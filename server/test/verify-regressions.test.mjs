// Regression tests for the verification of the review fixes
// (.review/verify-findings.md). Each V-numbered test is the verifier's
// reproduction from .review/repro/verify.test.mjs, or from
// seed-guard-check.mjs, with its assertions turned around to the fixed
// behaviour; the others cover the new findings N1 to N14. Real server,
// throwaway Postgres, fake X API, loopback HTTP. No network.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import https from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';
import { fileURLToPath } from 'node:url';
import { startBotAuth } from '../src/botauth.mjs';
import { createDb } from '../src/db.mjs';
import { isXUrl, processMention, statusIdOf } from '../src/intake.mjs';
import { checkSources } from '../src/notify.mjs';
import { tick } from '../src/worker.mjs';
import { applyTextPolicy, clearOembedCache } from '../src/xtext.mjs';
import { ADMIN_X_ID, Browser, startStack } from './support/app.mjs';

const NEXT = new Date().getUTCFullYear() + 1;
const DAY = 86_400_000;
let s;
let site;
let base;
let bob;
let carol;
let adminB;
let anon;
let allText;

const one = (sql, p = []) => s.db.one(sql, p);
const saveFor = async (eventId) => one('select * from saves where origin_event_id = $1', [eventId]);
const oembedCalls = () => s.fakeX.calls.filter((c) => c.path === '/oembed');
const tweetReads = () => s.fakeX.calls.filter((c) => c.method === 'GET' && c.path === '/2/tweets');
const dateOnly = (ms) => new Date(ms).toISOString().slice(0, 10);

async function storedCount(marker) {
  const like = `%${marker}%`;
  const r = await one(
    `select (select count(*) from sources where text like $1 or coalesce(title, '') like $1)
          + (select count(*) from statements where span like $1 or coalesce(deadline_text, '') like $1 or coalesce(condition_text, '') like $1)
          + (select count(*) from mention_events where coalesce(payload::text, '') like $1)
          + (select count(*) from inbox where body like $1)
          + (select count(*) from revisions where coalesce(before::text, '') || coalesce(after::text, '') || coalesce(note, '') like $1) as n`,
    [like],
  );
  return Number(r.n);
}

async function person(id, name, { profile = 'private', defaults = 'private' } = {}) {
  const u = s.fakeX.addUser(id, name);
  const b = await s.signIn(u);
  if (profile === 'public') await b.submit('/me/settings/publish', [['confirm', '1'], ['defaults', defaults]], { from: '/setup' });
  else await b.submit('/setup', { profile: 'private', defaults: 'private' });
  return { u, b };
}

function adminBlock(page, href) {
  const at = page.indexOf(href);
  assert.ok(at > 0, `listed: ${href}`);
  return page.slice(page.lastIndexOf('<form', at), page.indexOf('</form>', at));
}

// A real browser loads the page, then its stylesheet with the cookie the page set.
async function visit(browser, path, headers = {}) {
  await browser.request('GET', path, { headers });
  await browser.request('GET', '/static/stated.css', { headers: { ...headers, referer: new URL(path, s.base).toString() } });
}

function stubHttps() {
  const seen = [];
  const real = https.request;
  https.request = (url) => {
    seen.push(String(url));
    const req = new EventEmitter();
    req.end = () => setImmediate(() => req.emit('error', new Error('stubbed: no network')));
    req.destroy = () => {};
    return req;
  };
  return { seen, restore: () => { https.request = real; } };
}

