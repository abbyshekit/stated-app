// INTEGRATION: Server-only NEAR adapter. Prepare an exact action payload and
// verify finalized contract state independently of browser wallet outcomes.
// The network (testnet or mainnet) comes from near-network.mjs.
// Requires decimal.js 10.x.
import Decimal from 'decimal.js';
import { isAccount, isNamedAccount, network, unit } from './near-network.mjs';

export const TESTNET_RPC = 'https://test.rpc.fastnear.com';
/** The first endpoint for this server's network. A test double answers for exactly this one. */
export const primaryRpc = () => network().rpc[0];
// The network's own list, tried in order when one is busy or down. STATED_NEAR_RPC replaces the list.
export function rpcUrls(env = process.env) {
  const listed = String(env.STATED_NEAR_RPC || '').split(',').map((url) => url.trim()).filter((url) => /^https:\/\/[^\s]+$/.test(url));
  return listed.length ? listed : network().rpc;
}
export const STORAGE_FEE_YOCTO = '10000000000000000000000';
export const NEAR_CALL_GAS = 100000000000000n;
const CALL_OVERHEAD_GAS = 5_000_000_000_000n;
const ONE_NEAR = '1000000000000000000000000';
const MAX_DEPOSIT = 1010000000000000000000000n;
const MAX_RESPONSE = 1024 * 1024;
const D = Decimal.clone({ precision: 100 });
const METHODS = new Set(['create_bet', 'accept_bet', 'cancel_bet', 'expire_bet', 'propose_outcome', 'confirm_outcome', 'dispute_outcome',
  'finalize_unanswered', 'refund_unresolved', 'withdraw']);

function account(value, contract = false) {
  if (!(contract ? isNamedAccount(value) : isAccount(value))) throw new Error(`Invalid ${network().id} account`);
  return value;
}

function unsigned(value) {
  if (typeof value !== 'string' || !/^(0|[1-9][0-9]*)$/.test(value) || value.length > 39) throw new Error('Invalid yoctoNEAR amount');
  return value;
}

export function parseTestNear(value) {
  if (typeof value !== 'string' || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,24})?$/.test(value) || value.length > 26) throw new Error(`Invalid ${unit()} amount`);
  const amount = new D(value);
  if (amount.lte(0) || amount.gt(1)) throw new Error('A stake must be greater than zero and at most one');
  return amount.mul(ONE_NEAR).toFixed(0);
}

export function formatTestNear(value) {
  return new D(unsigned(value)).div(ONE_NEAR).toFixed();
}

// A caller that supplies its own fetch (a test double) gets exactly one endpoint, so no test reaches the network.
export async function rpc(method, params, { fetchImpl = fetch, urls = fetchImpl === fetch ? rpcUrls() : [primaryRpc()] } = {}) {
  let response = null;
  let failure = null;
  for (const url of urls) {
    try {
      response = await fetchImpl(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'stated', method, params }),
        signal: AbortSignal.timeout(15000), redirect: 'error'
      });
      // Busy or broken: the next endpoint may answer. Anything else is this endpoint's answer.
      if (response.status !== 429 && response.status < 500) break;
      failure = new Error(`NEAR RPC HTTP ${response.status}`);
      response = null;
    } catch (error) {
      failure = error;
    }
  }
  if (!response) throw failure || new Error('NEAR RPC unavailable');
  if (!response.ok) throw new Error(`NEAR RPC HTTP ${response.status}`);
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE) throw new Error('NEAR RPC response too large');
  if (!response.body) throw new Error('Empty NEAR RPC response');
  const reader = response.body.getReader();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > MAX_RESPONSE) throw new Error('NEAR RPC response too large');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  }
  const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (result.error) {
    // The message is generic ("Server error"); the cause names what happened.
    const error = new Error(`NEAR RPC error: ${result.error.message || 'request failed'}`);
    error.rpcCause = result.error.cause?.name || null;
    throw error;
  }
  if (!Object.hasOwn(result, 'result')) throw new Error('Invalid NEAR RPC response');
  return result.result;
}

