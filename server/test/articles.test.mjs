// Link intake plumbing: private website submission, editorial desk records
// (including labelled backfill), and network guards. The HTML served here is
// a labelled test fixture, not a real source; extraction quality is measured
// in eval/ and server/test/extract.test.mjs.

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { candidatesFrom, checkUrl, extractArticle, isBlockedAddress, safeFetch } from '../src/articles.mjs';
import { sourceForBet } from '../src/bets.mjs';
import { ADMIN_X_ID, Browser, startStack } from './support/app.mjs';

const NEXT = new Date().getUTCFullYear() + 1;
const FIXTURE = `<!doctype html><html><head>
  <title>TEST FIXTURE: Markets outlook</title>
  <meta name="author" content="Jane Writer">
  <meta property="article:published_time" content="${new Date().toISOString()}">
</head><body>
  <p>TEST FIXTURE ONLY. This page is served by the test suite and is not a real source.</p>
  <p>The index will top 6,000 by the end of ${NEXT}, in this writer’s view.</p>
  <p>“Rates will rise again by March ${NEXT},” said Pat Analyst, who has called the last three moves.</p>
  <p>Markets were quiet on Tuesday and volumes were light across most sectors.</p>
</body></html>`;

let s;
let site;
let base;
let aliceB;
let adminB;
let anon;