before(async () => {
  s = await startStack();
  const bot = s.fakeX.addUser('500', 'statedbot');
  bob = s.fakeX.addUser('200', 'bob');
  carol = s.fakeX.addUser('300', 'carol');
  s.fakeX.addUser(ADMIN_X_ID, 'reviewer');
  await s.connectBot(bot);
  allText = { ...s.config, x: { ...s.config.x, textPolicy: 'all' } };
  site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (req.url === '/real2') {
      return res.end(`<html><head><title>REAL TWO title</title><meta name="author" content="Jane Writer"></head>
        <body><p>REVIEW FIXTURE. The index will top 7,000 by the end of ${NEXT}, in this writer’s view.</p></body></html>`);
    }
    if (req.url === '/evil-same') {
      return res.end(`<html><head><meta property="og:title" content="FORGED-SAME title">
        <link rel="canonical" href="${base}/real2"></head><body><p>Nothing.</p></body></html>`);
    }
    if (req.url === '/real2-alias?utm=x') {
      return res.end(`<html><head><title>Alias</title><link rel="canonical" href="${base}/real2-alias"></head><body><p>ok</p></body></html>`);
    }
    return res.end('<p>ok</p>');
  });
  await new Promise((r) => site.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${site.address().port}`;
  adminB = await s.signIn({ id: ADMIN_X_ID });
  await adminB.submit('/setup', { profile: 'private', defaults: 'private' });
  anon = new Browser(s.base);
});

after(async () => {
  site.closeAllConnections();
  await new Promise((r) => site.close(r));
  await s.close();
});

test('V1 (N6): a page naming another URL on its host as canonical cannot set that record’s title', async () => {
  const { b: m } = await person('666', 'mallory');
  await m.submit('/me/track', { url: `${base}/evil-same` }, { from: '/me/track' });
  assert.equal((await one(`select url from sources where title = 'FORGED-SAME title'`)).url, `${base}/evil-same`, 'keyed on the page actually fetched');
  const picker = await adminB.submit('/admin/editorial', { url: `${base}/real2` }, { from: '/admin' });
  const intakeId = picker.url.match(/(\d+)$/)[1];
  const intake = await one('select candidates from url_intakes where id = $1', [intakeId]);
  assert.ok(intake.candidates.length > 0);
  await adminB.submit(`/admin/editorial/${intakeId}`, intake.candidates.map((c) => ['pick', String(c.index)]));
  const deskSave = (await one(`select s.id from saves s join users u on u.id = s.owner_user_id where u.kind = 'editorial' order by s.id desc limit 1`)).id;
  const page = await anon.get(`/desk/${deskSave}`);
  assert.match(page.text, /REAL TWO title/);
  assert.doesNotMatch(page.text, /FORGED-SAME title/);
  await m.submit('/me/track', { url: `${base}/real2-alias?utm=x` }, { from: '/me/track' });
  assert.ok(await one(`select 1 from sources where url = $1`, [`${base}/real2-alias`]), 'a canonical naming the same page, without its query, is still accepted');
});

test('V2 (N7): a trailing-dot X host is recognised and read through the X API, never fetched', async () => {
  assert.equal(isXUrl('https://x.com./bob/status/123'), true);
  assert.equal(statusIdOf('https://x.com./bob/status/123'), '123');
  assert.equal(isXUrl('https://www.twitter.com../bob'), true);
  const p = s.fakeX.post(bob.id, `Steel will top $1,000 by the end of ${NEXT}.`);
  const { seen, restore } = stubHttps();
  let page;
  try {
    const { b } = await person('101', 'tdot');
    page = await b.submit('/me/track', { url: `https://x.com./bob/status/${p.id}` }, { from: '/me/track' });
  } finally {
    restore();
  }
  assert.deepEqual(seen, [], 'no web fetch at all');
  assert.match(page.url, /\/me\/s\/\d+\?done=xsaved$/);
});

test('V3 (M5): a crashed claim that X never redelivers is retried after the lease, reading the mention again', async () => {
  const ann = s.fakeX.addUser('102', 'ann');
  const p = s.fakeX.post(bob.id, `Rents will fall 12% by the end of ${NEXT}.`);
  const tag = s.fakeX.post(ann.id, '@statedbot', { replyTo: p.id });
  await s.db.query(
    `insert into mention_events (event_id, author_x_user_id, outcome, attempts, processing_since, payload)
     values ($1, $2, 'processing', 1, now() - interval '11 minutes', $3)`,
    [tag.id, ann.id, JSON.stringify({ mention: { id: tag.id, author_id: ann.id }, includes: {} })],
  );
  await s.db.query(`insert into kv (key, value) values ('mentions_since_id', $1) on conflict (key) do update set value = excluded.value`, [tag.id]);
  const summary = await tick(s.db, s.config, s.x);
  assert.deepEqual(summary.mentions.processed, [], 'not redelivered by the poll');
  assert.equal(summary.retried.find((r) => r.id === tag.id)?.outcome, 'saved');
  assert.ok(await saveFor(tag.id));
});

