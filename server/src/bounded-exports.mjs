// INTEGRATION: bounded collection/export reads without changing store.mjs's private callers.
import { SAVE_SELECT, UserError, recordOf, isScored } from './store.mjs';
import { PUBLIC_SAVE_SQL, profileIsPublic } from './privacy.mjs';
import { effectiveTerms, isBackfill, outcomeFor, scoringProbability } from './terms.mjs';
import { isPlaceholder } from './xtext.mjs';

export const PUBLIC_PAGE_SIZE = 50;
export const OWNER_PAGE_SIZE = 200;
export const PUBLIC_HISTORY_SIZE = 500;
export const OWNER_HISTORY_SIZE = 2000;
// The record covers a person's whole public history, not one page: a prediction withdrawn after its
// outcome stays in the counts, so nobody improves a record by removing misses. Bounded all the same.
export const RECORD_CAP = 5000;

export async function publicRecord(db, user) {
  const rows = await db.many(`${SAVE_SELECT} join users u on u.id = s.owner_user_id
    where s.owner_user_id = $1 and ${PUBLIC_SAVE_SQL} and s.relation = 'mine'
    order by s.id desc limit $2`, [user.id, RECORD_CAP]);
  const record = recordOf(rows, { publicView: true });
  // Withdrawals retain counts only. Aggregate in PostgreSQL so removing a large
  // history cannot turn each public profile read into an unbounded row transfer.
  const held = await db.one(`select count(*)::text as total,
    (count(*) filter (where held_outcome='yes'))::text as yes,
    (count(*) filter (where held_outcome='no'))::text as no,
    (count(*) filter (where after_outcome))::text as after_outcome,
    (count(*) filter (where not after_outcome and after_deadline))::text as after_deadline,
    (count(*) filter (where held_outcome in ('yes','no') and scoring_probability is not null))::text as scored,
    coalesce(sum(100 * (ln(case when held_outcome='yes' then greatest(0.001,least(0.999,scoring_probability::double precision))
      else 1-greatest(0.001,least(0.999,scoring_probability::double precision)) end) - ln(0.5::double precision)) / -ln(0.5::double precision))
      filter (where held_outcome in ('yes','no') and scoring_probability is not null), 0) as score_total
    from public_withdrawals where owner_user_id=$1`, [user.id]);
  const scored = record.scored + Number(held.scored);
  return { ...record, predictions: record.predictions + Number(held.total),
    resolved: record.resolved + Number(held.yes) + Number(held.no),
    cameTrue: record.cameTrue + Number(held.yes), didNot: record.didNot + Number(held.no),
    withdrawnAfterOutcome: Number(held.after_outcome), withdrawnAfterDeadline: Number(held.after_deadline), scored,
    averageBaseline: scored ? ((record.averageBaseline || 0) * record.scored + Number(held.score_total)) / scored : null };
}

function cursor(params, name) {
  const value = params.get(name);
  if (value === null) return null;
  if (!/^[1-9]\d{0,17}$/.test(value)) throw new UserError('That page reference is invalid.', 400);
  return value;
}

function pageLink(url, values) {
  const next = new URL(url);
  for (const [name, value] of Object.entries(values)) {
    if (value == null) next.searchParams.delete(name);
    else next.searchParams.set(name, String(value));
  }
  return next.pathname + next.search;
}

export async function collectionPage(db, user, url, { owner = false } = {}) {
  if (!owner && !profileIsPublic(user)) return null;
  const before = cursor(url.searchParams, 'before');
  const through = cursor(url.searchParams, 'through');
  const ceiling = cursor(url.searchParams, 'ceiling');
  const nextBefore = cursor(url.searchParams, 'nextBefore');
  const limit = owner ? OWNER_PAGE_SIZE : PUBLIC_PAGE_SIZE;
  const rows = await db.many(`${SAVE_SELECT} ${owner ? '' : 'join users u on u.id = s.owner_user_id'}
    where s.owner_user_id = $1 ${owner ? '' : `and ${PUBLIC_SAVE_SQL}`}
      and ($2::bigint is null or s.id < $2::bigint)
      and ($4::bigint is null or s.id >= $4::bigint)
      and ($5::bigint is null or s.id <= $5::bigint)
    order by s.id desc limit $3`, [user.id, before, limit + 1, through, ceiling]);
  const items = rows.slice(0, limit);
  return {
    rows: items,
    mine: items.filter(row => row.relation === 'mine'),
    following: items.filter(row => row.relation === 'following'),
    limit, before, through, ceiling,
    next: through !== null
      ? (nextBefore ? pageLink(url, { before: nextBefore, historyAfter: null, through: null, ceiling: null, nextBefore: null }) : null)
      : (rows.length > limit ? pageLink(url, { before: items.at(-1).save_id, historyAfter: null }) : null),
  };
}

