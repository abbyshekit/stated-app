// Treasury admission runs under the shared outlayer-signer session lock.
import { kvGet, kvSet } from './db.mjs';
import { UserError } from './store.mjs';
import { TransactionExpiredError } from 'near-api-js/rpc-errors';

export const TREASURY_CALL_GAS = 100000000000000n;
const RULING_GAS = 300000000000000n;
export const MAX_REGISTRATION_DEPOSIT = (16384n + 32768n + 4096n) * 10000000000000000000n;
export const treasuryCreationKey = id => `treasury-account-creation:${id}`;
const fundingHistoryKey = (bank, recipient) => `treasury-funding-history:${bank}:${recipient}`;
const spendPrefix = bank => `treasury-spend-pending:${bank}:`;
const spendWatermarkKey = bank => `treasury-spend-height:${bank}`;
export const MAINNET_FEE_GRANT_YOCTO = '50000000000000000000000';
export const OUTLAYER_CLEANUP_COMPLETE_SQL = `coalesce((select (e.detail->>'escrow_terminal')::boolean
  and (e.detail->'ruling'='null'::jsonb or coalesce(e.detail->'ruling'->>'stage','idle')='settled')
  from bilateral_bet_events e where e.bet_id=bilateral_bets.id and e.kind='outlayer_ruling'
  order by e.id desc limit 1),false)`;

export async function initialMainnetGrant(db, config, chain, bank, row, { balance, fundingPending, requested }) {
  const check = async (tx, amount) => {
    if (balance != null || fundingPending) return;
    await assertTreasuryFundingLiquidity(tx, config, chain, bank.id, amount);
  };
  return db.tx(async tx => {
    // Count and immutable assignment stay atomic across processes. The caller
    // also holds the treasury signer lock through funding and finality.
    await tx.query("select pg_advisory_xact_lock(hashtextextended('play-mainnet-sponsor-grants', 0))");
    const assigned = await tx.one('select * from play_account_grants where x_user_id=$1', [row.x_user_id]);
    if (assigned) {
      if (assigned.account_id !== row.account_id || assigned.public_key !== row.public_key) {
        throw new UserError('This X account already received its starting balance. Restore its original account record before reopening it.', 409);
      }
      await check(tx, assigned.amount_yocto);
      return assigned.amount_yocto;
    }
    if (balance != null) throw new Error('This unfinished account has no recorded initial grant. Its funding needs operator review.');
    let amount = requested;
    if (BigInt(requested) > BigInt(MAINNET_FEE_GRANT_YOCTO)) {
      const used = await tx.one('select count(*)::int as n from play_account_grants where amount_yocto::numeric > $1::numeric', [MAINNET_FEE_GRANT_YOCTO]);
      if (used.n >= (config.play.sponsorLimit ?? 25)) amount = MAINNET_FEE_GRANT_YOCTO;
    }
    await check(tx, amount);
    await tx.query('insert into play_account_grants(x_user_id, account_id, public_key, amount_yocto) values($1,$2,$3,$4)',
      [row.x_user_id, row.account_id, row.public_key, amount]);
    return amount;
  });
}

export async function assertTreasuryFundingLiquidity(db, config, chain, id, amount) {
  const registration = BigInt(config.outlayer?.registrationDepositYocto || MAX_REGISTRATION_DEPOSIT);
  const call = await treasuryCallFunds(db, chain, id, TREASURY_CALL_GAS);
  await assertTreasuryLiquidity(db, chain, id, { spend: amount,
    registrationHeadroom: registration + BigInt(call.reserve) });
}

// The caller owns the shared treasury session lock and has checked admission.
// Keep ambiguous exposure durable even when the treasury has no play_accounts row.
export async function sendTreasuryFunding(db, chain, bank, accountId, prepare, pending = null) {
  if (pending && chain.preparedRetrySafe) {
    let retired = false;
    try { retired = await chain.preparedRetrySafe({ ...pending, transactionHash: pending.hash }, new TransactionExpiredError()); }
    catch { /* ambiguity retains the original bytes and treasury fence */ }
    if (retired) {
      await db.query('delete from kv where key=$1', [treasuryCreationKey(bank.id)]);
      throw new UserError('The prior treasury funding transaction expired without executing. Retry shortly.', 409);
    }
  }
  const intent = pending || { ...await prepare(), accountId };
  if (!intent.hash || !intent.signedTransaction) throw new Error('The treasury funding intent is incomplete.');
  await kvSet(db, treasuryCreationKey(bank.id), JSON.stringify(intent));
  await rememberTreasurySpend(db, bank.id, intent);
  const made = await chain.broadcastCall(intent);
  if (made.ok || made.final) {
    await kvSet(db, fundingHistoryKey(bank.id, accountId), JSON.stringify(intent));
    await db.query('delete from kv where key=$1', [treasuryCreationKey(bank.id)]);
  }
  await reconcileTreasurySpends(db, chain, bank.id, { strict: false });
  if (!made.ok && !made.final) throw new UserError('Treasury funding is still pending. Retry shortly.', 409);
  return made;
}

