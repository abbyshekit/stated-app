import { baselineScore } from '../../score.mjs';
import { when } from './html.mjs';
import { PUBLIC_SAVE_SQL, profileIsPublic } from './privacy.mjs';
import { effectiveTerms, isBackfill, outcomeFor, publishedInTime, scoringProbability } from './terms.mjs';
import { isPlaceholder } from './xtext.mjs';

// A database ID from a path or a form. Anything that is not 1 to 18 digits
// is refused before it reaches Postgres, whose bigint it would overflow.
export function idOf(value, { message = 'That reference is not valid.', status = 400 } = {}) {
  const text = String(value ?? '').trim();
  if (!/^\d{1,18}$/.test(text)) throw new UserError(message, status);
  return text;
}

export class UserError extends Error {
  constructor(message, status = 400) {
    super(message);
    this.name = 'UserError';
    this.status = status;
  }
}

const SAVE_COLUMNS = `
  s.id as save_id, s.owner_x_user_id, s.owner_user_id, s.relation, s.visibility,
  s.annotation, s.watch_at, s.intake, s.created_at as saved_at, s.capture as save_capture,
  s.author_deadline_at, s.author_probability, s.author_condition, s.author_confirmed_at,
  s.author_probability_added, s.first_public_at, s.author_committed_deadline_at, s.author_deadline_moved_at,
  st.id as statement_id, st.span, st.speaker, st.speaker_x_user_id, st.reported_speech,
  st.deadline_text, st.proposed_deadline_at, st.deadline_at, st.probability,
  st.condition_text, st.hedges, st.reviewed_probability, st.reviewed_condition,
  st.terms_confirmed_by, st.terms_confirmed_at, st.capture as statement_capture,
  st.status, st.resolution_note, st.resolution_url, st.resolved_at, st.outcome_at, st.created_at as captured_at,
  src.id as source_id, src.platform, src.platform_id, src.url as source_url,
  src.author_username, src.author_name, src.author_x_user_id, src.title,
  src.published_at, src.available, src.author_protected, src.first_observed_at, src.checked_at as source_checked_at
`;

const SAVE_FROM = `
  from saves s
  join statements st on st.id = s.statement_id
  join sources src on src.id = st.source_id
`;

export const SAVE_SELECT = `select ${SAVE_COLUMNS} ${SAVE_FROM}`;

export const EDITORIAL_X_ID = 'editorial:desk';

export { effectiveTerms, isBackfill, outcomeFor, publishedInTime, scoringProbability };

export async function ensureDesk(db) {
  return db.one(
    `insert into users (x_user_id, x_username, x_name, kind, profile_visibility, default_save_visibility, setup_completed_at)
     values ($1, 'desk', 'Stated desk', 'editorial', 'public', 'public', now())
     on conflict (x_user_id) do update set updated_at = now()
     returning *`,
    [EDITORIAL_X_ID],
  );
}

export async function userById(db, id) {
  return db.one('select * from users where id = $1', [id]);
}

export async function userByXId(db, xUserId) {
  return db.one(`select * from users where x_user_id = $1 and kind = 'person'`, [xUserId]);
}

export async function personByUsername(db, username) {
  return db.one(
    `select * from users where kind = 'person' and lower(x_username) = lower($1)
     order by updated_at desc limit 1`,
    [String(username || '')],
  );
}

export async function signInFromX(db, me, { ref } = {}) {
  return db.tx(async (tx) => {
    const existing = await tx.one('select * from users where x_user_id = $1', [me.id]);
    if (existing && existing.kind !== 'person') throw new UserError('That account cannot sign in.', 403);
    // X handles are unique at any moment, so this sign-in proves the handle is
    // now theirs. Anyone else still recorded with it has renamed on X: their
    // profile moves to an ID-based address until they sign in again.
    await tx.query(
      `update users set x_username = 'id_' || x_user_id, updated_at = now()
       where kind = 'person' and lower(x_username) = lower($1) and x_user_id <> $2`,
      [me.username, me.id],
    );
    let user;
    if (existing) {
      user = await tx.one(
        `update users set x_username = $2, x_name = $3, x_avatar_url = $4, updated_at = now() where id = $1 returning *`,
        [existing.id, me.username, me.name || null, me.profile_image_url || null],
      );
      await tx.query(`insert into account_events (user_id, kind, detail) values ($1, 'signin', $2)`, [user.id, { username: me.username }]);
    } else {
      user = await tx.one(
        `insert into users (x_user_id, x_username, x_name, x_avatar_url, acquired_via) values ($1, $2, $3, $4, $5) returning *`,
        [me.id, me.username, me.name || null, me.profile_image_url || null, ref || null],
      );
      await tx.query(`insert into account_events (user_id, kind, detail) values ($1, 'created', $2)`, [user.id, { username: me.username, ref: ref || null }]);
    }
    const claimed = await tx.query(
      `update saves set owner_user_id = $1, updated_at = now()
       where owner_x_user_id = $2 and owner_user_id is null`,
      [user.id, me.id],
    );
    if (claimed.rowCount) {
      await tx.query(`insert into account_events (user_id, kind, detail) values ($1, 'claimed_pending', $2)`, [user.id, { saves: claimed.rowCount }]);
    }
    return user;
  });
}

