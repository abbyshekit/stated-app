// Funding from another chain, with finalized NEAR delivery verification.
// Account-changing operations must lock play_accounts by x_user_id before
// locking deposit rows. This serializes quotes, settlement and key handover
// across server processes; a process-local signing queue alone is insufficient.
import { randomUUID } from 'node:crypto';
import Decimal from 'decimal.js';
import { network } from './near-network.mjs';
import { assertSignerAvailable, reservePlaySigner, withAvailablePlaySigner, inPilot, playAccountFor, secretOf, yocto } from './play.mjs';
import { UserError } from './store.mjs';

const D = Decimal.clone({ precision: 60 });
export const MIN_DEPOSIT_NEAR = '0.05';
export const MAX_DEPOSIT_NEAR = '2';
const OPEN_AT_ONCE = 3;
const PER_DAY = 10;
const WRAP_REGISTRATION_YOCTO = '1250000000000000000000';
// Both calls execute well below this on wrap.near. An account with the
// standard fee grant can reserve 30 Tgas before it receives a payment.
const WRAP_CALL_GAS = 30_000_000_000_000n;
const FINAL = new Set(['SUCCESS', 'REFUNDED', 'FAILED', 'EXPIRED']);
const PAYABLE = new Set(['PENDING_DEPOSIT', 'INCOMPLETE_DEPOSIT']);
const positiveYocto = (value) => typeof value === 'string' && /^\d{1,60}$/.test(value) && BigInt(value) > 0n;

export const fundingOn = (config) => Boolean(config.near?.real && config.play?.enabled && config.intents?.deposits);

function amountYocto(value) {
  const text = String(value || '').trim();
  const amount = /^\d{1,2}(\.\d{1,4})?$/.test(text) ? new D(text) : null;
  if (!amount || amount.lt(MIN_DEPOSIT_NEAR) || amount.gt(MAX_DEPOSIT_NEAR)) {
    throw Object.assign(new UserError(`Enter ${MIN_DEPOSIT_NEAR} to ${MAX_DEPOSIT_NEAR} NEAR.`), { field: 'near' });
  }
  return yocto(text);
}

function refundAddress(value, token) {
  const text = String(value || '').trim();
  if (!/^[A-Za-z0-9][A-Za-z0-9:._-]{3,127}$/.test(text)) {
    throw Object.assign(new UserError(`Enter a ${token.chainName} address for refunds.`), { field: 'refundTo' });
  }
  return text;
}

/** Hide every still-payable address at its deadline, including part-paid addresses. */
export const lapsed = (row, now = Date.now()) => !row.finished_at && PAYABLE.has(row.state) && now >= new Date(row.deadline).getTime();

function assertOpenAccount(config, user, account) {
  if (!fundingOn(config)) throw new UserError('Paying from another chain is not turned on here.', 503);
  if (!inPilot(config, user.x_user_id)) throw new UserError('Bets with real NEAR are invite-only for now.', 403);
  if (!account?.ready) throw new UserError('Open your account first.', 409);
  if (account.claimed_at) throw new UserError('You hold this account’s key now. Send NEAR to it from your own wallet.', 409);
}

async function lockAccount(db, xUserId) {
  // Bound contention without timing out an idle transaction while its chain
  // request is in flight: releasing that fence early would permit a second signer.
  await db.query("set local lock_timeout = '5s'");
  return db.one('select * from play_accounts where x_user_id = $1 for update', [String(xUserId)]);
}

async function wrappedCall(config, chain, account, method, args, depositYocto) {
  const secret = secretOf(config, account);
  const { balance, reserve } = await chain.callFunds(account.account_id, WRAP_CALL_GAS);
  if (balance < reserve + BigInt(depositYocto)) {
    throw new UserError('Add NEAR to this account to cover network fees.', 409);
  }
  return { signerId: account.account_id, secret, contractId: network().wrap,
    method, args, depositYocto, gas: WRAP_CALL_GAS };
}

