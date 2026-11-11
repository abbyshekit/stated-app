// INTEGRATION: Bet pages use authorized source identity separately from Bet seats.
// Public callers pass no viewer, so a private save cannot enrich a public page.
import { html } from './html.mjs';
import { ownerSave, publicSave, publicPredictionOwner, UserError } from './store.mjs';
import { face, facesFor, facesByUsername } from './certificate.mjs';
import { displaySourceUrl } from './xapi.mjs';

export async function predictionSourceHeader(db, viewer, source, simulatedOrigin) {
  if (!source?.available) return '';
  const direct = source.platform === 'x' && !source.reported_speech;
  const name = direct ? source.author_name || source.speaker : source.speaker;
  const handle = direct && source.author_username ? `@${source.author_username}` : '';
  const pictures = await facesFor(db, [source], viewer);
  const link = displaySourceUrl(source, simulatedOrigin);
  const label = source.platform === 'x' ? (simulatedOrigin ? 'On simulated X' : 'On X') : 'Source';
  return html`<div class="post source-author" data-source-author="prediction">
    <p class="visually-hidden">Source prediction by</p><div class="head">${face({ url: pictures.get(String(source.speaker_x_user_id)) || null, name })}<b>${name}</b><span>${handle}</span>${link ? html`<a class="src" href="${link}" rel="noopener noreferrer">${label}</a>` : ''}</div>
  </div>`;
}

export async function betSourceHeader(db, viewer, bet, simulatedOrigin) {
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
  if (source?.available) return predictionSourceHeader(db, viewer, source, simulatedOrigin);
  const handle = bet.creator_username || '';
  const pictures = await facesByUsername(db, [handle], viewer);
  const name = viewer?.x_username?.toLowerCase() === handle.toLowerCase() ? viewer.x_name || handle : handle;
  return html`<div class="post source-author" data-source-author="proposer">
    <div class="head">${face({ url: pictures.get(handle.toLowerCase()) || null, name })}<b>${name ? `Offered by ${name}` : 'Bet proposer'}</b><span>${handle ? `@${handle}` : ''}</span></div>
  </div>`;
}
