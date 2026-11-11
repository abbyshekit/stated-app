// Which X post text Stated stores, and how the owner sees a post whose text
// is not stored. Isolated here so the policy has one switch
// (STATED_X_TEXT_POLICY=all is the explicit opt-out).
//
// 'public-only' (default, approved by the owner of the product): a private
// save keeps the post ID, link, author IDs and the reading of its terms
// (dates, numbers, hedge words), but not the words of the post. Words are
// stored only while at least one public save shows the post, and those
// records are re-checked against X every day. An owner sees a private post's
// words only by asking for that one post: the server then reads it from X's
// oEmbed endpoint, through a cache shared by all users that keeps words for
// at most one hour and never writes them to the database. A check that finds
// the post protected or deleted drops that copy immediately. Until that
// check, a cached copy can remain for the rest of the hour.

import { interpret, stripForClaim } from './interpret.mjs';
import { PUBLIC_SAVE_SQL } from './privacy.mjs';
import { goneOnX, postText } from './xapi.mjs';

export function storesAllXText(config) {
  return config.x.textPolicy === 'all';
}

export function placeholderSpan(postId) {
  return `X post ${postId}`;
}

export function isPlaceholder(row) {
  return row.platform === 'x' && (!row.span || /^X post \d+$/.test(row.span) || /^Post removed on X/.test(row.span));
}

// One normalisation for every path, so the same post always yields the same
// claim text: the reply prefix, the bot's handle and the #public/#private
// commands are removed; no other word is.
export function xClaimText(text, botUsername) {
  let t = stripForClaim(String(text || ''));
  if (botUsername) t = t.replace(new RegExp(`@${botUsername}\\b`, 'gi'), ' ');
  t = t.replace(/(^|\s)#(?:public|private)\b/gi, ' ');
  return t.replace(/\s+/g, ' ').trim();
}

// The reading of a post's terms. Fragments of the post's words are kept only
// when the text itself may be stored.
export function readTerms(text, publishedAt, { keepWords }) {
  const terms = interpret(text, publishedAt);
  return {
    deadlineText: keepWords ? terms.deadlineText : null,
    proposedDeadlineAt: terms.proposedDeadlineAt,
    probability: terms.probability,
    condition: keepWords ? terms.condition : null,
    hedges: terms.hedges,
  };
}

// --- oEmbed -----------------------------------------------------------------

// Keyed by post ID and shared by every user, so a second owner asking for
// the same post causes no request. Words are kept at most 24 hours, so a
// deletion on X is honoured within a day; a failure is kept 10 minutes.
const cache = new Map();
const CACHE_MS = 60 * 60 * 1000;
const FAIL_MS = 10 * 60 * 1000;
const CACHE_MAX = 20_000;

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', mdash: '—', hellip: '…' };

function decode(text) {
  return String(text || '')
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&([a-z]+);/gi, (m, name) => ENTITIES[name.toLowerCase()] ?? m);
}

export function parseOembed(json) {
  const html = String(json?.html || '');
  const para = html.match(/<p[^>]*>([\s\S]*?)<\/p>/i)?.[1];
  if (!para) return null;
  const text = decode(para.replace(/<br\s*\/?>/gi, '\n').replace(/<[^>]+>/g, '')).trim();
  const tail = html.split(/<\/p>/i)[1] || '';
  const date = decode((tail.match(/<a[^>]*>([^<]*)<\/a>\s*<\/blockquote>/i)?.[1] || '').trim());
  return { text, author: json.author_name || null, date: date || null };
}