function vis(value) {
  return value === 'public' ? 'public' : 'private';
}

export async function completeSetup(db, user, input) {
  const profile = vis(input.profileVisibility);
  const defaults = profile === 'public' ? vis(input.defaultSaveVisibility) : 'private';
  const publish = new Set((input.publishIds || []).map(String));
  return db.tx(async (tx) => {
    const updated = await tx.one(
      `update users set profile_visibility = $2, default_save_visibility = $3, dm_updates = $4,
         setup_completed_at = coalesce(setup_completed_at, now()), updated_at = now()
       where id = $1 returning *`,
      [user.id, profile, defaults, Boolean(input.dmUpdates)],
    );
    await tx.query(
      `insert into visibility_events (user_id, scope, from_value, to_value) values ($1, 'profile', $2, $3)`,
      [user.id, user.setup_completed_at ? user.profile_visibility : null, profile],
    );
    const saves = await tx.many(
      `select s.id, s.visibility, src.author_protected from saves s
       join statements st on st.id = s.statement_id join sources src on src.id = st.source_id
       where s.owner_user_id = $1`,
      [user.id],
    );
    for (const save of saves) {
      const next = profile === 'public' && publish.has(String(save.id)) && !save.author_protected ? 'public' : 'private';
      if (next === 'public') {
        await tx.query('update saves set first_public_at = coalesce(first_public_at, now()) where id = $1', [save.id]);
      }
      if (next !== save.visibility) {
        await tx.query('update saves set visibility = $2, updated_at = now() where id = $1', [save.id, next]);
        await tx.query(
          `insert into visibility_events (save_id, user_id, scope, from_value, to_value) values ($1, $2, 'save', $3, $4)`,
          [save.id, user.id, save.visibility, next],
        );
      }
    }
    await tx.query(`insert into account_events (user_id, kind, detail) values ($1, 'setup', $2)`, [
      user.id,
      { profile, defaults, published: [...publish].length },
    ]);
    return updated;
  });
}

// Going from private to public needs `confirmedSelection`: the owner saw the
// list of saves and chose which to publish. Nothing else becomes public.
// Going private withdraws every public page; a later return to public asks again.
export async function setProfileVisibility(db, user, input) {
  const next = vis(input.visibility);
  const goingPublic = next === 'public' && user.profile_visibility !== 'public';
  if (goingPublic && input.confirmedSelection !== true) {
    throw new UserError('Choose which saves to publish before making the profile public.');
  }
  let publishIds = [];
  if (next === 'public') {
    publishIds = goingPublic
      ? (input.publishIds || [])
      : (await db.many(`select id from saves where owner_user_id = $1 and visibility = 'public'`, [user.id])).map((r) => r.id);
  }
  return completeSetup(db, user, {
    profileVisibility: next,
    defaultSaveVisibility: input.defaultSaveVisibility ?? user.default_save_visibility,
    dmUpdates: input.dmUpdates ?? user.dm_updates,
    publishIds,
  });
}

async function ownedSave(db, user, saveId) {
  if (!/^\d{1,18}$/.test(String(saveId))) throw new UserError('That save is not in your collection.', 404);
  const save = await db.one(`${SAVE_SELECT} where s.id = $1 and s.owner_user_id = $2`, [saveId, user.id]);
  if (!save) throw new UserError('That save is not in your collection.', 404);
  return save;
}

export async function setSaveVisibility(db, user, saveId, visibility) {
  const save = await ownedSave(db, user, saveId);
  const next = vis(visibility);
  if (next === 'public' && user.profile_visibility !== 'public') {
    throw new UserError('Your profile is private. Make it public in settings first, then choose what to publish.');
  }
  if (next === 'public' && save.author_protected) {
    throw new UserError('That post is from a protected account. It stays private.');
  }
  if (next === save.visibility) return save;
  if (next === 'private') await noteWithdrawal(db, save);
  if (next === 'public' && save.owner_user_id) {
    await db.query('delete from public_withdrawals where owner_user_id = $1 and dedupe_key = $2', [save.owner_user_id, withdrawalKey(save)]);
  }
  await db.query(
    `update saves set visibility = $2, updated_at = now(),
       first_public_at = case when $2 = 'public' then coalesce(first_public_at, now()) else first_public_at end
     where id = $1`,
    [save.save_id, next],
  );
  await db.query(
    `insert into visibility_events (save_id, user_id, scope, from_value, to_value) values ($1, $2, 'save', $3, $4)`,
    [save.save_id, user.id, save.visibility, next],
  );
  return ownedSave(db, user, saveId);
}