async function callWrappedNear(config, chain, account, method, args, depositYocto) {
  return chain.call(await wrappedCall(config, chain, account, method, args, depositYocto));
}

export async function registerForWrapped(config, chain, account, db = null) {
  if (db) await withAvailablePlaySigner(db, account.account_id, async () => {}, { chain, intentKey: 'wrapped-storage' });
  const wrap = network().wrap;
  const registered = await chain.view({ contractId: wrap, method: 'storage_balance_of', args: { account_id: account.account_id } });
  if (registered) return;
  const sent = db ? await chain.broadcastCall(await reservePlaySigner(db, chain, account.account_id, 'wrapped-storage',
    async (_tx, current) => {
      if (!current?.ready) throw new UserError('This account is no longer available.', 409);
      return chain.prepareCall(await wrappedCall(config, chain, current, 'storage_deposit',
        { account_id: account.account_id, registration_only: true }, WRAP_REGISTRATION_YOCTO));
    }))
    : await callWrappedNear(config, chain, account, 'storage_deposit',
      { account_id: account.account_id, registration_only: true }, WRAP_REGISTRATION_YOCTO);
  if (!sent.ok) throw new UserError('This account could not be prepared to receive NEAR. It may be out of NEAR for network fees.', 409);
}

/** Quote and insertion share an account lock, so a double press cannot allocate two addresses. */
export async function startDeposit(db, config, chain, intents, user, { assetId, near, refundTo }) {
  const wanted = amountYocto(near);
  assertOpenAccount(config, user, await playAccountFor(db, user.x_user_id));
  const token = (await intents.tokens()).find((t) => t.assetId === String(assetId || ''));
  if (!token) throw new UserError('Choose a token from the list.');
  const refund = refundAddress(refundTo, token);
  await registerForWrapped(config, chain, await playAccountFor(db, user.x_user_id), db);
  return db.tx(async (tx) => {
    const account = await lockAccount(tx, user.x_user_id);
    // Ownership can change while the token list is loading or the lock is waiting.
    assertOpenAccount(config, user, account);
    await assertSignerAvailable(tx, account.account_id, null, { chain });
    const same = await tx.one(`select * from play_deposits where x_user_id = $1 and origin_asset = $2 and near_yocto = $3 and refund_to = $4
      and finished_at is null and state = 'PENDING_DEPOSIT' and deadline > clock_timestamp()
      and created_at > clock_timestamp() - interval '2 minutes' order by created_at desc limit 1`,
    [account.x_user_id, token.assetId, wanted, refund]);
    if (same) return same;
    const counts = await tx.one(`select count(*) filter (where finished_at is null)::int as open,
      count(*) filter (where created_at > clock_timestamp() - interval '1 day')::int as today
      from play_deposits where x_user_id = $1`, [account.x_user_id]);
    if (counts.open >= OPEN_AT_ONCE) throw new UserError('You have payments still open. Finish those first, or wait for them to lapse.', 409);
    if (counts.today >= PER_DAY) throw new UserError('That is enough payments for one day. Try again tomorrow.', 429);
    const made = await intents.deposit({ assetId: token.assetId, yocto: wanted, recipient: account.account_id, refundTo: refund });
    if (!made.ok) {
      if (made.reason === 'minimum') {
        const least = new D(made.minimumYocto).div('1e24').toDecimalPlaces(2, Decimal.ROUND_UP).toFixed();
        throw new UserError(`${token.symbol} on ${token.chainName} moves at least ${least} NEAR at a time.`);
      }
      if (made.reason === 'refused') throw Object.assign(new UserError(`NEAR Intents did not accept that. Check that the refund address is a ${token.chainName} address.`), { field: 'refundTo' });
      throw new UserError('NEAR Intents could not be reached. Nothing was started; try again shortly.', 503);
    }
    return tx.one(`insert into play_deposits (id, x_user_id, account_id, origin_asset, origin_symbol, origin_chain, near_yocto,
        amount_in, min_amount_in, deposit_address, deposit_memo, refund_to, deadline, signed)
      values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14) returning *`,
    [randomUUID(), account.x_user_id, account.account_id, token.assetId, token.symbol, token.chainName, wanted,
      made.amountInFormatted, made.minAmountInFormatted, made.depositAddress, made.depositMemo, refund, made.deadline, JSON.stringify(made.signed)]);
  });
}

