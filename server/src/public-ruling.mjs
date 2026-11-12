// INTEGRATION: verified proof cache. Visibility and Bet bindings stay live on every request.
import { createHash } from 'node:crypto';
import { rulingCovers, verifyEnclaveRecordWithGpu } from './enclave-ruling.mjs';
import { UserError } from './store.mjs';

export function etagMatches(header, etag) {
  return typeof header === 'string' && header.split(',').some(value => {
    const tag = value.trim();
    return tag === '*' || tag.replace(/^W\//, '') === etag;
  });
}

export function createPublicRulingReader({ verify = verifyEnclaveRecordWithGpu, recipe,
  maxEntries = 16, maxBytes = 32 * 1024 * 1024, maxInFlight = 8 } = {}) {
  const cache = new Map();
  const pending = new Map();
  let bytes = 0;

  function drop(key) {
    const old = cache.get(key);
    if (old) bytes -= old.bytes;
    cache.delete(key);
  }

  async function verified(tx, row) {
    const key = String(row.event_id);
    const old = cache.get(key);
    if (old?.revision === row.event_revision) {
      cache.delete(key);
      cache.set(key, old);
      return old;
    }
    drop(key);
    const pendingKey = `${key}:${row.event_revision}`;
    if (pending.has(pendingKey)) return pending.get(pendingKey);
    if (pending.size >= maxInFlight) throw new UserError('Ruling verification is busy. Retry shortly.', 503);
    const load = (async () => {
      const event = await tx.one('select detail from bilateral_bet_events where id = $1', [row.event_id]);
      if (!event) return null;
      let record;
      try { record = await verify(event.detail); } catch { return null; }
      const entry = { revision: row.event_revision, record, bytes: Buffer.byteLength(JSON.stringify(record)),
        body: null, etag: null, agrees: undefined };
      if (entry.bytes <= maxBytes && maxEntries > 0) {
        while (cache.size >= maxEntries || bytes + entry.bytes > maxBytes) drop(cache.keys().next().value);
        cache.set(key, entry);
        bytes += entry.bytes;
      }
      return entry;
    })();
    pending.set(pendingKey, load);
    try { return await load; } finally { pending.delete(pendingKey); }
  }

  return async (tx, betId) => {
    // xmin invalidates same-ID edits to event.detail. Holding the event/publication
    // locks keeps the cold read and the authorization snapshot consistent.
    const row = await tx.one(`select e.id as event_id, e.xmin::text as event_revision,
      b.id, b.status, b.outcome, b.claim, b.resolve_at, b.evidence_source_url, b.terms_hash,
      (select s.statement_id from saves s where s.id=b.source_save_id) as statement_id
      from bilateral_bets b
      join bilateral_bet_publications p on p.bet_id=b.id and p.creator_user_id=b.creator_user_id
      join bilateral_bet_events e on e.bet_id=b.id and e.kind='enclave_ruling'
      where b.id=$1 and p.withdrawn_at is null order by e.id limit 1 for share of b,p,e`, [betId]);
    if (!row) return null;
    const entry = await verified(tx, row);
    if (!entry) return null;
    const record = entry.record;
    if (record.material.claim !== row.claim || record.material.deadline !== new Date(row.resolve_at).toISOString()
      || record.material.postUrl !== row.evidence_source_url
      || !rulingCovers(record, { betId: row.id, termsHash: row.terms_hash })) return null;
    if (record.evidence.kind === 'submitted') {
      // Same anonymous evidence visibility policy as evidenceForBet, selecting IDs only.
      const rows = row.statement_id ? await tx.many(`select e.id from bet_evidence e
        join users u on u.id=e.user_id join bilateral_bets b on b.id=e.bet_id
        where e.statement_id=$1 and (e.bet_id=$2
          or exists (select 1 from bilateral_bet_publications p
            where p.bet_id=b.id and p.creator_user_id=b.creator_user_id and p.withdrawn_at is null))`,
      [row.statement_id, betId]) : [];
      const visible = new Set(rows.map(item => String(item.id)));
      if (record.evidence.items.some(item => !visible.has(String(item.id)))) return null;
    }
    const settled = row.status === 'settled' && ['yes', 'no'].includes(row.outcome);
    const agrees = record.mode === 'review' && record.outcome !== 'unclear' && settled ? record.outcome === row.outcome : null;
    if (entry.body === null || entry.agrees !== agrees) {
      const body = JSON.stringify({ record: { ...record, agrees }, recipe });
      const bodyBytes = Buffer.byteLength(body);
      // Account for BOTH the proof object and serialized response in the LRU budget.
      const key = String(row.event_id);
      if (cache.get(key) === entry) {
        bytes -= entry.bytes;
        entry.bytes = Buffer.byteLength(JSON.stringify(record)) + bodyBytes;
        bytes += entry.bytes;
        while (bytes > maxBytes && cache.size) drop(cache.keys().next().value);
      }
      entry.body = body;
      entry.etag = `"${createHash('sha256').update(body).digest('hex')}"`;
      entry.agrees = agrees;
    }
    return { record: { ...record, agrees }, body: entry.body, etag: entry.etag };
  };
}