test('V4 (L3, N8): rotating user agents add no visitors; two real browsers behind one address count twice', async () => {
  const fromReply = async () => JSON.parse((await adminB.get('/admin/metrics.json')).text).visits.fromReply;
  const before = await fromReply();
  for (let i = 0; i < 25; i += 1) {
    await new Browser(s.base).request('GET', '/?r=reply', { headers: { 'user-agent': `Mozilla/5.0 rotating-${i}` } });
  }
  assert.equal((await fromReply()) - before, 0, 'a new user agent is not a new visitor');
  const ua = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) Twitter for iPhone';
  await visit(new Browser(s.base), '/desk?r=reply', { 'user-agent': ua });
  await visit(new Browser(s.base), '/desk?r=reply', { 'user-agent': ua });
  assert.equal((await fromReply()) - before, 2, 'two separate browsers with the same agent are two visitors');
  assert.match((await anon.get('/privacy')).text, /random visitor cookie/, 'the privacy page names the cookie');
});

test('V5 (L8, N9): an out-of-range ID in a form body is a 4xx, never a 500', async () => {
  const { b } = await person('103', 'oor');
  const res = await b.submit('/corrections', { statement: '99999999999999999999', kind: 'interpretation', body: 'This is a long enough body.', back: '/me' }, { from: '/me' });
  assert.equal(res.status, 404);
  const p = s.fakeX.post(bob.id, `Zinc will hit $5k by the end of ${NEXT}.`);
  const tag = s.fakeX.post(carol.id, '@statedbot', { replyTo: p.id });
  await tick(s.db, s.config, s.x);
  const st = (await saveFor(tag.id)).statement_id;
  const resolve = await adminB.submit(`/admin/resolve/${st}`, { outcome: 'no', url: 'https://example.com/z', note: 'No.', correction: '99999999999999999999' }, { from: '/admin' });
  assert.equal(resolve.status, 400);
  const terms = await adminB.submit(`/admin/terms/${st}`, { deadline: `${NEXT}-06-30`, note: 'x', correction: '99999999999999999999' }, { from: '/admin' });
  assert.equal(terms.status, 400);
  assert.equal((await one('select status, deadline_at from statements where id = $1', [st])).status, 'open', 'nothing changed');
});

test('V6 (H3, N5): a failing mention keeps IDs only, even for a long post', async () => {
  const cara = s.fakeX.addUser('104', 'cara');
  const mention = {
    id: '1999999999999999001',
    author_id: cara.id,
    text: '@statedbot',
    note_tweet: { text: '@statedbot NOTE-CANARY a long post whose full words live in note_tweet' },
    display_text_range: [0, 10],
    entities: { mentions: [{ start: 0, end: 10, username: 'statedbot', id: '500' }] },
    referenced_tweets: [{ type: 'replied_to', id: '1999999999999999000' }],
    created_at: new Date().toISOString(),
  };
  const fetchPost = async () => { const e = new Error('X 503'); e.status = 503; throw e; };
  const ident = await s.x.identity();
  await processMention(s.db, s.config, { mention, includes: {}, bot: ident, fetchPost }).catch(() => {});
  assert.equal(await storedCount('NOTE-CANARY'), 0, 'not even after the first failure');
  for (let i = 0; i < 2; i += 1) await processMention(s.db, s.config, { mention, includes: {}, bot: ident, fetchPost }).catch(() => {});
  const row = await one('select outcome, attempts, payload from mention_events where event_id = $1', [mention.id]);
  assert.equal(row.outcome, 'error');
  assert.equal(row.attempts, 3);
  assert.deepEqual(Object.keys(row.payload.mention).sort(), ['author_id', 'created_at', 'id', 'referenced_tweets']);
  assert.equal(await storedCount('NOTE-CANARY'), 0);
});

