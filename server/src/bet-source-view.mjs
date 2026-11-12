// INTEGRATION: Bet pages use authorized source identity separately from Bet seats.
// Public callers pass no viewer, so a private save cannot enrich a public page.
import { html } from './html.mjs';
import { ownerSave, publicSave, publicPredictionOwner, UserError } from './store.mjs';
import { face, facesFor, facesByUsername } from './certificate.mjs';
import { displaySourceUrl } from './xapi.mjs';
import { postLogo, postTime, xPostUrl } from './x-post-view.mjs';

// The Bet already publishes this URL. Read only its stored post time, never
// private source words or identity; a Bet/save creation time is not a post time.
export async function betPostTime(db, bet, simulatedOrigin) {
  const url = xPostUrl(bet.evidence_source_url, simulatedOrigin);
  if (!url) return '';
  const source = await db.one(`select src.published_at from bilateral_bets b
    join saves s on s.id=b.source_save_id join statements st on st.id=s.statement_id
    join sources src on src.id=st.source_id
    where b.id=$1 and src.platform='x' and src.url=$2`, [bet.id, bet.evidence_source_url]);
  return postTime(url, source?.published_at);
}

export async function predictionSourceHeader(db, viewer, source, simulatedOrigin) {
  if (!source?.available) return '';
  const direct = source.platform === 'x' && !source.reported_speech;
  const name = direct ? source.author_name || source.speaker : source.speaker;
  const handle = direct && source.author_username ? `@${source.author_username}` : '';
  const pictures = await facesFor(db, [source], viewer);
  const link = displaySourceUrl(source, simulatedOrigin);
  const label = source.platform === 'x' ? (simulatedOrigin ? 'On simulated X' : 'On X') : 'Source';
  const post = source.platform === 'x' ? xPostUrl(link, simulatedOrigin) : null;
  return html`<div class="post source-author" data-source-author="prediction">
    <p class="visually-hidden">Source prediction by</p><div class="head">${face({ url: pictures.get(String(source.speaker_x_user_id)) || null, name })}<b>${name}</b><span>${handle}</span>${post ? postLogo(post) : link ? html`<a class="src" href="${link}" rel="noopener noreferrer">${label}</a>` : ''}</div>
  </div>`;
}

export async function betSourceHeader(db, viewer, bet, simulatedOrigin, { timestamp = false } = {}) {
  const linked = await db.one('select source_save_id from bilateral_bets where id=$1', [bet.id]);
  let source = null;
  if (linked?.source_save_id) {
    if (viewer?.kind === 'person') {
      try { source = await ownerSave(db, viewer, linked.source_save_id); }
      catch (error) { if (!(error instanceof UserError) || error.status !== 404) throw error; }
    }
    if (!source) {
      const owner = await publicPredictionOwner(db, linked.source_save_id);
      if (owner) source = await publicSave(db, owner, linked.source_save_id);
    }
  }
  if (source?.available) return timestamp
    ? postTime(source.platform === 'x' ? xPostUrl(displaySourceUrl(source, simulatedOrigin), simulatedOrigin) : null, source.published_at)
    : predictionSourceHeader(db, viewer, source, simulatedOrigin);
  if (timestamp) return betPostTime(db, bet, simulatedOrigin);
  const handle = bet.creator_username || '';
  const pictures = await facesByUsername(db, [handle], viewer);
  const name = viewer?.x_username?.toLowerCase() === handle.toLowerCase() ? viewer.x_name || handle : handle;
  return html`<div class="post source-author" data-source-author="proposer">
    <div class="head">${face({ url: pictures.get(handle.toLowerCase()) || null, name })}<b>${name ? `Offered by ${name}` : 'Bet proposer'}</b><span>${handle ? `@${handle}` : ''}</span>${postLogo(xPostUrl(bet.evidence_source_url, simulatedOrigin))}</div>
  </div>`;
}
