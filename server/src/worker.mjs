import { sendBetReplies } from './reply-bets.mjs';
import { createIntake, runIntake } from './articles.mjs';
import { kvGet, kvSet } from './db.mjs';
import { insertSave, linkedUrls, PROCESSING_LEASE, processMention, sendPendingReplies, upsertXSource, upsertXStatement } from './intake.mjs';
import { INTAKES_PER_HOUR } from './limits.mjs';
import { runCompliance } from './compliance.mjs';
import { checkSources, deliverDms, refreshEdited, scanDeadlines } from './notify.mjs';
import { goneOnX, postFetcher, postText } from './xapi.mjs';
import { applyTextPolicy, sourcesNeedingText, storesAllXText, syncXText, xClaimText } from './xtext.mjs';

function mergeIncludes(pages) {
  const users = new Map();
  const tweets = new Map();
  for (const page of pages) {
    for (const u of page.includes?.users || []) users.set(u.id, u);
    for (const t of page.includes?.tweets || []) tweets.set(t.id, t);
  }
  return { users: [...users.values()], tweets: [...tweets.values()] };
}

function byIdAsc(a, b) {
  const x = BigInt(a.id);
  const y = BigInt(b.id);
  return x < y ? -1 : x > y ? 1 : 0;
}

export { postFetcher };

export async function pollMentions(db, config, x, { maxPages = 50 } = {}) {
  const bot = await x.identity();
  const sinceId = await kvGet(db, 'mentions_since_id');
  const initialized = await kvGet(db, 'mentions_initialized');
  if (!sinceId && !initialized && config.x.mentionsStart === 'now') {
    const first = await x.mentions({ maxResults: 5 });
    await kvSet(db, 'mentions_initialized', new Date().toISOString());
    if (first.meta?.newest_id) await kvSet(db, 'mentions_since_id', first.meta.newest_id);
    return { processed: [], skippedBacklog: first.meta?.result_count || 0 };
  }
  const pages = [];
  let token;
  for (let i = 0; i < maxPages; i += 1) {
    const page = await x.mentions({ sinceId: sinceId || undefined, paginationToken: token });
    pages.push(page);
    token = page.meta?.next_token;
    if (!token) break;
  }
  const mentions = pages.flatMap((p) => p.data || []).sort(byIdAsc);
  const includes = mergeIncludes(pages);
  const processed = [];
  const fetchPost = postFetcher(x);
  for (const mention of mentions) {
    try {
      const result = await processMention(db, config, { mention, includes, bot, fetchPost });
      processed.push({ id: mention.id, outcome: result.outcome });
    } catch (err) {
      processed.push({ id: mention.id, outcome: 'error', error: String(err.message || err) });
    }
  }
  const newest = pages[0]?.meta?.newest_id;
  if (newest && (!sinceId || BigInt(newest) > BigInt(sinceId))) await kvSet(db, 'mentions_since_id', newest);
  if (!initialized) await kvSet(db, 'mentions_initialized', new Date().toISOString());
  return { processed, truncated: Boolean(token) };
}

// Errors are retried up to three times; a claim abandoned by a crash is
// retried once its lease runs out. A stored event keeps IDs only, so the
// mention is read again from X (one post read with its author).
export async function retryErrored(db, config, x) {
  const bot = await x.identity();
  const rows = await db.many(
    `select event_id, payload from mention_events
     where ((outcome = 'error' and attempts < 3)
         or (outcome = 'processing' and (processing_since is null or processing_since < now() - interval '${PROCESSING_LEASE}')))
     order by received_at limit 20`,
  );
  const out = [];
  for (const row of rows) {
    let claimed = false;
    try {
      let mention = row.payload?.mention;
      let includes = row.payload?.includes || {};
      if (!mention?.text && !mention?.note_tweet) {
        const data = await x.posts([row.event_id]);
        const post = data.data?.[0];
        if (!post) {
          if (goneOnX(data.errors, row.event_id)) {
            await db.query(
              `update mention_events set outcome = 'tag_deleted', processing_since = null, payload = null where event_id = $1`,
              [row.event_id],
            );
            out.push({ id: row.event_id, outcome: 'tag_deleted' });
            continue;
          }
          throw new Error('X did not return the mention; it is retried later.');
        }
        mention = post;
        includes = { users: data.includes?.users || [] };
      }
      claimed = true;
      const result = await processMention(db, config, { mention, includes, bot, fetchPost: postFetcher(x) });
      out.push({ id: row.event_id, outcome: result.outcome });
    } catch (err) {
      // processMention records its own failure; a failure to read the
      // mention again is counted here, so it stops after three attempts.
      if (!claimed) await db.query(
        `update mention_events set outcome = 'error', attempts = attempts + 1, processing_since = null, reply_error = $2
         where event_id = $1 and outcome in ('error', 'processing')`,
        [row.event_id, String(err.message || err).slice(0, 500)],
      ).catch(() => {});
      out.push({ id: row.event_id, outcome: 'error', error: String(err.message || err) });
    }
  }
  return out;
}

