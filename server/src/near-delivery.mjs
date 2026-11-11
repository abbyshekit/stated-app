// Prove this transaction's delivery, independently of a provider's payment status.
const succeeded = (status) => typeof status?.SuccessValue === 'string'
  || typeof status?.SuccessReceiptId === 'string';
const uint = (value) => typeof value === 'string' && /^\d{1,39}$/.test(value);
// wrap.near still emits the older NEP-141 logs, including reverse transfers on refunds.
const LEGACY_TRANSFER = /^(?:Transfer|Refund) (\d{1,39}) from ([a-z0-9._-]{2,64}) to ([a-z0-9._-]{2,64})$/;

export function deliveryFromReceipts(result, { transactionHash, accountId, amountYocto, wrapContractId }) {
  if (result?.transaction?.hash !== transactionHash || result.final_execution_status !== 'FINAL'
    || typeof result.status?.SuccessValue !== 'string' || !uint(amountYocto) || BigInt(amountYocto) === 0n
    || !Array.isArray(result.receipts) || !Array.isArray(result.receipts_outcome)) return null;

  const outcomes = new Map(result.receipts_outcome.map(({ id, outcome }) => [id, outcome]));
  let native = 0n;
  let wrapped = 0n;
  const seen = new Set();
  for (const receipt of result.receipts) {
    const { receipt_id: id, receiver_id: receiver, predecessor_id: sender } = receipt;
    if (seen.has(id)) return null;
    seen.add(id);
    const outcome = outcomes.get(id);
    if (outcome?.executor_id !== receiver || !succeeded(outcome.status) || sender === 'system') continue;
    if (receiver === accountId && sender !== accountId) {
      for (const action of receipt.receipt?.Action?.actions || []) {
        if (!action.Transfer) continue;
        if (!uint(action.Transfer.deposit)) return null;
        native += BigInt(action.Transfer.deposit);
      }
    }
    if (receiver !== wrapContractId) continue;
    for (const log of outcome.logs || []) {
      if (typeof log !== 'string') continue;
      // A burn in an older resolver cannot be attributed from its log alone.
      if (log === 'The account of the sender was deleted') return null;
      const legacy = LEGACY_TRANSFER.exec(log);
      if (legacy) {
        if (legacy[3] === accountId) wrapped += BigInt(legacy[1]);
        if (legacy[2] === accountId) wrapped -= BigInt(legacy[1]);
        continue;
      }
      if (!log.startsWith('EVENT_JSON:')) continue;
      let event;
      try { event = JSON.parse(log.slice('EVENT_JSON:'.length)); }
      catch { return null; }
      if (event?.standard !== 'nep141' || event.version !== '1.0.0' || event.event !== 'ft_transfer') continue;
      if (!Array.isArray(event.data)) return null;
      for (const item of event.data) {
        if (!item || typeof item.old_owner_id !== 'string' || typeof item.new_owner_id !== 'string' || !uint(item.amount)) return null;
        const amount = BigInt(item.amount);
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