export async function annotate(db, user, saveId, text) {
  await ownedSave(db, user, saveId);
  const note = String(text || '').trim().slice(0, 2000);
  await db.query('update saves set annotation = $2, updated_at = now() where id = $1', [saveId, note || null]);
}

export async function setWatch(db, user, saveId, when) {
  await ownedSave(db, user, saveId);
  const at = when ? new Date(when) : null;
  if (at && Number.isNaN(at.getTime())) throw new UserError('Enter a real date.');
  await db.query('update saves set watch_at = $2, updated_at = now() where id = $1', [saveId, at]);
}

function withdrawalKey(save) {
  return save.platform && save.platform_id ? `${save.platform}:${save.platform_id}` : `statement:${save.statement_id}`;
}

async function sourceOf(tx, statementId) {
  return tx.one(
    `select src.platform, src.platform_id from statements st join sources src on src.id = st.source_id where st.id = $1`,
    [statementId],
  );
}

async function noteWithdrawal(db, save) {
  if (save.relation !== 'mine' || save.visibility !== 'public' || !save.owner_user_id) return;
  if (!save.first_public_at) return;
  const due = effectiveTerms(save).deadlineAt;
  const known = save.outcome_at || save.resolved_at;
  const afterDeadline = Boolean(due && new Date(due).getTime() < Date.now());
  const afterOutcome = Boolean(known);
  if (!afterDeadline && !afterOutcome) return;
  const held = (save.status === 'yes' || save.status === 'no') ? outcomeFor(save) : null;
  await db.query(
    `insert into public_withdrawals (owner_user_id, dedupe_key, held_outcome, scoring_probability, after_outcome, after_deadline)
     values ($1, $2, $3, $4, $5, $6)
     on conflict (owner_user_id, dedupe_key) do update set
       held_outcome = excluded.held_outcome, scoring_probability = excluded.scoring_probability,
       after_outcome = excluded.after_outcome, after_deadline = excluded.after_deadline, at = now()`,
    [save.owner_user_id, withdrawalKey(save), held, scoringProbability(save), afterOutcome, afterDeadline],
  );
}

export async function rememberCommitment(tx, save) {
  if (save.relation !== 'mine' || !save.author_confirmed_at || !save.owner_x_user_id || !save.statement_id) return;
  let platform = save.platform;
  let platformId = save.platform_id;
  if (!platform || !platformId) {
    const src = await sourceOf(tx, save.statement_id);
    platform = src?.platform;
    platformId = src?.platform_id;
  }
  if (!platform || !platformId) return;
  await tx.query(
    `insert into author_commitments (owner_x_user_id, platform, platform_id, statement_id, committed_deadline_at, deadline_at, deadline_moved_at, probability, probability_added, condition, confirmed_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
     on conflict (owner_x_user_id, platform, platform_id) do update set
       statement_id = excluded.statement_id,
       committed_deadline_at = least(
         coalesce(author_commitments.committed_deadline_at, excluded.committed_deadline_at),
         coalesce(excluded.committed_deadline_at, author_commitments.committed_deadline_at)),
       deadline_at = excluded.deadline_at,
       deadline_moved_at = excluded.deadline_moved_at,
       probability = excluded.probability,
       probability_added = excluded.probability_added,
       condition = excluded.condition,
       confirmed_at = excluded.confirmed_at`,
    [
      save.owner_x_user_id,
      platform,
      platformId,
      save.statement_id,
      save.author_committed_deadline_at,
      save.author_deadline_at,
      save.author_deadline_moved_at,
      save.author_probability,
      Boolean(save.author_probability_added),
      save.author_condition,
      save.author_confirmed_at,
    ],
  );
}

export async function restoreCommitment(tx, save) {
  if (!save || save.relation !== 'mine' || !save.owner_x_user_id || !save.statement_id) return save;
  const src = await sourceOf(tx, save.statement_id);
  if (!src?.platform_id) return save;
  const kept = await tx.one(
    'select * from author_commitments where owner_x_user_id = $1 and platform = $2 and platform_id = $3',
    [save.owner_x_user_id, src.platform, src.platform_id],
  );
  if (!kept?.confirmed_at) return save;
  await tx.query(
    'update author_commitments set statement_id = $4 where owner_x_user_id = $1 and platform = $2 and platform_id = $3',
    [save.owner_x_user_id, src.platform, src.platform_id, save.statement_id],
  );
  const late = kept.committed_deadline_at && new Date(kept.committed_deadline_at).getTime() < Date.now();
  return tx.one(
    `update saves set author_deadline_at = $2, author_committed_deadline_at = $3, author_deadline_moved_at = $4,
       author_probability = $5, author_probability_added = $6, author_condition = $7, author_confirmed_at = $8,
       capture = case when $9 and capture = 'prospective' then 'backfill' else capture end,
       capture_reason = case when $9 and capture = 'prospective' then 'author_late' else capture_reason end,
       updated_at = now()
     where id = $1 returning *`,
    [
      save.id,
      kept.deadline_at,
      kept.committed_deadline_at,
      kept.deadline_moved_at,
      kept.probability,
      kept.probability_added,
      kept.condition,
      kept.confirmed_at,
      Boolean(late),
    ],
  );
}