async function withdrawWrapped(config, chain, account, amountYocto = null) {
  const wrap = network().wrap;
  const held = await chain.view({ contractId: wrap, method: 'ft_balance_of', args: { account_id: account.account_id } });
  if (typeof held !== 'string' || !/^\d{1,60}$/.test(held)) throw new Error('Wrapped NEAR balance is unavailable.');
  const amount = amountYocto ?? held;
  if (BigInt(amount) === 0n || BigInt(held) < BigInt(amount)) return null;
  const sent = await callWrappedNear(config, chain, account, 'near_withdraw', { amount }, '1');
  if (!sent.ok || !sent.hash) throw new Error(`Wrapped NEAR could not be unwrapped: ${sent.failure || 'not accepted'}`);
  return sent.hash;
}

/** Returns a successful unwrap hash, null for a valid zero balance; invalid state is retryable. */
export async function unwrap(config, chain, account) {
  return withdrawWrapped(config, chain, account);
}

// Optional chain adapter: proves successful, finalized delivery by this exact
// destination transaction to this account. An account balance alone cannot
// establish which of several payments delivered the funds.
// The adapter returns { final: true, kind: 'native'|'wrapped', deliveredYocto }
// only after checking local chain receipts, otherwise null.
async function proveDelivery(chain, account, transactionHash, amountYocto) {
  if (!transactionHash || !positiveYocto(amountYocto) || typeof chain.depositDelivery !== 'function') return null;
  const proof = await chain.depositDelivery({ transactionHash, accountId: account.account_id,
    amountYocto, wrapContractId: network().wrap });
  if (proof?.final !== true || !['native', 'wrapped'].includes(proof.kind) || !positiveYocto(proof.deliveredYocto)
    || BigInt(proof.deliveredYocto) !== BigInt(amountYocto)) return null;
  return proof;
}

async function claimDelivery(tx, deposit, transactionHash, proof) {
  // This claim survives lost broadcasts. One transaction can fund multiple
  // recipients, but its net payment to one account belongs to one deposit.
  await tx.query(`insert into play_deposit_deliveries(transaction_hash, account_id, deposit_id, amount_yocto)
    values ($1, $2, $3, $4) on conflict do nothing`,
  [transactionHash, deposit.account_id, deposit.id, proof.deliveredYocto]);
  const claimed = await tx.one(`select deposit_id, amount_yocto from play_deposit_deliveries
    where transaction_hash = $1 and account_id = $2`, [transactionHash, deposit.account_id]);
  return String(claimed?.deposit_id) === String(deposit.id) && claimed.amount_yocto === proof.deliveredYocto;
}

async function reserveUnwrap(tx, deposit, hash) {
  await tx.query('insert into play_unwrap_transactions(transaction_hash, deposit_id) values($1,$2) on conflict do nothing',
    [hash, deposit.id]);
  const owner = await tx.one('select deposit_id from play_unwrap_transactions where transaction_hash = $1', [hash]);
  return String(owner?.deposit_id) === String(deposit.id);
}

