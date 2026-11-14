// INTEGRATION: NEAR accounts named after X handles. Each X user who bets from a
// reply gets an account under the treasury's name, created by the treasury.
// This server holds that account's key, sealed with STATED_TOKEN_KEY, until the
// person claims the account.
//
// On testnet (the default) the treasury also pays for stakes: test NEAR has no
// monetary value. On mainnet new accounts normally receive only network fees;
// an optional sponsored grant has a lifetime recipient cap. The configured
// pilot list (STATED_PILOT_X_IDS), including its '*' option, controls access.
//
// Signing here never establishes that anything happened. Every action goes
// through the same reserved request and finalized-transaction verification as
// a browser wallet: prepareNearAction, then verifyBetTransaction, then syncNearBet.
import Decimal from 'decimal.js';
import { createHash, randomBytes } from 'node:crypto';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, PublicKey, SignedTransaction, actions, baseDecode, baseEncode } from 'near-api-js';
import { InvalidNonceError, TransactionExpiredError } from 'near-api-js/rpc-errors';
import { open, seal } from './crypto.mjs';
import { canonicalJson } from './canonical.mjs';
import { kvGet, kvSet } from './db.mjs';
import { verifyBetTransaction } from './near-execution-state.mjs';
import { deliveryFromReceipts } from './near-delivery.mjs';
import { prepareNearAction, syncNearBet } from './near-bets.mjs';
import { COURT_CALL_GAS, functionCallFunds, NEAR_CALL_GAS as GAS, rpc } from './near-escrow.mjs';
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
const MAINNET_FEE_GRANT_YOCTO = yocto('0.05');

async function initialMainnetGrant(db, config, row, balance) {
  return db.tx(async (tx) => {
    // One database-wide reservation lock makes count + assignment atomic across
    // processes. It is released before the network call; the assignment persists.
    await tx.query("select pg_advisory_xact_lock(hashtextextended('play-mainnet-sponsor-grants', 0))");
    const assigned = await tx.one('select * from play_account_grants where x_user_id=$1', [row.x_user_id]);
    if (assigned) {
      if (assigned.account_id !== row.account_id || assigned.public_key !== row.public_key) {
        throw new UserError('This X account already received its starting balance. Restore its original account record before reopening it.', 409);
      }
      return assigned.amount_yocto;
    }
    // A pre-migration interrupted creation has no reliable funding record. Never
    // substitute the current configuration for the amount that actually moved.
    if (balance != null) throw new Error('This unfinished account has no recorded initial grant. Its funding needs operator review.');
    const requested = yocto(config.play.startNear || '0.05');
    let amount = requested;
    if (BigInt(requested) > BigInt(MAINNET_FEE_GRANT_YOCTO)) {
      const used = await tx.one('select count(*)::int as n from play_account_grants where amount_yocto::numeric > $1::numeric', [MAINNET_FEE_GRANT_YOCTO]);
      // Zero deliberately disables sponsorship; it never means unlimited.
      if (used.n >= (config.play.sponsorLimit ?? 25)) amount = MAINNET_FEE_GRANT_YOCTO;
    }
    await tx.query('insert into play_account_grants(x_user_id, account_id, public_key, amount_yocto) values($1,$2,$3,$4)',
      [row.x_user_id, row.account_id, row.public_key, amount]);
    return amount;
  });
}

/**
 * The account a key controls with no transaction at all: its public key in hex. NEAR sent to that
 * name brings the account into being, and only the key can sign for it.
 */
export function implicitAccountId(publicKey) {
  return Buffer.from(PublicKey.fromString(publicKey).data).toString('hex');
}

export { inPilot };

/** The real chain. Tests pass an object with the same methods. */
const txHash = (transaction) => baseEncode(createHash('sha256').update(transaction.transaction.encode()).digest());
const validHash = (hash) => typeof hash === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(hash) && baseDecode(hash).length === 32;

function rootCallRolledBack(result, expected) {
  const matchesCall = items => Array.isArray(items) && items.length === 1 && Object.keys(items[0]).length === 1
    && items[0]?.FunctionCall?.method_name === expected.method
    && items[0].FunctionCall.args === expected.argsBase64
    && items[0].FunctionCall.deposit === expected.depositYocto
    && String(items[0].FunctionCall.gas) === String(expected.gas);
  const initial = result?.transaction_outcome;
  const root = initial?.outcome?.status?.SuccessReceiptId;
  const receipt = result?.receipts?.find(item => item.receipt_id === root);
  const outcome = result?.receipts_outcome?.find(item => item.id === root)?.outcome;
  return result?.final_execution_status === 'FINAL' && Boolean(result.status?.Failure)
    && Object.keys(result.status).length === 1 && result.transaction?.hash === expected.hash
    && result.transaction.signer_id === expected.signerId && result.transaction.receiver_id === expected.contractId
    && matchesCall(result.transaction.actions)
    && initial?.id === expected.hash && initial.outcome.executor_id === expected.signerId
    && initial.outcome.receipt_ids?.length === 1 && initial.outcome.receipt_ids[0] === root
    && receipt?.receiver_id === expected.contractId && receipt.predecessor_id === expected.signerId
    && receipt.receipt?.Action?.signer_id === expected.signerId && matchesCall(receipt.receipt.Action.actions)
    && outcome?.executor_id === expected.contractId && Boolean(outcome.status?.Failure)
    && Object.keys(outcome.status).length === 1;
}

