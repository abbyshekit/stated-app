// The public way into a new Bet. A visitor picks a dated post, then a side and
// a stake, and Stated opens the reply on X with the command already typed. The
// Bet itself is made by that reply, exactly as if they had typed it under the
// post, so this page changes nothing, stores nothing and needs no sign-in.
import { html } from './html.mjs';
import { X_MARK } from './bet-view.mjs';
import { face, facesFor } from './certificate.mjs';
import { statusIdOf } from './intake.mjs';
import { inPilot, network, unit } from './near-network.mjs';
import { recentPublic } from './store.mjs';
import { effectiveTerms } from './terms.mjs';
import { isPlaceholder } from './xtext.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAKES = ['0.1', '0.25', '0.5', '1'];
const SIDES = ['yes', 'no'];
const DAY = 86400000;
const BAD_LINK = 'Paste a link to one post on X, like x.com/name/status/123.';
const HANDLE_IN_LINK = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(\w{1,15})\/status\/\d+/i;

/** The words the bot reads as an offer. `parseBetCommand` accepts exactly this shape. */
export const betCommandText = (bot, stake, side) => `@${bot} bet ${stake} ${side}`;

/** Where the reply is written: X's own composer, or the local stand-in while X is simulated. */
export function replyComposerUrl(config, bot, postId, stake, side) {
  if (config.x.simulatedOrigin) {
    return `${config.x.simulatedOrigin}/?c=${postId}&say=${encodeURIComponent(`bet ${stake} ${side}`)}`;
  }
  const intent = new URL('https://x.com/intent/tweet');
  intent.searchParams.set('in_reply_to', postId);
  intent.searchParams.set('text', betCommandText(bot, stake, side));
  return intent.toString();
}

// A post can carry a Bet from a reply when it is still open and its date is
// between ten minutes and a year away: the same window the bot enforces.
function bettable(row) {
  if (row.platform !== 'x' || !row.available || row.status !== 'open' || isPlaceholder(row)) return false;
  const due = new Date(effectiveTerms(row).deadlineAt || 0).getTime();
  return due > Date.now() + 10 * 60000 && due < Date.now() + 365 * DAY && Boolean(statusIdOf(row.source_url));
}

