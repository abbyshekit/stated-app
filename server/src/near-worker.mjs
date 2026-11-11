// INTEGRATION: Runs independently of the X worker; schema must add near_attempted_at.
import { syncNearBet } from './near-bets.mjs';
import { syncPendingBetTransactions } from './near-execution-state.mjs';

export async function syncNearBets(db, config, { limit = 10, fetchImpl = fetch } = {}) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 10) throw new RangeError('limit must be an integer from 1 to 10');
  const claimed = await db.tx(async (tx) => {
    const rows = await tx.many(`select u.*, b.id as bet_id, b.chain_state as before_chain_state
      from bilateral_bets b join users u on u.id = b.creator_user_id
      where (b.status in ('offered', 'accepted', 'proposed', 'disputed')
        or exists (select 1 from bilateral_near_requests r where r.bet_id=b.id
          and r.execution_status='pending' and r.transaction_hash is not null))
        and u.kind = 'person' and u.setup_completed_at is not null
        and exists (select 1 from bilateral_near_requests r where r.bet_id = b.id and r.method = 'create_bet')
        and (b.near_attempted_at is null or b.near_attempted_at <= clock_timestamp() - interval '60 seconds')
        and not b.near_absent_after_expiry
      order by b.near_attempted_at asc nulls first, b.created_at, b.id
      limit $1 for update of b skip locked`, [limit]);
    if (rows.length) await tx.query('update bilateral_bets set near_attempted_at = clock_timestamp() where id = any($1::uuid[])', [rows.map((row) => row.bet_id)]);
    return rows;
  });
  const result = { checked: 0, changed: 0, errors: 0 };
  for (const row of claimed) {
    result.checked += 1;
    try {
      const { bet_id: betId, before_chain_state: before, ...creator } = row;
      const after = await syncNearBet(db, config, creator, betId, { fetchImpl });
      const transactions = await syncPendingBetTransactions(db, config, betId, { fetchImpl });
      if (JSON.stringify(before) !== JSON.stringify(after.chain_state) || transactions) result.changed += 1;
    } catch {
      result.errors += 1;
    }
  }
  return result;
}

export function startNearWorker(db, config, { intervalMs = 60000, fetchImpl = fetch, onError } = {}) {
  if (!Number.isFinite(intervalMs) || intervalMs <= 0) throw new RangeError('intervalMs must be positive');
  let stopped = false;
  let timer;
  const schedule = (delay) => {
    timer = setTimeout(run, delay);
    timer.unref?.();
  };
  async function run() {
    if (stopped) return;
    try {
      const result = await syncNearBets(db, config, { fetchImpl });
      if (result.errors) onError?.(new Error(`${result.errors} NEAR escrow checks failed; they will retry after the backoff.`));
    } catch (error) {
      try { onError?.(error); } catch { /* Error reporting must not stop reconciliation. */ }
    } finally {
      if (!stopped) schedule(intervalMs);
    }
  }
  schedule(0);
  return () => { stopped = true; clearTimeout(timer); };
}