export async function withdrawalsFor(db, userId) {
  if (!userId) return [];
  return db.many(
    'select held_outcome, scoring_probability, after_outcome, after_deadline from public_withdrawals where owner_user_id = $1',
    [userId],
  );
}

export async function removeSave(db, user, saveId) {
  const save = await ownedSave(db, user, saveId);
  await db.tx(async (tx) => {
    // Serialize against new Bet references as well as another removal. The FK
    // is the backstop for deletes through any other database caller.
    const locked = await tx.one('select id from saves where id = $1 and owner_user_id = $2 for update', [saveId, user.id]);
    if (!locked) throw new UserError('That save is not in your collection.', 404);
    if (await tx.one('select id from bilateral_bets where source_save_id = $1 limit 1', [saveId])) {
      throw new UserError('This post has a bet on it, so it stays. You can make it private instead.', 409);
    }
    await noteWithdrawal(tx, save);
    await rememberCommitment(tx, save);
    await tx.query('delete from saves where id = $1 and owner_user_id = $2', [saveId, user.id]);
  });
  return save.statement_id;
}

// The current address of a public save, by its stable ID, so an old link
// keeps working after its owner renames and cannot show someone else.
export async function publicSaveOwner(db, saveId) {
  const owner = await publicPredictionOwner(db, saveId);
  return owner?.kind === 'person' ? owner : null;
}

// Prediction actions support personal profiles and the editorial Desk. The
// person-profile URL resolver above remains restricted to personal owners.
export async function publicPredictionOwner(db, saveId) {
  if (!/^\d{1,18}$/.test(String(saveId))) return null;
  return db.one(
    `select u.* from saves s join users u on u.id = s.owner_user_id
     where s.id = $1 and u.kind in ('person','editorial') and ${PUBLIC_SAVE_SQL}`,
    [saveId],
  );
}

function parseProbability(value) {
  if (value === '' || value == null) return null;
  const n = Number(String(value).replace('%', ''));
  if (!Number.isFinite(n) || n < 1 || n > 99) throw new UserError('Enter a probability from 1 to 99, or leave it blank.');
  return Math.round(n * 10) / 1000;
}

function parseDate(value, label) {
  if (!value) return null;
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) throw new UserError(`Enter a real ${label}.`);
  return d;
}

function earliest(...values) {
  const dates = values.filter(Boolean).map((v) => new Date(v));
  return dates.length ? new Date(Math.min(...dates.map((d) => d.getTime()))) : null;
}