before(async () => {
  s = await startStack();
  s.fakeX.addUser('100', 'alice');
  s.fakeX.addUser(ADMIN_X_ID, 'reviewer');
  site = http.createServer((req, res) => {
    if (req.url === '/story') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(FIXTURE);
    }
    if (req.url === '/to-metadata') {
      res.writeHead(302, { location: 'http://169.254.169.254/latest/meta-data/' });
      return res.end();
    }
    if (req.url === '/image') {
      res.writeHead(200, { 'content-type': 'image/png' });
      return res.end('png');
    }
    res.writeHead(404, { 'content-type': 'text/html' });
    return res.end('<p>gone</p>');
  });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${site.address().port}`;
  aliceB = await s.signIn({ id: '100' });
  await aliceB.submit('/setup', { profile: 'private', defaults: 'private' });
  adminB = await s.signIn({ id: ADMIN_X_ID });
  await adminB.submit('/setup', { profile: 'private', defaults: 'private' });
  anon = new Browser(s.base);
});

after(async () => {
  await new Promise((resolve) => site.close(resolve));
  await s.close();
});

test('a private link submission lists candidates and follows the picked ones, credited to their speakers', async () => {
  const expected = candidatesFrom(extractArticle(FIXTURE, `${base}/story`));
  assert.ok(expected.length >= 1, 'the fixture has at least one candidate');
  const picker = await aliceB.submit('/me/track', { url: `${base}/story` }, { from: '/me/track' });
  assert.match(picker.url, /\/me\/track\/\d+$/);
  for (const c of expected) assert.ok(picker.text.includes(c.text.slice(0, 40).replace(/&/g, '&amp;')), `candidate missing: ${c.text}`);
  assert.doesNotMatch(picker.text, /Markets were quiet on Tuesday/, 'a non-prediction is not offered');
  const id = picker.url.match(/(\d+)$/)[1];
  const picks = expected.map((c) => ['pick', String(c.index)]);
  const done = await aliceB.submit(`/me/track/${id}`, picks);
  assert.match(done.text, new RegExp(`Following ${expected.length}`));
  const rows = await s.db.many(`select s.relation, s.visibility, s.intake, st.span, st.speaker, st.reported_speech from saves s
    join statements st on st.id = s.statement_id where s.owner_x_user_id = '100' order by st.id`);
  assert.equal(rows.length, expected.length);
  for (const c of expected) {
    const row = rows.find((r) => r.span === c.text);
    assert.ok(row, `saved: ${c.text}`);
    assert.equal(row.relation, 'following');
    assert.equal(row.visibility, 'private');
    assert.equal(row.intake, 'url');
    assert.equal(row.speaker, c.speaker, 'attribution comes from the extracted speaker, never the saver');
    assert.equal(row.reported_speech, c.reportedSpeech);
  }
  assert.ok(rows.every((r) => r.speaker !== 'alice' && r.speaker !== '@alice'));
});

test('a link that fails says why, in the inbox and on the page', async () => {
  const page = await aliceB.submit('/me/track', { url: `${base}/missing` }, { from: '/me/track' });
  assert.match(page.text, /returned status 404/);
  const image = await aliceB.submit('/me/track', { url: `${base}/image` }, { from: '/me/track' });
  assert.match(image.text, /not a web page/);
  const inbox = await aliceB.get('/me/inbox');
  assert.match(inbox.text, /Unable to read/);
});

test('private-network links are refused before and after redirects', async () => {
  for (const url of [
    'http://127.0.0.1/', 'http://10.0.0.5/', 'http://169.254.169.254/latest/', 'http://[::1]/',
    'http://localhost:8080/', 'http://192.168.1.1/', 'ftp://example.com/', 'http://user:pass@example.com/',
  ]) {
    assert.throws(() => checkUrl(url), /private network|https:\/\/|username|standard web ports/, url);
  }
  for (const addr of ['::ffff:127.0.0.1', 'fd00::1', 'fe80::1', '100.64.0.1', '0.0.0.0']) {
    assert.equal(isBlockedAddress(addr), true, addr);
  }
  assert.equal(isBlockedAddress('93.184.216.34'), false);
  await assert.rejects(safeFetch(`${base}/to-metadata`, { allowLoopback: true }), /private network/);
});

test('the desk tracks a public article, labels a historical collection as backfill, and never reads private saves', async () => {
  const picker = await adminB.submit('/admin/editorial', { url: `${base}/story`, backfill: '1' }, { from: '/admin' });
  assert.match(picker.url, /\/admin\/editorial\/\d+$/);
  const id = picker.url.match(/(\d+)$/)[1];
  const candidates = candidatesFrom(extractArticle(FIXTURE, `${base}/story`));
  await adminB.submit(`/admin/editorial/${id}`, candidates.map((c) => ['pick', String(c.index)]));
  const desk = await anon.get('/desk');
  assert.equal(desk.status, 200);
  assert.match(desk.text, /Backfill/);
  const exported = JSON.parse((await anon.get('/api/desk/export.json')).text);
  assert.equal(exported.saves.length, candidates.length);
  assert.ok(exported.saves.every((x) => x.capture === 'backfill' && x.scored === false));
  const saveId = exported.saves[0].id;
  const page = await anon.get(`/desk/${saveId}`);
  assert.equal(page.status, 200);
  const card = await fetch(`${s.base}/share/predictions/${saveId}.png`);
  assert.equal(card.status, 200, 'editorial Predictions have the same public card capability');
  const png = Buffer.from(await card.arrayBuffer());
  assert.equal(png.readUInt32BE(16), 1200);
  const alice = await s.db.one("select * from users where x_user_id='100'");
  assert.equal(String((await sourceForBet(s.db, alice, saveId)).save_id), String(saveId), 'an open Desk Prediction can seed a Bet');
  assert.doesNotMatch(page.text, /public profiles? follows?/, 'Alice follows the same sentence privately and is not counted');
  assert.doesNotMatch(page.text, /alice/i);
  assert.equal((page.text.match(/<strong>Captured<\/strong>/g) || []).length, 1, 'only the desk’s own capture is in the public history');
  assert.match(page.text, /collected as history/i);
  const search = JSON.parse((await anon.get('/api/search?q=index')).text);
  assert.ok(search.results.every((r) => r.owner === 'desk'));
});

test('a reviewer corrects an extracted attribution before publishing, and the history keeps the original', async () => {
  const picker = await adminB.submit('/admin/editorial', { url: `${base}/story` }, { from: '/admin' });
  const id = picker.url.match(/(\d+)$/)[1];
  assert.match(picker.text, /name="speaker-0"/, 'the desk picker offers a speaker field');
  const candidates = candidatesFrom(extractArticle(FIXTURE, `${base}/story`));
  const first = candidates[0];
  await adminB.submit(`/admin/editorial/${id}`, [
    ['pick', String(first.index)], [`speaker-${first.index}`, 'TEST FIXTURE Speaker'], [`quoted-${first.index}`, '1'],
  ]);
  const statement = await s.db.one('select id, speaker, reported_speech from statements where span = $1', [first.text]);
  assert.equal(statement.speaker, 'TEST FIXTURE Speaker');
  assert.equal(statement.reported_speech, true);
  const history = await s.db.many(`select kind, before, after from revisions where statement_id = $1 and kind = 'attribution'`, [statement.id]);
  assert.equal(history.length, 1);
  assert.equal(history[0].before.speaker, first.speaker);
  const save = await s.db.one(`select s.id from saves s join users u on u.id = s.owner_user_id where u.kind = 'editorial' and s.statement_id = $1`, [statement.id]);
  const page = await anon.get(`/desk/${save.id}`);
  assert.match(page.text, /Attribution corrected in review/);
  assert.match(page.text, /Quoted TEST FIXTURE Speaker/);

  await adminB.submit(`/admin/terms/${statement.id}`, { speaker: 'TEST FIXTURE Second Speaker', deadline: '', probability: '', condition: '', note: 'Byline checked' }, { from: '/admin' });
  const after = await s.db.one('select speaker, terms_confirmed_by from statements where id = $1', [statement.id]);
  assert.equal(after.speaker, 'TEST FIXTURE Second Speaker');
  assert.equal(after.terms_confirmed_by, null, 'correcting only the speaker leaves the terms alone');
});

test('the migration is repeatable on an existing database', async () => {
  await s.db.migrate();
  await s.db.migrate();
  const kinds = await s.db.one(`select pg_get_constraintdef(oid) as def from pg_constraint where conname = 'revisions_kind_check'`);
  assert.match(kinds.def, /attribution/);
});

test('non-admins cannot reach review or the desk tools', async () => {
  assert.equal((await aliceB.request('GET', '/admin')).status, 404);
  const attempt = await aliceB.submit('/admin/resolve/1', { outcome: 'yes', url: 'https://example.com', note: 'x' });
  assert.equal(attempt.status, 404);
  assert.equal((await anon.request('GET', '/admin/metrics.json')).status, 404);
});
