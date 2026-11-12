import assert from 'node:assert/strict';
import { test } from 'node:test';
import { face } from '../src/certificate.mjs';
import { createHash } from 'node:crypto';
import http from 'node:http';
import { createSession, sessionFor, sessionDigest } from '../src/session-tokens.mjs';
import { collectionPage, exportPage, PUBLIC_PAGE_SIZE, OWNER_PAGE_SIZE, PUBLIC_HISTORY_SIZE, RECORD_CAP } from '../src/bounded-exports.mjs';
import { clientAddress, createReadLimiter } from '../src/public-read-limits.mjs';
import { createPublicRulingReader } from '../src/public-ruling.mjs';
import { registerBetRoutes } from '../src/bet-pages.mjs';
import { verifyEnclaveRecordWithGpu } from '../src/enclave-ruling.mjs';
import { enclaveRulingFixture } from './support/enclave.mjs';
import { loadConfig } from '../src/config.mjs';
const { createApp } = await import(process.env.LANE_D_WEB || '../src/web.mjs');

test('X-hosted avatars render as initial letters without a browser request to X', () => {
  const rendered = String(face({ url: 'https://pbs.twimg.com/profile_images/1/photo.jpg', name: '@alice' }));
  assert.doesNotMatch(rendered, /<img|pbs\.twimg\.com/);
  assert.match(rendered, />a<\/span>/);
});

const owner = { id: '1', x_user_id: '100', x_username: 'alice', kind: 'person',
  profile_visibility: 'public', setup_completed_at: new Date() };
const url = path => new URL(path, 'https://stated.example');
const save = id => ({ save_id: String(id), statement_id: String(id), relation: 'mine',
  status: 'open', saved_at: new Date(), available: true, span: `Claim ${id}`, speaker: '@alice' });

async function serving(t, handler) {
  const server = http.createServer(handler);
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => server.close(resolve)));
  return `http://127.0.0.1:${server.address().port}`;
}

test('fresh bearer lookup hashes before querying; stolen digests and legacy rows do not authenticate', async () => {
  const rows = new Map();
  const db = {
    async query(sql, values) {
      if (sql.startsWith('insert')) rows.set(values[0], { id: values[0], user_id: values[1], csrf: values[2] });
      else if (sql.startsWith('delete')) rows.delete(values[0]);
      else assert.fail(sql);
    },
    async one(sql, [id]) { assert.match(sql, /where id = \$1/); return rows.get(id) || null; },
  };
  const bearer = await createSession(db, '1', 30);
  const digest = sessionDigest(bearer);
  assert.equal(digest, createHash('sha256').update(bearer).digest('hex'));
  assert.equal(rows.has(bearer), false);
  assert.equal((await sessionFor(db, bearer)).id, digest);
  assert.equal(await sessionFor(db, digest), null);
  const legacy = 'L'.repeat(43);
  rows.set(legacy, { id: legacy });
  assert.equal(await sessionFor(db, legacy), null);
  assert.equal(rows.has(legacy), false);
  rows.set(digest, { id: 'mismatched'.padEnd(64, '0') });
  assert.equal(await sessionFor(db, bearer), null, 'the returned ID is checked in constant time');
});

test('HTTP auth accepts a fresh token, rejects a stolen row, enforces CSRF and signs out the hashed row', async t => {
  const bearer = 'A'.repeat(43);
  const digest = sessionDigest(bearer);
  let stored = { id: digest, user_id: owner.id, csrf: 'csrf-from-session' };
  const db = {
    async one(sql, values) {
      if (sql.includes('from sessions')) return stored?.id === values[0] ? stored : null;
      if (sql.includes('from users where id')) return owner;
      if (sql.includes('count(*)::int as n from inbox')) return { n: 0 };
      if (sql.includes('from bot_credentials')) return null;
      assert.fail(sql);
    },
    async many(sql) { assert.match(sql, /from inbox/); return []; },
    async query(sql, values) {
      assert.match(sql, /delete from sessions/);
      if (stored?.id === values[0]) stored = null;
    },
  };
  const base = await serving(t, createApp({ db, config: loadConfig({ STATED_BASE_URL: 'http://localhost' }) }));
  const headers = { cookie: `stated_sid=${bearer}` };
  assert.equal((await fetch(`${base}/api/me/inbox`, { headers })).status, 200);
  assert.equal((await fetch(`${base}/api/me/inbox`, { headers: { cookie: `stated_sid=${digest}` } })).status, 401);
  assert.equal((await fetch(`${base}/signout`, { method: 'POST', headers, body: 'csrf=bad', redirect: 'manual' })).status, 403);
  assert.ok(stored);
  const signedOut = await fetch(`${base}/signout`, { method: 'POST', headers, body: 'csrf=csrf-from-session', redirect: 'manual' });
  assert.equal(signedOut.status, 303);
  assert.equal(stored, null);
  assert.match(signedOut.headers.get('set-cookie'), /stated_sid=;.*Max-Age=0/);
  assert.equal((await fetch(`${base}/api/me/inbox`, { headers })).status, 401);
});