// Only the author of a statement can say what they meant. The confirmation
// is stored on their save, with the previous terms kept in the history.
//
// The prediction is held to the earliest deadline it ever had (the stated
// one, or the earliest the author confirmed). The author may move it later;
// the move is recorded and shown, but scoring, resolution and the public
// record still use the committed deadline. Terms lock once that deadline
// passes or the outcome is recorded. The score always uses the probability
// stated in the post; one the author adds or changes is shown, labelled and
// never scored. A committed deadline earlier than the save makes it backfill.
export async function confirmTerms(db, user, saveId, input) {
  const save = await ownedSave(db, user, saveId);
  if (save.relation !== 'mine' || save.speaker_x_user_id !== user.x_user_id) {
    throw new UserError('Only the author can confirm what a prediction means. Add a private note or a reminder date instead.', 403);
  }
  if (save.status !== 'open') throw new UserError('The outcome is already recorded. Request a correction instead.');
  const before = effectiveTerms(save);
  if (before.deadlineAt && new Date(before.deadlineAt).getTime() < Date.now()) {
    throw new UserError('The deadline has passed, so the terms are locked. Request a correction if the reading is wrong.');
  }
  const deadline = parseDate(input.deadlineAt, 'deadline');
  const probability = parseProbability(input.probability);
  const condition = String(input.condition || '').trim() || null;
  const stated = scoringProbability(save);
  const added = probability != null && (stated == null || Math.abs(probability - stated) > 1e-9);
  const authorFirst = earliest(save.author_committed_deadline_at, deadline);
  const committed = earliest(save.deadline_at || save.proposed_deadline_at, authorFirst);
  const moved = Boolean(deadline && committed && deadline.getTime() > committed.getTime());
  const sameMove = moved && save.author_deadline_at && new Date(save.author_deadline_at).getTime() === deadline.getTime();
  const movedAt = moved ? (sameMove && save.author_deadline_moved_at) || new Date() : null;
  const late = committed && committed < new Date(save.saved_at) && save.save_capture !== 'backfill';
  const notes = [String(input.note || '').trim()];
  if (moved && !sameMove) notes.push(`Moved the deadline from ${when(committed)} to ${when(deadline)}. The prediction is still held to ${when(committed)}.`);
  if (added) notes.push('The probability was added or changed by the author after posting, so it is not scored.');
  await db.tx(async (tx) => {
    await tx.query(
      `update saves set author_deadline_at = $2, author_probability = $3, author_condition = $4,
         author_probability_added = $5, author_committed_deadline_at = $6, author_deadline_moved_at = $7,
         author_confirmed_at = now(), updated_at = now() where id = $1`,
      [save.save_id, deadline, probability, condition, added, authorFirst, movedAt],
    );
    await tx.query(
      `insert into revisions (statement_id, save_id, kind, actor, before, after, note)
       values ($1, $2, 'author_terms', 'author', $3, $4, $5)`,
      [
        save.statement_id,
        save.save_id,
        { deadlineAt: before.deadlineAt, probability: before.probability, condition: before.condition },
        { deadlineAt: deadline, committedDeadlineAt: committed, probability, condition, probabilityAddedByAuthor: added },
        notes.filter(Boolean).join(' ') || null,
      ],
    );
    if (late) {
      await tx.query(`update saves set capture = 'backfill', capture_reason = 'author_late' where id = $1`, [save.save_id]);
      await tx.query(
        `insert into revisions (statement_id, save_id, kind, actor, before, after, note)
         values ($1, $2, 'capture_changed', 'system', $3, $4, $5)`,
        [save.statement_id, save.save_id, { capture: 'prospective' }, { capture: 'backfill' }, 'The committed deadline is earlier than the save, so it is backfill.'],
      );
    }
    await tx.query(
      `update inbox set done_at = now() where save_id = $1 and kind = 'pending_terms' and done_at is null`,
      [save.save_id],
    );
    await rememberCommitment(tx, {
      relation: 'mine',
      owner_x_user_id: save.owner_x_user_id,
      statement_id: save.statement_id,
      author_confirmed_at: new Date(),
      author_committed_deadline_at: authorFirst,
      author_deadline_at: deadline,
      author_deadline_moved_at: movedAt,
      author_probability: probability,
      author_probability_added: added,
      author_condition: condition,
    });
  });
}

export async function ownerCollections(db, user) {
  const rows = await db.many(`${SAVE_SELECT} where s.owner_user_id = $1 order by s.created_at desc`, [user.id]);
  return {
    mine: rows.filter((r) => r.relation === 'mine'),
    following: rows.filter((r) => r.relation === 'following'),
  };
}

export async function ownerSave(db, user, saveId) {
  if (!/^\d{1,18}$/.test(String(saveId))) return null;
  return db.one(`${SAVE_SELECT} where s.id = $1 and s.owner_user_id = $2`, [saveId, user.id]);
}

export async function publicCollections(db, user) {
  if (!profileIsPublic(user)) return null;
  const rows = await db.many(
    `${SAVE_SELECT} join users u on u.id = s.owner_user_id
     where s.owner_user_id = $1 and ${PUBLIC_SAVE_SQL}
     order by s.created_at desc`,
    [user.id],
  );
  return {
    mine: rows.filter((r) => r.relation === 'mine'),
    following: rows.filter((r) => r.relation === 'following'),
  };
}

export async function publicSave(db, user, saveId) {
  if (!profileIsPublic(user) || !/^\d{1,18}$/.test(String(saveId))) return null;
  return db.one(
    `${SAVE_SELECT} join users u on u.id = s.owner_user_id
     where s.id = $1 and s.owner_user_id = $2 and ${PUBLIC_SAVE_SQL}`,
    [saveId, user.id],
  );
}

// Is this statement visible to this viewer through any save they may see?
export async function canSeeStatement(db, user, statementId) {
  const row = await db.one(
    `select 1 as ok from saves s left join users u on u.id = s.owner_user_id
     where s.statement_id = $1 and ((s.owner_user_id is not null and s.owner_user_id = $2) or (${PUBLIC_SAVE_SQL}))
     limit 1`,
    [statementId, user?.id || 0],
  );
  return Boolean(row);
}

// Counts public followers only. A private follower is never counted.
export async function publicFollowerCount(db, statementId) {
  const row = await db.one(
    `select count(*)::int as n from saves s join users u on u.id = s.owner_user_id
     where s.statement_id = $1 and s.relation = 'following' and u.kind = 'person' and ${PUBLIC_SAVE_SQL}`,
    [statementId],
  );
  return row.n;
}

