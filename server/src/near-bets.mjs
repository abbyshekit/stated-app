// INTEGRATION: NEAR finalized state controls challenge acceptance and settlement.
// X sessions own private nonce-bound requests; wallet redirects never establish success.
import { randomBytes, randomUUID } from 'node:crypto';
import { fingerprint } from './canonical.mjs';
import { betFor, requireCreationReferee } from './bets.mjs';
import { notifyBetChange } from './bet-notify.mjs';
import { reserveNearRequest } from './near-request.mjs';
import { contractVersion, formatTestNear, rpc, STORAGE_FEE_YOCTO, viewCredit, viewEscrowSnapshot, walletPayload } from './near-escrow.mjs';
import { inPilot, isAccount, isNamedAccount, networkName } from './near-network.mjs';
import { assertStakeLimit } from './reputation.mjs';
import { UserError } from './store.mjs';
import { ensureOutlayerRegistration } from './outlayer.mjs';
import { nearChain } from './play.mjs';

const ns = (date) => (BigInt(new Date(date).getTime()) * 1000000n).toString();
const same = (a, b) => String(a) === String(b);
const participant = (b, u) => same(b.creator_user_id, u.id) || same(b.acceptor_user_id, u.id);

async function absentAfterDeadline(snapshot, bet, options) {
  if (snapshot.value || !snapshot.blockHash) return false;
  const block = await rpc('block', { block_id: snapshot.blockHash }, options);
  const timestamp = block.header?.timestamp_nanosec;
  return typeof timestamp === 'string' && /^\d+$/.test(timestamp) && BigInt(timestamp) >= BigInt(ns(bet.accept_by));
}

export async function cancelUnfundedBet(db, config, user, id, options = {}) {
  const visible = await betFor(db, user, id);
  const requested = await db.one("select 1 as found from bilateral_near_requests where bet_id=$1 and method='create_bet' limit 1", [id]);
  let finalizedExpiry = false;
  if (requested) {
    const snapshot = await viewEscrowSnapshot(configured(config), id, options);
    finalizedExpiry = await absentAfterDeadline(snapshot, visible, options);
  }
  await db.tx(async (tx) => {
    const bet = await tx.one('select * from bilateral_bets where id=$1 for update', [id]);
    if (!same(bet.creator_user_id, user.id) || bet.chain_state || bet.status !== 'offered') {
      throw new UserError('Only the proposer can discard an unfunded offer.', 409);
    }
    const issued = await tx.one("select 1 as found from bilateral_near_requests where bet_id=$1 and method='create_bet' limit 1", [id]);
    if (issued && !finalizedExpiry) throw new UserError('A funding request may still complete. Verify the escrow or wait until the acceptance deadline before discarding it.', 409);
    await tx.query("update bilateral_bets set status='cancelled' where id=$1", [id]);
    await tx.query("insert into bilateral_bet_events(bet_id,actor_user_id,kind) values($1,$2,'cancelled')", [id, user.id]);
  });
}

function configured(config) {
  if (!config.nearContract || !isNamedAccount(config.nearContract)) {
    throw new UserError(`${networkName()} escrow is not configured. Ask the operator to set STATED_NEAR_CONTRACT.`, 503);
  }
  return config.nearContract;
}

function evidence(value, required) {
  if (!value && !required) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.href.length > 2048
      || !url.hostname.includes('.') || /(?:^|\.)(localhost|local|internal)$/.test(url.hostname)) throw new Error();
    return url.href;
  } catch { throw new UserError('Enter a public HTTPS link for the result evidence.'); }
}

