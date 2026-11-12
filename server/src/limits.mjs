// Per-person limits shared by every intake route (website, mention, DM).
import { UserError } from './store.mjs';

export const INTAKES_PER_HOUR = 20;

export async function intakesInLastHour(db, ownerXUserId) {
  const row = await db.one(
    `select count(*)::int as n from url_intakes where owner_x_user_id = $1 and created_at > now() - interval '1 hour'`,
    [ownerXUserId],
  );
  return row.n;
}

// Reserve before any network work. All intake writers must use this helper;
// a count outside this transaction cannot authorize an insertion.
export async function reserveIntake(db, { ownerXUserId, url, route, status = 'queued' }) {
  return db.tx(async (tx) => {
    await tx.query('select pg_advisory_xact_lock(hashtextextended($1, 0))', [`url-intake:${ownerXUserId}`]);
    if ((await intakesInLastHour(tx, ownerXUserId)) >= INTAKES_PER_HOUR) {
      throw new UserError(`You have tracked ${INTAKES_PER_HOUR} links in the last hour. Try again later.`, 429);
    }
    return tx.one(
      `insert into url_intakes (owner_x_user_id, url, route, status) values ($1, $2, $3, $4) returning *`,
      [ownerXUserId, url, route, status],
    );
  });
}