const STOP = /^\s*(stop|unsubscribe|cancel|end|quit)\s*$/i;
const START = /^\s*(start|unstop|resume)\s*$/i;

// DM intake keeps a save off the public timeline: a link to a post or an
// article sent privately to the bot. The saves are always private, and no
// post text is stored for them. "stop" turns DMs off with one confirmation.
export async function processDm(db, config, x, event, bot) {
  if (event.sender_id === bot.userId) return { outcome: 'ignored_self' };
  const claimed = await db.one(
    `insert into dm_events (event_id, sender_x_user_id, outcome, attempts, processing_since) values ($1, $2, 'processing', 1, now())
     on conflict (event_id) do update set outcome = 'processing', attempts = dm_events.attempts + 1, processing_since = now()
       where (dm_events.outcome = 'error' and dm_events.attempts < 3)
          or (dm_events.outcome = 'processing' and dm_events.processing_since < now() - interval '${PROCESSING_LEASE}')
     returning event_id`,
    [event.id, event.sender_id],
  );
  if (!claimed) return { outcome: 'replay' };
  try {
    const text = String(event.text || '');
    let outcome = 'no_link';
    let reply = 'Send a link to a post on X or to an article, and it is saved privately to your Stated profile. Send STOP to turn off messages.';
    let intakeId = null;
    if (STOP.test(text)) {
      await db.query(`update users set dm_updates = false, dm_opted_out_at = now() where x_user_id = $1`, [event.sender_id]);
      outcome = 'opted_out';
      reply = 'You will not get messages from Stated. Updates stay in your inbox on the website. Send START to turn messages back on.';
    } else if (START.test(text)) {
      await db.query(`update users set dm_opted_out_at = null where x_user_id = $1`, [event.sender_id]);
      outcome = 'opted_in';
      reply = 'Messages are back on. Choose which updates to get in your Stated settings.';
    } else {
      const links = linkedUrls({ entities: event.entities || { urls: (text.match(/https?:\/\/\S+/g) || []).map((u) => ({ expanded_url: u })) } });
      if (links.statusIds.length) {
        const fetched = await postFetcher(x)(links.statusIds[0]);
        if (!fetched) {
          outcome = 'source_unavailable';
          reply = 'Unable to read that post. It may be deleted, or from a protected account.';
        } else {
          const result = await db.tx(async (tx) => {
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
            const owner = await tx.one(`select * from users where x_user_id = $1 and kind = 'person'`, [event.sender_id]);
            return insertSave(tx, {
              ownerXUserId: event.sender_id,
              owner,
              statement,
              relation: fetched.post.author_id === event.sender_id ? 'mine' : 'following',
              visibility: 'private',
              intake: 'dm',
              source,
            });
          });
          outcome = result.created ? 'saved' : 'duplicate';
          reply = result.created
            ? `Saved privately to ${result.save.relation === 'mine' ? 'My predictions' : 'Following'}. ${config.baseUrl}/me`
            : 'Already in your Stated profile.';
        }
      } else if (links.articles.length) {
        // createIntake counts the quota and reserves the intake in one locked transaction (limits.mjs).
        let intake = null;
        try {
          intake = await createIntake(db, { ownerXUserId: event.sender_id, url: links.articles[0], route: 'dm' });
        } catch (error) {
          if (error?.status !== 429) throw error;
        }
        if (!intake) {
          outcome = 'rate_limited';
          reply = `You have sent ${INTAKES_PER_HOUR} links in the last hour. Try again later.`;
        } else {
          await runIntake(db, config, intake.id);
          intakeId = intake.id;
          outcome = 'article';
          reply = `Pick which predictions to follow: ${config.baseUrl}/me/track/${intake.id}`;
        }
      }
    }
    await db.query('update dm_events set outcome = $2, intake_id = $3, processing_since = null where event_id = $1', [event.id, outcome, intakeId]);
    try {
      await x.sendDm({ to: event.sender_id, text: reply });
    } catch {
      // The save stands. The inbox carries any follow-up.
    }
    return { outcome, intakeId };
  } catch (err) {
    await db.query(`update dm_events set outcome = 'error', processing_since = null where event_id = $1`, [event.id]);
    throw err;
  }
}