test('V7 (H3, N3, N4): deletion leaves nothing; a private save is checked weekly; old words and payloads are removed', async () => {
  const { u: pam } = await person('105', 'pam', { profile: 'public', defaults: 'public' });
  const p = s.fakeX.post(bob.id, `Lumber will top $900 by the end of ${NEXT}. PUBLIC-CANARY`);
  s.fakeX.post(pam.id, '@statedbot', { replyTo: p.id });
  await tick(s.db, s.config, s.x);
  assert.ok(await storedCount('PUBLIC-CANARY') > 0, 'a public save stores the words');
  await s.db.query('update sources set checked_at = now()');
  await s.db.query('update sources set checked_at = null where platform_id = $1', [p.id]);
  s.fakeX.deleted.add(p.id);
  assert.equal((await checkSources(s.db, s.x)).gone.length, 1);
  assert.equal(await storedCount('PUBLIC-CANARY'), 0, 'deletion under the default policy removes every copy');

  const { u: quin, b: qb } = await person('106', 'quin');
  const q = s.fakeX.post(bob.id, `Cocoa will probably top $15k by the end of ${NEXT}.`);
  const tagQ = s.fakeX.post(quin.id, '@statedbot', { replyTo: q.id });
  await tick(s.db, s.config, s.x);
  s.fakeX.deleted.add(q.id);
  const reads = tweetReads().length;
  assert.equal((await checkSources(s.db, s.x)).gone.length, 0, 'a private save is not due for a week');
  assert.equal(tweetReads().length, reads, 'so it costs no read');
  await s.db.query(`update sources set first_observed_at = now() - interval '8 days', checked_at = null where platform_id = $1`, [q.id]);
  assert.equal((await checkSources(s.db, s.x)).gone.length, 1, 'the weekly check finds it gone');
  const src = await one(`select src.available, st.hedges, st.span from sources src join statements st on st.source_id = src.id where src.platform_id = $1`, [q.id]);
  assert.equal(src.available, false);
  assert.deepEqual(src.hedges, []);
  const own = await qb.get(`/me/s/${(await saveFor(tagQ.id)).id}`);
  assert.match(own.text, /no longer available on X/);
  assert.match((await qb.get('/me/inbox')).text, /no longer available on X/);

  const rae = s.fakeX.addUser('107', 'rae');
  const w = s.fakeX.post(bob.id, `Coffee will top $5 by the end of ${NEXT}. LEGACY-CANARY`);
  const tagW = s.fakeX.post(rae.id, '@statedbot', { replyTo: w.id });
  await tick(s.db, allText, s.x);
  await s.db.query(`insert into inbox (owner_x_user_id, kind, save_id, statement_id, body, dedupe_key)
    values ($1, 'saved', $2, $3, 'Saved to Following: @bob, “Coffee will top $5. LEGACY-CANARY”', 'legacy-quote')`,
  [rae.id, (await saveFor(tagW.id)).id, (await saveFor(tagW.id)).statement_id]);
  await s.db.query(`update mention_events set payload = $2 where event_id = $1`, [tagW.id, JSON.stringify({ mention: { ...tagW, text: 'LEGACY-CANARY' }, includes: { tweets: [w] } })]);
  assert.ok(await storedCount('LEGACY-CANARY') > 0, 'words stored under the all policy, and an old quoting inbox body and payload');
  await s.db.migrate();
  const applied = await applyTextPolicy(s.db, s.config);
  assert.ok(applied.dropped >= 1 && applied.inbox >= 1);
  assert.equal(await storedCount('LEGACY-CANARY'), 0, 'switching back to the default removes them');
});