export async function searchPublic(db, q, limit = 40) {
  const term = String(q || '').trim();
  if (term.length < 2) return [];
  return db.many(
    `select ${SAVE_COLUMNS}, u.x_username as owner_username, u.kind as owner_kind
     ${SAVE_FROM} join users u on u.id = s.owner_user_id
     where ${PUBLIC_SAVE_SQL}
       and (st.span ilike $1 or st.speaker ilike $1 or coalesce(src.author_username, '') ilike $1 or coalesce(src.title, '') ilike $1)
     order by s.created_at desc limit $2`,
    [`%${term.replace(/[%_\\]/g, (c) => `\\${c}`)}%`, limit],
  );
}

export async function recentPublic(db, limit = 8) {
  return db.many(
    `select ${SAVE_COLUMNS}, u.x_username as owner_username, u.kind as owner_kind
     ${SAVE_FROM} join users u on u.id = s.owner_user_id
     where ${PUBLIC_SAVE_SQL}
     order by s.created_at desc limit $1`,
    [limit],
  );
}

// The forecasting record counts only My predictions captured before the
// outcome was known. Following, backfill, ambiguous, annulled and disputed
// records are listed and never scored. The score uses the probability stated
// when the claim was made. In a public record, a resolved prediction counts
// only if it was public before its deadline and outcome; one published
// afterwards is listed as published late.
export function recordOf(rows, { publicView = false, withdrawals = [] } = {}) {
  const mine = rows.filter((r) => r.relation === 'mine');
  const backfill = mine.filter(isBackfill);
  const prospective = mine.filter((r) => !isBackfill(r));
  const settled = prospective.filter((r) => r.status === 'yes' || r.status === 'no');
  const publishedLate = publicView ? settled.filter((r) => !publishedInTime(r)) : [];
  const resolved = publicView ? settled.filter((r) => publishedInTime(r)) : settled;
  const scores = [];
  for (const r of resolved) {
    const p = scoringProbability(r);
    if (p != null) scores.push(baselineScore(p, outcomeFor(r)));
  }
  let cameTrue = resolved.filter((r) => outcomeFor(r) === 'yes').length;
  let didNot = resolved.filter((r) => outcomeFor(r) === 'no').length;
  let resolvedCount = resolved.length;
  let withdrawnAfterOutcome = 0;
  let withdrawnAfterDeadline = 0;
  if (publicView) {
    for (const w of withdrawals) {
      if (w.after_outcome) withdrawnAfterOutcome += 1;
      else if (w.after_deadline) withdrawnAfterDeadline += 1;
      if (w.held_outcome === 'yes' || w.held_outcome === 'no') {
        resolvedCount += 1;
        if (w.held_outcome === 'yes') cameTrue += 1;
        else didNot += 1;
        if (w.scoring_probability != null) scores.push(baselineScore(Number(w.scoring_probability), w.held_outcome));
      }
    }
  }
  return {
    predictions: mine.length + (publicView ? withdrawals.length : 0),
    prospective: prospective.length,
    backfill: backfill.length,
    open: prospective.filter((r) => r.status === 'open').length,
    resolved: resolvedCount,
    cameTrue,
    didNot,
    unscorable: prospective.filter((r) => ['ambiguous', 'annulled', 'disputed'].includes(r.status)).length,
    publishedLate: publishedLate.length,
    withdrawnAfterOutcome,
    withdrawnAfterDeadline,
    scored: scores.length,
    averageBaseline: scores.length ? scores.reduce((a, b) => a + b, 0) / scores.length : null,
  };
}

export function isScored(row, { publicView = false } = {}) {
  return row.relation === 'mine' && !isBackfill(row) && (row.status === 'yes' || row.status === 'no')
    && (!publicView || publishedInTime(row));
}

export async function revisionsFor(db, statementId, saveIds = []) {
  return db.many(
    // Result history is shared too. This also protects old revisions and
    // reviewer input retained separately from the sanitized statement fields.
    `with privacy as (select exists (
       select 1 from bilateral_bets b join saves s on s.id = b.source_save_id
       where s.statement_id = $1 and not exists (
         select 1 from bilateral_bet_publications p
         where p.bet_id = b.id and p.creator_user_id = b.creator_user_id and p.withdrawn_at is null
       )
     ) as hide), history as (
       select r.*, (privacy.hide and r.kind in ('resolved', 'resolution_changed', 'disputed')) as redact
       from revisions r cross join privacy
       where r.statement_id = $1 and (r.save_id is null or r.save_id = any($2::bigint[]))
     )
     select id, statement_id, save_id, kind, actor,
       case when redact then before - 'url' - 'note' else before end as before,
       case when redact then after - 'url' - 'note' else after end as after,
       case when redact then 'Result recorded. Bet evidence stays on its Bet page.' else note end as note, at
     from history order by at, (kind = 'captured') desc, id`,
    [statementId, saveIds.map(String)],
  );
}

