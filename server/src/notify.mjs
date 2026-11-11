// Updates go to the owner's inbox, and to a DM only when the owner opted in.
// There is no public fallback: a DM that cannot be sent stays in the inbox.
// Inbox bodies never quote a post: the post is shown from its record when the
// inbox is read, so a deleted post leaves nothing behind in the inbox.

import { kvSet } from './db.mjs';
import { addInbox, idOf, UserError } from './store.mjs';
import { cameTrueLate } from './terms.mjs';
import { goneOnX, postText } from './xapi.mjs';
import { dropOembed, readTerms, xClaimText } from './xtext.mjs';

const DAY = 24 * 60 * 60 * 1000;

function fmt(date) {
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric',
  }).format(new Date(date));
}

export async function scanDeadlines(db, now = new Date()) {
  // The author's own confirmation counts only on the author's save, and the
  // deadline is the committed one: the earliest the prediction ever had.
  const due = `coalesce(least(case when s.relation = 'mine' then s.author_committed_deadline_at end,
                              coalesce(st.deadline_at, st.proposed_deadline_at)), s.watch_at)`;
  const rows = await db.many(
    `select s.id as save_id, s.owner_x_user_id, s.relation, s.watch_at,
            case when s.relation = 'mine' then s.author_committed_deadline_at end as author_deadline_at,
            st.id as statement_id, st.speaker, st.deadline_at, st.proposed_deadline_at,
            ${due} as due, u.dm_updates
     from saves s
     join statements st on st.id = s.statement_id
     left join users u on u.id = s.owner_user_id
     where st.status = 'open'
       and s.intake <> 'editorial'
       and s.capture = 'prospective'
       and ${due} is not null
       and ${due} <= $1::timestamptz + interval '7 days'`,
    [now],
  );
  const created = [];
  for (const row of rows) {
    const due = new Date(row.due);
    const left = due.getTime() - now.getTime();
    const window = left <= 0 ? 'passed' : (left <= 2 * DAY ? 'two_days' : 'week');
    let basis = 'your own reminder date';
    if (row.author_deadline_at && (!row.deadline_at && !row.proposed_deadline_at
      || new Date(row.author_deadline_at) <= new Date(row.deadline_at || row.proposed_deadline_at))) basis = 'the deadline you committed to';
    else if (row.deadline_at) basis = 'the deadline confirmed in review';
    else if (row.proposed_deadline_at) basis = 'the deadline as read from the post, not confirmed';
    const lead = window === 'passed'
      ? `The deadline passed on ${fmt(due)}`
      : `The deadline is ${fmt(due)}, ${window === 'two_days' ? 'within two days' : 'within a week'}`;
    const body = `${lead} for a prediction by ${row.speaker}. The date is ${basis}.${window === 'passed' ? ' The outcome is recorded once the source is clear.' : ''}`;
    const item = await addInbox(db, {
      ownerXUserId: row.owner_x_user_id,
      kind: 'deadline',
      saveId: row.save_id,
      statementId: row.statement_id,
      body,
      dedupeKey: `deadline:${row.save_id}:${window}:${due.toISOString()}`,
      deliverDm: Boolean(row.dm_updates),
    });
    if (item) created.push(item);
  }
  return created;
}

const NEEDS_NOTE = new Set(['ambiguous', 'annulled', 'disputed']);

