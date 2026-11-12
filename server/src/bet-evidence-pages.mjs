// Follows DESIGN.md: ordinary CSRF forms, the existing colour tokens, one filled action.
import { html } from './html.mjs';
import { ownerSave, publicPredictionOwner, publicSave, UserError } from './store.mjs';
import { submitEvidence } from './bet-evidence.mjs';
import { evidenceForBet } from './bet-public.mjs';
import { face, facesByUsername, facesFor } from './certificate.mjs';
import { nextBetTime } from './bet-view.mjs';

const ID = '([a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})';
const opposite = (side) => side === 'yes' ? 'no' : 'yes';

export function registerBetEvidenceRoutes({ route, db, config, layout, needPost, csrfField, send, redirect, notFound, fetchPage }) {
  async function findBet(ctx) {
    if (!ctx.user) return null;
    return db.one(`select b.*, creator.x_username as creator_username, s.statement_id, p.closes_at
      from bilateral_bets b
      join users creator on creator.id = b.creator_user_id
      left join saves s on s.id = b.source_save_id
      left join enclave_plans p on p.statement_id = s.statement_id
      where b.id = $1 and s.statement_id is not null
        and (b.creator_user_id = $2 or b.acceptor_user_id = $2)`,
    [ctx.params[0], ctx.user.id]);
  }

  async function show(ctx, bet, { error = null, url = '' } = {}) {
    const rows = bet.statement_id ? await evidenceForBet(db, bet.statement_id, bet.id, ctx.user.id) : [];
    const closes = bet.closes_at ? new Date(bet.closes_at) : new Date(new Date(bet.resolve_at).getTime() + config.play.evidenceWindowSeconds * 1000);
    const accepted = bet.acceptor_user_id && bet.accepted_at;
    const open = accepted && ['accepted', 'proposed', 'disputed'].includes(bet.status)
      && bet.statement_id && Date.now() < closes.getTime();
    const ownSide = String(bet.creator_user_id) === String(ctx.user.id) ? bet.creator_side : opposite(bet.creator_side);
    const path = `/bets/${bet.id}/evidence`;
    let source = bet.source_save_id ? await ownerSave(db, ctx.user, bet.source_save_id) : null;
    if (!source && bet.source_save_id) {
      const owner = await publicPredictionOwner(db, bet.source_save_id);
      if (owner) source = await publicSave(db, owner, bet.source_save_id);
    }
    const direct = source?.available && source.platform === 'x' && !source.reported_speech;
    const author = source?.available ? (direct ? source.author_name || source.speaker : source.speaker) : bet.creator_username || 'Bet proposer';
    const handle = source?.available ? (direct ? source.author_username : null) : bet.creator_username;
    const pictures = await facesByUsername(db, [bet.creator_username], ctx.user);
    const sourcePictures = source?.available ? await facesFor(db, [source], ctx.user) : null;
    const authorPicture = source?.available ? sourcePictures.get(String(source.speaker_x_user_id)) : pictures.get(String(bet.creator_username || '').toLowerCase());
    const items = rows.map(row => {
      const username = row.x_username;
      let link = null; let host = null; let postedHost = null;
      try {
        const parsed = new URL(row.final_url || row.url);
        if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) {
          link = parsed.href;
          host = parsed.host;
        }
        const posted = new URL(row.url);
        if (host && posted.host !== host) postedHost = posted.host;
      } catch { /* Stored links may predate validation. */ }
      return html`<li class="prow"><div>
        <p class="pwho"><b>${String(row.user_id) === String(ctx.user.id) ? 'You' : username ? `@${username}` : 'Bettor'} bet ${row.side}</b></p>
        <p class="evidence-title">${link ? html`<a class="tl" href="${link}" rel="noopener noreferrer">${row.title || host}</a>` : (row.title || row.final_url || row.url)}</p>
        <p class="meta">${host ? html`<span>${host}</span>` : ''}${postedHost ? html`<span class="quiet">posted as ${postedHost}</span>` : ''}</p>
      </div></li>`;
    });
    // DESIGN.md: one fold holds the complete saved text, below the link list.
    const savedText = rows.length ? html`<details class="fold"><summary>What the jury reads</summary>
      <ul class="posts evidence-list">${rows.map(row => html`<li class="prow"><div>
        <p class="pwho"><b>${row.title || row.final_url || row.url}</b></p>
        ${String(row.body || '').split('\n\n').map(text => html`<p>${text}</p>`)}
      </div></li>`)}</ul></details>` : '';
    const errorMessage = error?.message === 'Evidence is closed.' ? 'Links are closed.'
      : error?.message === 'Evidence is unavailable.' ? 'Links are unavailable.' : error?.message;
    const body = html`
      <h1 class="visually-hidden">Links</h1>
      <ul class="posts evidence-post"><li class="prow">${face({ url: authorPicture, name: author })}<div>
        <p class="pwho"><b>${author}</b>${handle && `@${handle}` !== author ? html`<span>@${handle}</span>` : ''}</p>
        <p class="said">${bet.claim}</p>
      </div></li></ul>
      <p class="gut quiet">The deadline ${new Date(bet.resolve_at).getTime() > Date.now() ? 'is' : 'was'} ${nextBetTime(bet.resolve_at)}. Links close ${nextBetTime(closes)}.</p>
      ${open ? html`<form method="post" action="${path}" class="evidence-form">
        ${csrfField(ctx)}
        <div class="gut">
          <label for="evidence-url">Link to a web page (not an X post)</label>
          <input id="evidence-url" name="url" type="url" value="${url}" maxlength="600" placeholder="https://"${error ? html` aria-invalid="true"` : ''} required>
        </div>
        <input type="hidden" name="side" value="${ownSide}">
        <div class="acts">${error ? html`<p class="err" role="alert">${errorMessage}</p>` : ''}<button class="primary big" type="submit">Add a link</button></div>
      </form>` : html`<div class="gut">${error ? html`<p class="err" role="alert">${errorMessage}</p>${url ? html`<p>${url}</p>` : ''}` : ''}<p class="quiet">${accepted || bet.accepted_at ? 'Links are closed.' : 'Links can be added once the bet is accepted.'}</p></div>`}
      ${items.length ? html`<ul class="posts evidence-list">${items}</ul>` : html`<p class="empty">Links from both sides appear here.</p>`}
      ${savedText}`;
    send(ctx.res, error?.status || 200, await layout(ctx, 'Links', body, { back: `/bets/${bet.id}`, extra: html`<span class="page-title">Links</span>`, kind: 'private', flush: true }), { kind: 'private' });
  }

  route('GET', new RegExp(`^/bets/${ID}/evidence$`), async (ctx) => {
    const bet = await findBet(ctx);
    if (!bet) return notFound(ctx);
    return show(ctx, bet);
  });

  route('POST', new RegExp(`^/bets/${ID}/evidence$`), async (ctx) => {
    const receivedAt = Date.now();
    const bet = await findBet(ctx);
    if (!bet) return notFound(ctx);
    const form = await needPost(ctx);
    if (!form) return;
    const url = String(form.get('url') || '');
    const side = String(bet.creator_user_id) === String(ctx.user.id) ? bet.creator_side : opposite(bet.creator_side);
    try {
      await submitEvidence(db, config, { betId: bet.id, userId: ctx.user.id, side, url, via: 'page', receivedAt, ...(fetchPage ? { fetchPage } : {}) });
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      const current = await findBet(ctx);
      if (!current) return notFound(ctx);
      return show(ctx, current, { error, url });
    }
    return redirect(ctx.res, `/bets/${bet.id}/evidence`);
  });
}
