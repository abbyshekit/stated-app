// Per-person limits shared by every intake route (website, mention, DM).
export const INTAKES_PER_HOUR = 20;

export async function intakesInLastHour(db, ownerXUserId) {
  const row = await db.one(
    `select count(*)::int as n from url_intakes where owner_x_user_id = $1 and created_at > now() - interval '1 hour'`,
    [ownerXUserId],
  );
  return row.n;
}