async function gasPricing(options) {
  const [block, protocol] = await Promise.all([
    rpc('gas_price', [null], options),
    rpc('EXPERIMENTAL_protocol_config', { finality: 'final' }, options),
  ]);
  const current = BigInt(unsigned(block.gas_price));
  // The receipt price floor can exceed the gas price shown by the block.
  const floor = BigInt(unsigned(protocol.runtime_config?.min_gas_purchase_price
    ?? (protocol.protocol_version < 85 ? '0' : undefined)));
  return { price: current > floor ? current : floor, storage: protocol.runtime_config?.storage_amount_per_byte };
}

export async function gasPurchasePrice(options) {
  return (await gasPricing(options)).price;
}

/** Conservative liquidity requirement for one function call, before its deposit. */
export async function functionCallFunds(signer, gas, options) {
  const [state, { price, storage }] = await Promise.all([
    rpc('query', { request_type: 'view_account', finality: 'final', account_id: account(signer) }, options),
    gasPricing(options),
  ]);
  if (!Number.isSafeInteger(state.storage_usage) || state.storage_usage < 0) throw new Error('Invalid NEAR account storage usage');
  // The attached gas excludes the transaction and receipt fees. Allow headroom
  // for those and keep the balance required by the signer's existing storage.
  const reserve = (gas + CALL_OVERHEAD_GAS) * price + BigInt(state.storage_usage) * BigInt(unsigned(storage));
  return { balance: BigInt(unsigned(state.amount)), reserve };
}

async function viewSnapshot(contract, methodName, args, options) {
  account(contract, true);
  const result = await rpc('query', { request_type: 'call_function', finality: 'final', account_id: contract, method_name: methodName, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') }, options);
  // A view that panics or does not exist answers with an error string in place of bytes.
  if (typeof result.error === 'string') throw new Error(`NEAR view error: ${result.error.slice(0, 300)}`);
  if (!Array.isArray(result.result) || result.result.some(byte => !Number.isInteger(byte) || byte < 0 || byte > 255)) throw new Error('Invalid NEAR view result');
  if (!Number.isSafeInteger(result.block_height) || result.block_height < 0) throw new Error('Invalid NEAR block height');
  return { value: JSON.parse(Buffer.from(result.result).toString('utf8')), blockHeight: String(result.block_height), blockHash: result.block_hash || null };
}

export async function viewEscrow(contract, id, options = {}) {
  return (await viewEscrowSnapshot(contract, id, options)).value;
}

export function viewEscrowSnapshot(contract, id, options = {}) {
  if (typeof id !== 'string' || id.length === 0 || id.length > 256) throw new Error('Invalid bet id');
  return viewSnapshot(contract, 'get_bet', { id }, options);
}

// Version 1 has no version() view. Only a definite answer is remembered, so an
// RPC outage never pins a version 2 contract to version 1 behaviour.
const versions = new Map();
export async function contractVersion(contract, options = {}) {
  if (versions.has(contract)) return versions.get(contract);
  try {
    const value = (await viewSnapshot(contract, 'version', {}, options)).value;
    const version = value === '2' ? 2 : 1;
    versions.set(contract, version);
    return version;
  } catch (error) {
    if (/MethodNotFound|MethodResolveError|method .*not found/i.test(String(error.message))) versions.set(contract, 1);
    return 1;
  }
}

export async function viewCredit(contract, accountId, options = {}) {
  return (await viewSnapshot(contract, 'get_credit', { account_id: account(accountId) }, options)).value;
}

// The connected wallet owns its signing key, nonce and block hash. This payload
// describes only the exact server-reserved action; server verification still
// establishes whether the resulting transaction completed.
export function walletPayload({ contract, accountId, methodName, args, depositYocto, requestId }) {
  account(contract, true);
  account(accountId);
  if (!METHODS.has(methodName)) throw new Error('Invalid escrow method');
  if (BigInt(unsigned(depositYocto)) > MAX_DEPOSIT) throw new Error('Deposit exceeds the one-NEAR stake limit');
  if (!args || typeof args !== 'object' || Array.isArray(args)
    || Buffer.byteLength(JSON.stringify(args)) > 10240) throw new Error('Invalid transaction arguments');
  return { contract, accountId, method: methodName, args, depositYocto,
    gas: String(NEAR_CALL_GAS), requestId };
}
