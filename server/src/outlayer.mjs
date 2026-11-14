// INTEGRATION: New OutLayer commitments only; parent owns schema/config/routes.
// Signing uses committed outlayer_near_requests intents and finalized execution.
import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { canonicalJson, fingerprint } from './canonical.mjs';
import { checkPlan, decide, materialHash } from './enclave-ruling.mjs';
import { nearChain, treasury, playAccountFor, secretOf, reservePlaySigner, withAvailablePlaySigner, withManagedOperation } from './play.mjs';
import { reserveNearRequest } from './near-request.mjs';
import { walletPayload } from './near-escrow.mjs';
import { verifyNearExecution } from './near-execution.mjs';
import { syncNearBet } from './near-bets.mjs';
import { UserError } from './store.mjs';
import { isNamedAccount } from './near-network.mjs';
import { InvalidNonceError, TransactionExpiredError } from 'near-api-js/rpc-errors';

const GAS = '100000000000000';
const RULING_GAS = '300000000000000';
const COMPUTE_RETRY_MS = [300000, 1800000, 21600000];
const ACTIVE = ['accepted', 'proposed', 'disputed'];
const ROSTER = ['Qwen/Qwen3.8-27B', 'deepseek-ai/DeepSeek-V4.1-Flash-1017', 'z-ai/glm-5.3-flash'];
export const outlayerModels = () => [...ROSTER];
const same = (a, b) => String(a) === String(b);
const iso = value => new Date(value).toISOString();
const fail = message => { throw new UserError(message, 409); };

async function sponsor(db, config, chain) {
  if (config.play?.enabled) return treasury(db, config, chain);
  if (!isNamedAccount(config.play?.treasury || '') || !config.play?.treasuryKey) {
    throw new Error('OutLayer requires STATED_PLAY_TREASURY and STATED_PLAY_TREASURY_KEY for storage and keeper gas.');
  }
  return { id: config.play.treasury, secret: config.play.treasuryKey };
}

export function supportsOpenEvidence(configView) {
  return configView?.supports_open_evidence === true;
}

export function outlayerTermsHash(material, salt) {
  if (!/^[a-f0-9]{64}$/.test(salt || '')) fail('The OutLayer commitment needs its original salt.');
  return createHash('sha256').update(canonicalJson({ domain: 'stated-outlayer-v1', material, salt })).digest('hex');
}

export function makeOutlayerMaterial({ id, claim, madeAt, createdAt = madeAt, acceptBy, deadline, postUrl, evidenceSourceUrl, plan, creatorSide }, config, refereeConfig) {
  const startAt = Math.max(new Date(madeAt).getTime(), new Date(createdAt).getTime());
  const acceptAt = acceptBy === undefined ? startAt : Date.parse(acceptBy);
  if (!Number.isSafeInteger(startAt) || !Number.isSafeInteger(acceptAt) || acceptAt > Date.parse(deadline)) fail('The OutLayer acceptance deadline is invalid.');
  const base = { bet_id: String(id), claim: String(claim), made_at: iso(startAt), deadline: iso(deadline), post_url: String(postUrl) };
  if (!base.bet_id.trim() || Buffer.byteLength(base.bet_id) > 128 || !base.claim.trim()
    || Buffer.byteLength(base.claim) > 16000 || !base.post_url.startsWith('https://')
    || Buffer.byteLength(base.post_url) > 2048 || base.made_at > base.deadline) fail('The OutLayer material is invalid.');
  const input = { claim: base.claim, madeAt: base.made_at, deadline: base.deadline, postUrl: base.post_url };
  if (!plan || !['coinbase-candles', 'evidence'].includes(plan.source)) fail('A checked server evidence plan is required before creation.');
  const raw = plan;
  const checked = checkPlan(raw, input);
  let evidence;
  if (checked.source === 'coinbase-candles') {
    // Exclude the entire partly elapsed candle at both creation and acceptance.
    const rangeStart = iso(Math.ceil(Math.max(startAt, acceptAt) / 60000) * 60000);
    if (raw.kind === 'range' && rangeStart >= checked.end) fail('The price range has no complete candle after acceptance closes.');
    if (raw.kind === 'moment' && (Date.parse(checked.start) <= acceptAt || Date.parse(checked.start) < startAt)) {
      fail('The price moment minute must be after the acceptance deadline and bet creation.');
    }
    // Keep the original moment: checkPlan returns the candle boundary instead.
    evidence = { kind: 'coinbase', product: checked.product, window: raw.kind === 'moment'
      ? { kind: 'moment', at: iso(raw.at) } : { kind: 'range', start: rangeStart, end: checked.end } };
  } else if (evidenceSourceUrl != null && evidenceSourceUrl !== '') {
    if (!['yes', 'no'].includes(creatorSide)) fail('A precommitted evidence source needs the creator side.');
    evidence = { kind: 'submitted', items: [{ side: creatorSide, url: evidenceUrl(evidenceSourceUrl) }] };
  } else if (supportsOpenEvidence(refereeConfig)) {
    const seconds = config.play?.evidenceWindowSeconds ?? 86400;
    if (!Number.isSafeInteger(seconds) || seconds < 1 || seconds > 3 * 86400) fail('Use an evidence window from one second to three days.');
    evidence = { kind: 'open', window_seconds: seconds, max_per_side: 2 };
  } else {
    if (!['yes', 'no'].includes(creatorSide)) fail('A precommitted evidence source needs the creator side.');
    const url = evidenceUrl(base.post_url);
    evidence = { kind: 'submitted', items: [{ side: creatorSide, url }] };
  }
  const material = { ...base, evidence };
  if (Buffer.byteLength(JSON.stringify(material)) > 16384) fail('The OutLayer material exceeds its storage limit.');
  return material;
}