test('collections use keyset pagination and cap both public and owner pages in SQL', async () => {
  for (const [privateOwner, limit] of [[false, PUBLIC_PAGE_SIZE], [true, OWNER_PAGE_SIZE]]) {
    const page = await collectionPage({ async many(sql, values) {
      assert.match(sql, /s\.owner_user_id = \$1/);
      assert.match(sql, /s\.id < \$2::bigint/);
      assert.match(sql, /order by s\.id desc limit \$3/);
      assert.equal(values[2], limit + 1);
      if (!privateOwner) assert.match(sql, /u\.profile_visibility = 'public'/);
      return Array.from({ length: limit + 1 }, (_, index) => save(1000 - index));
    } }, owner, url('/api/u/alice/export.json'), { owner: privateOwner });
    assert.equal(page.rows.length, limit);
    assert.match(page.next, new RegExp(`before=${1001 - limit}`));
  }
  let queried = false;
  assert.equal(await collectionPage({ async many() { queried = true; } }, { ...owner, profile_visibility: 'private' }, url('/u/alice')), null);
  assert.equal(queried, false);
  for (const invalid of ['-1', '0', '1e5', '9999999999999999999', '1%20or%201=1']) {
    await assert.rejects(collectionPage({}, owner, url(`/u/alice?before=${invalid}`)), /reference is invalid/);
  }
});

test('one batch query fetches bounded histories, separates save-private revisions and continues without loss', async () => {
  const saves = [save(3), { ...save(2), statement_id: '3' }];
  const revisions = [
    { id: '1', statement_id: '3', save_id: null },
    { id: '2', statement_id: '3', save_id: '3' },
    { id: '3', statement_id: '3', save_id: '2' },
    ...Array.from({ length: PUBLIC_HISTORY_SIZE }, (_, i) => ({ id: String(i + 4), statement_id: '3', save_id: null })),
  ];
  let calls = 0;
  const db = { async many(sql, values) {
    calls += 1;
    if (!sql.includes('from revisions')) return saves;
    assert.match(sql, /save_id is null or r\.save_id = any\(\$2::bigint\[\]\)/);
    assert.equal(values[3], PUBLIC_HISTORY_SIZE + 1);
    return revisions.filter(r => values[2] == null || BigInt(r.id) > BigInt(values[2])).slice(0, values[3]);
  } };
  const first = await exportPage(db, owner, url('/api/u/alice/export.json'));
  assert.equal(calls, 2, 'one save query and one history query, independent of save count');
  assert.equal(first.pagination.historyContinues, true);
  assert.equal(first.saves[0].history.some(r => r.id === '3'), false);
  assert.equal(first.saves[1].history.some(r => r.id === '2'), false);
  assert.match(first.pagination.next, /historyAfter=500/);
  const second = await exportPage(db, owner, url(first.pagination.next));
  assert.equal(second.pagination.next, null);
  const ids = new Set([...first.saves[0].history, ...second.saves[0].history].map(r => r.id));
  assert.equal(ids.size, revisions.length - 1);
});

