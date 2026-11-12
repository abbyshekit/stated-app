import { createHash, randomUUID } from 'node:crypto';
import { safeFetch } from './articles.mjs';
import { extractInWorker } from './extraction-pool.mjs';
import { betReplies, say } from './reply-bets.mjs';
import { UserError } from './store.mjs';

function evidenceUrl(raw) {
  const text = String(raw || '').trim();
  if (text.length < 9 || text.length > 600 || !/^https:\/\//i.test(text) || /[\s\\]/.test(text)) {
    throw new UserError('Use a public https link outside X.');
  }
  let url;
  try { url = new URL(text); } catch { throw new UserError('Use a public https link outside X.'); }
  const host = url.hostname.replace(/\.+$/, '');
  if (url.protocol !== 'https:' || url.username || url.password) {
    throw new UserError('Use a public https link outside X.');
  }
  if (/(^|\.)(x|twitter)\.com$/i.test(host)) {
    throw new UserError('The jury can’t open X posts. Paste a link to a public web page.');
  }
  const link = url.toString();
  if (link.length > 600) throw new UserError('Use a public https link outside X.');
  return link;
}

/** Handles are separate tokens: an @ inside a link is never stripped. */
export function parseEvidenceCommand(text) {
  const words = String(text || '').trim().split(/\s+/).filter((word) => !/^@\w{1,15}$/.test(word));
  if (words.length !== 2 || !/^(yes|no)$/i.test(words[0])) return null;
  try { return { kind: 'evidence', side: words[0].toLowerCase(), url: evidenceUrl(words[1]) }; } catch { return null; }
}

async function evidenceBet(tx, betId) {
  return tx.one(`select b.*, s.statement_id, p.closes_at from bilateral_bets b
    left join saves s on s.id = b.source_save_id
    left join enclave_plans p on p.statement_id = s.statement_id where b.id = $1`, [betId]);
}

function checkBettor(bet, userId) {
  if (!bet || !userId || ![String(bet.creator_user_id), String(bet.acceptor_user_id || '')].includes(String(userId))) {
    throw new UserError('Not a bettor on this Bet.', 404);
  }
  if (!bet.statement_id) throw new UserError('This Bet has no post to add evidence to.');
  if (!['accepted', 'proposed', 'disputed'].includes(bet.status)) throw new UserError('Evidence is closed.');
}

function evidenceClosesAt(bet, config) {
  return bet.closes_at ? new Date(bet.closes_at).getTime()
    : new Date(bet.resolve_at).getTime() + config.play.evidenceWindowSeconds * 1000;
}

function checkWindow(bet, config, now = Date.now()) {
  const closesAt = evidenceClosesAt(bet, config);
  if (!bet.accepted_at || !bet.acceptor_user_id || new Date(bet.accepted_at).getTime() > now || !(now < closesAt)) {
    throw new UserError('Evidence is closed.');
  }
}

function checkReadTime(bet, config, readAt) {
  if (!(readAt <= evidenceClosesAt(bet, config) + 120_000)) throw new UserError('Evidence is closed.');
}

async function acknowledge(db, config, row) {
  // The first stored item chooses the reply target even when this call is a retry.
  const first = await db.one(`select event_id from bet_evidence where bet_id = $1 and user_id = $2 order by at, id limit 1`, [row.bet_id, row.user_id]);
  const offer = first?.event_id ? null : await db.one(`select event_id from bet_commands
    where bet_id = $1 and kind = 'bet' order by created_at limit 1`, [row.bet_id]);
  const inReplyTo = first?.event_id || offer?.event_id;
  if (!inReplyTo) return;
  const bet = await evidenceBet(db, row.bet_id);
  const closesAt = bet.closes_at || new Date(new Date(bet.resolve_at).getTime() + config.play.evidenceWindowSeconds * 1000);
  await say(db, config, { key: `evidence-ack:${row.bet_id}:${row.user_id}`, inReplyTo, betId: row.bet_id,
    body: betReplies.evidenceAck({ closesAt, url: `${config.baseUrl}/bets/${row.bet_id}` }) });
}

