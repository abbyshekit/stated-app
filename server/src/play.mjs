// INTEGRATION: NEAR accounts named after X handles. Each X user who bets from a
// reply gets an account under the treasury's name, created by the treasury.
// This server holds that account's key, sealed with STATED_TOKEN_KEY, until the
// person claims the account.
//
// On testnet (the default) the treasury also pays for stakes: test NEAR has no
// monetary value. On mainnet the treasury pays only what a new account needs for
// network fees, a stake is the person's own NEAR, and only people on the
// operator's list (STATED_PILOT_X_IDS) get an account at all.
//
// Signing here never establishes that anything happened. Every action goes
// through the same reserved request and finalized-transaction verification as
// a browser wallet: prepareNearAction, then verifyBetTransaction, then syncNearBet.
import Decimal from 'decimal.js';
import { randomBytes } from 'node:crypto';
import { Account, FailoverRpcProvider, JsonRpcProvider, KeyPair, KeyPairSigner, PublicKey, actions } from 'near-api-js';
import { open, seal } from './crypto.mjs';
import { kvGet, kvSet } from './db.mjs';
import { verifyBetTransaction } from './near-execution-state.mjs';
import { deliveryFromReceipts } from './near-delivery.mjs';
import { prepareNearAction, syncNearBet } from './near-bets.mjs';
import { functionCallFunds, NEAR_CALL_GAS as GAS, rpc, rpcUrls } from './near-escrow.mjs';
import { inPilot, isNamedAccount, network, unit } from './near-network.mjs';
import { UserError } from './store.mjs';

const D = Decimal.clone({ precision: 60 });
const NEAR = new D('1e24');
export const yocto = (near) => new D(near).mul(NEAR).toFixed(0);
export const near = (yoctoAmount) => new D(yoctoAmount).div(NEAR).toFixed();

// On testnet a new account starts with enough for one full-size Bet and its fees. Top-ups
// stop at the lifetime grant, so one account cannot drain the treasury.
const LIFETIME_GRANT_YOCTO = yocto('6');
const TREASURY_LOW_YOCTO = yocto('4');

/**
 * The account a key controls with no transaction at all: its public key in hex. NEAR sent to that
 * name brings the account into being, and only the key can sign for it.
 */
export function implicitAccountId(publicKey) {
  return Buffer.from(PublicKey.fromString(publicKey).data).toString('hex');
}

export { inPilot };

