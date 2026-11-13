// INTEGRATION: DESIGN.md's existing jury rail and verification fold, with OutLayer provenance.
import Decimal from 'decimal.js';
import { html } from './html.mjs';
import { accountLink } from './near-network.mjs';
import { modelFace, modelName } from './jury-models.mjs';

const word = outcome => ({ yes: 'Yes', no: 'No', void: 'Void', unclear: 'Undecided' })[outcome] || 'Pending';

function evidenceLink(value) {
  try {
    const url = new URL(value);
    if (url.protocol === 'https:' && !url.username && !url.password) {
      return html`<a class="tl" href="${url.href}" rel="noopener noreferrer">${value}</a>`;
    }
  } catch { /* Malformed historical links remain escaped text. */ }
  return value;
}

// DESIGN.md: source details use the existing Links fold and ordinary link rows.
function evidenceLinks(summary) {
  if (!['submitted', 'open'].includes(summary?.kind) || !Array.isArray(summary.items) || !summary.items.length) return '';
  return html`<details class="fold"><summary>Links, ${summary.items.length}</summary><ul class="posts evidence-list">${summary.items.map(item => {
    const posted = item.postedUrl || item.url;
    return html`<li class="prow"><div><p class="evidence-title">Bet ${word(item.side)}: ${evidenceLink(posted)}</p>
      ${item.unreadable ? html`<p class="meta">could not be read: ${item.unreadable}</p>` : ''}
      ${item.postedUrl && item.postedUrl !== item.url ? html`<p class="evidence-title">Read from ${evidenceLink(item.url)}</p>` : ''}</div></li>`;
  })}</ul></details>`;
}

export function outlayerDetail(bet, { links = true } = {}) {
  const record = bet.outlayer;
  if (!record) return '';
  const result = record.result;
  return html`<p class="gut">${result ? 'The jury ran in an OutLayer enclave.' : 'This bet uses the OutLayer enclave jury.'}
    ${links ? html`<a class="tl" href="/bets/${bet.id}/ruling">${result ? 'View ruling' : 'View referee status'}</a>` : ''}</p>
    ${result ? html`<ul class="jury-rail">${result.verdicts.map(verdict => html`<li class="seat">${modelFace(verdict.model)}
      <b>${modelName(verdict.model)}</b><span>${word(verdict.outcome)}, ${new Decimal(verdict.confidence).times(100).toFixed()}% sure</span></li>`)}</ul>` : ''}
    ${evidenceLinks(result?.evidence_summary)}
    <details class="fold"><summary>Verify OutLayer</summary>
      <p>Referee: <a class="tl" href="${accountLink(record.referee)}" rel="noopener noreferrer">${record.referee}</a></p>
      <p>Stage: ${record.ruling.stage}. Outcome: ${word(record.ruling.outcome)}.</p>
      <p class="acct">Jury WASM SHA256: <code>${record.config.wasm_hash}</code></p>
      ${/^https:\/\//.test(record.config.wasm_url || '') ? html`<p><a class="tl" href="${record.config.wasm_url}" rel="noopener noreferrer">Jury WASM</a></p>` : ''}
      <p><a class="tl" href="https://app.outlayer.ai/docs/tee-attestation" rel="noopener noreferrer">OutLayer attestation verification</a></p>
      ${links ? html`<p><a class="tl" href="/bets/${bet.id}/outlayer-ruling.json">Material and ruling JSON</a></p>` : ''}
      <p>The referee accepts the pinned jury's result through OutLayer. This page does not independently verify a model attestation.</p>
    </details>`;
}

export function outlayerRulingBody(bet, post) {
  const result = bet.outlayer.result;
  return html`<h1 class="visually-hidden">OutLayer ruling</h1>${post}
    <div class="verdict ruling-verdict${result?.outcome === 'yes' ? ' yes' : ''}"><b>${word(result?.outcome || bet.outlayer.ruling.outcome)}</b></div>
    ${outlayerDetail(bet)}
    ${!result ? html`<p class="gut">The referee has not exposed a jury result for this bet.</p>` : ''}
    <div class="acts"><a class="pill solid big" href="/bets/new?from=${bet.id}">Make a bet</a></div>`;
}
