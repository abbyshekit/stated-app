// The recorded testnet run stays inspectable even when this demo's faucet is unavailable.
import evidence from '../../evidence/hackathon-demo-20261111.json' with { type: 'json' };
import { html } from '../src/html.mjs';
import { deliveryFromReceipts } from '../src/near-delivery.mjs';
import { formatTestNear, rpc, viewEscrow } from '../src/near-escrow.mjs';

const { environment, payout } = evidence;
const transactionUrl = `https://testnet.nearblocks.io/txns/${payout.transaction}`;
const successTrue = 'dHJ1ZQ==';

export async function verifyRecordedPayout({ request = rpc, readBet = viewEscrow } = {}) {
  const [result, bet] = await Promise.all([
    request('tx_status', { tx_hash: payout.transaction, sender_account_id: payout.winner, wait_until: 'FINAL' }),
    readBet(environment.escrow, environment.bet),
  ]);
  const transaction = result?.transaction;
  const call = transaction?.actions?.[0]?.FunctionCall;
  const delivery = deliveryFromReceipts(result, {
    transactionHash: payout.transaction, accountId: payout.winner,
    amountYocto: payout.deliveredYocto, wrapContractId: 'wrap.testnet',
  });
  const transfer = result?.receipts?.find((receipt) => receipt.receipt_id === payout.transferReceipt);
  const callback = result?.receipts_outcome?.find(({ id }) => id === payout.callbackReceipt)?.outcome;
  return bet?.id === environment.bet && bet.status === 'settled' && bet.creator_side === 'no'
    && bet.acceptor === payout.winner && bet.resolution?.outcome === 'yes' && bet.resolution.method === 'referee'
    && BigInt(bet.stake_yocto) * 2n === BigInt(payout.deliveredYocto)
    && transaction?.signer_id === payout.winner && transaction.receiver_id === environment.escrow
    && transaction.actions.length === 1 && call?.method_name === 'withdraw' && call.deposit === '0'
    && result.status?.SuccessValue === successTrue && delivery?.kind === 'native'
    && transfer?.predecessor_id === environment.escrow && transfer.receiver_id === payout.winner
    && transfer.receipt?.Action?.actions?.some((action) => action.Transfer?.deposit === payout.deliveredYocto)
    && callback?.executor_id === environment.escrow && callback.status?.SuccessValue === successTrue;
}

// Finalized history is immutable. Coalesce concurrent checks and cool down after failures.
export function recordedPayoutCheck(verify = verifyRecordedPayout) {
  let pending;
  let retryAt = 0;
  return async () => {
    if (pending) return pending;
    if (Date.now() < retryAt) return 'unavailable';
    pending = Promise.resolve().then(verify).then((match) => match ? 'verified' : 'unverified', () => 'unavailable');
    const state = await pending;
    if (state !== 'verified') {
      retryAt = Date.now() + 10_000;
      pending = undefined;
    }
    return state;
  };
}

export function recordedPayoutPage(state) {
  const summary = {
    verified: 'Verified on NEAR testnet. The Bet settled and the withdrawal transferred the full pot.',
    unverified: 'The live response did not match the recording. Open the transaction to inspect it.',
    unavailable: 'The live check is unavailable. Open the transaction or try again.',
  }[state];
  return html`<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>Recorded payout · Stated</title><link rel="icon" href="/static/favicon.svg">
<link rel="stylesheet" href="/static/stated.css"><link rel="stylesheet" href="/static/skin.css"></head>
<body><div class="wrap"><header><a class="wordmark" href="/">Stated</a></header>
<main class="pad"><h1>Recorded payout</h1>
<p>Simulated X. Real NEAR testnet.</p>
<p>${environment.prediction}</p>
<h2>${formatTestNear(payout.deliveredYocto)} test NEAR paid</h2>
<p>Carol took Yes and received the pot after the referee recorded the result.</p>
${summary ? html`<p role="status">${summary}</p>` : ''}
<p><a class="btn" href="${state === 'verified' ? transactionUrl : '/demo-proof?verify=1'}">${state === 'verified' ? 'Open transaction' : 'Verify payout'}</a></p>
${state === 'verified' ? '' : html`<p><a href="${transactionUrl}">Open transaction</a></p>`}
<p><a href="/demo-readiness">Demo readiness</a></p>
</main></div></body></html>`;
}
