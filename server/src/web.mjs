import { createHash, createHmac } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { baselineScore } from '../../score.mjs';
import { editorialIntake, personIntake, selectCandidates } from './articles.mjs';
import { nearChain } from './play.mjs';
import { registerPlayRoutes } from './play-pages.mjs';
import { enclaveRecipe, registerBetRoutes } from './bet-pages.mjs';
import { createPublicRulingReader } from './public-ruling.mjs';
import { registerBetStartRoutes } from './bet-start.mjs';
import { registerBetRulingRoutes, rulingPost } from './bet-ruling-pages.mjs';
import { registerCourtRoutes } from './court-pages.mjs';
import { registerBetEvidenceRoutes } from './bet-evidence-pages.mjs';

// One policy for every page. A page that must hand a form to another origin widens form-action for itself only.
const CONTENT_SECURITY_POLICY = "default-src 'self'; style-src 'self'; img-src 'self' data: https://pbs.twimg.com; form-action 'self'; frame-ancestors 'none'; base-uri 'none'";
// No page uses these; a third-party frame or injected script cannot ask for them either.
const PERMISSIONS_POLICY = 'camera=(), microphone=(), geolocation=(), payment=(), usb=(), serial=(), bluetooth=(), interest-cohort=()';
import { registerWalletRpc } from './near-wallet-rpc.mjs';
import { registerShareRoutes } from './share-pages.mjs';
import { betsFor } from './bets.mjs';
import { publicBet, publicBetsForProfile, publicBetsForSave, firstPublicBetsForSaves, nextOpenPublicBet, publicBetHall } from './bet-public.mjs';
import { betList, betBlock as detailBetBlock } from './bet-view.mjs';
import { betBlock, betLead, betState, dayMonth, timeLeft } from './marked.mjs';
import { betSourceHeader } from './bet-source-view.mjs';
import { postLogo, postTime, xPostUrl } from './x-post-view.mjs';
import { rulingOnEvidence, settlementMarkup, settlementSentence } from './settlement-view.mjs';
import { formatTestNear } from './near-escrow.mjs';
import { network, unit } from './near-network.mjs';
import { assertNetworkConfig } from './config.mjs';
import { logoFile } from './token-logos.mjs';
import { intentsQuotes } from './intents.mjs';
import { pkcePair, sameString, token } from './crypto.mjs';
import { createSession, sessionFor } from './session-tokens.mjs';
import { collectionPage, exportPage, publicRecord } from './bounded-exports.mjs';
import { createReadLimiter } from './public-read-limits.mjs';
import { esc, html, pct, raw, signed, when } from './html.mjs';
import { face, facesByUsername, facesFor } from './certificate.mjs';
import { kvGet } from './db.mjs';
import { metrics, outsideBetsTaken } from './metrics.mjs';
import { purgeOrphanXSources, resolveStatement } from './notify.mjs';
import { canViewProfile, ownerSaveView, profileIsPublic, PUBLIC_SAVE_SQL, publicSaveView } from './privacy.mjs';
import { privacyPage, termsPage } from './legal-pages.mjs';
import {
  annotate,
  publicSaveOwner,
  completeSetup,
  confirmTerms,
  decideCorrection,
  ensureDesk,
  inboxFor,
  markInboxDone,
  openCorrections,
  ownerCollections,
  ownerSave,
  personByUsername,
  publicFollowerCount,
  publicSave,
  recentPublic,
  recordOf,
  removeSave,
  requestCorrection,
  reviewerSetTerms,
  revisionsFor,
  searchPublic,
  setProfileVisibility,
  setSaveVisibility,
  setWatch,
  signInFromX,
  UserError,
  userById,
} from './store.mjs';
import { cameTrueLate, effectiveTerms, isBackfill, outcomeFor, publishedInTime, scoringProbability } from './terms.mjs';
import { authorizeUrl, botClient, displaySourceUrl, exchangeCode, getMe, saveBotCredentials, SIGNIN_SCOPES } from './xapi.mjs';
import { isPlaceholder, postWords, syncXText } from './xtext.mjs';

// Status banners come from this list only, so a link cannot put arbitrary
// words on a shareable page.
const FLASH = {
  saved: () => 'Saved.',
  public: () => 'Now public on your profile.',
  private: () => 'Now private.',
  terms: () => 'Terms saved. The earlier version is in the history.',
  removed: () => 'Removed from your profile.',
  review: () => 'Sent to review. The history shows the decision.',
  withdrawn: () => 'Your profile is private. Its public pages are withdrawn.',
  settings: () => 'Settings saved.',
  published: (n) => `Your profile is public with ${n} published.`,
  following: (n) => `Following ${n} ${n === 1 ? 'prediction' : 'predictions'}.`,
  xsaved: () => 'Saved privately. The post was read through X, not fetched as a web page.',
  captured: () => 'Saved from your reply on X.',
};

function flashOf(url) {
  const make = FLASH[url.searchParams.get('done')];
  if (!make) return null;
  const n = Math.max(0, Math.min(1000, Number.parseInt(url.searchParams.get('n') || '0', 10) || 0));
  return make(n);
}

const BOT_UA = /bot|crawl|spider|slurp|preview|facebookexternalhit|embedly|curl|wget|python|node-fetch|undici/i;

const CSS = readFileSync(new URL('../public/stated.css', import.meta.url), 'utf8');
const CSS_VERSION = createHash('sha256').update(CSS).digest('hex').slice(0, 10);
// The certificate look: a second sheet loaded after the first, and two self-hosted faces.
const CERT_CSS = readFileSync(new URL('../public/certificate.css', import.meta.url), 'utf8');
const CERT_CSS_VERSION = createHash('sha256').update(CERT_CSS).digest('hex').slice(0, 10);
const LIVE_CSS = readFileSync(new URL('../public/certificate-live.css', import.meta.url), 'utf8');
const LIVE_CSS_VERSION = createHash('sha256').update(LIVE_CSS).digest('hex').slice(0, 10);
// The skin: chrome, lists, forms and the private side, loaded last.
const SKIN_CSS = readFileSync(new URL('../public/skin.css', import.meta.url), 'utf8');
const SKIN_CSS_VERSION = createHash('sha256').update(SKIN_CSS).digest('hex').slice(0, 10);
const FAVICON = readFileSync(new URL('../public/favicon.svg', import.meta.url));
const WALLET_JS = readFileSync(new URL('../public/wallet.js', import.meta.url));
const WALLET_VERSION = createHash('sha256').update(WALLET_JS).digest('hex').slice(0, 10);
// The copy buttons on the payment page.
const PAY_JS = readFileSync(new URL('../public/pay.js', import.meta.url));
const PAY_VERSION = createHash('sha256').update(PAY_JS).digest('hex').slice(0, 10);
const FONTS = new Map(['Archivo-latin.woff2', 'Inter-latin.woff2', 'ibm-plex-mono-latin-400-normal.woff2']
  .map((name) => [name, readFileSync(new URL(`../public/fonts/${name}`, import.meta.url))]));
const X_MARK = raw('<svg class="xmark" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M18.9 2H22l-7.5 8.6L23 22h-6.9l-5.4-7-6.2 7H1.4l8-9.2L1 2h7l4.9 6.4L18.9 2Zm-1.2 18h1.9L7.4 3.9H5.4L17.7 20Z"/></svg>');
const REFS = new Set(['reply', 'profile']);

function returnPath(value, fallback = '/me') {
  return value && /^\/(?![/\\])[^\\\s]*$/.test(value) ? value : fallback;
}

