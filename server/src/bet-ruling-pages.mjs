// INTEGRATION: web.mjs registers this public, read-only page beside the Bet start routes.
// DESIGN.md: a normal post row, hairline-separated evidence and one filled action; skin.css only.
import Decimal from 'decimal.js';
import { html } from './html.mjs';
import { readPublicBet } from './bet-public.mjs';
import { face, facesByUsername, facesFor } from './certificate.mjs';
import { readEnclaveRuling, quoteSummary } from './enclave-ruling.mjs';
import { publicPredictionOwner, publicSave } from './store.mjs';
import { dayMonth } from './marked.mjs';
import { markedClaim } from './bet-view.mjs';

const ID = '([a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})';
const percent = (value) => `${new Decimal(value).times(100).toFixed()}%`;
// Thousands separated, decimals as Coinbase gave them: US$100,000 and US$3.689.
const price = (value) => {
  const [whole, cents] = new Decimal(value).toFixed().split('.');
  return `US$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${cents ? `.${cents}` : ''}`;
};
const time = (value) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short',
}).format(new Date(value)) + ' UTC';
const clock = (value) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', hour: '2-digit', minute: '2-digit',
}).format(new Date(value));
const outcomeWord = (outcome) => outcome === 'yes' ? 'Yes' : outcome === 'no' ? 'No' : 'Undecided';
const modelName = (id) => id.split('/').at(-1)
  .replace(/-(?:A\d+B|FP\d+|BF\d+|Flash|Instruct|Thinking|\d{4,8})(?=-|$)/gi, '')
  .replaceAll('-', ' ');
const VERIFIED = [
  'Each model ran in an Intel TDX enclave whose quote chains to Intel’s root certificate',
  'Each enclave’s signing key and this request’s fresh nonce are inside its quote',
  'Each verdict is signed by its enclave’s key',
  'The signed request names this bet and its terms hash',
  'The evidence text the models read is inside the signed request',
];

// Public pages never enrich the source identity from the viewer's private save.
async function postRow(db, bet, outcome) {
  const linked = await db.one('select source_save_id from bilateral_bets where id=$1', [bet.id]);
  const owner = linked?.source_save_id ? await publicPredictionOwner(db, linked.source_save_id) : null;
  const source = owner ? await publicSave(db, owner, linked.source_save_id) : null;
  const available = source?.available;
  const direct = available && source.platform === 'x' && !source.reported_speech;
  const author = available ? (direct ? source.author_name || source.speaker : source.speaker) : bet.creator_username || 'Bet proposer';
  const handle = available ? (direct ? source.author_username : null) : bet.creator_username;
  const pictures = available ? await facesFor(db, [source]) : await facesByUsername(db, [handle]);
  const picture = pictures.get(available ? String(source.speaker_x_user_id) : String(handle || '').toLowerCase());
  return html`<ul class="posts ruling-post"><li class="prow">${face({ url: picture, name: author })}<div>
    <p class="pwho"><b>${author}</b>${handle && `@${handle}` !== author ? html`<span>@${handle}</span>` : ''}</p>
    <p class="said">${markedClaim(bet.claim, outcome)}</p>
  </div></li></ul>`;
}

function evidenceLine(record) {
  const evidence = JSON.parse(record.evidence.text);
  if (record.evidence.kind === 'submitted') return evidence.items.length
    ? (evidence.items.length === 1 ? 'From 1 link posted as evidence.'
      : new Set(evidence.items.map((item) => item.side)).size > 1 ? `From ${evidence.items.length} links posted by both sides.`
        : `From ${evidence.items.length} links posted by one side.`)
    : 'No links were posted.';
  const plan = record.plan.parsed;
  return plan.kind === 'moment'
    ? `Coinbase ${plan.product} opened at ${price(evidence.summary.priceAtMoment)} at ${clock(plan.start)} UTC on ${dayMonth(plan.start)}.`
    : `Coinbase ${plan.product} ranged from ${price(evidence.summary.lowestLow)} to ${price(evidence.summary.highestHigh)} between ${time(plan.start).replace(/ UTC$/, '')} and ${time(plan.end)}.`;
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
      return { bet, record, quotes, post: await postRow(tx, bet, record.outcome) };
    });
    if (!result) return notFound(ctx);
    const { bet, record, quotes, post } = result;
    const gpuVerified = record.verdicts.every(verdict => verdict.gpu?.verdict === true);
    const verified = gpuVerified
      ? [...VERIFIED, 'Each model’s NVIDIA GPU attestation was verified by NVIDIA’s attestation service'] : VERIFIED;
    const body = html`
      <h1 class="visually-hidden">Ruling</h1>
      ${post}
      <div class="verdict ruling-verdict${record.outcome === 'yes' ? ' yes' : ''}"><h2>NEAR AI enclave jury</h2><b>${outcomeWord(record.outcome)}</b><span>${dayMonth(record.decidedAt, { year: true })}</span></div>
      ${record.mode === 'review' && record.agrees !== null ? html`<p class="gut quiet">${record.agrees ? 'Agrees with the recorded result' : 'Disagrees with the recorded result'}</p>` : ''}
      <ul class="jury-rail${record.outcome === 'yes' ? '' : ' agreed'}">${record.verdicts.map(verdict => html`<li class="seat${verdict.parsed.outcome === record.outcome ? ' won' : ''}">
        ${face({ name: modelName(verdict.model) })}<b>${modelName(verdict.model)}</b><span>${outcomeWord(verdict.parsed.outcome)}, ${percent(verdict.parsed.confidence)}</span>
      </li>`)}</ul>
      <p class="gut">${evidenceLine(record)}</p>
      <p class="gut quiet">Each verdict was signed inside an Intel TDX enclave, and every signature checked out.</p>
      <div class="folds">
      <details class="fold"><summary>Why each model decided</summary>
        <ul class="posts evidence-list">${record.verdicts.map(verdict => html`<li class="prow"><div><p class="pwho"><b>${verdict.model}</b></p><p>${verdict.parsed.reason}</p></div></li>`)}</ul>
      </details>
      <details class="fold"><summary>Check it yourself</summary>
        <ul class="posts evidence-list">${verified.map(line => html`<li class="prow"><div>${line}</div></li>`)}</ul>
        <p class="quiet">Not checked: enclave measurements against a published list, TCB level and revocation${gpuVerified ? '' : ', the GPU’s own attestation'}.</p>
        <p>${record.mode === 'review'
          ? `Every model has to agree at ${percent(record.minConfidence)} or more for the jury to give a verdict. A second opinion does not change the payout.`
          : `Every model has to agree at ${percent(record.minConfidence)} or more, or both stakes go back.`}</p>
        <p class="acct"><code>node scripts/verify-enclave-ruling.mjs ${config.baseUrl} ${bet.id}</code></p>
        <p><a class="tl" href="/bets/${bet.id}/enclave-ruling.json">Ruling JSON</a></p>
        ${quotes.map(quote => html`<p class="quiet acct">${quote.role} ${quote.model} <code>${quote.mrtd.slice(0, 16)}</code></p>`)}
      </details>
      </div>
      <div class="acts"><a class="pill solid big" href="/bets/new?from=${bet.id}">Make your own bet</a></div>`;
    send(ctx.res, 200, await layout(ctx, 'Ruling', body, { flush: true, back: `/bets/${bet.id}`, signin: false }));
  });
}