/** Stores the exact, bounded text the jury will read; duplicate submissions reuse it. */
export async function submitEvidence(db, config, { betId, userId, side, url, via, eventId = null, fetchPage, receivedAt = Date.now() }) {
  if (!config.nearai?.rulings) throw new UserError('Evidence is unavailable.', 404);
  if (!['yes', 'no'].includes(side)) throw new UserError('Choose bet yes or bet no.');
  if (!['reply', 'page'].includes(via)) throw new UserError('Choose how to add this evidence.');
  const link = evidenceUrl(url);
  const arrivedAt = new Date(receivedAt).getTime();
  async function checked(tx, readAt = Date.now()) {
    const bet = await evidenceBet(tx, betId);
    checkBettor(bet, userId);
    const existing = await tx.one(`select * from bet_evidence where statement_id = $1 and user_id = $2 and url = $3`,
      [bet.statement_id, userId, link]);
    if (existing) {
      // A queued reply may finish after closing if an earlier attempt already stored it.
      if (via !== 'reply' || !eventId || existing.event_id !== eventId) checkWindow(bet, config, arrivedAt);
      return { bet, existing };
    }
    checkWindow(bet, config, arrivedAt);
    checkReadTime(bet, config, readAt);
    return { bet, existing: null };
  }
  const candidate = await evidenceBet(db, betId);
  checkBettor(candidate, userId);
  const reservationId = randomUUID();
  const initial = await db.tx(async (tx) => {
    await tx.query('select id from statements where id = $1 for update', [candidate.statement_id]);
    const state = await checked(tx);
    if (state.existing) return state;
    await tx.query('delete from bet_evidence_reservations where statement_id = $1 and expires_at <= clock_timestamp()', [state.bet.statement_id]);
    const { n } = await tx.one(`select (
      (select count(*) from bet_evidence where statement_id = $1 and user_id = $2) +
      (select count(*) from bet_evidence_reservations where statement_id = $1 and user_id = $2)
    )::int as n`, [state.bet.statement_id, userId]);
    if (n >= 2) throw new UserError('You can add at most two links per post.');
    if (await tx.one('select id from bet_evidence_reservations where statement_id = $1 and user_id = $2 and url = $3',
      [state.bet.statement_id, userId, link])) throw new UserError('That link is being read. Try again shortly.', 409);
    await tx.query(`insert into bet_evidence_reservations (id, statement_id, bet_id, user_id, url)
      values ($1,$2,$3,$4,$5)`, [reservationId, state.bet.statement_id, betId, userId, link]);
    return state;
  });
  if (initial.existing) {
    await acknowledge(db, config, initial.existing);
    return initial.existing;
  }
  let row;
  try {
    let article; let body; let finalUrl;
    let page;
    try {
      // safeFetch carries this one deadline through every redirect.
      const signal = AbortSignal.timeout(10_000);
      page = await (fetchPage || ((raw, options) => safeFetch(raw, {
        allowLoopback: config.fetch?.allowLoopback, timeoutMs: config.fetch?.timeoutMs,
        maxBytes: config.fetch?.maxBytes, userAgent: `StatedBot/0.1 (+${config.baseUrl})`,
        ...options,
      })))(link, { signal });
      signal.throwIfAborted();
    } catch { throw new UserError('That link could not be read.'); }
    const readAt = Date.now();
    checkReadTime(initial.bet, config, readAt);
    try {
      finalUrl = evidenceUrl(page.url || link);
      // In a worker with a three-second deadline: a hostile page cannot hold the event loop.
      article = await extractInWorker('evidence', page.body, finalUrl, { claim: initial.bet.claim });
      body = article.text;
      if (!body) throw new Error('Empty page');
    } catch (error) {
      throw error instanceof UserError && /too long/.test(error.message) ? error : new UserError('That link could not be read.');
    }
    row = await db.tx(async (tx) => {
      // The reservation survives network work without holding a statement lock.
      await tx.query('select id from statements where id = $1 for update', [initial.bet.statement_id]);
      const { bet, existing } = await checked(tx, readAt);
      if (existing) return existing;
      const slot = await tx.one(`select id from bet_evidence_reservations
        where id = $1 and expires_at > clock_timestamp()`, [reservationId]);
      if (!slot) throw new UserError('That evidence read expired. Submit the link again.', 409);
      // A link always counts for the side its poster bet on, whichever word the reply used.
      const own = String(bet.creator_user_id) === String(userId) ? bet.creator_side : (bet.creator_side === 'yes' ? 'no' : 'yes');
      const stored = await tx.one(`insert into bet_evidence (statement_id, bet_id, user_id, side, url, final_url, title, body, body_hash, via, event_id)
        values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) returning *`,
      [bet.statement_id, betId, userId, own, link, finalUrl, article.title?.slice(0, 1000) || null, body,
        createHash('sha256').update(body).digest('hex'), via, eventId]);
      await tx.query('delete from bet_evidence_reservations where id = $1', [reservationId]);
      return stored;
    });
  } finally {
    // Failed reads release their slot; a crashed process is recovered by the
    // database-clock expiry on the next submission, never by a stale worker.
    await db.query('delete from bet_evidence_reservations where id = $1', [reservationId]);
  }
  await acknowledge(db, config, row);
  return row;
}

