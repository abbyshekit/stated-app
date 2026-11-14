// Prove this transaction's delivery, independently of a provider's payment status.
import { isDeepStrictEqual } from 'node:util';

const oneStatus = (status, field, type) => status && typeof status === 'object' && !Array.isArray(status)
  && Object.keys(status).length === 1 && Object.hasOwn(status, field) && typeof status[field] === type;
const succeeded = (status) => oneStatus(status, 'SuccessValue', 'string') || oneStatus(status, 'SuccessReceiptId', 'string');
const uint = (value) => typeof value === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(value) && BigInt(value) < (1n << 128n);
const account = (value) => typeof value === 'string' && value.length >= 2 && value.length <= 64
  && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value);
// wrap.near still emits the older NEP-141 logs, including reverse transfers on refunds.
const LEGACY_TRANSFER = /^(?:Transfer|Refund) (\d{1,39}) from ([a-z0-9._-]{2,64}) to ([a-z0-9._-]{2,64})$/;

function indexed(records, field) {
  const index = new Map();
  for (const item of records) {
    const id = item?.[field];
    if (typeof id !== 'string' || !id || index.has(id)) return null;
    index.set(id, item);
  }
  return index;
}

function finalReceiptGraph(result, transactionHash) {
  const transaction = result?.transaction;
  const initial = result?.transaction_outcome;
  const root = initial?.outcome?.status?.SuccessReceiptId;
  if (transaction?.hash !== transactionHash || result.final_execution_status !== 'FINAL'
    || !oneStatus(result.status, 'SuccessValue', 'string') || !account(transaction.signer_id)
    || !account(transaction.receiver_id) || !Array.isArray(transaction.actions)
    || initial?.id !== transactionHash || initial.outcome.executor_id !== transaction.signer_id
    || !oneStatus(initial.outcome.status, 'SuccessReceiptId', 'string') || !root
    || !isDeepStrictEqual(initial.outcome.receipt_ids, [root])
    || !Array.isArray(result.receipts) || !Array.isArray(result.receipts_outcome)) return null;
  const receipts = indexed(result.receipts, 'receipt_id');
  const outcomes = indexed(result.receipts_outcome, 'id');
  if (!receipts || !outcomes || receipts.has(transactionHash) || outcomes.has(transactionHash)) return null;
  // The node elides the converted transaction receipt for calls to the signer's own account.
  if (!receipts.has(root) && transaction.signer_id === transaction.receiver_id) {
    receipts.set(root, { receiver_id: transaction.receiver_id, predecessor_id: transaction.signer_id,
      receipt: { Action: { signer_id: transaction.signer_id, actions: transaction.actions } } });
  }
  const first = receipts.get(root);
  if (first?.receiver_id !== transaction.receiver_id || first.predecessor_id !== transaction.signer_id
    || !isDeepStrictEqual(first.receipt?.Action?.actions, transaction.actions)) return null;

  const graph = new Map();
  const queue = [{ id: root, parent: transaction.signer_id }];
  for (const { id, parent } of queue) {
    if (graph.has(id)) return null;
    const receipt = receipts.get(id);
    const outcome = outcomes.get(id)?.outcome;
    const action = receipt?.receipt?.Action;
    if (!account(receipt?.receiver_id) || (receipt.predecessor_id !== parent && receipt.predecessor_id !== 'system')
      || receipt.receiver_id !== outcome?.executor_id || !Array.isArray(action?.actions)
      || (receipt.predecessor_id !== 'system' && action.signer_id !== transaction.signer_id)
      || !Array.isArray(outcome.logs) || !Array.isArray(outcome.receipt_ids)
      || (!succeeded(outcome.status) && !oneStatus(outcome.status, 'Failure', 'object'))) return null;
    const returned = outcome.status.SuccessReceiptId;
    if (returned != null && !outcome.receipt_ids.includes(returned)) return null;
    graph.set(id, { receipt, outcome });
    for (const child of outcome.receipt_ids) queue.push({ id: child, parent: receipt.receiver_id });
  }
  if (graph.size !== receipts.size || graph.size !== outcomes.size) return null;
  let returned = graph.get(root).outcome.status;
  while (returned.SuccessReceiptId) returned = graph.get(returned.SuccessReceiptId).outcome.status;
  return returned.SuccessValue === result.status.SuccessValue ? graph.values() : null;
}

export function deliveryFromReceipts(result, { transactionHash, accountId, amountYocto, wrapContractId, unwrap = false }) {
  if (!uint(amountYocto) || BigInt(amountYocto) === 0n) return null;
  const graph = finalReceiptGraph(result, transactionHash);
  if (!graph) return null;
  let native = 0n;
  let wrapped = 0n;
  for (const { receipt, outcome } of graph) {
    const { receiver_id: receiver, predecessor_id: sender } = receipt;
    if (!succeeded(outcome.status) || sender === 'system') continue;
    for (const action of receipt.receipt.Action.actions) {
      if (!action || (typeof action !== 'string' && Object.keys(action).length !== 1)) return null;
      if (receiver === accountId && sender !== accountId && Object.hasOwn(action, 'Transfer')) {
        if (!uint(action.Transfer?.deposit)) return null;
        native += BigInt(action.Transfer.deposit);
      }
      if (sender === accountId && receiver !== accountId && (action.Transfer || action.FunctionCall)) {
        const deposit = (action.Transfer || action.FunctionCall).deposit;
        if (!uint(deposit)) return null;
        native -= BigInt(deposit);
      }
      if (sender === accountId && receiver === wrapContractId && !unwrap
        && ['near_withdraw', 'storage_unregister'].includes(action.FunctionCall?.method_name)) return null;
    }
    if (receiver !== wrapContractId) continue;
    for (const log of outcome.logs) {
      if (typeof log !== 'string') return null;
      // A burn in an older resolver cannot be attributed from its log alone.
      if (log === 'The account of the sender was deleted') return null;
      const legacy = LEGACY_TRANSFER.exec(log);
      if (legacy) {
        if (!uint(legacy[1]) || !account(legacy[2]) || !account(legacy[3])) return null;
        if (legacy[3] === accountId) wrapped += BigInt(legacy[1]);
        if (legacy[2] === accountId) wrapped -= BigInt(legacy[1]);
        continue;
      }
      if (!log.startsWith('EVENT_JSON:')) continue;
      let event;
      try { event = JSON.parse(log.slice('EVENT_JSON:'.length)); }
      catch { return null; }
      if (event?.standard !== 'nep141' || event.version !== '1.0.0') continue;
      if (!['ft_transfer', 'ft_burn'].includes(event.event)) continue;
      if (!Array.isArray(event.data)) return null;
      for (const item of event.data) {
        if (!item || !uint(item.amount)) return null;
        const amount = BigInt(item.amount);
        if (event.event === 'ft_burn') {
          if (!account(item.owner_id)) return null;
          if (item.owner_id === accountId) wrapped -= amount;
          continue;
        }
        if (!account(item.old_owner_id) || !account(item.new_owner_id)) return null;
        if (item.new_owner_id === accountId) wrapped += amount;
        if (item.old_owner_id === accountId) wrapped -= amount;
      }
    }
  }
  const wanted = BigInt(amountYocto);
  if (wrapped === wanted && native === 0n) return { final: true, kind: 'wrapped', deliveredYocto: wanted.toString() };
  if (native === wanted && wrapped === 0n) return { final: true, kind: 'native', deliveredYocto: wanted.toString() };
  return null;
}
