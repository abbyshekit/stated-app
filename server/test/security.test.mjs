// Findings from the security review, each pinned by a test: login CSRF,
// open redirect, untrusted canonical links, slow-drip fetches, intake rate
// limits, escaping of hostile post text, and response headers.

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { INTAKES_PER_HOUR, safeFetch } from '../src/articles.mjs';
import { tick } from '../src/worker.mjs';
import { Browser, startStack } from './support/app.mjs';

let s;
let site;
let base;
let mallory;
let alice;

before(async () => {
  s = await startStack();
  const bot = s.fakeX.addUser('500', 'statedbot');
  alice = s.fakeX.addUser('100', 'alice');
  mallory = s.fakeX.addUser('666', 'mallory');
  await s.connectBot(bot);
  site = http.createServer((req, res) => {
    if (req.url === '/canonical') {
      res.writeHead(200, { 'content-type': 'text/html' });
      return res.end('<html><head><title>TEST FIXTURE</title><link rel="canonical" href="javascript:alert(1)"></head><body><p>TEST FIXTURE. Prices will rise 5% by the end of 2030, the writer says.</p></body></html>');
    }
    if (req.url === '/drip') {
      res.writeHead(200, { 'content-type': 'text/html' });
      const timer = setInterval(() => res.write('<p>.</p>'), 300);
      req.on('close', () => clearInterval(timer));
      return undefined;
    }
    res.writeHead(404);
    return res.end();
  });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  base = `http://127.0.0.1:${site.address().port}`;
});

after(async () => {
  site.closeAllConnections();
  await new Promise((resolve) => site.close(resolve));
  await s.close();
});

test('a callback link from someone else’s sign-in does not sign this browser in', async () => {
  const attacker = new Browser(s.base);
  s.fakeX.consentAs = mallory.id;
  const start = await attacker.request('GET', '/signin/x');
  const consent = await attacker.request('GET', start.location);
  s.fakeX.consentAs = null;
  assert.match(consent.location, /\/callback\?code=/);
  const victim = new Browser(s.base);
  const landed = await victim.request('GET', consent.location);
  assert.equal(landed.status, 400);
  assert.match(landed.text, /started in a different browser/);
  assert.equal(victim.jar.has('stated_sid'), false);
});

test('the sign-in return address must stay on this site', async () => {
  const b = new Browser(s.base);
  for (const bad of ['//evil.example', '/\\evil.example', 'https://evil.example', '/ space']) {
    await b.request('GET', `/signin/x?return=${encodeURIComponent(bad)}`);
    const row = await s.db.one('select return_to from oauth_states order by created_at desc limit 1');
    assert.equal(row.return_to, null, bad);
  }
  await b.request('GET', `/signin/x?return=${encodeURIComponent('/me/track')}`);
  assert.equal((await s.db.one('select return_to from oauth_states order by created_at desc limit 1')).return_to, '/me/track');
});

test('a page cannot make its canonical link a script', async () => {
  const b = await s.signIn(alice);
  await b.submit('/setup', { profile: 'private', defaults: 'private' });
  await b.submit('/me/track', { url: `${base}/canonical` }, { from: '/me/track' });
  const source = await s.db.one(`select url from sources where platform = 'web' order by id desc limit 1`);
  assert.equal(source.url, `${base}/canonical`);
});

test('a server that drips bytes is cut off by the overall deadline', async () => {
  const started = Date.now();
  await assert.rejects(safeFetch(`${base}/drip`, { allowLoopback: true, timeoutMs: 600 }), /took too long/);
  assert.ok(Date.now() - started < 3000);
});

test('link intake is rate limited per person', async () => {
  const b = await s.signIn(alice);
  for (let i = 0; i < INTAKES_PER_HOUR; i += 1) {
    await s.db.query(`insert into url_intakes (owner_x_user_id, url, route, status) values ($1, 'https://example.com', 'web', 'failed')`, [alice.id]);
  }
  const page = await b.submit('/me/track', { url: `${base}/canonical` }, { from: '/me/track' });
  assert.equal(page.status, 422);
  assert.match(page.text, /tracked 20 links in the last hour/);
});

test('hostile post text is escaped on public pages and in previews', async () => {
  const hostile = 's.fakeX will "close" <script>alert(1)</script> by the end of 2030 <img src=x onerror=alert(2)>';
  const p = s.fakeX.post(alice.id, hostile);
  s.fakeX.post(alice.id, '@statedbot', { replyTo: p.id });
  await tick(s.db, s.config, s.x);
  const b = await s.signIn(alice);
  const save = await s.db.one(`select s.id from saves s join statements st on st.id = s.statement_id
    join sources src on src.id = st.source_id where src.platform_id = $1`, [p.id]);
  const own = await b.get(`/me/s/${save.id}?words=1`);
  assert.match(own.text, /Shown from X/, 'the private page shows the post through oEmbed on request');
  assert.doesNotMatch(own.text, /<script>alert|<img src=x/, 'oEmbed text is escaped like stored text');
  assert.match(own.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  await b.submit('/me/settings/publish', [['confirm', '1'], ['publish', String(save.id)], ['defaults', 'private']]);
  await tick(s.db, s.config, s.x);
  const page = await new Browser(s.base).get(`/u/alice/${save.id}`);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /<script>alert|<img src=x/);
  assert.match(page.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.match(page.text, /<meta property="og:title" content="@alice: s\.fakeX will &quot;close&quot; &lt;script&gt;/);
});

test('pages carry a strict content security policy; private pages are not cached or indexed', async () => {
  const b = await s.signIn(alice);
  const res = await fetch(`${s.base}/me`, { headers: { cookie: b.cookieHeader() } });
  assert.match(res.headers.get('content-security-policy'), /default-src 'self'; style-src 'self'/);
  assert.doesNotMatch(res.headers.get('content-security-policy'), /unsafe-inline|script-src/);
  assert.match(res.headers.get('content-security-policy'), /frame-ancestors 'none'/);
  assert.equal(res.headers.get('cache-control'), 'no-store');
  assert.match(res.headers.get('x-robots-tag'), /noindex/);
  const cookie = (await fetch(`${s.base}/signin/x`, { redirect: 'manual' })).headers.getSetCookie().join(';');
  assert.match(cookie, /stated_oauth=[^;]+; Path=\/; HttpOnly; SameSite=Lax/);
});
