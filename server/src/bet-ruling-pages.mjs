// INTEGRATION: web.mjs registers this public, read-only page beside the Bet start routes.
// DESIGN.md: a normal post row, hairline-separated evidence and one filled action; skin.css only.
import Decimal from 'decimal.js';
import { readFileSync } from 'node:fs';
import { html } from './html.mjs';
import { readPublicBet } from './bet-public.mjs';
import { face, facesByUsername, facesFor } from './certificate.mjs';
import { readEnclaveRuling, quoteSummary } from './enclave-ruling.mjs';
import { publicPredictionOwner, publicSave } from './store.mjs';
import { dayMonth } from './marked.mjs';
import { markedClaim } from './bet-view.mjs';
import { formatTestNear } from './near-escrow.mjs';
import { unit } from './near-network.mjs';
import { dstackPasses } from './dstack-verifier.mjs';

const ID = '([a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})';
const MODEL_LOGOS = new Map(['qwen', 'deepseek', 'zai'].map(family => [family,
  readFileSync(new URL(`../public/models/${family}.svg`, import.meta.url))]));
const modelFace = (id) => {
  const family = id.startsWith('Qwen/') ? 'qwen' : id.startsWith('deepseek-ai/') ? 'deepseek'
    : /^(?:z-ai|zai-org)\//.test(id) ? 'zai' : null;
  const maker = { qwen: 'Qwen', deepseek: 'DeepSeek', zai: 'Z.ai' }[family];
  return family ? html`<span class="face model-logo ${family}" role="img" aria-label="${maker} logo"></span>`
    : face({ name: modelName(id) });
};
const percent = (value) => `${new Decimal(value).times(100).toFixed()}%`;
const majorityOutcome = (record) => {
  const counts = new Map();
  for (const { parsed } of record.verdicts) counts.set(parsed.outcome, (counts.get(parsed.outcome) || 0) + 1);
  return [...counts].find(([, count]) => count > record.verdicts.length / 2)?.[0];
};
// Thousands separated, decimals as Coinbase gave them: US$100,000 and US$3.689.
const price = (value) => {
  const [whole, cents] = new Decimal(value).toFixed().split('.');
  return `US$${whole.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}${cents ? `.${cents}` : ''}`;
};
const clock = (value) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', hour: '2-digit', minute: '2-digit',
}).format(new Date(value));
const outcomeWord = (outcome) => outcome === 'yes' ? 'Yes' : outcome === 'no' ? 'No' : 'Undecided';
const modelName = (id) => /^(?:z-ai|zai-org)\/glm-5\.3-flash$/i.test(id) ? 'GLM-5.3 Flash' : id.split('/').at(-1)
  .replace(/-(?:A\d+B|FP\d+|BF\d+|Flash|Instruct|Thinking|\d{4,8})(?=-|$)/gi, '')
  .replaceAll('-', ' ');
const VERIFIED = [
  'Each model ran in an Intel TDX enclave whose quote chains to Intel’s root certificate',
  'Each enclave’s signing key and this request’s fresh nonce are inside its quote',
  'Each verdict is signed by its enclave’s key',
  'The signed request names this bet and its terms hash',
  'The text the models read is inside the signed request',
];

// DESIGN.md: two plain supporting lines inside the existing verification fold.
export function dstackVerificationLines(record) {
  const results = [record.plan, ...record.verdicts].flatMap(call => [call.dstack?.gateway, call.dstack?.model]);
  if (!results.every(dstackPasses) || results.some(result => result.advisoryIds.length)) return [];
  const versions = [...new Set(results.map(result => result.osImageVersion))];
  if (versions.length !== 1 || !versions[0]) return [];
  return [
    `Boot measurements match the published dstack OS ${versions[0]} image, production build, checked by the official dstack verifier.`,
    'Intel TCB is up to date with no security advisories.',
  ];
}

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
  return html`<div class="ruling-post"><div class="post"><div class="head">${face({ url: picture, name: author })}<b>${author}</b>${handle && `@${handle}` !== author ? html`<span>@${handle}</span>` : ''}</div></div>
    <p class="prop bet-claim${bet.claim.length > 200 ? ' long' : bet.claim.length > 120 ? ' mid' : ''}">${markedClaim(bet.claim, outcome)}</p>
  </div>`;
}

function evidenceLine(record, bet) {
  const evidence = JSON.parse(record.evidence.text);
  const deadline = `${clock(bet.resolve_at)} UTC ${dayMonth(bet.resolve_at)}`;
  if (record.evidence.kind === 'submitted') {
    const majority = majorityOutcome(record);
    const juror = record.outcome === 'unclear'
      ? majority && record.verdicts.find(verdict => verdict.parsed.outcome !== majority) : record.verdicts[0];
    return html`${juror ? html`“${juror.parsed.reason.replace(/[.,!?]+$/, '')},” ${modelName(juror.model)} wrote. ` : ''}The deadline was ${deadline}.`;
  }
  const plan = record.plan.parsed;
  return plan.kind === 'moment'
    ? `Coinbase ${plan.product} traded at ${price(evidence.summary.priceAtMoment)} at ${deadline}, the deadline.`
    : `Coinbase ${plan.product} ranged from ${price(evidence.summary.lowestLow)} to ${price(evidence.summary.highestHigh)} before the deadline, ${deadline}.`;
}