export async function assertTreasuryCreationAvailable(db, chain, id, accountId = null) {
  const value = await kvGet(db, treasuryCreationKey(id));
  const pending = value ? JSON.parse(value) : null;
  if (pending) {
    await rememberTreasurySpend(db, id, pending);
    let finalized = false;
    try { finalized = Boolean(chain.preparedFinalized && await chain.preparedFinalized(pending)); }
    catch { /* failed or unavailable history is not finality */ }
    let resolved = finalized;
    if (!resolved && chain.preparedRetrySafe) {
      try { resolved = await chain.preparedRetrySafe({ ...pending, transactionHash: pending.hash }, new TransactionExpiredError()); }
      catch { /* retain the fence when inclusion or retirement remains ambiguous */ }
    }
    if (resolved) {
      if (finalized) await kvSet(db, fundingHistoryKey(id, pending.accountId), value);
      await db.query('delete from kv where key=$1 and value=$2', [treasuryCreationKey(id), value]);
      return null;
    }
  }
  if (pending && pending.accountId !== accountId) {
    throw new UserError('A treasury-funded account transaction is still pending. Retry shortly.', 409);
  }
  return pending;
}

// A receipt can execute after its transaction's inclusion block. Its own block
// is the lower bound for every later view that might authorize more funding.
export async function fundingReceiptProof(result, receiverId, readBlock, { terminalRoot = true } = {}) {
  const first = result.transaction_outcome;
  const root = first?.outcome?.status?.SuccessReceiptId;
  const receipt = result.receipts_outcome?.find(item => item.id === root && item.outcome?.executor_id === receiverId);
  const status = receipt?.outcome?.status;
  if (first?.id !== result.transaction?.hash || first.outcome.executor_id !== result.transaction?.signer_id
    || !root || first.outcome.receipt_ids?.length !== 1 || first.outcome.receipt_ids[0] !== root
    || !status || Object.keys(status).length !== 1
    || (typeof status.SuccessValue !== 'string' && !status.Failure && (terminalRoot || typeof status.SuccessReceiptId !== 'string'))
    || (terminalRoot && (typeof status.SuccessValue === 'string') !== (typeof result.status?.SuccessValue === 'string'))
    || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(receipt?.block_hash || '')) return null;
  const block = await readBlock(receipt.block_hash);
  if (block?.header?.hash !== receipt.block_hash || !Number.isSafeInteger(block.header.height) || block.header.height < 0) return null;
  return { blockHeight: block.header.height, succeeded: typeof result.status?.SuccessValue === 'string' };
}

export async function rememberTreasurySpend(db, bank, intent) {
  if (!intent?.hash || !intent.signedTransaction) throw new Error('The treasury spend intent is incomplete.');
  await kvSet(db, `${spendPrefix(bank)}${intent.hash}`, JSON.stringify({ hash: intent.hash, signedTransaction: intent.signedTransaction }));
}

export async function reconcileTreasurySpends(db, chain, bank, { strict = true } = {}) {
  const saved = await kvGet(db, spendWatermarkKey(bank));
  let minimum = saved == null ? undefined : Number(saved);
  if (saved != null && (!Number.isSafeInteger(minimum) || minimum < 0)) throw new Error('Invalid treasury spend watermark');
  const pending = await db.many('select key,value from kv where left(key,length($1))=$1', [spendPrefix(bank)]);
  let unresolved = false;
  for (const row of pending) {
    const intent = JSON.parse(row.value);
    let proof; let retired = false;
    try { proof = await chain.preparedSpendFinalized?.(intent); } catch { /* unknown execution cannot release treasury liquidity */ }
    const finalized = proof && Number.isSafeInteger(proof.blockHeight) && proof.blockHeight >= 0;
    if (finalized) {
      minimum = Math.max(minimum ?? 0, proof.blockHeight);
      const advanced = await db.one(`insert into kv(key,value) values($1,$2) on conflict(key) do update
        set value=greatest(kv.value::bigint,excluded.value::bigint)::text,updated_at=clock_timestamp() returning value`,
      [spendWatermarkKey(bank), String(minimum)]);
      minimum = Number(advanced?.value);
      if (!Number.isSafeInteger(minimum) || minimum < proof.blockHeight) throw new Error('Invalid treasury spend watermark');
    } else {
      try { retired = Boolean(chain.preparedNeverExecuted && await chain.preparedNeverExecuted(intent)); }
      catch { /* root rollback can burn gas; only proven nonexecution retires without a height */ }
    }
    if (finalized || retired) {
      await db.query('delete from kv where key=$1 and value=$2', [row.key, row.value]);
    } else unresolved = true;
  }
  if (strict && unresolved) throw new UserError('Treasury spending is awaiting confirmation. Retry shortly.', 409);
  return minimum;
}