export async function requestCorrection(db, user, { statementId, kind, body, evidenceUrl }) {
  if (!user) throw new UserError('Sign in to request a correction.', 401);
  const id = idOf(statementId, { message: 'That record is not available.', status: 404 });
  if (!(await canSeeStatement(db, user, id))) throw new UserError('That record is not available.', 404);
  const text = String(body || '').trim();
  if (text.length < 10) throw new UserError('Say what is wrong, in a sentence.');
  const url = String(evidenceUrl || '').trim();
  if (url && !/^https?:\/\//i.test(url)) throw new UserError('The evidence link has to start with https://.');
  return db.one(
    `insert into correction_requests (statement_id, requester_user_id, kind, body, evidence_url)
     values ($1, $2, $3, $4, $5) returning *`,
    [id, user.id, kind === 'resolution' ? 'resolution' : 'interpretation', text.slice(0, 2000), url || null],
  );
}

export async function openCorrections(db) {
  return db.many(
    `select c.*, st.span, st.speaker, st.status, src.platform, src.url as source_url from correction_requests c
     join statements st on st.id = c.statement_id join sources src on src.id = st.source_id
     where c.status = 'open' order by c.created_at`,
  );
}

export async function reviewerSetTerms(db, reviewer, statementId, input) {
  if (input.correctionId) idOf(input.correctionId);
  const statement = await db.one('select * from statements where id = $1', [statementId]);
  if (!statement) throw new UserError('That record does not exist.', 404);
  const deadline = parseDate(input.deadlineAt, 'deadline');
  const probability = parseProbability(input.probability);
  const condition = String(input.condition || '').trim() || null;
  const speaker = String(input.speaker || '').trim().slice(0, 120);
  await db.tx(async (tx) => {
    if (speaker && speaker !== statement.speaker) {
      await tx.query('update statements set speaker = $2 where id = $1', [statementId, speaker]);
      await tx.query(
        `insert into revisions (statement_id, kind, actor, before, after, note) values ($1, 'attribution', 'reviewer', $2, $3, $4)`,
        [statementId, { speaker: statement.speaker }, { speaker }, String(input.note || '').trim() || null],
      );
    }
    // Only the fields the reviewer filled in change; a correction of
    // attribution alone leaves the terms as they were.
    const hasTerms = deadline || probability != null || condition;
    if (hasTerms) {
      const after = await tx.one(
        `update statements set deadline_at = coalesce($2, deadline_at), reviewed_probability = coalesce($3, reviewed_probability),
           reviewed_condition = coalesce($4, reviewed_condition), terms_confirmed_by = 'reviewer', terms_confirmed_at = now()
         where id = $1 returning *`,
        [statementId, deadline, probability, condition],
      );
      await tx.query(
        `insert into revisions (statement_id, kind, actor, before, after, note)
         values ($1, 'reviewer_terms', 'reviewer', $2, $3, $4)`,
        [
          statementId,
          {
            deadlineAt: statement.deadline_at || statement.proposed_deadline_at,
            probability: statement.reviewed_probability ?? statement.probability,
            condition: statement.reviewed_condition || statement.condition_text,
          },
          { deadlineAt: after.deadline_at, probability: after.reviewed_probability ?? after.probability, condition: after.reviewed_condition || after.condition_text },
          String(input.note || '').trim() || null,
        ],
      );
      // A reviewed deadline earlier than a save makes that save backfill. A
      // save that was backfill only because the deadline read from the text
      // had passed is prospective again when review confirms a later one: it
      // was made before that deadline and before any outcome. Historical
      // collections and undated old claims keep their label.
      if (deadline) {
        const late = await tx.many(
          `update saves set capture = 'backfill', capture_reason = 'late', updated_at = now()
           where statement_id = $1 and capture = 'prospective'
             and created_at > least(coalesce(author_committed_deadline_at, $2), $2) returning id`,
          [statementId, deadline],
        );
        const misread = after.status === 'open' && !after.outcome_at
          ? await tx.many(
            `update saves set capture = 'prospective', capture_reason = null, updated_at = now()
             where statement_id = $1 and capture = 'backfill' and capture_reason = 'late'
               and created_at <= least(coalesce(author_committed_deadline_at, $2), $2) returning id`,
            [statementId, deadline],
          )
          : [];
        if (misread.length && after.capture === 'backfill' && deadline > new Date()) {
          const historical = await tx.one(
            `select 1 as yes from saves where statement_id = $1 and capture_reason = 'historical' limit 1`,
            [statementId],
          );
          if (!historical) await tx.query(`update statements set capture = 'prospective' where id = $1`, [statementId]);
        }
        const changes = [
          ...late.map((s) => [s.id, 'prospective', 'backfill', 'Saved after the deadline confirmed in review, so it is backfill.']),
          ...misread.map((s) => [s.id, 'backfill', 'prospective', 'Saved before the deadline confirmed in review and before any outcome, so it is prospective.']),
        ];
        for (const [saveId, from, to, note] of changes) {
          await tx.query(
            `insert into revisions (statement_id, save_id, kind, actor, before, after, note)
             values ($1, $2, 'capture_changed', 'system', $3, $4, $5)`,
            [statementId, saveId, { capture: from }, { capture: to }, note],
          );
        }
      }
    }
    if (input.correctionId) {
      await tx.query(
        `update correction_requests set status = 'accepted', reviewer_note = $2, decided_at = now() where id = $1`,
        [input.correctionId, String(input.note || '').trim() || null],
      );
    }
  });
}

export async function decideCorrection(db, correctionId, { status, note }) {
  await db.query(
    `update correction_requests set status = $2, reviewer_note = $3, decided_at = now() where id = $1 and status = 'open'`,
    [correctionId, status === 'accepted' ? 'accepted' : 'rejected', String(note || '').trim() || null],
  );
}

export async function inboxFor(db, user, { open = true, prioritizeUpdates = false } = {}) {
  return db.many(
    `select i.*, st.span, s.relation from inbox i
     left join statements st on st.id = i.statement_id
     left join saves s on s.id = i.save_id
     where i.owner_x_user_id = $1 ${open ? 'and i.done_at is null' : ''}
     order by ${prioritizeUpdates ? "(i.kind in ('saved', 'pending_terms'))," : ''} i.created_at desc, i.id desc limit 100`,
    [user.x_user_id],
  );
}

export async function markInboxDone(db, user, id) {
  await db.query('update inbox set done_at = now() where id = $1 and owner_x_user_id = $2', [id, user.x_user_id]);
}

export async function addInbox(db, item) {
  return db.one(
    `insert into inbox (owner_x_user_id, kind, save_id, statement_id, intake_id, body, dedupe_key, deliver_dm, dm_status)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9)
     on conflict (dedupe_key) do nothing returning *`,
    [
      item.ownerXUserId,
      item.kind,
      item.saveId || null,
      item.statementId || null,
      item.intakeId || null,
      item.body,
      item.dedupeKey,
      Boolean(item.deliverDm),
      item.deliverDm ? 'pending' : 'none',
    ],
  );
}

function exportRow(row, { owner }) {
  const terms = effectiveTerms(row);
  const stored = row.available && !isPlaceholder(row);
  const base = {
    id: row.save_id,
    collection: row.relation === 'mine' ? 'my_predictions' : 'following',
    capture: isBackfill(row) ? 'backfill' : 'prospective',
    claim: stored ? row.span : null,
    speaker: row.speaker,
    reportedSpeech: row.reported_speech,
    source: row.available ? row.source_url : null,
    sourceTitle: row.title,
    publishedAt: row.published_at,
    savedAt: row.saved_at,
    firstPublicAt: row.first_public_at,
    deadlineText: row.deadline_text,
    deadlineAt: terms.deadlineAt,
    deadlineBasis: terms.deadlineBasis,
    deadlineMovedTo: terms.movedTo,
    deadlineMovedAt: terms.movedAt,
    probability: terms.probability,
    probabilityBasis: terms.probabilityBasis,
    scoredProbability: scoringProbability(row),
    condition: terms.condition,
    status: row.status,
    outcome: outcomeFor(row),
    outcomeKnownAt: row.outcome_at,
    resolutionNote: row.resolution_note,
    resolutionUrl: row.resolution_url,
    scored: isScored(row, { publicView: !owner }),
  };
  if (!owner) return base;
  return {
    ...base,
    textStored: stored,
    source: row.source_url,
    visibility: row.visibility,
    annotation: row.annotation,
    watchAt: row.watch_at,
  };
}

export async function ownerExport(db, user) {
  const { mine, following } = await ownerCollections(db, user);
  const rows = [...mine, ...following];
  return {
    exportedAt: new Date().toISOString(),
    account: {
      xUserId: user.x_user_id,
      username: user.x_username,
      profileVisibility: user.profile_visibility,
      defaultSaveVisibility: user.default_save_visibility,
    },
    record: recordOf(mine),
    saves: await Promise.all(rows.map(async (row) => ({
      ...exportRow(row, { owner: true }),
      history: await revisionsFor(db, row.statement_id, [row.save_id]),
    }))),
  };
}

export async function publicExport(db, user) {
  const collections = await publicCollections(db, user);
  if (!collections) return null;
  const rows = [...collections.mine, ...collections.following];
  return {
    exportedAt: new Date().toISOString(),
    profile: user.kind === 'editorial' ? 'desk' : user.x_username,
    scope: 'public entries only',
    record: recordOf(collections.mine, { publicView: true, withdrawals: await withdrawalsFor(db, user.id) }),
    saves: await Promise.all(rows.map(async (row) => ({
      ...exportRow(row, { owner: false }),
      history: await revisionsFor(db, row.statement_id, [row.save_id]),
    }))),
  };
}
