// Persisted-state doubles exercise the production public projection and renderer.
// Publication filtering itself is also covered with Postgres in bet-public.test.mjs.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import test from 'node:test';
import { publicBetHall } from '../src/bet-public.mjs';
import { betList } from '../src/bet-view.mjs';

function storedBet(status = 'offered') {
  const row = { id: randomUUID(), creator_user_id: '1', acceptor_user_id: '2',
    claim: '<script>private words are escaped</script>', criteria: 'Official result',
    evidence_source_url: 'https://example.org/result', creator_side: 'yes',
    stake_yocto: '100000000000000000000000', accept_by: '2026-11-20T00:00:00.000Z',
    resolve_at: '2026-11-21T00:00:00.000Z', created_at: '2026-11-10T00:00:00.000Z',
    published_at: '2026-11-11T00:00:00.000Z', read_at: '2026-11-11T01:00:00.000Z',
    near_verified_at: '2026-11-11T00:59:00.000Z', near_height: '42',
    creator_wallet: 'creator.testnet', acceptor_wallet: 'other.testnet',
    creator_username: 'creator', acceptor_username: 'private_identity', acceptor_consented: false,
    creator_bound: true, acceptor_bound: true, terms_hash: 'a'.repeat(64),
    referee_wallet: 'referee.testnet' };
  row.chain_state = { id: row.id, terms_hash: row.terms_hash, creator_side: row.creator_side,
    stake_yocto: row.stake_yocto, creator: row.creator_wallet, creator_binding_hash: 'b'.repeat(64),
    accept_by_ns: (BigInt(Date.parse(row.accept_by)) * 1000000n).toString(),
    resolve_at_ns: (BigInt(Date.parse(row.resolve_at)) * 1000000n).toString(),
    status, referee: row.referee_wallet, acceptor: status === 'offered' ? null : row.acceptor_wallet,
    ...(status === 'offered' ? {} : { acceptor_binding_hash: 'c'.repeat(64) }),
    ...(status === 'settled' ? { resolution: { outcome: 'yes', method: 'referee' } } : {}) };
  return row;
}

function database(rows, paid = []) {
  const verified = rows.filter(row => row.near_verified_at && row.chain_state.stake_yocto === row.stake_yocto);
  const settled = verified.filter(row => row.chain_state.status === 'settled');
  const pot = count => (BigInt(count) * 200000000000000000000000n).toString();
  return { tx: async fn => fn({
    one: async sql => {
      assert.match(sql, /count\(\*\)::text as total/);
      return { total: String(verified.length), settled: String(settled.length),
        paid: pot(settled.filter(row => paid.includes(row.id)).length), won: pot(settled.length),
        has_open: verified.some(row => row.chain_state.status === 'offered' && new Date(row.accept_by) > new Date(row.read_at)) };
    },
    many: async sql => {
      assert.match(sql, /limit \$5/);
      return verified.map(row => ({ ...row, payout_completed: paid.includes(row.id),
        hall_open: Number(row.chain_state.status === 'offered' && new Date(row.accept_by) > new Date(row.read_at)),
        hall_rank: row.chain_state.status === 'offered' ? -Date.parse(row.accept_by) : Date.parse(row.published_at) }))
        .sort((a, b) => b.hall_open - a.hall_open || b.hall_rank - a.hall_rank);
    },
  }) };
}

test('hall lists every public verified bet included in its total', async () => {
  const rows = Array.from({ length: 8 }, () => storedBet('settled'));
  const invalid = storedBet(); invalid.chain_state.stake_yocto = '1';
  const unchecked = storedBet(); unchecked.near_verified_at = null;
  const hall = await publicBetHall(database([...rows, invalid, unchecked], [rows[7].id]));
  assert.equal(hall.total, 8);
  assert.equal(hall.settled, 8);
  assert.equal(hall.rows.length, 8);
  assert.equal(hall.paidYocto, '200000000000000000000000');
  const html = String(betList(hall.rows, { hall: true }));
  assert.match(html, /@creator won the 0\.2 test NEAR pot\./);
  assert.doesNotMatch(html, /private_identity|<script>/);
  assert.match(html, /&lt;script&gt;/);
  assert.equal((html.match(/class="prow note"/g) || []).length, 8);
  assert.match(html, /<span class="hl">&lt;script&gt;/);
  assert.match(html, new RegExp(`href="/bets/${rows[0].id}"`));
});

test('hall puts open offers in closing order before settled bets', async () => {
  const late = storedBet();
  const soon = storedBet();
  soon.accept_by = '2026-11-19T00:00:00.000Z';
  soon.chain_state.accept_by_ns = (BigInt(Date.parse(soon.accept_by)) * 1000000n).toString();
  const settled = storedBet('settled');
  const hall = await publicBetHall(database([late, settled, soon]));
  assert.deepEqual(hall.rows.map(bet => bet.id), [soon.id, late.id, settled.id]);
});

test('the public hall bounds database projection and keeps an older page reachable', async () => {
  const rows = Array.from({ length: 100 }, (_, i) => ({ ...storedBet('settled'), hall_open: '0', hall_rank: String(100 - i) }));
  const db = { tx: fn => fn(db), one: async () => ({ total: '100', settled: '100', paid: '0', won: '20000000000000000000000000' }),
    async many(sql, params) {
      assert.match(sql, /limit \$/i);
      const after = params[2];
      const limit = params[4];
      return rows.filter(row => !after || Number(row.hall_rank) < Number(after)).slice(0, limit);
    } };
  const first = await publicBetHall(db);
  assert.equal(first.total, 100);
  assert.ok(first.rows.length > 0 && first.rows.length < first.total);
  assert.ok(first.next);
  const second = await publicBetHall(db, { before: first.next });
  assert.ok(second.rows.length > 0);
  assert.equal(second.total, 100);
  assert.equal(second.rows.some(row => first.rows.some(bet => bet.id === row.id)), false);
});

test('an empty hall has no fabricated totals and plain statuses follow snapshots', async () => {
  assert.deepEqual(await publicBetHall(database([])), { rows: [], total: 0, settled: 0, paidYocto: '0', wonYocto: '0', hasOpen: false, next: null });
  const hall = await publicBetHall(database([storedBet(), storedBet('accepted')]));
  const html = String(betList(hall.rows, { hall: true }));
  assert.match(html, /Offer closes in \d+ (?:minutes?|hours?|days?), \d{2}:\d{2} UTC 20 Nov 2026/);
  assert.match(html, /Both sides are in/);
  assert.equal(hall.paidYocto, '0');
  const expired = storedBet();
  expired.accept_by = '2020-11-20T00:00:00.000Z';
  expired.chain_state.accept_by_ns = (BigInt(Date.parse(expired.accept_by)) * 1000000n).toString();
  const expiredHall = await publicBetHall(database([expired]));
  assert.match(String(betList(expiredHall.rows, { hall: true })), /Offer expired/);
  assert.doesNotMatch(String(betList(expiredHall.rows, { hall: true })), /Offer closes/);
});