export function outlayerReadyAt(material) {
  const deadline = Date.parse(material.deadline);
  const evidence = material.evidence;
  let ready;
  if (evidence?.kind === 'coinbase') {
    const window = evidence.window;
    ready = window?.kind === 'moment' ? Math.floor(Date.parse(window.at) / 60000) * 60000 + 120000
      : Math.ceil(Math.min(Date.parse(window?.end), deadline) / 60000) * 60000 + 60000;
  } else if (evidence?.kind === 'open') ready = deadline + evidence.window_seconds * 1000;
  else if (evidence?.kind === 'auto') ready = deadline + 180000;
  else if (evidence?.kind === 'submitted') ready = deadline;
  if (!Number.isSafeInteger(ready) || !Number.isSafeInteger(deadline)) fail('The committed evidence window is invalid.');
  return Math.max(deadline, ready);
}

function boundMaterial(bet) {
  const material = bet.outlayer_material;
  if (!material || material.bet_id !== bet.id || material.claim !== bet.claim
    || material.deadline !== iso(bet.resolve_at) || outlayerTermsHash(material, bet.terms_salt) !== bet.terms_hash
    || !bet.referee_wallet) fail('The OutLayer material does not match the funded terms.');
  return material;
}

function validateRuling(bet, ruling) {
  const material = boundMaterial(bet);
  let registered;
  try { registered = JSON.parse(ruling.material_json); } catch { fail('The referee returned invalid registered material.'); }
  if (canonicalJson(registered) !== canonicalJson(material) || ruling.terms_hash !== bet.terms_hash
    || !['idle', 'reading', 'pricing', 'running', 'paying', 'settled'].includes(ruling.stage)
    || ![null, 'yes', 'no', 'void'].includes(ruling.outcome)
    || !/^\d+$/.test(String(ruling.nonce))
    || (typeof ruling.nonce === 'number' && !Number.isSafeInteger(ruling.nonce))
    || !/^\d+$/.test(String(ruling.started_ns)) || !/^\d+$/.test(String(ruling.next_ns))
    || (typeof ruling.deadline_ns === 'string'
      ? BigInt(ruling.deadline_ns) !== BigInt(Date.parse(material.deadline)) * 1000000n
      : !Number.isInteger(ruling.deadline_ns) || Math.round(ruling.deadline_ns / 1000000) !== Date.parse(material.deadline))) fail('The referee ruling does not match the funded terms.');
  return ruling;
}

async function liveConfig(chain, config, bet) {
  const view = await chain.view({ contractId: bet.referee_wallet, method: 'get_config' });
  if (!view || view.escrow !== config.nearContract) fail('The referee names a different escrow.');
  return view;
}

function verificationRequest(row) {
  return { id: row.id, wallet_account: row.signer_account, method: row.method, args: row.args,
    metadata: { contract: row.contract_account, depositYocto: row.deposit_yocto, gas: row.gas } };
}

async function reconcileIntent(db, row, fetchImpl) {
  const checked = await verifyNearExecution(verificationRequest(row), row.transaction_hash, { fetchImpl });
  await db.query(`update outlayer_near_requests set execution_status=$2,detail=$3,updated_at=clock_timestamp()
    where id=$1 and transaction_hash=$4`, [row.id, checked.status, checked.explanation, row.transaction_hash]);
  return { ...row, execution_status: checked.status };
}