test('V8 (N2): owner pages make no oEmbed request; one explicit request reads one post; the cache is shared', async () => {
  const sam = s.fakeX.addUser('108', 'sam');
  const posts = [];
  for (let i = 0; i < 5; i += 1) {
    const p = s.fakeX.post(bob.id, `Asset ${i} will rise 10% by the end of ${NEXT}.`);
    s.fakeX.post(sam.id, '@statedbot', { replyTo: p.id });
    posts.push(p.id);
  }
  await tick(s.db, s.config, s.x);
  const sb = await s.signIn(sam);
  clearOembedCache();
  const start = oembedCalls().length;
  await sb.get('/setup');
  await sb.submit('/setup', { profile: 'private', defaults: 'private' });
  const saveIds = (await s.db.many(`select id from saves where owner_x_user_id = $1 order by id`, [sam.id])).map((r) => r.id);
  for (const path of ['/me', '/me?tab=following', '/me/inbox', '/me/settings', '/me/settings/publish?defaults=private', '/api/me', '/me/export.json', ...saveIds.map((id) => `/me/s/${id}`)]) {
    assert.equal((await sb.request('GET', path)).status, 200, path);
  }
  assert.equal(oembedCalls().length, start, 'rendering owner pages sends X nothing');
  const shown = await sb.get(`/me/s/${saveIds[0]}?words=1`);
  assert.match(shown.text, /Asset 0 will rise 10%/);
  const burst = oembedCalls().slice(start);
  assert.equal(burst.length, 1, 'exactly the one post asked for');
  assert.match(burst[0].query.url, new RegExp(`status/${posts[0]}$`));
  assert.equal(burst[0].query.dnt, 'true');
  const { b: other } = await person('112', 'tom');
  const p0 = await s.db.one(`select id from statements where source_id = (select id from sources where platform_id = $1)`, [posts[0]]);
  s.fakeX.post('112', '@statedbot', { replyTo: posts[0] });
  await tick(s.db, s.config, s.x);
  const tomSave = await one(`select id from saves where owner_x_user_id = '112' and statement_id = $1`, [p0.id]);
  await other.get(`/me/s/${tomSave.id}?words=1`);
  assert.equal(oembedCalls().length, start + 1, 'another owner asking for the same post is served from the shared cache');
});

test('V9a (N1): with no stated deadline, repeated extensions leave the prediction held to the first deadline', async () => {
  const { u: tia, b: tb } = await person('109', 'tia', { profile: 'public', defaults: 'public' });
  const p = s.fakeX.post(tia.id, 'Ether will reach $10k.');
  const tag = s.fakeX.post(tia.id, '@statedbot', { replyTo: p.id });
  await tick(s.db, s.config, s.x);
  const save = await saveFor(tag.id);
  assert.equal(save.capture, 'prospective');
  const soon = dateOnly(Date.now() + 2 * DAY);
  const soonLabel = new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric' }).format(new Date(`${soon}T23:59:59Z`));
  for (const d of [soon, `${NEXT + 2}-06-30`, `${NEXT + 5}-06-30`]) {
    const res = await tb.submit(`/me/saves/${save.id}/terms`, { deadline: d, probability: '', condition: '', back: `/me/s/${save.id}` });
    assert.equal(res.status, 200, `confirmation to ${d} accepted`);
  }
  const card = (await anon.get(`/u/tia/${save.id}`)).text;
  assert.equal(card.match(/<dt>Deadline<\/dt><dd>([\s\S]*?)<\/dd>/)[1], `${soonLabel}, confirmed by the author`, 'held to the first deadline');
  assert.match(card, new RegExp(`Deadline moved from ${soonLabel} to Jun 30, ${NEXT + 5} on [A-Z][a-z]{2} \\d{1,2}, \\d{4} by the author\\. The prediction is still held to ${soonLabel}\\.`));
  const block = adminBlock((await adminB.get('/admin')).text, `/status/${p.id}`);
  assert.match(block, new RegExp(`held to ${soonLabel}\\. Deadline moved from ${soonLabel} to Jun 30, ${NEXT + 5}`));
  await s.db.query(`update saves set author_committed_deadline_at = now() - interval '1 day' where id = $1`, [save.id]);
  const locked = await tb.submit(`/me/saves/${save.id}/terms`, { deadline: `${NEXT + 9}-01-01`, probability: '', condition: '', back: `/me/s/${save.id}` });
  assert.equal(locked.status, 400, 'once the first deadline passes, the terms are locked');
  assert.match(locked.text, /terms are locked/);
});