async function completePreparedUnwrap(db, config, chain, row, now) {
  if (!row?.unwrap_signed_transaction || row.finished_at) return row;
  return db.tx(async (tx) => {
    const account = await lockAccount(tx, row.x_user_id);
    const fresh = await tx.one('select * from play_deposits where id = $1 and x_user_id = $2 for update', [row.id, String(row.x_user_id)]);
    if (!fresh || fresh.finished_at || !fresh.unwrap_signed_transaction) return fresh;
    if (account?.account_id !== fresh.account_id || account.claimed_at) return fresh;
    if (fresh.unwrap_attempted_at && now - new Date(fresh.unwrap_attempted_at).getTime() < 4000) return fresh;
    await tx.query('update play_deposits set unwrap_attempted_at = clock_timestamp(), checked_at = clock_timestamp() where id = $1', [fresh.id]);
    if (!await reserveUnwrap(tx, fresh, fresh.unwrap_pending_tx)) {
      // A legacy duplicate belongs to its recorded owner. Release this row's
      // copy so it can prepare its own unwrap after the owner settles.
      return tx.one('update play_deposits set unwrap_pending_tx = null, unwrap_signed_transaction = null where id = $1 returning *', [fresh.id]);
    }
    let delivered = false;
    let rejection = null;
    try {
      const payment = { transactionHash: fresh.unwrap_pending_tx, accountId: fresh.account_id, amountYocto: fresh.near_yocto };
      delivered = await chain.unwrapDelivery(payment);
      if (!delivered) {
        // The exact signed bytes committed above are the only permitted retry.
        // Any failure or lost response leaves the reservation in place.
        await chain.broadcastCall({ signedTransaction: fresh.unwrap_signed_transaction });
        delivered = await chain.unwrapDelivery(payment);
      }
    } catch (error) { rejection = error; }
    if (!delivered) {
      // A proven root rollback, or never-executed bytes beyond finalized
      // expiry, permits replacement. Ambiguous outcomes retain their bytes.
      try {
        if (typeof chain.unwrapRetrySafe === 'function' && await chain.unwrapRetrySafe({
          signedTransaction: fresh.unwrap_signed_transaction, transactionHash: fresh.unwrap_pending_tx,
        }, rejection)) {
          return tx.one('update play_deposits set unwrap_pending_tx = null, unwrap_signed_transaction = null where id = $1 returning *', [fresh.id]);
        }
      } catch { /* keep the reservation until its outcome is known */ }
      return fresh;
    }
    return tx.one(`update play_deposits set unwrap_tx = unwrap_pending_tx, finished_at = clock_timestamp(),
      checked_at = clock_timestamp() where id = $1 and finished_at is null returning *`, [fresh.id]);
  });
}