test('token buckets refill, isolate clients, canonicalize IPs, ignore untrusted headers and bound memory', () => {
  let time = 0;
  const request = ip => ({ headers: { 'x-real-ip': ip }, socket: { remoteAddress: '127.0.0.1' } });
  const limit = createReadLimiter({ railway: true, capacity: 2, refillMs: 1000, maxClients: 2, now: () => time });
  assert.equal(limit(request('192.0.2.1')).allowed, true);
  assert.equal(limit(request('192.0.2.1')).allowed, true);
  assert.deepEqual(limit(request('192.0.2.1')), { allowed: false, retryAfter: 1 });
  assert.equal(limit(request('192.0.2.2')).allowed, true);
  assert.equal(limit(request('192.0.2.3')).allowed, false);
  time = 1000;
  assert.equal(limit(request('192.0.2.1')).allowed, true);
  time = 3000;
  assert.equal(limit(request('192.0.2.3')).allowed, true);
  assert.equal(clientAddress(request('192.0.2.1')), '127.0.0.1');
  assert.equal(clientAddress(request('fake, 192.0.2.1'), { railway: true }), '127.0.0.1');
  assert.equal(clientAddress(request('::ffff:192.0.2.1'), { railway: true }), '192.0.2.1');
  assert.equal(clientAddress(request('2001:0db8::1'), { railway: true }), clientAddress(request('2001:db8::1'), { railway: true }));
});

test('history continuation pins its save range across concurrent removal and insertion', async () => {
  let saves = Array.from({ length: 51 }, (_, i) => save(51 - i));
  const revisions = [
    { id: '1', statement_id: '1', save_id: null },
    ...Array.from({ length: PUBLIC_HISTORY_SIZE + 1 }, (_, i) => ({ id: String(i + 100), statement_id: '51', save_id: null })),
  ];
  const db = { async many(sql, values) {
    if (sql.includes('from revisions')) return revisions.filter(r => values[0].includes(r.statement_id)
      && (values[2] == null || BigInt(r.id) > BigInt(values[2]))).slice(0, values[3]);
    return saves.filter(s => (values[1] == null || BigInt(s.save_id) < BigInt(values[1]))
      && (values[3] == null || BigInt(s.save_id) >= BigInt(values[3]))
      && (values[4] == null || BigInt(s.save_id) <= BigInt(values[4]))).slice(0, values[2]);
  } };
  const first = await exportPage(db, owner, url('/api/u/alice/export.json'));
  assert.equal(first.pagination.historyContinues, true);
  saves = [save(52), ...saves.filter(s => s.save_id !== '51')];
  const continuation = await exportPage(db, owner, url(first.pagination.next));
  assert.equal(continuation.saves.some(s => s.id === '1' || s.id === '52'), false);
  assert.ok(continuation.pagination.next);
  const last = await exportPage(db, owner, url(continuation.pagination.next));
  assert.equal(last.saves[0].id, '1');
  assert.equal(last.saves[0].history[0].id, '1');
  assert.equal(last.pagination.next, null);
});

function rulingDb(record) {
  let reads = 0;
  const material = record.material;
  const row = { event_id: '42', event_revision: '1', id: material.bets[0].id, claim: material.claim,
    resolve_at: material.deadline, evidence_source_url: material.postUrl, terms_hash: material.bets[0].termsHash,
    status: 'settled', outcome: 'yes', statement_id: '7' };
  const state = { row, record, public: true, visible: [], detailReads: () => reads,
    async one(sql) {
      if (sql.startsWith('select detail')) { reads += 1; return { detail: structuredClone(state.record) }; }
      assert.match(sql, /p\.withdrawn_at is null/);
      assert.match(sql, /e\.xmin::text/);
      assert.match(sql, /for share of b,p,e/);
      return state.public ? { ...row } : null;
    },
    async many(sql) { assert.match(sql, /e\.statement_id=\$1/); return state.visible.map(id => ({ id })); },
  };
  return state;
}