/** The real chain. Tests pass an object with the same methods. */
export function nearChain({ urls = rpcUrls(), fetchImpl = fetch } = {}) {
  const provider = new FailoverRpcProvider(urls.map((url) => new JsonRpcProvider({ url })));
  const signer = (id, secret) => new Account(id, provider, new KeyPairSigner(KeyPair.fromString(secret)));
  const sent = (result) => {
    const status = result?.status || {};
    const hash = result?.transaction?.hash || null;
    const ok = Boolean(hash) && result.final_execution_status === 'FINAL' && typeof status.SuccessValue === 'string';
    return { hash, ok, failure: ok ? null : Object.hasOwn(status, 'Failure') ? JSON.stringify(status.Failure).slice(0, 400) : 'Final success not established' };
  };
  const send = async (id, secret, receiverId, list) => sent(await signer(id, secret).signAndSendTransaction({
    receiverId, actions: list, waitUntil: 'FINAL', throwOnFailure: false }));
  return {
    newKey() {
      const key = KeyPair.fromRandom('ed25519');
      return { secret: key.toString(), publicKey: key.getPublicKey().toString() };
    },
    // Testnet only: mainnet has no faucet.
    async faucet(accountId, publicKey) {
      const { faucet } = network();
      if (!faucet) throw new Error('There is no faucet on NEAR mainnet. Fund the treasury account yourself.');
      const response = await fetchImpl(faucet, { method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ newAccountId: accountId, newAccountPublicKey: publicKey }),
        signal: AbortSignal.timeout(30000), redirect: 'error' });
      if (!response.ok) throw new Error(`Testnet faucet refused: HTTP ${response.status}`);
    },
    async balance(accountId) {
      try {
        const state = await rpc('query', { request_type: 'view_account', finality: 'final', account_id: accountId }, { fetchImpl });
        return typeof state.amount === 'string' ? state.amount : null;
      } catch (error) {
        if (error.rpcCause === 'UNKNOWN_ACCOUNT' || /does not exist/i.test(String(error.message))) return null;
        throw error;
      }
    },
    callFunds: (accountId, gas = GAS) => functionCallFunds(accountId, gas, { fetchImpl }),
    async hasKey(accountId, publicKey, { fullAccess = false } = {}) {
      try {
        const key = await rpc('query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey }, { fetchImpl });
        // Some providers return an old-style query error inside result.
        if (typeof key?.error === 'string' && /^(access key|account) .+ does not exist while viewing/i.test(key.error)) return false;
        const access = key?.permission;
        if (key?.error || !Number.isSafeInteger(key?.nonce) || key.nonce < 0
          || (access !== 'FullAccess' && !access?.FunctionCall)) throw new Error('Invalid NEAR access key result');
        return !fullAccess || access === 'FullAccess';
      } catch (error) {
        // Only a definite "no such key" is a no. An outage must not read as a lost key.
        if (['UNKNOWN_ACCESS_KEY', 'UNKNOWN_ACCOUNT'].includes(error.rpcCause)) return false;
        throw error;
      }
    },
    async depositDelivery(payment) {
      if (!/^[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(payment.transactionHash)) return null;
      const params = { tx_hash: payment.transactionHash, sender_account_id: payment.accountId, wait_until: 'NONE' };
      const result = await rpc('tx_status', params, { fetchImpl });
      return deliveryFromReceipts(result, payment);
    },
    createAccount: ({ parentId, parentSecret, accountId, publicKey, amountYocto }) => send(parentId, parentSecret, accountId,
      [actions.createAccount(), actions.transfer(BigInt(amountYocto)), actions.addFullAccessKey(PublicKey.fromString(publicKey))]),
    transfer: ({ fromId, secret, toId, amountYocto }) => send(fromId, secret, toId, [actions.transfer(BigInt(amountYocto))]),
    call: ({ signerId, secret, contractId, method, args, depositYocto = '0', gas = GAS }) => send(signerId, secret, contractId,
      [actions.functionCall(method, args, gas, BigInt(depositYocto))]),
    // A read of another contract's state (a token balance, a storage registration). Costs nothing.
    async view({ contractId, method, args = {} }) {
      const result = await rpc('query', { request_type: 'call_function', finality: 'final', account_id: contractId,
        method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') }, { fetchImpl });
      if (typeof result.error === 'string') throw new Error(`NEAR view error: ${result.error.slice(0, 300)}`);
      return JSON.parse(Buffer.from(result.result).toString('utf8'));
    },
    deploy: ({ accountId, secret, wasm, init = 'new' }) => send(accountId, secret, accountId,
      [actions.deployContract(wasm), actions.functionCall(init, {}, GAS, 0n)]),
    // Creates a contract account under the parent's name with its code and no access key, in one
    // transaction: it either all happens or none of it does, and no key for the account ever exists.
    deployLocked: ({ parentId, parentSecret, accountId, wasm, amountYocto, init = 'new' }) => send(parentId, parentSecret, accountId,
      [actions.createAccount(), actions.transfer(BigInt(amountYocto)), actions.deployContract(wasm), actions.functionCall(init, {}, GAS, 0n)]),
    // Removes an account's only key. After this nobody can redeploy its code or sign for it.
    lock: ({ accountId, secret, publicKey }) => send(accountId, secret, accountId, [actions.deleteKey(PublicKey.fromString(publicKey))]),
    drain: ({ fromId, secret, toId }) => send(fromId, secret, fromId, [actions.deleteAccount(toId)]),
    rotateKey: ({ accountId, secret, addPublicKey, removePublicKey }) => send(accountId, secret, accountId,
      [actions.addFullAccessKey(PublicKey.fromString(addPublicKey)), actions.deleteKey(PublicKey.fromString(removePublicKey))]),
  };
}

// Stores a value only if the key is new, then returns what is stored: two
// instances that race to create the same account end up holding one key.
async function kvOnce(db, key, value) {
  await db.query('insert into kv (key, value) values ($1, $2) on conflict (key) do nothing', [key, String(value)]);
  return kvGet(db, key);
}

function assertPlay(config) {
  if (!config.play?.enabled) throw new UserError('Bets from replies are not turned on here.', 503);
  if (!config.tokenKey) throw new Error('STATED_TOKEN_KEY is required to hold play-account keys.');
}

/**
 * A database belongs to one network: its accounts, keys and Bets are that network's. The first
 * start records which, and a server on the other network refuses to use it. A database that
 * already holds accounts or funded Bets and has no record is taken to be testnet's, which is all
 * that existed before mainnet mode.
 */
export async function assertDatabaseNetwork(db, config) {
  const id = config.near?.network || 'testnet';
  const recorded = await kvGet(db, 'near_network');
  if (recorded && recorded !== id) throw new Error(`This database belongs to NEAR ${recorded}. A ${id} server needs a database of its own.`);
  if (recorded) return;
  if (id === 'mainnet') {
    const used = (await db.one('select 1 as found from play_accounts limit 1'))
      || (await db.one('select 1 as found from bilateral_bets where chain_state is not null limit 1'));
    if (used) throw new Error('This database already holds testnet accounts or Bets. A mainnet server needs a database of its own.');
  }
  const winner = await kvOnce(db, 'near_network', id);
  if (winner !== id) throw new Error(`This database belongs to NEAR ${winner}. A ${id} server needs a database of its own.`);
}

/** The treasury that funds new accounts: from the environment, or made once from the faucet. */
export async function treasury(db, config, chain) {
  assertPlay(config);
  if (config.play.treasury || config.play.treasuryKey) {
    if (!config.play.treasury || !config.play.treasuryKey) {
      throw new Error('Set both STATED_PLAY_TREASURY and STATED_PLAY_TREASURY_KEY.');
    }
    if (!isNamedAccount(config.play.treasury)) throw new Error(`STATED_PLAY_TREASURY must be a .${network().suffix} account.`);
    return { id: config.play.treasury, secret: config.play.treasuryKey };
  }
  const stored = await kvGet(db, 'play_treasury');
  if (stored) {
    const value = JSON.parse(open(stored, config.tokenKey));
    return { id: value.id, secret: value.secret };
  }
  if (!config.play.autoProvision || network().real) throw new Error('No play treasury. Set STATED_PLAY_TREASURY and STATED_PLAY_TREASURY_KEY.');
  // The key is stored before the faucet is asked, so a crash cannot lose a funded account.
  let pending = await kvGet(db, 'play_treasury_pending');
  if (!pending) {
    const key = chain.newKey();
    pending = await kvOnce(db, 'play_treasury_pending',
      seal(JSON.stringify({ id: `stated-play-${randomBytes(5).toString('hex')}.testnet`, secret: key.secret, publicKey: key.publicKey }), config.tokenKey));
  }
  const made = JSON.parse(open(pending, config.tokenKey));
  if ((await chain.balance(made.id)) == null) await chain.faucet(made.id, made.publicKey);
  await kvSet(db, 'play_treasury', seal(JSON.stringify({ id: made.id, secret: made.secret }), config.tokenKey));
  return { id: made.id, secret: made.secret };
}

/** Tops the treasury up from the faucet when it runs low. At most once every two minutes. */
export async function refillTreasury(db, config, chain) {
  const bank = await treasury(db, config, chain);
  // A treasury supplied by the operator is the operator's to fund; only a faucet-made one refills itself.
  if (config.play.treasury || !config.play.autoProvision) return { refilled: false, balance: null };
  const balance = await chain.balance(bank.id);
  if (balance != null && new D(balance).gte(TREASURY_LOW_YOCTO)) return { refilled: false, balance };
  const last = Number(await kvGet(db, 'play_treasury_refill_at') || 0);
  if (Date.now() - last < 2 * 60 * 1000) return { refilled: false, balance };
  await kvSet(db, 'play_treasury_refill_at', Date.now());
  const key = chain.newKey();
  const id = `stated-drop-${randomBytes(6).toString('hex')}.testnet`;
  await chain.faucet(id, key.publicKey);
  const moved = await chain.drain({ fromId: id, secret: key.secret, toId: bank.id });
  return { refilled: moved.ok, balance: await chain.balance(bank.id) };
}

/** Keeps the referee able to reserve the gas for a ruling. */
export async function topUpReferee(db, config, chain) {
  const judge = await referee(db, config, chain);
  const { balance, reserve } = await chain.callFunds(judge.id);
  if (balance >= reserve) return false;
  const bank = await treasury(db, config, chain);
  return (await chain.transfer({ fromId: bank.id, secret: bank.secret, toId: judge.id, amountYocto: yocto('0.2') })).ok;
}

/** The referee account: decides a Bet from Stated's recorded Result. Its key never leaves this server. */
export async function referee(db, config, chain) {
  const stored = await kvGet(db, 'play_referee');
  if (stored) return JSON.parse(open(stored, config.tokenKey));
  const bank = await treasury(db, config, chain);
  const id = `referee.${bank.id}`;
  let pending = await kvGet(db, 'play_referee_pending');
  if (!pending) {
    const fresh = chain.newKey();
    pending = await kvOnce(db, 'play_referee_pending', seal(JSON.stringify({ id, secret: fresh.secret, publicKey: fresh.publicKey }), config.tokenKey));
  }
  if (JSON.parse(open(pending, config.tokenKey)).id !== id) throw new Error('The stored referee key belongs to a different treasury.');
  const key = JSON.parse(open(pending, config.tokenKey));
  if ((await chain.balance(id)) == null) {
    const made = await chain.createAccount({ parentId: bank.id, parentSecret: bank.secret, accountId: id, publicKey: key.publicKey, amountYocto: yocto('0.3') });
    if (!made.ok) throw new Error(`The referee account could not be created: ${made.failure || 'no transaction'}`);
  } else if (!(await chain.hasKey(id, key.publicKey))) {
    throw new Error('The referee account exists with a key this server does not hold.');
  }
  await kvSet(db, 'play_referee', seal(JSON.stringify({ id, secret: key.secret }), config.tokenKey));
  return { id, secret: key.secret };
}

export async function refereeId(db, config) {
  const stored = await kvGet(db, 'play_referee');
  return stored ? JSON.parse(open(stored, config.tokenKey)).id : null;
}

/** A NEAR account name from an X handle. Handles NEAR cannot spell fall back to the numeric X id. */
export function accountNameFor(username, xUserId, parent) {
  const handle = String(username || '').toLowerCase();
  const fallback = `x${String(xUserId).replace(/\D/g, '')}`;
  const spellable = /^[a-z0-9]+(?:_[a-z0-9]+)*$/.test(handle) && handle !== 'referee' && !/^x\d+$/.test(handle);
  const name = spellable ? handle : fallback;
  const id = `${name}.${parent}`;
  return id.length <= 64 ? id : `${fallback}.${parent}`;
}

/** The person's play account, created and funded on first use. Bound to the X user id, never to the handle. */
export async function ensurePlayAccount(db, config, chain, { xUserId, username }) {
  assertPlay(config);
  if (!inPilot(config, xUserId)) throw Object.assign(new UserError('Bets with real NEAR are invite-only for now.', 403), { pilot: true });
  const existing = await playAccountFor(db, xUserId);
  if (existing?.ready) return existing;
  return withManagedOperation(db, `managed-account:${config.near?.network || 'testnet'}:${String(xUserId)}`,
    'Your account is still being opened. Try again shortly.',
    (locked) => provisionPlayAccount(locked, config, chain, { xUserId, username }));
}

async function provisionPlayAccount(db, config, chain, { xUserId, username }) {
  const existing = await db.one('select * from play_accounts where x_user_id = $1', [String(xUserId)]);
  if (existing?.ready) return existing;
  const bank = await treasury(db, config, chain);
  let row = existing;
  if (!row) {
    // A burst of new handles cannot empty the treasury: past the hourly number, new people wait.
    const recent = await db.one(`select count(*)::int as n from play_accounts where created_at > clock_timestamp() - interval '1 hour'`);
    if (recent.n >= config.play.newAccountsPerHour) throw new UserError('New play accounts are paused for the hour.', 429);
    const key = chain.newKey();
    let accountId = accountNameFor(username, xUserId, bank.id);
    // A recycled handle may already own that name; the id-based name is always free for this person.
    const taken = await db.one('select 1 as found from play_accounts where account_id = $1', [accountId]);
    if (taken || (await chain.balance(accountId)) != null) accountId = accountNameFor('', xUserId, bank.id);
    row = await db.one(`insert into play_accounts (x_user_id, account_id, secret_sealed, public_key)
      values ($1, $2, $3, $4) on conflict (x_user_id) do update set x_user_id = excluded.x_user_id returning *`,
    [String(xUserId), accountId, seal(key.secret, config.tokenKey), key.publicKey]);
  }
  // The key was stored first. Create the account unless an earlier attempt already did.
  if ((await chain.balance(row.account_id)) == null) {
    // Money is about to leave the treasury: top it up first if it is running low.
    await refillTreasury(db, config, chain);
    const made = await chain.createAccount({ parentId: bank.id, parentSecret: bank.secret, accountId: row.account_id,
      publicKey: row.public_key, amountYocto: yocto(config.play.startNear || '1.6') });
    if (!made.ok) throw new Error(`The play account could not be created: ${made.failure || 'no transaction'}`);
  } else if (!(await chain.hasKey(row.account_id, row.public_key))) {
    throw new Error(`That account name exists on ${network().id} with a key this server does not hold.`);
  }
  return db.one(`update play_accounts set ready = true, granted_yocto = case when granted_yocto = '0' then $2 else granted_yocto end
    where x_user_id = $1 returning *`, [String(xUserId), yocto(config.play.startNear || '1.6')]);
}

export async function playAccountFor(db, xUserId) {
  return db.one('select * from play_accounts where x_user_id = $1', [String(xUserId)]);
}

/** The key this server holds for an account that has not been claimed. Throws once it has. */
export function secretOf(config, account) {
  if (account.claimed_at || !account.secret_sealed) {
    throw new UserError('You claimed this account, so only your own wallet can sign for it now.', 409);
  }
  return open(account.secret_sealed, config.tokenKey);
}

/** How much more the account needs before it can cover a deposit and its fees. "0" when it has enough. */
export async function shortfall(config, chain, account, neededYocto) {
  const { balance, reserve } = await chain.callFunds(account.account_id);
  const deposit = BigInt(neededYocto);
  // Only a positive escrow deposit must preserve the grant. A cancellation
  // or withdrawal can use it to pay network fees.
  const grant = config.play.fundsStakes === false && deposit > 0n ? BigInt(account.granted_yocto ?? '0') : 0n;
  const want = deposit + (grant > reserve ? grant : reserve);
  return balance >= want ? '0' : (want - balance).toString();
}

/**
 * Makes sure the account can cover a deposit. On testnet it is topped up from the
 * treasury within the lifetime grant. With real NEAR the treasury never pays for a
 * stake: the person adds the difference themselves.
 */
export async function ensureFunds(db, config, chain, account, neededYocto) {
  const short = await shortfall(config, chain, account, neededYocto);
  if (short === '0') return;
  if (config.play.fundsStakes === false) {
    const more = new D(short).div(NEAR).toDecimalPlaces(2, Decimal.ROUND_UP).toFixed();
    throw Object.assign(new UserError(`This account needs ${more} more NEAR for that.`, 409), { funds: true, shortYocto: short });
  }
  // The grant is reserved in one statement before any money moves, so two actions at once
  // cannot both pass the limit, and a crash can only over-count it.
  const reserved = await db.one(`update play_accounts set granted_yocto = (granted_yocto::numeric + $2::numeric)::text
    where x_user_id = $1 and granted_yocto::numeric + $2::numeric <= $3::numeric returning x_user_id`,
  [account.x_user_id, short, LIFETIME_GRANT_YOCTO]);
  if (!reserved) throw Object.assign(new UserError(`That stake is more ${unit()} than this account has left.`, 409), { funds: true });
  await refillTreasury(db, config, chain);
  const bank = await treasury(db, config, chain);
  let moved = { ok: false };
  try { moved = await chain.transfer({ fromId: bank.id, secret: bank.secret, toId: account.account_id, amountYocto: short }); }
  finally {
    if (!moved.ok) {
      await db.query(`update play_accounts set granted_yocto = (granted_yocto::numeric - $2::numeric)::text where x_user_id = $1`, [account.x_user_id, short]);
    }
  }
  if (!moved.ok) throw Object.assign(new UserError('Test NEAR is out for the moment. Try again shortly.', 503), { funds: true });
}

/**
 * One escrow action signed by the person's play account. Returns the synced Bet.
 * The wallet step is the only difference from the browser path.
 */
export async function playAction(db, config, chain, user, betId, input, { fetchImpl = fetch } = {}) {
  if (input.action === 'accept') {
    const reference = typeof betId === 'string' ? betId.toLowerCase() : betId;
    return withManagedOperation(db, `managed-accept:${config.nearContract}:${reference}:${user.id}`,
      'Your stake is still being matched. Retry verification shortly.',
      (locked) => performPlayAction(locked, config, chain, user, reference, input, { fetchImpl }));
  }
  return performPlayAction(db, config, chain, user, betId, input, { fetchImpl });
}

// Session-scoped because each reservation and verification must commit normally.
// All work uses this one connection; waiting contenders hold no pool connection.
async function withManagedOperation(db, key, busyMessage, fn) {
  const deadline = performance.now() + 5000;
  const busy = () => new UserError(busyMessage, 409);
  for (;;) {
    const remaining = deadline - performance.now();
    if (remaining <= 0) throw busy();
    const client = await new Promise((resolve, reject) => {
      let expired = false;
      const timer = setTimeout(() => { expired = true; reject(busy()); }, remaining);
      db.pool.connect((error, connected) => {
        clearTimeout(timer);
        if (expired) { connected?.release(); return; }
        if (error) reject(error);
        else resolve(connected);
      });
    });
    let locked = false;
    let releaseError;
    try {
      const result = await client.query('select pg_try_advisory_lock(hashtextextended($1, 0)) as locked', [key]);
      locked = result.rows[0].locked;
      if (locked) {
        const bound = {
          query: (sql, params) => client.query(sql, params),
          one: async (sql, params) => (await client.query(sql, params)).rows[0] || null,
          many: async (sql, params) => (await client.query(sql, params)).rows,
          async tx(work) {
            await client.query('begin');
            try {
              const value = await work(bound);
              await client.query('commit');
              return value;
            } catch (error) {
              await client.query('rollback');
              throw error;
            }
          },
        };
        return await fn(bound);
      }
    } finally {
      try {
        if (locked) await client.query('select pg_advisory_unlock(hashtextextended($1, 0))', [key]);
      } catch (error) { releaseError = error; throw error; }
      finally { client.release(releaseError); }
    }
    await new Promise((resolve) => setTimeout(resolve, Math.min(50, Math.max(0, deadline - performance.now()))));
  }
}

async function performPlayAction(db, config, chain, user, betId, input, { fetchImpl }) {
  assertPlay(config);
  const account = await playAccountFor(db, user.x_user_id);
  if (!account?.ready) throw new UserError('This person has no play account yet.', 409);
  secretOf(config, account);
  if (input.action === 'accept') {
    if (!inPilot(config, user.x_user_id)) throw new UserError('Bets with real NEAR are invite-only for now.', 403);
    const bet = await syncNearBet(db, config, user, betId, { fetchImpl });
    const request = await db.one(`select * from bilateral_near_requests
      where bet_id=$1 and user_id=$2 and wallet_account=$3 and method='accept_bet'
      and metadata->>'contract'=$4 order by created_at, id limit 1`,
    [betId, user.id, account.account_id, config.nearContract]);
    const exact = request && input.termsHash === bet.terms_hash && request.args.id === betId
      && request.args.binding_hash === request.binding_hash && request.metadata.depositYocto === bet.stake_yocto;
    if (exact && String(bet.acceptor_user_id) === String(user.id) && bet.acceptor_wallet === account.account_id
      && bet.chain_state?.acceptor_binding_hash === request.binding_hash
      && ['accepted', 'proposed', 'disputed', 'settled', 'refunded'].includes(bet.chain_state.status)) {
      return { bet, hash: request.transaction_hash, status: 'succeeded' };
    }
    // An interrupted finalized lookup can be checked again, but its signed
    // transaction must not be replaced by a second broadcast while unresolved.
    if (exact && bet.status === 'offered' && bet.chain_state?.status === 'offered'
      && request.transaction_hash && request.execution_status !== 'failed') {
      const verified = await verifyBetTransaction(db, config, user, betId,
        { requestId: request.id, transactionHash: request.transaction_hash }, { fetchImpl });
      if (verified.status === 'failed') throw new UserError(`NEAR rejected that: ${verified.explanation}`, 409);
      return { bet: await syncNearBet(db, config, user, betId, { fetchImpl }), hash: request.transaction_hash, status: verified.status };
    }
  }
  const prepared = await prepareNearAction(db, config, user, betId, { ...input, accountId: account.account_id }, { fetchImpl });
  const sign = async (tx, current) => {
    const secret = secretOf(config, current);
    await ensureFunds(tx, config, chain, current, prepared.depositYocto);
    return chain.call({ signerId: current.account_id, secret, contractId: prepared.payload.contract,
      method: prepared.method, args: prepared.args, depositYocto: prepared.depositYocto });
  };
  // On mainnet, serialize the balance check and signing with other spends, deposits and key handover.
  const sent = config.near?.real ? await db.tx(async (tx) => {
    await tx.query("set local lock_timeout = '5s'");
    const current = await tx.one('select * from play_accounts where x_user_id = $1 for update', [String(user.x_user_id)]);
    if (current?.account_id !== account.account_id || !current.ready) throw new UserError('This account is no longer available.', 409);
    return sign(tx, current);
  }) : await sign(db, account);
  if (!sent.hash) throw new Error('The transaction was not accepted by the network.');
  const verified = await verifyBetTransaction(db, config, user, betId, { requestId: prepared.requestId, transactionHash: sent.hash }, { fetchImpl });
  if (verified.status === 'failed') throw new UserError(`NEAR rejected that: ${sent.failure || verified.explanation}`, 409);
  const bet = await syncNearBet(db, config, user, betId, { fetchImpl });
  return { bet, hash: sent.hash, status: verified.status };
}

/** The referee settles an accepted Bet. Only a Bet funded with this referee can be settled this way. */
const REFEREE_TIMEOUT_MS = 120_000;

export async function refereeSettle(db, config, chain, bet, creator, outcome, { fetchImpl = fetch } = {}) {
  assertPlay(config);
  if (!['yes', 'no', 'void'].includes(outcome)) throw new Error('Unknown outcome');
  const judge = await referee(db, config, chain);
  if (!bet.referee_wallet || bet.referee_wallet !== judge.id || bet.chain_state?.referee !== judge.id) {
    throw new UserError('This Bet did not name Stated as its referee.', 409);
  }
  // The caller holds the Result's row lock through this call, so it must not wait forever on a stalled RPC.
  // A transaction that lands after the timeout is found by the next pass, which reads the chain first.
  let timer;
  const sent = await Promise.race([
    chain.call({ signerId: judge.id, secret: judge.secret, contractId: config.nearContract,
      method: 'referee_resolve', args: { id: bet.id, outcome } }),
    new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('The referee transaction is unconfirmed after 120 s; the next pass reads the chain.')), REFEREE_TIMEOUT_MS); timer.unref?.(); }),
  ]).finally(() => clearTimeout(timer));
  if (!sent.ok) throw new Error(`The referee transaction failed: ${sent.failure || 'not accepted'}`);
  const synced = await syncNearBet(db, config, creator, bet.id, { fetchImpl });
  await db.query(`insert into bilateral_bet_events (bet_id, actor_user_id, kind, detail) values ($1, $2, 'referee_resolved', $3)`,
    [bet.id, creator.id, { outcome, transactionHash: sent.hash, referee: judge.id }]);
  return { bet: synced, hash: sent.hash };
}

