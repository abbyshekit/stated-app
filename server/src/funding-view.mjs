// INTEGRATION: DESIGN.md's ordinary account text and controls, shared by wallet and bet pages.
import { html } from './html.mjs';
import { near, shortfall, yocto } from './play.mjs';

export function fundingNeed(value) {
  return typeof value === 'string' && /^(?:0|[1-9][0-9]{0,24})$/.test(value)
    && BigInt(value) <= BigInt(yocto('1.01')) ? value : '0';
}

export async function fundingStatus(config, chain, account, neededYocto = '0') {
  const needed = fundingNeed(neededYocto);
  const [balance, missing] = await Promise.all([
    chain.balance(account.account_id), shortfall(config, chain, account, needed),
  ]);
  return { accountId: account.account_id, balanceNear: balance == null ? null : near(balance),
    neededYocto: needed, neededNear: near(needed), missingNear: near(missing) };
}

export function fundingPanel(status, { payVersion = '', unavailable = false } = {}) {
  return html`<div class="gut" data-funding data-needed-yocto="${status.neededYocto}">
    <p>NEAR account: <span class="acct" id="funding-account">${status.accountId}</span>
      <button class="tl" type="button" data-copy="funding-account" hidden>Copy account</button></p>
    <p>Current balance: <b data-funding-balance>${status.balanceNear == null ? 'Unavailable' : `${status.balanceNear} NEAR`}</b></p>
    <p>Needed for this bet: <b>${status.neededNear} NEAR</b>${status.neededYocto === '0' ? ' (choose a bet to see its stake)' : ', plus network fees'}.</p>
    <p>Add <b data-funding-missing>${status.missingNear == null ? 'an amount shown when NEAR reconnects' : `${status.missingNear} NEAR`}</b> to cover it.</p>
    <p>Send NEAR to this account from any exchange or wallet; it shows up here within a minute.</p>
    <p class="quiet" role="status" data-funding-status>${unavailable ? 'Balance unavailable. Retry the balance check.' : ''}</p>
    <button class="tl" type="button" data-refresh-balance hidden>Refresh balance</button>
  </div><script src="/static/pay.js?v=${payVersion}" defer></script>`;
}