export async function evidenceFor(tx, statementId) {
  return tx.many(`select e.*, u.x_username from bet_evidence e join users u on u.id = e.user_id
    where e.statement_id = $1 order by e.at, e.id`, [statementId]);
}

/** Allow the jury to start only after late reads stop and every matching reply finishes. */
export async function evidenceSettled(tx, statementId, now) {
  const plan = await tx.one('select closes_at from enclave_plans where statement_id = $1', [statementId]);
  if (!plan?.closes_at || !(new Date(now).getTime() >= new Date(plan.closes_at).getTime() + 150_000)) return false;
  const { queued } = await tx.one(`select exists (
    select 1 from evidence_commands c
    join users u on u.x_user_id = c.x_user_id and u.kind = 'person'
    join bilateral_bets b on (u.id = b.creator_user_id or u.id = b.acceptor_user_id)
    join saves s on s.id = b.source_save_id
    join statements st on st.id = s.statement_id join sources src on src.id = st.source_id
    where c.status = 'queued' and c.created_at < $2 and s.statement_id = $1 and (
      exists (select 1 from bot_outbox o where o.post_id = c.target_ref and o.bet_id = b.id)
      or exists (select 1 from bet_commands offer where offer.event_id = c.target_ref and offer.kind = 'bet' and offer.bet_id = b.id)
      or (src.platform = 'x' and src.platform_id = c.target_ref))) as queued`, [statementId, plan.closes_at]);
  return !queued;
}

/** A prompt is an outbox insert, so its dedupe key and prompted_at commit together. */
export async function evidencePrompts(db, config, { say: post }) {
  if (!config.nearai?.rulings) return { prompted: 0 };
  return db.tx(async (tx) => {
    const plans = await tx.many(`select * from enclave_plans where source = 'evidence' and prompted_at is null
      order by at for update skip locked`);
    let prompted = 0;
    for (const plan of plans) {
      const bets = await tx.many(`select b.id, b.resolve_at, c.event_id from bilateral_bets b
        join saves s on s.id = b.source_save_id
        join bet_commands c on c.bet_id = b.id and c.kind = 'bet'
        where s.statement_id = $1 and b.accepted_at is not null and b.acceptor_user_id is not null
          and b.status in ('accepted', 'proposed', 'disputed') order by b.created_at`, [plan.statement_id]);
      for (const bet of bets) {
        const closesAt = plan.closes_at || new Date(new Date(bet.resolve_at).getTime() + config.play.evidenceWindowSeconds * 1000);
        await post({ key: `evidence-prompt:${bet.id}`, inReplyTo: bet.event_id, betId: bet.id,
          body: betReplies.evidencePrompt({ closesAt, url: `${config.baseUrl}/bets/${bet.id}` }) }, tx);
        prompted += 1;
      }
      await tx.query('update enclave_plans set prompted_at = clock_timestamp() where statement_id = $1', [plan.statement_id]);
    }
    return { prompted };
  });
}

