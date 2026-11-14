// The public way into a new Bet. A visitor picks a post, then a side, stake and
// any missing date, and Stated opens the reply on X with the command already typed. The
// Bet itself is made by that reply, exactly as if they had typed it under the
// post, so this page changes nothing, stores nothing and needs no sign-in.
import { html } from './html.mjs';
import { nextOpenPublicBet } from './bet-public.mjs';
import { X_MARK } from './bet-view.mjs';
import { face, facesFor } from './certificate.mjs';
import { statusIdOf } from './intake.mjs';
import { dayMonth } from './marked.mjs';
import { inPilot, network, unit } from './near-network.mjs';
import { aboveLimit, limitFor, limitHint, limitReply, recordFor, stakeCap, stakeCapReply } from './reputation.mjs';
import { recentPublic } from './store.mjs';
import { effectiveTerms } from './terms.mjs';
import { isPlaceholder, oembedText } from './xtext.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const STAKES = ['0.1', '0.25', '0.5', '1'];
const SIDES = ['yes', 'no'];
const DAY = 86400000;
const BAD_LINK = 'Paste a link to one post on X, like x.com/name/status/123.';
const HANDLE_IN_LINK = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(\w{1,15})\/status\/\d+/i;

/** The words the bot reads as an offer. `parseBetCommand` accepts exactly this shape. */
export const betCommandText = (bot, stake, side, date = null) => `@${bot} bet ${stake} ${side}${date ? ` by ${dayMonth(date, { year: true })}` : ''}`;