export function nearChain({ urls, fetchImpl = fetch } = {}) {
  const rpcOptions = { fetchImpl, urls };
  const request = (method, params) => rpc(method, params, rpcOptions);
  // Use the SDK's serialization and signing, but send through the same bounded
  // and redirect-free transport as every on-chain verification read.
  const provider = new JsonRpcProvider();
  provider.sendJsonRpc = async (method, params) => {
    try { return await request(method, params); }
    catch (error) {
      if (error.invalidNonce) throw Object.assign(new InvalidNonceError(error.invalidNonce.ak_nonce, error.invalidNonce.tx_nonce),
        { rpcAmbiguous: error.rpcAmbiguous });
      if (error.transactionExpired) throw Object.assign(new TransactionExpiredError(), { rpcAmbiguous: error.rpcAmbiguous });
      throw error;
    }
  };
  const signer = (id, secret) => new Account(id, provider, new KeyPairSigner(KeyPair.fromString(secret)));
  const sent = (result, expected) => {
    const status = result?.status || {};
    const hash = result?.transaction?.hash || null;
    if (hash && (hash !== expected.hash || result.transaction.signer_id !== expected.signerId
      || result.transaction.receiver_id !== expected.receiverId)) throw new Error('NEAR returned a different signed transaction');
    const final = Boolean(hash) && hash === expected.hash && result?.final_execution_status === 'FINAL' && Object.keys(status).length === 1;
    const ok = final && typeof status.SuccessValue === 'string';
    // The call's return value (a DAO's add_proposal returns the new proposal id), parsed as JSON when it is JSON.
    let value = null;
    if (ok && status.SuccessValue) {
      const text = Buffer.from(status.SuccessValue, 'base64').toString('utf8');
      try { value = JSON.parse(text); } catch { value = text; }
    }
    return { hash, ok, value, failure: ok ? null : final && Object.hasOwn(status, 'Failure')
      ? JSON.stringify(status.Failure).slice(0, 400) : 'Final success not established' };
  };
  const broadcast = async (transaction) => sent(await provider.sendTransactionUntil(transaction, 'FINAL'),
    { hash: txHash(transaction), signerId: transaction.transaction.signerId, receiverId: transaction.transaction.receiverId });
  provider.sendTransactionUntil = async (transaction, waitUntil) => {
    const expected = { hash: txHash(transaction), signerId: transaction.transaction.signerId, receiverId: transaction.transaction.receiverId };
    const pending = { final_execution_status: 'NONE', status: 'NotStarted',
      transaction: { hash: expected.hash, signer_id: expected.signerId, receiver_id: expected.receiverId } };
    let result;
    try {
      result = await provider.sendJsonRpc('send_tx', {
        signed_tx_base64: Buffer.from(transaction.encode()).toString('base64'), wait_until: waitUntil,
      });
    } catch (rejection) {
      // A nonce rejection after a lost response may refer to this very send.
      // Reconcile its exact signed hash before the SDK may allocate another nonce.
      try {
        result = await request('tx', { tx_hash: expected.hash, sender_account_id: expected.signerId, wait_until: 'NONE' });
      } catch (lookup) {
        if (!rejection.rpcAmbiguous && lookup.rpcCause === 'UNKNOWN_TRANSACTION'
          && (rejection instanceof InvalidNonceError || rejection instanceof TransactionExpiredError)) throw rejection;
        return pending;
      }
    }
    sent(result, expected);
    return result?.transaction?.hash ? result : pending;
  };
  const send = async (id, secret, receiverId, list) => {
    const result = await signer(id, secret).signAndSendTransaction({
      receiverId, actions: list, waitUntil: 'FINAL', throwOnFailure: false, retries: 2,
    });
    return sent(result, { hash: result?.transaction?.hash || null, signerId: id, receiverId });
  };
  const receipts = async (hash, signerId) => {
    const params = { tx_hash: hash, sender_account_id: signerId, wait_until: 'NONE' };
    try { return await request('tx_status', params); }
    catch (error) {
      if (error.rpcCause !== 'METHOD_NOT_FOUND' && error.rpcCode !== -32601) throw error;
      return request('EXPERIMENTAL_tx_status', params);
    }
  };
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
        const state = await request('query', { request_type: 'view_account', finality: 'final', account_id: accountId });
        if (typeof state?.error === 'string' && /^account [^ ]+ does not exist while viewing/i.test(state.error)) return null;
        if (typeof state?.amount !== 'string' || !/^(0|[1-9][0-9]{0,38})$/.test(state.amount)) throw new Error('Invalid NEAR account balance');
        return state.amount;
      } catch (error) {
        if (error.rpcCause === 'UNKNOWN_ACCOUNT') return null;
        throw error;
      }
    },
    callFunds: (accountId, gas = GAS) => functionCallFunds(accountId, gas, rpcOptions),
    async readAccessKeys(accountId) {
      const state = await request('query', { request_type: 'view_access_key_list', finality: 'final', account_id: accountId });
      const valid = (key) => {
        try { PublicKey.fromString(key.public_key); } catch { return false; }
        const access = key.access_key;
        if (!Number.isSafeInteger(access?.nonce) || access.nonce < 0) return false;
        if (access.permission === 'FullAccess') return true;
        const call = access.permission?.FunctionCall;
        return Boolean(call && (call.allowance === null || typeof call.allowance === 'string' && /^\d+$/.test(call.allowance))
          && typeof call.receiver_id === 'string' && call.receiver_id.length > 0
          && Array.isArray(call.method_names) && call.method_names.every((method) => typeof method === 'string'));
      };
      if (state?.error || !Array.isArray(state?.keys) || !state.keys.every((key) => key && valid(key))) {
        throw new Error('Invalid NEAR access key list');
      }
      return state.keys;
    },
    async hasKey(accountId, publicKey, { fullAccess = false } = {}) {
      try {
        const key = await request('query', { request_type: 'view_access_key', finality: 'final', account_id: accountId, public_key: publicKey });
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
      if (!validHash(payment.transactionHash)) return null;
      // 1Click supplies a hash without its signer. Public all-shard nodes can
      // retrieve it by hash using the recipient as the routing hint. The
      // returned signer and complete receipt graph supply the proof.
      const result = await receipts(payment.transactionHash, payment.accountId);
      return deliveryFromReceipts(result, payment);
    },
    createAccount: ({ parentId, parentSecret, accountId, publicKey, amountYocto }) => send(parentId, parentSecret, accountId,
      [actions.createAccount(), actions.transfer(BigInt(amountYocto)), actions.addFullAccessKey(PublicKey.fromString(publicKey))]),
    transfer: ({ fromId, secret, toId, amountYocto }) => send(fromId, secret, toId, [actions.transfer(BigInt(amountYocto))]),
    call: ({ signerId, secret, contractId, method, args, depositYocto = '0', gas = GAS }) => send(signerId, secret, contractId,
      [actions.functionCall(method, args, gas, BigInt(depositYocto))]),
    async prepareCall({ signerId, secret, contractId, method, args, depositYocto = '0', gas = GAS }) {
      const transaction = await signer(signerId, secret).createSignedTransaction({ receiverId: contractId,
        actions: [actions.functionCall(method, args, gas, BigInt(depositYocto))] });
      return { hash: txHash(transaction),
        signedTransaction: Buffer.from(transaction.encode()).toString('base64') };
    },
    async broadcastCall({ signedTransaction }) {
      const transaction = SignedTransaction.decode(Buffer.from(signedTransaction, 'base64'));
      return broadcast(transaction);
    },
    async preparedFinalized({ signedTransaction, hash }) {
      const signed = SignedTransaction.decode(Buffer.from(signedTransaction, 'base64'));
      if (txHash(signed) !== hash) return false;
      try {
        const result = await receipts(hash, signed.transaction.signerId);
        const matchingActions = Array.isArray(result?.transaction?.actions)
          && result.transaction.actions.length === signed.transaction.actions.length
          && signed.transaction.actions.every((action, index) => {
            const observed = result.transaction.actions[index];
            if (!observed || Object.keys(observed).length !== 1) return false;
            if (action.functionCall) {
              const call = action.functionCall;
              return observed.FunctionCall?.method_name === call.methodName
                && observed.FunctionCall.args === Buffer.from(call.args).toString('base64')
                && observed.FunctionCall.deposit === call.deposit.toString()
                && String(observed.FunctionCall.gas) === call.gas.toString();
            }
            if (action.addKey) return observed.AddKey?.public_key === PublicKey.from(action.addKey.publicKey).toString()
              && observed.AddKey.access_key?.permission === 'FullAccess';
            if (action.deleteKey) return observed.DeleteKey?.public_key === PublicKey.from(action.deleteKey.publicKey).toString();
            return false;
          });
        return result?.final_execution_status === 'FINAL' && result.transaction?.hash === hash
          && matchingActions
          && result.transaction.signer_id === signed.transaction.signerId
          && result.transaction.receiver_id === signed.transaction.receiverId
          && Object.keys(result.status || {}).length === 1
          && (typeof result.status.SuccessValue === 'string' || Boolean(result.status.Failure));
      } catch { return false; }
    },
    async prepareRotation({ accountId, secret, addPublicKey, removePublicKey }) {
      const transaction = await signer(accountId, secret).createSignedTransaction({ receiverId: accountId,
        actions: [actions.addFullAccessKey(PublicKey.fromString(addPublicKey)), actions.deleteKey(PublicKey.fromString(removePublicKey))] });
      return { hash: txHash(transaction), signedTransaction: Buffer.from(transaction.encode()).toString('base64') };
    },
    async unwrapDelivery({ transactionHash, accountId, amountYocto }) {
      const wrapContractId = network().wrap;
      let result;
      try { result = await receipts(transactionHash, accountId); }
      catch (error) {
        if (error.rpcCause === 'UNKNOWN_TRANSACTION') return false;
        throw error;
      }
      const transaction = result?.transaction;
      const call = transaction?.actions?.[0]?.FunctionCall;
      if (transaction?.hash !== transactionHash || transaction.signer_id !== accountId
        || transaction.receiver_id !== wrapContractId || transaction.actions?.length !== 1
        || call?.method_name !== 'near_withdraw' || call.deposit !== '1'
        || call.args !== Buffer.from(JSON.stringify({ amount: amountYocto })).toString('base64')) return false;
      // The contract's promise transfers the amount plus its one-yocto call
      // deposit. Require that transfer itself to have finalized successfully.
      return Boolean(deliveryFromReceipts(result, { transactionHash, accountId, amountYocto, wrapContractId, unwrap: true }));
    },
    async preparedRetrySafe({ signedTransaction, transactionHash }, rejection) {
      const signed = SignedTransaction.decode(Buffer.from(signedTransaction, 'base64'));
      if (txHash(signed) !== transactionHash) return false;
      const transaction = signed.transaction;
      const expected = transaction.actions[0]?.functionCall;
      if (transaction.actions.length !== 1 || !expected) return false;
      try {
        const result = await receipts(transactionHash, transaction.signerId);
        // A failure of the exact root action rolls back its changes and deposit.
        // A failed downstream transfer or callback does not establish rollback.
        return rootCallRolledBack(result, { hash: transactionHash, signerId: transaction.signerId,
          contractId: transaction.receiverId, method: expected.methodName,
          argsBase64: Buffer.from(expected.args).toString('base64'), depositYocto: expected.deposit.toString(), gas: expected.gas.toString() });
      } catch (error) {
        if (error.rpcCause !== 'UNKNOWN_TRANSACTION') throw error;
      }
      if (!(rejection instanceof InvalidNonceError || rejection instanceof TransactionExpiredError)) return false;
      const head = await request('block', { finality: 'final' });
      if (!Number.isSafeInteger(head?.header?.height) || head.header.height < 0 || !validHash(head.header.hash)) return false;
      const key = await request('query', { request_type: 'view_access_key', block_id: head.header.hash,
        account_id: transaction.signerId, public_key: transaction.publicKey.toString() });
      // A consumed nonce could be this transaction's lost successful response.
      // A lower finalized nonce proves it never executed in finalized history.
      if (key?.error || key.permission !== 'FullAccess' || !Number.isSafeInteger(key.nonce)
        || key.nonce < 0 || BigInt(key.nonce) >= transaction.nonce) return false;
      const referenceHash = baseEncode(Buffer.from(transaction.blockHash));
      const [reference, protocol] = await Promise.all([
        request('block', { block_id: referenceHash }),
        request('EXPERIMENTAL_protocol_config', { block_id: head.header.hash }),
      ]);
      return reference?.header?.hash === referenceHash && Number.isSafeInteger(reference.header.height) && reference.header.height >= 0
        && Number.isSafeInteger(protocol?.transaction_validity_period) && protocol.transaction_validity_period > 0
        && BigInt(head.header.height) > BigInt(reference.header.height) + BigInt(protocol.transaction_validity_period);
    },
    async requestRetrySafe(row) {
      // Legacy request rows lack signed bytes. Their exact root receipt can
      // still prove rollback; absence, nonce state and callbacks cannot.
      if (!validHash(row.transaction_hash) || !row.metadata?.contract || !row.wallet_account) return false;
      try {
        const result = await receipts(row.transaction_hash, row.wallet_account);
        const encoded = result?.transaction?.actions?.[0]?.FunctionCall?.args;
        if (typeof encoded !== 'string' || encoded.length > 65536) return false;
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.toString('base64') !== encoded || canonicalJson(JSON.parse(bytes.toString('utf8'))) !== canonicalJson(row.args)) return false;
        return rootCallRolledBack(result, { hash: row.transaction_hash, signerId: row.wallet_account,
          contractId: row.metadata.contract, method: row.method, argsBase64: encoded,
          depositYocto: row.metadata.depositYocto, gas: row.metadata.gas || GAS.toString() });
      } catch { return false; }
    },
    async unwrapRetrySafe(payment, rejection) {
      const transaction = SignedTransaction.decode(Buffer.from(payment.signedTransaction, 'base64')).transaction;
      if (transaction.receiverId !== network().wrap || transaction.actions.length !== 1
        || transaction.actions[0]?.functionCall?.methodName !== 'near_withdraw') return false;
      return this.preparedRetrySafe(payment, rejection);
    },
    // A read of another contract's state (a token balance, a storage registration). Costs nothing.
    async view({ contractId, method, args = {} }) {
      const result = await request('query', { request_type: 'call_function', finality: 'final', account_id: contractId,
        method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
      if (typeof result.error === 'string') throw new Error(`NEAR view error: ${result.error.slice(0, 300)}`);
      if (!Array.isArray(result.result) || result.result.some((byte) => !Number.isInteger(byte) || byte < 0 || byte > 255)) {
        throw new Error('Invalid NEAR view result');
      }
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

/**
 * Keeps the referee able to reserve the gas for its largest call. With Stated Court that is a
 * 300-Tgas filing or approval: sized for an ordinary call, the referee once sat 0.001 NEAR short
 * of it and every filing failed until it was topped up by hand (12 November 2026).
 */
export async function topUpReferee(db, config, chain) {
  const judge = await referee(db, config, chain);
  const court = Boolean(config.court?.dao);
  const { balance, reserve } = await chain.callFunds(judge.id, court ? COURT_CALL_GAS : GAS);
  if (balance >= reserve) return false;
  const bank = await treasury(db, config, chain);
  const top = BigInt(yocto('0.2'));
  const amount = court ? reserve - balance + top : top;
  return (await chain.transfer({ fromId: bank.id, secret: bank.secret, toId: judge.id, amountYocto: String(amount) })).ok;
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
  } else if (!(await chain.hasKey(id, key.publicKey, { fullAccess: true }))) {
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
  // The key and immutable funding assignment are committed before any money moves.
  // A retry after account creation uses that assignment, even after config changes.
  const balance = await chain.balance(row.account_id);
  const amount = config.near?.real ? await initialMainnetGrant(db, config, row, balance) : yocto(config.play.startNear || '1.6');
  if (balance == null) {
    // Money is about to leave the treasury: top it up first if it is running low.
    await refillTreasury(db, config, chain);
    const made = await chain.createAccount({ parentId: bank.id, parentSecret: bank.secret, accountId: row.account_id,
      publicKey: row.public_key, amountYocto: amount });
    if (!made.ok) throw new Error(`The play account could not be created: ${made.failure || 'no transaction'}`);
  } else if (!(await chain.hasKey(row.account_id, row.public_key, { fullAccess: true }))) {
    throw new Error(`That account name exists on ${network().id} with a key this server does not hold.`);
  }
  return db.one(`update play_accounts set ready = true, granted_yocto = case when granted_yocto = '0' then $2 else granted_yocto end
    where x_user_id = $1 returning *`, [String(xUserId), amount]);
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

// Call while holding the managed account row lock. A signed unwrap owns its
// account nonce until its delivery or inability to execute has been established.
export async function assertSignerAvailable(tx, accountId, allowedDeposit = null, { chain, intentKey = null, requestId = null, outlayerId = null } = {}) {
  const pending = await tx.one(`select id from play_deposits where account_id = $1
    and unwrap_signed_transaction is not null and finished_at is null
    and ($2::uuid is null or id <> $2::uuid) limit 1`, [accountId, allowedDeposit]);
  if (pending) throw new UserError('A payment is still being unwrapped. Wait for its confirmation before using this account.', 409);
  const account = await tx.one('select signer_intent from play_accounts where account_id=$1', [accountId]);
  const intent = account?.signer_intent;
  if (intent && intent.key !== intentKey) {
    let resolved = Boolean(chain?.preparedFinalized && await chain.preparedFinalized(intent));
    if (!resolved && chain?.preparedRetrySafe) {
      try {
        resolved = await chain.preparedRetrySafe({ transactionHash: intent.hash, signedTransaction: intent.signedTransaction }, new TransactionExpiredError());
        if (resolved) {
          await tx.query(`update bilateral_near_requests set execution_status='failed', execution_message='Signed transaction can no longer be included'
            where wallet_account=$1 and transaction_hash=$2 and execution_status='pending'`, [accountId, intent.hash]);
          await tx.query(`update outlayer_near_requests set execution_status='failed', detail='Signed transaction can no longer be included'
            where signer_account=$1 and transaction_hash=$2 and execution_status='pending'`, [accountId, intent.hash]);
        }
      } catch { /* ambiguous history keeps the nonce fenced */ }
    }
    if (!resolved) {
      throw new UserError('An account transaction is still pending. Wait for its confirmation before using this account.', 409);
    }
    // Nonce finality and business execution are separate. Keep verification of
    // the request's success/failure intact while allowing the next nonce.
    await tx.query(`update bilateral_near_requests set signer_released_at=coalesce(signer_released_at,clock_timestamp())
      where wallet_account=$1 and transaction_hash=$2`, [accountId, intent.hash]);
    await tx.query(`update outlayer_near_requests set signer_released_at=coalesce(signer_released_at,clock_timestamp())
      where signer_account=$1 and transaction_hash=$2`, [accountId, intent.hash]);
  }
  // Preserve pre-migration unresolved sends as well as the current reservation.
  // A terminal execution status is usable only after exact transaction verification.
  const prior = await tx.one(`select id from bilateral_near_requests where wallet_account=$1
    and transaction_hash is not null and execution_status='pending' and signer_released_at is null
    and ($2::uuid is null or id <> $2::uuid)
    and ($3::text is null or transaction_hash <> $3) limit 1`, [accountId, requestId, intent?.hash || null]);
  const outlayer = await tx.one(`select id from outlayer_near_requests where signer_account=$1
    and signed_transaction is not null and execution_status='pending' and signer_released_at is null
    and ($2::uuid is null or id <> $2::uuid)
    and ($3::text is null or transaction_hash <> $3) limit 1`, [accountId, outlayerId, intent?.hash || null]);
  if (prior || outlayer) throw new UserError('An account transaction is still pending. Wait for its confirmation before using this account.', 409);
}

// Commit the account-wide reservation before any bytes leave this process.
// The exact operation may resume its bytes; every other operation must establish
// finality first. Request rows retain their history after the account moves on.
export async function reservePlaySigner(db, chain, accountId, key, prepare, { requestId = null, outlayerId = null } = {}) {
  return db.tx(async tx => {
    await tx.query("set local lock_timeout = '5s'");
    const account = await tx.one('select * from play_accounts where account_id = $1 for update', [accountId]);
    if (!account) return prepare(tx, null);
    if (account.claimed_at) throw new UserError('You hold this account’s key now. Use your own wallet.', 409);
    await assertSignerAvailable(tx, accountId, null, { chain, intentKey: key, requestId, outlayerId });
    let replacing = false;
    if (account.signer_intent?.key === key && chain.preparedRetrySafe) {
      try {
        replacing = await chain.preparedRetrySafe({ transactionHash: account.signer_intent.hash,
          signedTransaction: account.signer_intent.signedTransaction }, new TransactionExpiredError());
      } catch { /* reuse the committed bytes when retirement is unproved */ }
    }
    if (requestId && account.signer_intent?.key !== key) {
      const prior = await tx.one('select * from bilateral_near_requests where id=$1 for update', [requestId]);
      if (prior?.transaction_hash && prior.execution_status === 'failed') {
        try {
          replacing = prior.signed_transaction && chain.preparedRetrySafe
            ? await chain.preparedRetrySafe({ transactionHash: prior.transaction_hash, signedTransaction: prior.signed_transaction }, new TransactionExpiredError())
            : Boolean(chain.requestRetrySafe && await chain.requestRetrySafe(prior));
        } catch { /* legacy or unavailable proof never authorizes replacement */ }
      }
    }
    const prepared = account.signer_intent?.key === key && !replacing ? account.signer_intent : await prepare(tx, account, replacing);
    if (!prepared?.hash || !prepared.signedTransaction) throw new Error('The account signing reservation is incomplete.');
    await tx.query('update play_accounts set signer_intent=$2 where account_id=$1', [accountId, { ...prepared, key }]);
    if (requestId) await tx.query(`update bilateral_near_requests set transaction_hash=$2, signed_transaction=$3,
      execution_status=case when $4 then 'pending' else execution_status end,
      signer_released_at=case when $4 then null else signer_released_at end
      where id=$1 and (transaction_hash is null or transaction_hash=$2 or $4)`, [requestId, prepared.hash, prepared.signedTransaction, replacing]);
    return prepared;
  });
}

export async function withAvailablePlaySigner(db, accountId, work, options = {}) {
  return db.tx(async tx => {
    const account = await tx.one('select * from play_accounts where account_id = $1 for update', [accountId]);
    if (account) {
      if (account.claimed_at) throw new UserError('You hold this account’s key now. Use your own wallet.', 409);
      await assertSignerAvailable(tx, accountId, null, options);
    }
    return work();
  });
}

/** How much more the account needs before it can cover a deposit and its fees. "0" when it has enough. */
export async function shortfall(config, chain, account, neededYocto) {
  const { balance, reserve } = await chain.callFunds(account.account_id);
  const deposit = BigInt(neededYocto);
  // A positive mainnet deposit preserves only the grant's fee portion. A
  // cancellation or withdrawal can use that reserve to pay network fees.
  const recorded = BigInt(account.granted_yocto ?? '0');
  const retained = config.near?.real && recorded > BigInt(MAINNET_FEE_GRANT_YOCTO) ? BigInt(MAINNET_FEE_GRANT_YOCTO) : recorded;
  const grant = config.play.fundsStakes === false && deposit > 0n
    ? retained : 0n;
  const want = deposit + (grant > reserve ? grant : reserve);
  return balance >= want ? '0' : (want - balance).toString();
}

/**
 * Makes sure the account can cover a deposit. On testnet it is topped up from the
 * treasury within the lifetime grant. With real NEAR the initial sponsored balance
 * can fund stakes, but the treasury never tops it up: the person adds any shortfall.
 */
export async function ensureFunds(db, config, chain, account, neededYocto) {
  const short = await shortfall(config, chain, account, neededYocto);
  if (short === '0') return;
  if (config.play.fundsStakes === false) {
    const more = new D(short).div(NEAR).toDecimalPlaces(2, Decimal.ROUND_UP).toFixed();
    throw Object.assign(new UserError(`This account needs ${more} more NEAR for that.`, 409), { funds: true, shortYocto: short, neededYocto });
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
  if (['fund', 'accept'].includes(input.action)) {
    const reference = typeof betId === 'string' ? betId.toLowerCase() : betId;
    return withManagedOperation(db, `managed-${input.action}:${config.nearContract}:${reference}:${user.id}`,
      'Your stake is still being matched. Retry verification shortly.',
      (locked) => performPlayAction(locked, config, chain, user, reference, input, { fetchImpl }));
  }
  return performPlayAction(db, config, chain, user, betId, input, { fetchImpl });
}

// Session-scoped because each reservation and verification must commit normally.
// All work uses this one connection; waiting contenders hold no pool connection.
export async function withManagedOperation(db, key, busyMessage, fn) {
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
  const resume = async request => {
    const signed = await reservePlaySigner(db, chain, account.account_id, `request:${request.id}`,
      async (tx, current, replacing) => {
        if (!replacing) return { hash: request.transaction_hash, signedTransaction: request.signed_transaction };
        if (!current?.ready) throw new UserError('This account is no longer available.', 409);
        await ensureFunds(tx, config, chain, current, request.metadata.depositYocto);
        return chain.prepareCall({ signerId: current.account_id, secret: secretOf(config, current),
          contractId: request.metadata.contract, method: request.method, args: request.args,
          depositYocto: request.metadata.depositYocto, gas: BigInt(request.metadata.gas || GAS) });
      }, { requestId: request.id });
    try { await chain.broadcastCall(signed); }
    catch (error) {
      if (!(error instanceof InvalidNonceError || error instanceof TransactionExpiredError)) throw error;
      // The reservation already checked retirement. Ambiguous rejection keeps
      // its exact bytes; verification below reports their unresolved state.
    }
    return signed.hash;
  };
  if (input.action === 'fund') {
    const bet = await syncNearBet(db, config, user, betId, { fetchImpl, chain });
    if (String(bet.creator_user_id) === String(user.id) && bet.chain_state?.creator === account.account_id) {
      return { bet, hash: null, status: 'succeeded' };
    }
    const request = await db.one(`select * from bilateral_near_requests where bet_id=$1 and user_id=$2
      and wallet_account=$3 and method='create_bet' and metadata->>'contract'=$4 order by created_at,id limit 1`,
    [betId, user.id, account.account_id, config.nearContract]);
    if (request?.transaction_hash && request.execution_status !== 'failed') {
      let transactionHash = request.transaction_hash;
      if (request.signed_transaction && request.execution_status === 'pending') {
        transactionHash = await resume(request);
      }
      const verified = await verifyBetTransaction(db, config, user, betId,
        { requestId: request.id, transactionHash }, { fetchImpl });
      if (verified.status === 'failed') throw new UserError(`NEAR rejected that: ${verified.explanation}`, 409);
      return { bet: await syncNearBet(db, config, user, betId, { fetchImpl, chain }), hash: transactionHash, status: verified.status };
    }
  }
  if (input.action === 'accept') {
    if (!inPilot(config, user.x_user_id)) throw new UserError('Bets with real NEAR are invite-only for now.', 403);
    const bet = await syncNearBet(db, config, user, betId, { fetchImpl, chain });
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
      let transactionHash = request.transaction_hash;
      if (request.signed_transaction && request.execution_status === 'pending') {
        transactionHash = await resume(request);
      }
      const verified = await verifyBetTransaction(db, config, user, betId,
        { requestId: request.id, transactionHash }, { fetchImpl });
      if (verified.status === 'failed') throw new UserError(`NEAR rejected that: ${verified.explanation}`, 409);
      return { bet: await syncNearBet(db, config, user, betId, { fetchImpl, chain }), hash: transactionHash, status: verified.status };
    }
  }
  const prepared = await prepareNearAction(db, config, user, betId, { ...input, accountId: account.account_id }, { fetchImpl, chain });
  const sign = async (tx, current, replacing = false) => {
    if (!current?.ready) throw new UserError('This account is no longer available.', 409);
    const secret = secretOf(config, current);
    if (config.near?.real) {
      const prior = await tx.one('select * from bilateral_near_requests where id=$1 for update', [prepared.requestId]);
      if (prior?.signed_transaction && !replacing) return { hash: prior.transaction_hash, signedTransaction: prior.signed_transaction };
      if (prior?.transaction_hash && !replacing) throw new UserError('An earlier account transaction needs confirmation before this request can be signed.', 409);
    }
    await ensureFunds(tx, config, chain, current, prepared.depositYocto);
    return (config.near?.real ? chain.prepareCall : chain.call)({ signerId: current.account_id, secret, contractId: prepared.payload.contract,
      method: prepared.method, args: prepared.args, depositYocto: prepared.depositYocto });
  };
  // On mainnet, serialize the balance check and signing with other spends, deposits and key handover.
  const sent = config.near?.real ? await chain.broadcastCall(await reservePlaySigner(db, chain, account.account_id, `request:${prepared.requestId}`,
    (tx, current, replacing) => sign(tx, current, replacing), { requestId: prepared.requestId })) : await sign(db, account);
  if (!sent.hash) throw new Error('The transaction was not accepted by the network.');
  const verified = await verifyBetTransaction(db, config, user, betId, { requestId: prepared.requestId, transactionHash: sent.hash }, { fetchImpl });
  if (verified.status === 'failed') throw new UserError(`NEAR rejected that: ${sent.failure || verified.explanation}`, 409);
  const bet = await syncNearBet(db, config, user, betId, { fetchImpl, chain });
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
  let reservedRotation = null;
  if (config.near?.real) {
    const account = await playAccountFor(db, xUserId);
    if (!account?.ready) throw new UserError('You have no play account yet. Bet once and one is made for you.', 404);
    secretOf(config, account);
    if (publicKey === account.public_key) throw new UserError('That is the key this server already holds. Use one of your own.');
    const already = !(await chain.hasKey(account.account_id, account.public_key))
      && await chain.hasKey(account.account_id, publicKey, { fullAccess: true });
    if (!already) {
      reservedRotation = await reservePlaySigner(db, chain, account.account_id, `rotate:${publicKey}`,
        (_tx, current) => chain.prepareRotation({ accountId: current.account_id, secret: secretOf(config, current),
          addPublicKey: publicKey, removePublicKey: current.public_key }));
      const sent = await chain.broadcastCall(reservedRotation);
      if (!sent.ok) throw new UserError(`NEAR did not change the keys: ${sent.failure || 'not accepted'}`, 409);
    }
  }
  return db.tx(async (tx) => {
    await tx.query("set local lock_timeout = '5s'");
    const account = await tx.one('select * from play_accounts where x_user_id = $1 for update', [String(xUserId)]);
    if (!account?.ready) throw new UserError('You have no play account yet. Bet once and one is made for you.', 404);
    const pending = await tx.one(`select 1 as found from play_deposits where x_user_id = $1
      and unwrap_signed_transaction is not null and finished_at is null limit 1`, [String(xUserId)]);
    if (pending) throw new UserError('A payment is still being unwrapped. Wait for its confirmation before taking the account.', 409);
    await assertSignerAvailable(tx, account.account_id, null, { chain });
    const secret = secretOf(config, account);
    if (publicKey === account.public_key) throw new UserError('That is the key this server already holds. Use one of your own.');
    // Recover a completed rotation whose connection was lost before the database commit.
    let transactionHash = reservedRotation?.hash || null;
    const already = !(await chain.hasKey(account.account_id, account.public_key))
      && await chain.hasKey(account.account_id, publicKey, { fullAccess: true });
    if (!already) {
      if (config.near?.real) throw new UserError('The account key change is still pending. Retry after its confirmation.', 409);
      const done = await chain.rotateKey({ accountId: account.account_id, secret, addPublicKey: publicKey, removePublicKey: account.public_key });
      if (!done.ok) throw new UserError(`NEAR did not change the keys: ${done.failure || 'not accepted'}`, 409);
      transactionHash = done.hash;
    }
    await tx.query('update play_accounts set secret_sealed = null, claimed_at = clock_timestamp() where x_user_id = $1', [String(xUserId)]);
    return { accountId: account.account_id, transactionHash };
  });
}