/** Refreshes under the account lock and reloads the row, never trusting a worker's old snapshot. */
export async function refreshDeposit(db, config, chain, intents, row, { now = Date.now() } = {}) {
  const updated = await db.tx(async (tx) => {
    const account = await lockAccount(tx, row.x_user_id);
    const fresh = await tx.one('select * from play_deposits where id = $1 and x_user_id = $2 for update', [row.id, String(row.x_user_id)]);
    if (!fresh) return null;
    if (fresh.finished_at) return fresh;
    if (fresh.unwrap_signed_transaction) return fresh;
    if (fresh.checked_at && now - new Date(fresh.checked_at).getTime() < 4000) return fresh;
    const found = await intents.status({ depositAddress: fresh.deposit_address, depositMemo: fresh.deposit_memo });
    if (!found.ok && fresh.state !== 'SUCCESS') {
      return tx.one('update play_deposits set checked_at = clock_timestamp() where id = $1 and finished_at is null returning *', [fresh.id]);
    }
    // SUCCESS can remain unfinished until local settlement catches up. A later
    // provider response cannot roll that delivery back to an earlier state.
    let state = FINAL.has(fresh.state) || (fresh.state !== 'PENDING_DEPOSIT' && found.state === 'PENDING_DEPOSIT')
      ? fresh.state : found.state;
    const details = found.ok && found.state === state ? found : {};
    if (state === 'PENDING_DEPOSIT' && now > new Date(fresh.deadline).getTime() + 60 * 60 * 1000) state = 'EXPIRED';
    // A partial payment remains watched after grace, for its refund or delivery.
    let unwrapTx = fresh.unwrap_tx;
    let done = FINAL.has(state);
    if (state === 'SUCCESS') {
      // A recorded unwrap was already confirmed. Never sign again for it.
      done = Boolean(unwrapTx);
      if (!done && account?.account_id === fresh.account_id) {
        try {
          const destinationTx = fresh.destination_tx || details.destinationTx;
          // EXACT_OUTPUT fixes the promised output in the stored request. A
          // provider's later status amount cannot replace it.
          const amount = details.deliveredYocto ?? fresh.delivered_yocto ?? fresh.near_yocto;
          const proof = positiveYocto(amount) && BigInt(amount) === BigInt(fresh.near_yocto)
            ? await proveDelivery(chain, account, destinationTx, fresh.near_yocto) : null;
          const claimed = proof && await claimDelivery(tx, fresh, destinationTx, proof);
          if (claimed && proof.kind === 'native') done = true;
          if (claimed && proof.kind === 'wrapped' && !account.claimed_at) {
            // Unwrap only this payment: sweeping the balance could leave a
            // second, independently delivered payment with no unwrap proof.
            if (typeof chain.prepareCall !== 'function' || typeof chain.broadcastCall !== 'function'
              || typeof chain.unwrapDelivery !== 'function') throw new Error('Resumable unwrapping is unavailable');
            await assertSignerAvailable(tx, account.account_id, fresh.id, { chain });
            const held = await chain.view({ contractId: network().wrap, method: 'ft_balance_of', args: { account_id: account.account_id } });
            if (positiveYocto(held) && BigInt(held) >= BigInt(proof.deliveredYocto)) {
              const prepared = await chain.prepareCall(await wrappedCall(config, chain, account, 'near_withdraw',
                { amount: proof.deliveredYocto }, '1'));
              if (!prepared.hash || !prepared.signedTransaction
                || !await reserveUnwrap(tx, fresh, prepared.hash)) throw new Error('Invalid prepared unwrap ownership');
              await tx.query(`update play_deposits set unwrap_pending_tx = $2, unwrap_signed_transaction = $3
                where id = $1 and unwrap_pending_tx is null`, [fresh.id, prepared.hash, prepared.signedTransaction]);
            }
          }
        } catch { /* local delivery or unwrapping is not yet established; retry */ }
      }
    }
    return tx.one(`update play_deposits set state = $2, delivered_yocto = coalesce($3, delivered_yocto), destination_tx = coalesce($4, destination_tx),
        unwrap_tx = $5, refunded = coalesce($6, refunded), refund_reason = coalesce($7, refund_reason), checked_at = clock_timestamp(),
        finished_at = case when $8 then clock_timestamp() else finished_at end
      where id = $1 and finished_at is null returning *`,
    [fresh.id, state, details.deliveredYocto, details.destinationTx, unwrapTx, details.refunded, details.refundReason, done]);
  });
  return completePreparedUnwrap(db, config, chain, updated, now);
}

export async function refreshOpenDeposits(db, config, chain, intents) {
  if (!fundingOn(config)) return 0;
  const rows = await db.many(`select * from play_deposits where finished_at is null
    and (checked_at is null or checked_at < clock_timestamp() - interval '20 seconds')
    order by checked_at asc nulls first, created_at, id limit 20`);
  for (const row of rows) await refreshDeposit(db, config, chain, intents, row);
  return rows.length;
}

export async function depositFor(db, xUserId, id) {
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(String(id))) return null;
  return db.one('select * from play_deposits where id = $1 and x_user_id = $2', [id, String(xUserId)]);
}

export async function recentDeposits(db, xUserId) {
  return db.many('select * from play_deposits where x_user_id = $1 order by created_at desc limit 5', [String(xUserId)]);
}