function verifyTerms(bet, chain) {
  const active = ['accepted', 'proposed', 'disputed', 'settled', 'refunded'].includes(chain.status);
  if (!isAccount(chain.creator || '') || !/^[a-f0-9]{64}$/.test(chain.creator_binding_hash || '')
    || (active && (!isAccount(chain.acceptor || '') || !/^[a-f0-9]{64}$/.test(chain.acceptor_binding_hash || '')))
    || (chain.acceptor && bet.invited_wallet && chain.acceptor !== bet.invited_wallet)
    || (chain.status === 'proposed' && !chain.proposal)
    // Version 2 records how a Bet was settled; a referee can settle one that never had a proposal.
    || (chain.status === 'settled' && !chain.proposal && !chain.resolution)
    || (chain.resolution && (!['yes', 'no', 'void'].includes(chain.resolution.outcome)
      || !['agreement', 'unanswered', 'referee'].includes(chain.resolution.method)))
    || (chain.referee && (!isAccount(chain.referee) || chain.referee === chain.creator || chain.referee === chain.acceptor))
    || (chain.proposal && (!/^\d{1,20}$/.test(chain.proposal.revision || '') || BigInt(chain.proposal.revision) < 1n
      || BigInt(chain.proposal.revision) > 18446744073709551615n))) {
    throw new UserError('NEAR returned an invalid escrow state. Do not deposit.', 409);
  }
  if (chain.id !== bet.id || chain.terms_hash !== bet.terms_hash
    || chain.stake_yocto !== bet.stake_yocto || chain.creator_side !== bet.creator_side
    || chain.accept_by_ns !== ns(bet.accept_by) || chain.resolve_at_ns !== ns(bet.resolve_at)
    || (chain.invited_account || null) !== (bet.invited_wallet || null)
    || (chain.referee || null) !== (bet.referee_wallet || null)) {
    throw new UserError('The on-chain escrow does not match these terms. Do not deposit.', 409);
  }
}