// Returns { text, author, date } or null when the post cannot be shown
// (deleted, protected, or oEmbed unavailable). The request carries the post's
// link only: it names no Stated user.
export async function oembedText(config, postId, postUrl, fetchImpl = fetch) {
  const key = String(postId);
  const hit = cache.get(key);
  if (hit && hit.until > Date.now()) return hit.value;
  let value = null;
  try {
    const url = new URL(`${config.x.oembedBase}/oembed`);
    url.searchParams.set('url', String(postUrl));
    url.searchParams.set('omit_script', '1');
    url.searchParams.set('dnt', 'true');
    url.searchParams.set('hide_thread', '1');
    const res = await fetchImpl(url, { signal: AbortSignal.timeout(4000) });
    if (res.ok) value = parseOembed(await res.json());
  } catch {
    value = null;
  }
  if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value);
  cache.set(key, { value, until: Date.now() + (value ? CACHE_MS : FAIL_MS) });
  return value;
}

export function clearOembedCache() {
  cache.clear();
}

export function dropOembed(postId) {
  cache.delete(String(postId));
}

// The words of one private post, for its owner, on request. Never called for
// a list of saves, so X never sees one owner's collection requested together.
export async function postWords(config, row, fetchImpl = fetch) {
  if (!isPlaceholder(row) || !row.available) return row;
  const shown = await oembedText(config, row.platform_id, row.source_url, fetchImpl);
  if (shown) {
    row.display_text = xClaimText(shown.text);
    row.display_via = 'oembed';
  } else {
    row.display_failed = true;
  }
  return row;
}

// --- Keeping stored text in step with visibility ----------------------------

async function publicSaveCount(db, sourceId) {
  const row = await db.one(
    `select count(*)::int as n from saves s join statements st on st.id = s.statement_id
     join users u on u.id = s.owner_user_id
     where st.source_id = $1 and ${PUBLIC_SAVE_SQL}`,
    [sourceId],
  );
  return row.n;
}

export async function storeXText(db, source, statement, text, { botUsername } = {}) {
  const claim = xClaimText(text, botUsername);
  if (!claim) return;
  const terms = readTerms(claim, source.published_at || new Date(), { keepWords: true });
  await db.query('update sources set text = $2 where id = $1', [source.id, text]);
  await db.query(
    `update statements set span = $2, deadline_text = coalesce(deadline_text, $3), condition_text = coalesce(condition_text, $4)
     where id = $1`,
    [statement.id, claim, terms.deadlineText, terms.condition],
  );
}

export async function dropXText(db, sourceId) {
  await db.query(`update sources set text = '' where id = $1`, [sourceId]);
  await db.query(
    `update statements set span = 'X post ' || (select platform_id from sources where id = $1),
       deadline_text = null, condition_text = null
     where source_id = $1`,
    [sourceId],
  );
  await db.query(
    `update revisions set after = after - 'deadlineText' - 'condition'
     where statement_id in (select id from statements where source_id = $1) and after is not null`,
    [sourceId],
  );
}

const STORED_SPAN_SQL = `exists (select 1 from statements st where st.source_id = src.id
  and st.span !~ '^X post [0-9]+$' and st.span !~ '^Post removed on X')`;

// Call after any change that can make an X post public or private. Words of
// a post no longer public anywhere are dropped at once. Words for a newly
// public post are read from X only when a client is passed, in batches of up
// to 100 posts per call. Web requests pass none, so publishing never waits
// on X; the worker fills them on its next pass.
export async function syncXText(db, config, { statementIds = [], sourceIds = [], x = null } = {}) {
  if (storesAllXText(config)) return { stored: [], dropped: [] };
  const ids = [...new Set(sourceIds.map(String))];
  if (statementIds.length) {
    const rows = await db.many(
      `select distinct source_id from statements where id = any($1::bigint[])`,
      [statementIds.map(String)],
    );
    for (const r of rows) ids.push(String(r.source_id));
  }
  const dropped = [];
  const toFill = [];
  for (const sourceId of [...new Set(ids)]) {
    const source = await db.one(
      `select src.*, ${STORED_SPAN_SQL} as span_stored from sources src where src.id = $1 and src.platform = 'x'`,
      [sourceId],
    );
    if (!source || !source.available) continue;
    const isPublic = (await publicSaveCount(db, sourceId)) > 0;
    if (isPublic && !source.text) toFill.push(source);
    else if (!isPublic && (source.text || source.span_stored)) {
      await dropXText(db, sourceId);
      dropped.push(String(sourceId));
    }
  }
  const stored = x && toFill.length ? await fillText(db, x, toFill) : [];
  return { stored, dropped };
}