test('verified ruling cache skips crypto on hits but refreshes event revisions, binding, outcome and publication', async () => {
  const db = rulingDb(enclaveRulingFixture({ mode: 'review' }));
  let verifications = 0;
  const read = createPublicRulingReader({ recipe: 'verify', verify: async record => {
    verifications += 1;
    return verifyEnclaveRecordWithGpu(record);
  } });
  const first = await read(db, db.row.id);
  assert.ok(first);
  assert.equal(JSON.parse(first.body).record.agrees, true);
  assert.match(first.etag, /^"[a-f0-9]{64}"$/);
  assert.deepEqual(await read(db, db.row.id), first);
  assert.equal(verifications, 1);
  assert.equal(db.detailReads(), 1);
  db.row.outcome = 'no';
  const changed = await read(db, db.row.id);
  assert.equal(JSON.parse(changed.body).record.agrees, false);
  assert.notEqual(changed.etag, first.etag);
  for (const field of ['claim', 'resolve_at', 'evidence_source_url', 'terms_hash', 'id']) {
    const original = db.row[field];
    db.row[field] = field === 'resolve_at' ? '2030-01-01T00:00:00.000Z' : 'changed';
    assert.equal(await read(db, db.row.id), null, field);
    db.row[field] = original;
  }
  db.public = false;
  assert.equal(await read(db, db.row.id), null);
  db.public = true;
  db.record.materialHash = 'tampered';
  db.row.event_revision = '2';
  assert.equal(await read(db, db.row.id), null);
  assert.equal(verifications, 2);
});

test('cache hits cannot disclose evidence whose publication was withdrawn', async () => {
  // Auth policy tests reuse a verified fixture projection and vary only its evidence visibility.
  const record = enclaveRulingFixture();
  const db = rulingDb(record);
  const read = createPublicRulingReader({ verify: async value => ({ ...await verifyEnclaveRecordWithGpu(value),
    evidence: { kind: 'submitted', items: [{ id: '77' }] } }) });
  db.visible = ['77'];
  assert.ok(await read(db, db.row.id));
  db.visible = [];
  assert.equal(await read(db, db.row.id), null);
  assert.equal(db.detailReads(), 1);
});

test('cache bounds evict least recently used proofs and oversized records are never retained', async () => {
  const db = rulingDb(enclaveRulingFixture());
  let checks = 0;
  const read = createPublicRulingReader({ maxEntries: 2, verify: async record => { checks += 1; return record; } });
  for (const key of ['1', '2', '1', '3', '1']) { db.row.event_id = key; assert.ok(await read(db, db.row.id)); }
  assert.equal(checks, 3);
  db.row.event_id = '2';
  await read(db, db.row.id);
  assert.equal(checks, 4);
  const small = createPublicRulingReader({ maxBytes: 1, verify: async record => record });
  const before = db.detailReads();
  await small(db, db.row.id);
  await small(db, db.row.id);
  assert.equal(db.detailReads() - before, 2);
});

test('concurrent cache misses share verification and excess concurrent work is refused', async () => {
  const db = rulingDb(enclaveRulingFixture());
  let release;
  let checks = 0;
  const gate = new Promise(resolve => { release = resolve; });
  const read = createPublicRulingReader({ maxInFlight: 1, verify: async record => { checks += 1; await gate; return record; } });
  const first = read(db, db.row.id);
  const second = read(db, db.row.id);
  await Promise.resolve();
  db.row.event_id = '43';
  await assert.rejects(read(db, db.row.id), error => error.status === 503);
  release();
  const results = await Promise.all([first, second]);
  assert.equal(checks, 1);
  assert.deepEqual(results[0], results[1]);
});

test('real JSON route sends a strong ETag, bodyless 304, fresh 404 on withdrawal, and 429 before database work', async t => {
  const db = rulingDb(enclaveRulingFixture());
  let txs = 0;
  db.tx = fn => { txs += 1; return fn(db); };
  const routes = [];
  registerBetRoutes({ route: (method, pattern, fn) => routes.push({ method, pattern, fn }), db, config: { play: {} },
    send: (res, status, body, { headers = {} } = {}) => { res.writeHead(status, headers); res.end(body); },
    notFound: ctx => { ctx.res.writeHead(404); ctx.res.end(); },
  });
  const handler = routes.find(route => route.pattern.test(`/bets/${db.row.id}/enclave-ruling.json`));
  assert.ok(handler);
  const base = await serving(t, (req, res) => handler.fn({ req, res, params: [db.row.id] }).catch(error => { res.writeHead(500); res.end(error.message); }));
  const first = await fetch(base);
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');
  assert.match(etag, /^"[a-f0-9]{64}"$/);
  await first.text();
  for (const value of [etag, `"other", W/${etag}`, '*']) {
    const cached = await fetch(base, { headers: { 'if-none-match': value } });
    assert.equal(cached.status, 304);
    assert.equal(await cached.text(), '');
    assert.equal(cached.headers.get('etag'), etag);
  }
  const different = await fetch(base, { headers: { 'if-none-match': '"different"' } });
  assert.equal(different.status, 200);
  await different.text();
  assert.equal(db.detailReads(), 1);
  db.public = false;
  assert.equal((await fetch(base, { headers: { 'if-none-match': etag } })).status, 404);
  for (let i = 0; i < 4; i += 1) await fetch(base);
  const before = txs;
  const refused = await fetch(base);
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers.get('retry-after')) > 0);
  assert.equal(txs, before);
});