export async function syncNearBet(db, config, user, id, options = {}) {
  const contract = configured(config);
  const visible = await betFor(db, user, id);
  let snapshot;
  try { snapshot = await viewEscrowSnapshot(contract, visible.id, options); }
  catch { throw new UserError(`${networkName()} could not be checked. Retry verification.`, 503); }
  const chain = snapshot.value;
  if (!chain) {
    if (visible.chain_state) throw new UserError('The recorded escrow is missing from this contract. Ask the operator to check the configuration.', 409);
    if (new Date(visible.accept_by).getTime() <= Date.now() && await absentAfterDeadline(snapshot, visible, options)) {
      await db.query(`update bilateral_bets set near_absent_after_expiry=true,
        near_verified_at=clock_timestamp() where id=$1 and chain_state is null`, [visible.id]);
    }
    return visible;
  }
  verifyTerms(visible, chain);
  await db.tx(async (tx) => {
    const bet = await tx.one('select * from bilateral_bets where id = $1 for update', [visible.id]);
    if (bet.near_height && BigInt(bet.near_height) > BigInt(snapshot.blockHeight)) return;
    // A response obtained before a concurrent sync may be older. Terminal states
    // and accepted participant bindings never regress to an earlier chain state.
    if (bet.chain_state && ['settled', 'cancelled', 'expired', 'refunded'].includes(bet.status)
      && fingerprint(bet.chain_state) !== fingerprint(chain)) return;
    if (bet.acceptor_user_id && !chain.acceptor) return;
    const creation = await tx.one(`select * from bilateral_near_requests
      where bet_id = $1 and method = 'create_bet' and binding_hash = $2`, [bet.id, chain.creator_binding_hash]);
    if (!creation || !same(creation.user_id, bet.creator_user_id) || creation.wallet_account !== chain.creator) {
      throw new UserError('This escrow was not funded by the proposer through Stated. Do not accept it.', 409);
    }
    let taker = null;
    if (chain.acceptor) {
      taker = await tx.one(`select * from bilateral_near_requests
        where bet_id = $1 and method = 'accept_bet' and binding_hash = $2`, [bet.id, chain.acceptor_binding_hash]);
      // The contract also permits direct wallet calls. Preserve that escrow's
      // recovery path without treating its public binding hash as X identity.
      if (!taker || taker.wallet_account !== chain.acceptor || same(taker.user_id, bet.creator_user_id)
        || (bet.invited_user_id && !same(taker.user_id, bet.invited_user_id))) taker = null;
    }
    if (!['offered', 'accepted', 'proposed', 'disputed', 'settled', 'cancelled', 'expired', 'refunded'].includes(chain.status)) {
      throw new UserError('NEAR returned an unsupported escrow status. Ask the operator to check it.', 503);
    }
    const proposal = chain.proposal;
    if (proposal) {
      const proposerId = proposal.proposer === chain.creator ? bet.creator_user_id
        : proposal.proposer === chain.acceptor ? taker?.user_id : null;
      if (![chain.creator, chain.acceptor].includes(proposal.proposer)
        || !['yes', 'no', 'void'].includes(proposal.outcome)) throw new UserError('Invalid on-chain result proposal.', 409);
      if (proposerId) {
        const request = await tx.one(`select metadata from bilateral_near_requests
        where bet_id = $1 and user_id = $2 and method = 'propose_outcome' and args->>'proposal_id' = $3
        and metadata->>'proposalRevision' = $4 and args->>'outcome' = $5
        order by created_at desc limit 1`, [bet.id, proposerId, proposal.id, proposal.revision, proposal.outcome]);
        await tx.query(`insert into bilateral_bet_proposals (id, bet_id, proposer_user_id, outcome, evidence_url, note, revision)
        values ($1,$2,$3,$4,$5,$6,$7) on conflict (bet_id,revision) do nothing`,
        [proposal.id, bet.id, proposerId, proposal.outcome, request?.metadata.evidenceUrl || null,
          request?.metadata.note || 'Proposed directly on NEAR. No supporting evidence was submitted through Stated.', proposal.revision]);
      }
    }
    const currentFingerprint = fingerprint(chain);
    const previous = bet.chain_state ? fingerprint(bet.chain_state) : null;
    await tx.query(`update bilateral_bets set creator_wallet=$2, acceptor_wallet=$3, acceptor_user_id=$4,
      chain_state=$5, status=$6, current_proposal_id=$7, outcome=$8, near_height=$9, current_proposal_revision=$10,
      accepted_at=case when $3::text is not null then coalesce(accepted_at,clock_timestamp()) else accepted_at end,
      settled_at=case when $6='settled' then coalesce(settled_at,clock_timestamp()) else settled_at end,
      near_verified_at=clock_timestamp(), near_absent_after_expiry=false where id=$1`,
    [bet.id, chain.creator, chain.acceptor || null, taker?.user_id || null, chain, chain.status,
      proposal?.id || null, chain.status === 'settled' ? (chain.resolution?.outcome || proposal?.outcome || null) : null,
      snapshot.blockHeight, proposal?.revision || null]);
    // Publication consent belongs to the exact request that funded this escrow.
    // Reconciliation can honor it even if the wallet callback never returns.
    if (!bet.chain_state && chain.status === 'offered' && creation.metadata?.publishAfterFunding === true) {
      await tx.query(`insert into bilateral_bet_publications (bet_id,creator_user_id,published_at)
        values ($1,$2,clock_timestamp()) on conflict (bet_id) do nothing`, [bet.id, bet.creator_user_id]);
    }
    if (currentFingerprint !== previous) {
      await tx.query(`insert into bilateral_bet_events (bet_id,actor_user_id,kind,detail)
        values ($1,$2,'chain_verified',$3)`, [bet.id, user.id, { status: chain.status, proposalId: proposal?.id || null }]);
      await notifyBetChange(tx, { before: bet, after: { ...bet, acceptor_user_id: taker?.user_id || null, chain_state: chain }, eventKey: currentFingerprint });
    }
  });
  const synced = await betFor(db, user, id);
  if (!options.skipOutlayerRegistration && synced.outlayer_material && ['accepted','proposed','disputed'].includes(synced.status)) {
    // Acceptance is final. A failed registration remains recoverable by the keeper.
    try { await ensureOutlayerRegistration(db, config, options.chain || nearChain(options), synced, options); }
    catch { /* The durable material and registration intent are retried independently. */ }
  }
  return { ...synced, acceptor_unbound: Boolean(synced.acceptor_wallet && !synced.acceptor_user_id) };
}