// As with take(), targets may be a bot reply, the offer command, or the source post.
// Only the bettors of a reply Bet may put work in the evidence queue.
export async function targetEvidenceBet(db, cmd) {
  return db.one(`select b.id, u.id as user_id, s.statement_id, b.resolve_at, p.closes_at from bilateral_bets b
    left join saves s on s.id = b.source_save_id
    left join enclave_plans p on p.statement_id = s.statement_id
    left join statements st on st.id = s.statement_id left join sources src on src.id = st.source_id
    join users u on u.x_user_id = $2 and u.kind = 'person' and (u.id = b.creator_user_id or u.id = b.acceptor_user_id)
    where b.referee_wallet is not null and b.chain_state is not null
      and b.status in ('accepted', 'proposed', 'disputed') and (
      exists (select 1 from bot_outbox o where o.post_id = $1 and o.bet_id = b.id)
      or exists (select 1 from bet_commands c where c.event_id = $1 and c.kind = 'bet' and c.bet_id = b.id)
      or (src.platform = 'x' and src.platform_id = $1))
    order by b.accepted_at desc nulls last, b.created_at desc limit 1`, [cmd.target_ref, cmd.x_user_id]);
}

/** Bounded retries for queue infrastructure failures; refusals never post a reply. */
export async function runEvidenceCommands(db, config, { limit = 6, fetchPage } = {}) {
  const result = { done: 0, refused: 0, retry: 0, failed: 0 };
  if (!config.nearai?.rulings) return result;
  const claimed = await db.tx(async (tx) => {
    const exhausted = await tx.query(`update evidence_commands set status = 'failed',
      detail = coalesce(detail, 'Evidence command stopped after three attempts.'), updated_at = clock_timestamp()
      where status = 'queued' and attempts >= 3 and updated_at < clock_timestamp() - interval '45 seconds'`);
    result.failed += exhausted.rowCount;
    const rows = await tx.many(`select c.event_id from evidence_commands c join (
      select event_id, row_number() over (partition by x_user_id order by created_at, event_id) as turn
      from evidence_commands where status = 'queued' and attempts < 3
        and (attempts = 0 or updated_at < clock_timestamp() - interval '45 seconds')
      ) q on q.event_id = c.event_id
      where c.status = 'queued' and c.attempts < 3
        and (c.attempts = 0 or c.updated_at < clock_timestamp() - interval '45 seconds')
      order by q.turn, c.created_at, c.event_id limit $1 for update of c skip locked`, [limit]);
    if (!rows.length) return [];
    const updated = await tx.many(`update evidence_commands set attempts = attempts + 1, updated_at = clock_timestamp()
      where event_id = any($1::text[]) returning *`, [rows.map((row) => row.event_id)]);
    // UPDATE RETURNING has no ordering guarantee; keep the round-robin claim order.
    const byId = new Map(updated.map((row) => [row.event_id, row]));
    return rows.map((row) => byId.get(row.event_id));
  });
  async function work(cmd) {
    try {
      const found = await targetEvidenceBet(db, cmd);
      if (!found?.user_id) throw new UserError('Not a bettor on this Bet.', 404);
      await submitEvidence(db, config, { betId: found.id, userId: found.user_id, side: cmd.side, url: cmd.url,
        via: 'reply', eventId: cmd.event_id, receivedAt: cmd.created_at, fetchPage });
      await db.query(`update evidence_commands set status = 'done', detail = null, updated_at = clock_timestamp()
        where event_id = $1 and status = 'queued'`, [cmd.event_id]);
      result.done += 1;
    } catch (error) {
      const status = error instanceof UserError ? 'refused' : cmd.attempts >= 3 ? 'failed' : 'queued';
      await db.query(`update evidence_commands set status = $2, detail = $3, updated_at = clock_timestamp()
        where event_id = $1 and status = 'queued'`, [cmd.event_id, status, String(error.message || error).slice(0, 300)]);
      result[status === 'queued' ? 'retry' : status] += 1;
    }
  }
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(6, claimed.length) }, async () => {
    while (next < claimed.length) await work(claimed[next++]);
  }));
  return result;
}
