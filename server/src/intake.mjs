import { parseBetCommand, queueBetCommand } from './reply-bets.mjs';
import { parseEvidenceCommand, targetEvidenceBet } from './bet-evidence.mjs';
import { interpret, looksLikePrediction, missingTerms } from './interpret.mjs';
import { reserveIntake } from './limits.mjs';
import { inPilot } from './near-network.mjs';
import { replyFor } from './replies.mjs';
import { addInbox, restoreCommitment, UserError, userByXId } from './store.mjs';
import { explicitlyMentions, postText, postUrl } from './xapi.mjs';
import { placeholderSpan, readTerms, storeXText, storesAllXText, xClaimText } from './xtext.mjs';
import { parseQuickBet } from './quick-bet.mjs';

const STATUS_URL = /^https?:\/\/(?:www\.|mobile\.)?(?:x|twitter)\.com\/(\w{1,15}|i\/web)\/status\/(\d+)/i;
const DAY = 24 * 3600 * 1000;
// A post with no deadline, saved this long after it was written, cannot be
// shown to have been saved before its outcome was known.
export const STALE_UNDATED_DAYS = 30;
// A crashed claim is retried after this long.
export const PROCESSING_LEASE = '10 minutes';

// Only explicit hashtags are commands. The word "public" in a sentence is
// part of the claim and never changes visibility.
export function commandFlags(text) {
  const t = ` ${String(text || '').toLowerCase()} `;
  return {
    private: /\s#private\b/.test(t),
    public: /\s#public\b/.test(t),
  };
}

// A hostname with a trailing dot ("x.com.") names the same host, so it is
// removed before any X check.
function normalised(url) {
  try {
    const u = new URL(String(url || ''));
    u.hostname = u.hostname.replace(/\.+$/, '');
    return u;
  } catch {
    return null;
  }
}

export function statusIdOf(url) {
  const u = normalised(url);
  return (u ? u.toString() : String(url || '')).match(STATUS_URL)?.[2] || null;
}

export function isXUrl(url) {
  const u = normalised(url);
  return Boolean(u && /(^|\.)(x|twitter)\.com$/i.test(u.hostname));
}

// What is kept of a mention: IDs only, never the words of any post. A retry
// reads the mention again from X.
export function minimalPayload(mention) {
  return {
    mention: {
      id: mention.id,
      author_id: mention.author_id,
      created_at: mention.created_at,
      referenced_tweets: mention.referenced_tweets,
      in_reply_to_user_id: mention.in_reply_to_user_id,
    },
    includes: {},
  };
}