export async function prepareNearAction(db, config, user, id, input, options = {}) {
  const action = input.action;
  if ((action === 'fund' || action === 'accept') && !inPilot(config, user.x_user_id)) {
    throw new UserError('Bets with real NEAR are invite-only for now.', 403);
  }
  const contract = configured(config);
  const bet = await syncNearBet(db, config, user, id, options);
  const account = input.accountId;
  if (!isAccount(account)) throw new UserError(`Enter your ${networkName()} account ID.`);
  const creator = same(bet.creator_user_id, user.id);
  const member = participant(bet, user);
  const chain = bet.chain_state;
  const binding = randomBytes(32).toString('hex');
  let method;
  let args = { id: bet.id };
  let deposit = '0';
  let metadata = {};
  if (action === 'fund') {
    if (!creator || bet.status !== 'offered' || chain) throw new UserError('Only the proposer can fund an uncreated escrow.', 409);
    method = 'create_bet';
    args = { ...args, terms_hash: bet.terms_hash, creator_side: bet.creator_side, stake_yocto: bet.stake_yocto,
      accept_by_ns: ns(bet.accept_by), resolve_at_ns: ns(bet.resolve_at), invited_account: bet.invited_wallet, binding_hash: binding };
    if (bet.referee_wallet) {
      // A referee is part of the funded terms, so the contract must be one that enforces it.
      if ((await contractVersion(contract, options)) < 2) throw new UserError('This escrow contract cannot name a referee. Ask the operator to deploy version 2.', 409);
      if (bet.referee_wallet === account) throw new UserError('The referee cannot take a side.');
      args.referee = bet.referee_wallet;
    }
    deposit = (BigInt(bet.stake_yocto) + BigInt(STORAGE_FEE_YOCTO)).toString();
    if (input.publishAfterFunding === true) metadata.publishAfterFunding = true;
  } else if (action === 'accept') {
    if (creator || bet.status !== 'offered' || !chain || bet.expired || input.termsHash !== bet.terms_hash
      || (bet.invited_user_id && !same(bet.invited_user_id, user.id))) throw new UserError('Review the funded offer before accepting it.', 409);
    if (chain.creator === account || (bet.invited_wallet && bet.invited_wallet !== account)) throw new UserError('Use the invited opponent wallet, distinct from the proposer.');
    if (chain.referee && chain.referee === account) throw new UserError('The referee cannot take a side.');
    method = 'accept_bet'; args.binding_hash = binding; deposit = bet.stake_yocto;
  } else {
    if (!member || !chain) throw new UserError('Only funded challenge participants can make this transaction.', 403);
    const expected = creator ? chain.creator : chain.acceptor;
    if (account !== expected) throw new UserError(`Use the participant wallet ${expected}.`);
    if (bet.acceptor_unbound && !['cancel', 'expire', 'refund', 'withdraw'].includes(action)) {
      throw new UserError('The accepting wallet is not linked to a Stated opponent. Reclaim your stake after the refund deadline.', 409);
    }
    if (action === 'cancel') {
      if (!creator || chain.status !== 'offered') throw new UserError('Only an unaccepted offer can be cancelled.', 409);
      method = 'cancel_bet';
    } else if (action === 'expire') {
      method = 'expire_bet';
    } else if (action === 'refund') {
      method = 'refund_unresolved';
    } else if (action === 'withdraw') {
      method = 'withdraw'; args = {};
      let credit;
      try { credit = await viewCredit(contract, account, options); }
      catch { throw new UserError('Withdrawal credit could not be checked. Retry verification.', 503); }
      if (typeof credit !== 'string' || !/^(0|[1-9][0-9]{0,38})$/.test(credit)) throw new UserError('NEAR returned an invalid withdrawal credit. Retry verification.', 503);
      if (BigInt(credit) === 0n) throw Object.assign(
        new UserError('This wallet has no available withdrawal credit. Review the latest escrow state.', 409), { noWithdrawalCredit: true });
      metadata = { creditYocto: credit };
    } else if (action === 'propose') {
      if (!['accepted', 'proposed', 'disputed'].includes(chain.status)) throw new UserError('This challenge cannot receive another result.', 409);
      if (!['yes', 'no', 'void'].includes(input.outcome)) throw new UserError('Choose a result.');
      const note = String(input.note || '').trim();
      if (!note || note.length > 2000) throw new UserError('Give the result a reason of 2000 characters or fewer.');
      method = 'propose_outcome'; args = { ...args, proposal_id: randomUUID(), outcome: input.outcome };
      metadata = { note, evidenceUrl: evidence(input.evidenceUrl, input.outcome !== 'void'),
        proposalRevision: (BigInt(chain.proposal?.revision || '0') + 1n).toString() };
    } else if (action === 'confirm' || action === 'dispute') {
      if (chain.status !== 'proposed' || !chain.proposal || chain.proposal.id !== input.proposalId
        || String(chain.proposal.revision) !== input.proposalRevision || chain.proposal.outcome !== input.proposalOutcome
        || chain.proposal.proposer === account) throw new UserError('Review the other participant’s latest result before responding.', 409);
      method = action === 'confirm' ? 'confirm_outcome' : 'dispute_outcome';
      args = { ...args, proposal_id: chain.proposal.id, expected_revision: chain.proposal.revision };
      if (action === 'dispute') {
        const note = String(input.note || '').trim();
        if (!note || note.length > 2000) throw new UserError('Give a dispute reason of 2000 characters or fewer.');
        metadata.note = note;
      }
    } else if (action === 'finalize') {
      // Version 2: a result the other side never answered stands once the response window has passed.
      if (chain.status !== 'proposed' || !chain.proposal || chain.proposal.proposer !== account
        || !chain.proposal.proposed_at_ns) throw new UserError('There is no unanswered result of yours to finalize.', 409);
      if (chain.referee) throw new UserError('This bet has a referee, so an unanswered result does not stand. The referee decides it.', 409);
      method = 'finalize_unanswered';
      args = { ...args, proposal_id: chain.proposal.id, expected_revision: chain.proposal.revision };
    } else throw new UserError('Choose a supported escrow action.');
  }
  if (action === 'fund' || action === 'accept') {
    await assertStakeLimit(db, config, user.id, formatTestNear(bet.stake_yocto));
  }
  if (action === 'fund' && config.near?.real) {
    requireCreationReferee(config);
    if (bet.referee_wallet !== config.outlayer.referee || !bet.outlayer_material) {
      throw new UserError('This draft has no committed OutLayer referee. Make a new bet before funding.', 409);
    }
    let view;
    try { view = await (options.chain || nearChain(options)).view({ contractId: config.outlayer.referee, method: 'get_config' }); }
    catch { throw new UserError('The OutLayer referee configuration could not be checked. Retry before funding.', 503); }
    if (view?.escrow !== config.nearContract) throw new UserError('The OutLayer referee names another escrow. Funding is paused.', 503);
  }
  const { request, reused } = await reserveNearRequest(db, { bet, user, account, method, args, metadata, depositYocto: deposit, contract });
  const payload = walletPayload({ contract: request.metadata.contract, accountId: request.wallet_account,
    methodName: request.method, args: request.args, depositYocto: request.metadata.depositYocto, requestId: request.id });
  return { payload, method: request.method, args: request.args, depositYocto: request.metadata.depositYocto,
    accountId: request.wallet_account, requestId: request.id, reused, withdrawalCreditYocto: request.metadata.creditYocto || null };
}