test('V9b (N1, M3): extending a stated deadline keeps neither a miss open nor a late publication counted', async () => {
  const run = async (id, name, extend) => {
    const { u, b } = await person(id, name, { profile: 'public', defaults: 'private' });
    const p = s.fakeX.post(u.id, `Copper will top $6 by the end of ${NEXT}, 70% chance.`);
    const tag = s.fakeX.post(u.id, '@statedbot', { replyTo: p.id });
    await tick(s.db, s.config, s.x);
    const save = await saveFor(tag.id);
    if (extend) {
      const res = await b.submit(`/me/saves/${save.id}/terms`, { deadline: `${NEXT + 3}-12-31`, probability: '', condition: '', back: `/me/s/${save.id}` });
      assert.equal(res.status, 200);
    }
    await s.db.query(`update statements set proposed_deadline_at = now() - interval '1 day' where id = $1`, [save.statement_id]);
    await s.db.query(`update saves set created_at = now() - interval '60 days' where id = $1`, [save.id]);
    await b.submit(`/me/saves/${save.id}/visibility`, { visibility: 'public', back: '/me' });
    const admin = (await adminB.get('/admin')).text;
    await adminB.submit(`/admin/resolve/${save.statement_id}`, { outcome: 'yes', url: 'https://example.com/cu6', note: 'Topped $6.', known: dateOnly(Date.now()) }, { from: '/admin' });
    const rec = JSON.parse((await anon.get(`/api/u/${name}`)).text).record;
    const card = (await anon.get(`/u/${name}/${save.id}`)).text;
    return { rec, admin, card, p };
  };
  const control = await run('110', 'una', false);
  assert.equal(control.rec.publishedLate, 1);
  assert.equal(control.rec.scored, 0);
  const ext = await run('111', 'val', true);
  assert.equal(ext.rec.publishedLate, 1, 'the extension does not let the late publication count');
  assert.equal(ext.rec.scored, 0);
  assert.doesNotMatch(ext.card.match(/<dt>Deadline<\/dt><dd>([\s\S]*?)<\/dd>/)[1], new RegExp(`${NEXT + 3}`), 'the card’s deadline is the stated one');
  assert.match(ext.card, new RegExp(`Deadline moved from [A-Z][a-z]{2} \\d{1,2}, \\d{4} to Dec 31, ${NEXT + 3}`));
  assert.match(adminBlock(ext.admin, `/status/${ext.p.id}`), new RegExp(`Deadline moved from [^<]* to Dec 31, ${NEXT + 3}`), 'the reviewer sees the move, and resolves against the stated deadline');
});

test('N1: a "came true" that became known only after the committed deadline counts as did not come true', async () => {
  const { u: wes, b: wb } = await person('113', 'wes');
  const late = s.fakeX.post(wes.id, 'Gold will reach $6k.');
  const inTime = s.fakeX.post(wes.id, 'Silver will reach $90.');
  const t1 = s.fakeX.post(wes.id, '@statedbot', { replyTo: late.id });
  const t2 = s.fakeX.post(wes.id, '@statedbot', { replyTo: inTime.id });
  await tick(s.db, s.config, s.x);
  const s1 = await saveFor(t1.id);
  const s2 = await saveFor(t2.id);
  for (const sv of [s1, s2]) {
    await wb.submit(`/me/saves/${sv.id}/terms`, { deadline: dateOnly(Date.now() + 2 * DAY), probability: '', condition: '', back: '/me' });
  }
  // Time passes: both committed deadlines are now ten days ago.
  await s.db.query(`update saves set author_committed_deadline_at = now() - interval '10 days', author_deadline_at = now() - interval '10 days',
    created_at = now() - interval '30 days' where id = any($1::bigint[])`, [[s1.id, s2.id]]);
  await adminB.submit(`/admin/resolve/${s1.statement_id}`, { outcome: 'yes', url: 'https://example.com/g', note: 'Reached $6k.', known: dateOnly(Date.now() - DAY) }, { from: '/admin' });
  await adminB.submit(`/admin/resolve/${s2.statement_id}`, { outcome: 'yes', url: 'https://example.com/s', note: 'Reached $90.', known: dateOnly(Date.now() - 20 * DAY) }, { from: '/admin' });
  const rec = JSON.parse((await wb.get('/api/me')).text).record;
  assert.equal(rec.resolved, 2);
  assert.equal(rec.cameTrue, 1, 'known before the committed deadline');
  assert.equal(rec.didNot, 1, 'known after it');
  assert.match((await wb.get(`/me/s/${s1.id}`)).text, /Came true only after the deadline it was held to/);
  const inbox = await one(`select body from inbox where save_id = $1 and kind = 'outcome'`, [s1.id]);
  assert.match(inbox.body, /counts as did not come true/);
});

