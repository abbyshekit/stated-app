import { UserError } from './store.mjs';

export const OAUTH_STATE_TTL_SECONDS = 15 * 60;
const PENDING_LIMIT = { signin: 1024, bot: 16 };

export async function reserveOAuthState(db, { state, verifier, purpose, returnTo = null, ref = null }) {
  const pending = await db.tx(async tx => {
    // All issuers share this lock across replicas. Bot authorization has its own capacity.
    await tx.query("select pg_advisory_xact_lock(hashtextextended('oauth-states', 0))");
    await tx.query(`delete from oauth_states where created_at <= statement_timestamp() - $1::int * interval '1 second'`,
      [OAUTH_STATE_TTL_SECONDS]);
    const usage = await tx.one(`select count(*)::int as count,
      ceil($2::int - extract(epoch from statement_timestamp() - min(created_at)))::int as retry_after
      from oauth_states where purpose = $1`, [purpose, OAUTH_STATE_TTL_SECONDS]);
    if (usage.count >= PENDING_LIMIT[purpose]) return Math.max(1, usage.retry_after);
    await tx.query(`insert into oauth_states (state, code_verifier, purpose, return_to, ref, created_at)
      values ($1, $2, $3, $4, $5, statement_timestamp())`, [state, verifier, purpose, returnTo, ref]);
    return 0;
  });
  if (pending) throw new UserError('Too many sign-ins are pending. Try again shortly.', 429, { retryAfter: pending });
}
