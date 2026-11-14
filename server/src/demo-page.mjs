// INTEGRATION: Public, read-only demo view; the caller supplies verified mainnet evidence and owns the route and demo styles.
import Decimal from 'decimal.js';
import { html } from './html.mjs';
import { formatTestNear } from './near-escrow.mjs';
import { modelFace, modelName } from './jury-models.mjs';

const walkthrough = 'https://stated-production.up.railway.app/bets/0bf4f3a7-8dfc-44e2-a139-1e33ce844178/ruling';
const thread = 'https://x.com/AbhishekEsq/status/2121456040327922071';
const word = value => value === 'yes' ? 'Yes' : 'No';

function safeUrl(value) {
  try {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null;
  } catch { return null; }
}

function dateFromNs(value) {
  try {
    if (!/^\d+$/.test(String(value))) return null;
    const ms = BigInt(value) / 1000000n;
    if (ms > 8640000000000000n) return null;
    const date = new Date(Number(ms));
    return Number.isFinite(date.getTime()) ? new Intl.DateTimeFormat('en-GB', {
      timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric',
    }).format(date) : null;
  } catch { return null; }
}

function validCase(item, outcome) {
  try {
    return item?.outcome === outcome && typeof item.claim === 'string' && item.claim.trim()
      && safeUrl(item.sourceUrl) && dateFromNs(item.resolvedAtNs)
      && item.payout?.verified === true && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(item.payout.hash || '')
      && new Decimal(formatTestNear(item.stakeYocto)).gt(0)
      && new Decimal(formatTestNear(item.payout.amountYocto)).eq(new Decimal(formatTestNear(item.stakeYocto)).times(2))
      && item.potYocto === item.payout.amountYocto && item.winner === item.payout.recipient
      && Array.isArray(item.verdicts) && item.verdicts.length === 3
      && item.verdicts.every(v => typeof v.model === 'string' && v.model && v.outcome === outcome
        && new Decimal(v.confidence).gte(0.8) && new Decimal(v.confidence).lte(1));
  } catch { return false; }
}

function example(item) {
  const [rawHeadline, ...terms] = item.claim.split(/(?=counts\s+as\s+yes\s*:)/i);
  const headline = rawHeadline.replace(/^Controlled validation [AB]\.\s*/, '').trim();
  return html`<section class="demo-example" id="${item.outcome}">
    <h2 class="demo-claim">${item.outcome === 'yes' ? html`<span class="hl">${headline.trim()}</span>` : html`<span class="struck">${headline.trim()}</span>`}</h2>
    <div class="verdict ruling-verdict${item.outcome === 'yes' ? ' yes' : ''}"><b>${word(item.outcome)}</b><span>${dateFromNs(item.resolvedAtNs)} UTC</span></div>
    <ul class="jury-rail">${item.verdicts.map(v => html`<li class="seat">${modelFace(v.model)}<b>${modelName(v.model)}</b><span>${word(v.outcome)}, ${new Decimal(v.confidence).times(100).toFixed()}% sure</span></li>`)}</ul>
    <p class="gut">Verified payout: ${formatTestNear(item.payout.amountYocto)} NEAR. <a class="tl" href="https://nearblocks.io/txns/${item.payout.hash}" rel="noopener noreferrer">View withdrawal</a></p>
    <p class="gut"><a class="tl" href="${safeUrl(item.sourceUrl)}" rel="noopener noreferrer">Evidence source</a></p>
    ${terms.length ? html`<details class="fold"><summary>Full terms</summary><p>${item.claim}</p></details>` : ''}
  </section>`;
}

export function demoReady(evidence) {
  return evidence?.schemaVersion === 1 && evidence.network === 'mainnet'
    && evidence.mode === 'operator-controlled' && evidence.overall === 'PASS'
    && Number.isFinite(Date.parse(evidence.checkedAt)) && Array.isArray(evidence.checks) && evidence.checks.length > 0
    && evidence.checks.every(check => check?.ok === true) && Array.isArray(evidence.cases) && evidence.cases.length === 2
    && evidence.cases.some(item => validCase(item, 'yes')) && evidence.cases.some(item => validCase(item, 'no'));
}

export function demoPage({ evidence, bot = 'statedforecast', mainnet = true } = {}) {
  const ready = mainnet && demoReady(evidence);
  const yes = ready && evidence.cases.find(item => item.outcome === 'yes');
  const no = ready && evidence.cases.find(item => item.outcome === 'no');
  return html`<div class="demo-page">
    <h1 class="gut">Demo</h1>
    <p class="gut">Write a claim, review the bet and sign. The jury decides and NEAR pays the winner.</p>
    <div class="acts"><a class="pill solid big" href="/me/bets/new">Make a bet</a></div>
    ${ready ? html`<p class="gut quiet">Operator-controlled mainnet tests</p>
      <nav class="demo-nav" aria-label="Demo outcomes"><a class="tl" href="#yes">Yes outcome</a> <a class="tl" href="#no">No outcome</a></nav>
      ${example(yes)}${example(no)}
      <details class="fold"><summary>Start from X</summary>
        <p>Tag @${bot} with a claim, deadline, stake and Yes or No. The reply opens your bet for review.</p>
        <p><a class="tl" href="${thread}" rel="noopener noreferrer">See the X test thread</a>. This historical FAA draft reached review and expired unfunded.</p>
      </details>
      <details class="fold"><summary>Check the results</summary>
        <p>Verification relies on the responses of the configured public RPC providers. It does not independently verify model attestation.</p>
        <p>Verified ${evidence.checkedAt}.</p>
        <p class="acct"><code>node scripts/verify-mainnet-demo.mjs</code></p>
        <p><a class="tl" href="/demo/evidence.json">Public evidence JSON</a></p>
        <p><a class="tl" href="/court">Keyless referee</a></p>
      </details>` : html`<p class="gut">Mainnet examples are unavailable. Check the public evidence and try again.</p><p class="gut"><a class="tl" href="/demo/evidence.json">Public evidence JSON</a></p>`}
    <p class="gut"><a class="tl" href="${walkthrough}" rel="noopener noreferrer">View the full testnet walkthrough</a></p>
  </div>`;
}