test('N12: publishing reads nothing from X in the request; the worker fills every newly public post in one batched read', async () => {
  const { u: ida, b: ib } = await person('114', 'ida');
  const ids = [];
  for (let i = 0; i < 4; i += 1) {
    const p = s.fakeX.post(bob.id, `Index ${i} will rise 5% by the end of ${NEXT}.`);
    s.fakeX.post(ida.id, '@statedbot', { replyTo: p.id });
    ids.push(p.id);
  }
  await tick(s.db, s.config, s.x);
  const saves = await s.db.many('select id from saves where owner_x_user_id = $1', [ida.id]);
  const reads = tweetReads().length;
  await ib.submit('/me/settings', { profile: 'public', defaults: 'private' });
  await ib.submit('/me/settings/publish', [['confirm', '1'], ...saves.map((sv) => ['publish', String(sv.id)]), ['defaults', 'private']]);
  assert.equal(tweetReads().length, reads, 'no X read while publishing');
  await tick(s.db, s.config, s.x);
  const fill = tweetReads().slice(reads).filter((c) => ids.some((id) => c.query.ids.split(',').includes(id)));
  assert.equal(fill.length, 1, 'one batched read');
  assert.deepEqual(fill[0].query.ids.split(',').sort(), [...ids].sort());
  assert.equal((await one(`select count(*)::int as n from sources where platform_id = any($1::text[]) and text <> ''`, [ids])).n, 4);
});

test('N13: a claim saved only by someone who has not signed up is in the outcome list, without a handle', async () => {
  const ghost = s.fakeX.addUser('115', 'ghost');
  const p = s.fakeX.post(ghost.id, `Ghost claim: wheat will top $9 by the end of ${NEXT}.`);
  s.fakeX.post(ghost.id, '@statedbot', { replyTo: p.id });
  await tick(s.db, s.config, s.x);
  const block = adminBlock((await adminB.get('/admin')).text, `https://x.com/i/web/status/${p.id}`);
  assert.doesNotMatch(block, /ghost/i);
  assert.match(block, /Private saves only/);
});

test('N14: the source check removes a post’s words only when X says it is gone', async () => {
  const { u: kai } = await person('116', 'kai', { profile: 'public', defaults: 'public' });
  const kept = s.fakeX.post(bob.id, `Nickel will top $20k by the end of ${NEXT}. KEPT-CANARY`);
  const gone = s.fakeX.post(bob.id, `Tin will top $50k by the end of ${NEXT}.`);
  s.fakeX.post(kai.id, '@statedbot', { replyTo: kept.id });
  s.fakeX.post(kai.id, '@statedbot', { replyTo: gone.id });
  await tick(s.db, s.config, s.x);
  assert.ok(await storedCount('KEPT-CANARY') > 0);
  await s.db.query('update sources set checked_at = now()');
  await s.db.query('update sources set checked_at = null where platform_id = any($1::text[])', [[kept.id, gone.id]]);
  s.fakeX.deleted.add(gone.id);
  const original = s.fakeX.handle.bind(s.fakeX);
  // X omits the kept post with an error that is not "not found".
  s.fakeX.handle = async (req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/2/tweets?') && req.url.includes(kept.id)) {
      res.writeHead(200, { 'content-type': 'application/json' });
      return res.end(JSON.stringify({ errors: [
        { resource_id: kept.id, title: 'Service Unavailable', detail: 'Try again later.' },
        { resource_id: gone.id, title: 'Not Found Error', detail: `Could not find tweet with ids: [${gone.id}].` },
      ] }));
    }
    return original(req, res);
  };
  let result;
  try {
    result = await checkSources(s.db, s.x);
  } finally {
    s.fakeX.handle = original;
  }
  assert.equal(result.gone.length, 1, 'only the post X says is not found');
  assert.ok(await storedCount('KEPT-CANARY') > 0, 'the transiently omitted post keeps its words');
  assert.equal((await one('select available, checked_at from sources where platform_id = $1', [kept.id])).available, true);
  assert.equal((await one('select checked_at from sources where platform_id = $1', [kept.id])).checked_at, null, 'and is checked again next run');
});