function cookies(req) {
  const out = {};
  for (const part of String(req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

function cookie(name, value, { maxAge, secure }) {
  return [
    `${name}=${encodeURIComponent(value)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    maxAge != null ? `Max-Age=${maxAge}` : '',
    secure ? 'Secure' : '',
  ].filter(Boolean).join('; ');
}

async function readForm(req, limit = 100_000) {
  const chunks = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > limit) throw new UserError('That form is too large.', 413);
    chunks.push(chunk);
  }
  const params = new URLSearchParams(Buffer.concat(chunks).toString('utf8'));
  return {
    get: (key) => params.get(key) ?? '',
    all: (key) => params.getAll(key),
  };
}

function headersFor(kind) {
  const base = {
    'content-security-policy': CONTENT_SECURITY_POLICY,
    'x-content-type-options': 'nosniff',
    'referrer-policy': 'strict-origin-when-cross-origin',
  };
  if (kind === 'private') {
    base['cache-control'] = 'no-store';
    base['x-robots-tag'] = 'noindex, nofollow';
  } else {
    // Public pages are revalidated on every view, so withdrawing a record is
    // not delayed by a shared cache.
    base['cache-control'] = 'no-cache';
  }
  return base;
}

// A date of today is the moment it is recorded, so a save earlier today is
// still before the outcome. A past date covers that whole day. A future date
// is left for the recorder to reject.
function knownInstant(value) {
  const text = String(value || '').trim();
  if (!text) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(text)) {
    const now = new Date();
    if (text === now.toISOString().slice(0, 10)) return now;
    return new Date(`${text}T23:59:59.999Z`);
  }
  return new Date(text);
}

export function createApp({ db, config, fetchImpl = fetch, chain = null, intents = null }) {
  // Cross-chain quotes for a stake, when they are turned on. A test passes its own.
  // A mainnet configuration that was not asked for in so many words never becomes an app.
  assertNetworkConfig(config);
  const quotes = intents || (config.intents?.enabled || config.intents?.deposits ? intentsQuotes() : null);
  const sourceHref = (row, original) => displaySourceUrl(row, config.x.simulatedOrigin, original);
  const xLabel = () => config.x.simulatedOrigin ? 'simulated X' : 'X';
  // The signer for accounts this server holds keys for, made on first use so a server without them never builds one.
  let playChain = chain;
  const chainFor = () => (playChain ||= nearChain({ fetchImpl }));
  let botName = null;
  let xClient = null;
  const readBudget = createReadLimiter({ railway: config.hosted && Boolean(process.env.RAILWAY_ENVIRONMENT) });
  const publicRuling = createPublicRulingReader({ recipe: enclaveRecipe });
  const readPublicRuling = async (tx, id) => (await publicRuling(tx, id))?.record || null;

  function allowHeavyRead(ctx) {
    const budget = readBudget(ctx.req);
    if (budget.allowed) return true;
    send(ctx.res, 429, JSON.stringify({ error: 'Too many downloads. Retry after the indicated delay.' }), {
      kind: 'private', headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': String(budget.retryAfter) },
    });
    return false;
  }

  // The bot's X client, when a bot is connected; null otherwise.
  async function botX() {
    const row = await db.one('select 1 as ok from bot_credentials where id = 1');
    if (!row) return null;
    if (!xClient) xClient = botClient(db, config, fetchImpl);
    return xClient;
  }

  // Drops the stored words of posts that stopped being public. Words for
  // newly public posts are read by the worker, in batches, never inside a
  // web request.
  async function sync(statementIds) {
    if (!statementIds.length) return;
    await syncXText(db, config, { statementIds });
  }

  async function botUsername() {
    if (botName) return botName;
    const row = await db.one('select x_username from bot_credentials where id = 1');
    botName = row?.x_username || process.env.STATED_BOT_USERNAME || 'statedforecast';
    return botName;
  }

  async function viewerOf(req) {
    const sid = cookies(req).stated_sid;
    if (!sid) return { user: null, session: null };
    const session = await sessionFor(db, sid);
    if (!session) return { user: null, session: null };
    const user = await userById(db, session.user_id);
    return { user, session };
  }

  function isAdmin(user) {
    return Boolean(user && config.adminXIds.includes(user.x_user_id));
  }

  function send(res, status, body, { kind = 'public', headers = {} } = {}) {
    res.writeHead(status, { 'content-type': 'text/html; charset=utf-8', ...headersFor(kind), ...headers });
    res.end(String(body));
  }

  function json(res, status, data, kind = 'public') {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', ...headersFor(kind) });
    res.end(JSON.stringify(data));
  }

  function redirect(res, location, headers = {}) {
    res.writeHead(303, { location, 'cache-control': 'no-store', ...headers });
    res.end();
  }

  function csrfField(ctx) {
    return ctx.session ? html`<input type="hidden" name="csrf" value="${ctx.session.csrf}">` : '';
  }

  // `flush` pages lay out their own edges (lists and posts run the full width
  // of the column); every other page gets the column's side padding. `back`
  // swaps the wordmark for a way back; `extra` sits beside the viewer's face.
  async function layout(ctx, title, body, { og = null, kind = 'public', flush = false, back = null, extra = null, signin: headerSignin = true, inboxBadge = true, two = false } = {}) {
    const user = ctx.user;
    const path = ctx.url.pathname;
    // DESIGN.md: the public Bet keeps the wordmark; its ruling has a back arrow.
    if (kind === 'public' && /^\/bets\/[a-f\d-]{36}$/i.test(path)) {
      back = null;
    }
    const current = (p) => (path === p || (p !== '/' && path.startsWith(`${p}/`)) ? raw('aria-current="page"') : '');
    // Four sections. Predictions owns /me, a save and tracking; Bets owns both bet paths.
    const section = /^\/me\/bets|^\/bets\//.test(path) ? 'bets'
      : path.startsWith('/me/inbox') ? 'inbox'
      : path.startsWith('/me/settings') ? 'settings'
      : (path === '/me' || path.startsWith('/me/')) ? 'predictions' : '';
    const here = (name) => (section === name ? raw('aria-current="page"') : '');
    const waiting = user && inboxBadge ? Number((await db.one('select count(*)::int as n from inbox where owner_x_user_id = $1 and done_at is null', [user.x_user_id])).n) : 0;
    const signin = `/signin${path === '/' || path.startsWith('/signin') ? '' : `?return=${encodeURIComponent(path + ctx.url.search)}`}`;
    const ogTags = og && kind === 'public' ? html`
      <meta property="og:title" content="${og.title}">
      <meta property="og:description" content="${og.description}">
      <meta property="og:type" content="website">
      <meta property="og:url" content="${config.baseUrl}${path}">
      ${og.image ? html`<meta property="og:image" content="${config.baseUrl}${og.image}">
      <meta property="og:image:width" content="1200"><meta property="og:image:height" content="630">
      <meta name="twitter:image" content="${config.baseUrl}${og.image}">` : ''}
      <meta name="twitter:card" content="${og.image ? 'summary_large_image' : 'summary'}">
      <meta name="twitter:title" content="${og.title}">
      <meta name="twitter:description" content="${og.description}">` : '';
    return html`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>${title} · Stated</title>
  <meta name="description" content="${og?.description || 'Bet on what is said on X. Three AI models in NEAR AI enclaves decide the result.'}">
  ${kind === 'private' ? raw('<meta name="robots" content="noindex, nofollow">') : ''}
  ${ogTags}
  <link rel="icon" type="image/svg+xml" href="/static/favicon.svg">
  <link rel="stylesheet" href="/static/stated.css?v=${CSS_VERSION}">
  <link rel="stylesheet" href="/static/skin.css?v=${SKIN_CSS_VERSION}">
</head>
<body>
  <a class="skip" href="#content">Skip to content</a>
  <div class="wrap${two ? ' two' : ''}">
    <header>
      ${back ? html`<a class="back" href="${back}" aria-label="Back">←</a>` : html`<a class="wordmark" href="/">Stated</a>`}
      <span class="grow"></span>
      ${extra || ''}
      ${user ? html`
      <details class="me">
        <summary aria-label="Menu for @${user.x_username}${waiting ? `, ${waiting} in your inbox` : ''}">${face({ url: user.x_avatar_url, name: user.x_username, size: 'xs' })}${waiting ? raw('<i class="dot" aria-hidden="true"></i>') : ''}</summary>
        <nav aria-label="Main">
          <span class="handle">@${user.x_username}</span>
          <a href="/me" ${here('predictions')}>Predictions</a>
          <a href="/me/bets" ${here('bets')}>Bets</a>
          <a href="/me/inbox" ${here('inbox')}>Inbox${waiting ? html`<span class="n">${waiting}</span>` : ''}</a>
          ${config.play?.enabled ? html`<a href="/me/wallet" ${current('/me/wallet')}>Wallet</a>` : ''}
          <a href="/me/settings" ${here('settings')}>Settings</a>
          <div class="sub">
            ${profileIsPublic(user) ? html`<a href="/u/${user.x_username}" ${current(`/u/${user.x_username}`)}>Public profile</a>` : ''}
            <a href="/search" ${current('/search')}>Search</a>
            <a href="/desk" ${current('/desk')}>Desk</a>
            ${isAdmin(user) ? html`<a href="/admin" ${current('/admin')}>Admin</a>` : ''}
          </div>
          <form method="post" action="/signout">${csrfField(ctx)}<button class="link" type="submit">Sign out</button></form>
        </nav>
      </details>` : (!headerSignin || path.startsWith('/signin') ? '' : html`<a class="pill" href="${signin}">${X_MARK}Sign in</a>`)}
    </header>
    <main id="content"${flush ? '' : raw(' class="pad"')}>${body}</main>
    <footer>
      <nav aria-label="More"><a href="/search">Search</a>${isAdmin(user) ? html`<a href="/desk">Desk</a>` : ''}<a href="/terms">Terms</a><a href="/privacy">Privacy</a></nav>
    </footer>
  </div>
</body>
</html>`;
  }

  async function notFound(ctx) {
    send(ctx.res, 404, await layout(ctx, 'Not found', html`
      <h1>Nothing public here</h1>
      <p>This page does not exist, or its owner keeps it private.</p>
      <p><a href="/">Go to Stated</a></p>`), { kind: 'private' });
  }

  // Visits are counted by a first-party cookie, never by address or user
  // agent. A public page gives a new browser a random visitor cookie; the
  // visit is counted when that browser loads the page's stylesheet with the
  // cookie (see the stylesheet route), once per visitor, page and referral a
  // day. A client that keeps no cookies, as most scripts and crawlers do, is
  // never counted, however it varies its user agent.
  function signVisitor(raw) {
    const sig = createHmac('sha256', config.tokenKey || 'stated').update(raw).digest('base64url');
    return `${raw}.${sig}`;
  }

  function verifyVisitor(value) {
    const text = String(value || '');
    const i = text.lastIndexOf('.');
    if (i < 8) return '';
    const raw = text.slice(0, i);
    const sig = text.slice(i + 1);
    const expect = createHmac('sha256', config.tokenKey || 'stated').update(raw).digest('base64url');
    return sameString(sig, expect) ? raw : '';
  }

  function ensureVisitor(ctx) {
    if (verifyVisitor(cookies(ctx.req).stated_vid)) return;
    ctx.visitorCookie = cookie('stated_vid', signVisitor(token(16)), { maxAge: 365 * 86400, secure: config.secureCookies });
  }

  const COUNTED = /^\/(?:$|u\/\w{1,40}(?:\/\d{1,18})?$|desk(?:\/\d{1,18})?$|bets\/[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$)/;

  async function countVisit(ctx) {
    const vid = verifyVisitor(cookies(ctx.req).stated_vid);
    const ua = String(ctx.req.headers['user-agent'] || '');
    if (!vid || !ua || BOT_UA.test(ua)) return;
    let page;
    try {
      page = new URL(String(ctx.req.headers.referer || ''));
    } catch {
      return;
    }
    if (page.origin !== new URL(config.baseUrl).origin || !COUNTED.test(page.pathname)) return;
    const r = page.searchParams.get('r');
    const ref = REFS.has(r) ? r : null;
    const visitor = createHash('sha256').update(`stated-visit:${vid}`).digest('hex').slice(0, 32);
    await db.query(
      `insert into visits (path, ref, viewer_user_id, visitor)
       select $1, $2, $3, $4 where not exists (
         select 1 from visits where visitor = $4 and path = $1 and coalesce(ref, '') = coalesce($2, '')
           and at > now() - interval '1 day')`,
      [page.pathname, ref, ctx.user?.id || null, visitor],
    );
    if (ref) {
      await db.query(
        `insert into visitor_refs (visitor, ref) values ($1, $2)
         on conflict (visitor) do update set ref = excluded.ref, at = now()`,
        [visitor, ref],
      );
    }
  }

  function refCookie(ctx) {
    const out = [];
    if (ctx.visitorCookie) out.push(ctx.visitorCookie);
    const ref = ctx.url.searchParams.get('r');
    if (REFS.has(ref) && !ctx.user && !cookies(ctx.req).stated_ref) {
      out.push(cookie('stated_ref', ref, { maxAge: 30 * 86400, secure: config.secureCookies }));
    }
    return out.length ? { 'set-cookie': out } : {};
  }

  function hostOf(url) {
    try {
      return new URL(url).hostname.replace(/^www\./, '');
    } catch {
      return '';
    }
  }

  // A web source shows its host beside its title, so a page cannot pass
  // itself off as another publication by its title alone.
  function speakerLine(row) {
    const who = row.platform === 'x' && row.author_username
      ? html`<a href="${sourceHref(row, row.available ? row.source_url : `https://x.com/${row.author_username}`)}" rel="noopener noreferrer">${row.speaker}</a>`
      : html`${row.speaker}${row.title ? html` in <a href="${row.source_url}" rel="noopener noreferrer">${row.title}</a> <span class="mono">(${hostOf(row.source_url)})</span>` : html` on <a href="${row.source_url}" rel="noopener noreferrer">${hostOf(row.source_url)}</a>`}`;
    const said = row.reported_speech ? 'Quoted' : 'Said by';
    return html`${said} ${who}${row.published_at ? html` · ${when(row.published_at)}` : ''}`;
  }

  function outcomeLine(row) {
    if (cameTrueLate(row)) return html`<span class="miss">Came true only after the deadline it was held to, so it counts as did not come true</span>`;
    if (row.status === 'yes') return html`<span class="hit">Came true</span>`;
    if (row.status === 'no') return html`<span class="miss">Did not come true</span>`;
    if (row.status === 'ambiguous') return 'Ambiguous, not scored';
    if (row.status === 'annulled') return 'Annulled, not scored';
    return 'Open';
  }

  function scoreLine(row, ownerView) {
    const whose = ownerView ? 'your' : 'this profile’s';
    if (row.relation === 'following') return `Following only. It does not count toward ${whose} score.`;
    if (isBackfill(row)) return 'Backfill: saved after its deadline or outcome, or long after an undated claim was made. Shown, never scored as a forecast.';
    if (row.status === 'ambiguous' || row.status === 'annulled' || row.status === 'disputed') return 'Not scored.';
    if (row.status === 'yes' || row.status === 'no') {
      if (!ownerView && !publishedInTime(row)) return 'Published after its deadline or outcome, so it is not counted in this public record.';
      const p = scoringProbability(row);
      return p != null
        ? `Scored: baseline ${signed(baselineScore(p, outcomeFor(row)))} from the ${pct(p)} stated when it was made.`
        : 'Scored as came true or did not. No probability was stated when it was made.';
    }
    return 'Counts toward the forecasting record once the outcome is recorded.';
  }

  function claimText(row) {
    if (!row.available) return 'The post is no longer available on X, so its words are not shown.';
    if (row.display_text) return row.display_text;
    if (isPlaceholder(row)) return `A post by ${row.speaker}${row.published_at ? ` on ${when(row.published_at)}` : ''}. Stated keeps a private post’s link and terms, not its words.`;
    return row.span;
  }

  // A private post's words are fetched from X only when its owner asks, one
  // post at a time, from this record's own page (`wordsAction`).
  function postLinks(row, wordsAction) {
    if (!isPlaceholder(row) || !row.available) return '';
    if (row.display_via === 'oembed') {
      return html`<p class="quiet">Shown from ${xLabel()} for you just now; Stated does not store these words. <a href="${sourceHref(row)}" rel="noopener noreferrer">Open on ${xLabel()}</a></p>`;
    }
    if (row.display_failed) {
      return html`<p class="quiet">${xLabel()} did not return this post’s words. It may be deleted or protected. <a href="${sourceHref(row)}" rel="noopener noreferrer">Open the post on ${xLabel()}</a></p>`;
    }
    const seen = row.source_checked_at || row.first_observed_at;
    return html`<div class="row">
      <a class="button" href="${sourceHref(row)}" rel="noopener noreferrer">Open the post on ${xLabel()}</a>
      ${wordsAction ? html`<form method="get" action="${wordsAction}"><input type="hidden" name="words" value="1"><button type="submit">Show the post’s words here</button></form>` : ''}
    </div>
    ${seen ? html`<p class="quiet">X last confirmed this post exists on ${when(seen)}. Private saves are checked weekly.</p>` : ''}`;
  }

  const dateShort = (value) => dayMonth(value, { year: new Date(value).getUTCFullYear() !== new Date().getUTCFullYear() });

  // Where a prediction stands, in one plain phrase.
  function standing(row) {
    const outcome = verdictOf(row);
    const knownAt = row.outcome_at || row.resolved_at;
    if (outcome === 'yes') return `Came true${knownAt ? ` ${dateShort(knownAt)}` : ''}`;
    if (outcome === 'no') return `Didn’t happen${knownAt ? ` ${dateShort(knownAt)}` : ''}`;
    if (row.status === 'ambiguous') return 'Ambiguous, not scored';
    if (row.status === 'annulled') return 'Annulled, not scored';
    if (row.status === 'disputed') return 'Result disputed';
    const deadline = effectiveTerms(row).deadlineAt;
    return deadline ? timeLeft(deadline) : 'No date yet';
  }

  // The words, carrying their mark: highlighted when the prediction came true,
  // struck through when it did not. A withheld private post is never marked,
  // because the sentence shown in its place is ours and not the author's.
  function markedWords(row, { sweep = false } = {}) {
    const text = claimText(row);
    const theirs = row.available && (!isPlaceholder(row) || row.display_text);
    const outcome = theirs ? verdictOf(row) : null;
    if (outcome === 'yes') return html`<span class="hl${sweep ? ' sweep' : ''}">${text}</span>`;
    if (outcome === 'no') return html`<span class="struck">${text}</span>`;
    return text;
  }

  // One post at full size: the face, the name, the words, then either how long
  // until we find out or the Result with its evidence.
  function postCard(row, { wordsAction = null, faces = null, sweep = false, link = null } = {}) {
    const { direct, name, handle } = whoOf(row);
    const outcome = verdictOf(row);
    const knownAt = row.outcome_at || row.resolved_at;
    const source = sourceHref(row, row.source_url && row.available ? row.source_url : (direct ? `https://x.com/${row.author_username}` : row.source_url));
    const posted = row.published_at ? `Posted ${dayMonth(row.published_at, { year: true })}` : 'Source';
    const sourceLink = source ? html`<a class="tl" href="${source}" rel="noopener noreferrer">${posted}</a>` : '';
    const evidence = html`${row.resolution_note ? html`<span>${row.resolution_note}</span>` : ''}${row.resolution_url ? html`<a class="tl" href="${row.resolution_url}" rel="noopener noreferrer">Evidence</a>` : ''}`;
    const state = outcome
      ? html`<p class="verdict ${outcome}"><b>${outcome === 'yes' ? 'Yes' : 'No'}</b>${knownAt ? html`<span>${dayMonth(knownAt, { year: true })}</span>` : ''}<span class="grow"></span>${sourceLink}</p>
        ${row.resolution_note || row.resolution_url ? html`<p class="proof">${evidence}</p>` : html`<p class="proof"></p>`}`
      : html`<div class="when"><b>${standing(row)}</b>${source ? html`<a href="${source}" rel="noopener noreferrer">${posted}</a>` : ''}</div>
        ${row.status !== 'open' && (row.resolution_note || row.resolution_url) ? html`<p class="proof">${evidence}</p>` : ''}`;
    const words = markedWords(row, { sweep });
    const length = [...String(claimText(row) || '')].length;
    const size = length > 200 ? ' long' : length > 120 ? ' mid' : '';
    return html`
      <article class="post" id="s-${row.save_id}">
        <div class="head">${face({ url: faces?.get(String(row.speaker_x_user_id)) || null, name, size: 'lg' })}<b>${name}</b><span>${handle}</span>${row.platform === 'x' ? postLogo(xPostUrl(source, config.x.simulatedOrigin), config.x.simulatedOrigin) : ''}</div>
        <p class="said${size}">${link ? html`<a href="${link}">${words}</a>` : words}</p>
        ${row.available && row.platform === 'x' ? postTime(xPostUrl(source, config.x.simulatedOrigin), row.published_at) : ''}
        ${!direct ? html`<p class="aside">${speakerLine(row)}</p>` : ''}
        ${isBackfill(row) ? html`<p class="aside">Backfill: saved after its deadline or outcome.</p>` : ''}
        ${postLinks(row, wordsAction)}
      </article>
      ${state}`;
  }

  // How the prediction was read: its deadline, probability, outcome and score.
  function termsFold(row, { ownerView = false, more = '' } = {}) {
    const terms = effectiveTerms(row);
    let deadline = 'Not stated';
    if (terms.deadlineBasis === 'author') deadline = html`${when(terms.deadlineAt)}, confirmed by the author`;
    else if (terms.deadlineBasis === 'reviewer') deadline = html`${when(terms.deadlineAt)}, confirmed in review${row.deadline_text ? html` (stated: “${row.deadline_text}”)` : ''}`;
    else if (terms.deadlineBasis === 'reading') {
      deadline = row.deadline_text
        ? html`“${row.deadline_text}”, read as ${when(terms.deadlineAt)}. Not confirmed.`
        : html`Read from the post as ${when(terms.deadlineAt)}. Not confirmed.`;
    }
    const moved = terms.movedTo
      ? html`<dt>Moved</dt><dd>Deadline moved from ${when(terms.deadlineAt)} to ${when(terms.movedTo)}${terms.movedAt ? html` on ${when(terms.movedAt)}` : ''} by the author. The prediction is still held to ${when(terms.deadlineAt)}.</dd>`
      : '';
    let probability = terms.probability != null ? pct(terms.probability) : 'Not stated';
    if (terms.probabilityBasis === 'author_added') probability = `${probability}, added by the author after posting. Not scored.`;
    return html`
      <details class="fold terms">
        <summary>Terms</summary>
          <dl>
            <dt>Deadline</dt><dd>${deadline}</dd>
            ${moved}
            <dt>Probability</dt><dd>${probability}</dd>
            ${terms.condition ? html`<dt>Condition</dt><dd>${terms.condition}</dd>` : ''}
            ${row.hedges?.length ? html`<dt>Hedged</dt><dd>${row.hedges.map((h) => `“${h}”`).join(', ')}. Not converted to a number.</dd>` : ''}
            <dt>Outcome</dt><dd>${outcomeLine(row)}${row.resolution_note ? html`. ${row.resolution_note}` : ''}${row.resolution_url ? html` <a href="${row.resolution_url}" rel="noopener noreferrer">Evidence</a>` : ''}</dd>
            <dt>Score</dt><dd>${scoreLine(row, ownerView)}</dd>
          </dl>
        ${more}
      </details>`;
  }

  // The outcome a certificate shows: the one the save is held to.
  function verdictOf(row) {
    if (row.status === 'yes' || row.status === 'no') return outcomeFor(row);
    return null;
  }

  // Who a row is about, as X shows it: display name, then the handle.
  function whoOf(row) {
    const direct = row.platform === 'x' && row.author_username && !row.reported_speech;
    const name = direct ? (row.author_name || row.speaker) : row.speaker;
    const handle = direct && `@${row.author_username}` !== name ? `@${row.author_username}` : '';
    return { direct, name, handle };
  }

  // One row of a list: the post as it looked, then where it stands. The source
  // link sits after the words, so a row never hides where they came from.
  function fileRow(row, { link, by = null, ask = null }, faces = null, betLine = null) {
    const { direct, name, handle } = whoOf(row);
    const source = direct
      ? html`<a href="${sourceHref(row, row.available ? row.source_url : `https://x.com/${row.author_username}`)}" rel="noopener noreferrer">On ${xLabel()}</a>`
      : html`<span>${speakerLine(row)}</span>`;
    return html`
      <li class="prow" id="s-${row.save_id}">
        ${face({ url: faces?.get(String(row.speaker_x_user_id)) || null, name: row.speaker || '' })}
        <div>
          <p class="pwho"><b>${name}</b>${handle ? html`<span>${handle}</span>` : ''}</p>
          <p class="said"><a href="${link}">${markedWords(row)}</a></p>
          <p class="meta"><span>${standing(row)}</span>${by ? html`<span>${by}</span>` : ''}${isBackfill(row) ? html`<span>Backfill</span>` : ''}${source}</p>
          ${betLine || ''}${ask || ''}
        </div>
      </li>`;
  }

  function fileList(rows, options, faces = null, betLines = null) {
    return html`<ul class="posts">${rows.map((row) => fileRow(row, options(row), faces, betLines?.get(String(row.save_id))))}</ul>`;
  }

  // One line under an open prediction when somebody has test NEAR on it. The
  // rows passed in are ones the viewer may already see; the Bet shown is the
  // deliberately published projection only.
  async function betLinesFor(rows, viewer) {
    const lines = new Map();
    // The saves whose Bet still has an empty seat, for a page that wants to open on a dare.
    lines.dares = new Set();
    lines.dareBets = new Map();
    const pairs = [];
    const eligible = rows.filter((r) => r.status === 'open' && r.available).slice(0, 24);
    const published = await firstPublicBetsForSaves(db, eligible.map(row => row.save_id));
    for (const row of eligible) {
      const bet = published.get(String(row.save_id));
      if (bet) pairs.push([row, bet]);
    }
    if (!pairs.length) return lines;
    const faces = await facesByUsername(db, pairs.flatMap(([, bet]) => [bet.creator_username, bet.acceptor_username]), viewer);
    const pic = (username) => face({ url: faces.get(String(username || '').toLowerCase()) || null, name: username || '?' });
    for (const [row, bet] of pairs) {
      const other = bet.creator_side === 'yes' ? 'no' : 'yes';
      if (betState(bet).open && bet.creator_username) {
        const mine = Boolean(viewer?.x_username) && viewer.x_username.toLowerCase() === bet.creator_username.toLowerCase();
        if (!mine) {
          lines.dares.add(String(row.save_id));
          lines.dareBets.set(String(row.save_id), { id: bet.id, other,
            line: html`<p class="meta bet"><span class="stack">${pic(bet.creator_username)}</span><span>@${bet.creator_username} bet ${formatTestNear(bet.stake_yocto)} ${unit()} on ${bet.creator_side}.</span></p>` });
        }
        lines.set(String(row.save_id), html`<p class="meta bet"><span class="stack">${pic(bet.creator_username)}</span><span>${mine ? 'You' : `@${bet.creator_username}`} bet ${bet.creator_side}.</span>${mine
          ? html`<a href="/bets/${bet.id}">Open the bet</a>` : html`<a href="/bets/${bet.id}?join=1#accept">Bet ${other}</a>`}</p>`);
      } else if (['accepted', 'proposed', 'disputed'].includes(bet.status) && bet.creator_username && bet.acceptor_username) {
        lines.set(String(row.save_id), html`<p class="meta bet"><span class="stack">${pic(bet.creator_username)}${pic(bet.acceptor_username)}</span><a href="/bets/${bet.id}">@${bet.creator_username} v @${bet.acceptor_username}</a><span>${formatTestNear(bet.stake_yocto)} ${unit()} each</span></p>`);
      }
    }
    return lines;
  }

  const publicRow = (row) => ({
    link: row.owner_kind === 'editorial' ? `/desk/${row.save_id}` : `/u/${row.owner_username}/${row.save_id}`,
    by: row.owner_kind === 'editorial' ? 'Desk' : null,
  });

  // Sharing is always a plain X composer link that the person submits
  // themself. An open Prediction of your own reads as a dare; a Result of
  // your own is owned in the first person, hit or miss.
  function shareText(row, { own = false } = {}) {
    const result = verdictOf(row);
    const quote = `“${claimText(row).slice(0, 130)}”`;
    const due = effectiveTerms(row).deadlineAt ? ` Known by ${dayMonth(effectiveTerms(row).deadlineAt, { year: true })}.` : '';
    const evidence = result && row.resolution_url ? ` Evidence: ${row.resolution_url}` : '';
    if (result && own) return `Result: ${result === 'yes' ? 'Yes. I called it' : 'No. I got this one wrong'}: ${quote}${evidence}`;
    if (result) return `Result: ${result === 'yes' ? 'Yes' : 'No'}. ${row.speaker}: ${quote}${evidence}`;
    if (row.status !== 'open') return `${({ ambiguous: 'Ambiguous', annulled: 'Annulled', disputed: 'Disputed' })[row.status] || 'Outcome updated'}. ${row.speaker}: ${quote}`;
    if (own) return `On the record: ${quote}${due} Hold me to it, or take the other side.`;
    return `${row.speaker}: ${quote}${due} On the record.`;
  }

  function shareHref(url, row, options = {}) {
    const intent = new URL('https://x.com/intent/post');
    intent.searchParams.set('text', shareText(row, options));
    intent.searchParams.set('url', url);
    return intent.toString();
  }

  function shareLink(url, row, { ghost = false, own = false, label = null } = {}) {
    const href = shareHref(url, row, { own });
    if (ghost) return html`<a class="tl" href="${href}" rel="noopener noreferrer">Share on X</a>`;
    return html`<a class="pill solid big" href="${href}" rel="noopener noreferrer">${X_MARK}${label || (verdictOf(row) ? 'Post the result' : 'Post on X')}</a>`;
  }

  function historyList(revisions, { fold = false } = {}) {
    if (!revisions.length) return '';
    const label = {
      captured: 'Captured',
      author_terms: 'The author confirmed the terms',
      reviewer_terms: 'Terms corrected in review',
      attribution: 'Attribution corrected in review',
      resolved: 'Outcome recorded',
      resolution_changed: 'Outcome changed',
      disputed: 'Outcome disputed',
      source_unavailable: 'Source removed',
      source_edited: 'Source edited',
      terms_reparsed: 'Deadline reading corrected',
      capture_changed: 'Backfill label changed',
    };
    const describe = (terms) => {
      if (!terms) return '';
      if (terms.capture && Object.keys(terms).length === 1) return terms.capture === 'backfill' ? 'backfill' : 'prospective';
      if (terms.status) return `${terms.status}${terms.note ? `: ${terms.note}` : ''}`;
      if (terms.speaker) return `${terms.reportedSpeech ? 'quoted ' : ''}${terms.speaker}`;
      const parts = [];
      if (terms.deadlineAt || terms.proposedDeadlineAt) parts.push(`deadline ${when(terms.deadlineAt || terms.proposedDeadlineAt)}`);
      if (terms.probability != null) parts.push(`probability ${pct(terms.probability)}`);
      if (terms.condition) parts.push(`condition “${terms.condition}”`);
      return parts.join(', ') || 'no terms stated';
    };
    return html`
      ${fold ? html`<details class="fold"><summary>History<small>${revisions.length} ${revisions.length === 1 ? 'entry' : 'entries'}</small></summary>` : html`<h2>History</h2>`}
      <ol class="history">
        ${revisions.map((r) => {
          const unchanged = r.before && r.after && describe(r.before) === describe(r.after);
          const title = unchanged && (r.kind === 'reviewer_terms' || r.kind === 'author_terms')
            ? (r.kind === 'reviewer_terms' ? 'Terms confirmed in review' : 'The author confirmed the terms as read')
            : (label[r.kind] || r.kind);
          return html`<li>
          <p><strong>${title}</strong> · ${when(r.at)}</p>
          ${r.before && r.kind !== 'captured' && !unchanged ? html`<p class="quiet">Before: ${describe(r.before)}</p>` : ''}
          ${r.after ? html`<p class="quiet">${r.kind === 'captured' ? 'Read as' : (unchanged ? 'Terms' : 'After')}: ${describe(r.after)}</p>` : ''}
          ${r.note && r.note !== r.after?.note ? html`<p class="quiet">${r.note}</p>` : ''}
        </li>`;
        })}
      </ol>${fold ? raw('</details>') : ''}`;
  }

  function correctionForm(ctx, row) {
    if (!ctx.user) return html`<p class="stakes left"><a href="/signin?r=profile">Sign in</a> to request a correction.</p>`;
    return html`
      <details class="fold">
        <summary>Request a correction</summary>
        <form method="post" action="/corrections">${csrfField(ctx)}
          <input type="hidden" name="statement" value="${row.statement_id}">
          <input type="hidden" name="back" value="${ctx.url.pathname}">
          <fieldset><legend>What is wrong</legend>
            <div class="choice"><input type="radio" id="ck-i-${row.save_id}" name="kind" value="interpretation" checked><label for="ck-i-${row.save_id}">The reading of the claim, its deadline or its probability</label></div>
            <div class="choice"><input type="radio" id="ck-r-${row.save_id}" name="kind" value="resolution"><label for="ck-r-${row.save_id}">The recorded outcome</label></div>
          </fieldset>
          <label for="cb-${row.save_id}">Explain it</label>
          <textarea id="cb-${row.save_id}" name="body" required></textarea>
          <label for="ce-${row.save_id}">Evidence link, optional</label>
          <input type="url" id="ce-${row.save_id}" name="evidence" placeholder="https://">
          <button type="submit">Send to review</button>
        </form>
      </details>`;
  }

  function recordBlock(record, { publicOnly }) {
    if (!record.predictions) return html`<p class="quiet">No predictions yet.</p>`;
    return html`
      <p>${record.prospective} ${record.prospective === 1 ? 'prediction' : 'predictions'} captured before the outcome, ${record.open} open.
      ${record.resolved ? html`${record.cameTrue} came true and ${record.didNot} did not.` : 'None resolved yet.'}
      ${record.scored ? html`Average baseline ${signed(record.averageBaseline)} on ${record.scored} with a stated probability.` : ''}
      ${record.unscorable ? html`${record.unscorable} not scored (ambiguous, annulled or disputed).` : ''}
      ${record.backfill ? html`${record.backfill} backfill ${record.backfill === 1 ? 'record' : 'records'} shown but not scored.` : ''}
      ${record.publishedLate ? html`${record.publishedLate} published only after ${record.publishedLate === 1 ? 'its' : 'their'} outcome or deadline, so not counted.` : ''}
      ${record.withdrawnAfterOutcome ? html`${record.withdrawnAfterOutcome} public ${record.withdrawnAfterOutcome === 1 ? 'prediction was' : 'predictions were'} withdrawn after the outcome was known. ${record.withdrawnAfterOutcome === 1 ? 'It stays' : 'They stay'} in the counts above; the ${record.withdrawnAfterOutcome === 1 ? 'claim is' : 'claims are'} not shown.` : ''}
      ${record.withdrawnAfterDeadline ? html`${record.withdrawnAfterDeadline} withdrawn after the deadline and before an outcome.` : ''}</p>
      ${publicOnly ? html`<p class="quiet">Public entries only, counted only if they were public before their deadline and outcome. This is not a complete view of this person’s forecasting history.</p>` : ''}`;
  }

  async function needUser(ctx) {
    if (ctx.user) return true;
    redirect(ctx.res, `/signin?return=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`);
    return false;
  }

  async function needPost(ctx) {
    if (!ctx.user || !ctx.session) {
      redirect(ctx.res, '/signin');
      return null;
    }
    const origin = ctx.req.headers.origin;
    if (origin && origin !== new URL(config.baseUrl).origin) throw new UserError('That form came from another site.', 403);
    const form = await readForm(ctx.req);
    if (!sameString(form.get('csrf'), ctx.session.csrf)) throw new UserError('That form expired. Reload the page and try again.', 403);
    return form;
  }

  // Routes.

  const routes = [];
  const route = (method, pattern, fn) => routes.push({ method, pattern, fn });

  route('GET', /^\/(?:favicon\.ico|static\/favicon\.svg)$/, (ctx) => {
    ctx.res.writeHead(200, { 'content-type': 'image/svg+xml', 'cache-control': 'public, max-age=86400' });
    ctx.res.end(FAVICON);
  });

  // Token and chain logos. The address carries the set's version, so a file can be kept for a long time.
  route('GET', /^\/static\/tokens\/((?:chain|token)-[a-z0-9]+\.png)$/, (ctx) => {
    const file = logoFile(ctx.params[0]);
    if (!file) return notFound(ctx);
    ctx.res.writeHead(200, { 'content-type': 'image/png', 'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff' });
    ctx.res.end(file);
  });

  // Published OutLayer jury builds. Each file is named by its SHA-256, so an address never changes
  // meaning; the referee contract pins the hash and OutLayer rejects any other bytes.
  route('GET', /^\/static\/outlayer\/(stated-jury-[0-9a-f]{64}\.wasm)$/, (ctx) => {
    const name = ctx.params[0];
    let file;
    try { file = readFileSync(new URL(`../public/outlayer/${name}`, import.meta.url)); } catch { return notFound(ctx); }
    if (createHash('sha256').update(file).digest('hex') !== name.slice('stated-jury-'.length, -'.wasm'.length)) return notFound(ctx);
    ctx.res.writeHead(200, { 'content-type': 'application/wasm', 'content-length': file.length,
      'cache-control': 'public, max-age=31536000, immutable', 'x-content-type-options': 'nosniff', 'access-control-allow-origin': '*' });
    ctx.res.end(file);
  });

  route('GET', /^\/static\/pay\.js$/, (ctx) => {
    const etag = `"${PAY_VERSION}"`;
    const headers = { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', etag,
      'x-content-type-options': 'nosniff' };
    ctx.res.writeHead(ctx.req.headers['if-none-match'] === etag ? 304 : 200, headers);
    ctx.res.end(ctx.req.headers['if-none-match'] === etag ? undefined : PAY_JS);
  });

  route('GET', /^\/static\/wallet\.js$/, (ctx) => {
    const etag = `"${WALLET_VERSION}"`;
    const headers = { 'content-type': 'text/javascript; charset=utf-8', 'cache-control': 'no-cache', etag,
      'x-content-type-options': 'nosniff' };
    ctx.res.writeHead(ctx.req.headers['if-none-match'] === etag ? 304 : 200, headers);
    ctx.res.end(ctx.req.headers['if-none-match'] === etag ? undefined : WALLET_JS);
  });

  // Revalidated on every page view (a 304 when unchanged), which is when a
  // visit is counted.
  route('GET', /^\/static\/stated\.css$/, async (ctx) => {
    await countVisit(ctx);
    const etag = `"${CSS_VERSION}"`;
    const headers = { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache', etag };
    if (ctx.req.headers['if-none-match'] === etag) {
      ctx.res.writeHead(304, headers);
      ctx.res.end();
      return;
    }
    ctx.res.writeHead(200, headers);
    ctx.res.end(CSS);
  });

  route('GET', /^\/static\/certificate\.css$/, async (ctx) => {
    const etag = `"${CERT_CSS_VERSION}"`;
    const headers = { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache', etag };
    if (ctx.req.headers['if-none-match'] === etag) {
      ctx.res.writeHead(304, headers);
      ctx.res.end();
      return;
    }
    ctx.res.writeHead(200, headers);
    ctx.res.end(CERT_CSS);
  });

  route('GET', /^\/static\/skin\.css$/, async (ctx) => {
    const etag = `"${SKIN_CSS_VERSION}"`;
    const headers = { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache', etag };
    ctx.res.writeHead(ctx.req.headers['if-none-match'] === etag ? 304 : 200, headers);
    ctx.res.end(ctx.req.headers['if-none-match'] === etag ? undefined : SKIN_CSS);
  });

  route('GET', /^\/static\/certificate-live\.css$/, async (ctx) => {
    const etag = `"${LIVE_CSS_VERSION}"`;
    const headers = { 'content-type': 'text/css; charset=utf-8', 'cache-control': 'no-cache', etag };
    ctx.res.writeHead(ctx.req.headers['if-none-match'] === etag ? 304 : 200, headers);
    ctx.res.end(ctx.req.headers['if-none-match'] === etag ? undefined : LIVE_CSS);
  });

  route('GET', /^\/static\/fonts\/([\w.-]{1,60}\.woff2)$/, async (ctx) => {
    const font = FONTS.get(ctx.params[0]);
    if (!font) return notFound(ctx);
    ctx.res.writeHead(200, { 'content-type': 'font/woff2', 'cache-control': 'public, max-age=31536000, immutable' });
    ctx.res.end(font);
  });

  route('GET', /^\/healthz$/, async (ctx) => {
    await db.query('select 1');
    json(ctx.res, 200, { ok: true });
  });

  route('GET', /^\/$/, async (ctx) => {
    ensureVisitor(ctx);
    const hall = await publicBetHall(db);
    const outsideTaken = await outsideBetsTaken(db, { exclude: config.excludeXIds, admins: config.adminXIds });
    const bot = await botUsername();
    // One row per statement: the author's own save wins over a follower's.
    const seen = new Map();
    for (const row of await recentPublic(db, 24)) {
      const kept = seen.get(String(row.statement_id));
      if (!kept || (kept.relation !== 'mine' && row.relation === 'mine')) seen.set(String(row.statement_id), row);
    }
    const recent = [...seen.values()].slice(0, 9);
    const faces = await facesFor(db, recent, ctx.user);
    const betLines = await betLinesFor(recent, ctx.user);
    // DESIGN.md: the latest public ruling is the first object, with its mark on the words.
    let settled = null;
    for (const row of hall.rows.filter(bet => bet.status === 'settled' && ['yes', 'no'].includes(bet.outcome))
      .sort((a, b) => new Date(b.settled_at) - new Date(a.settled_at))) {
      const bet = await publicBet(db, row.id, { ...config.play, readRuling: readPublicRuling });
      if (rulingOnEvidence(bet) && !bet.evidence?.privateItemCount) { settled = bet; break; }
    }
    const dare = !settled && config.play?.enabled
      ? recent.find((row) => betLines.dares.has(String(row.save_id)) && !isPlaceholder(row)) || null : null;
    const lead = dare || recent.find((row) => verdictOf(row) === 'yes' && row.available && !isPlaceholder(row)) || null;
    const dareBet = dare ? betLines.dareBets.get(String(dare.save_id)) : null;
    const fallback = !settled && !dareBet && config.play?.enabled
      ? await nextOpenPublicBet(db, ctx.user?.id) : null;
    const rest = recent.filter((row) => fallback || row !== lead).slice(0, 8);
    const fallbackFaces = fallback ? await facesByUsername(db, [fallback.creator_username], ctx.user) : null;
    const featuredId = settled?.id || fallback?.id || dareBet?.id;
    const listed = config.near.real ? hall.rows : hall.rows.filter(bet => bet.id !== featuredId);
    const offers = listed.filter(bet => betState(bet).open);
    const hasOpenOffers = hall.rows.some(bet => betState(bet).open);
    const active = listed.filter(bet => ['accepted', 'proposed', 'disputed'].includes(bet.status));
    const finished = listed.filter(bet => !betState(bet).open && !active.includes(bet));
    const homeAction = config.near.real ? { href: ctx.user ? '/me/bets/new' : '/signin?return=%2Fme%2Fbets%2Fnew', label: 'Make a bet' }
      : !ctx.user ? { href: '/signin', label: 'Make a bet' }
      : fallback ? { href: `/bets/${fallback.id}?join=1#accept`, label: `Bet ${fallback.creator_side === 'yes' ? 'no' : 'yes'}` }
        : dareBet ? { href: `/bets/${dareBet.id}`, label: `Bet ${dareBet.other}` }
          : !settled ? { href: '/me', label: 'Your predictions' } : null;
    send(ctx.res, 200, await layout(ctx, 'Bets on what is said on X', html`
      <h1 class="visually-hidden">Stated</h1>
      ${settled ? html`<section class="settled-feature">
        ${await rulingPost(db, settled, settled.outcome, { claimHref: `/bets/${settled.id}/ruling` })}
        <a class="feature-result" href="/bets/${settled.id}/ruling"><div class="verdict ruling-verdict${settled.outcome === 'yes' ? ' yes' : ''}"><b>${settled.outcome === 'yes' ? html`<span class="hl">Yes</span>` : 'No'}</b><span>${dayMonth(settled.enclave?.decidedAt || settled.outlayer?.recordedAt || settled.settled_at, { year: true })}</span></div>
        <p class="gut feature-winner">${betLead(settled).text} the ${formatTestNear((BigInt(settled.stake_yocto) * 2n).toString())} ${unit()} pot.</p></a><p class="gut settlement-line">${settlementMarkup(await settlementSentence(db, config, settled))}</p></section>`
      : fallback ? html`${await betSourceHeader(db, null, fallback, config.x.simulatedOrigin)}<p class="prop">${fallback.claim}</p>${await betSourceHeader(db, null, fallback, config.x.simulatedOrigin, { timestamp: true })}${detailBetBlock(fallback, { viewer: ctx.user, faces: fallbackFaces, joinHref: `/bets/${fallback.id}?join=1#accept` })}`
        : lead ? html`${postCard(lead, { faces, sweep: true, link: publicRow(lead).link })}${dareBet ? html`<div class="dare">${dareBet.line}</div>` : ''}` : ''}
      ${config.near.real ? html`<p class="pitch home-intro">Sign in with X, add NEAR to your account, then make or take a bet. The <a class="tl" href="/court">OutLayer referee</a> rules and the winner is paid.</p>` : html`<p class="pitch home-intro${hasOpenOffers ? '' : ' empty'}">${hasOpenOffers ? '' : 'No open offers right now. '}Reply to any post on X with <span class="mention">@${bot} bet ${config.play.defaultStakeNear} no</span>.${hasOpenOffers ? ' Three AI models judge it and NEAR pays the winner.' : ''}</p>`}
      ${homeAction ? html`<div class="acts"><a class="pill solid big" href="${homeAction.href}">${homeAction.label}</a></div>` : ''}
      ${hall.total || config.near.real ? html`<section id="public-bets"><p class="pitch"><a class="tl" href="#public-bets">${hall.total} ${hall.total === 1 ? 'bet' : 'bets'}</a>, ${hall.settled} settled, ${formatTestNear(hall.wonYocto)} ${unit()} won${outsideTaken >= 1 || config.near.real ? html`, <span class="outside-taken">${outsideTaken} ${outsideTaken === 1 ? 'bet' : 'bets'} taken by people outside the team</span>` : ''}</p>${offers.length || config.near.real ? html`<h2 class="lead">Open offers</h2>${offers.length ? betList(offers, { hall: true }) : html`<p class="empty quiet">No open offers yet.</p>`}` : ''}${active.length || config.near.real ? html`<h2 class="lead">Bets in progress</h2>${active.length ? betList(active, { hall: true }) : html`<p class="empty quiet">No bets in progress yet.</p>`}` : ''}${finished.length || config.near.real ? html`<h2 class="lead">Finished bets</h2>${finished.length ? betList(finished, { hall: true }) : html`<p class="empty quiet">No finished bets yet.</p>`}` : ''}</section>` : ''}
      ${rest.length ? fileList(rest, publicRow, faces, betLines) : ''}
    `, { flush: true, signin: false, og: {
      title: 'Stated: bets on what is said on X', description: 'Bet on what is said on X, decided by three AI models in NEAR AI enclaves.',
    } }), { headers: refCookie(ctx) });
  });

  route('GET', /^\/signin$/, async (ctx) => {
    if (ctx.user) return redirect(ctx.res, returnPath(ctx.url.searchParams.get('return')));
    const params = new URLSearchParams();
    for (const key of ['r', 'return']) if (ctx.url.searchParams.get(key)) params.set(key, ctx.url.searchParams.get(key));
    const next = `/signin/x${params.size ? `?${params}` : ''}`;
    send(ctx.res, 200, await layout(ctx, 'Sign in', html`
      <div class="signbox">
        <h1 class="visually-hidden">Sign in</h1>
        <p class="pitch">Stated reads your X profile and posts, nothing else. It cannot post, follow or message as you.</p>
        <p>Your profile here starts private. By signing in you agree to the <a href="/terms">Terms of Service</a> and the <a href="/privacy">Privacy Policy</a>.</p>
        <a class="pill solid big xbutton" href="${next}">${X_MARK}Sign in with X</a>
      </div>
    `, { kind: 'private', flush: true }), { kind: 'private', headers: refCookie(ctx) });
  });

  route('GET', /^\/terms$/, async (ctx) => {
    send(ctx.res, 200, await layout(ctx, 'Terms of Service', termsPage({ bot: await botUsername(), real: config.near.real,
      pilotXIds: config.play.pilotXIds, startNear: config.play.startNear, sponsorLimit: config.play.sponsorLimit, maxStakeNear: config.play.maxStakeNear })));
  });

  route('GET', /^\/privacy$/, async (ctx) => {
    send(ctx.res, 200, await layout(ctx, 'Privacy Policy', privacyPage({
      bot: await botUsername(), sessionDays: config.sessionDays, textPolicy: config.x.textPolicy, real: Boolean(config.near.real),
    })));
  });

  route('GET', /^\/signin\/x$/, async (ctx) => {
    if (!config.x.clientId) throw new UserError('Sign-in is not configured on this server.', 503);
    const { verifier, challenge } = pkcePair();
    const state = token(24);
    const back = ctx.url.searchParams.get('return');
    const returnTo = returnPath(back, null);
    const vid = verifyVisitor(cookies(ctx.req).stated_vid);
    const storedRef = vid
      ? await db.one('select ref from visitor_refs where visitor = $1', [createHash('sha256').update(`stated-visit:${vid}`).digest('hex').slice(0, 32)])
      : null;
    const ref = storedRef?.ref || null;
    await db.query(`delete from oauth_states where created_at < now() - interval '1 hour'`);
    await db.query(
      `insert into oauth_states (state, code_verifier, purpose, return_to, ref) values ($1, $2, 'signin', $3, $4)`,
      [state, verifier, returnTo, REFS.has(ref) ? ref : null],
    );
    // The state is bound to this browser, so a callback link from someone
    // else's sign-in cannot sign this browser in to their account.
    redirect(ctx.res, authorizeUrl(config, { state, challenge, scopes: SIGNIN_SCOPES }), {
      'set-cookie': cookie('stated_oauth', state, { maxAge: 900, secure: config.secureCookies }),
    });
  });

  route('GET', /^\/callback$/, async (ctx) => {
    const q = ctx.url.searchParams;
    const presented = q.get('state') || '';
    const pending = await db.one(`select purpose from oauth_states where state = $1`, [presented]);
    if (pending?.purpose === 'signin' && !sameString(cookies(ctx.req).stated_oauth, presented)) {
      throw new UserError('That sign-in was started in a different browser. Start again from Sign in with X.', 400);
    }
    const state = await db.one(
      `delete from oauth_states where state = $1 and created_at > now() - interval '15 minutes' returning *`,
      [presented],
    );
    if (!state) throw new UserError('That sign-in link expired. Start again from Sign in with X.', 400);
    if (q.get('error') || !q.get('code')) throw new UserError('Sign-in was cancelled on X. Nothing was saved.', 400);
    const tokens = await exchangeCode(config, { code: q.get('code'), verifier: state.code_verifier }, fetchImpl);
    const me = await getMe(config, tokens.accessToken, fetchImpl);
    if (state.purpose === 'bot') {
      // The bot is the configured account or, without one, the account
      // already connected. Only the very first connection, with neither, can
      // bind a new account.
      const expected = config.x.botUserId || (await db.one('select x_user_id from bot_credentials where id = 1'))?.x_user_id;
      if (expected && me.id !== expected) {
        throw new UserError(`That approval came from @${me.username}, not the configured bot account. Sign in to X as the bot and open the link again.`, 400);
      }
      await saveBotCredentials(db, config, { user: me, tokens });
      botName = me.username;
      send(ctx.res, 200, await layout(ctx, 'Bot connected', html`
        <h1>Bot connected as @${me.username}</h1>
        <p>Scopes granted: ${tokens.scopes || 'not reported'}.</p>`), { kind: 'private' });
      return;
    }
    const user = await signInFromX(db, me, { ref: state.ref });
    const sid = await createSession(db, user.id, config.sessionDays);
    const next = !user.setup_completed_at
      ? (state.return_to && state.return_to !== '/me'
        ? `/setup?return=${encodeURIComponent(returnPath(state.return_to))}` : '/setup')
      : returnPath(state.return_to);
    redirect(ctx.res, next, {
      'set-cookie': [
        cookie('stated_sid', sid, { maxAge: config.sessionDays * 86400, secure: config.secureCookies }),
        cookie('stated_ref', '', { maxAge: 0, secure: config.secureCookies }),
        cookie('stated_oauth', '', { maxAge: 0, secure: config.secureCookies }),
      ],
    });
  });

  route('POST', /^\/signout$/, async (ctx) => {
    const form = await needPost(ctx);
    if (!form) return;
    await db.query('delete from sessions where id = $1', [ctx.session.id]);
    redirect(ctx.res, '/', { 'set-cookie': cookie('stated_sid', '', { maxAge: 0, secure: config.secureCookies }) });
  });

  route('GET', /^\/setup$/, async (ctx) => {
    if (!(await needUser(ctx))) return;
    if (ctx.user.setup_completed_at) return redirect(ctx.res, returnPath(ctx.url.searchParams.get('return')));
    const { mine, following } = await ownerCollections(db, ctx.user);
    const pending = [...mine, ...following];
    const waiting = pending.length
      ? `${pending.length === 1 ? 'The post you saved' : `${pending.length} posts you saved`} by tagging @${await botUsername()} ${pending.length === 1 ? 'is' : 'are'} waiting.`
      : '';
    send(ctx.res, 200, await layout(ctx, 'Finish setup', html`
      <div class="hero"><h1>You’re in, @${ctx.user.x_username}</h1>
        <p>${waiting ? `${waiting} ` : ''}Your profile starts private. Nothing is public until you publish it.</p></div>
      <form method="post" action="/setup">
        ${csrfField(ctx)}
        <input type="hidden" name="return" value="${returnPath(ctx.url.searchParams.get('return'))}">
        ${pending.length === 1
          // One tagged post is waiting: the button says it will show that post, so
          // pressing it is the owner's own request for its words, as on the post's page.
          ? html`<input type="hidden" name="show" value="1"><div class="acts"><button class="primary big" type="submit">Finish setup and show my post</button></div>`
          : html`<div class="acts"><button class="primary big" type="submit">Finish setup</button></div>`}
        <div class="folds"><details class="fold"><summary>Choose what is public</summary>
          <fieldset>
            <legend>Who can see your profile</legend>
            <div class="choice"><input type="radio" id="pv-private" name="profile" value="private" checked><label for="pv-private"><strong>Private.</strong> Only you can see your profile and your saves.</label></div>
            <div class="choice"><input type="radio" id="pv-public" name="profile" value="public"><label for="pv-public"><strong>Public.</strong> Anyone can see the saves you make public. You can still keep any save private.</label></div>
          </fieldset>
          <fieldset>
            <legend>If public, new saves start as</legend>
            <div class="choice"><input type="radio" id="dv-private" name="defaults" value="private" checked><label for="dv-private">Private, until I publish them</label></div>
            <div class="choice"><input type="radio" id="dv-public" name="defaults" value="public"><label for="dv-public">Public</label></div>
          </fieldset>
          ${pending.length ? html`<fieldset>
            <legend>If public, publish these now</legend>
            <p class="quiet">Nothing is published unless you tick it.</p>
            ${pending.map((row) => html`<div class="choice"><input type="checkbox" id="pub-${row.save_id}" name="publish" value="${row.save_id}"><label for="pub-${row.save_id}">${row.relation === 'mine' ? 'Prediction' : `Following ${row.speaker}`}: ${claimText(row).slice(0, 140)}</label></div>`)}
          </fieldset>` : ''}
          ${config.x.dmEnabled ? html`<fieldset>
            <legend>Updates</legend>
            <p class="quiet">Deadline and outcome updates always go to your private inbox here.</p>
            <div class="choice"><input type="checkbox" id="dm" name="dm" value="1"><label for="dm">Also send them to me by direct message on X</label></div>
          </fieldset>` : ''}
        </details></div>
      </form>`, { kind: 'private', flush: true }), { kind: 'private' });
  });

  route('POST', /^\/setup$/, async (ctx) => {
    const form = await needPost(ctx);
    if (!form) return;
    await completeSetup(db, ctx.user, {
      profileVisibility: form.get('profile'),
      defaultSaveVisibility: form.get('defaults'),
      dmUpdates: config.x.dmEnabled && form.get('dm') === '1',
      publishIds: form.all('publish'),
    });
    await syncOwner(ctx.user);
    // Someone who tagged the bot once and then signed in came for that post:
    // take them to it. With an explicit destination, or more than one save,
    // the destination or the list stands.
    const target = returnPath(form.get('return'));
    if (target === '/me') {
      const { mine, following } = await ownerCollections(db, ctx.user);
      const saved = [...mine, ...following];
      if (saved.length === 1) return redirect(ctx.res, `/me/s/${saved[0].save_id}?done=captured${form.get('show') === '1' ? '&words=1' : ''}`);
    }
    redirect(ctx.res, target);
  });

  // After any change to what a person shows publicly, the stored words of
  // their X posts follow: fetched for newly public records, dropped for ones
  // no longer public anywhere.
  async function syncOwner(user) {
    const rows = await db.many('select statement_id from saves where owner_user_id = $1', [user.id]);
    await sync(rows.map((r) => r.statement_id));
  }

  const isoDay = (value) => (value ? new Date(value).toISOString().slice(0, 10) : '');

  // What the owner does next with a Prediction: one filled button.
  function ownerAction(ctx, row, back, publicUrl) {
    const user = ctx.user;
    const isAuthor = row.relation === 'mine' && row.speaker_x_user_id === user.x_user_id;
    const fields = html`${csrfField(ctx)}<input type="hidden" name="back" value="${back}">`;
    const terms = effectiveTerms(row);
    const canToggle = profileIsPublic(user) && !row.author_protected;
    const isPublic = Boolean(publicUrl);
    const needsConfirm = isAuthor && row.status === 'open' && !row.author_confirmed_at;
    const change = canToggle ? html`<form method="post" action="/me/saves/${row.save_id}/visibility">${fields}<input type="hidden" name="visibility" value="${isPublic ? 'private' : 'public'}"><button class="tl" type="submit">${isPublic ? 'Make private' : 'Make public'}</button></form>` : '';
    let main;
    if (needsConfirm) {
      main = html`
        <form method="post" action="/me/saves/${row.save_id}/terms">${fields}
          ${terms.deadlineAt ? html`<input type="hidden" name="deadline" value="${isoDay(terms.deadlineAt)}">`
            : html`<label for="dl-quick-${row.save_id}">When will this be known?</label><input type="date" id="dl-quick-${row.save_id}" name="deadline">`}
          <input type="hidden" name="probability" value="${terms.probability != null ? Math.round(terms.probability * 100) : ''}">
          <input type="hidden" name="condition" value="${terms.condition || ''}">
          <button class="primary big" type="submit">Confirm</button>
        </form>`;
    } else if (isPublic) main = shareLink(publicUrl, row, { own: isAuthor });
    else if (canToggle) {
      main = html`<form method="post" action="/me/saves/${row.save_id}/visibility">${fields}
          <input type="hidden" name="visibility" value="public"><button class="primary big" type="submit">Make public</button></form>`;
    } else main = html`<a class="pill big" href="/me/settings/publish">Choose what to publish</a>`;
    return html`
      ${needsConfirm && terms.deadlineAt ? html`<p class="stakes">Known by ${dayMonth(terms.deadlineAt, { year: true })}${terms.probability != null ? html`, ${pct(terms.probability)} likely` : ''}. Is that what you meant?</p>` : ''}
      <div class="acts">
        ${main}
        <div class="two">
          ${needsConfirm && isPublic ? shareLink(publicUrl, row, { ghost: true, own: isAuthor }) : ''}
          ${needsConfirm || isPublic ? change : ''}
          ${row.status === 'open' && row.available ? html`<a class="tl" href="/me/bets/new?save=${row.save_id}">Bet on it</a>` : ''}
        </div>
      </div>
      ${isPublic ? '' : html`<p class="stakes left">Only you can see this.</p>`}`;
  }

  // Everything else an owner can do, folded. Each form keeps its own route.
  function ownerFolds(ctx, row, back, revisions) {
    const user = ctx.user;
    const isAuthor = row.relation === 'mine' && row.speaker_x_user_id === user.x_user_id;
    const fields = html`${csrfField(ctx)}<input type="hidden" name="back" value="${back}">`;
    const terms = effectiveTerms(row);
    return html`
      <section class="folds owner" id="sharing">
        ${termsFold(row, { ownerView: true, more: historyList(revisions) })}
        ${isAuthor && row.status === 'open' ? html`
          <details class="fold" id="terms"><summary>${row.author_confirmed_at ? 'Revise what you meant' : 'Confirm what you meant'}</summary>
            <p class="quiet">Earlier versions stay in the history. Terms lock at the deadline. The score always uses the probability your post stated: a number you add or change here is shown, not scored.</p>
            <form method="post" action="/me/saves/${row.save_id}/terms">${fields}
              <label for="dl-${row.save_id}">Deadline</label>
              <input type="date" id="dl-${row.save_id}" name="deadline" value="${isoDay(terms.deadlineAt)}">
              <label for="p-${row.save_id}">Probability, percent</label>
              <input type="number" min="1" max="99" id="p-${row.save_id}" name="probability" value="${terms.probability != null ? Math.round(terms.probability * 100) : ''}">
              <label for="c-${row.save_id}">Condition, if any</label>
              <input type="text" id="c-${row.save_id}" name="condition" value="${terms.condition || ''}">
              <label for="tn-${row.save_id}">Reason for the change, optional</label>
              <input type="text" id="tn-${row.save_id}" name="note">
              <p><button type="submit">${row.author_confirmed_at ? 'Save revision' : 'Confirm terms'}</button></p>
            </form>
          </details>` : ''}
        ${!isAuthor ? html`
          <details class="fold"><summary>Reminder${row.watch_at ? html`<small>${dayMonth(row.watch_at, { year: true })}</small>` : ''}</summary>
            <form method="post" action="/me/saves/${row.save_id}/watch">${fields}
              <label for="w-${row.save_id}">Remind me on (private)</label>
              <input type="date" id="w-${row.save_id}" name="watch" value="${isoDay(row.watch_at)}">
              <p><button type="submit">Save date</button></p>
            </form>
          </details>` : ''}
        <details class="fold"><summary>Private note${row.annotation ? html`<small>Saved</small>` : ''}</summary>
          <form method="post" action="/me/saves/${row.save_id}/note">${fields}
            <label class="visually-hidden" for="n-${row.save_id}">Private note</label>
            <textarea id="n-${row.save_id}" name="note">${row.annotation || ''}</textarea>
            <p><button type="submit">Save note</button></p>
          </form>
        </details>
        <details class="fold"><summary>More</summary>
          <p class="quiet">${{ mention: 'Saved by tagging the bot.', dm: 'Saved by direct message.' }[row.intake] || 'Saved from a link.'} ${row.visibility === 'public' && profileIsPublic(user) ? 'Public on your profile.' : 'Private.'}</p>
          ${correctionForm(ctx, row)}
          <form method="post" action="/me/saves/${row.save_id}/remove">${fields}
            <p class="quiet">Removing takes this out of your profile. It cannot be undone from here.</p>
            <button type="submit">Remove from my profile</button>
          </form>
        </details>
      </section>`;
  }

  // The first sentence of a notice is its headline; the rest is detail.
  function splitNotice(body) {
    const text = String(body || '');
    const cutAt = text.search(/[.:](\s|$)/);
    if (cutAt < 0 || cutAt > 110) return { head: text.length > 110 ? `${text.slice(0, 107)}…` : text, rest: text.length > 110 ? text : '' };
    return { head: text.slice(0, cutAt + 1).replace(/:$/, ''), rest: text.slice(cutAt + 1).trim() };
  }

  // Notices are stored as full sentences, because they also go out as direct
  // messages. On screen the Inbox shows the short form: who and what, then the
  // detail. The scoring sentence is left to the Prediction's own page.
  const OUTCOME_WORD = { 'It came true': 'Yes', 'It did not come true': 'No', 'Ambiguous, so it is not scored': 'Ambiguous',
    'Annulled, so it is not scored': 'Annulled', 'The outcome is disputed, so it is not scored': 'Disputed' };
  const SCORING = /\s*(You follow this claim\. It does not count toward your score\.|It counts toward your record\.|The credit stays with them, and it does not count toward your score\.|A prediction without a probability is still tracked; it is scored as came true or did not\.)/g;
  // Bet notices are stored as full sentences; the Inbox row says the same thing in fewer words.
  const BET_SHORT = {
    'The creator deposited the stake for this bet.': 'The bet is open.',
    'The result is in and this bet is settled. The stakes went to the winner.': 'Settled. The winner was paid.',
    'Both participants deposited their stakes for this bet.': 'Both sides are in.',
    'A result was proposed for this bet. It has not been agreed.': 'A result was proposed. It is not agreed yet.',
    'The proposed result for this bet was disputed.': 'The proposed result was disputed.',
    'Both participants agreed on a result. The resulting funds are credited for withdrawal.': 'Both sides agreed. The stakes went to the winner.',
  };
  function noticeView(item) {
    if (item.kind === 'bet_update' && BET_SHORT[item.body]) return { head: BET_SHORT[item.body], rest: '' };
    const body = String(item.body || '');
    const m = item.kind === 'outcome' && body.match(/^Outcome recorded for a prediction by (.+?): (It came true|It did not come true|Ambiguous, so it is not scored|Annulled, so it is not scored|The outcome is disputed, so it is not scored)\.\s*([^]*)$/);
    if (m) return { head: `${m[1]}: ${OUTCOME_WORD[m[2]]}`, rest: m[3].replace(SCORING, '').trim() };
    const { head, rest } = splitNotice(body);
    return { head, rest: rest.replace(SCORING, '').trim() };
  }

  const noticeLink = (item) => (item.intake_id ? `/me/track/${item.intake_id}`
    : item.save_id && item.relation ? `/me/s/${item.save_id}`
    : item.bet_id ? `/bets/${item.bet_id}` : null);

  route('GET', /^\/me$/, async (ctx) => {
    if (!(await needUser(ctx))) return;
    if (!ctx.user.setup_completed_at) return redirect(ctx.res, '/setup');
    const tab = ctx.url.searchParams.get('tab') === 'following' ? 'following' : 'mine';
    const { mine, following } = await ownerCollections(db, ctx.user);
    const rows = tab === 'mine' ? mine : following;
    const flash = flashOf(ctx.url);
    const record = recordOf(mine);
    const bot = await botUsername();
    const isPublic = (row) => row.visibility === 'public' && profileIsPublic(ctx.user);
    const unconfirmed = (row) => row.relation === 'mine' && row.speaker_x_user_id === ctx.user.x_user_id && !row.author_confirmed_at && row.status === 'open';
    // An author's unconfirmed prediction asks its one question in the row.
    const ask = (row) => {
      if (!unconfirmed(row)) return null;
      const terms = effectiveTerms(row);
      if (!terms.deadlineAt) {
        return html`<div class="ask" role="group" aria-label="Confirm what you meant"><span>When will this be known?</span><a class="pill solid" href="/me/s/${row.save_id}#terms">Set a date</a></div>`;
      }
      return html`<div class="ask" role="group" aria-label="Confirm what you meant">
            <span>${dayMonth(terms.deadlineAt, { year: true })}${terms.probability != null ? html`, ${pct(terms.probability)}` : ''}. That right?</span>
            <form method="post" action="/me/saves/${row.save_id}/terms">${csrfField(ctx)}<input type="hidden" name="back" value="/me">
              <input type="hidden" name="deadline" value="${isoDay(terms.deadlineAt)}">
              <input type="hidden" name="probability" value="${terms.probability != null ? Math.round(terms.probability * 100) : ''}">
              <input type="hidden" name="condition" value="${terms.condition || ''}">
              <button class="primary" type="submit">Looks right</button>
            </form>
            <a class="pill" href="/me/s/${row.save_id}#terms">Edit</a>
          </div>`;
    };
    send(ctx.res, 200, await layout(ctx, 'My profile', html`
      <h1 class="visually-hidden">@${ctx.user.x_username}</h1>
      <nav class="tabs" aria-label="Collections">
        <a href="/me" ${tab === 'mine' ? raw('aria-current="page"') : ''}>Yours</a>
        <a href="/me?tab=following" ${tab === 'following' ? raw('aria-current="page"') : ''}>Following</a>
      </nav>
      <form class="paste" method="post" action="/me/track">${csrfField(ctx)}
        <label class="visually-hidden" for="q-url">Link to a post on X or an article</label>
        <input type="url" id="q-url" name="url" inputmode="url" placeholder="Paste a link to a post on X" required>
        <button class="primary" type="submit">Add</button>
      </form>
      ${flash ? html`<p class="notice" role="status">${flash}</p>` : ''}
      ${tab === 'mine' && record.predictions ? html`<p class="record">${record.cameTrue} right, ${record.didNot} wrong, ${record.open} open</p>` : ''}
      ${rows.length ? fileList(rows, (row) => ({
        link: `/me/s/${row.save_id}`,
        by: isPublic(row) ? null : 'Only you can see this',
        ask: ask(row),
      }), await facesFor(db, rows, ctx.user), await betLinesFor(rows.filter(isPublic), ctx.user)) : (tab === 'mine'
        ? html`<p class="blank">Reply <b>@${bot}</b> under one of your own posts on X and it lands here.</p>`
        : html`<p class="blank">Nothing here yet. Paste a link above, or reply <b>@${bot}</b> under a prediction on X.</p>
          <div class="acts"><a class="pill big" href="/">See what people are calling</a></div>`)}
      <section class="folds">
        <details class="fold"><summary>Your record</summary>${recordBlock(record, { publicOnly: false })}</details>
        <p class="stakes left">${profileIsPublic(ctx.user)
          ? html`Your profile is public. <a href="/u/${ctx.user.x_username}">See what others see</a>`
          : html`Your profile is private. <a href="/me/settings">Make it public in Settings</a>`}</p>
      </section>
    `, { kind: 'private', flush: true }), { kind: 'private' });
  });

  route('GET', /^\/me\/inbox$/, async (ctx) => {
    if (!(await needUser(ctx))) return;
    const items = await inboxFor(db, ctx.user, { prioritizeUpdates: true });
    const captureNotice = (item) => ['saved', 'pending_terms'].includes(item.kind);
    const betIds = [...new Set(items.map((item) => item.bet_id).filter(Boolean))];
    const betClaims = new Map(betIds.length
      ? (await db.many('select id, claim from bilateral_bets where id = any($1::uuid[])', [betIds])).map((row) => [row.id, row.claim]) : []);
    const updates = items.filter((item) => !captureNotice(item));
    const saved = items.filter(captureNotice);
    const rows = (entries) => html`<ul class="posts inbox">${entries.map((item) => {
        const { head, rest } = noticeView(item);
        const href = noticeLink(item);
        return html`
        <li class="prow note">
          <div>
            <p class="said">${href ? html`<a class="what" href="${href}">${head}</a>` : head}</p>
            ${item.bet_id && betClaims.get(item.bet_id) ? html`<p class="meta">${betClaims.get(item.bet_id).slice(0, 110)}</p>` : ''}
            ${rest ? html`<p class="meta">${rest}</p>` : ''}
            <div class="meta"><span>${dayMonth(item.created_at, { year: true })}${item.dm_status === 'failed' ? '. The direct message failed. This copy is kept here.' : ''}${item.dm_status === 'sent' ? '. Also sent by direct message.' : ''}</span>
              <form method="post" action="/me/inbox/${item.id}/done">${csrfField(ctx)}<button class="tl" type="submit">Done</button></form></div>
          </div>
        </li>`;
      })}</ul>`;
    send(ctx.res, 200, await layout(ctx, 'Inbox', html`
      <div class="hero"><h1>Inbox</h1></div>
      ${updates.length ? rows(updates) : html`<p class="blank">Nothing yet. Results and bet updates show up here.</p>`}
      ${saved.length ? html`<details class="fold saved-notices"><summary>Saved predictions (${saved.length})</summary>${rows(saved)}</details>` : ''}
    `, { kind: 'private', flush: true, back: '/me', inboxBadge: false }), { kind: 'private' });
  });

  route('POST', /^\/me\/inbox\/(\d{1,18})\/done$/, async (ctx) => {
    const form = await needPost(ctx);
    if (!form) return;
    await markInboxDone(db, ctx.user, ctx.params[0]);
    redirect(ctx.res, '/me/inbox');
  });

  route('POST', /^\/me\/saves\/(\d{1,18})\/(visibility|note|watch|terms|remove)$/, async (ctx) => {
    const form = await needPost(ctx);
    if (!form) return;
    const [id, action] = ctx.params;
    let done = 'saved';
    if (action === 'visibility') {
      const row = await setSaveVisibility(db, ctx.user, id, form.get('visibility'));
      await sync([row.statement_id]);
      done = row.visibility === 'public' ? 'public' : 'private';
    }
    if (action === 'note') await annotate(db, ctx.user, id, form.get('note'));
    if (action === 'watch') await setWatch(db, ctx.user, id, form.get('watch') ? `${form.get('watch')}T12:00:00Z` : null);
    if (action === 'terms') {
      await confirmTerms(db, ctx.user, id, {
        deadlineAt: form.get('deadline') ? `${form.get('deadline')}T23:59:59Z` : null,
        probability: form.get('probability'),
        condition: form.get('condition'),
        note: form.get('note'),
      });
      done = 'terms';
    }
    if (action === 'remove') {
      const statementId = await removeSave(db, ctx.user, id);
      await sync([statementId]);
      await purgeOrphanXSources(db);
      return redirect(ctx.res, '/me?done=removed');
    }
    const back = form.get('back');
    const target = back && /^\/me(\/s\/\d{1,18})?$/.test(back) ? back : '/me';
    redirect(ctx.res, `${target}?done=${done}`);
  });

  route('GET', /^\/me\/s\/(\d{1,18})$/, async (ctx) => {
    if (!(await needUser(ctx))) return;
    const row = await ownerSave(db, ctx.user, ctx.params[0]);
    if (!row) return notFound(ctx);
    // Only an explicit request for this one post reads its words from X.
    if (ctx.url.searchParams.get('words') === '1') await postWords(config, row, fetchImpl);
    const revisions = await revisionsFor(db, row.statement_id, [row.save_id]);
    const flash = flashOf(ctx.url);
    const publicUrl = row.visibility === 'public' && profileIsPublic(ctx.user)
      ? `${config.baseUrl}/u/${ctx.user.x_username}/${row.save_id}` : null;
    const back = `/me/s/${row.save_id}`;
    const own = row.relation === 'mine' && row.speaker_x_user_id === ctx.user.x_user_id;
    const bet = (await publicBetsForSave(db, row.save_id))[0];
    const betFaces = bet ? await facesByUsername(db, [bet.creator_username, bet.acceptor_username], ctx.user) : null;
    const done = ctx.url.searchParams.get('done');
    // Right after a save goes public, or is saved or confirmed while public,
    // the one useful next step is to post it.
    const nudge = publicUrl && row.status === 'open' && ['public', 'terms', 'xsaved'].includes(done);
    send(ctx.res, 200, await layout(ctx, claimText(row).slice(0, 80), html`
      ${nudge ? html`
      <div class="notice go" role="status">
        <p>${flash}<small>${own ? 'Post it so people can hold you to it.' : 'Post it so the record is seen.'}</small></p>
        ${shareLink(publicUrl, row, { own, label: 'Post on X' })}
      </div>` : (flash ? html`<p class="${done === 'captured' ? 'stakes left' : 'notice'}" role="status">${flash}</p>` : '')}
      ${postCard(row, { wordsAction: back, faces: await facesFor(db, [row], ctx.user), sweep: true })}
      ${bet ? html`${betBlock(bet, { viewer: ctx.user, faces: betFaces, joinHref: `/bets/${bet.id}?join=1#accept`, cameTrue: verdictOf(row) === 'yes' })}
      <div class="acts"><a class="pill big" href="/bets/${bet.id}">Open the bet</a></div>` : ''}
      ${ownerAction(ctx, row, back, publicUrl)}
      ${ownerFolds(ctx, row, back, revisions)}
    `, { kind: 'private', flush: true, back: `/me${row.relation === 'following' ? '?tab=following' : ''}` }), { kind: 'private' });
  });

  route('POST', /^\/corrections$/, async (ctx) => {
    const form = await needPost(ctx);
    if (!form) return;
    await requestCorrection(db, ctx.user, {
      statementId: form.get('statement'),
      kind: form.get('kind'),
      body: form.get('body'),
      evidenceUrl: form.get('evidence'),
    });
    const back = form.get('back');
    const target = back && /^\/(me\/s\/\d{1,18}|u\/\w{1,40}\/\d{1,18}|desk\/\d{1,18})$/.test(back) ? back : '/me';
    redirect(ctx.res, `${target}?done=review`);
  });

  route('GET', /^\/me\/export\.json$/, async (ctx) => {
    if (!ctx.user) return json(ctx.res, 401, { error: 'sign_in' }, 'private');
    if (!allowHeavyRead(ctx)) return;
    const data = { ...await exportPage(db, ctx.user, ctx.url, { owner: true }), bets: ctx.user.setup_completed_at ? await betsFor(db, ctx.user) : [] };
    ctx.res.writeHead(200, {
      'content-type': 'application/json; charset=utf-8',
      'content-disposition': `attachment; filename="stated-${ctx.user.x_username}.json"`,
      ...headersFor('private'),
    });
    ctx.res.end(JSON.stringify(data, null, 2));
  });

  route('GET', /^\/me\/settings$/, async (ctx) => {
    if (!(await needUser(ctx))) return;
    const u = ctx.user;
    send(ctx.res, 200, await layout(ctx, 'Settings', html`
      <h1>Settings</h1>
      <p class="note">This covers your prediction pages. Each bet is published on its own.</p>
      <form method="post" action="/me/settings">
        ${csrfField(ctx)}
        <fieldset>
          <legend>Who can see your profile</legend>
          <div class="choice"><input type="radio" id="pv-private" name="profile" value="private" ${u.profile_visibility === 'private' ? raw('checked') : ''}><label for="pv-private"><strong>Private.</strong> Takes your public prediction pages down.</label></div>
          <div class="choice"><input type="radio" id="pv-public" name="profile" value="public" ${u.profile_visibility === 'public' ? raw('checked') : ''}><label for="pv-public"><strong>Public.</strong> ${u.profile_visibility === 'public' ? 'Your public saves are visible.' : 'You will choose which saves to publish next.'}</label></div>
        </fieldset>
        <fieldset>
          <legend>New saves start as</legend>
          <div class="choice"><input type="radio" id="dv-private" name="defaults" value="private" ${u.default_save_visibility === 'private' ? raw('checked') : ''}><label for="dv-private">Private</label></div>
          <div class="choice"><input type="radio" id="dv-public" name="defaults" value="public" ${u.default_save_visibility === 'public' ? raw('checked') : ''}><label for="dv-public">Public, when the profile is public</label></div>
        </fieldset>
        ${config.x.dmEnabled ? html`<div class="choice"><input type="checkbox" id="dm" name="dm" value="1" ${u.dm_updates ? raw('checked') : ''}><label for="dm">Send updates by direct message on X</label></div>` : ''}
        <button class="primary" type="submit">Save settings</button>
      </form>`), { kind: 'private' });
  });

  route('POST', /^\/me\/settings$/, async (ctx) => {
    const form = await needPost(ctx);
    if (!form) return;
    const profile = form.get('profile') === 'public' ? 'public' : 'private';
    const defaults = form.get('defaults') === 'public' ? 'public' : 'private';
    const dm = config.x.dmEnabled && form.get('dm') === '1';
    if (profile === 'public' && ctx.user.profile_visibility !== 'public') {
      return redirect(ctx.res, `/me/settings/publish?defaults=${defaults}&dm=${dm ? 1 : 0}`);
    }
    await setProfileVisibility(db, ctx.user, { visibility: profile, defaultSaveVisibility: defaults, dmUpdates: dm });
    await syncOwner(ctx.user);
    redirect(ctx.res, `/me?done=${profile === 'private' ? 'withdrawn' : 'settings'}`);
  });

  route('GET', /^\/me\/settings\/publish$/, async (ctx) => {
    if (!(await needUser(ctx))) return;
    const { mine, following } = await ownerCollections(db, ctx.user);
    const rows = [...mine, ...following];
    const q = ctx.url.searchParams;
    send(ctx.res, 200, await layout(ctx, 'Choose what to publish', html`
      <h1>Choose what to publish</h1>
      <p>Your profile becomes public with only the saves you tick. Everything else stays private.</p>
      <form method="post" action="/me/settings/publish">
        ${csrfField(ctx)}
        <input type="hidden" name="defaults" value="${q.get('defaults') === 'public' ? 'public' : 'private'}">
        <input type="hidden" name="dm" value="${q.get('dm') === '1' ? '1' : '0'}">
        ${rows.length ? rows.map((row) => html`<div class="choice"><input type="checkbox" id="pub-${row.save_id}" name="publish" value="${row.save_id}" ${row.author_protected ? raw('disabled') : ''}><label for="pub-${row.save_id}">${row.relation === 'mine' ? 'Prediction' : `Following ${row.speaker}`}: ${claimText(row).slice(0, 160)}${row.author_protected ? ' (protected account, stays private)' : ''}${row.status !== 'open' ? ' (already resolved: shown, but not counted in your public record)' : ''}</label></div>`) : html`<p>You have no saves yet.</p>`}
        <div class="row">
          <button class="primary" type="submit" name="confirm" value="1">Make my profile public</button>
          <a class="button" href="/me/settings">Keep it private</a>
        </div>
      </form>`), { kind: 'private' });
  });

  route('POST', /^\/me\/settings\/publish$/, async (ctx) => {
    const form = await needPost(ctx);
    if (!form) return;
    if (form.get('confirm') !== '1') return redirect(ctx.res, '/me/settings');
    await setProfileVisibility(db, ctx.user, {
      visibility: 'public',
      confirmedSelection: true,
      publishIds: form.all('publish'),
      defaultSaveVisibility: form.get('defaults'),
      dmUpdates: config.x.dmEnabled && form.get('dm') === '1',
    });
    await syncOwner(ctx.user);
    redirect(ctx.res, `/me?done=published&n=${form.all('publish').length}`);
  });

  async function trackPage(ctx, { error = '', value = '', status = 200 } = {}) {
    send(ctx.res, status, await layout(ctx, 'Add a post', html`
      <div class="hero"><h1>Add a post</h1><p>Paste a link to a post on X, or to an article. It stays private until you publish it.</p></div>
      <form class="paste${error ? ' bad' : ''}" method="post" action="/me/track">
        ${csrfField(ctx)}
        <label class="visually-hidden" for="url">Article or post link</label>
        <input type="url" id="url" name="url" inputmode="url" placeholder="https://" required value="${value}"
          ${error ? raw('aria-invalid="true" aria-describedby="url-error"') : ''}>
        <button class="primary" type="submit">Add</button>
      </form>
      ${error ? html`<p class="err" id="url-error" role="alert">${error}</p>` : ''}`,
    { kind: 'private', flush: true, back: '/me' }), { kind: 'private' });
  }

  route('GET', /^\/me\/track$/, async (ctx) => {
    if (!(await needUser(ctx))) return;
    // "Follow prediction" arrives here with the source link filled in; the
    // save itself still happens on the form's own post.
    const url = ctx.url.searchParams.get('url') || '';
    await trackPage(ctx, { value: /^https?:\/\/\S{1,2000}$/.test(url) ? url : '' });
  });

  route('POST', /^\/me\/track$/, async (ctx) => {
    const form = await needPost(ctx);
    if (!form) return;
    let intake;
    try {
      intake = await personIntake(db, config, ctx.user, form.get('url'), 'web', { x: await botX() });
    } catch (err) {
      if (!(err instanceof UserError)) throw err;
      return trackPage(ctx, { error: err.message, value: form.get('url'), status: 422 });
    }
    if (intake.kind === 'x') return redirect(ctx.res, `/me/s/${intake.save.id}?done=xsaved`);
    redirect(ctx.res, `/me/track/${intake.id}`);
  });

  async function pickerPage(ctx, intake, { action, editorial }) {
    const source = intake.source_id ? await db.one('select * from sources where id = $1', [intake.source_id]) : null;
    send(ctx.res, 200, await layout(ctx, 'Pick predictions', html`
      <h1>Pick predictions to ${editorial ? 'publish on the desk' : 'follow'}</h1>
      <p class="quiet">${source?.title || intake.url}</p>
      ${intake.status === 'failed' ? html`<p class="banner error" role="alert">${intake.error}</p><p><a class="button" href="${editorial ? '/admin' : '/me/track'}">Try another link</a></p>` : ''}
      ${intake.status === 'selected' ? html`<p class="banner">Already picked.</p>` : ''}
      ${intake.status === 'fetched' ? html`
        ${intake.candidates.length ? html`
          <form method="post" action="${action}">
            ${csrfField(ctx)}
            ${intake.candidates.map((c) => html`<div class="choice"><input type="checkbox" id="c-${c.index}" name="pick" value="${c.index}"><label for="c-${c.index}">${c.text}<br><span class="quiet">${c.reportedSpeech ? 'Quoted' : 'Said by'} ${c.speaker || 'the author'}${c.deadlineText ? ` · deadline “${c.deadlineText}”` : ' · no deadline stated'}${c.probability != null ? ` · ${pct(c.probability)}` : ''}</span></label></div>
              ${editorial ? html`<div class="row speaker-fix">
                <label for="sp-${c.index}" class="quiet">Speaker</label>
                <input type="text" id="sp-${c.index}" name="speaker-${c.index}" value="${c.speaker || ''}">
                <div class="choice"><input type="checkbox" id="rq-${c.index}" name="quoted-${c.index}" value="1" ${c.reportedSpeech ? raw('checked') : ''}><label for="rq-${c.index}" class="quiet">Quoted, not the writer</label></div>
              </div>` : ''}`)}
            <p class="quiet">Picked predictions are credited to their speaker, not to you.${editorial ? ' Desk records are public.' : ''}</p>
            <button class="primary" type="submit">${editorial ? 'Publish picked records' : 'Follow picked predictions'}</button>
          </form>` : html`<p>No sentences in that page read as predictions.</p>`}` : ''}
    `), { kind: 'private' });
  }

  route('GET', /^\/me\/track\/(\d{1,18})$/, async (ctx) => {
    if (!(await needUser(ctx))) return;
    const intake = await db.one('select * from url_intakes where id = $1 and owner_x_user_id = $2', [ctx.params[0], ctx.user.x_user_id]);
    if (!intake) return notFound(ctx);
    await pickerPage(ctx, intake, { action: `/me/track/${intake.id}`, editorial: false });
  });

  route('POST', /^\/me\/track\/(\d{1,18})$/, async (ctx) => {
    const form = await needPost(ctx);
    if (!form) return;
    const saves = await selectCandidates(db, { ownerXUserId: ctx.user.x_user_id, intakeId: ctx.params[0], indexes: form.all('pick') });
    redirect(ctx.res, `/me?tab=following&done=following&n=${saves.length}`);
  });

  async function profilePage(ctx, owner, { base, title, publicBets = [] }) {
    const publicProfile = canViewProfile(null, owner);
    const collections = publicProfile ? await collectionPage(db, owner, ctx.url)
      : publicBets.length ? { mine: [], following: [], next: null } : null;
    if (!collections) return notFound(ctx);
    ensureVisitor(ctx);
    const record = await publicRecord(db, owner);
    const isOwnerViewing = ctx.user && ctx.user.id === owner.id;
    const all = [...collections.mine, ...collections.following];
    const listFaces = await facesFor(db, all, ctx.user);
    const betLines = await betLinesFor(all, ctx.user);
    const list = (rows) => fileList(rows, (row) => ({ link: `${base}/${row.save_id}` }), listFaces, betLines);
    send(ctx.res, 200, await layout(ctx, title, html`
      ${owner.kind === 'editorial' ? '' : html`<div class="post who-head"><div class="head">${face({ url: listFaces.get(String(owner.x_user_id)) || null, name: owner.x_username, size: 'lg' })}<b>${publicProfile ? owner.x_name || owner.x_username : owner.x_username}</b><span>@${owner.x_username}</span></div></div>`}
      <div class="hero${owner.kind === 'editorial' ? '' : ' visually-hidden'}">
        <h1>${title}</h1>
        ${owner.kind === 'editorial'
          ? html`<p>Forecasts from public articles, credited to the people who made them. The first subject is U.S. macroeconomic and market forecasts with near deadlines: the Fed, inflation, growth, oil and stock-index targets. Dated AI milestones are a second lane. Records saved after their outcome was known are labelled backfill.</p>`
          : ''}
      </div>
      ${isOwnerViewing ? html`<p class="notice">This is what others see. Private saves are not listed.</p>` : ''}
      ${publicBets.length ? html`<h2 class="lead">Public bets</h2>${betList(publicBets, { hall: true })}` : ''}
      ${publicProfile && owner.kind !== 'editorial' ? html`<h2>Predictions on this page (${collections.mine.length})</h2>
      ${collections.mine.length ? list(collections.mine) : html`<p class="blank">No public predictions.</p>`}` : ''}
      ${publicProfile ? html`<h2>${owner.kind === 'editorial' ? 'Records' : 'Following'} on this page (${collections.following.length})</h2>
      ${collections.following.length ? list(collections.following) : html`<p class="blank">Nothing public.</p>`}` : ''}
      ${collections.next ? html`<p class="gut"><a class="tl" rel="next" href="${collections.next}">Next page</a></p>` : ''}
      ${publicProfile && owner.kind !== 'editorial' ? html`<section class="folds"><details class="fold record"><summary>Record</summary>${recordBlock(record, { publicOnly: true })}</details></section>` : ''}
    `, {
      flush: true,
      og: {
        title,
        description: owner.kind === 'editorial'
          ? `${collections.following.length} public records on this page.`
          : `${collections.mine.length} public predictions, ${collections.following.length} followed claims on this page.`,
      },
    }), { headers: refCookie(ctx) });
  }

  async function savePage(ctx, owner, saveId, { base, title }) {
    const row = await publicSave(db, owner, saveId);
    if (!row) return notFound(ctx);
    ensureVisitor(ctx);
    const who = owner.kind === 'editorial' ? 'the Stated desk' : `@${owner.x_username}`;
    const followers = await publicFollowerCount(db, row.statement_id);
    const revisions = await revisionsFor(db, row.statement_id, [row.save_id]);
    const flash = flashOf(ctx.url);
    const shareUrl = `${config.baseUrl}${base}/${row.save_id}`;
    const outcome = verdictOf(row);
    const bet = (await publicBetsForSave(db, row.save_id))[0];
    const betFaces = bet ? await facesByUsername(db, [bet.creator_username, bet.acceptor_username], ctx.user) : null;
    const join = bet ? `/bets/${bet.id}?join=1#accept` : null;
    const other = bet ? (bet.creator_side === 'yes' ? 'no' : 'yes') : null;
    const viewerOffered = Boolean(bet?.creator_username && ctx.user && ctx.user.x_username.toLowerCase() === bet.creator_username.toLowerCase());
    const canTake = Boolean(bet && betState(bet).open && !viewerOffered);
    // A visitor's main action on an open prediction is to take an open bet, or
    // else to follow it; the owner and anyone looking at a result share instead.
    const canFollow = !outcome && row.available && row.source_url && !(ctx.user && ctx.user.id === owner.id);
    const follow = canFollow ? `/me/track?url=${encodeURIComponent(row.source_url)}` : null;
    let primary;
    if (canTake) {
      primary = ctx.user ? html`<a class="pill solid big" href="${join}">Bet ${other}</a>`
        : html`<a class="pill solid big" href="/signin?return=${encodeURIComponent(join)}">Bet ${other}</a>`;
    } else if (follow) primary = html`<a class="pill solid big" href="${follow}">Follow it</a>`;
    else primary = shareLink(shareUrl, row);
    const sharesFirst = !canTake && !follow;
    send(ctx.res, 200, await layout(ctx, claimText(row).slice(0, 80), html`
      ${flash ? html`<p class="notice" role="status">${flash}</p>` : ''}
      <div class="pri">${postCard(row, { faces: await facesFor(db, [row], ctx.user), sweep: true })}</div>
      ${bet ? betBlock(bet, { viewer: ctx.user, faces: betFaces, joinHref: canTake ? join : null, cameTrue: outcome === 'yes' }) : ''}
      <div class="acts">
        ${primary}
        <div class="two">
          ${row.status === 'open' && row.available ? html`<a class="tl" href="/me/bets/new?save=${row.save_id}">${bet ? 'Make your own bet' : 'Bet on it'}</a>` : ''}
          ${sharesFirst ? html`<a class="tl" href="/share/predictions/${row.save_id}.png" download="stated-prediction-${row.save_id}.png">Save image</a>` : shareLink(shareUrl, row, { ghost: true })}
        </div>
      </div>
      <section class="folds">
        ${termsFold(row, { more: html`<p class="quiet">Saved by ${who} on ${dayMonth(row.saved_at, { year: true })}.
          ${row.relation === 'following' ? 'Saving it does not mean agreeing with it.' : ''}
          ${followers ? `${followers} public ${followers === 1 ? 'profile follows' : 'profiles follow'} this claim.` : ''}</p>${historyList(revisions)}` })}
        ${correctionForm(ctx, row)}
      </section>
    `, {
      flush: true,
      back: base,
      // One way to sign in per screen: the page's own button when it has one.
      signin: !(canTake && !ctx.user), two: true,
      extra: canTake && follow ? html`<a class="pill" href="${follow}">Follow</a>` : null,
      og: {
        title: `${row.speaker}: ${claimText(row).slice(0, 90)}`,
        image: `/share/predictions/${row.save_id}.png`,
        description: `${row.relation === 'mine' ? 'Prediction' : 'Followed claim'} saved by ${who}. ${row.deadline_text ? `Deadline: ${row.deadline_text}. ` : ''}${row.status === 'open' ? 'Open.' : 'Resolved.'}`,
      },
    }), { headers: refCookie(ctx) });
  }

  route('GET', /^\/u\/(\w{1,40})$/, async (ctx) => {
    const owner = await personByUsername(db, ctx.params[0]);
    if (!owner) return notFound(ctx);
    const publicBets = await publicBetsForProfile(db, owner.x_username);
    if (!canViewProfile(null, owner) && !publicBets.length) return notFound(ctx);
    await profilePage(ctx, owner, { base: `/u/${owner.x_username}`, title: `@${owner.x_username}`, publicBets });
  });

  // A save is found by its ID; the handle in the address is only a label. An
  // address whose handle is stale redirects to the owner's current handle, so
  // a renamed account's old links keep working and a new holder of the old
  // handle never appears to own them.
  route('GET', /^\/u\/(\w{1,40})\/(\d{1,18})$/, async (ctx) => {
    const owner = await publicSaveOwner(db, ctx.params[1]);
    if (!owner) return notFound(ctx);
    if (owner.x_username.toLowerCase() !== ctx.params[0].toLowerCase()) {
      const r = ctx.url.searchParams.get('r');
      return redirect(ctx.res, `/u/${owner.x_username}/${ctx.params[1]}${REFS.has(r) ? `?r=${r}` : ''}`);
    }
    await savePage(ctx, owner, ctx.params[1], { base: `/u/${owner.x_username}`, title: `@${owner.x_username}` });
  });

  route('GET', /^\/desk$/, async (ctx) => {
    const desk = await ensureDesk(db);
    await profilePage(ctx, desk, { base: '/desk', title: 'The Stated desk' });
  });

  route('GET', /^\/desk\/(\d{1,18})$/, async (ctx) => {
    const desk = await ensureDesk(db);
    await savePage(ctx, desk, ctx.params[0], { base: '/desk', title: 'The Stated desk' });
  });

  route('GET', /^\/search$/, async (ctx) => {
    const q = ctx.url.searchParams.get('q') || '';
    const rows = await searchPublic(db, q);
    send(ctx.res, 200, await layout(ctx, 'Search', html`
      <div class="hero"><h1>Search public records</h1></div>
      <form class="paste" method="get" action="/search">
        <label class="visually-hidden" for="q">Words in a prediction, or an author</label>
        <input type="search" id="q" name="q" value="${q}" placeholder="Words in a prediction, or an author">
        <button class="primary" type="submit">Search</button>
      </form>
      ${q ? html`<p class="stakes left">${rows.length} public ${rows.length === 1 ? 'record' : 'records'}. Private saves never appear here.</p>` : ''}
      ${rows.length ? fileList(rows, publicRow, await facesFor(db, rows, ctx.user)) : ''}
    `, { flush: true }));
  });

  // JSON reads share the same privacy predicates as the pages.

  route('GET', /^\/api\/u\/(\w{1,40})$/, async (ctx) => {
    const owner = await personByUsername(db, ctx.params[0]);
    const collections = owner ? await collectionPage(db, owner, ctx.url) : null;
    if (!collections) return json(ctx.res, 404, { error: 'not_found' });
    json(ctx.res, 200, {
      username: owner.x_username,
      record: await publicRecord(db, owner),
      recordScope: 'every public prediction, counted only if public before its deadline and outcome; predictions withdrawn after the outcome stay in the counts',
      pagination: { limit: collections.limit, next: collections.next },
      predictions: collections.mine.map(publicSaveView),
      following: collections.following.map(publicSaveView),
    });
  });

  route('GET', /^\/api\/u\/(\w{1,40})\/(\d{1,18})$/, async (ctx) => {
    const owner = await personByUsername(db, ctx.params[0]);
    const row = owner ? await publicSave(db, owner, ctx.params[1]) : null;
    if (!row) return json(ctx.res, 404, { error: 'not_found' });
    json(ctx.res, 200, {
      ...publicSaveView(row),
      publicFollowers: await publicFollowerCount(db, row.statement_id),
      history: await revisionsFor(db, row.statement_id, [row.save_id]),
    });
  });

  route('GET', /^\/api\/u\/(\w{1,40})\/export\.json$/, async (ctx) => {
    if (!allowHeavyRead(ctx)) return;
    const owner = await personByUsername(db, ctx.params[0]);
    const data = owner ? await exportPage(db, owner, ctx.url) : null;
    if (!data) return json(ctx.res, 404, { error: 'not_found' });
    json(ctx.res, 200, data);
  });

  route('GET', /^\/api\/desk\/export\.json$/, async (ctx) => {
    if (!allowHeavyRead(ctx)) return;
    json(ctx.res, 200, await exportPage(db, await ensureDesk(db), ctx.url));
  });

  route('GET', /^\/api\/search$/, async (ctx) => {
    const rows = await searchPublic(db, ctx.url.searchParams.get('q') || '');
    json(ctx.res, 200, { results: rows.map((r) => ({ ...publicSaveView(r), owner: r.owner_kind === 'editorial' ? 'desk' : r.owner_username })) });
  });

  route('GET', /^\/api\/me$/, async (ctx) => {
    if (!ctx.user) return json(ctx.res, 401, { error: 'sign_in' }, 'private');
    const { mine, following } = await ownerCollections(db, ctx.user);
    json(ctx.res, 200, {
      username: ctx.user.x_username,
      profileVisibility: ctx.user.profile_visibility,
      record: recordOf(mine),
      predictions: mine.map(ownerSaveView),
      following: following.map(ownerSaveView),
    }, 'private');
  });

  route('GET', /^\/api\/me\/inbox$/, async (ctx) => {
    if (!ctx.user) return json(ctx.res, 401, { error: 'sign_in' }, 'private');
    json(ctx.res, 200, { items: await inboxFor(db, ctx.user) }, 'private');
  });

  // Admin: reviewers record outcomes and run the editorial desk. They never
  // see owners' annotations or private collections.

  async function needAdmin(ctx) {
    if (isAdmin(ctx.user)) return true;
    await notFound(ctx);
    return false;
  }

  route('GET', /^\/admin$/, async (ctx) => {
    if (!(await needAdmin(ctx))) return;
    const m = await metrics(db, { exclude: config.excludeXIds });
    const corrections = await openCorrections(db);
    // The reviewer resolves a claim against the deadline it states. Nothing
    // here reveals who saved a claim, or that its author did: a claim no one
    // has made public shows no speaker, no save count and no saver's terms,
    // and its link carries no handle. A saver's confirmed terms appear only
    // when the author's own save is public, as they do on its public card. A
    // private author's earlier committed deadline is applied to their own
    // record from the outcome date, without being shown here. Claims saved
    // only by people who have not signed up are listed too.
    const authorPublic = `s.relation = 'mine' and s.author_confirmed_at is not null and ${PUBLIC_SAVE_SQL}`;
    const open = await db.many(
      `select st.id, st.span, st.speaker, st.deadline_text, st.status, st.capture,
              src.platform, src.platform_id, src.url as source_url, src.available,
              coalesce(st.deadline_at, st.proposed_deadline_at) as due, count(s.id) as saves,
              coalesce(bool_or(${PUBLIC_SAVE_SQL}), false) or coalesce(bool_or(u.kind = 'editorial'), false) as has_public,
              min(s.author_committed_deadline_at) filter (where ${authorPublic}) as committed_at,
              max(s.author_deadline_at) filter (where ${authorPublic}) as moved_to,
              max(s.author_deadline_moved_at) filter (where ${authorPublic}) as moved_at,
              max(s.author_condition) filter (where ${authorPublic}) as public_condition
       from statements st join sources src on src.id = st.source_id
       join saves s on s.statement_id = st.id left join users u on u.id = s.owner_user_id
       group by st.id, src.id order by (st.status = 'open') desc, due nulls last limit 100`,
    );
    const backlog = Number(await kvGet(db, 'source_check_backlog')) || 0;
    const claimFor = (st) => {
      if (st.platform !== 'x') return st.span;
      const link = html`<a href="${sourceHref(st, st.has_public ? st.source_url : `https://x.com/i/web/status/${st.platform_id}`)}" rel="noopener noreferrer">Read the post on ${xLabel()}</a>`;
      return isPlaceholder(st)
        ? html`${link} <span class="quiet">(its words are not stored while it is private)</span>`
        : html`${st.span} ${link}`;
    };
    const publicTerms = (st) => {
      const committed = st.committed_at && (!st.due || new Date(st.committed_at) < new Date(st.due)) ? st.committed_at : st.due;
      const moved = st.moved_to && committed && new Date(st.moved_to) > new Date(committed);
      if (!(st.committed_at && committed !== st.due) && !moved && !st.public_condition) return '';
      const parts = [committed ? `held to ${when(committed)}` : null, st.public_condition ? `condition “${st.public_condition}”` : null].filter(Boolean);
      return html`<p class="quiet">On the public record: ${parts.join(', ')}.${moved ? html` Deadline moved from ${when(committed)} to ${when(st.moved_to)}${st.moved_at ? html` on ${when(st.moved_at)}` : ''}; the prediction is still held to ${when(committed)}.` : ''}</p>`;
    };
    const outcomeSelect = (id, current) => html`
      <label for="o-${id}">Outcome</label>
      <select id="o-${id}" name="outcome">
        ${[['yes', 'It came true'], ['no', 'It did not'], ['ambiguous', 'Ambiguous'], ['annulled', 'Annulled'], ['disputed', 'Disputed']]
          .map(([v, l]) => html`<option value="${v}" ${current === v ? raw('selected') : ''}>${l}</option>`)}
      </select>`;
    send(ctx.res, 200, await layout(ctx, 'Admin', html`
      <h1>Admin</h1>
      ${backlog > 0 ? html`<p class="banner error" role="alert">${backlog} saved X posts are overdue for their deletion check (daily for public records, weekly for private saves). Run <span class="mono">npm run cli -- tick --sources</span> again.</p>` : ''}
      <h2>Metrics</h2>
      <table>
        <tr><th>Valid tags</th><td>${m.tags.valid}</td><th>Saves per valid tag</th><td>${m.tags.savesPerValidTag == null ? '—' : m.tags.savesPerValidTag.toFixed(2)}</td></tr>
        <tr><th>Taggers</th><td>${m.tags.taggers}</td><th>Repeat savers</th><td>${m.repeat.repeatSavers} of ${m.repeat.savers}</td></tr>
        <tr><th>Returned another day</th><td>${m.repeat.returnedAnotherDay}</td><th>Median seconds to save</th><td>${m.tags.medianSecondsToSave == null ? '—' : Math.round(m.tags.medianSecondsToSave)}</td></tr>
        <tr><th>Set up</th><td>${m.accounts.setUp}</td><th>Public profiles</th><td>${m.accounts.publicProfiles}</td></tr>
        <tr><th>Public saves</th><td>${m.collections.publicSaves}</td><th>Pending saves</th><td>${m.collections.pending}</td></tr>
        <tr><th>Views from bot replies</th><td>${m.visits.fromReply}</td><th>Sign-ups from replies</th><td>${m.accounts.acquiredFromReply}</td></tr>
        <tr><th>Views from profiles</th><td>${m.visits.fromProfile}</td><th>Sign-ups from profiles</th><td>${m.accounts.acquiredFromProfile}</td></tr>
        <tr><th>Bets offered</th><td>${m.bets.offered}</td><th>Funded on ${network().id}</th><td>${m.bets.funded}</td></tr>
        <tr><th>Bets published</th><td>${m.bets.published}</td><th>Bet page visitors, not a side</th><td>${m.bets.pageViews}</td></tr>
        <tr><th>Bet follows</th><td>${m.bets.follows} (${m.bets.followsByNewAccount} by accounts made after the bet)</td><th>Bets taken</th><td>${m.bets.accepted} (${m.bets.acceptedByNewAccount} by accounts made after the bet)</td></tr>
        <tr><th>Bets settled</th><td>${m.bets.settled}</td><th></th><td></td></tr>
      </table>
      <h2>Track an article on the desk</h2>
      <form method="post" action="/admin/editorial">${csrfField(ctx)}
        <label for="eurl">Article link</label><input type="url" id="eurl" name="url" required>
        <div class="choice"><input type="checkbox" id="ebf" name="backfill" value="1"><label for="ebf">Historical collection. Records are labelled backfill and never scored as forecasts.</label></div>
        <button type="submit">Find predictions</button>
      </form>
      <h2>Correction requests (${corrections.length})</h2>
      ${corrections.map((c) => html`
        <div class="banner">
          <p>${claimFor(c)}</p>
          <p class="quiet">${c.speaker} · status ${c.status} · ${c.kind === 'resolution' ? 'about the outcome' : 'about the reading'} · ${when(c.created_at)}</p>
          <p>${c.body}</p>
          ${c.evidence_url ? html`<p><a href="${c.evidence_url}" rel="noopener noreferrer">Evidence offered</a></p>` : ''}
          ${c.kind === 'resolution' ? html`
            <form method="post" action="/admin/resolve/${c.statement_id}">${csrfField(ctx)}
              <input type="hidden" name="correction" value="${c.id}">
              ${outcomeSelect(`c${c.id}`, c.status)}
              <label for="ce-${c.id}">Evidence link</label><input type="url" id="ce-${c.id}" name="url" value="${c.evidence_url || ''}">
              <label for="ck-${c.id}">Outcome known on</label><input type="date" id="ck-${c.id}" name="known">
              <label for="cn-${c.id}">What happened</label><input type="text" id="cn-${c.id}" name="note">
              <button type="submit">Accept and change the outcome</button>
            </form>` : html`
            <form method="post" action="/admin/terms/${c.statement_id}">${csrfField(ctx)}
              <input type="hidden" name="correction" value="${c.id}">
              <label for="cs-${c.id}">Speaker (leave as is unless the attribution is wrong)</label><input type="text" id="cs-${c.id}" name="speaker" value="${c.speaker}">
              <label for="cd-${c.id}">Deadline</label><input type="date" id="cd-${c.id}" name="deadline">
              <label for="cp-${c.id}">Probability, percent</label><input type="number" min="1" max="99" id="cp-${c.id}" name="probability">
              <label for="cc-${c.id}">Condition</label><input type="text" id="cc-${c.id}" name="condition">
              <label for="ct-${c.id}">Reason</label><input type="text" id="ct-${c.id}" name="note">
              <button type="submit">Accept and correct the reading</button>
            </form>`}
          <form method="post" action="/admin/corrections/${c.id}/reject">${csrfField(ctx)}
            <label for="cr-${c.id}">Reason for rejecting</label><input type="text" id="cr-${c.id}" name="note">
            <button type="submit">Reject</button>
          </form>
        </div>`)}
      <h2>Record outcomes</h2>
      <p class="quiet">Resolve each claim against the deadline it states. Reviewers never see who saved a claim, their notes or terms they confirmed privately; for a claim no one has made public, the speaker and the number of saves are hidden too. An outcome needs an evidence link; ambiguous, annulled and disputed need a reason. Give the date the outcome became known: a saver who committed to an earlier deadline is held to it from that date.</p>
      ${open.map((st) => html`
        <form class="banner" method="post" action="/admin/resolve/${st.id}">${csrfField(ctx)}
          <p>${claimFor(st)}</p>
          <p class="quiet">${st.has_public ? html`${st.speaker} · ` : 'Private saves only · '}${st.deadline_text ? html`“${st.deadline_text}” · ` : ''}${st.due ? `deadline ${when(st.due)}` : 'no deadline stated'}${st.has_public ? ` · ${st.saves} ${Number(st.saves) === 1 ? 'save' : 'saves'}` : ''} · ${st.status}${st.capture === 'backfill' ? ' · backfill' : ''}</p>
          ${publicTerms(st)}
          ${outcomeSelect(st.id, st.status)}
          <label for="e-${st.id}">Evidence link</label><input type="url" id="e-${st.id}" name="url">
          <label for="k-${st.id}">Outcome known on</label><input type="date" id="k-${st.id}" name="known" required>
          <label for="r-${st.id}">What happened</label><input type="text" id="r-${st.id}" name="note">
          <button type="submit">${st.status === 'open' ? 'Record outcome' : 'Change outcome'}</button>
        </form>`)}
    `), { kind: 'private' });
  });

  route('POST', /^\/admin\/terms\/(\d{1,18})$/, async (ctx) => {
    const form = await needPost(ctx);
    if (!form || !(await needAdmin(ctx))) return;
    await reviewerSetTerms(db, ctx.user, ctx.params[0], {
      deadlineAt: form.get('deadline') ? `${form.get('deadline')}T23:59:59Z` : null,
      probability: form.get('probability'),
      condition: form.get('condition'),
      speaker: form.get('speaker'),
      note: form.get('note'),
      correctionId: form.get('correction') || null,
    });
    redirect(ctx.res, '/admin');
  });

  route('POST', /^\/admin\/corrections\/(\d{1,18})\/reject$/, async (ctx) => {
    const form = await needPost(ctx);
    if (!form || !(await needAdmin(ctx))) return;
    await decideCorrection(db, ctx.params[0], { status: 'rejected', note: form.get('note') });
    redirect(ctx.res, '/admin');
  });

  route('GET', /^\/admin\/metrics\.json$/, async (ctx) => {
    if (!isAdmin(ctx.user)) return json(ctx.res, 404, { error: 'not_found' });
    json(ctx.res, 200, await metrics(db, { exclude: config.excludeXIds }), 'private');
  });

  route('POST', /^\/admin\/resolve\/(\d{1,18})$/, async (ctx) => {
    const form = await needPost(ctx);
    if (!form || !(await needAdmin(ctx))) return;
    await resolveStatement(db, {
      statementId: ctx.params[0],
      outcome: form.get('outcome'),
      note: form.get('note'),
      url: form.get('url'),
      reviewer: ctx.user,
      correctionId: form.get('correction') || null,
      outcomeAt: knownInstant(form.get('known')),
    });
    redirect(ctx.res, '/admin');
  });

  route('POST', /^\/admin\/editorial$/, async (ctx) => {
    const form = await needPost(ctx);
    if (!form || !(await needAdmin(ctx))) return;
    const intake = await editorialIntake(db, config, form.get('url'), { backfill: form.get('backfill') === '1' });
    redirect(ctx.res, `/admin/editorial/${intake.id}`);
  });

  route('GET', /^\/admin\/editorial\/(\d{1,18})$/, async (ctx) => {
    if (!(await needAdmin(ctx))) return;
    const desk = await ensureDesk(db);
    const intake = await db.one('select * from url_intakes where id = $1 and owner_x_user_id = $2', [ctx.params[0], desk.x_user_id]);
    if (!intake) return notFound(ctx);
    await pickerPage(ctx, intake, { action: `/admin/editorial/${intake.id}`, editorial: true });
  });

  route('POST', /^\/admin\/editorial\/(\d{1,18})$/, async (ctx) => {
    const form = await needPost(ctx);
    if (!form || !(await needAdmin(ctx))) return;
    const desk = await ensureDesk(db);
    const overrides = {};
    for (const index of form.all('pick')) {
      overrides[index] = { speaker: form.get(`speaker-${index}`), reportedSpeech: form.get(`quoted-${index}`) === '1' };
    }
    await selectCandidates(db, { ownerXUserId: desk.x_user_id, intakeId: ctx.params[0], indexes: form.all('pick'), editorial: true, overrides });
    redirect(ctx.res, '/desk');
  });

  registerBetRoutes({ route, db, config, layout, needUser, needAdmin, isAdmin, needPost, csrfField, send, redirect, notFound, fetchImpl, walletVersion: WALLET_VERSION, payVersion: PAY_VERSION, botUsername, chain: chainFor, quotes, allowHeavyRead, publicRuling });
  registerBetStartRoutes({ route, db, config, layout, send, redirect, botUsername, fileList, betLinesFor, publicRow, csp: CONTENT_SECURITY_POLICY });
  registerBetRulingRoutes({ route, db, config, layout, send, notFound, readRuling: readPublicRuling });
  registerCourtRoutes({ route, db, config, layout, send, notFound, chain: chainFor });
  registerBetEvidenceRoutes({ route, db, config, layout, needPost, csrfField, send, redirect, notFound, chain: chainFor, fetchImpl, walletVersion: WALLET_VERSION });
  registerPlayRoutes({ botUsername, route, db, config, layout, needUser, needPost, csrfField, send, redirect, notFound, chain: chainFor, quotes, payVersion: PAY_VERSION, allowHeavyRead });
  registerWalletRpc({ route, config, needUser, json, fetchImpl });
  registerShareRoutes({ route, db, config, notFound, headersFor });

  const https = config.baseUrl.startsWith('https://');
  return async function handle(req, res) {
    // Optional calls: some tests drive the handler with a minimal response double.
    res.setHeader?.('permissions-policy', PERMISSIONS_POLICY);
    if (https) res.setHeader?.('strict-transport-security', 'max-age=31536000; includeSubDomains');
    let url;
    try {
      url = new URL(req.url, config.baseUrl);
    } catch {
      // Node's parser accepts targets such as "http://[" that URL rejects: the client's error, not a crash.
      res.writeHead(400, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' });
      res.end('Bad request.');
      return;
    }
    const ctx = { req, res, url, params: [], user: null, session: null };
    try {
      const viewer = await viewerOf(req);
      ctx.user = viewer.user;
      ctx.session = viewer.session;
      for (const r of routes) {
        if (r.method !== req.method) continue;
        const m = url.pathname.match(r.pattern);
        if (!m) continue;
        ctx.params = m.slice(1);
        await r.fn(ctx);
        return;
      }
      await notFound(ctx);
    } catch (err) {
      if (res.headersSent) {
        res.end();
        return;
      }
      const status = err instanceof UserError ? err.status : 500;
      if (status >= 500) console.error(err);
      const message = err instanceof UserError ? err.message : 'Something failed on the server. Try again.';
      if (url.pathname.startsWith('/api/')) return json(res, status, { error: message }, 'private');
      let back = ctx.user ? '/me' : '/';
      try {
        const from = new URL(String(req.headers.referer || ''));
        if (from.origin === new URL(config.baseUrl).origin) back = from.pathname + from.search;
      } catch { /* No usable referrer: the default stands. */ }
      send(res, status, await layout(ctx, 'That didn’t work', html`
        <div class="hero"><h1>That didn’t work</h1></div>
        <p class="notice" role="alert">${message}</p>
        <div class="acts"><a class="pill solid big" href="${back}">Go back</a></div>`, { kind: 'private', flush: true, inboxBadge: false }), { kind: 'private' });
    }
  };
}

export function escapeForTests(value) {
  return esc(value);
}