// DM events have no since-cursor, so pages are read until one already seen.
export async function pollDms(db, config, x, { maxPages = 5 } = {}) {
  if (!config.x.dmEnabled) return null;
  const bot = await x.identity();
  const events = [];
  let token;
  for (let i = 0; i < maxPages; i += 1) {
    const data = await x.dmEvents({ paginationToken: token });
    const page = (data.data || []).filter((e) => e.event_type === 'MessageCreate' || !e.event_type);
    events.push(...page);
    const ids = page.map((e) => e.id);
    const seen = ids.length
      ? await db.one(`select count(*)::int as n from dm_events where event_id = any($1::text[]) and outcome not in ('error', 'processing')`, [ids])
      : { n: 0 };
    token = data.meta?.next_token;
    if (!token || seen.n > 0) break;
  }
  const out = [];
  for (const event of events.sort(byIdAsc)) {
    try {
      out.push({ id: event.id, ...(await processDm(db, config, x, event, bot)) });
    } catch (err) {
      out.push({ id: event.id, outcome: 'error', error: String(err.message || err) });
    }
  }
  return out;
}

export async function runQueuedIntakes(db, config) {
  const queued = await db.many(`select id from url_intakes where status = 'queued' order by created_at limit 10`);
  const out = [];
  for (const { id } of queued) {
    const done = await runIntake(db, config, id);
    out.push({ id, status: done?.status });
  }
  return out;
}

// Public X records published while the bot was unreachable get their text now.
export async function fillPublicText(db, config, x) {
  if (storesAllXText(config)) return [];
  const due = await sourcesNeedingText(db);
  if (!due.length) return [];
  const result = await syncXText(db, config, { sourceIds: due.map((r) => r.id), x });
  return result.stored;
}

export async function tick(db, config, x, { now = new Date(), sourceCheck = false } = {}) {
  const summary = {};
  summary.mentions = await pollMentions(db, config, x);
  summary.retried = await retryErrored(db, config, x);
  summary.dms = await pollDms(db, config, x);
  summary.intakes = await runQueuedIntakes(db, config);
  summary.replies = await sendPendingReplies(db, x);
  summary.betReplies = await sendBetReplies(db, x);
  summary.textFilled = await fillPublicText(db, config, x);
  summary.deadlines = (await scanDeadlines(db, now)).length;
  summary.dmUpdates = await deliverDms(db, x, config);
  if (sourceCheck) {
    if (config.x.complianceBearer) {
      summary.compliance = await runCompliance(db, config);
      if (summary.compliance.mode === 'fallback') {
        summary.sources = await checkSources(db, x, { privateCheckDays: config.x.privateCheckDays, lookup: 'id-only' });
      } else if (summary.compliance.rehydrate?.length) {
        summary.rehydrated = await refreshEdited(db, x, summary.compliance.rehydrate);
        summary.sources = await checkSources(db, x, { privateCheckDays: 0, publicEveryHours: 24 * 30, lookup: 'id-only' });
      } else {
        summary.sources = await checkSources(db, x, { privateCheckDays: 0, publicEveryHours: 24 * 30, lookup: 'id-only' });
      }
    } else {
      summary.sources = await checkSources(db, x, { privateCheckDays: config.x.privateCheckDays });
    }
    summary.policy = await applyTextPolicy(db, config);
  }
  return summary;
}

// The source check runs hourly; each run takes every stored public post not
// checked in the last 20 hours, so each is re-checked at least daily.
export function startWorker(db, config, x, log = console) {
  let stopped = false;
  let timer = null;
  let lastSourceCheck = 0;
  let delay = config.worker.pollMs;

  async function loop() {
    if (stopped) return;
    try {
      const connected = await db.one('select 1 as ok from bot_credentials where id = 1');
      if (connected) {
        const sourceCheck = Date.now() - lastSourceCheck > 3600 * 1000;
        if (sourceCheck) lastSourceCheck = Date.now();
        const summary = await tick(db, config, x, { sourceCheck });
        const saved = summary.mentions.processed?.length || 0;
        if (saved || summary.replies.length) log.log(`[worker] mentions ${saved}, replies ${summary.replies.length}`);
        if (summary.sources?.errors?.length) log.error(`[worker] source check errors: ${summary.sources.errors.length}`);
        delay = config.worker.pollMs;
      }
    } catch (err) {
      log.error(`[worker] ${err.message}`);
      if (err.status === 429 || err.status === 402) {
        const reset = Number(err.resetAt) * 1000;
        delay = Number.isFinite(reset) && reset > Date.now() ? reset - Date.now() + 1000 : Math.min(delay * 2, 15 * 60 * 1000);
      }
    }
    if (!stopped) timer = setTimeout(loop, delay);
  }

  timer = setTimeout(loop, 1000);
  return () => {
    stopped = true;
    if (timer) clearTimeout(timer);
  };
}