test('L10: with no X_BOT_USER_ID, only the connected bot can authorise again', async () => {
  assert.equal(s.config.x.botUserId, '');
  const url = await startBotAuth(s.db, s.config);
  s.fakeX.consentAs = carol.id;
  const page = await new Browser(s.base).follow(url);
  s.fakeX.consentAs = null;
  assert.equal(page.status, 400);
  assert.match(page.text, /not the configured bot account/);
  assert.equal((await one('select x_user_id from bot_credentials where id = 1')).x_user_id, '500');
  const again = await s.connectBot({ id: '500' });
  assert.equal(again.status, 200, 'the bot itself can still reconnect');
});

test('N10: the desk-seeding guard runs before the database is touched and cannot be switched off', async () => {
  const script = fileURLToPath(new URL('../dev/seed-desk.mjs', import.meta.url));
  const dir = mkdtempSync(join(tmpdir(), 'seed-guard-'));
  const dbUrl = (name) => s.config.databaseUrl.replace(/\/[^/]+$/, `/${name}`);
  const run = (plan, url, env = {}) => new Promise((resolve) => {
    const file = join(dir, `plan-${Math.random().toString(36).slice(2)}.json`);
    writeFileSync(file, JSON.stringify(plan));
    execFile('node', [script, file], { env: { ...process.env, DATABASE_URL: url, ...env } }, (err, stdout, stderr) => {
      resolve({ ok: !err, out: `${stdout}${stderr}` });
    });
  });
  const tables = async (name) => {
    const db = createDb(dbUrl(name));
    try {
      return (await db.one(`select to_regclass('public.users') is not null as yes`)).yes;
    } finally {
      await db.close();
    }
  };
  try {
    for (const name of ['seed_fresh', 'seed_people', 'seed_clean']) await s.db.query(`create database ${name}`);
    const plain = await run({ realRecordsOnly: true, articles: [{ url: 'http://127.0.0.1/story', picks: [] }] }, dbUrl('seed_fresh'));
    assert.equal(plain.ok, false);
    const loop = await run({ articles: [{ url: 'https://127.0.0.1/story', picks: [] }] }, dbUrl('seed_fresh'));
    assert.equal(loop.ok, false);
    assert.match(loop.out, /Not a public https page/);
    assert.equal(await tables('seed_fresh'), false, 'a refused run did not migrate the database');

    const people = createDb(dbUrl('seed_people'));
    await people.migrate();
    await people.query(`insert into users (x_user_id, x_username) values ('42', 'fixture_person')`);
    await people.close();
    for (const [plan, env] of [[{ articles: [] }, {}], [{ realRecordsOnly: true, articles: [] }, { SEED_DESK_ALLOW_PEOPLE: '1' }]]) {
      const r = await run(plan, dbUrl('seed_people'), env);
      assert.equal(r.ok, false, `refused with ${JSON.stringify(plan)} ${JSON.stringify(env)}`);
      assert.match(r.out, /1 person accounts/);
    }
    const check = createDb(dbUrl('seed_people'));
    assert.equal((await check.one(`select count(*)::int as n from users where kind = 'editorial'`)).n, 0, 'no desk user was created');
    await check.close();

    const clean = await run({ articles: [] }, dbUrl('seed_clean'));
    assert.equal(clean.ok, true, clean.out);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