export function linkedUrls(post) {
  const urls = (post?.entities?.urls || []).map((u) => u.unwound_url || u.expanded_url || u.url).filter(Boolean);
  const statusIds = [];
  const articles = [];
  for (const url of urls) {
    const id = statusIdOf(url);
    if (id) statusIds.push(id);
    else if (/^https?:\/\//i.test(url) && !/^https?:\/\/(?:t\.co|pic\.x\.com|x\.com\/\w+\/status\/\d+\/(?:photo|video))/i.test(url)) articles.push(url);
  }
  return { statusIds: [...new Set(statusIds)], articles: [...new Set(articles)] };
}

function replyExclusions(mention, requesterId, botId, targetAuthorId) {
  const ids = new Set();
  if (mention.in_reply_to_user_id) ids.add(mention.in_reply_to_user_id);
  for (const m of mention?.entities?.mentions || []) if (m.id) ids.add(m.id);
  if (targetAuthorId) ids.add(targetAuthorId);
  ids.delete(requesterId);
  ids.delete(botId);
  return [...ids];
}

async function repliesInLastHour(db, authorXUserId) {
  const row = await db.one(
    `select count(*)::int as n from mention_events
     where author_x_user_id = $1 and reply_status in ('pending', 'sending', 'sent') and received_at > now() - interval '1 hour'`,
    [authorXUserId],
  );
  return row.n;
}

// A reply is a public post. It is queued only when replies are enabled and
// the tagger is under the hourly cap; otherwise its text is kept as 'held'.
async function recordEvent(tx, config, mention, fields) {
  let status = 'none';
  if (fields.replyText) {
    status = config.x.repliesEnabled ? 'pending' : 'held';
    if (status === 'pending' && (await repliesInLastHour(tx, mention.author_id)) >= config.x.repliesPerTaggerPerHour) status = 'held';
  }
  const minimal = minimalPayload(mention);
  return tx.one(
    `update mention_events set outcome = $2, save_id = $3, intake_id = $4, reply_text = $5,
       reply_exclude = $6, reply_status = $7, payload = $8, command = $9, processing_since = null
     where event_id = $1 returning *`,
    [
      mention.id,
      fields.outcome,
      fields.saveId || null,
      fields.intakeId || null,
      fields.replyText || null,
      fields.exclude || [],
      status,
      JSON.stringify(minimal),
      fields.command || null,
    ],
  );
}

export async function upsertXSource(tx, post, author, acquisition, { text = '' } = {}) {
  return tx.one(
    `insert into sources (platform, platform_id, url, author_x_user_id, author_username, author_name,
       author_protected, text, published_at, acquisition)
     values ('x', $1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (platform, platform_id) do update set
       author_username = coalesce(excluded.author_username, sources.author_username),
       author_name = coalesce(excluded.author_name, sources.author_name),
       author_protected = excluded.author_protected
     returning *`,
    [
      post.id,
      postUrl(author?.username, post.id),
      post.author_id,
      author?.username || null,
      author?.name || null,
      Boolean(author?.protected),
      text,
      post.created_at ? new Date(post.created_at) : null,
      acquisition,
    ],
  );
}

// An X post has exactly one statement, whatever path saved it. Its terms are
// read from the post's words at capture; the words themselves are stored
// only when the text policy allows (see xtext.mjs).
export async function upsertXStatement(tx, source, { claim, keepWords, speaker, speakerXUserId, publishedAt, now = new Date() }) {
  const existing = await tx.one('select * from statements where source_id = $1 order by id limit 1', [source.id]);
  if (existing) return existing;
  const terms = readTerms(claim, publishedAt, { keepWords });
  const late = terms.proposedDeadlineAt && new Date(terms.proposedDeadlineAt) < now;
  return tx.one(
    `insert into statements (source_id, span, speaker, speaker_x_user_id, reported_speech,
       deadline_text, proposed_deadline_at, probability, condition_text, hedges, capture)
     values ($1, $2, $3, $4, false, $5, $6, $7, $8, $9, $10)
     on conflict (source_id, span) do update set speaker = statements.speaker
     returning *`,
    [
      source.id,
      keepWords ? claim : placeholderSpan(source.platform_id),
      speaker,
      speakerXUserId || null,
      terms.deadlineText,
      terms.proposedDeadlineAt,
      terms.probability,
      terms.condition,
      terms.hedges,
      late ? 'backfill' : 'prospective',
    ],
  );
}

// Statements from web pages: one per sentence. A statement is backfill when
// first captured after its stated deadline, or collected as history.
export async function upsertStatement(tx, source, { span, speaker, speakerXUserId, reportedSpeech = false, publishedAt, backfill = false, now = new Date() }) {
  const terms = interpret(span, publishedAt);
  const late = terms.proposedDeadlineAt && new Date(terms.proposedDeadlineAt) < now;
  return tx.one(
    `insert into statements (source_id, span, speaker, speaker_x_user_id, reported_speech,
       deadline_text, proposed_deadline_at, probability, condition_text, hedges, capture)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (source_id, span) do update set speaker = statements.speaker
     returning *`,
    [
      source.id,
      span,
      speaker,
      speakerXUserId || null,
      reportedSpeech,
      terms.deadlineText,
      terms.proposedDeadlineAt,
      terms.probability,
      terms.condition,
      terms.hedges,
      backfill || late ? 'backfill' : 'prospective',
    ],
  );
}

function initialVisibility(owner, flags, protectedSource) {
  if (!owner || !owner.setup_completed_at || owner.profile_visibility !== 'public' || protectedSource) return 'private';
  if (flags.private) return 'private';
  if (flags.public) return 'public';
  return owner.default_save_visibility;
}

// Capture timing belongs to each save, so one person's private save never
// shapes how someone else's public copy is labelled. A save is backfill when
// it comes after the deadline or the outcome, when it is collected as
// history, or when an undated claim is saved long after it was made.
export function saveCapture(statement, now = new Date(), { backfill = false, source = null } = {}) {
  if (backfill) return { capture: 'backfill', why: 'historical' };
  if (statement.capture === 'backfill' || statement.status !== 'open') return { capture: 'backfill', why: 'late' };
  if (statement.outcome_at && new Date(statement.outcome_at) <= now) return { capture: 'backfill', why: 'late' };
  const due = statement.deadline_at || statement.proposed_deadline_at;
  if (due && new Date(due) < now) return { capture: 'backfill', why: 'late' };
  const published = source?.published_at ? new Date(source.published_at) : null;
  if (!due && published && now - published > STALE_UNDATED_DAYS * DAY) return { capture: 'backfill', why: 'undated' };
  return { capture: 'prospective', why: null };
}

const CAPTURE_NOTES = {
  late: 'Saved after its deadline or outcome, or collected as history. Shown as backfill and never scored as a forecast.',
  historical: 'Collected as history. Shown as backfill and never scored as a forecast.',
  undated: `Saved more than ${STALE_UNDATED_DAYS} days after it was made, with no deadline, so it cannot be shown that the outcome was unknown when it was saved. Shown as backfill and never scored as a forecast.`,
  prospective: 'Saved before its deadline and before any outcome was recorded.',
};

export async function insertSave(tx, { ownerXUserId, owner, statement, relation, visibility, intake, originEventId, backfill = false, source = null }) {
  const { capture, why } = saveCapture(statement, new Date(), { backfill, source });
  const publicNow = visibility === 'public' && (owner?.kind === 'editorial'
    || (owner && owner.profile_visibility === 'public' && owner.setup_completed_at));
  const inserted = await tx.one(
    `insert into saves (owner_x_user_id, owner_user_id, statement_id, relation, visibility, intake, origin_event_id, capture, first_public_at, capture_reason)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     on conflict (owner_x_user_id, statement_id) do nothing
     returning *`,
    [ownerXUserId, owner ? owner.id : null, statement.id, relation, visibility, intake, originEventId || null, capture, publicNow ? new Date() : null, why],
  );
  if (inserted) {
    const after = {
      proposedDeadlineAt: statement.proposed_deadline_at,
      probability: statement.probability,
      hedges: statement.hedges,
      capture,
    };
    if (statement.deadline_text) after.deadlineText = statement.deadline_text;
    if (statement.condition_text) after.condition = statement.condition_text;
    await tx.query(
      `insert into revisions (statement_id, save_id, kind, actor, after, note) values ($1, $2, 'captured', 'system', $3, $4)`,
      [statement.id, inserted.id, after, CAPTURE_NOTES[why || 'prospective']],
    );
    const restored = await restoreCommitment(tx, inserted);
    return { save: restored || inserted, created: true };
  }
  const existing = await tx.one('select * from saves where owner_x_user_id = $1 and statement_id = $2', [ownerXUserId, statement.id]);
  return { save: existing, created: false };
}

// One mention is one event. Replaying the same event ID returns the first
// result and queues nothing. A claim left in 'processing' by a crash is
// taken over after the lease; an 'error' is retried up to three times.
export async function processMention(db, config, { mention, includes = {}, bot, fetchPost }) {
  if (!mention?.id || !mention.author_id) return { outcome: 'ignored_malformed' };
  if (mention.author_id === bot.userId) return { outcome: 'ignored_self' };

  const users = new Map((includes.users || []).map((u) => [u.id, u]));
  const tweets = new Map((includes.tweets || []).map((t) => [t.id, t]));
  const requester = users.get(mention.author_id) || { id: mention.author_id };

  const claimed = await db.one(
    `insert into mention_events (event_id, author_x_user_id, author_username, mention_created_at, outcome, payload, attempts, processing_since)
     values ($1, $2, $3, $4, 'processing', $5, 1, now())
     on conflict (event_id) do update set outcome = 'processing', reply_error = null,
       attempts = mention_events.attempts + 1, processing_since = now(),
       payload = coalesce(excluded.payload, mention_events.payload)
       where (mention_events.outcome = 'error' and mention_events.attempts < 3)
          or (mention_events.outcome = 'processing' and mention_events.processing_since is not null
              and mention_events.processing_since < now() - interval '${PROCESSING_LEASE}')
          or (mention_events.outcome = 'processing' and mention_events.processing_since is null)
     returning event_id, received_at`,
    [
      mention.id,
      mention.author_id,
      requester.username || null,
      mention.created_at ? new Date(mention.created_at) : null,
      JSON.stringify(minimalPayload(mention)),
    ],
  );
  if (!claimed) {
    const event = await db.one('select * from mention_events where event_id = $1', [mention.id]);
    return { outcome: 'replay', event };
  }

  try {
    const refs = mention.referenced_tweets || [];
    if (refs.some((r) => r.type === 'retweeted')) {
      return { outcome: 'ignored_repost', event: await recordEvent(db, config, mention, { outcome: 'ignored_repost' }) };
    }
    const text = postText(mention);
    const flags = commandFlags(text);
    const command = flags.private ? '#private' : (flags.public ? '#public' : null);
    const links = linkedUrls(mention);
    const quoted = refs.find((r) => r.type === 'quoted');
    const parent = refs.find((r) => r.type === 'replied_to');
    // "bet 0.5 no" and "take" are commands only when they are all the person typed.
    // X shortens pasted links. Expand only exact URL tokens so surrounding prose
    // still fails the whole-command parser, and URL path casing stays intact.
    const urls = mention.note_tweet?.entities?.urls || mention.entities?.urls || [];
    const commandText = text.replace(/\S+/g, (word) => {
      const link = urls.find((entry) => entry.url === word);
      return link?.unwound_url || link?.expanded_url || word;
    });
    let bet = config.play?.enabled ? parseBetCommand(commandText, {
      defaultStake: config.play.defaultStakeNear,
      now: mention.created_at || new Date(),
      rulings: Boolean(config.nearai?.rulings || config.outlayer?.referee),
      outlayer: Boolean(config.outlayer?.referee),
    }) : null;
    let quickBet = null;
    if (config.play?.enabled && config.near?.real && !parent && !quoted
      && !links.statusIds.length && /^\w{1,15}$/.test(bot.username || '') && explicitlyMentions(mention, bot.username)) {
      try {
        const botTag = new RegExp(`(^|\\s)@${bot.username}\\b`, 'ig');
        quickBet = parseQuickBet(commandText.replace(botTag, '$1').replace(/\s+/g, ' ').trim(), {
          now: mention.created_at || new Date(), timeZone: 'UTC',
        });
      } catch (error) {
        if (!(error instanceof UserError)) throw error;
        const replyText = `I couldn't create that bet draft: ${error.message}`;
        const event = await recordEvent(db, config, mention, {
          outcome: 'bet_invalid',
          replyText,
          command: 'bet',
          exclude: replyExclusions(mention, mention.author_id, bot.userId, null),
        });
        return { outcome: 'bet_invalid', event };
      }
    }
    if (quickBet) bet = { kind: 'bet', side: quickBet.creatorSide, stake: quickBet.stakeNear };

    // Replying inside a thread the bot is already in puts the bot's handle in
    // the hidden reply prefix. That is not a request, so nothing is saved or posted.
    const parentPost = parent ? tweets.get(parent.id) : null;
    const botName = String(bot.username || '').toLowerCase();
    const botInThread = mention.in_reply_to_user_id === bot.userId
      || parentPost?.author_id === bot.userId
      || (parentPost?.entities?.mentions || []).some((m) => m.id === bot.userId || (botName && String(m.username || '').toLowerCase() === botName));
    // Evidence replies belong to the enclave jury; with it switched off they are not read as links to track.
    if (parent && config.play?.enabled && !config.nearai?.rulings && !config.outlayer?.referee && parseEvidenceCommand(commandText)) {
      return { outcome: 'ignored_evidence', event: await recordEvent(db, config, mention, { outcome: 'ignored_evidence' }) };
    }
    if (bet?.kind === 'evidence' && parent
      && (explicitlyMentions(mention, bot.username) || parentPost?.author_id === bot.userId || mention.in_reply_to_user_id === bot.userId)) {
      return db.tx(async (tx) => {
        const bettor = await targetEvidenceBet(tx, { target_ref: parent.id, x_user_id: mention.author_id });
        if (!bettor) return { outcome: 'ignored_evidence', event: await recordEvent(tx, config, mention, { outcome: 'ignored_evidence' }) };
        const closesAt = bettor.closes_at ? new Date(bettor.closes_at).getTime()
          : new Date(bettor.resolve_at).getTime() + config.play.evidenceWindowSeconds * 1000;
        if (!(new Date(claimed.received_at).getTime() < closesAt)) {
          return { outcome: 'ignored_evidence', event: await recordEvent(tx, config, mention, { outcome: 'ignored_evidence' }) };
        }
        // Serialize this sender's count and insert so concurrent replies cannot exceed the cap.
        await tx.query('select id from users where id = $1 for update', [bettor.user_id]);
        const { n } = await tx.one(`select count(*)::int as n from evidence_commands c
          where c.x_user_id = $1 and c.status = 'queued' and exists (
            select 1 from bilateral_bets b join saves s on s.id = b.source_save_id
            join statements st on st.id = s.statement_id join sources src on src.id = st.source_id
            where s.statement_id = $2 and (
              exists (select 1 from bot_outbox o where o.post_id = c.target_ref and o.bet_id = b.id)
              or exists (select 1 from bet_commands offer where offer.event_id = c.target_ref and offer.kind = 'bet' and offer.bet_id = b.id)
              or (src.platform = 'x' and src.platform_id = c.target_ref)))`, [mention.author_id, bettor.statement_id]);
        if (n >= 4) return { outcome: 'ignored_evidence', event: await recordEvent(tx, config, mention, { outcome: 'ignored_evidence' }) };
        const exclude = replyExclusions(mention, mention.author_id, bot.userId, null);
        await queueBetCommand(tx, { eventId: mention.id, xUserId: mention.author_id, username: requester.username,
          command: bet, targetRef: parent.id, exclude, receivedAt: claimed.received_at });
        return { outcome: 'bet_evidence', event: await recordEvent(tx, config, mention, { outcome: 'bet_evidence', command: 'evidence', exclude }) };
      });
    }
    // Taking a Bet: a reply to the offer, to the reply that made it, or to the post itself.
    // A bare "take" under the bot's own offer is deliberate, so it does not need the handle typed again.
    if (bet?.kind === 'take' && (parent || quoted)
      && (explicitlyMentions(mention, bot.username) || parentPost?.author_id === bot.userId || mention.in_reply_to_user_id === bot.userId)) {
      return db.tx(async (tx) => {
        await queueBetCommand(tx, { eventId: mention.id, xUserId: mention.author_id, username: requester.username,
          command: bet, targetRef: (parent || quoted).id, exclude: replyExclusions(mention, mention.author_id, bot.userId, null) });
        return { outcome: 'bet_take', event: await recordEvent(tx, config, mention, { outcome: 'bet_take', command: 'take' }) };
      });
    }
    if ((Array.isArray(mention.display_text_range) || botInThread) && !explicitlyMentions(mention, bot.username)) {
      return { outcome: 'ignored_implicit', event: await recordEvent(db, config, mention, { outcome: 'ignored_implicit' }) };
    }
    const targetId = quoted?.id || parent?.id || links.statusIds[0] || null;
    const ownHost = (() => { try { return new URL(config.baseUrl).host; } catch { return ''; } })();
    const outside = links.articles.filter((url) => {
      try { const to = new URL(url); return to.host !== ownHost && to.hostname.replace(/^www\./, '') !== 'github.com'; } catch { return true; }
    });

    let target = null;
    let targetAuthor = null;
    let targetText = '';
    if (targetId) {
      target = tweets.get(targetId) || null;
      targetAuthor = target ? users.get(target.author_id) || null : null;
      if ((!target || !targetAuthor) && fetchPost) {
        // fetchPost returns null only when X says the post is gone or
        // protected. Any other failure throws, so the event is retried.
        const fetched = await fetchPost(targetId);
        if (fetched?.post) {
          target = fetched.post;
          targetAuthor = fetched.author || null;
        }
      }
      if (!target) {
        const owner = await userByXId(db, mention.author_id);
        const replyText = replyFor({ outcome: 'source_unavailable', owner, baseUrl: config.baseUrl, links: config.x.replyLinks });
        const event = await recordEvent(db, config, mention, {
          outcome: 'source_unavailable',
          replyText,
          command,
          exclude: replyExclusions(mention, mention.author_id, bot.userId, null),
        });
        return { outcome: 'source_unavailable', event };
      }
      if (target.author_id === bot.userId) {
        return { outcome: 'ignored_bot_target', event: await recordEvent(db, config, mention, { outcome: 'ignored_bot_target' }) };
      }
      targetText = postText(target);
    } else if (quickBet) {
      target = mention;
      targetAuthor = requester;
      targetText = quickBet.claim;
    } else if (links.articles.length && !outside.length) {
      // A post that only links to Stated itself or its source, such as an announcement, is not a request to read an article.
      return { outcome: 'ignored_own_link', event: await recordEvent(db, config, mention, { outcome: 'ignored_own_link' }) };
    } else if (outside.length) {
      // The quota is counted and the intake reserved in one locked transaction (limits.mjs).
      let intake;
      try {
        intake = await reserveIntake(db, { ownerXUserId: mention.author_id, url: outside[0], route: 'mention' });
      } catch (error) {
        if (error?.status !== 429) throw error;
        return { outcome: 'rate_limited', event: await recordEvent(db, config, mention, { outcome: 'rate_limited' }) };
      }
      const owner = await userByXId(db, mention.author_id);
      const replyText = replyFor({ outcome: 'article', owner, baseUrl: config.baseUrl, links: config.x.replyLinks });
      const event = await recordEvent(db, config, mention, {
        outcome: 'article',
        intakeId: intake.id,
        replyText,
        exclude: replyExclusions(mention, mention.author_id, bot.userId, null),
      });
      return { outcome: 'article', event, intakeId: intake.id };
    } else {
      const own = xClaimText(text, bot.username);
      if (own.length < 12 || !looksLikePrediction(own)) {
        return { outcome: 'no_target', event: await recordEvent(db, config, mention, { outcome: 'no_target' }) };
      }
      target = mention;
      targetAuthor = requester;
      targetText = text;
    }

    const result = await db.tx(async (tx) => {
      const owner = await tx.one(`select * from users where x_user_id = $1 and kind = 'person'`, [mention.author_id]);
      const relation = target.author_id === mention.author_id ? 'mine' : 'following';
      const visibility = initialVisibility(owner, flags, Boolean(targetAuthor?.protected));
      const claim = xClaimText(targetText, bot.username);
      const keepWords = storesAllXText(config) || visibility === 'public';
      const source = await upsertXSource(tx, target, targetAuthor, 'mention', { text: keepWords ? targetText : '' });
      let statement = await upsertXStatement(tx, source, {
        claim,
        keepWords,
        speaker: targetAuthor?.username ? `@${targetAuthor.username}` : 'Unknown author',
        speakerXUserId: target.author_id,
        publishedAt: target.created_at ? new Date(target.created_at) : new Date(),
      });
      if (quickBet && !statement.deadline_at && !statement.proposed_deadline_at) {
        statement = await tx.one(`update statements set proposed_deadline_at = $2, deadline_text = 'UTC'
          where id = $1 and deadline_at is null and proposed_deadline_at is null returning *`, [statement.id, quickBet.resolveAt])
          || await tx.one('select * from statements where id = $1', [statement.id]);
      }
      const offering = bet?.kind === 'bet' && (target.id !== mention.id || Boolean(quickBet));
      if (offering && !bet.error && bet.deadline && !statement.deadline_at && !statement.proposed_deadline_at) {
        const due = new Date(bet.deadline).getTime();
        const now = Date.now();
        if (due < now + 10 * 60000) bet.error = 'too_soon';
        else if (due > now + 365 * DAY) bet.error = 'too_far';
      }
      if (offering && !bet.error && inPilot(config, mention.author_id)
        && bet.deadline && !statement.deadline_at && !statement.proposed_deadline_at) {
        // Store before the save so its capture and revision use the same deadline
        // as the queued Bet. A concurrent capture's existing date always wins.
        statement = await tx.one(`update statements set proposed_deadline_at = $2
          where id = $1 and deadline_at is null and proposed_deadline_at is null returning *`, [statement.id, bet.deadline])
          || await tx.one('select * from statements where id = $1', [statement.id]);
      }
      const { save, created } = await insertSave(tx, {
        ownerXUserId: mention.author_id,
        owner,
        statement,
        relation,
        visibility,
        intake: 'mention',
        originEventId: mention.id,
        source,
      });
      if (keepWords && !source.text && save.visibility === 'public') {
        await storeXText(tx, source, statement, targetText, { botUsername: bot.username });
        statement = await tx.one('select * from statements where id = $1', [statement.id]);
      }
      const outcome = created ? 'saved' : 'duplicate';
      const late = save.capture === 'backfill'
        ? ' It is backfill: saved after its deadline or outcome, or long after an undated claim was made. It is shown but not scored.'
        : '';
      if (created && relation === 'mine') {
        const missing = missingTerms({ deadlineText: statement.deadline_text || (statement.proposed_deadline_at ? 'read' : null), probability: statement.probability });
        await addInbox(tx, {
          ownerXUserId: mention.author_id,
          kind: 'pending_terms',
          saveId: save.id,
          statementId: statement.id,
          body: (missing.length
            ? `Saved to My predictions. Missing: ${missing.join(' and ')}. Confirm what you meant before the deadline. A prediction without a probability is still tracked; it is scored as came true or did not.`
            : 'Saved to My predictions. Confirm the deadline as read from your post.') + late,
          dedupeKey: `terms:${save.id}`,
        });
      } else if (created) {
        await addInbox(tx, {
          ownerXUserId: mention.author_id,
          kind: 'saved',
          saveId: save.id,
          statementId: statement.id,
          body: `Saved a post by ${statement.speaker} to Following. The credit stays with them, and it does not count toward your score.${late}`,
          dedupeKey: `saved:${save.id}`,
        });
      }
      // The play worker replies with a mainnet draft or a funded testnet bet.
      // It retains the words only until the bet has been created.
      if (offering) {
        await queueBetCommand(tx, { eventId: mention.id, xUserId: mention.author_id, username: requester.username,
          command: bet.error ? { ...bet, stake: null } : bet, saveId: save.id, words: quickBet ? quickBet.claim : claim,
          ...(quickBet ? { structuredTerms: quickBet } : {}),
          exclude: replyExclusions(mention, mention.author_id, bot.userId, target.author_id) });
        if (bet.error) await tx.query('update bet_commands set detail = $2 where event_id = $1', [mention.id, bet.error]);
      }
      // A duplicate tag gets no reply: no paid post for something already saved.
      const replyText = created && !offering ? replyFor({
        outcome,
        relation: save.relation,
        visibility: save.visibility,
        owner,
        saveId: save.id,
        baseUrl: config.baseUrl,
        links: config.x.replyLinks,
      }) : null;
      const event = await recordEvent(tx, config, mention, {
        outcome,
        saveId: save.id,
        replyText,
        command: offering ? 'bet' : command,
        exclude: replyExclusions(mention, mention.author_id, bot.userId, target.author_id),
      });
      return { outcome, save, statement, source, event };
    });
    return result;
  } catch (err) {
    await db.query(
      `update mention_events set outcome = 'error', reply_error = $2, processing_since = null, payload = $3
       where event_id = $1`,
      [mention.id, String(err.message || err).slice(0, 500), JSON.stringify(minimalPayload(mention))],
    );
    throw err;
  }
}

// Claim the reply before posting it: at most one reply per event, even if
// two workers run or the process restarts mid-send. A reply stuck in
// 'sending' is never re-sent automatically: it may have been posted, so it is
// marked failed for a person to check.
export async function sendPendingReplies(db, x, { limit = 20 } = {}) {
  await db.query(
    `update mention_events set reply_status = 'failed',
       reply_error = 'Interrupted while sending. Check the bot''s replies on X before sending again.'
     where reply_status = 'sending' and coalesce(replied_at, received_at) < now() - interval '${PROCESSING_LEASE}'`,
  );
  const sent = [];
  const pending = await db.many(
    `select event_id from mention_events where reply_status = 'pending' order by received_at limit $1`,
    [limit],
  );
  for (const { event_id: id } of pending) {
    const claimed = await db.one(
      `update mention_events set reply_status = 'sending', replied_at = now() where event_id = $1 and reply_status = 'pending' returning *`,
      [id],
    );
    if (!claimed) continue;
    try {
      const post = await x.reply({ text: claimed.reply_text, inReplyTo: claimed.event_id, exclude: claimed.reply_exclude });
      await db.query(
        `update mention_events set reply_status = 'sent', reply_post_id = $2, replied_at = now() where event_id = $1`,
        [id, post?.id || null],
      );
      sent.push(id);
    } catch (err) {
      await db.query(
        `update mention_events set reply_status = 'failed', reply_error = $2 where event_id = $1`,
        [id, String(err.message || err).slice(0, 500)],
      );
      if (err.status === 429 || err.status === 402) break;
    }
  }
  return sent;
}

export { DAY };
