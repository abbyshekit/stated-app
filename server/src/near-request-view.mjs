// INTEGRATION: Private Bet pages show each actor's latest saved wallet intents.
// DESIGN.md governs presentation. These controls use the existing exact verifier;
// a wallet return or a pasted transaction hash never establishes success alone.
import { html, raw } from './html.mjs';
import { transactionLink } from './near-network.mjs';

const ACTIONS = {
  create_bet: 'Deposit stake',
  accept_bet: 'Accept bet',
  cancel_bet: 'Cancel offer',
  expire_bet: 'Expire offer',
  propose_outcome: 'Propose result',
  confirm_outcome: 'Agree result',
  dispute_outcome: 'Dispute result',
  refund_unresolved: 'Reclaim stake',
};
const STATUS = { pending: 'Pending verification', failed: 'Transaction failed', succeeded: 'Transaction confirmed' };

export async function latestWalletRequests(db, config, user, betId) {
  if (!config.nearContract) return [];
  // At most one row for each known action. Withdrawals retain their separate
  // credit-aware recovery controls. Never expose another actor's request.
  return db.many(`select distinct on (method) id, method, wallet_account,
    execution_status, execution_message, transaction_hash
    from bilateral_near_requests where bet_id=$1 and user_id=$2
    and metadata->>'contract'=$3 and method=any($4::text[])
    order by method, created_at desc, id desc`, [betId, user.id, config.nearContract, Object.keys(ACTIONS)]);
}

export function walletRequestHistory(requests, betId, csrf) {
  if (!requests.length) return '';
  return html`<section class="wallet-requests" aria-label="Wallet requests">
    <h2>Latest wallet requests</h2>
    <p class="quiet">If you already approved a request in Meteor, enter its transaction hash to check the result before signing again.</p>
    ${requests.map((request) => html`<details class="fold" ${request.execution_status === 'succeeded' ? '' : raw('open')}>
      <summary><span>${ACTIONS[request.method]}</span> <small>${STATUS[request.execution_status] || 'Not verified'}</small></summary>
      <p class="mono">${request.wallet_account}</p>
      <p class="quiet mono">Request ${request.id}</p>
      ${request.execution_message ? html`<p role="status">${request.execution_message}</p>` : ''}
      ${request.transaction_hash ? html`<p><a href="${transactionLink(request.transaction_hash)}" rel="noopener noreferrer">View transaction</a></p>` : ''}
      ${['pending', 'failed'].includes(request.execution_status) ? html`
        <form method="post" action="/bets/${betId}/transactions">
          ${csrf}<input type="hidden" name="requestId" value="${request.id}">
          <label>Transaction hash<input type="text" name="transactionHash" value="${request.transaction_hash || ''}" required maxlength="44" autocomplete="off"></label>
          <button type="submit">Check transaction</button>
        </form>` : ''}
    </details>`)}
  </section>`;
}