// A reviewer records the outcome with evidence and the date it became known.
// Yes and No need an https evidence link; Ambiguous, Annulled and Disputed
// need an explanation; any change of outcome needs a new note. A change keeps
// the earlier outcome in the history. Saves made on or after the date the
// outcome became known are backfill.
export async function resolveStatement(db, { statementId, outcome, note, url, reviewer, correctionId, outcomeAt = null }) {
  if (correctionId) idOf(correctionId);
  if (!['yes', 'no', 'ambiguous', 'annulled', 'disputed'].includes(outcome)) {
    throw new UserError('Record yes, no, ambiguous, annulled, or disputed.');
  }
  const evidence = String(url || '').trim();
  if (evidence && !/^https:\/\//i.test(evidence)) throw new UserError('The evidence link has to start with https://.');
  if ((outcome === 'yes' || outcome === 'no') && !evidence) {
    throw new UserError('Add an https link to the evidence for this outcome.');
  }
  const text = String(note || '').trim();
  if (NEEDS_NOTE.has(outcome) && !text) throw new UserError('Explain why this outcome is ambiguous, annulled or disputed.');
  if ((outcome === 'yes' || outcome === 'no') && !outcomeAt) {
    throw new UserError('Enter the date the outcome became known.');
  }
  const before = await db.one('select * from statements where id = $1', [statementId]);
  if (!before) throw new UserError('That record does not exist.', 404);
  if (before.status !== 'open' && before.status !== outcome && (!text || text === before.resolution_note)) {
    throw new UserError('Changing an outcome needs a new note explaining the change.');
  }
  const known = outcomeAt ? new Date(outcomeAt) : new Date();
  if (Number.isNaN(known.getTime())) throw new UserError('Enter the date the outcome became known.');
  if (known.getTime() > Date.now() + 60_000) throw new UserError('The outcome cannot be known in the future.');
  if (before.status === outcome && before.resolution_url === (evidence || null) && (!text || text === before.resolution_note)) return before;
  const statement = await db.tx(async (tx) => {
    const updated = await tx.one(
      `update statements set status = $2, resolution_note = $3, resolution_url = $4, resolved_at = now(), resolved_by = $5,
         outcome_at = $6
       where id = $1 returning *`,
      [statementId, outcome, text || (before.status === outcome ? before.resolution_note : null), evidence || null, reviewer?.id || null, known],
    );
    const kind = outcome === 'disputed' ? 'disputed' : (before.status === 'open' ? 'resolved' : 'resolution_changed');
    await tx.query(
      `insert into revisions (statement_id, kind, actor, before, after, note) values ($1, $2, 'reviewer', $3, $4, $5)`,
      [
        statementId,
        kind,
        { status: before.status, note: before.resolution_note, url: before.resolution_url },
        { status: updated.status, note: updated.resolution_note, url: updated.resolution_url, knownAt: known },
        text || null,
      ],
    );
    const late = await tx.many(
      `update saves set capture = 'backfill', capture_reason = 'outcome_known', updated_at = now()
       where statement_id = $1 and capture = 'prospective' and created_at >= $2 returning id`,
      [statementId, known],
    );
    for (const save of late) {
      await tx.query(
        `insert into revisions (statement_id, save_id, kind, actor, before, after, note) values ($1, $2, 'capture_changed', 'system', $3, $4, $5)`,
        [statementId, save.id, { capture: 'prospective' }, { capture: 'backfill' }, `Saved on or after ${fmt(known)}, when the outcome became known.`],
      );
    }
    if (correctionId) {
      await tx.query(
        `update correction_requests set status = 'accepted', reviewer_note = $2, decided_at = now() where id = $1`,
        [correctionId, text || null],
      );
    }
    return updated;
  });
  await notifyOutcome(db, statement);
  return statement;
}

export async function notifyOutcome(db, statement) {
  const saves = await db.many(
    `select s.id, s.owner_x_user_id, s.relation, s.capture, u.dm_updates,
       s.author_confirmed_at, s.author_committed_deadline_at, s.author_deadline_at
     from saves s left join users u on u.id = s.owner_user_id
     where s.statement_id = $1 and s.intake <> 'editorial'`,
    [statement.id],
  );
  const word = {
    yes: 'It came true',
    no: 'It did not come true',
    ambiguous: 'Ambiguous, so it is not scored',
    annulled: 'Annulled, so it is not scored',
    disputed: 'The outcome is disputed, so it is not scored',
  }[statement.status];
  const scorable = statement.status === 'yes' || statement.status === 'no';
  const created = [];
  for (const save of saves) {
    let counts = '';
    if (save.relation !== 'mine') counts = ' You follow this claim. It does not count toward your score.';
    else if (save.capture === 'backfill') counts = ' It is backfill, so it is not scored.';
    else if (cameTrueLate({ ...statement, ...save })) counts = ' It became known only after the deadline you committed to, so it counts as did not come true by then.';
    else if (scorable) counts = ' It counts toward your record.';
    const item = await addInbox(db, {
      ownerXUserId: save.owner_x_user_id,
      kind: 'outcome',
      saveId: save.id,
      statementId: statement.id,
      body: `Outcome recorded for a prediction by ${statement.speaker}: ${word}.${statement.resolution_note ? ` ${statement.resolution_note}` : ''}${counts}`,
      dedupeKey: `outcome:${save.id}:${statement.status}:${new Date(statement.resolved_at).getTime()}`,
      deliverDm: Boolean(save.dm_updates),
    });
    if (item) created.push(item);
  }
  return created;
}

export async function deliverDms(db, x, config, { limit = 20 } = {}) {
  const items = await db.many(
    `select i.*, u.dm_opted_out_at from inbox i left join users u on u.x_user_id = i.owner_x_user_id and u.kind = 'person'
     where i.dm_status = 'pending' order by i.created_at limit $1`,
    [limit],
  );
  const results = [];
  for (const item of items) {
    if (!config.x.dmEnabled || !x?.sendDm) {
      await db.query(`update inbox set dm_status = 'unavailable', dm_error = 'Direct messages are not enabled for this bot.' where id = $1`, [item.id]);
      results.push({ id: item.id, status: 'unavailable' });
      continue;
    }
    if (item.dm_opted_out_at) {
      await db.query(`update inbox set dm_status = 'unavailable', dm_error = 'You sent STOP, so no messages are sent.' where id = $1`, [item.id]);
      results.push({ id: item.id, status: 'unavailable' });
      continue;
    }
    // X allows a bot to DM only someone who has messaged it first.
    const opened = await db.one('select 1 as ok from dm_events where sender_x_user_id = $1 limit 1', [item.owner_x_user_id]);
    if (!opened) {
      await db.query(
        `update inbox set dm_status = 'unavailable', dm_error = 'Send the bot a direct message first. X lets it reply only after you write.' where id = $1`,
        [item.id],
      );
      results.push({ id: item.id, status: 'unavailable' });
      continue;
    }
    try {
      await x.sendDm({ to: item.owner_x_user_id, text: `${item.body}\n\n${config.baseUrl}/me/inbox` });
      await db.query(`update inbox set dm_status = 'sent', dm_error = null where id = $1`, [item.id]);
      results.push({ id: item.id, status: 'sent' });
    } catch (err) {
      await db.query(`update inbox set dm_status = 'failed', dm_error = $2 where id = $1`, [item.id, String(err.message || err).slice(0, 300)]);
      results.push({ id: item.id, status: 'failed' });
      if (err.status === 429 || err.status === 402) break;
    }
  }
  return results;
}

// Removes every stored copy of a post's words: the source text, the claim,
// the term fragments, the history fields, the stored mention payloads and the
// inbox bodies of every save of it.
export async function scrubSource(tx, sourceId, platformId, reason) {
  dropOembed(platformId);
  await tx.query(`update sources set available = false, text = '', title = null, checked_at = now() where id = $1`, [sourceId]);
  await tx.query(
    `update statements set span = 'Post removed on X (record ' || id || ')', deadline_text = null, condition_text = null, hedges = '{}'
     where source_id = $1`,
    [sourceId],
  );
  await tx.query(
    `update revisions set after = after - 'deadlineText' - 'condition' - 'hedges'
     where statement_id in (select id from statements where source_id = $1) and after is not null`,
    [sourceId],
  );
  await tx.query(
    `update mention_events set payload = null
     where save_id in (select s.id from saves s join statements st on st.id = s.statement_id where st.source_id = $1)
        or event_id = $2
        or payload::text like $3`,
    [sourceId, platformId, `%"${platformId}"%`],
  );
  await tx.query(
    `update inbox set body = 'A post you saved is no longer available on X, so its words are no longer stored.'
     where statement_id in (select id from statements where source_id = $1) and kind in ('saved', 'deadline', 'outcome', 'pending_terms')`,
    [sourceId],
  );
  await tx.query(
    `update saves set visibility = 'private', updated_at = now()
     where statement_id in (select id from statements where source_id = $1) and visibility = 'public'`,
    [sourceId],
  );
  await tx.query(
    `insert into revisions (statement_id, kind, actor, note)
     select id, 'source_unavailable', 'system', $2 from statements where source_id = $1`,
    [sourceId, `The original post ${reason}. Its words are no longer stored or shown.`],
  );
}

// An X post that no save refers to any more is deleted outright.
export async function purgeOrphanXSources(db) {
  const gone = await db.many(
    `delete from sources src where src.platform = 'x'
       and not exists (select 1 from statements st join saves s on s.statement_id = st.id where st.source_id = src.id)
     returning id, platform_id`,
  );
  for (const g of gone) {
    await db.query(`update mention_events set payload = null where event_id = $1 or payload::text like $2`, [g.platform_id, `%"${g.platform_id}"%`]);
  }
  return gone.length;
}

async function applyEdit(db, source, post, botUsername) {
  const current = postText(post);
  const claim = xClaimText(current, botUsername);
  const statement = await db.one('select * from statements where source_id = $1 order by id limit 1', [source.id]);
  const terms = readTerms(claim, source.published_at || new Date(), { keepWords: true });
  await db.tx(async (tx) => {
    await tx.query('update sources set text = $2, checked_at = now() where id = $1', [source.id, current]);
    if (!statement) return;
    await tx.query(
      `update statements set span = $2, deadline_text = $3, proposed_deadline_at = $4, probability = $5, condition_text = $6, hedges = $7
       where id = $1`,
      [statement.id, claim, terms.deadlineText, terms.proposedDeadlineAt, terms.probability, terms.condition, terms.hedges],
    );
    await tx.query(
      `insert into revisions (statement_id, kind, actor, before, after, note) values ($1, 'source_edited', 'system', $2, $3, $4)`,
      [
        statement.id,
        { proposedDeadlineAt: statement.proposed_deadline_at, probability: statement.probability },
        { proposedDeadlineAt: terms.proposedDeadlineAt, probability: terms.probability },
        'The author edited the post on X. The text shown is the current version, and its terms were read again.',
      ],
    );
  });
}

// A post whose words are stored (a public record) is re-checked against X at
// least daily: due after 20 hours, and the worker runs this hourly. A
// link-only post (saved privately, words not stored) is checked every
// `privateCheckDays` (default 7; 0 turns it off), for existence only.
// "available" means X returned the post at the last check, whose date is
// kept and shown. Posts are read in batches of 100 until none is due. A post
// counts as gone only when X says it was not found or is not authorised;
// any other omission, and any error, leaves it for the next run.
function dueSql(privateCheckDays, publicEveryHours = 20) {
  const days = Math.max(0, Number(privateCheckDays) || 0);
  const hours = Math.max(1, Number(publicEveryHours) || 20);
  const linkOnly = days
    ? `or (src.text = '' and coalesce(src.checked_at, src.first_observed_at) < now() - interval '${days * 24 - 8} hours')`
    : '';
  return `src.platform = 'x' and src.available and (
    (src.text <> '' and (src.checked_at is null or src.checked_at < now() - interval '${hours} hours')) ${linkOnly})`;
}

// A batch `rehydrate` result means the stored public text is stale. Read
// those posts again. A protected author is removed here the same way a
// deletion is. Private saves store no words, so there is nothing to refresh.
export async function refreshEdited(db, x, ids) {
  const wanted = [...new Set((ids || []).map(String))].filter(Boolean);
  if (!wanted.length) return [];
  let data;
  try {
    data = await x.posts(wanted);
  } catch {
    return [];
  }
  const posts = new Map((data.data || []).map((p) => [p.id, p]));
  const users = new Map((data.includes?.users || []).map((u) => [u.id, u]));
  const botUsername = (await x.identity().catch(() => ({})))?.username;
  const done = [];
  for (const id of wanted) {
    const source = await db.one(`select * from sources where platform = 'x' and platform_id = $1 and available`, [id]);
    const post = posts.get(id);
    if (!source || !post) continue;
    if (users.get(post.author_id)?.protected) {
      await db.tx(async (tx) => {
        await scrubSource(tx, source.id, source.platform_id, 'is now from a protected account');
        await tx.query('update sources set author_protected = true where id = $1', [source.id]);
      });
      continue;
    }
    const current = postText(post);
    if (source.text && current && current !== source.text) {
      await applyEdit(db, source, post, botUsername);
      done.push(source.id);
    }
  }
  return done;
}

export async function checkSources(db, x, { maxBatches = 1000, privateCheckDays = 7, publicEveryHours = 20, lookup = 'full' } = {}) {
  const purged = await purgeOrphanXSources(db);
  const gone = [];
  const edited = [];
  const errors = [];
  const botUsername = (await x.identity().catch(() => ({})))?.username;
  const seen = new Set();
  for (let batchNo = 0; batchNo < maxBatches; batchNo += 1) {
    const batch = (await db.many(
      `select src.* from sources src where ${dueSql(privateCheckDays, publicEveryHours)}
       order by src.checked_at nulls first, src.id limit 100`,
    )).filter((s) => !seen.has(s.id));
    if (!batch.length) break;
    batch.forEach((s) => seen.add(s.id));
    let data;
    try {
      data = await x.posts(
        batch.map((s) => s.platform_id),
        lookup === 'id-only' ? { fields: 'author_id,text', expansions: '' } : undefined,
      );
    } catch (err) {
      errors.push({ batch: batchNo, error: String(err.message || err) });
      break;
    }
    const posts = new Map((data.data || []).map((p) => [p.id, p]));
    const users = new Map((data.includes?.users || []).map((u) => [u.id, u]));
    for (const source of batch) {
      try {
        const post = posts.get(source.platform_id);
        const author = post ? users.get(post.author_id) : null;
        if (post && !author?.protected) {
          const current = postText(post);
          if (source.text && current && current !== source.text) {
            await applyEdit(db, source, post, botUsername);
            edited.push(source.id);
          } else {
            await db.query('update sources set checked_at = now() where id = $1', [source.id]);
          }
          continue;
        }
        if (!post && !goneOnX(data.errors, source.platform_id)) {
          errors.push({ source: source.id, error: 'X omitted this post without saying it is gone; checked again next run.' });
          continue;
        }
        const reason = post ? 'is now from a protected account' : 'is no longer available on X';
        await db.tx(async (tx) => {
          await scrubSource(tx, source.id, source.platform_id, reason);
          if (post) await tx.query('update sources set author_protected = true where id = $1', [source.id]);
        });
        gone.push(source.id);
        const saves = await db.many(
          `select s.id, s.owner_x_user_id, st.id as statement_id, u.dm_updates from saves s
           join statements st on st.id = s.statement_id left join users u on u.id = s.owner_user_id
           where st.source_id = $1`,
          [source.id],
        );
        for (const save of saves) {
          await addInbox(db, {
            ownerXUserId: save.owner_x_user_id,
            kind: 'source_unavailable',
            saveId: save.id,
            statementId: save.statement_id,
            body: `A post you saved ${reason}. Its words are no longer stored or shown, and the save is now private.`,
            dedupeKey: `gone:${save.id}`,
            deliverDm: Boolean(save.dm_updates),
          });
        }
      } catch (err) {
        errors.push({ source: source.id, error: String(err.message || err) });
        await db.query('update sources set checked_at = now() where id = $1', [source.id]).catch(() => {});
      }
    }
  }
  const overdue = privateCheckDays
    ? `or (src.text = '' and coalesce(src.checked_at, src.first_observed_at) < now() - interval '${Math.max(0, Number(privateCheckDays)) + 1} days')`
    : '';
  const backlogHours = Math.max(1, Number(publicEveryHours) || 20) + 4;
  const backlog = await db.one(
    `select count(*)::int as n from sources src where src.platform = 'x' and src.available and (
       (src.text <> '' and (src.checked_at is null or src.checked_at < now() - interval '${backlogHours} hours')) ${overdue})`,
  );
  await kvSet(db, 'source_check_backlog', String(backlog.n));
  return { gone, edited, errors, purged, backlog: backlog.n };
}
