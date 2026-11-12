// INTEGRATION: publicBet supplies the validated public projection, including its
// referee settlement hash. Reviewer routes must lock bilateral_bets FOR UPDATE
// before obtaining that projection and call publishPublicResultEvidence inside
// the same transaction. This serializes writes and prevents duplicate events.
// The evidence is a historical explanation published after settlement; it is
// never contemporaneous rationale. This module reads only public result events,
// never statements, saves, source material, or private notes.
import { idOf, UserError } from './store.mjs';

const HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

function resultKey(bet) {
  return bet && typeof bet === 'object'
    && bet.settled_by === 'referee'
    && ['yes', 'no'].includes(bet.outcome)
    && typeof bet.id === 'string'
    && HASH.test(bet.settlement_transaction_hash || '')
    && typeof bet.referee_wallet === 'string' && bet.referee_wallet.length > 0
    && validIso(bet.settled_at)
    ? { id: bet.id, hash: bet.settlement_transaction_hash, outcome: bet.outcome,
      referee: bet.referee_wallet, settledAt: bet.settled_at }
    : null;
}

function validIso(value) {
  if (typeof value !== 'string') return false;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) && date.toISOString() === value;
}

function timestamp(value) {
  if (value == null) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function parseEvidence(detail, key, at) {
  const publishedAt = timestamp(at);
  if (!detail || typeof detail !== 'object' || Array.isArray(detail)
    || detail.outcome !== key.outcome || detail.referee !== key.referee
    || detail.transactionHash !== key.hash
    || typeof detail.note !== 'string' || detail.note.length < 1 || detail.note.length > 600
    || detail.note !== detail.note.trim()
    || typeof detail.url !== 'string' || typeof detail.knownAt !== 'string'
    || !validIso(detail.knownAt) || !publishedAt) return null;
  let url;
  try { url = new URL(detail.url); } catch { return null; }
  if (url.protocol !== 'https:' || url.username || url.password || detail.url.length > 2048
    || new Date(detail.knownAt) > new Date(publishedAt)
    || new Date(detail.knownAt) > new Date(key.settledAt)) return null;
  return { note: detail.note, url: detail.url, knownAt: detail.knownAt, publishedAt };
}

async function resultEvent(tx, key) {
  const row = await tx.one(`select detail, at from bilateral_bet_events
    where bet_id=$1 and kind='public_result_evidence'
      and detail->>'transactionHash'=$2 and detail->>'outcome'=$3
      and detail->>'referee'=$4
    order by id limit 1`, [key.id, key.hash, key.outcome, key.referee]);
  return row ? { evidence: parseEvidence(row.detail, key, row.at) } : null;
}

function inputEvidence(input, key) {
  const note = typeof input?.note === 'string' ? input.note.trim() : '';
  if (!note || note.length > 600) throw new UserError('Enter a result explanation of 1 to 600 characters.');
  const urlText = typeof input?.url === 'string' ? input.url : '';
  let url;
  try { url = new URL(urlText); } catch { throw new UserError('Enter an absolute HTTPS link for the result evidence.'); }
  if (urlText.length > 2048 || url.protocol !== 'https:' || url.username || url.password) {
    throw new UserError('Use an HTTPS result link of 2048 characters or fewer, without embedded credentials.');
  }
  const knownAt = input?.knownAt;
  if (!validIso(knownAt)) throw new UserError('Enter when the result became known as a UTC ISO timestamp.');
  const knownTime = new Date(knownAt).getTime();
  if (knownTime > Date.now() || knownTime > new Date(key.settledAt).getTime()) {
    throw new UserError('The result cannot have become known after settlement.');
  }
  return { outcome: key.outcome, referee: key.referee,
    transactionHash: key.hash, note, url: urlText, knownAt };
}

export async function readPublicResultEvidence(tx, bet) {
  const key = resultKey(bet);
  return key ? (await resultEvent(tx, key))?.evidence || null : null;
}

export async function publishPublicResultEvidence(tx, reviewerId, bet, input) {
  const key = resultKey(bet);
  if (!key) throw new UserError('Public referee settlement evidence is unavailable for this bet.', 409);
  const actor = idOf(reviewerId, { message: 'Sign in to publish result evidence.', status: 401 });
  const detail = inputEvidence(input, key);
  const prior = await resultEvent(tx, key);
  if (prior) {
    if (prior.evidence) return prior.evidence;
    throw new UserError('Published result evidence is invalid and cannot be replaced.', 409);
  }
  const row = await tx.one(`insert into bilateral_bet_events
    (bet_id, actor_user_id, kind, detail) values ($1, $2, 'public_result_evidence', $3)
    returning at`, [key.id, actor, detail]);
  const publishedAt = timestamp(row?.at);
  if (!publishedAt) throw new Error('Result evidence insert returned no publication time.');
  return { note: detail.note, url: detail.url, knownAt: detail.knownAt, publishedAt };
}