/** Where the reply is written: X's own composer, or the local stand-in while X is simulated. */
export function replyComposerUrl(config, bot, postId, stake, side, date = null) {
  if (config.x.simulatedOrigin) {
    return `${config.x.simulatedOrigin}/?c=${postId}&say=${encodeURIComponent(betCommandText(bot, stake, side, date).replace(/^@\w+ /, ''))}`;
  }
  const intent = new URL('https://x.com/intent/tweet');
  intent.searchParams.set('in_reply_to', postId);
  intent.searchParams.set('text', betCommandText(bot, stake, side, date));
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
    const q = ctx.url.searchParams;
    if (config.near?.real && !q.get('link') && q.get('go') !== '1') return redirect(ctx.res, '/me/bets/new');
    const bot = config.play?.enabled ? await botUsername() : null;
    // Without bets from replies the only way to offer one is the wallet form.
    if (!/^\w{1,15}$/.test(bot || '') || (ctx.user && !inPilot(config, ctx.user.x_user_id))) return redirect(ctx.res, '/me/bets/new');

    const cap = stakeCap(config);
    const stakes = config.near?.real ? [...new Set([...STAKES.filter((value) => !aboveLimit(value, cap)), cap])] : STAKES;
    const from = UUID.test(q.get('from') || '') ? q.get('from').toLowerCase() : null;
    const link = String(q.get('link') || '').trim().slice(0, 300);
    const side = SIDES.includes(q.get('side')) ? q.get('side') : null;
    const stake = stakes.includes(q.get('stake')) ? q.get('stake') : null;
    const date = String(q.get('date') || '').trim().slice(0, 40);
    const datePreset = ['week', 'month', 'year', 'custom'].includes(q.get('datePreset')) ? q.get('datePreset') : null;
    const postId = statusIdOf(link);
    const go = q.get('go') === '1';
    const record = ctx.user && postId && config.play.reputationTiers !== null ? await recordFor(db, ctx.user.id) : null;
    const limit = record ? limitFor(config, record) : config.near?.real ? cap : null;
    const hint = record ? limitHint(config, record) : config.near?.real ? stakeCapReply(config) : null;
    // Look beyond the recent public list: a pasted post may already have a
    // date, even when its saves are private. Only date presence is used here.
    const held = postId ? await db.one(`select coalesce(st.deadline_at, st.proposed_deadline_at) as deadline
      from sources src join statements st on st.source_id = src.id
      where src.platform = 'x' and src.platform_id = $1 order by st.id limit 1`, [postId]) : null;
    const needsDate = Boolean(postId && !held?.deadline);
    const now = Date.now();
    const minDate = new Date(now + DAY).toISOString().slice(0, 10);
    // Commands settle at the end of the chosen UTC day. Keep that whole day
    // within the worker's 365-day limit.
    const maxDate = new Date(now + 364 * DAY).toISOString().slice(0, 10);
    const addCalendarMonth = (base) => {
      const d = new Date(base);
      const day = d.getUTCDate();
      d.setUTCDate(1);
      d.setUTCMonth(d.getUTCMonth() + 1);
      d.setUTCDate(Math.min(day, new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 0)).getUTCDate()));
      return d;
    };
    const dateNow = new Date(now);
    const yearEnd = new Date(Date.UTC(dateNow.getUTCFullYear(), 11, 31, 23, 59, 59));
    if (yearEnd.getTime() < now) yearEnd.setUTCFullYear(yearEnd.getUTCFullYear() + 1);
    const yearUnavailable = yearEnd.getTime() < now + 10 * 60000 || yearEnd.getTime() > now + 365 * DAY;
    const dateFor = (preset) => {
      const base = new Date(dateNow);
      if (preset === 'week') base.setUTCDate(base.getUTCDate() + 7);
      else if (preset === 'month') return addCalendarMonth(base);
      else if (preset === 'year') return yearEnd;
      else return null;
      return base;
    };
    const effectivePreset = datePreset || (date ? 'custom' : 'month');
    const presetDate = effectivePreset !== 'custom' ? dateFor(effectivePreset) : null;
    const chosenDate = presetDate ? presetDate.toISOString().slice(0, 10) : date;
    const pickedDate = /^\d{4}-\d{2}-\d{2}$/.test(chosenDate) ? new Date(`${chosenDate}T00:00:00Z`) : null;
    const validDate = pickedDate && Number.isFinite(pickedDate.getTime()) && pickedDate.toISOString().slice(0, 10) === chosenDate;
    const dateParts = /^(\d{4})-(\d{2})-(\d{2})$/.exec(chosenDate);
    const dateMonth = dateParts ? Number(dateParts[2]) : 0;
    const dateDay = dateParts ? Number(dateParts[3]) : 0;
    const impossibleDate = Boolean(dateParts && !validDate);
    const impossibleDateLabel = impossibleDate
      ? `${dateMonth >= 1 && dateMonth <= 12 ? `${dateDay} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][dateMonth - 1]} ${dateParts[1]}` : chosenDate} is not a date.`
      : null;

    let error = null;
    if (link && !postId) error = BAD_LINK;
    else if (go && !postId) error = BAD_LINK;
    else if (go && !side) error = 'Choose bet yes or bet no.';
    else if (go && !stake) error = `Choose a stake of up to ${cap} ${unit()}.`;
    else if (go && limit && aboveLimit(stake, limit)) error = limitReply(config, limit);
    else if (go && needsDate && impossibleDate) error = impossibleDateLabel;
    else if (go && needsDate && (!validDate || (effectivePreset === 'year' ? yearUnavailable : chosenDate < minDate || chosenDate > maxDate))) error = 'Choose a date from tomorrow to a year away.';
    else if (go) return redirect(ctx.res, replyComposerUrl(config, bot, postId, stake, side, needsDate ? chosenDate : null));

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
      // A funded offer with an empty seat is the quickest bet there is, so the page points at one.
      const openBet = await nextOpenPublicBet(db, ctx.user?.id);
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
        ${openBet?.creator_username ? html`<div class="acts"><div class="two"><a class="tl" href="/bets/${openBet.id}">Or take @${openBet.creator_username}’s open bet</a></div></div>` : ''}
      `, { status: error ? 400 : 200 });
    }

    // Then the bet on it. The default stake and one-month date leave the side to the visitor.
    const picked = open.find((row) => statusIdOf(row.source_url) === postId) || null;
    const faces = picked ? await facesFor(db, [picked], ctx.user) : null;
    const allowed = stakes.filter((value) => !limit || !aboveLimit(value, limit));
    const stakeNow = stake || (allowed.includes(config.play.defaultStakeNear) ? config.play.defaultStakeNear : allowed[0]);
    const postUrl = config.x.simulatedOrigin ? `${config.x.simulatedOrigin}/?c=${postId}` : `https://x.com/i/web/status/${postId}`;
    // The reply is drawn the way X will show it. CSS fills in the side and stake from the
    // two choices below, so the visitor sees the exact words before the composer opens.
    const author = picked?.author_username || (link.match(HANDLE_IN_LINK)?.[1] !== 'i' ? link.match(HANDLE_IN_LINK)?.[1] : null);
    let fetchedHandle = null;
    const oembed = !picked ? await oembedText(config, postId, postUrl, async (url) => {
      const response = await fetch(url, { signal: AbortSignal.timeout(2000) });
      return { ok: response.ok, json: async () => {
        const json = await response.json();
        fetchedHandle = String(json.author_url || '').match(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\/(\w{1,15})\/?$/i)?.[1] || null;
        return json;
      } };
    }) : null;
    // Retain the public handle with the shared parsed oEmbed cache for later previews.
    if (oembed && fetchedHandle) oembed.username = fetchedHandle;
    const postAuthor = picked?.author_name || oembed?.author || author || 'Post author';
    const postHandle = picked?.author_username || oembed?.username || author;
    // DESIGN.md: the date stays whole inside the drawn reply.
    const replyDate = value => dayMonth(value, { year: true }).replaceAll(' ', '\u00a0');
    const previewDate = needsDate ? html`
      <i class="date-week"> by ${replyDate(dateFor('week'))}</i>
      <i class="date-month"> by ${replyDate(dateFor('month'))}</i>
      ${!yearUnavailable ? html`<i class="date-year"> by ${replyDate(yearEnd)}</i>` : ''}
      <i class="date-custom">${validDate && effectivePreset === 'custom' ? html` by ${replyDate(pickedDate)}` : ' by the date you pick'}</i>` : '';
    return page(html`
      <h1 class="visually-hidden">Make a bet</h1>
      <form method="get" action="/bets/new" novalidate>
        <input type="hidden" name="go" value="1">
        ${from ? html`<input type="hidden" name="from" value="${from}">` : ''}
        <input type="hidden" name="link" value="${link}">
        ${needsDate ? html`<p class="lead">Bet on this post</p>` : ''}
        ${picked ? fileList([picked], publicRow, faces)
    : oembed ? html`<ul class="posts"><li class="prow">${face({ url: null, name: postAuthor || postHandle || 'Post author' })}<div><p class="pwho"><b>${postAuthor || postHandle}</b>${postHandle ? html`<span>@${postHandle}</span>` : ''}</p><p class="said">${oembed.text}</p></div></li></ul>`
    : html`<p class="gut">${needsDate ? '' : 'This post already has a date on Stated.'} <a class="tl unread" href="${postUrl}" rel="noopener noreferrer">${link.replace(/^https?:\/\//i, '').replace(/[?#].*$/, '')}</a></p>`}
        <ul class="posts"><li class="prow">${face({ url: ctx.user?.x_avatar_url || null, name: ctx.user?.x_username || 'You' })}<div>
          <p class="pwho"><b>You</b>${ctx.user?.x_username ? html`<span>@${ctx.user.x_username}</span>` : ''}</p>
          <p class="meta"><span>Replying to ${postHandle ? `@${postHandle}` : 'that post'}</span></p>
          <p class="said cmd"><b>@${bot}</b> bet ${stakes.map((value, i) => html`<i class="k${i}">${value}</i>`)} <i class="yes">yes</i><i class="no">no</i><i class="unset">yes or no</i>${needsDate ? previewDate : ''}</p>
        </div></li></ul>
        <p class="meta stake-label">Your side</p>
        <div class="seg side-choice" role="radiogroup" aria-label="Your side">
          ${SIDES.map((value) => html`<input type="radio" id="side-${value}" name="side" value="${value}" required${value === side ? ' checked' : ''}><label for="side-${value}">Bet ${value}</label>`)}
        </div>
        <p class="meta stake-label">Stake each, in ${unit()}</p>
        <div class="seg side-choice" role="radiogroup" aria-label="Stake each, in ${unit()}">
          ${stakes.map((value, i) => html`<input type="radio" id="stake-${i}" name="stake" value="${value}"${value === stakeNow ? ' checked' : ''}${limit && aboveLimit(value, limit) ? html` disabled aria-disabled="true"` : ''}><label for="stake-${i}"${limit && aboveLimit(value, limit) ? html` aria-disabled="true"` : ''}>${value}</label>`)}
        </div>
        ${hint ? html`<p class="gut quiet">${hint}</p>` : ''}
        ${needsDate ? html`<p class="meta stake-label" id="deadline-label">Deadline, 23:59 UTC</p><div class="seg side-choice date-presets" role="radiogroup" aria-labelledby="deadline-label">
          ${[['week', '1 week'], ['month', '1 month'], ...(!yearUnavailable ? [['year', '31 Dec']] : []), ['custom', 'Other']].map(([value, label]) => html`<input type="radio" id="date-${value}" name="datePreset" value="${value}"${effectivePreset === value ? ' checked' : ''}><label for="date-${value}">${label}</label>`)}
        </div><div class="gut custom-date">
          <input type="${effectivePreset === 'custom' && date && !validDate ? 'text' : 'date'}" id="bet-date" name="date" value="${date}" min="${minDate}" max="${maxDate}" aria-labelledby="deadline-label"${effectivePreset === 'custom' && date && !validDate ? html` placeholder="YYYY-MM-DD"` : ''}${error && effectivePreset === 'custom' && (!validDate || chosenDate < minDate || chosenDate > maxDate) ? html` aria-invalid="true"` : ''}>
        </div>` : ''}
        ${error ? html`<p class="err" role="alert">${error}</p>` : ''}
        <div class="acts"><button class="primary big send" type="submit"><span class="need">Choose yes or no</span><span class="go">${X_MARK}Reply ${config.x.simulatedOrigin ? 'in simulated X' : 'on X'}</span></button></div>
      </form>
    `, { status: error ? 400 : 200, backTo: `/bets/new${from ? `?from=${from}` : ''}` });
  });
}
