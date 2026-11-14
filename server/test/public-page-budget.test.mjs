import assert from 'node:assert/strict';
import test from 'node:test';
import { registerShareRoutes } from '../src/share-pages.mjs';
import { createApp } from '../src/web.mjs';
import { loadConfig } from '../src/config.mjs';
import { revisionsFor } from '../src/store.mjs';
import { publicBetForShare } from '../src/bet-public.mjs';
import { publicRecord } from '../src/bounded-exports.mjs';

function shareFixture() {
  const routes = [];
  let reads = 0;
  let publicNow = true;
  const row = { save_id: '1', owner_user_id: '3', speaker: 'Author', span: 'A public claim',
    status: 'yes', available: true, platform: 'x', author_username: 'author' };
  const db = { tx: fn => fn(db), async many() { return []; }, async one(sql) {
    reads += 1;
    if (sql.startsWith('select u.*')) return publicNow ? { id: '3', kind: 'editorial', profile_visibility: 'public', setup_completed_at: true } : null;
    return publicNow ? row : null;
  } };
  let rendered = 0;
  registerShareRoutes({ db, route: (_, pattern, handle) => routes.push({ pattern, handle }),
    config: { baseUrl: 'https://example.test' }, headersFor: () => ({}),
    notFound: ({ res }) => { res.writeHead(404, { 'cache-control': 'no-store' }); res.end(); },
    render: svg => { rendered += 1; return Buffer.from(svg); },
    now: () => 1_800_000_000_000,
  });
  return { async get(path, address = '192.0.2.1') {
    const route = routes.find(route => route.pattern.test(path));
    assert.ok(route);
    const response = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end(body) { this.body = body; } };
    await route.handle({ params: path.match(route.pattern).slice(1), url: new URL(path, 'https://example.test'),
      req: { headers: {}, socket: { remoteAddress: address } }, res: response });
    return response;
  }, reads: () => reads, rendered: () => rendered, row, withdraw: () => { publicNow = false; } };
}

test('share cache rechecks publication and resists client floods before record queries', async () => {
  const fixture = shareFixture();
  const path = '/share/predictions/1.png';
  const first = await fixture.get(path);
  assert.equal(first.status, 200);
  assert.equal(first.headers['cache-control'], 'no-store');
  assert.equal((await fixture.get(path)).status, 200);
  assert.equal(fixture.reads(), 4);
  fixture.withdraw();
  assert.equal((await fixture.get(path)).status, 404);
  for (let i = 0; i < 100; i += 1) {
    const before = fixture.reads();
    const res = await fixture.get(`/share/predictions/${i + 2}.png`);
    if (res.status !== 429) continue;
    assert.equal(fixture.reads(), before);
    assert.equal(fixture.rendered(), 1);
    assert.ok(Number(res.headers['retry-after']) > 0);
    assert.equal(res.headers['cache-control'], 'no-store');
    return;
  }
  assert.fail('Share requests never reached an address-wide budget.');
});

test('public page routes share an address budget before session and record queries', async () => {
  let queries = 0;
  const db = { async one() { queries += 1; return null; }, async many() { queries += 1; return []; }, tx: fn => fn(db) };
  const handle = createApp({ db, config: loadConfig({ STATED_BASE_URL: 'http://localhost' }) });
  for (let i = 0; i < 60; i += 1) {
    const res = { writeHead(status) { this.status = status; }, end() {} };
    await handle({ method: 'GET', url: `/u/unknown_${i}`, headers: {}, socket: { remoteAddress: '192.0.2.1' } }, res);
    assert.equal(res.status, 404);
  }
  const before = queries;
  for (const path of ['/', '/court', '/search?q=claim', '/desk', '/api/search?q=claim', '/api/u/alice', '/bets/00000000-0000-4000-8000-000000000001']) {
    const res = { writeHead(status, headers) { this.status = status; this.headers = headers; }, end() {} };
    await handle({ method: 'GET', url: path, headers: { cookie: 'stated_sid=' + 'a'.repeat(43) }, socket: { remoteAddress: '192.0.2.1' } }, res);
    assert.equal(res.status, 429, path);
    assert.ok(Number(res.headers['retry-after']) > 0);
    assert.equal(res.headers['cache-control'], 'no-store');
    assert.equal(queries, before);
  }
});

test('public history reads retain privacy redaction while bounding SQL rows and continuing by ID', async () => {
  let calls = 0;
  const db = { async many(sql, values) {
    calls += 1;
    assert.match(sql, /p\.withdrawn_at is null/);
    assert.match(sql, /before - 'url' - 'note'/);
    assert.match(sql, /r\.id > \$3::bigint/);
    assert.match(sql, /order by r\.id limit \$4/);
    assert.deepEqual(values, ['7', ['3'], '30', 51]);
    return [];
  } };
  await revisionsFor(db, '7', ['3'], { after: '30', limit: 51 });
  await assert.rejects(revisionsFor(db, '7', ['3'], { after: '-1', limit: 51 }), error => error.status === 400);
  assert.equal(calls, 1);
});

test('share Bet lookups avoid signed material and retain current publication authorization', async () => {
  let queries = 0;
  const db = { tx: fn => fn(db), async one(sql) {
    queries += 1;
    assert.match(sql, /b\.source_save_id/);
    assert.match(sql, /p\.withdrawn_at is null for share of b,p/);
    assert.match(sql, /octet_length\(b\.chain_state::text\)<=16384/);
    assert.doesNotMatch(sql, /select (?:detail|e\.detail|b\.\*)/);
    return null;
  } };
  assert.equal(await publicBetForShare(db, '00000000-0000-4000-8000-000000000001'), null);
  assert.equal(queries, 1);
});

test('withdrawal totals leave PostgreSQL as one aggregate row and keep the complete record', async () => {
  const db = { async many(sql) { assert.doesNotMatch(sql, /from public_withdrawals/); return []; }, async one(sql, values) {
    assert.match(sql, /count\(\*\)::text as total/);
    assert.match(sql, /from public_withdrawals where owner_user_id=\$1/);
    assert.deepEqual(values, ['3']);
    return { total: '6000', yes: '3000', no: '3000', after_outcome: '5000', after_deadline: '1000', scored: '6000', score_total: 600000 };
  } };
  const record = await publicRecord(db, { id: '3' });
  assert.equal(record.predictions, 6000);
  assert.equal(record.resolved, 6000);
  assert.equal(record.cameTrue, 3000);
  assert.equal(record.didNot, 3000);
  assert.equal(record.withdrawnAfterOutcome, 5000);
  assert.equal(record.withdrawnAfterDeadline, 1000);
  assert.equal(record.averageBaseline, 100);
});

test('global share render budget limits cold images across addresses and keeps cache hits usable', async () => {
  const fixture = shareFixture();
  const first = await fixture.get('/share/predictions/1.png');
  assert.equal(first.status, 200);
  for (let i = 0; i < 100; i += 1) {
    fixture.row.span = `Distinct claim ${i}`;
    const before = fixture.rendered();
    const res = await fixture.get(`/share/predictions/${i + 2}.png`, `192.0.2.${i + 2}`);
    if (res.status !== 429) continue;
    assert.equal(fixture.rendered(), before);
    fixture.row.span = 'A public claim';
    const hit = await fixture.get('/share/predictions/1.png', '192.0.2.200');
    assert.equal(hit.status, 200);
    assert.deepEqual(hit.body, first.body);
    return;
  }
  assert.fail('Distinct share images never reached a global render budget.');
});
