// INTEGRATION: web.mjs registers this public, read-only page beside the Bet start routes.
// DESIGN.md: a normal post row, hairline-separated evidence and one filled action; skin.css only.
import Decimal from 'decimal.js';
import { html } from './html.mjs';
import { readPublicBet } from './bet-public.mjs';
import { face, facesByUsername, facesFor } from './certificate.mjs';
import { readEnclaveRuling, quoteSummary } from './enclave-ruling.mjs';
import { publicPredictionOwner, publicSave } from './store.mjs';

const ID = '([a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})';
const percent = (value) => `${new Decimal(value).times(100).toFixed()}%`;
const price = (value) => `US$${new Decimal(value).toFixed()}`;
const time = (value) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short',
}).format(new Date(value)) + ' UTC';
const VERIFIED = [
  'Each model ran in an Intel TDX enclave whose quote chains to Intel’s root certificate',
  'Each enclave’s signing key and this request’s fresh nonce are inside its quote',
  'Each verdict is signed by its enclave’s key',
  'The signed request names this bet and its terms hash',
  'The evidence text the models read is inside the signed request',
];

// Public pages never enrich the source identity from the viewer's private save.
async function postRow(db, bet) {
  const linked = await db.one('select source_save_id from bilateral_bets where id=$1', [bet.id]);
  const owner = linked?.source_save_id ? await publicPredictionOwner(db, linked.source_save_id) : null;
  const source = owner ? await publicSave(db, owner, linked.source_save_id) : null;
  const available = source?.available;
  const direct = available && source.platform === 'x' && !source.reported_speech;
  const author = available ? (direct ? source.author_name || source.speaker : source.speaker) : bet.creator_username || 'Bet proposer';
  const handle = available ? (direct ? source.author_username : null) : bet.creator_username;
  const pictures = available ? await facesFor(db, [source]) : await facesByUsername(db, [handle]);
  const picture = pictures.get(available ? String(source.speaker_x_user_id) : String(handle || '').toLowerCase());
  return html`<ul class="posts"><li class="prow">${face({ url: picture, name: author })}<div>
    <p class="pwho"><b>${author}</b>${handle && `@${handle}` !== author ? html`<span>@${handle}</span>` : ''}</p>
    <p class="said">${bet.claim}</p>
  </div></li></ul>`;
}

function submittedRows(items) {
  return items.map(item => {
    let link = null;
    let host = null;
    // A signature authenticates stored text; it does not make an arbitrary URL safe to open.
    try {
      const url = new URL(item.url);
      if (url.protocol === 'https:' && !url.username && !url.password) {
        link = url.href;
        host = url.host;
      }
    } catch { /* Show the stored title without a link when an old URL is invalid. */ }
    return html`<li class="prow"><div>
      <p class="pwho"><b>Bet ${item.side}</b></p>
      <p class="evidence-title">${link ? html`<a class="tl" href="${link}" rel="noopener noreferrer">${item.title || host}</a>` : item.title || item.url}</p>
      ${host ? html`<p class="meta">${host}</p>` : ''}
      <details class="fold"><summary>Page text</summary>${item.text.split(/\n\n+/u).map(text => html`<p class="acct">${text}</p>`)}</details>
    </div></li>`;
  });
}

function evidenceRows(record) {
  const evidence = JSON.parse(record.evidence.text);
  if (record.evidence.kind === 'submitted') return html`<ul class="posts evidence-list">${submittedRows(evidence.items)}</ul>`;
  const plan = record.plan.parsed;
  return html`<ul class="posts evidence-list"><li class="prow"><div>
    <p>Coinbase ${plan.product} price, ${time(plan.start)} to ${time(plan.end)}</p>
    <p>${plan.kind === 'moment' ? `opened at ${price(evidence.summary.priceAtMoment)}` : `low ${price(evidence.summary.lowestLow)}, high ${price(evidence.summary.highestHigh)}`}</p>
    <a class="tl" href="${record.evidence.urls[0]}" rel="noopener noreferrer">Coinbase data</a>
  </div></li></ul>`;
}

function heading(record) {
  if (record.outcome === 'unclear') return 'The jury could not decide';
  if (record.mode === 'review') {
    if (record.agrees === null) return 'The jury could not decide';
    return `Second opinion: ${record.agrees ? 'agrees' : 'disagrees'}`;
  }
  return `Ruled ${record.outcome}`;
}

export function registerBetRulingRoutes({ route, db, config, layout, send, notFound }) {
  route('GET', new RegExp(`^/bets/${ID}/ruling$`), async (ctx) => {
    const result = await db.tx(async tx => {
      const bet = await readPublicBet(tx, ctx.params[0], config.play);
      // The signed text cannot be redacted. Preserve the JSON route's private-evidence gate.
      if (!bet?.enclave || bet.evidence?.privateItemCount) return null;
      let record;
      let quotes;
      try {
        record = await readEnclaveRuling(tx, bet.id);
        if (!record) return null;
        quotes = quoteSummary(record);
      } catch { return null; }
      return { bet, record, quotes, post: await postRow(tx, bet) };
    });
    if (!result) return notFound(ctx);
    const { bet, record, quotes, post } = result;
    const body = html`
      <h1 class="visually-hidden">Ruling</h1>
      ${post}
      <p class="lead">${heading(record)}<span>${time(record.decidedAt)}</span></p>
      <h2>Jury</h2>
      <ul class="posts evidence-list">${record.verdicts.map(verdict => html`<li class="prow"><div>
        <p class="pwho"><b>${verdict.model}</b></p>
        <p class="meta"><b>${verdict.parsed.outcome}</b><span>${percent(verdict.parsed.confidence)}</span></p>
        <p class="meta">${verdict.parsed.reason}</p>
      </div></li>`)}</ul>
      <p class="gut">${record.mode === 'review'
        ? `Every model has to agree at ${percent(record.minConfidence)} or more for the jury to give a verdict. A second opinion does not change the payout.`
        : `Every model has to agree at ${percent(record.minConfidence)} or more, or both stakes go back.`}</p>
      <h2>Evidence</h2>
      ${evidenceRows(record)}
      <h2>Verified</h2>
      <ul class="posts evidence-list">${VERIFIED.map(line => html`<li class="prow"><div>✓ ${line}</div></li>`)}</ul>
      <p class="gut quiet">Not checked: enclave measurements against a published list, TCB level and revocation, the GPU’s own attestation.</p>
      <details class="fold"><summary>Check it yourself</summary>
        <p class="acct"><code>node scripts/verify-enclave-ruling.mjs ${config.baseUrl} ${bet.id}</code></p>
        <p><a class="tl" href="/bets/${bet.id}/enclave-ruling.json">Ruling JSON</a></p>
        ${quotes.map(quote => html`<p class="quiet acct">${quote.role} ${quote.model} <code>${quote.mrtd.slice(0, 16)}</code></p>`)}
      </details>
      <div class="acts"><a class="pill solid big" href="/bets/new?from=${bet.id}">Make your own bet</a></div>`;
    send(ctx.res, 200, await layout(ctx, 'Ruling', body, { flush: true, back: `/bets/${bet.id}`, signin: false }));
  });
}
