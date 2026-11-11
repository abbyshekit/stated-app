// Private article intake. The page is untrusted input: it is fetched with
// network guards, parsed as text, and never treated as instructions. Only the
// candidate sentences and the page metadata are stored, not the full article.

import { lookup as dnsLookup } from 'node:dns';
import http from 'node:http';
import https from 'node:https';
import net from 'node:net';
import { articleClaimCue, interpret } from './interpret.mjs';
import { addInbox, ensureDesk, UserError, userByXId } from './store.mjs';
import { insertSave, isXUrl, statusIdOf, upsertStatement, upsertXSource, upsertXStatement } from './intake.mjs';
import { INTAKES_PER_HOUR, intakesInLastHour } from './limits.mjs';
import { postFetcher, postText } from './xapi.mjs';
import { storesAllXText, xClaimText } from './xtext.mjs';

function v4Parts(addr) {
  return addr.split('.').map(Number);
}

export function isBlockedAddress(address) {
  let addr = String(address || '').toLowerCase();
  if (addr.startsWith('[') && addr.endsWith(']')) addr = addr.slice(1, -1);
  const mapped = addr.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
  if (mapped) addr = mapped[1];
  if (net.isIPv4(addr)) {
    const [a, b] = v4Parts(addr);
    return a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && b === 168)
      || (a === 192 && b === 0)
      || (a === 198 && (b === 18 || b === 19))
      || addr.startsWith('192.0.2.') || addr.startsWith('198.51.100.') || addr.startsWith('203.0.113.');
  }
  if (net.isIPv6(addr)) {
    // Also refused: IPv4-compatible (::a.b.c.d, ::7f00:1), site-local
    // fec0::/10, 6to4 2002::/16 and Teredo 2001:0::/32, which can carry an
    // internal IPv4 address.
    return addr === '::' || addr === '::1'
      || /^f[cd]/.test(addr) || /^fe[89a-f]/.test(addr) || /^ff/.test(addr)
      || addr.startsWith('64:ff9b:') || addr.startsWith('2001:db8') || addr.startsWith('::ffff:')
      || /^::(\d+\.\d+\.\d+\.\d+|[0-9a-f]{1,4}(:[0-9a-f]{1,4})?)$/.test(addr)
      || addr.startsWith('2002:') || /^2001:0?:/.test(addr) || addr.startsWith('2001::');
  }
  return true;
}

function isLoopback(address) {
  return /^127\./.test(address) || address === '::1' || address === '::ffff:127.0.0.1';
}

function guardedLookup(allowLoopback) {
  return (hostname, options, callback) => {
    dnsLookup(hostname, { ...options, all: true }, (err, addresses) => {
      if (err) return callback(err);
      const list = Array.isArray(addresses) ? addresses : [{ address: addresses, family: options.family || 4 }];
      const bad = list.find((a) => isBlockedAddress(a.address) && !(allowLoopback && isLoopback(a.address)));
      if (bad || !list.length) {
        const blocked = new Error(`Blocked address for ${hostname}.`);
        blocked.code = 'EBLOCKED';
        return callback(blocked);
      }
      if (options.all) return callback(null, list);
      return callback(null, list[0].address, list[0].family);
    });
  };
}

export function checkUrl(raw, { allowLoopback = false } = {}) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw new UserError('Paste a full link that starts with https://.');
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') throw new UserError('Paste a link that starts with https://.');
  if (url.username || url.password) throw new UserError('Links with a username or password are not accepted.');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  if (net.isIP(host) && isBlockedAddress(host) && !(allowLoopback && isLoopback(host))) {
    throw new UserError('That link points to a private network address.');
  }
  if (/^(localhost|.*\.local|.*\.internal)$/i.test(host) && !allowLoopback) {
    throw new UserError('That link points to a private network address.');
  }
  if (url.port && !['80', '443'].includes(url.port) && !allowLoopback) {
    throw new UserError('Only standard web ports are accepted.');
  }
  url.hash = '';
  return url;
}