async function fillText(db, x, sources) {
  const stored = [];
  const botUsername = (await x.identity()).username;
  for (let i = 0; i < sources.length; i += 100) {
    const batch = sources.slice(i, i + 100);
    let data;
    try {
      data = await x.posts(batch.map((s) => s.platform_id));
    } catch {
      break;
    }
    const posts = new Map((data.data || []).map((p) => [p.id, p]));
    const users = new Map((data.includes?.users || []).map((u) => [u.id, u]));
    for (const source of batch) {
      const post = posts.get(source.platform_id);
      const statement = await db.one('select * from statements where source_id = $1 order by id limit 1', [source.id]);
      if (!statement) continue;
      if (!post) {
        if (goneOnX(data.errors, source.platform_id)) {
          dropOembed(source.platform_id);
          await db.query(`update sources set available = false, text = '', checked_at = now() where id = $1`, [source.id]);
        }
        continue;
      }
      const author = users.get(post.author_id);
      if (author?.protected) {
        dropOembed(source.platform_id);
        await db.query(`update sources set available = false, author_protected = true, text = '', checked_at = now() where id = $1`, [source.id]);
        continue;
      }
      if ((await publicSaveCount(db, source.id)) < 1) continue;
      await storeXText(db, source, statement, postText(post), { botUsername });
      await db.query('update sources set checked_at = now() where id = $1', [source.id]);
      stored.push(String(source.id));
    }
  }
  return stored;
}

// Applies the policy to data stored before it, or under the 'all' opt-out:
// the words of X posts that no public record shows are dropped, and inbox
// bodies from earlier versions that quoted a post are replaced. Mention
// payloads are cut to IDs by the schema upgrade. Safe to repeat; run on
// every start and by `npm run migrate`.
export async function applyTextPolicy(db, config) {
  if (storesAllXText(config)) return { dropped: 0, inbox: 0 };
  const rows = await db.many(
    `select src.id from sources src
     where src.platform = 'x' and (src.text <> '' or ${STORED_SPAN_SQL})
       and not exists (select 1 from statements st join saves s on s.statement_id = st.id
                       join users u on u.id = s.owner_user_id
                       where st.source_id = src.id and ${PUBLIC_SAVE_SQL})`,
  );
  for (const r of rows) await dropXText(db, r.id);
  const inbox = await db.query(
    `update inbox i set body = case i.kind
       when 'saved' then 'Saved a post to Following. Open the save to see it.'
       when 'pending_terms' then 'Saved to My predictions. Confirm what you meant before the deadline.'
       when 'deadline' then 'A deadline is near or has passed for a post you saved. Open the save to see it.'
       when 'outcome' then 'An outcome was recorded for a post you saved. Open the save to see it.'
       else i.body end
     where i.body like '%“%' and i.kind in ('saved', 'pending_terms', 'deadline', 'outcome')
       and i.statement_id in (select st.id from statements st join sources src on src.id = st.source_id where src.platform = 'x')`,
  );
  return { dropped: rows.length, inbox: inbox.rowCount };
}

// Public X records whose text is missing, for the worker to fill.
export async function sourcesNeedingText(db, limit = 100) {
  return db.many(
    `select distinct src.id from sources src
     join statements st on st.source_id = src.id
     join saves s on s.statement_id = st.id
     join users u on u.id = s.owner_user_id
     where src.platform = 'x' and src.available and src.text = '' and ${PUBLIC_SAVE_SQL}
     limit $1`,
    [limit],
  );
}