async function treasuryCallFunds(db, chain, bank, gas) {
  const minimum = await reconcileTreasurySpends(db, chain, bank);
  let funds;
  try { funds = await chain.callFunds(bank, gas, minimum === undefined ? {} : { minimumBlockHeight: minimum }); }
  catch (error) {
    if (error.staleBalance) throw new UserError('The treasury balance is stale. Retry after confirmation.', 409);
    throw error;
  }
  if (minimum !== undefined && (!Number.isSafeInteger(funds.blockHeight) || funds.blockHeight < minimum)) {
    throw new UserError('The treasury balance is stale. Retry after confirmation.', 409);
  }
  return funds;
}

export async function assertTreasurySpendFunds(db, chain, bank, deposit, gas) {
  const funds = await treasuryCallFunds(db, chain, bank, BigInt(gas));
  if (BigInt(funds.balance) < BigInt(deposit) + BigInt(funds.reserve)) {
    throw new UserError('Treasury spending is paused while its balance recovers. Retry shortly.', 409);
  }
}

async function recipientFundingHistory(db, chain, bank, recipient) {
  const value = await kvGet(db, fundingHistoryKey(bank, recipient));
  const history = value ? JSON.parse(value) : null;
  if (history && (!Number.isSafeInteger(history.blockHeight) || history.blockHeight < 0 || typeof history.succeeded !== 'boolean')) {
    let proof;
    try { proof = await chain.preparedFundingFinalized?.(history); } catch { /* retain the funding watermark until proof is available */ }
    if (!proof || !Number.isSafeInteger(proof.blockHeight) || proof.blockHeight < 0 || typeof proof.succeeded !== 'boolean') {
      throw new UserError('The funding balance is awaiting confirmation. Retry shortly.', 409);
    }
    Object.assign(history, proof);
    await kvSet(db, fundingHistoryKey(bank, recipient), JSON.stringify(history));
  }
  return history;
}

export async function treasuryRecipientFunds(db, chain, bank, recipient, gas) {
  const minimum = (await recipientFundingHistory(db, chain, bank, recipient))?.blockHeight;
  let funds;
  try { funds = await chain.callFunds(recipient, gas, minimum === undefined ? {} : { minimumBlockHeight: minimum }); }
  catch (error) {
    if (error.staleBalance) throw new UserError('The funding balance is stale. Retry after confirmation.', 409);
    throw error;
  }
  if (minimum !== undefined && (!Number.isSafeInteger(funds.blockHeight) || funds.blockHeight < minimum)) {
    throw new UserError('The funding balance is stale. Retry after confirmation.', 409);
  }
  return funds;
}

export async function treasuryRecipientBalance(db, chain, bank, recipient) {
  return (await recipientFundingHistory(db, chain, bank, recipient))?.succeeded
    ? String((await treasuryRecipientFunds(db, chain, bank, recipient, TREASURY_CALL_GAS)).balance)
    : chain.balance(recipient);
}

export async function assertTreasuryLiquidity(db, chain, id, { spend, gas = TREASURY_CALL_GAS, registrationHeadroom = 0n, excludeBetId = null } = {}) {
  // Only committed registration intents create liabilities. Unsponsored accepted
  // bets cannot prevent the first registration. Keep failed intents reserved too:
  // a downstream failure can retain its storage and still need a ruling later.
  const liabilities = await db.one(`select count(distinct bilateral_bets.id)::int as n from bilateral_bets
    join outlayer_near_requests r on r.bet_id=bilateral_bets.id
    where r.signer_account=$1 and r.method='register_material'
    and (bilateral_bets.status in ('accepted','proposed','disputed')
      or (bilateral_bets.status in ('settled','refunded') and not ${OUTLAYER_CLEANUP_COMPLETE_SQL}))
    and ($2::uuid is null or bilateral_bets.id<>$2::uuid)`, [id, excludeBetId]);
  if (!Number.isSafeInteger(liabilities?.n) || liabilities.n < 0) throw new Error('Invalid treasury registration liabilities');
  const funds = await treasuryCallFunds(db, chain, id, BigInt(gas));
  const ruling = await treasuryCallFunds(db, chain, id, RULING_GAS);
  // Reserve one future ruling for each committed bet plus the new admission.
  // callFunds includes live gas pricing, overhead and signer storage. Counting
  // storage more than once is conservative; refunds are never presumed liquid.
  const required = BigInt(spend) + BigInt(funds.reserve) + BigInt(registrationHeadroom)
    + (BigInt(liabilities.n) + 1n) * BigInt(ruling.reserve);
  if (BigInt(funds.balance) < required || BigInt(ruling.balance) < required) {
    throw new UserError('New sponsorship is paused while the treasury restores keeper liquidity. Try again later.', 409);
  }
}