function requestOnce(url, { allowLoopback, timeoutMs, maxBytes, userAgent, signal }) {
  return new Promise((done, fail) => {
    // `timeout` below is an idle timeout; this one bounds the whole request,
    // so a server that drips bytes cannot hold a worker.
    let timer = null;
    const resolve = (value) => {
      clearTimeout(timer);
      done(value);
    };
    const reject = (err) => {
      clearTimeout(timer);
      fail(err);
    };
    const lib = url.protocol === 'https:' ? https : http;
    const req = lib.request(url, {
      method: 'GET',
      signal,
      lookup: guardedLookup(allowLoopback),
      headers: {
        'user-agent': userAgent,
        accept: 'text/html,application/xhtml+xml,text/plain;q=0.8',
        'accept-encoding': 'identity',
      },
      timeout: timeoutMs,
    }, (res) => {
      const status = res.statusCode || 0;
      if (status >= 300 && status < 400) {
        res.resume();
        return resolve({ status, location: res.headers.location || '', headers: res.headers, body: '' });
      }
      const type = String(res.headers['content-type'] || '');
      if (status >= 200 && status < 300 && !/text\/html|application\/xhtml\+xml|text\/plain/i.test(type)) {
        res.destroy();
        return reject(new UserError('That link is not a web page.'));
      }
      let size = 0;
      const chunks = [];
      res.on('data', (chunk) => {
        size += chunk.length;
        if (size > maxBytes) {
          res.destroy();
          reject(new UserError('That page is too large to read.'));
          return;
        }
        chunks.push(chunk);
      });
      res.on('end', () => resolve({ status, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
      res.on('error', reject);
    });
    req.on('timeout', () => req.destroy(new UserError('The page took too long to respond.')));
    req.on('error', (err) => reject(err.code === 'EBLOCKED'
      ? new UserError('That link points to a private network address.')
      : err));
    timer = setTimeout(() => req.destroy(new UserError('The page took too long to respond.')), timeoutMs * 2);
    req.end();
  });
}

export async function safeFetch(raw, options = {}) {
  const opts = {
    allowLoopback: Boolean(options.allowLoopback),
    timeoutMs: options.timeoutMs || 8000,
    maxBytes: options.maxBytes || 2_000_000,
    userAgent: options.userAgent || 'StatedBot/0.1',
    signal: options.signal,
  };
  // X pages are never fetched as web pages, at the first hop or after a
  // redirect: X content comes only through the X API.
  const notX = (u) => {
    if (isXUrl(u.toString())) throw new UserError('X pages are not fetched directly. Paste a post link, which is read through the X API.');
    return u;
  };
  let url = notX(checkUrl(raw, opts));
  for (let hop = 0; hop <= 5; hop += 1) {
    opts.signal?.throwIfAborted();
    const res = await requestOnce(url, opts);
    if (res.status >= 300 && res.status < 400) {
      if (!res.location) throw new UserError('The page redirected without a destination.');
      url = notX(checkUrl(new URL(res.location, url).toString(), opts));
      continue;
    }
    if (res.status < 200 || res.status >= 300) throw new UserError(`The page returned status ${res.status}.`);
    return { url: url.toString(), body: res.body };
  }
  throw new UserError('The page redirected too many times.');
}

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…' };

function decode(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

function textOf(html) {
  return decode(String(html || '').replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function metaContent(html, attr, name) {
  const re = new RegExp(`<meta[^>]+${attr}=["']${name}["'][^>]*>`, 'i');
  const tag = html.match(re)?.[0];
  if (!tag) return null;
  return decode(tag.match(/content=["']([^"']*)["']/i)?.[1] || '') || null;
}

function jsonLd(html) {
  const out = {};
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    try {
      const data = JSON.parse(m[1]);
      const items = Array.isArray(data) ? data : (data['@graph'] || [data]);
      for (const item of items) {
        const author = Array.isArray(item.author) ? item.author[0] : item.author;
        if (!out.author && author) out.author = typeof author === 'string' ? author : author.name;
        if (!out.published && item.datePublished) out.published = item.datePublished;
        if (!out.headline && item.headline) out.headline = item.headline;
        if (!out.body && typeof item.articleBody === 'string' && item.articleBody.length > 200) out.body = item.articleBody;
      }
    } catch {
      // Malformed metadata is ignored, not repaired.
    }
  }
  return out;
}

// Chrome that never holds the story: navigation, headers, footers, sidebars,
// forms and dialogs are dropped before paragraphs are read.
const CHROME_BLOCKS = /<(nav|header|footer|aside|form|dialog|menu)(?=[\s>/])[^>]*>[\s\S]*?<\/\1>/gi;

// The outermost <article> elements, found by depth so an article nested in
// another (a related-story card) does not cut the outer one short.
function articleBlocks(html) {
  const blocks = [];
  let depth = 0;
  let start = -1;
  for (const m of html.matchAll(/<(\/?)article\b[^>]*>/gi)) {
    if (!m[1]) {
      if (depth === 0) start = m.index + m[0].length;
      depth += 1;
    } else if (depth > 0) {
      depth -= 1;
      if (depth === 0 && start >= 0) blocks.push(html.slice(start, m.index));
    }
  }
  return blocks;
}

const tokensOf = (s) => new Set(String(s || '').toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').split(/\s+/).filter((w) => w.length > 2));

// A page that carries several stories (a daily digest) gives each story a
// heading of the same level. When the title matches one of those headings and
// at least three other long headings share its level, only that story's
// section is read, up to the next heading of the same or a higher level.
function storySection(html, title) {
  const heads = [...html.matchAll(/<h([1-4])\b[^>]*>([\s\S]*?)<\/h\1>/gi)].map((m) => ({ at: m.index, end: m.index + m[0].length, level: Number(m[1]), text: textOf(m[2]) }));
  if (heads.length < 2 || !title) return html;
  const want = tokensOf(title);
  let best = null;
  for (const h of heads) {
    const got = tokensOf(h.text);
    let shared = 0;
    for (const w of got) if (want.has(w)) shared += 1;
    const score = shared / Math.max(1, Math.min(got.size, want.size));
    if (got.size >= 3 && score >= 0.6 && (!best || score > best.score)) best = { ...h, score };
  }
  if (!best) return html;
  // Story headlines run long; the section titles of one long document do not.
  const peers = heads.filter((h) => h !== best && h.level === best.level);
  const siblings = peers.filter((h) => h.text.length >= 45);
  if (best.text.length < 45 || siblings.length < 3 || siblings.length < 0.75 * peers.length) return html;
  const next = heads.find((h) => h.at > best.end && h.level <= best.level);
  return html.slice(best.end, next ? next.at : html.length);
}

function paragraphsIn(html) {
  const out = [];
  // List items count when they read as sentences: body text sits in <li> on pages that bullet their points.
  for (const m of html.matchAll(/<(p|li)\b[^>]*>([\s\S]*?)<\/\1>/gi)) {
    const t = textOf(m[2]);
    const keep = m[1].toLowerCase() === 'p' ? t.length > 30 : (t.length >= 100 && /[.!?”"]\s*$|\.\s+[A-Z]/.test(t));
    if (keep && out[out.length - 1] !== t) out.push(t);
  }
  return out;
}

// Long text that is not in <p> tags (a story in one <div> or <span>).
function blockTexts(html) {
  const lines = decode(html.replace(/<\/(?:p|h[1-6]|li|blockquote|td|tr|div|section|article|figcaption|ul|ol|table)>|<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, ' ')).split('\n');
  return lines.map((l) => l.replace(/\s+/g, ' ').trim()).filter((l) => l.length >= 300);
}

const lengthOf = (list) => list.reduce((n, p) => n + p.length, 0);

export function extractArticle(html, finalUrl) {
  const source = String(html || '');
  const ld = jsonLd(source);
  const clean = source
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|template|svg)[\s\S]*?<\/\1>/gi, ' ');
  const canonical = clean.match(/<link[^>]+rel=["']canonical["'][^>]*>/i)?.[0]?.match(/href=["']([^"']+)["']/i)?.[1];
  const title = metaContent(clean, 'property', 'og:title') || ld.headline || textOf(clean.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1] || '') || null;
  const byline = metaContent(clean, 'name', 'author') || metaContent(clean, 'property', 'article:author') || ld.author || null;
  const published = metaContent(clean, 'property', 'article:published_time') || ld.published
    || clean.match(/<time[^>]+datetime=["']([^"']+)["']/i)?.[1] || null;
  const site = metaContent(clean, 'property', 'og:site_name') || new URL(finalUrl).hostname.replace(/^www\./, '');

  // Read the story, not the page: the article element with the most paragraph
  // text, cut to the section the title names, with page chrome removed.
  const stripped = clean.replace(CHROME_BLOCKS, ' ');
  const articles = articleBlocks(stripped).map((h) => ({ h, n: lengthOf(paragraphsIn(h)) })).sort((a, b) => b.n - a.n);
  const scope = articles.length && articles[0].n >= 300 ? articles[0].h : stripped;
  let paragraphs = paragraphsIn(storySection(scope, title));
  if (lengthOf(paragraphs) < 300 && scope !== stripped) paragraphs = paragraphsIn(storySection(stripped, title));
  let from = 'paragraphs';
  // Structured data carries the full text on some pages that hide it from <p> tags.
  if (ld.body && lengthOf(paragraphs) < 0.6 * ld.body.length) {
    paragraphs = ld.body.split(/\n+/).map((p) => p.replace(/\s+/g, ' ').trim()).filter((p) => p.length > 30);
    from = 'structured-data';
  }
  if (lengthOf(paragraphs) < 1500) {
    const have = paragraphs.join(' ');
    const extra = blockTexts(storySection(scope, title)).filter((b) => !have.includes(b.slice(0, 80)));
    if (extra.length && lengthOf(extra) > lengthOf(paragraphs)) { paragraphs = extra; from = 'text-blocks'; }
  }
  if (!paragraphs.length) paragraphs = [textOf(clean.match(/<body[^>]*>([\s\S]*)<\/body>/i)?.[1] || clean)];
  let canonicalUrl = finalUrl;
  try {
    if (canonical) canonicalUrl = new URL(canonical, finalUrl).toString();
  } catch {
    canonicalUrl = finalUrl;
  }
  const publishedAt = published && !Number.isNaN(Date.parse(published)) ? new Date(published) : null;
  return {
    title, byline: byline ? textOf(byline).replace(/,(?=\S)/g, ', ') : null, site, publishedAt, canonicalUrl, paragraphs, paragraphsFrom: from,
  };
}

// ---------------------------------------------------------------------------
// Attribution. A sentence is the writer's unless a frame names another speaker:
// a quotation followed or preceded by a speech verb, "X said/expects/sees ...",
// "according to X", a pronoun continuing a named speaker in the same paragraph,
// or a survey group as the subject. The saver is never a candidate speaker.

const CAPW = "(?:[A-Z][\\w.&'’-]*)";
const ROLE = '(?:analysts?|economists?|strategists?|researchers?|panelists?|respondents?|forecasters?|officials?|scientists?|executives?|engineers?|investors?|survey|panel|team|authors?|leaders?|experts?|insiders?|staff|CEO|CFO|COO|CTO|president|chair|chairman|governor|professor|founder|co-?founder|director|chief \\w+(?: \\w+)?)';
const NAME = `(?:the\\s+(?:\\d+\\s+)?(?:${CAPW}\\s+)*${ROLE}|${CAPW}(?:\\s+(?:(?:of|and|&|for|the|de|van|von|at)\\s+)?${CAPW}|\\s+(?:[a-z-]+\\s+)?${ROLE}){0,7})`;
const SAYV = "(?:shows?|showed|writes|said|says|told\\s+[\\w ,]{1,40}?|wrote|writes|predicted|predicts|expect(?:s|ed|ing)?|forecasts?|forecasted|sees?|saw|believes?|believed|thinks?|thought|warned|warns|argued|argues|estimates?|estimated|projects?|projected|anticipates?|cited|put|puts|named|noted|notes|added|adds|pointed out|reckons?|declared|stated|suggests?|suggested|claims?|claimed|calls?|called|reiterated|reaffirmed|flagged|acknowledges?|admits?|asserted|insists?|promised|vowed|revised|raised|lifted|describes?|described|posted|replied|announced|has\\s+(?:said|predicted|warned|argued)|have\\s+(?:said|predicted|warned|argued))";
const SAYCONT = '(?:predicting|expecting|forecasting|saying|warning|arguing|projecting|anticipating|suggesting)';
const NOT_PERSON = /\b(Prize|Summit|Times|Street|Journal|Magazine|Council|Committee|Index|Bank|Fed|Reserve|Report|Survey|Act|Law|Court|University|Institute|Labs?|Group|Company|Inc|Corp|Fund|Project|Test|Accord|Agency|Department)\b/;
const STOP_NAME = /^(?:The|This|That|These|Those|It|He|She|They|We|I|In|On|At|A|An|But|And|So|If|As|For|With|While|When|There|Here|What|Who|Why|How|Some|Many|Most|All|Both|One|His|Her|Their|Its|Our|My|Now|Then|However|Still|Yet|Meanwhile|Of|To|Despite|Amid|After|Before|Following|Under|Over|Since)$/;

const RE_QUOTE_THEN_NAME = new RegExp(`[”"],?\\s+(${NAME})\\s+(?:(?:also|now|later|then)\\s+)?${SAYV}\\b`);
const RE_QUOTE_THEN_VERB = new RegExp(`[”"],?\\s+${SAYV}\\s+(${NAME})\\b`);
const RE_NAME_FIRST = new RegExp(`^(?:(?:But|And|However|Still|Now|Then|Meanwhile|Yet|So|Even),?\\s+)?(?:[A-Z][^,.;“”"]{0,40},\\s+)?(?:[“"][^”"]{0,120}[”"],?\\s+)?(${NAME})\\s+(?:(?:also|now|has|have|had|previously|recently|still|later|again|already)\\s+)*(?:${SAYV}|(?:are|is|have been|has been)\\s+(?:already\\s+|now\\s+)?${SAYCONT})\\b`);
const RE_APPOS = new RegExp(`^(${NAME})\\s*,\\s[^.;]{3,160}?,\\s+(?:(?:now|also|has|have|previously|recently|still|later|again|already)\\s+)*${SAYV}\\b`);
const RE_LOOSE = new RegExp(`^(${NAME})\\b[^.;]{0,80}?\\b(?:who|that)\\s+(?:has|have)\\s+(?:also\\s+)?(?:said|predicted|argued|warned)\\b`);
const RE_PRONOUN_SAY = /(?:[”"],?\s+|,\s*)(?:he|she|they)\s+(?:said|wrote|added|noted|told|warned|argued|predicted|put)\b|\b(?:he|she|they)\s+(?:has\s+|have\s+|had\s+)?(?:previously\s+|also\s+|recently\s+|earlier\s+)?(?:declared|stated|argued|predicted|warned|claimed|suggested|said)\b/;
const RE_PRONOUN_FIRST = new RegExp(`^(?:(?:But|And|Still|Now|Then|Yet),?\\s+)?(?:He|She|They)\\s+(?:(?:also|now|has|have|had|previously|recently|still|later|again|already)\\s+)*${SAYV}\\b`);
const RE_SURVEY_ANY = /\b((?:[A-Z][\w&.-]*\s+){0,3}(?:Survey|Poll))\b[^.]{0,90}?\b(?:showed|shows|found|finds)\b/;
const RE_GROUP_MID = /(?:,|—|-)\s*(respondents|panelists|forecasters|economists|analysts|strategists)\s+(?:still\s+|also\s+|now\s+|generally\s+|in aggregate\s+)?(?:see|expect|anticipate|forecast|predict|say|believe|put)\b/i;
const RE_ACCORDING = new RegExp(`\\b(?:according to|per|as reported by)\\s+(?:the\\s+)?(?:latest\\s+)?(${NAME})`);
const RE_TRAILING = new RegExp(`,\\s*(${NAME})\\s+(?:said|says|told[\\w ,]{1,40}|wrote|added|noted|warned|predicted)\\b`);
const RE_MID = new RegExp(`\\b(${NAME})\\s+${SAYV}\\s+(?:that\\b|at\\b|in\\s+(?:a|an|the)\\b|[“"])`);
const RE_TITLE_TRAILING = new RegExp(`,\\s*(${NAME})\\s+(?:thinks|believes|says|warns|predicts|expects|argues)\\.?$`);
const RE_SURVEY = /^(?:But\s+|And\s+)?(?:(?:the|The)\s+)?(?:(?:latest|new|latest\s+\w+)\s+)?((?:[A-Z][\w&.-]*\s+){0,4}(?:Survey|Poll|Outlook|Panel))(?:\s+(?:of\s+\d+\s+\w+(?:\s+\w+)?|panel))?\s+(?:shows?|showed|found|finds?|says?|said|suggests?|indicates?|sees?|expects?|foresees?)\b/;
const RE_GROUP = /^(?:But\s+|And\s+|However,\s+)?(?:(?:the|The)\s+)?(?:\d+\s+|latest\s+|CNBC\s+Fed\s+Survey\s+)*(respondents|panelists|forecasters|economists|analysts|strategists|survey respondents)\b/i;
const RE_SHARE = /^(?:But\s+|And\s+|However,\s+|Yet\s+)?(?:\d+(?:\.\d+)?\s?%|(?:More|Nearly|Almost|Just|Only)\s+(?:than\s+)?(?:half|a third|two[- ]thirds|nine in ten|one in \w+)|(?:Forty|Fifty|Sixty|Seventy|Eighty|Ninety|Thirty|Twenty)(?:[- ]\w+)?\s+percent|(?:A|The)\s+(?:majority|plurality|minority))\s+(?:of\s+(?:the\s+)?(?:respondents|panelists|economists|forecasters|those surveyed)\s+)?(?:do\s+|also\s+|now\s+|still\s+)?(?:expect|anticipate|say|see|believe|think|predict|forecast|put)/i;

function cleanName(raw) {
  let name = raw.replace(/\s+/g, ' ').trim().replace(/^(?:The|But|And|However|Still|Now|Then|Meanwhile|Yet|So|Even)\s+(?=[A-Z])/, '');
  if (STOP_NAME.test(name) || name.length < 2) return null;
  return name.replace(/['’]s$/, '');
}

const letters = (s) => String(s || '').toLowerCase().replace(/[^a-z]/g, '');

// Is this name the page's own publisher or author, and nothing more? Then the
// claim is the writer's. A quoted person who works for the publisher is not.
const ORG_WORDS = new Set(['global', 'research', 'team', 'analysts', 'economists', 'strategists', 'staff', 'desk', 'newsroom', 'editors', 'the', 'company', 'institute', 'group']);
function isWriter(name, article) {
  if (/survey|respondents|panel|poll/i.test(name)) return false;
  const core = letters(name.split(/\s+/).filter((w) => !ORG_WORDS.has(w.toLowerCase())).join(' '));
  const site = letters(String(article.site || '').replace(/\.(com|org|net|co|io|ai|uk)$/i, ''));
  const names = [String(article.byline || ''), ...String(article.byline || '').split(/[;,]| and /)].map(letters).filter((p) => p.length > 4);
  if (site.length > 3 && core.length > 3 && (core === site || (core.includes(site) && core.length - site.length <= 3) || site.includes(core))) return true;
  return names.some((n) => core === n || core.includes(n) || n.includes(core));
}

// In an article that reports a survey, unattributed passive forecasts ("is seen", "are forecast", "is expected to") are the survey's.
const PASSIVE_FORECAST = /\b(?:is|are)\s+(?:seen|forecast|projected|expected|predicted)\b|\bforecasts? of\b|\boutlook for\b|\b(?:put|puts)\s+the\s+(?:risk|odds|probability)\b|\bsee\s+the\b/;

// The speaker of one sentence, or null for the writer.
export function attributionOf(sentence, ctx = {}) {
  const t = sentence;
  const hit = (name, via) => {
    const speaker = cleanName(name);
    if (!speaker) return null;
    // "the analyst wrote" names a role; the person is whoever the paragraph just named.
    if (/^(?:the\s+)?(?:\w+\s+)?(?:analyst|economist|strategist|researcher|expert|official|executive|spokesperson|CEO|chair)$/i.test(speaker) && (ctx.lastSpeaker || ctx.lastName)) return { speaker: ctx.lastSpeaker || ctx.lastName, via };
    return { speaker, via };
  };
  let m;
  let found = null;
  if (ctx.title && (m = t.match(RE_TITLE_TRAILING))) found = hit(m[1], 'title');
  if (!found && (m = t.match(RE_QUOTE_THEN_NAME))) found = hit(m[1], 'quote-name');
  if (!found && (m = t.match(RE_QUOTE_THEN_VERB))) found = hit(m[1], 'quote-verb');
  if (!found && (m = t.match(RE_NAME_FIRST))) found = hit(m[1], 'name-first');
  if (!found && (m = t.match(RE_APPOS))) found = hit(m[1], 'appositive');
  if (!found && (m = t.match(RE_LOOSE))) found = hit(m[1], 'loose');
  if (!found && (m = t.match(RE_ACCORDING))) found = hit(m[1], 'according-to');
  if (!found && (m = t.match(RE_TRAILING))) found = hit(m[1], 'trailing');
  if (!found && (m = t.match(RE_MID))) found = hit(m[1], 'mid');
  if (!found && (m = t.match(RE_SURVEY))) found = { speaker: m[1], via: 'survey' };
  if (!found && (m = t.match(RE_SURVEY_ANY))) found = { speaker: m[1].replace(/^The\s+/, ''), via: 'survey' };
  if (!found && (m = t.match(RE_GROUP))) found = { speaker: m[1].toLowerCase() === 'survey respondents' ? 'respondents' : m[1].toLowerCase(), via: 'group' };
  if (!found && (m = t.match(RE_GROUP_MID))) found = { speaker: m[1].toLowerCase(), via: 'group' };
  if (!found && RE_SHARE.test(t)) found = { speaker: 'respondents', via: 'share' };
  if (!found && (ctx.lastSpeaker || ctx.lastName) && RE_PRONOUN_SAY.test(t)) found = { speaker: ctx.lastSpeaker || ctx.lastName, via: 'pronoun-say' };
  if (!found && ctx.lastSpeaker && /^(?:(?:But|And|Yet|However|Still),?\s+)?[“"]/.test(t) && !/[”"]\s*,?\s+(?:he|she|they|[A-Z])/.test(t)) found = { speaker: ctx.lastSpeaker, via: 'quote-continues' };
  if (!found && ctx.surveyName && PASSIVE_FORECAST.test(t)) found = { speaker: ctx.surveyName, via: 'survey-context' };
  if (!found && (ctx.lastSpeaker || ctx.lastName) && RE_PRONOUN_FIRST.test(t)) found = { speaker: ctx.lastSpeaker || ctx.lastName, via: 'pronoun' };
  if (!found && ctx.lastSpeaker && /^(?:His|Her|Their)\b/.test(t)) found = { speaker: ctx.lastSpeaker, via: 'pronoun' };
  if (!found && ctx.quoteCarry && /^[“"]/.test(t)) found = { speaker: ctx.quoteCarry, via: 'quote-carry' };
  if (found && !['group', 'share', 'survey', 'survey-context'].includes(found.via) && isWriter(found.speaker, ctx.article || {})) return null;
  return found;
}

// Sentence splitting that keeps decimals, initials and abbreviations whole,
// and joins a quotation that a full stop split in two.
const ABBREV = /\b(U\.S|U\.K|U\.N|E\.U|Mr|Mrs|Ms|Dr|Prof|Inc|Corp|Co|Ltd|vs|No|St|Jr|Sr|e\.g|i\.e|a\.m|p\.m|J\.P|D\.C|Gov|Sen|Rep|Gen|Lt|Fig|approx|est)\./g;

export function sentencesIn(paragraph) {
  const guarded = paragraph.replace(ABBREV, '$1§').replace(/\b([A-Z])\.(?=\s?[A-Z]\b)/g, '$1§');
  const raw = guarded.split(/(?<=[.!?]["”’)]*)\s+(?=["“‘(]?[A-Z0-9$])/).map((s) => s.replace(/§/g, '.').replace(/\s+/g, ' ').trim()).filter(Boolean);
  const out = [];
  for (let i = 0; i < raw.length; i += 1) {
    let s = raw[i];
    const open = (x) => (x.match(/[“]/g) || []).length - (x.match(/[”]/g) || []).length;
    const straight = (x) => (x.match(/"/g) || []).length % 2;
    let guard = 0;
    while ((open(s) > 0 || straight(s)) && i + 1 < raw.length && guard < 3 && s.length < 600) {
      i += 1; guard += 1;
      s = `${s} ${raw[i]}`;
    }
    out.push(s);
  }
  return out;
}

function looksLikeTranscript(article) {
  const paragraphs = article.paragraphs;
  const questions = paragraphs.filter((p) => p.endsWith('?')).length;
  return paragraphs.length >= 30 && questions >= 8 && questions / paragraphs.length >= 0.1;
}

export function candidatesFrom(article, limit = 15) {
  const publishedAt = article.publishedAt || new Date();
  const writer = article.byline || article.site;
  const transcript = looksLikeTranscript(article);
  const interviewee = transcript ? cleanName(String(article.title || '').match(new RegExp(`^(${CAPW}(?:\\s+${CAPW}){1,2})`))?.[1] || '') : null;
  // A page about a survey names it near the top; passive forecasts then belong to it.
  const lead = `${article.title || ''} ${article.paragraphs.slice(0, 4).join(' ')}`;
  const surveyName = /\b(?:survey|poll|outlook survey|panel)\b/i.test(article.title || '')
    ? (lead.match(/\b((?:[A-Z][\w&.-]*\s+){0,4}(?:Survey|Poll))\b/)?.[1] || null)
    : null;
  const all = [];
  const seen = new Set();

  const consider = (text, location, ctx) => {
    if (text.length < 25 || text.length > 700 || text.endsWith('?') || seen.has(text)) return null;
    const att = attributionOf(text, { ...ctx, article, surveyName, title: location === 'title' });
    const cue = articleClaimCue(text, { attributed: Boolean(att), publishedAt, title: location === 'title', survey: Boolean(surveyName) });
    if (!cue.predictive) return null;
    seen.add(text);
    let speaker = writer;
    let reportedSpeech = false;
    let speakerUncertain = false;
    if (att) {
      speaker = att.speaker;
      reportedSpeech = true;
    } else if (transcript && interviewee && ctx.firstPerson) {
      speaker = interviewee;
      reportedSpeech = true;
      speakerUncertain = true;
    }
    const terms = interpret(text, publishedAt);
    const candidate = {
      index: 0, text, speaker, reportedSpeech,
      deadlineText: terms.deadlineText, proposedDeadlineAt: terms.proposedDeadlineAt,
      probability: terms.probability, condition: terms.condition, hedges: terms.hedges,
      strength: cue.strength + (att ? 1 : 0) + (terms.deadlineText ? 1 : 0),
    };
    if (location === 'title') candidate.location = 'title';
    if (speakerUncertain) candidate.speakerUncertain = true;
    all.push(candidate);
    return att;
  };

  if (article.title) consider(article.title.trim(), 'title', {});

  let previous = null;
  let lastName = null;
  for (const paragraph of article.paragraphs) {
    let lastSpeaker = null;
    let quoteCarry = null;
    if (/^[“"]/.test(paragraph) && previous) quoteCarry = previous;
    const firstPerson = transcript && !paragraph.endsWith('?') && /\b(?:I|I’m|I'm|I’d|I'd|I’ve|I've|we|We|my|our|us)\b/.test(paragraph);
    for (const sentence of sentencesIn(paragraph)) {
      const att = consider(sentence, 'body', { lastSpeaker, quoteCarry, lastName, firstPerson });
      const named = attributionOf(sentence, { article, surveyName: null });
      if (named && !['pronoun', 'quote-carry', 'pronoun-say', 'quote-continues'].includes(named.via)) lastSpeaker = named.speaker;
      else if (att && !['pronoun', 'pronoun-say', 'quote-continues'].includes(att.via)) lastSpeaker = att.speaker;
      const person = sentence.match(/^(?:(?:But|And|Still|Now|Then|Yet|Even),?\s+)?([A-Z][a-z’'-]+(?:\s+(?:van|von|de|Van|Von|De)?\s*[A-Z][a-z’'-]+){0,2})(?=\s*,|\s+(?:is|was|has|had|said|says|told|wrote|believes|thinks|expects|predicted|argues|put|named|pointed|added|warned|also|now|still|recently|[a-z]+s)\b)/)?.[1];
      if (person && !STOP_NAME.test(person.split(' ')[0]) && !NOT_PERSON.test(person)) lastName = person;
    }
    previous = lastSpeaker;
  }

  // The cap keeps the strongest candidates, in page order, and says how many it left out.
  let kept = all;
  if (all.length > limit) {
    const ranked = all.map((c, i) => ({ c, i })).sort((a, b) => b.c.strength - a.c.strength || a.i - b.i).slice(0, limit);
    kept = ranked.sort((a, b) => a.i - b.i).map((r) => r.c);
  }
  kept.forEach((c, i) => { c.index = i; });
  Object.defineProperty(kept, 'total', { value: all.length, enumerable: false });
  return kept;
}

// A page's canonical address is accepted only when it names the page that was
// fetched (after redirects), differing at most in query, fragment, a
// trailing slash or "www.". Anything else could let one page on a shared
// host claim another page's record, so the record is keyed on the fetched
// address instead.
export function sameSiteCanonical(canonical, fetchedUrl) {
  if (!/^https?:\/\//i.test(String(canonical || ''))) return fetchedUrl;
  const key = (u) => {
    try {
      const p = new URL(u);
      return `${p.hostname.replace(/^www\./, '').replace(/\.+$/, '')}${p.pathname.replace(/\/+$/, '') || '/'}`;
    } catch {
      return null;
    }
  };
  return key(canonical) && key(canonical) === key(fetchedUrl) ? canonical : fetchedUrl;
}

export async function createIntake(db, { ownerXUserId, url, route }) {
  return db.one(
    `insert into url_intakes (owner_x_user_id, url, route, status) values ($1, $2, $3, 'queued') returning *`,
    [ownerXUserId, url, route],
  );
}

export async function runIntake(db, config, intakeId) {
  const intake = await db.one('select * from url_intakes where id = $1', [intakeId]);
  if (!intake || intake.status !== 'queued') return intake;
  try {
    const page = await safeFetch(intake.url, {
      allowLoopback: config.fetch.allowLoopback,
      timeoutMs: config.fetch.timeoutMs,
      maxBytes: config.fetch.maxBytes,
      userAgent: `StatedBot/0.1 (+${config.baseUrl})`,
    });
    const article = extractArticle(page.body, page.url);
    // The record is keyed on the page's own address (or its canonical form,
    // when that names the same page). An existing record's title, author and
    // text are never changed by a later fetch.
    article.canonicalUrl = sameSiteCanonical(article.canonicalUrl, page.url);
    const candidates = candidatesFrom(article);
    const source = await db.one(
      `insert into sources (platform, platform_id, url, author_name, title, text, published_at, acquisition)
       values ('web', $1, $2, $3, $4, $5, $6, $7)
       on conflict (platform, platform_id) do update set platform_id = sources.platform_id
       returning *`,
      [
        article.canonicalUrl,
        article.canonicalUrl,
        article.byline,
        article.title,
        candidates.map((c) => c.text).join('\n'),
        article.publishedAt,
        intake.route === 'editorial' ? 'editorial' : 'url_intake',
      ],
    );
    const updated = await db.one(
      `update url_intakes set status = 'fetched', source_id = $2, candidates = $3 where id = $1 returning *`,
      [intake.id, source.id, JSON.stringify(candidates)],
    );
    if (intake.route !== 'editorial') {
      await addInbox(db, {
        ownerXUserId: intake.owner_x_user_id,
        kind: 'pick_predictions',
        intakeId: intake.id,
        body: candidates.length
          ? `Found ${candidates.length} possible ${candidates.length === 1 ? 'prediction' : 'predictions'} in “${article.title || article.canonicalUrl}”. Pick the ones to follow.`
          : `No predictions found in “${article.title || article.canonicalUrl}”.`,
        dedupeKey: `pick:${intake.id}`,
      });
    }
    return updated;
  } catch (err) {
    const message = err instanceof UserError ? err.message : 'Unable to read that page.';
    const failed = await db.one(
      `update url_intakes set status = 'failed', error = $2 where id = $1 returning *`,
      [intake.id, message],
    );
    if (intake.route !== 'editorial') {
      await addInbox(db, {
        ownerXUserId: intake.owner_x_user_id,
        kind: 'pick_predictions',
        intakeId: intake.id,
        body: `Unable to read ${intake.url}. ${message}`,
        dedupeKey: `pick:${intake.id}`,
      });
    }
    return failed;
  }
}

// Picked predictions go to Following, attributed to the speaker in the
// article. The saver is never recorded as the author. On the desk a reviewer
// may correct the extracted attribution (`overrides[index] = { speaker,
// reportedSpeech }`), kept in the record's history, and may mark a single
// pick as backfill (`backfill: true`) when its outcome is already known.
export async function selectCandidates(db, { ownerXUserId, intakeId, indexes, editorial = false, overrides = {} }) {
  const chosen = new Set((indexes || []).map(Number));
  return db.tx(async (tx) => {
    const intake = await tx.one('select * from url_intakes where id = $1 and owner_x_user_id = $2 for update', [intakeId, ownerXUserId]);
    if (!intake) throw new UserError('That link is not in your inbox.', 404);
    if (intake.status !== 'fetched') throw new UserError('That link has no predictions to pick.');
    const source = await tx.one('select * from sources where id = $1', [intake.source_id]);
    const owner = editorial
      ? await tx.one('select * from users where x_user_id = $1', [ownerXUserId])
      : await tx.one(`select * from users where x_user_id = $1 and kind = 'person'`, [ownerXUserId]);
    const saves = [];
    for (const candidate of intake.candidates) {
      if (!chosen.has(Number(candidate.index))) continue;
      const fix = editorial ? overrides[candidate.index] : null;
      const backfill = Boolean(intake.backfill) || Boolean(fix?.backfill);
      let statement = await upsertStatement(tx, source, {
        span: candidate.text,
        speaker: candidate.speaker,
        reportedSpeech: candidate.reportedSpeech,
        publishedAt: source.published_at || new Date(),
        backfill,
      });
      const speaker = String(fix?.speaker || '').trim();
      if (speaker && (speaker !== statement.speaker || Boolean(fix.reportedSpeech) !== statement.reported_speech)) {
        statement = await tx.one(
          `update statements set speaker = $2, reported_speech = $3 where id = $1 returning *`,
          [statement.id, speaker.slice(0, 120), Boolean(fix.reportedSpeech)],
        );
        await tx.query(
          `insert into revisions (statement_id, kind, actor, before, after, note) values ($1, 'attribution', 'reviewer', $2, $3, $4)`,
          [
            statement.id,
            { speaker: candidate.speaker, reportedSpeech: candidate.reportedSpeech },
            { speaker: statement.speaker, reportedSpeech: statement.reported_speech },
            'Attribution checked against the article in review.',
          ],
        );
      }
      // A link tracked privately stays private whatever the profile's default;
      // the owner publishes a pick from its page if they want to.
      const visibility = editorial ? 'public' : 'private';
      const { save } = await insertSave(tx, {
        ownerXUserId,
        owner,
        statement,
        relation: 'following',
        visibility,
        intake: editorial ? 'editorial' : (intake.route === 'dm' ? 'dm' : 'url'),
        backfill,
        source,
      });
      saves.push(save);
    }
    await tx.query(`update url_intakes set status = 'selected' where id = $1`, [intake.id]);
    await tx.query(`update inbox set done_at = now() where intake_id = $1 and done_at is null`, [intake.id]);
    return saves;
  });
}

// `backfill` marks a historical collection: its records are labelled and
// never treated as forecasts captured before the outcome.
export async function editorialIntake(db, config, url, { backfill = false } = {}) {
  const desk = await ensureDesk(db);
  checkUrl(url, { allowLoopback: config.fetch.allowLoopback });
  const intake = await createIntake(db, { ownerXUserId: desk.x_user_id, url, route: 'editorial' });
  if (backfill) await db.query('update url_intakes set backfill = true where id = $1', [intake.id]);
  return runIntake(db, config, intake.id);
}

export { INTAKES_PER_HOUR };

// A post link is read through the X API, never fetched as a web page, and
// saved privately. Without a connected bot it is refused with a clear reason.
async function saveXLink(db, config, owner, url, x) {
  const id = statusIdOf(url);
  if (!x) {
    throw new UserError('Stated reads X posts through its X connection, which is not set up on this server yet. Tag the bot under the post on X instead.', 503);
  }
  const fetched = await postFetcher(x)(id);
  if (!fetched) throw new UserError('Unable to read that post. It may be deleted, or from a protected account.');
  const bot = await x.identity();
  await db.query(`insert into url_intakes (owner_x_user_id, url, route, status) values ($1, $2, 'web', 'selected')`, [owner.x_user_id, url]);
  return db.tx(async (tx) => {
    const keepWords = storesAllXText(config);
    const body = postText(fetched.post);
    const source = await upsertXSource(tx, fetched.post, fetched.author, 'mention', { text: keepWords ? body : '' });
    const statement = await upsertXStatement(tx, source, {
      claim: xClaimText(body, bot.username),
      keepWords,
      speaker: fetched.author?.username ? `@${fetched.author.username}` : 'Unknown author',
      speakerXUserId: fetched.post.author_id,
      publishedAt: fetched.post.created_at ? new Date(fetched.post.created_at) : new Date(),
    });
    const { save, created } = await insertSave(tx, {
      ownerXUserId: owner.x_user_id,
      owner,
      statement,
      relation: fetched.post.author_id === owner.x_user_id ? 'mine' : 'following',
      visibility: 'private',
      intake: 'url',
      source,
    });
    return { kind: 'x', save, created };
  });
}

export async function personIntake(db, config, user, url, route = 'web', { x = null } = {}) {
  checkUrl(url, { allowLoopback: config.fetch.allowLoopback });
  const owner = await userByXId(db, user.x_user_id);
  if (!owner) throw new UserError('Sign in first.', 401);
  if ((await intakesInLastHour(db, owner.x_user_id)) >= INTAKES_PER_HOUR) {
    throw new UserError(`You have tracked ${INTAKES_PER_HOUR} links in the last hour. Try again later.`, 429);
  }
  if (statusIdOf(url)) return saveXLink(db, config, owner, url, x);
  if (isXUrl(url)) throw new UserError('Paste a link to a single post (x.com/…/status/…) or to an article.');
  const intake = await createIntake(db, { ownerXUserId: owner.x_user_id, url, route });
  return runIntake(db, config, intake.id);
}
