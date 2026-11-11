// INTEGRATION: Persist stated_request_id=request.id in new withdrawal args before
// constructing the wallet payload. Call only for an actor-authorized stored request.
// API: returns {status, transactionHash, explanation}; status is pending,
// succeeded or failed. Invalid hashes, missing withdrawal tags and transaction
// mismatches throw UserError(409). RPC outages and incomplete evidence stay pending.
// A finalized withdraw result must decode to boolean true or false. Credit views
// and the preview's creditYocto never establish payment or the amount transferred.
import { baseDecode } from 'near-api-js';
import { canonicalJson } from './canonical.mjs';
import { rpc } from './near-escrow.mjs';
import { UserError } from './store.mjs';

const PENDING = 'The transaction is not yet verified as final. Retry verification.';
const MISMATCH = 'This transaction does not match the recorded wallet request. Check its transaction hash.';

function mismatch() {
  return new UserError(MISMATCH, 409);
}

function decodeJson(value, maxBytes) {
  // Buffer's base64 decoder accepts malformed input; require its canonical form.
  if (typeof value !== 'string' || value.length > Math.ceil(maxBytes / 3) * 4
    || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) throw mismatch();
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > maxBytes || bytes.toString('base64') !== value) throw mismatch();
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
}

function validateHash(transactionHash) {
  if (typeof transactionHash !== 'string' || transactionHash.length < 32
    || transactionHash.length > 44 || !/^[1-9A-HJ-NP-Za-km-z]+$/.test(transactionHash)) throw mismatch();
  try {
    if (baseDecode(transactionHash).length !== 32) throw mismatch();
  } catch { throw mismatch(); }
}

function validateTransaction(request, result, transactionHash) {
  const transaction = result.transaction;
  if (!transaction || transaction.hash !== transactionHash
    || transaction.signer_id !== request.wallet_account
    || transaction.receiver_id !== request.metadata.contract
    || !Array.isArray(transaction.actions) || transaction.actions.length !== 1) throw mismatch();
  const action = transaction.actions[0];
  const call = action?.FunctionCall;
  if (!action || Object.keys(action).length !== 1 || !call
    || call.method_name !== request.method || call.deposit !== request.metadata.depositYocto
    || !(call.gas === '100000000000000' || (Number.isSafeInteger(call.gas) && call.gas === 100000000000000))) throw mismatch();
  let args;
  try { args = decodeJson(call.args, 10240); }
  catch { throw mismatch(); }
  if (canonicalJson(args) !== canonicalJson(request.args)) throw mismatch();
}

export async function verifyNearExecution(request, transactionHash, { fetchImpl = fetch } = {}) {
  validateHash(transactionHash);
  if (!request || typeof request.wallet_account !== 'string' || !request.wallet_account
    || typeof request.method !== 'string' || !request.method
    || typeof request.metadata?.contract !== 'string' || !request.metadata.contract
    || typeof request.metadata.depositYocto !== 'string'
    || !/^(0|[1-9][0-9]{0,38})$/.test(request.metadata.depositYocto)
    || !request.args || typeof request.args !== 'object' || Array.isArray(request.args)) throw mismatch();
  if (request.method === 'withdraw' && (typeof request.id !== 'string' || !request.id
    || request.args.stated_request_id !== request.id)) {
    throw new UserError('This withdrawal lacks a unique recorded request tag. Its completion cannot be verified through Stated.', 409);
  }

  const answer = (status, explanation) => ({ status, transactionHash, explanation });
  let result;
  try {
    result = await rpc('tx', {
      tx_hash: transactionHash, sender_account_id: request.wallet_account, wait_until: 'FINAL',
    }, { fetchImpl });
  } catch { return answer('pending', PENDING); }
  if (!result || result.final_execution_status !== 'FINAL') return answer('pending', PENDING);
  validateTransaction(request, result, transactionHash);

  const status = result.status;
  if (!status || typeof status !== 'object' || Array.isArray(status)
    || Object.keys(status).length !== 1) return answer('pending', PENDING);
  if (Object.hasOwn(status, 'Failure')) {
    return answer('failed', 'NEAR finalized this transaction as failed. Verify available credit before preparing another request.');
  }
  if (!Object.hasOwn(status, 'SuccessValue') || typeof status.SuccessValue !== 'string') {
    return answer('pending', PENDING);
  }
  if (request.method !== 'withdraw') return answer('succeeded', 'NEAR verified that this transaction completed.');

  let paid;
  try { paid = decodeJson(status.SuccessValue, 64); }
  catch { return answer('pending', 'NEAR finalized the transaction, but its withdrawal result could not be verified. Retry verification.'); }
  if (paid === true) return answer('succeeded', 'NEAR verified that the withdrawal transfer completed.');
  if (paid === false) {
    return answer('failed', 'The withdrawal transfer failed. The contract restored its credit. Verify available credit before retrying.');
  }
  return answer('pending', 'NEAR finalized the transaction, but its withdrawal result could not be verified. Retry verification.');
}