function rulingLine(record, bet) {
  if (record.mode === 'review') return record.agrees !== null
    ? `A Stated reviewer recorded ${outcomeWord(bet.outcome)}. The jury ${record.agrees ? 'agreed' : 'disagreed'}.` : '';
  const settled = ['settled', 'refunded'].includes(bet.status);
  if (record.outcome === 'unclear') {
    const counts = new Map();
    for (const { parsed } of record.verdicts) counts.set(parsed.outcome, (counts.get(parsed.outcome) || 0) + 1);
    const split = [...counts.values()].sort((a, b) => b - a);
    return `The NEAR AI enclave jury split ${split[0]} to ${split[1] || 0}. All three must agree, so both stakes ${settled ? 'went' : 'go'} back.`;
  }
  const creatorWon = record.outcome === bet.creator_side;
  const winner = creatorWon ? bet.creator_username : bet.acceptor_username;
  const pot = formatTestNear((BigInt(bet.stake_yocto) * 2n).toString());
  return `The NEAR AI enclave jury agreed, so ${winner ? `@${winner}, who bet ${record.outcome},` : `the ${record.outcome} side`} ${settled ? 'won' : 'wins'} the ${pot} ${unit()} pot.`;
}

function evidenceFold(record) {
  if (record.evidence.kind !== 'submitted') return '';
  const { items } = JSON.parse(record.evidence.text);
  if (!items.length) return html`<p class="gut quiet">No links yet.</p>`;
  return html`<details class="fold"><summary>Links, ${items.length}</summary>
    <ul class="posts evidence-list">${items.map(item => {
      let url = null; let host = null;
      try {
        const parsed = new URL(item.url);
        if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) { url = parsed.href; host = parsed.host; }
      } catch { /* Invalid stored URLs remain escaped text. */ }
      return html`<li class="prow"><div><p>Bet ${item.side}: ${url ? html`<a class="tl" href="${url}" rel="noopener noreferrer">${item.title || host}</a>` : item.title || item.url}${host ? html` <span class="quiet">${host}</span>` : ''}</p>
        <details class="fold"><summary>Saved page text</summary>${item.text.split('\n\n').map(text => html`<p>${text}</p>`)}</details>
      </div></li>`;
    })}</ul>
  </details>`;
}

export function registerBetRulingRoutes({ route, db, config, layout, send, notFound }) {
  // Match web.mjs static handling, restricted to the bundled model logos.
  route('GET', /^\/static\/models\/(qwen|deepseek|zai)\.svg$/, (ctx) => {
    ctx.res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400', 'x-content-type-options': 'nosniff' });
    ctx.res.end(MODEL_LOGOS.get(ctx.params[0]));
  });
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
    const dstackLines = dstackVerificationLines(record);
    const evidence = evidenceLine(record, bet);
    const line = rulingLine(record, bet);
    const majority = record.outcome === 'unclear' ? majorityOutcome(record) : null;
    const body = html`
      <h1 class="visually-hidden">Ruling</h1>
      ${post}
      <div class="verdict ruling-verdict${record.outcome === 'yes' ? ' yes' : ''}"><b>${record.outcome === 'yes' ? html`<span class="hl">Yes</span>` : outcomeWord(record.outcome)}</b><span>${dayMonth(record.decidedAt, { year: true })}</span></div>
      ${line ? html`<p class="gut">${line}</p>` : ''}
      <ul class="jury-rail">${record.verdicts.map(verdict => html`<li class="seat${majority && verdict.parsed.outcome !== majority ? ' dissent' : ''}">
        ${modelFace(verdict.model)}<b>${modelName(verdict.model)}</b><span>${outcomeWord(verdict.parsed.outcome)}, ${percent(verdict.parsed.confidence)} sure</span>
      </li>`)}</ul>
      ${evidence ? html`<p class="gut">${evidence}</p>` : ''}
      <div class="acts"><a class="pill solid big" href="/bets/new?from=${bet.id}">${record.mode === 'ruling' && record.outcome === 'unclear' && ['settled', 'refunded'].includes(bet.status) ? 'Make another bet' : 'Make your own bet'}</a></div>
      <div class="folds">
      ${evidenceFold(record)}
      <details class="fold"><summary>Why each model decided</summary>
        <ul class="posts evidence-list">${record.verdicts.map(verdict => html`<li class="prow"><div><p class="pwho"><b>${verdict.model}</b></p><p>${verdict.parsed.reason}</p></div></li>`)}</ul>
      </details>
      <details class="fold"><summary>Check it yourself</summary>
        <p>Each verdict was signed inside an Intel TDX enclave, and every signature checked out.</p>
        <ul class="posts evidence-list">${verified.map(line => html`<li class="prow"><div>${line}</div></li>`)}</ul>
        ${dstackLines.length ? dstackLines.map(line => html`<p>${line}</p>`) : html`<p class="quiet">Not checked: enclave measurements against a published list, TCB level and revocation${gpuVerified ? '' : ', the GPU’s own attestation'}.</p>`}
        ${dstackLines.length && !gpuVerified ? html`<p class="quiet">Not checked: the GPU’s own attestation.</p>` : ''}
        <p>${record.mode === 'review'
          ? `Every model has to agree at ${percent(record.minConfidence)} or more for the jury to give a verdict. A second opinion does not change the payout.`
          : `Every model has to agree at ${percent(record.minConfidence)} or more, or both stakes go back.`}</p>
        <p class="acct"><code>node scripts/verify-enclave-ruling.mjs ${config.baseUrl} ${bet.id}</code></p>
        <p><a class="tl" href="/bets/${bet.id}/enclave-ruling.json">Ruling JSON</a></p>
        ${quotes.map(quote => html`<p class="quiet acct">${quote.role} ${quote.model} <code>${quote.mrtd.slice(0, 16)}</code></p>`)}
      </details>
      </div>`;
    send(ctx.res, 200, await layout(ctx, 'Ruling', body, { flush: true, back: `/bets/${bet.id}`, signin: false }));
  });
}
