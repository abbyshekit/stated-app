// INTEGRATION: cookies carry random bearer tokens; sessions.id contains only their SHA-256 digest.
import { createHash } from 'node:crypto';
import { sameString, token } from './crypto.mjs';

export const sessionDigest = value => createHash('sha256').update(value).digest('hex');

export async function createSession(db, userId, days) {
  const bearer = token(32);
  await db.query(`insert into sessions (id, user_id, csrf, expires_at) values ($1, $2, $3, now() + ($4 || ' days')::interval)`,
    [sessionDigest(bearer), userId, token(24), String(days)]);
  return bearer;
}

export async function sessionFor(db, bearer) {
  // A database digest (64 hex characters) is never a valid cookie token.
  if (typeof bearer !== 'string' || !/^[A-Za-z0-9_-]{43}$/.test(bearer)) return null;
  const digest = sessionDigest(bearer);
  const session = await db.one('select * from sessions where id = $1 and expires_at > now()', [digest]);
  if (!session) {
    // Indexed exact-key cleanup of a presented legacy raw-token row, never a full-table scan.
    await db.query('delete from sessions where id = $1', [bearer]);
    return null;
  }
  return sameString(session.id, digest) ? session : null;
}