// Preserve the existing export shape; the store's exportRow is private.
function exportRow(row, owner) {
  const terms = effectiveTerms(row);
  const stored = row.available && !isPlaceholder(row);
  const base = {
    id: row.save_id, collection: row.relation === 'mine' ? 'my_predictions' : 'following',
    capture: isBackfill(row) ? 'backfill' : 'prospective', claim: stored ? row.span : null,
    speaker: row.speaker, reportedSpeech: row.reported_speech,
    source: row.available ? row.source_url : null, sourceTitle: row.title,
    publishedAt: row.published_at, savedAt: row.saved_at, firstPublicAt: row.first_public_at,
    deadlineText: row.deadline_text, deadlineAt: terms.deadlineAt, deadlineBasis: terms.deadlineBasis,
    deadlineMovedTo: terms.movedTo, deadlineMovedAt: terms.movedAt,
    probability: terms.probability, probabilityBasis: terms.probabilityBasis,
    scoredProbability: scoringProbability(row), condition: terms.condition,
    status: row.status, outcome: outcomeFor(row), outcomeKnownAt: row.outcome_at,
    resolutionNote: row.resolution_note, resolutionUrl: row.resolution_url,
    scored: isScored(row, { publicView: !owner }),
  };
  return owner ? { ...base, textStored: stored, source: row.source_url, visibility: row.visibility,
    annotation: row.annotation, watchAt: row.watch_at } : base;
}

export async function exportPage(db, user, url, { owner = false } = {}) {
  const page = await collectionPage(db, user, url, { owner });
  if (!page) return null;
  const after = cursor(url.searchParams, 'historyAfter');
  const historyLimit = owner ? OWNER_HISTORY_SIZE : PUBLIC_HISTORY_SIZE;
  // One revision query for the entire page. Pairing the save with its statement
  // excludes another save's private revisions even when the statement is shared.
  const revisions = page.rows.length ? await db.many(`
    with history as (
      select r.*, (r.kind in ('resolved', 'resolution_changed', 'disputed') and exists (
        select 1 from bilateral_bets b join saves s on s.id = b.source_save_id
        where s.statement_id = r.statement_id and not exists (
          select 1 from bilateral_bet_publications p
          where p.bet_id = b.id and p.creator_user_id = b.creator_user_id and p.withdrawn_at is null
        )
      )) as redact
    from revisions r where r.statement_id = any($1::bigint[])
      and (r.save_id is null or r.save_id = any($2::bigint[]))
      and ($3::bigint is null or r.id > $3::bigint)
    order by r.id limit $4)
    select id, statement_id, save_id, kind, actor,
      case when redact then before - 'url' - 'note' else before end as before,
      case when redact then after - 'url' - 'note' else after end as after,
      case when redact then 'Result recorded. Bet evidence stays on its Bet page.' else note end as note, at
    from history order by id`, [page.rows.map(row => row.statement_id), page.rows.map(row => row.save_id), after, historyLimit + 1]) : [];
  const history = revisions.slice(0, historyLimit);
  const historyContinues = revisions.length > historyLimit;
  return {
    exportedAt: new Date().toISOString(),
    ...(owner ? { account: { xUserId: user.x_user_id, username: user.x_username,
      profileVisibility: user.profile_visibility, defaultSaveVisibility: user.default_save_visibility } }
      : { profile: user.kind === 'editorial' ? 'desk' : user.x_username, scope: 'public entries only' }),
    record: recordOf(page.mine, { publicView: !owner }),
    recordScope: 'entries on this page only; excludes withdrawn entries',
    saves: page.rows.map(row => ({ ...exportRow(row, owner), history: history.filter(revision =>
      String(revision.statement_id) === String(row.statement_id)
      && (revision.save_id == null || String(revision.save_id) === String(row.save_id))) })),
    pagination: { limit: page.limit, historyLimit, historyContinues,
      // History continuation repeats the same saves; append histories by revision ID.
      next: historyContinues ? pageLink(url, { historyAfter: history.at(-1).id,
        // Pin both ends: removals cannot pull a different save into this batch,
        // and new saves cannot inherit the batch's revision cursor either.
        through: page.through || page.rows.at(-1).save_id,
        ceiling: page.ceiling || page.rows[0].save_id,
        nextBefore: page.next ? new URL(page.next, url).searchParams.get('before') : null,
      }) : page.next },
  };
}
