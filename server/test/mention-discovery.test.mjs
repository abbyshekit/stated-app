import test from 'node:test';
import assert from 'node:assert/strict';
import { createDb, kvGet } from '../src/db.mjs';
import { pollMentionDiscovery } from '../src/mention-discovery.mjs';
import { startPostgres } from './support/pg.mjs';

let pg;
let db;

test.before(async () => {
  pg = await startPostgres();
  db = createDb(pg.url);
  await db.migrate();
});

test.after(async () => {
  await db?.close();
  pg?.stop();
});

async function reset() {
  await db.query("delete from kv where key = 'mention_discovery_state'");
}

async function state() {
  const saved = await kvGet(db, 'mention_discovery_state');
  return saved ? JSON.parse(saved) : null;
}

test('advisory lock limits concurrent pollers and commits one real intake', async () => {
  await reset();
  let release;
  let entered;
  const held = new Promise((resolve) => { release = resolve; });
  const started = new Promise((resolve) => { entered = resolve; });
  let calls = 0;
  const x = { async searchMentions() { calls += 1; return { data: [{ id: '101', author_id: '7' }] }; } };
  const processMention = async (post) => {
    entered();
    await held;
    await db.query("insert into mention_events (event_id, author_x_user_id, outcome) values ($1, $2, 'stored') on conflict do nothing", [post.id, post.author_id]);
  };
  const first = pollMentionDiscovery(db, x, { baselineId: '100', processMention, now: 1_000_000 });
  await started;
  const second = await pollMentionDiscovery(db, x, { baselineId: '100', processMention, now: 1_000_000 });
  assert.equal(second.status, 'busy');
  release();
  assert.equal((await first).status, 'ok');
  assert.equal(calls, 1);
  assert.equal((await db.one('select count(*)::int as n from mention_events')).n, 1);
});

test('failed search records its attempt timestamp and throttles the next call', async () => {
  await reset();
  let calls = 0;
  const x = { async searchMentions() { calls += 1; throw Object.assign(new Error('unavailable'), { status: 503 }); } };
  const args = { baselineId: '200', processMention() {}, now: 2_000_000 };
  assert.deepEqual(await pollMentionDiscovery(db, x, args), { status: 'search_error', httpStatus: 503 });
  assert.equal((await pollMentionDiscovery(db, x, { ...args, now: 2_000_001 })).status, 'throttled');
  assert.equal(calls, 1);
  assert.equal((await state()).lastAttempt, 2_000_000);
});

test('keeps newest ID pending across pages, then advances to the highest returned ID', async () => {
  await reset();
  const seen = [];
  const pages = [
    { data: [{ id: '120' }, { id: '115' }], meta: { next_token: 'page-2' } },
    { data: [{ id: '118' }] },
  ];
  const x = { async searchMentions(args) { return pages.shift(); } };
  const processMention = async (post) => { seen.push(post.id); };
  assert.deepEqual(await pollMentionDiscovery(db, x, { baselineId: '100', processMention, now: 3_000_000 }), { status: 'ok', processed: 2, hasMore: true });
  assert.deepEqual(await state(), { sinceId: '100', lastAttempt: 3_000_000, nextToken: 'page-2', newest: '120' });
  assert.deepEqual(await pollMentionDiscovery(db, x, { baselineId: '100', processMention, now: 3_120_000 }), { status: 'ok', processed: 1, hasMore: false });
  assert.deepEqual(seen, ['115', '120', '118']);
  assert.deepEqual(await state(), { sinceId: '120', lastAttempt: 3_120_000 });
});

test('expired pagination token retries from the unchanged cursor without skipping IDs', async () => {
  await reset();
  const requests = [];
  const x = { async searchMentions(args) {
    requests.push(args);
    if (requests.length === 1) return { data: [{ id: '301' }], meta: { next_token: 'stale' } };
    if (requests.length === 2) throw Object.assign(new Error('bad token'), { status: 400 });
    return { data: [{ id: '299' }, { id: '302' }] };
  } };
  const seen = [];
  const processMention = async (post) => { seen.push(post.id); };
  await pollMentionDiscovery(db, x, { baselineId: '250', processMention, now: 4_000_000 });
  assert.equal((await pollMentionDiscovery(db, x, { baselineId: '250', processMention, now: 4_120_000 })).status, 'search_error');
  assert.deepEqual(await state(), { sinceId: '250', lastAttempt: 4_120_000 });
  await pollMentionDiscovery(db, x, { baselineId: '250', processMention, now: 4_240_000 });
  assert.equal(requests[1].paginationToken, 'stale');
  assert.equal(requests[2].sinceId, '250');
  assert.equal(requests[2].paginationToken, undefined);
  assert.deepEqual(seen, ['301', '299', '302']);
  assert.equal((await state()).sinceId, '302');
});

test('processing failure leaves cursor unchanged and idempotent intake absorbs retry', async () => {
  await reset();
  await db.query('delete from mention_events');
  const x = { async searchMentions() { return { data: [{ id: '401', author_id: '9' }] }; } };
  let failOnce = true;
  const processMention = async (post) => {
    await db.query("insert into mention_events (event_id, author_x_user_id, outcome) values ($1, $2, 'stored') on conflict do nothing", [post.id, post.author_id]);
    if (failOnce) { failOnce = false; throw new Error('downstream failed after idempotent write'); }
  };
  assert.equal((await pollMentionDiscovery(db, x, { baselineId: '400', processMention, now: 5_000_000 })).status, 'processing_error');
  assert.equal((await state()).sinceId, '400');
  assert.equal((await pollMentionDiscovery(db, x, { baselineId: '400', processMention, now: 5_120_000 })).status, 'ok');
  assert.equal((await db.one('select count(*)::int as n from mention_events')).n, 1);
  assert.equal((await state()).sinceId, '401');
});

test('saved discovery state contains IDs and pagination metadata only', async () => {
  await reset();
  const x = { async searchMentions() { return { data: [{ id: '501', text: 'private post body', author_id: '22' }], meta: { next_token: 'opaque-page-token' } }; } };
  await pollMentionDiscovery(db, x, { baselineId: '500', processMention() {}, now: 6_000_000 });
  const raw = await kvGet(db, 'mention_discovery_state');
  assert.deepEqual(JSON.parse(raw), { sinceId: '500', lastAttempt: 6_000_000, nextToken: 'opaque-page-token', newest: '501' });
  assert.equal(raw.includes('private post body'), false);
  assert.equal(raw.includes('author_id'), false);
});

test('explicit all mode discovers recent posts older than the ordinary mention watermark', async () => {
  await reset();
  const seen = [];
  const x = { async searchMentions(args) {
    assert.equal(args.sinceId, undefined);
    return { data: [{ id: '150' }] };
  } };
  const result = await pollMentionDiscovery(db, x, { baselineId: '200', includeRecentBacklog: true,
    processMention: async post => seen.push(post.id), now: 7_000_000 });
  assert.equal(result.status, 'ok');
  assert.deepEqual(seen, ['150']);
  assert.equal((await state()).sinceId, '150');
});