// Commit signed bytes before broadcast; reconcile and resend the identical transaction.
async function persistentCall(db, chain, bet, signer, method, args, deposit, gas, fetchImpl, { repeat = false, attemptKey = null, signerLocked = false, registrationLimit = null, rulingDailyLimit = null } = {}) {
  if (!chain.prepareCall || !chain.broadcastCall) throw new Error('OutLayer requires durable transaction signing.');
  const lockKey = `outlayer-signer:${signer.id}`;
  const busyMessage = 'An OutLayer transaction is being prepared. Retry shortly.';
  if (!signerLocked && db.pool) {
    return withManagedOperation(db, lockKey, busyMessage,
      locked => persistentCall(locked, chain, bet, signer, method, args, deposit, gas, fetchImpl, { repeat, attemptKey, signerLocked: true, registrationLimit, rulingDailyLimit }));
  }
  if (!signerLocked) {
    // Managed acceptance already owns a dedicated session, but must still
    // serialize this signer against keeper calls using the pool.
    const lock = await db.one('select pg_try_advisory_lock(hashtextextended($1, 0)) as locked', [lockKey]);
    if (!lock?.locked) fail(busyMessage);
    try { return await persistentCall(db, chain, bet, signer, method, args, deposit, gas, fetchImpl, { repeat, attemptKey, signerLocked: true, registrationLimit, rulingDailyLimit }); }
    finally { await db.query('select pg_advisory_unlock(hashtextextended($1, 0))', [lockKey]); }
  }
  let row = await db.tx(async tx => {
    await tx.one('select id from bilateral_bets where id=$1 for update', [bet.id]);
    const previous = await tx.one(`select * from outlayer_near_requests where bet_id=$1
      and signer_account=$2 and contract_account=$3 and method=$4 and args=$5::jsonb
      and intent_key is not distinct from $6
      order by created_at desc,id desc limit 1`, [bet.id, signer.id, bet.referee_wallet, method, args, attemptKey]);
    if (previous && previous.execution_status !== 'failed' && !(repeat && previous.execution_status === 'succeeded')) return previous;
    if (previous?.execution_status === 'failed' && previous.transaction_hash) {
      // A downstream failure may follow a committed deposit. Failure alone
      // never authorizes another signature, including legacy failed rows.
      let safe = false;
      try {
        safe = previous.signed_transaction && typeof chain.preparedRetrySafe === 'function'
          ? await chain.preparedRetrySafe({ transactionHash: previous.transaction_hash,
            signedTransaction: previous.signed_transaction }, new TransactionExpiredError())
          : Boolean(chain.requestRetrySafe && await chain.requestRetrySafe({
            ...verificationRequest(previous), transaction_hash: previous.transaction_hash }));
      } catch { /* retain the original intent until conclusive proof exists */ }
      if (!safe) return previous;
    }
    if (method === 'register_material' && registrationLimit !== null) {
      // A committed intent reserves its allowance before signing or broadcast.
      // Failed/ambiguous attempts retain the reservation; retries of the same
      // durable intent return above. X-linked user IDs survive wallet rotation.
      if (!bet.creator_user_id || !Number.isSafeInteger(registrationLimit) || registrationLimit < 1) fail('The registration daily limit is invalid.');
      const accounts = [...new Set([bet.creator_user_id, bet.acceptor_user_id].filter(value => value != null).map(String))].sort();
      for (const account of accounts) {
        await tx.one('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`outlayer-registration:${account}`]);
        const used = await tx.one(`select count(*)::int as n from outlayer_near_requests r
          join bilateral_bets b on b.id=r.bet_id where (b.creator_user_id=$1 or b.acceptor_user_id=$1) and r.method='register_material'
          and r.created_at >= (date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC')`, [account]);
        if (!Number.isSafeInteger(used?.n) || used.n >= registrationLimit) fail('An account has reached its daily sponsored registration limit. Retry after midnight UTC.');
      }
    }
    if (method === 'request_ruling' && rulingDailyLimit !== null) {
      if (!Number.isSafeInteger(rulingDailyLimit) || rulingDailyLimit < 0) fail('The ruling daily limit is invalid.');
      // The locked bet row serializes every keeper process before reserving a
      // new intent. Existing signed intents returned above remain recoverable.
      const used = await tx.one(`select count(*)::int as n from outlayer_near_requests
        where bet_id=$1 and method='request_ruling'
        and created_at >= (date_trunc('day',clock_timestamp() at time zone 'UTC') at time zone 'UTC')`, [bet.id]);
      if (!Number.isSafeInteger(used?.n) || used.n >= rulingDailyLimit) fail('This bet has reached its daily ruling limit. Retry after midnight UTC.');
    }
    return tx.one(`insert into outlayer_near_requests
      (id,bet_id,signer_account,contract_account,method,args,deposit_yocto,gas,intent_key)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [randomUUID(), bet.id, signer.id, bet.referee_wallet, method, args, deposit, gas, attemptKey]);
  });
  if (row.transaction_hash && !['succeeded', 'failed'].includes(row.execution_status)) row = await reconcileIntent(db, row, fetchImpl);
  if (['succeeded','failed'].includes(row.execution_status)) return row;
  if (!row.signed_transaction) {
    let prepared;
    try {
      prepared = await reservePlaySigner(db, chain, signer.id, `outlayer:${row.id}`, () => chain.prepareCall({
        signerId: signer.id, secret: signer.secret, contractId: bet.referee_wallet,
        method, args, depositYocto: deposit, gas: BigInt(gas) }), { outlayerId: row.id });
    } catch (error) {
      if (error instanceof UserError && error.status === 409) throw error;
      await db.query(`update outlayer_near_requests set execution_status='failed',detail='Signing failed before broadcast',
        updated_at=clock_timestamp() where id=$1 and transaction_hash is null`, [row.id]);
      throw error;
    }
    row = await db.one(`update outlayer_near_requests set transaction_hash=$2,signed_transaction=$3,
      execution_status='pending',updated_at=clock_timestamp() where id=$1 and transaction_hash is null returning *`,
    [row.id, prepared.hash, prepared.signedTransaction]);
    if (!row) throw new Error('The OutLayer signing intent changed before broadcast.');
  }
  await db.query(`update outlayer_near_requests set broadcast_started_at=coalesce(broadcast_started_at,clock_timestamp()),
    updated_at=clock_timestamp() where id=$1`, [row.id]);
  try {
    await withAvailablePlaySigner(db, signer.id, () => chain.broadcastCall({ signedTransaction: row.signed_transaction }),
      { chain, intentKey: `outlayer:${row.id}`, outlayerId: row.id });
  } catch (error) {
    if (!(error instanceof InvalidNonceError || error instanceof TransactionExpiredError)) throw error;
    const checked = await reconcileIntent(db, row, fetchImpl);
    if (checked.execution_status !== 'pending') return checked;
    // Historical lookup absence cannot distinguish nonexecution from a lost
    // successful response. Require the saved signature's conclusive proof.
    try {
      if (typeof chain.preparedRetrySafe !== 'function' || !await chain.preparedRetrySafe({
        transactionHash: row.transaction_hash, signedTransaction: row.signed_transaction,
      }, error)) return checked;
    } catch (lookupError) {
      return checked;
    }
    await db.query(`update outlayer_near_requests set execution_status='failed',detail='Signed transaction can no longer be included',
      updated_at=clock_timestamp() where id=$1 and execution_status='pending'`, [row.id]);
    return { ...row, execution_status: 'failed' };
  }
  return reconcileIntent(db, row, fetchImpl);
}

async function computePause(db, bet, ruling, budget, now, lastRequestAt) {
  const pause = await db.tx(async tx => {
    await tx.one('select id from bilateral_bets where id=$1 for update', [bet.id]);
    const last = await tx.one(`select detail from bilateral_bet_events where bet_id=$1
      and kind='outlayer_compute_pause' order by id desc limit 1`, [bet.id]);
    const prior = last?.detail;
    const nonce = String(ruling.nonce);
    const counters = { failures: ruling.failures ?? 0, admissionFailures: ruling.admission_failures ?? 0,
      undecided: ruling.undecided ?? 0, acceptedNonce: ruling.accepted_nonce == null ? null : String(ruling.accepted_nonce) };
    if (![counters.failures, counters.admissionFailures, counters.undecided].every(value => Number.isInteger(value) && value >= 0 && value <= 255)
      || (typeof ruling.accepted_nonce === 'number' && !Number.isSafeInteger(ruling.accepted_nonce))
      || (counters.acceptedNonce !== null && (!/^[1-9]\d*$/.test(counters.acceptedNonce)
        || BigInt(counters.acceptedNonce) > BigInt(nonce)))) throw new Error('The referee returned invalid retry counters.');
    // Error text survives valid unclear results. An accepted result starts a
    // fresh run even when an older accepted nonce invalidated newer attempts.
    const accepted = counters.acceptedNonce !== null;
    const reset = accepted && (!prior || prior.acceptedNonce !== counters.acceptedNonce || prior.undecided !== counters.undecided);
    const progressed = prior && (prior.nonce !== nonce || prior.failures !== counters.failures
      || prior.admissionFailures !== counters.admissionFailures);
    const rejected = ruling.stage === 'idle' && !reset && (prior
      ? progressed || prior.consecutive > 0
      : BigInt(nonce) > 0n || counters.failures + counters.admissionFailures > 0);
    const newRejection = rejected && (!prior || progressed);
    const consecutive = reset ? 0 : newRejection ? (prior?.consecutive || 0) + 1 : rejected ? prior.consecutive : 0;
    if (reset || newRejection || (!prior && BigInt(budget) === 0n)) {
      const detail = { nonce, budget: String(budget), ...counters, consecutive,
        attemptedAt: lastRequestAt ? new Date(lastRequestAt).getTime() : now };
      await tx.query(`insert into bilateral_bet_events (bet_id,actor_user_id,kind,detail)
        values($1,$2,'outlayer_compute_pause',$3)`, [bet.id, bet.creator_user_id, detail]);
      return { detail, warn: !prior && (rejected || BigInt(budget) === 0n) };
    }
    return { detail: prior || { nonce, ...counters, consecutive: 0, attemptedAt: now } };
  });
  if (pause.warn) console.warn(`OutLayer compute unavailable for ${bet.referee_wallet} (bet ${bet.id}, pool ${budget} yocto). Fund the pool or check pricing before retrying.`);
  return pause.detail;
}

async function observedRegistration(db, bet, ruling, fetchImpl) {
  validateRuling(bet, ruling);
  const pending = await db.many(`select * from outlayer_near_requests where bet_id=$1 and contract_account=$2
    and method='register_material' and execution_status='pending' and transaction_hash is not null
    order by created_at,id limit 5`, [bet.id, bet.referee_wallet]);
  for (const request of pending) await reconcileIntent(db, request, fetchImpl);
  return ruling;
}

export async function ensureOutlayerRegistration(db, config, chain, bet, { fetchImpl = fetch } = {}) {
  const material = boundMaterial(bet);
  const configView = await liveConfig(chain, config, bet);
  let ruling = await chain.view({ contractId: bet.referee_wallet, method: 'get_ruling', args: { bet_id: bet.id } });
  if (ruling) {
    await observedRegistration(db, bet, ruling, fetchImpl);
    await snapshot(db, bet, configView, ruling);
    return ruling;
  }
  if (!ACTIVE.includes(bet.status)) return null;
  if (config.near?.real && (!/^[1-9]\d{0,38}$/.test(bet.stake_yocto || '') || BigInt(bet.stake_yocto) < 100000000000000000000000n)) {
    fail('The minimum mainnet stake for sponsored registration is 0.1 NEAR.');
  }
  const registrationLimit = config.outlayer?.registrationDailyLimit ?? 5;
  if (!Number.isSafeInteger(registrationLimit) || registrationLimit < 1) fail('The registration daily limit is invalid.');
  const signer = await sponsor(db, config, chain);
  // Protocol storage price is 10^19 yocto/byte; reserve bounded record overhead.
  const deposit = config.outlayer?.registrationDepositYocto
    || ((BigInt(Buffer.byteLength(JSON.stringify(material))) + 32768n + 4096n) * 10000000000000000000n).toString();
  if (!/^[1-9]\d{0,38}$/.test(deposit)) fail('The registration storage deposit is invalid.');
  const request = await persistentCall(db, chain, bet, signer, 'register_material', { material, salt: bet.terms_salt }, deposit, GAS, fetchImpl, { registrationLimit });
  ruling = await chain.view({ contractId: bet.referee_wallet, method: 'get_ruling', args: { bet_id: bet.id } });
  if (ruling) {
    await observedRegistration(db, bet, ruling, fetchImpl);
    await snapshot(db, bet, configView, ruling);
    return ruling;
  }
  if (request.execution_status === 'succeeded') await db.query(`update outlayer_near_requests
    set execution_status='failed',detail='Registration callback did not store material',updated_at=clock_timestamp() where id=$1`, [request.id]);
  return null;
}

async function snapshot(db, bet, configView, ruling, { escrowTerminal = false } = {}) {
  if (ruling) validateRuling(bet, ruling);
  else if (!escrowTerminal) fail('The referee ruling is missing.');
  const detail = { referee: bet.referee_wallet, config: configView, ruling, ...(escrowTerminal ? { escrow_terminal: true } : {}) };
  await db.tx(async tx => {
    await tx.one('select id from bilateral_bets where id=$1 for update', [bet.id]);
    const last = await tx.one(`select detail from bilateral_bet_events where bet_id=$1 and kind='outlayer_ruling' order by id desc limit 1`, [bet.id]);
    if (!last || fingerprint(last.detail) !== fingerprint(detail)) await tx.query(`insert into bilateral_bet_events
      (bet_id,actor_user_id,kind,detail) values($1,$2,'outlayer_ruling',$3)`, [bet.id, bet.creator_user_id, detail]);
  });
}

async function recordSettlement(db, bet, ruling, fetchImpl) {
  if (bet.status !== 'settled' || bet.chain_state?.resolution?.method !== 'referee' || ruling.stage !== 'settled'
    || bet.outcome !== ruling.outcome) return;
  validateRuling(bet, ruling);
  // The accepted result can belong to an older attempt. The live nonce also
  // advances on invalidation and permissionless callers bypass this ledger.
  const acceptedNonce = ruling.accepted_nonce ?? ruling.result_nonce ?? null;
  if (acceptedNonce !== null && (!/^[1-9]\d*$/.test(String(acceptedNonce))
    || (typeof acceptedNonce === 'number' && !Number.isSafeInteger(acceptedNonce)))) fail('The accepted ruling nonce is invalid.');
  let exact = acceptedNonce !== null;
  let request = exact ? await db.one(`select * from outlayer_near_requests where bet_id=$1 and contract_account=$2
    and method='request_ruling' and transaction_hash is not null and execution_status<>'failed' and intent_key=$3
    order by created_at desc,id desc limit 1`, [bet.id, bet.referee_wallet, String(BigInt(acceptedNonce) - 1n)]) : null;
  if (request?.execution_status === 'pending') request = await reconcileIntent(db, request, fetchImpl);
  if (request?.execution_status !== 'succeeded') {
    exact = false;
    request = await db.one(`select * from outlayer_near_requests where bet_id=$1 and contract_account=$2
      and method='request_ruling' and transaction_hash is not null and execution_status<>'failed'
      order by created_at desc,id desc limit 1`, [bet.id, bet.referee_wallet]);
    if (request?.execution_status === 'pending') request = await reconcileIntent(db, request, fetchImpl);
    if (request?.execution_status !== 'succeeded') request = await db.one(`select * from outlayer_near_requests
      where bet_id=$1 and contract_account=$2 and method='request_ruling'
      and transaction_hash is not null and execution_status='succeeded'
      order by created_at desc,id desc limit 1`, [bet.id, bet.referee_wallet]);
  }
  const detail = { outcome: bet.outcome, referee: bet.referee_wallet, acceptedNonce: acceptedNonce === null ? null : String(acceptedNonce),
    transactionHash: request?.execution_status === 'succeeded' ? request.transaction_hash : null,
    transactionAttribution: request?.execution_status === 'succeeded' ? (exact ? 'accepted_attempt' : 'latest_verified_request') : 'terminal_state' };
  await db.tx(async tx => {
    await tx.one('select id from bilateral_bets where id=$1 for update', [bet.id]);
    await tx.query(`insert into bilateral_bet_events(bet_id,actor_user_id,kind,detail)
      select $1,$2,'referee_resolved',$3 where not exists
        (select 1 from bilateral_bet_events where bet_id=$1 and kind='referee_resolved')`, [bet.id, bet.creator_user_id, detail]);
    // A permissionless settlement may be observed before its transaction is
    // known. Preserve one event and enrich it if a verified request appears.
    if (detail.transactionHash) await tx.query(`update bilateral_bet_events set detail=detail || $2::jsonb
      where bet_id=$1 and kind='referee_resolved' and (detail->>'transactionHash' is null
        or ($2::jsonb->>'transactionAttribution'='accepted_attempt' and coalesce(detail->>'transactionAttribution','')<>'accepted_attempt'))`, [bet.id, detail]);
  });
}

export async function runOutlayerKeeper(db, config, { chain, fetchImpl = fetch, limit = 20, now = Date.now() } = {}) {
  chain ||= nearChain({ fetchImpl });
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100 || !Number.isSafeInteger(now)) throw new Error('Invalid keeper limits');
  const bets = await db.many(`select * from bilateral_bets where outlayer_material is not null
    and referee_wallet is not null and chain_state is not null
    and (status in ('offered','accepted','proposed','disputed') or (status in ('settled','refunded')
      and not coalesce((select (e.detail->>'escrow_terminal')::boolean
        and (e.detail->'ruling'='null'::jsonb or coalesce(e.detail->'ruling'->>'stage','idle')='settled') from bilateral_bet_events e
        where e.bet_id=bilateral_bets.id and e.kind='outlayer_ruling' order by e.id desc limit 1),false))
      or (status='settled' and chain_state->'resolution'->>'method'='referee'
        and outcome=(select e.detail->'ruling'->>'outcome' from bilateral_bet_events e
          where e.bet_id=bilateral_bets.id and e.kind='outlayer_ruling' order by e.id desc limit 1)
        and (not exists (select 1 from bilateral_bet_events e
          where e.bet_id=bilateral_bets.id and e.kind='referee_resolved')
          or (exists (select 1 from bilateral_bet_events e where e.bet_id=bilateral_bets.id
            and e.kind='referee_resolved' and e.detail->>'transactionHash' is null)
            and exists (select 1 from outlayer_near_requests q where q.bet_id=bilateral_bets.id
              and q.contract_account=bilateral_bets.referee_wallet and q.method='request_ruling'
              and q.transaction_hash is not null and q.execution_status<>'failed')))))
    order by near_verified_at asc nulls first,id limit $1`, [limit]);
  const results = [];
  for (let bet of bets) {
    try {
      const user = await db.one('select * from users where id=$1', [bet.creator_user_id]);
      if (!user) throw new Error('The proposer account is unavailable');
      bet = await syncNearBet(db, config, user, bet.id, { fetchImpl, chain, skipOutlayerRegistration: true });
      const material = boundMaterial(bet);
      const configView = await liveConfig(chain, config, bet);
      const escrowTerminal = ['settled', 'refunded'].includes(bet.status);
      let ruling;
      if (escrowTerminal) {
        ruling = await chain.view({ contractId: bet.referee_wallet, method: 'get_ruling', args: { bet_id: bet.id } });
        await snapshot(db, bet, configView, ruling, { escrowTerminal });
        if (ruling) await recordSettlement(db, bet, ruling, fetchImpl);
      } else if (!ACTIVE.includes(bet.status)) {
        results.push({ betId: bet.id, status: bet.status });
        continue;
      } else {
        ruling = await ensureOutlayerRegistration(db, config, chain, bet, { fetchImpl });
      }
      if (!ruling) { results.push({ betId: bet.id, status: escrowTerminal ? bet.status : 'registration_pending' }); continue; }
      await snapshot(db, bet, configView, ruling, { escrowTerminal });
      const busy = ['reading', 'pricing', 'running', 'paying'].includes(ruling.stage);
      const timeout = Number.isSafeInteger(configView.timeout_seconds) && configView.timeout_seconds > 0 ? configView.timeout_seconds : 600;
      // Older contract builds expose raw u64 JSON numbers. Round upward before
      // scheduling; exact material/hash and escrow bindings remain mandatory.
      const millis = value => typeof value === 'string' ? Number((BigInt(value) + 999999n) / 1000000n) : Math.ceil(value / 1000000);
      if (ruling.stage !== 'settled' && now >= outlayerReadyAt(material)
        && now >= millis(ruling.next_ns) && (!busy || now >= millis(ruling.started_ns) + timeout * 1000)) {
        const args = { bet_id: bet.id };
        const attemptKey = String(ruling.nonce);
        // Reconcile an already committed intent even when a later pool check
        // would pause new sends. Its signed bytes must not be orphaned.
        const existing = await db.one(`select id from outlayer_near_requests where bet_id=$1
          and contract_account=$2 and method='request_ruling' and intent_key=$3
          and args=$4::jsonb and execution_status='pending' order by created_at desc,id desc limit 1`,
        [bet.id, bet.referee_wallet, attemptKey, args]);
        const emptyOpen = material.evidence.kind === 'open' && Array.isArray(ruling.evidence) && ruling.evidence.length === 0;
        if (!existing && !escrowTerminal && !emptyOpen && !ruling.outcome && now < Date.parse(material.deadline) + 7 * 86400000) {
          const budget = await chain.view({ contractId: bet.referee_wallet, method: 'get_compute_budget' });
          if (!/^\d+$/.test(String(budget))) throw new Error('The referee returned an invalid compute budget.');
          if (ruling.stage === 'idle' || BigInt(budget) === 0n) {
            const last = await db.one(`select updated_at from outlayer_near_requests where bet_id=$1
              and contract_account=$2 and method='request_ruling' order by updated_at desc limit 1`, [bet.id, bet.referee_wallet]);
            const pause = await computePause(db, bet, ruling, budget, now, last?.updated_at);
            const delay = COMPUTE_RETRY_MS[Math.max(0, Math.min(pause.consecutive - 1, COMPUTE_RETRY_MS.length - 1))];
            if (BigInt(budget) === 0n || (pause.consecutive > 0 && now < pause.attemptedAt + delay)) {
              results.push({ betId: bet.id, status: BigInt(budget) === 0n ? 'compute_unfunded'
                : pause.failures + pause.admissionFailures > 0 ? 'pricing_backoff' : 'compute_underfunded' }); continue;
            }
            if (pause.consecutive > 0) await db.query(`insert into bilateral_bet_events (bet_id,actor_user_id,kind,detail)
              values($1,$2,'outlayer_compute_pause',$3)`, [bet.id, bet.creator_user_id,
              { ...pause, attemptedAt: now }]);
          }
        }
        const signer = await sponsor(db, config, chain);
        const rulingDailyLimit = config.outlayer?.rulingDailyLimit ?? 12;
        if (!Number.isSafeInteger(rulingDailyLimit) || rulingDailyLimit < 0) throw new Error('The ruling daily limit is invalid.');
        // Bind attempts in the ledger while preserving the exact contract ABI.
        await persistentCall(db, chain, bet, signer, 'request_ruling', args, '0', RULING_GAS, fetchImpl,
          { attemptKey, rulingDailyLimit });
        ruling = await chain.view({ contractId: bet.referee_wallet, method: 'get_ruling', args: { bet_id: bet.id } });
        validateRuling(bet, ruling);
        await snapshot(db, bet, configView, ruling, { escrowTerminal });
        bet = await syncNearBet(db, config, user, bet.id, { fetchImpl, chain, skipOutlayerRegistration: true });
        await recordSettlement(db, bet, ruling, fetchImpl);
      }
      results.push({ betId: bet.id, status: bet.status, stage: ruling.stage, outcome: ruling.outcome });
    } catch (error) { results.push({ betId: bet.id, status: 'error', error: error.message }); }
  }
  return { checked: results.length, errors: results.filter(result => result.status === 'error').length, results };
}

function evidenceUrl(value) {
  const invalid = () => fail('Use a public HTTPS link outside X, at most 600 characters.');
  if (typeof value !== 'string' || value.length > 600 || /[\s\p{Cc}\\#]/u.test(value) || !/^https:\/\//i.test(value)) invalid();
  const authority = value.slice(8).split(/[/?#]/, 1)[0];
  if (!authority || /[@:%]/.test(authority)) invalid();
  let parsed;
  try { parsed = new URL(value); } catch { invalid(); }
  const host = parsed.hostname.replace(/\.+$/, '').toLowerCase();
  const labels = host.split('.');
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.port || parsed.href.length > 600
    || isIP(host.replace(/^\[|\]$/g, '')) || labels.length < 2 || labels.at(-1).length < 2
    || labels.some(label => !/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    || /(?:^|\.)(?:localhost|local|internal|intranet|lan|home|onion|test|invalid|arpa)$/.test(host)
    || /(?:^|\.)(?:x|twitter)\.com$/.test(host)) invalid();
  // Keep the spelling committed by the caller; only the worker normalizes it.
  return value;
}

export { evidenceUrl as outlayerEvidenceUrl };

export async function submitOutlayerEvidence(db, config, chain, bet, user, { url, fetchImpl = fetch } = {}) {
  if (!user?.id || (!same(bet.creator_user_id, user.id) && !same(bet.acceptor_user_id, user.id))) fail('Only the two bettors can submit evidence.');
  bet = await syncNearBet(db, config, user, bet.id, { fetchImpl, chain, skipOutlayerRegistration: true });
  const material = boundMaterial(bet);
  const view = await liveConfig(chain, config, bet);
  if (!supportsOpenEvidence(view) || material.evidence.kind !== 'open') fail('This referee does not accept open evidence for this bet.');
  if (!ACTIVE.includes(bet.status) || Date.now() < Date.parse(material.deadline) || Date.now() >= outlayerReadyAt(material)) fail('Evidence is accepted only during the committed evidence window.');
  const account = same(bet.creator_user_id, user.id) ? bet.chain_state.creator : bet.chain_state.acceptor;
  if (!account || bet.acceptor_unbound) fail('Link both participant wallets before submitting evidence.');
  const args = { bet_id: bet.id, url: evidenceUrl(url) };
  const deposit = view.evidence_deposit_yocto
    || ((BigInt(Buffer.byteLength(args.url)) + 512n) * 10000000000000000000n).toString();
  if (typeof deposit !== 'string' || !/^[1-9]\d{0,38}$/.test(deposit)) fail('The evidence storage deposit is invalid.');
  const registered = await ensureOutlayerRegistration(db, config, chain, bet, { fetchImpl });
  if (!registered) throw new Error('Evidence registration is pending verification. Retry this link shortly.');
  if (Date.now() >= outlayerReadyAt(material)) fail('The evidence window closed while registration was being verified.');
  const managed = await playAccountFor(db, user.x_user_id);
  if (managed?.ready && managed.account_id === account && !managed.claimed_at) {
    const signer = await db.tx(async tx => {
      const current = await tx.one('select * from play_accounts where x_user_id=$1 for update', [String(user.x_user_id)]);
      if (!current?.ready || current.account_id !== account || current.claimed_at) fail('The managed participant account is unavailable.');
      return { id: account, secret: secretOf(config, current) };
    });
    const request = await persistentCall(db, chain, bet, signer, 'submit_evidence', args, deposit, GAS, fetchImpl);
    if (request.execution_status === 'failed') fail('The evidence transaction failed. Check the referee limits and submit another link.');
    if (request.execution_status !== 'succeeded') throw new UserError('Evidence is pending verification. Retry this link to check its transaction.', 409);
    return { requestId: request.id, transactionHash: request.transaction_hash, status: request.execution_status };
  }
  const { request, reused } = await reserveNearRequest(db, { bet, user, account, method: 'submit_evidence', args,
    metadata: {}, depositYocto: deposit, contract: bet.referee_wallet });
  const payload = walletPayload({ contract: bet.referee_wallet, accountId: account, methodName: request.method,
    args: request.args, depositYocto: deposit, requestId: request.id });
  return { payload, method: request.method, args: request.args, depositYocto: deposit, accountId: account, requestId: request.id, reused };
}

function verifiedResult(result, material, bet) {
  if (!result) return null;
  const expected = materialHash({ claim: material.claim, madeAt: material.made_at, deadline: material.deadline,
    postUrl: material.post_url, bets: [{ id: bet.id, termsHash: bet.terms_hash }] });
  if (result.bet_id !== bet.id || result.terms_hash !== bet.terms_hash || result.material_hash !== expected
    || !Array.isArray(result.verdicts) || result.verdicts.length !== ROSTER.length) fail('The jury result is not bound to this bet.');
  result.verdicts.forEach((verdict, index) => {
    if (verdict.model !== ROSTER[index] || !['yes', 'no', 'unclear'].includes(verdict.outcome)
      || typeof verdict.confidence !== 'number' || !Number.isFinite(verdict.confidence)
      || verdict.confidence < 0 || verdict.confidence > 1) fail('The jury result contains an invalid verdict.');
  });
  if (decide(result.verdicts, 0.8) !== result.outcome) fail('The jury result violates its decision policy.');
  return result;
}

// Only finalized, actor-bound submissions appear here. The worker fetches text;
// server pages show the submitted URLs without substituting local page extracts.
export async function outlayerEvidenceForBet(db, betId) {
  return db.many(`select distinct on (submitted.user_id, submitted.url) submitted.* from (
    select r.id::text, case when r.signer_account=b.creator_wallet then b.creator_user_id else b.acceptor_user_id end as user_id,
      case when r.signer_account=b.creator_wallet then b.creator_side else case b.creator_side when 'yes' then 'no' else 'yes' end end as side,
      r.args->>'url' as url, r.created_at as at
    from outlayer_near_requests r join bilateral_bets b on b.id=r.bet_id
    where r.bet_id=$1 and r.method='submit_evidence' and r.execution_status='succeeded'
      and r.contract_account=b.referee_wallet and r.signer_account in (b.creator_wallet,b.acceptor_wallet)
    union all
    select r.id::text,r.user_id,case when r.wallet_account=b.creator_wallet then b.creator_side
      else case b.creator_side when 'yes' then 'no' else 'yes' end end,r.args->>'url',r.created_at
    from bilateral_near_requests r join bilateral_bets b on b.id=r.bet_id
    where r.bet_id=$1 and r.method='submit_evidence' and r.execution_status='succeeded'
      and r.metadata->>'contract'=b.referee_wallet and r.wallet_account in (b.creator_wallet,b.acceptor_wallet)
  ) submitted order by submitted.user_id,submitted.url,submitted.at limit 20`, [betId]);
}

export async function readOutlayerRuling(db, betId) {
  const row = await db.one(`select b.*,e.detail,e.at as recorded_at from bilateral_bets b
    join lateral (select detail,at from bilateral_bet_events where bet_id=b.id and kind='outlayer_ruling'
      order by id desc limit 1) e on true where b.id=$1
      and octet_length(e.detail::text)<=2097152 and octet_length(b.outlayer_material::text)<=32768`, [betId]);
  if (!row) return null;
  try {
    const material = boundMaterial(row);
    const { referee, config, ruling } = row.detail;
    if (referee !== row.referee_wallet || !config?.escrow) return null;
    validateRuling(row, ruling);
    const result = verifiedResult(ruling.result || ruling.jury_result || ruling.last_result || null, material, row);
    return { referee, config, ruling, material, salt: row.terms_salt, result, recordedAt: row.recorded_at };
  } catch { return null; }
}