test('public export HTTP route is bounded and rate limited before owner/export queries', async t => {
  let queries = 0;
  const db = {
    async one(sql) { queries += 1; assert.match(sql, /from users where kind = 'person'/); return owner; },
    async many(sql, values) {
      queries += 1;
      if (sql.includes('from revisions')) return [];
      assert.equal(values[2], PUBLIC_PAGE_SIZE + 1);
      return Array.from({ length: PUBLIC_PAGE_SIZE + 1 }, (_, i) => save(1000 - i));
    },
  };
  const base = await serving(t, createApp({ db, config: loadConfig({ STATED_BASE_URL: 'http://localhost' }) }));
  const first = await fetch(`${base}/api/u/alice/export.json`);
  const body = await first.json();
  assert.equal(first.status, 200);
  assert.equal(body.saves.length, PUBLIC_PAGE_SIZE);
  assert.match(body.pagination.next, /before=/);
  for (let i = 1; i < 10; i += 1) assert.equal((await fetch(`${base}/api/u/alice/export.json`)).status, 200);
  const before = queries;
  const refused = await fetch(`${base}/api/u/alice/export.json`);
  assert.equal(refused.status, 429);
  assert.equal(queries, before);
  assert.equal((await fetch(`${base}/api/desk/export.json`)).status, 429);
  assert.equal((await fetch(`${base}/bets/00000000-0000-4000-8000-000000000001/enclave-ruling.json`)).status, 429);
  assert.equal(queries, before, 'exports and ruling JSON share one budget');
});

test('public profile HTML and API show bounded pages with a next-page link', async t => {
  const db = {
    async one(sql) {
      if (sql.includes('from users where kind')) return owner;
      if (sql.includes('bot_credentials')) return null;
      assert.fail(sql);
    },
    async many(sql, values) {
      if (sql.includes('unnest')) return [];
      if (sql.includes('lower(creator.x_username)')) {
        assert.match(sql, /p\.withdrawn_at is null/);
        assert.deepEqual(values, ['alice']);
        return [];
      }
      // The record reads the whole public history (bounded) and the withdrawals, apart from the page.
      if (sql.includes('from public_withdrawals')) return [];
      if (values[1] === RECORD_CAP) return Array.from({ length: PUBLIC_PAGE_SIZE + 1 }, (_, i) => save(1000 - i));
      assert.match(sql, /s\.owner_user_id = \$1/);
      assert.equal(values[2], PUBLIC_PAGE_SIZE + 1);
      return Array.from({ length: PUBLIC_PAGE_SIZE + 1 }, (_, i) => save(1000 - i));
    },
    async tx(fn) { return fn(db); },
  };
  const base = await serving(t, createApp({ db, config: loadConfig({ STATED_BASE_URL: 'http://localhost' }) }));
  const response = await fetch(`${base}/u/alice`);
  const text = await response.text();
  assert.equal(response.status, 200);
  assert.match(text, /Claim 951/);
  assert.doesNotMatch(text, /Claim 950/);
  assert.match(text, /rel="next" href="\/u\/alice\?before=951"/);
  const api = await fetch(`${base}/api/u/alice`);
  const body = await api.json();
  assert.equal(body.predictions.length, PUBLIC_PAGE_SIZE);
  assert.match(body.pagination.next, /before=951/);
});
