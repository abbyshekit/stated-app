// INTEGRATION: Server-only NEAR adapter. Prepare an exact action payload and
// verify finalized contract state independently of browser wallet outcomes.
// The network (testnet or mainnet) comes from near-network.mjs.
// Requires decimal.js 10.x.
import Decimal from 'decimal.js';
import { isAccount, isNamedAccount, network, unit } from './near-network.mjs';

export const TESTNET_RPC = 'https://test.rpc.fastnear.com';
/** The first endpoint for this server's network. A test double answers for exactly this one. */
export const primaryRpc = () => network().rpc[0];

export function rpcUrls(env = process.env) {
  if (env.STATED_NEAR_RPC == null) return network().rpc;
  const listed = String(env.STATED_NEAR_RPC).split(',').map((part) => {
    const value = part.trim();
    const url = /^https:\/\/[^\s\\#]+$/i.test(value) ? URL.parse(value) : null;
    if (!url?.hostname || url.username || url.password || value.split('/')[2].includes('@')) {
      throw new Error('STATED_NEAR_RPC must contain only HTTPS endpoints without credentials or fragments.');
    }
    return url.href;
  });
  return [...new Set(listed)];
}
export const STORAGE_FEE_YOCTO = '10000000000000000000000';
export const NEAR_CALL_GAS = 100000000000000n;
// Stated Court filings and approvals through the relay attach this much gas, so the
// referee that sends them must be able to reserve it.
export const COURT_CALL_GAS = 300_000_000_000_000n;
const CALL_OVERHEAD_GAS = 5_000_000_000_000n;
const ONE_NEAR = '1000000000000000000000000';
const MAX_DEPOSIT = 1010000000000000000000000n;
const MAX_RESPONSE = 1024 * 1024;
const D = Decimal.clone({ precision: 100 });
const METHODS = new Set(['create_bet', 'accept_bet', 'cancel_bet', 'expire_bet', 'propose_outcome', 'confirm_outcome', 'dispute_outcome',
  'finalize_unanswered', 'refund_unresolved', 'withdraw', 'submit_evidence']);

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

export async function readRpcJson(response) {
  if (Number(response.headers.get('content-length')) > MAX_RESPONSE) {
    await response.body?.cancel().catch(() => {});
    throw new Error('NEAR RPC response too large');
  }
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
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
}

// An injected fetch uses one endpoint unless the caller supplies an exact list.
export async function rpc(method, params, { fetchImpl = fetch, urls = fetchImpl === fetch ? rpcUrls() : [primaryRpc()] } = {}) {
  let failure;
  let ambiguous = false;
  for (const url of urls) {
    let response;
    try {
      response = await fetchImpl(url, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 'stated', method, params }),
        signal: AbortSignal.timeout(15000), redirect: 'error'
      });
    } catch (error) {
      if (method === 'send_tx') ambiguous = true;
      error.rpcAmbiguous = ambiguous;
      failure = error;
      continue;
    }
    // Some providers use an HTTP client-error status for JSON-RPC errors,
    // including the method error needed by the legacy receipt fallback.
    const rpcErrorStatus = response.status === 400 || response.status === 422;
    if ((!response.ok && !rpcErrorStatus) || response.redirected) {
      await response.body?.cancel().catch(() => {});
      failure = new Error(`NEAR RPC HTTP ${response.status}`);
      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        if (method === 'send_tx') ambiguous = true;
        failure.rpcAmbiguous = ambiguous;
        continue;
      }
      failure.rpcAmbiguous = ambiguous;
      throw failure;
    }
    const payload = await readRpcJson(response);
    if (payload?.jsonrpc !== '2.0' || payload.id !== 'stated'
      || Object.hasOwn(payload, 'result') === Object.hasOwn(payload, 'error')) throw new Error('Invalid NEAR RPC response');
    if (Object.hasOwn(payload, 'result')) {
      if (!response.ok) throw new Error(`NEAR RPC HTTP ${response.status}`);
      return payload.result;
    }
    if (!Number.isInteger(payload.error?.code) || typeof payload.error.message !== 'string') throw new Error('Invalid NEAR RPC response');
    const error = new Error(`NEAR RPC error: ${payload.error.message.slice(0, 300)}`);
    error.rpcCause = payload.error.cause?.name || null;
    error.rpcCode = payload.error.code;
    error.rpcAmbiguous = ambiguous;
    const invalid = error.rpcCause === 'INVALID_TRANSACTION' ? payload.error.data?.TxExecutionError?.InvalidTxError : null;
    error.invalidNonce = invalid?.InvalidNonce || null;
    error.transactionExpired = invalid === 'Expired';
    if (['DOES_NOT_TRACK_SHARD', 'INTERNAL_ERROR'].includes(error.rpcCause || payload.error.name)) {
      if (method === 'send_tx') ambiguous = true;
      error.rpcAmbiguous = ambiguous;
      failure = error;
      continue;
    }
    throw error;
  }
  throw failure || new Error('NEAR RPC unavailable');
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