/** Hands the account to its owner: their key goes on, this server's key comes off, and the stored key is erased. */
export async function claimPlayAccount(db, config, chain, xUserId, publicKey) {
  assertPlay(config);
  if (!/^ed25519:[1-9A-HJ-NP-Za-km-z]{43,44}$/.test(String(publicKey || ''))) {
    throw new UserError('Enter a public key that starts with ed25519:');
  }
  try { PublicKey.fromString(publicKey); }
  catch { throw new UserError('That is not a valid ed25519 public key.'); }
  return db.tx(async (tx) => {
    await tx.query("set local lock_timeout = '5s'");
    const account = await tx.one('select * from play_accounts where x_user_id = $1 for update', [String(xUserId)]);
    if (!account?.ready) throw new UserError('You have no play account yet. Bet once and one is made for you.', 404);
    const secret = secretOf(config, account);
    if (publicKey === account.public_key) throw new UserError('That is the key this server already holds. Use one of your own.');
    // Recover a completed rotation whose connection was lost before the database commit.
    let transactionHash = null;
    const already = !(await chain.hasKey(account.account_id, account.public_key))
      && await chain.hasKey(account.account_id, publicKey, { fullAccess: true });
    if (!already) {
      const done = await chain.rotateKey({ accountId: account.account_id, secret, addPublicKey: publicKey, removePublicKey: account.public_key });
      if (!done.ok) throw new UserError(`NEAR did not change the keys: ${done.failure || 'not accepted'}`, 409);
      transactionHash = done.hash;
    }
    await tx.query('update play_accounts set secret_sealed = null, claimed_at = clock_timestamp() where x_user_id = $1', [String(xUserId)]);
    return { accountId: account.account_id, transactionHash };
  });
}