export function registerBetStartRoutes({ route, db, config, layout, send, redirect, botUsername, fileList, betLinesFor, publicRow, csp }) {
  // The form on this page ends at the reply composer, on another origin. Browsers apply
  // form-action to that redirect, so this page alone may send its form there.
  const composer = config.x.simulatedOrigin ? new URL(config.x.simulatedOrigin).origin : 'https://x.com';
  const policy = csp.replace("form-action 'self'", `form-action 'self' ${composer}`);
  const where = config.x.simulatedOrigin ? 'simulated X' : 'X';

  route('GET', /^\/bets\/new$/, async (ctx) => {
    const bot = config.play?.enabled ? await botUsername() : null;
    // Without bets from replies the only way to offer one is the wallet form.
    if (!/^\w{1,15}$/.test(bot || '') || (ctx.user && !inPilot(config, ctx.user.x_user_id))) return redirect(ctx.res, '/me/bets/new');

    const q = ctx.url.searchParams;
    const from = UUID.test(q.get('from') || '') ? q.get('from').toLowerCase() : null;
    const link = String(q.get('link') || '').trim().slice(0, 300);
    const side = SIDES.includes(q.get('side')) ? q.get('side') : null;
    const stake = STAKES.includes(q.get('stake')) ? q.get('stake') : null;
    const postId = statusIdOf(link);
    const go = q.get('go') === '1';

    let error = null;
    if (link && !postId) error = BAD_LINK;
    else if (go && !postId) error = BAD_LINK;
    else if (go && !side) error = 'Choose bet yes or bet no.';
    else if (go && !stake) error = `Choose a stake of up to 1 ${unit()}.`;
    else if (go) return redirect(ctx.res, replyComposerUrl(config, bot, postId, stake, side));

    // One row per statement, the way the home page lists them.
    const seen = new Map();
    for (const row of await recentPublic(db, 24)) {
      const kept = seen.get(String(row.statement_id));
      if (!kept || (kept.relation !== 'mine' && row.relation === 'mine')) seen.set(String(row.statement_id), row);
    }
    const open = [...seen.values()].filter(bettable);
    const fromQuery = from ? `&from=${from}` : '';
    const back = from ? `/bets/${from}` : '/';
    const page = (body, { status = 200, backTo = back } = {}) => layout(ctx, 'Make a bet', body, { flush: true, back: backTo, signin: false })
      .then((out) => send(ctx.res, status, out, { headers: { 'content-security-policy': policy } }));

    if (!postId) {
      // First the choice of post: the ones already on Stated, then any post by its link.
      const rows = open.slice(0, 6);
      const faces = await facesFor(db, rows, ctx.user);
      const lines = rows.length ? await betLinesFor(rows, ctx.user) : null;
      const pick = (row) => {
        const to = `/bets/new?link=${encodeURIComponent(row.source_url)}${fromQuery}`;
        return { link: to };
      };
      return page(html`
        <h1 class="visually-hidden">Make a bet</h1>
        <p class="lead">Pick a post to bet on</p>
        ${rows.length ? fileList(rows, pick, faces, lines) : ''}
        <form method="get" action="/bets/new">
          ${from ? html`<input type="hidden" name="from" value="${from}">` : ''}
          <div class="gut">
            <label for="bet-link">${rows.length ? `Or paste a link to a post on ${where}` : `Paste its link from ${where}`}</label>
            <input type="url" id="bet-link" name="link" value="${link}" required maxlength="300" autocomplete="off" inputmode="url" placeholder="https://x.com/name/status/123">
          </div>
          ${error ? html`<p class="err" role="alert">${error}</p>` : ''}
          <div class="acts paste"><button class="${rows.length ? 'big' : 'primary big'}" type="submit">Use this post</button></div>
        </form>
      `, { status: error ? 400 : 200 });
    }

    // Then the bet on it. Nothing is chosen for the visitor except the smallest stake.
    const picked = open.find((row) => statusIdOf(row.source_url) === postId) || null;
    const faces = picked ? await facesFor(db, [picked], ctx.user) : null;
    const stakeNow = stake || (STAKES.includes(config.play.defaultStakeNear) ? config.play.defaultStakeNear : STAKES[0]);
    const postUrl = config.x.simulatedOrigin ? `${config.x.simulatedOrigin}/?c=${postId}` : `https://x.com/i/web/status/${postId}`;
    // The reply is drawn the way X will show it. CSS fills in the side and stake from the
    // two choices below, so the visitor sees the exact words before the composer opens.
    const author = picked?.author_username || (link.match(HANDLE_IN_LINK)?.[1] !== 'i' ? link.match(HANDLE_IN_LINK)?.[1] : null);
    return page(html`
      <h1 class="visually-hidden">Make a bet</h1>
      <form method="get" action="/bets/new">
        <input type="hidden" name="go" value="1">
        ${from ? html`<input type="hidden" name="from" value="${from}">` : ''}
        <input type="hidden" name="link" value="${link}">
        ${picked ? fileList([picked], publicRow, faces)
    : html`<p class="gut">Stated has not read this post. Check its date before you reply. <a class="tl unread" href="${postUrl}" rel="noopener noreferrer">${link.replace(/^https?:\/\//i, '').replace(/[?#].*$/, '')}</a></p>`}
        <ul class="posts"><li class="prow">${face({ url: ctx.user?.x_avatar_url || null, name: ctx.user?.x_username || 'You' })}<div>
          <p class="pwho"><b>You</b>${ctx.user?.x_username ? html`<span>@${ctx.user.x_username}</span>` : ''}</p>
          <p class="meta"><span>Replying to ${author ? `@${author}` : 'that post'}</span></p>
          <p class="said cmd"><b>@${bot}</b> bet ${STAKES.map((value, i) => html`<i class="k${i}">${value}</i>`)} <i class="yes">yes</i><i class="no">no</i><i class="unset">yes or no</i></p>
        </div></li></ul>
        <div class="seg quiet" role="radiogroup" aria-label="Your side">
          ${SIDES.map((value) => html`<input type="radio" id="side-${value}" name="side" value="${value}" required${value === side ? ' checked' : ''}><label for="side-${value}">Bet ${value}</label>`)}
        </div>
        <div class="seg quiet" role="radiogroup" aria-label="Stake each, in ${unit()}">
          ${STAKES.map((value, i) => html`<input type="radio" id="stake-${i}" name="stake" value="${value}"${value === stakeNow ? ' checked' : ''}><label for="stake-${i}">${value}</label>`)}
        </div>
        <p class="stakes">Amounts are ${unit()} each. No wallet needed.</p>
        ${error ? html`<p class="err" role="alert">${error}</p>` : ''}
        <div class="acts"><button class="primary big send" type="submit"><span class="need">Choose yes or no</span><span class="go">${X_MARK}Reply ${config.x.simulatedOrigin ? 'in simulated X' : 'on X'}</span></button></div>
      </form>
    `, { status: error ? 400 : 200, backTo: `/bets/new${from ? `?from=${from}` : ''}` });
  });
}
