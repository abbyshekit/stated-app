// Regression tests for the independent review in .review/findings.md. Each
// F-numbered test is the reviewer's reproduction from
// .review/repro/review.test.mjs with its assertions turned around to the
// fixed behaviour; the others cover findings the reviewer confirmed by code
// reading only. Real server, throwaway Postgres, fake X API, loopback sites.

import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import http from 'node:http';
import https from 'node:https';
import { after, before, test } from 'node:test';
import { baselineScore } from '../../score.mjs';
import { isBlockedAddress } from '../src/articles.mjs';
import { commandFlags, sendPendingReplies } from '../src/intake.mjs';
import { checkSources, deliverDms } from '../src/notify.mjs';
import { startBotAuth } from '../src/botauth.mjs';
import { addInbox } from '../src/store.mjs';
import { pollDms, processDm, retryErrored, tick } from '../src/worker.mjs';
import { clearOembedCache, xClaimText } from '../src/xtext.mjs';
import { ADMIN_X_ID, Browser, startStack } from './support/app.mjs';

const NEXT = new Date().getUTCFullYear() + 1;
const LAST = new Date().getUTCFullYear() - 1;
let s;
let site;
let base;
let alice;
let bob;
let carol;
let dave;
let adminB;
let malloryB;
let malloryPublic;
let anon;
let allText;
let dmConfig;

const one = (sql, p = []) => s.db.one(sql, p);
const saveFor = async (eventId) => one('select * from saves where origin_event_id = $1', [eventId]);
const record = async (browser) => JSON.parse((await browser.get('/api/me')).text).record;

// Every place Stated keeps text, searched for one marker.
async function storedCount(marker) {
  const like = `%${marker}%`;
  const r = await one(
    `select (select count(*) from sources where text like $1 or coalesce(title, '') like $1)
          + (select count(*) from statements where span like $1 or coalesce(deadline_text, '') like $1 or coalesce(condition_text, '') like $1)
          + (select count(*) from mention_events where coalesce(payload::text, '') like $1 or coalesce(reply_text, '') like $1)
          + (select count(*) from inbox where body like $1)
          + (select count(*) from revisions where coalesce(before::text, '') || coalesce(after::text, '') || coalesce(note, '') like $1) as n`,
    [like],
  );
  return Number(r.n);
}

function failTweetLookups() {
  const original = s.fakeX.handle.bind(s.fakeX);
  s.fakeX.handle = async (req, res) => {
    if (req.method === 'GET' && req.url.startsWith('/2/tweets?')) {
      res.writeHead(503, { 'content-type': 'application/json' });
      return res.end('{"title":"Service Unavailable"}');
    }
    return original(req, res);
  };
  return () => { s.fakeX.handle = original; };
}

before(async () => {
  s = await startStack();
  const bot = s.fakeX.addUser('500', 'statedbot');
  alice = s.fakeX.addUser('100', 'alice');
  bob = s.fakeX.addUser('200', 'bob');
  carol = s.fakeX.addUser('300', 'carol');
  dave = s.fakeX.addUser('400', 'dave');
  s.fakeX.addUser(ADMIN_X_ID, 'reviewer');
  await s.connectBot(bot);
  allText = { ...s.config, x: { ...s.config.x, textPolicy: 'all' } };
  dmConfig = { ...s.config, x: { ...s.config.x, dmEnabled: true } };
  site = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    if (req.url === '/story') {
      return res.end(`<html><head><title>REVIEW FIXTURE: Real story</title><meta name="author" content="Jane Writer"></head>
        <body><p>REVIEW FIXTURE. The index will top 6,000 by the end of ${NEXT}, in this writer’s view.</p></body></html>`);
    }
    if (req.url === '/evil-takeover') {
      return res.end(`<html><head><meta property="og:title" content="FORGED TITLE planted by a signed-in user">
        <link rel="canonical" href="${base}/story"></head><body><p>Nothing here.</p></body></html>`);
    }
    if (req.url === '/evil-forge') {
      return res.end(`<html><head><meta property="og:title" content="Reuters: Powell sets out the rate path">
        <link rel="canonical" href="https://www.reuters.com/markets/us/powell-rate-path-${NEXT}/"></head><body>
        <p>“Rates will hit 10% by March ${NEXT},” said Jerome Powell, who has called the last three moves.</p></body></html>`);
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

test('H1 (F1): a page naming a desk article as its canonical cannot retitle the desk record', async () => {
  const picker = await adminB.submit('/admin/editorial', { url: `${base}/story` }, { from: '/admin' });
  const intakeId = picker.url.match(/(\d+)$/)[1];
  const intake = await one('select candidates from url_intakes where id = $1', [intakeId]);
  assert.ok(intake.candidates.length > 0);
  await adminB.submit(`/admin/editorial/${intakeId}`, intake.candidates.map((c) => ['pick', String(c.index)]));
  const deskSave = (await one(`select s.id from saves s join users u on u.id = s.owner_user_id where u.kind = 'editorial' order by s.id desc limit 1`)).id;
  assert.match((await anon.get(`/desk/${deskSave}`)).text, /REVIEW FIXTURE: Real story/);

  const mallory = s.fakeX.addUser('666', 'mallory');
  malloryB = await s.signIn(mallory);
  await malloryB.submit('/setup', { profile: 'private', defaults: 'private' });
  await malloryB.submit('/me/track', { url: `${base}/evil-takeover` }, { from: '/me/track' });

  const page = await anon.get(`/desk/${deskSave}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /REVIEW FIXTURE: Real story/);
  assert.doesNotMatch(page.text, /FORGED TITLE/);
  const title = await one(`select src.title from saves s join statements st on st.id = s.statement_id
    join sources src on src.id = st.source_id where s.id = $1`, [deskSave]);
  assert.equal(title.title, 'REVIEW FIXTURE: Real story');
});

test('H1 (F1b): a page cannot borrow another site’s address, and a web record shows the host it came from', async () => {
  const picker = await malloryB.submit('/me/track', { url: `${base}/evil-forge` }, { from: '/me/track' });
  const source = await one(`select url from sources where title like 'Reuters:%'`);
  assert.ok(source.url.startsWith(base), `stored the fetched address, not the claimed one: ${source.url}`);
  const intakeId = picker.url.match(/(\d+)$/)[1];
  const intake = await one('select candidates from url_intakes where id = $1', [intakeId]);
  assert.ok(intake.candidates.length > 0);
  await malloryB.submit(`/me/track/${intakeId}`, intake.candidates.map((c) => ['pick', String(c.index)]));
  const save = await one(`select id from saves where owner_x_user_id = '666' order by id desc limit 1`);
  await malloryB.submit('/me/settings/publish', [['confirm', '1'], ['publish', String(save.id)], ['defaults', 'private']], { from: '/me/settings' });
  const pub = await anon.get(`/u/mallory/${save.id}`);
  assert.equal(pub.status, 200);
  assert.doesNotMatch(pub.text, /href="https:\/\/www\.reuters\.com/);
  assert.match(pub.text, /Reuters: Powell sets out the rate path<\/a> <span class="mono">\(127\.0\.0\.1\)<\/span>/);
  malloryPublic = save.id;
});

test('H2 (F2): terms lock at the deadline, an earlier confirmed deadline makes the save backfill, and the posted probability is scored', async () => {
  const p = s.fakeX.post(alice.id, `Bitcoin will close above $150k by the end of ${NEXT}, 60% chance.`);
  const q = s.fakeX.post(alice.id, `Gold will close above $5k by the end of ${NEXT}, 60% chance.`);
  const tag = s.fakeX.post(alice.id, '@statedbot', { replyTo: p.id });
  const tag2 = s.fakeX.post(alice.id, '@statedbot', { replyTo: q.id });
  await tick(s.db, s.config, s.x);
  const save = await saveFor(tag.id);
  const save2 = await saveFor(tag2.id);
  const a = await s.signIn(alice);
  await a.submit('/setup', { profile: 'private', defaults: 'private' });

  const res = await a.submit(`/me/saves/${save.id}/terms`, { deadline: `${LAST}-06-30`, probability: '99', condition: '', back: `/me/s/${save.id}` });
  assert.equal(res.status, 200);
  const row = await one('select capture, author_probability_added from saves where id = $1', [save.id]);
  assert.equal(row.capture, 'backfill', 'a confirmed deadline before the save makes it backfill');
  assert.equal(row.author_probability_added, true);
  const again = await a.submit(`/me/saves/${save.id}/terms`, { deadline: `${NEXT}-12-31`, probability: '99', condition: '', back: `/me/s/${save.id}` });
  assert.equal(again.status, 400);
  assert.match(again.text, /terms are locked/);

  await a.submit(`/me/saves/${save2.id}/terms`, { deadline: `${NEXT}-12-31`, probability: '99', condition: '', back: `/me/s/${save2.id}` });
  for (const sv of [save, save2]) {
    await adminB.submit(`/admin/resolve/${sv.statement_id}`, { outcome: 'yes', url: 'https://example.com/e', note: 'It happened.', known: new Date().toISOString().slice(0, 10) }, { from: '/admin' });
  }
  const rec = await record(a);
  assert.equal(rec.backfill, 1);
  assert.equal(rec.scored, 1);
  assert.ok(Math.abs(rec.averageBaseline - baselineScore(0.6, 'yes')) < 0.01, `scored from the posted 60%, not the 99% added later (got ${rec.averageBaseline})`);
  assert.match((await a.get(`/me/s/${save2.id}`)).text, /added by the author after posting\. Not scored\./);
});

test('M1 (F3): a reviewed deadline earlier than a save makes that save backfill', async () => {
  const p = s.fakeX.post(bob.id, `Gold will hit $5,000 by the end of ${NEXT}.`);
  const tag = s.fakeX.post(bob.id, '@statedbot', { replyTo: p.id });
  await tick(s.db, s.config, s.x);
  const save = await saveFor(tag.id);
  const b = await s.signIn(bob);
  await b.submit('/setup', { profile: 'private', defaults: 'private' });
  await adminB.submit(`/admin/terms/${save.statement_id}`, { deadline: `${LAST}-01-31`, probability: '', condition: '', note: 'Meant January' }, { from: '/admin' });
  await adminB.submit(`/admin/resolve/${save.statement_id}`, { outcome: 'yes', url: 'https://example.com/gold', note: 'Hit.', known: new Date().toISOString().slice(0, 10) }, { from: '/admin' });
  assert.equal((await one('select capture from saves where id = $1', [save.id])).capture, 'backfill');
  const rec = await record(b);
  assert.equal(rec.resolved, 0);
  assert.equal(rec.backfill, 1);
  const kinds = (await s.db.many('select kind from revisions where save_id = $1 order by id', [save.id])).map((r) => r.kind);
  assert.ok(kinds.includes('capture_changed'), 'the history records why it changed');
});

test('a reviewed later deadline undoes a backfill label that came only from a misread deadline', async () => {
  const p = s.fakeX.post(bob.id, 'Our survey: 93% expect a pause at the Fed meeting taking place this week and 76% anticipate a rate hike at its next meeting in December.', { at: new Date(Date.now() - 10 * 86_400_000) });
  const tag = s.fakeX.post(carol.id, '@statedbot', { replyTo: p.id });
  await tick(s.db, s.config, s.x);
  const save = await saveFor(tag.id);
  assert.equal(save.capture, 'backfill', 'the first deadline read from the text has passed');
  await adminB.submit(`/admin/terms/${save.statement_id}`, { deadline: `${NEXT}-12-09`, probability: '', condition: '', note: 'Tracks the December call' }, { from: '/admin' });
  assert.equal((await one('select capture from saves where id = $1', [save.id])).capture, 'prospective');
  assert.equal((await one('select capture from statements where id = $1', [save.statement_id])).capture, 'prospective');
  const change = await one(`select before, after from revisions where save_id = $1 and kind = 'capture_changed'`, [save.id]);
  assert.deepEqual([change.before.capture, change.after.capture], ['backfill', 'prospective']);
});

test('M2 (F4): an undated post saved long after it was made, or saved after the outcome was known, is backfill', async () => {
  const p = s.fakeX.post(dave.id, 'Bitcoin will trade above $100k.', { at: new Date('2019-03-01T00:00:00Z') });
  const tag = s.fakeX.post(dave.id, '@statedbot', { replyTo: p.id });
  await tick(s.db, s.config, s.x);
  const save = await saveFor(tag.id);
  assert.equal(save.capture, 'backfill');
  assert.match((await one(`select note from revisions where save_id = $1 and kind = 'captured'`, [save.id])).note, /more than 30 days after it was made/);
  await adminB.submit(`/admin/resolve/${save.statement_id}`, { outcome: 'yes', url: 'https://example.com/btc-100k', note: 'Happened in Dec 2024.', known: new Date().toISOString().slice(0, 10) }, { from: '/admin' });

  const fresh = s.fakeX.post(dave.id, 'The Knicks will sign a new coach.');
  const tag2 = s.fakeX.post(dave.id, '@statedbot', { replyTo: fresh.id });
  await tick(s.db, s.config, s.x);
  const save2 = await saveFor(tag2.id);
  assert.equal(save2.capture, 'prospective');
  const yesterday = new Date(Date.now() - 86_400_000).toISOString().slice(0, 10);
  await adminB.submit(`/admin/resolve/${save2.statement_id}`, { outcome: 'yes', url: 'https://example.com/coach', note: 'Signed the day before it was saved.', known: yesterday }, { from: '/admin' });
  assert.equal((await one('select capture from saves where id = $1', [save2.id])).capture, 'backfill');

  const d = await s.signIn(dave);
  await d.submit('/setup', { profile: 'private', defaults: 'private' });
  const rec = await record(d);
  assert.equal(rec.backfill, 2);
  assert.equal(rec.cameTrue, 0);
});

test('H3 (F5): a privately saved post’s words are never stored, and a deleted post’s words leave every table', async () => {
  const p = s.fakeX.post(bob.id, `Oil will trade above $120 by the end of ${NEXT}. TOMBSTONE-PRIVATE`);
  const tag = s.fakeX.post(carol.id, '@statedbot', { replyTo: p.id });
  await tick(s.db, s.config, s.x);
  const c = await s.signIn(carol);
  await c.submit('/setup', { profile: 'private', defaults: 'private' });
  assert.equal(await storedCount('TOMBSTONE-PRIVATE'), 0, 'nothing of a private save’s words is stored');
  const own = await c.get(`/me/s/${(await saveFor(tag.id)).id}?words=1`);
  assert.match(own.text, /TOMBSTONE-PRIVATE/, 'the owner can still read it, shown from X on request');
  assert.equal(await storedCount('TOMBSTONE-PRIVATE'), 0, 'reading it stores nothing');

  // With every post's words stored (STATED_X_TEXT_POLICY=all), deletion removes them everywhere.
  const q = s.fakeX.post(bob.id, `Oil will trade above $130 by the end of ${NEXT}. TOMBSTONE-CANARY`);
  const tag2 = s.fakeX.post(carol.id, '@statedbot', { replyTo: q.id });
  await tick(s.db, allText, s.x);
  assert.ok(await storedCount('TOMBSTONE-CANARY') > 0, 'stored under the all policy');
  await s.db.query('update sources set checked_at = now()');
  await s.db.query('update sources set checked_at = null where platform_id = $1', [q.id]);
  s.fakeX.deleted.add(q.id);
  clearOembedCache();
  const result = await checkSources(s.db, s.x);
  assert.equal(result.gone.length, 1);
  assert.equal(await storedCount('TOMBSTONE-CANARY'), 0);
  for (const path of ['/me/inbox', '/api/me/inbox', `/me/s/${(await saveFor(tag2.id)).id}`, '/api/me', '/me/export.json']) {
    assert.doesNotMatch((await c.get(path)).text, /TOMBSTONE-CANARY|above \$130/, path);
  }
});

test('the owner’s page falls back to a link when X will not show the post', async () => {
  const p = s.fakeX.post(bob.id, `Copper will hit $7 by the end of ${NEXT}. OEMBED-GONE`);
  const tag = s.fakeX.post(carol.id, '@statedbot', { replyTo: p.id });
  await tick(s.db, s.config, s.x);
  s.fakeX.deleted.add(p.id);
  clearOembedCache();
  const c = await s.signIn(carol);
  const page = await c.get(`/me/s/${(await saveFor(tag.id)).id}?words=1`);
  assert.doesNotMatch(page.text, /OEMBED-GONE/);
  assert.match(page.text, /X did not return this post’s words/);
  assert.match(page.text, new RegExp(`href="https://x.com/bob/status/${p.id}"`));
});

test('M5 (F6): a mention claimed by a worker that crashed is taken over once its lease runs out', async () => {
  const p = s.fakeX.post(bob.id, `Rents will fall 10% by the end of ${NEXT}.`);
  const tag = s.fakeX.post(alice.id, '@statedbot', { replyTo: p.id });
  await s.db.query(`insert into mention_events (event_id, author_x_user_id, outcome, attempts, processing_since) values ($1, $2, 'processing', 1, now())`, [tag.id, alice.id]);
  const first = await tick(s.db, s.config, s.x);
  assert.equal(first.mentions.processed.find((x) => x.id === tag.id)?.outcome, 'replay', 'a live claim is left to its worker');
  await s.db.query(`update mention_events set processing_since = now() - interval '11 minutes' where event_id = $1`, [tag.id]);
  await s.db.query(`delete from kv where key = 'mentions_since_id'`);
  await tick(s.db, s.config, s.x);
  assert.ok(await saveFor(tag.id), 'the abandoned claim was taken over');
  assert.equal((await one('select outcome from mention_events where event_id = $1', [tag.id])).outcome, 'saved');
});

test('M5: a reply interrupted mid-send is marked for a person to check and never posted again', async () => {
  const ev = await one(`select event_id from mention_events where reply_status = 'sent' order by received_at desc limit 1`);
  await s.db.query(`update mention_events set reply_status = 'sending', replied_at = now() - interval '11 minutes' where event_id = $1`, [ev.event_id]);
  const posts = s.fakeX.created.length;
  await sendPendingReplies(s.db, s.x);
  const row = await one('select reply_status, reply_error from mention_events where event_id = $1', [ev.event_id]);
  assert.equal(row.reply_status, 'failed');
  assert.match(row.reply_error, /Check the bot/);
  assert.equal(s.fakeX.created.length, posts);
});

test('M6 (F7): a transient X error is retried, with no public reply in the meantime', async () => {
  const p = s.fakeX.post(bob.id, `Unemployment will reach 5% by the end of ${NEXT}.`);
  const tag = s.fakeX.post(dave.id, `@statedbot https://x.com/bob/status/${p.id}`);
  const replies = s.fakeX.created.length;
  const restore = failTweetLookups();
  try {
    await tick(s.db, s.config, s.x);
  } finally {
    restore();
  }
  const ev = await one('select outcome, reply_status, reply_text, payload::text as payload from mention_events where event_id = $1', [tag.id]);
  assert.equal(ev.outcome, 'error');
  assert.equal(ev.reply_text, null);
  assert.equal(s.fakeX.created.length, replies, 'no reply while the outcome is unknown');
  await retryErrored(s.db, s.config, s.x);
  assert.ok(await saveFor(tag.id), 'the retry saved it once X recovered');
  assert.equal((await one('select outcome from mention_events where event_id = $1', [tag.id])).outcome, 'saved');
});

test('M7 (F8): reviewers see neither the speaker nor the save count of a claim no one has made public', async () => {
  const p = s.fakeX.post(carol.id, `Carol private claim: the Lakers will win the ${NEXT} title.`);
  s.fakeX.post(carol.id, '@statedbot #private', { replyTo: p.id });
  await tick(s.db, s.config, s.x);
  const page = (await adminB.get('/admin')).text;
  const at = page.indexOf(`https://x.com/i/web/status/${p.id}`);
  assert.ok(at > 0, 'listed with a link that carries no handle');
  const block = page.slice(page.lastIndexOf('<form', at), page.indexOf('</form>', at));
  assert.doesNotMatch(block, /carol/i);
  assert.doesNotMatch(block, /\d+ saves?\b/);
  assert.match(block, /Private saves only/);
});

test('M4 and N11: the reviewer sees an author’s confirmed terms only once that save is public', async () => {
  const p = s.fakeX.post(alice.id, `Ether will reach $10k by the end of ${NEXT}.`);
  const tag = s.fakeX.post(alice.id, '@statedbot', { replyTo: p.id });
  await tick(s.db, s.config, s.x);
  const save = await saveFor(tag.id);
  const a = await s.signIn(alice);
  await a.submit(`/me/saves/${save.id}/terms`, { deadline: `${NEXT}-03-31`, probability: '', condition: 'if spot ETFs are approved', back: `/me/s/${save.id}` });
  const blockFor = (page, href) => {
    const at = page.indexOf(href);
    assert.ok(at > 0, `listed: ${href}`);
    return page.slice(page.lastIndexOf('<form', at), page.indexOf('</form>', at));
  };
  const hidden = blockFor((await adminB.get('/admin')).text, `https://x.com/i/web/status/${p.id}`);
  assert.doesNotMatch(hidden, /alice|author|confirmed|spot ETFs|Mar 31/i, 'nothing shows that a saver, let alone the author, confirmed terms');
  assert.match(hidden, /Private saves only/);

  await a.submit('/me/settings/publish', [['confirm', '1'], ['publish', String(save.id)], ['defaults', 'private']], { from: '/me/settings' });
  const shown = blockFor((await adminB.get('/admin')).text, `/status/${p.id}`);
  assert.match(shown, new RegExp(`On the public record: held to Mar 31, ${NEXT}`));
  assert.match(shown, /condition “if spot ETFs are approved”/);
});

test('L1 (F9): a status banner comes from a fixed list, never from the address', async () => {
  const page = await anon.get(`/u/mallory/${malloryPublic}?done=${encodeURIComponent('Verified by the Stated desk: this came true.')}`);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, /Verified by the Stated desk/);
  assert.doesNotMatch(page.text, /role="status"/);
  assert.match((await malloryB.get('/me?done=public')).text, /Now public on your profile\./);
});

test('M8 (F10): only #public and #private are commands, no word is cut from a claim, and tags cannot publish without a public profile', async () => {
  assert.equal(commandFlags('@statedbot The public will sour on AI art by the end of 2027.').public, false);
  assert.equal(commandFlags('@statedbot #public').public, true);
  assert.equal(xClaimText('@statedbot The public will sour on AI art by the end of 2027. #public', 'statedbot'), 'The public will sour on AI art by the end of 2027.');
  const e = s.fakeX.addUser('700', 'erin');
  const eb = await s.signIn(e);
  await eb.submit('/me/settings/publish', [['confirm', '1'], ['defaults', 'private']], { from: '/setup' });
  const m = s.fakeX.post(e.id, `@statedbot The public will sour on AI art by the end of ${NEXT}.`);
  await tick(s.db, s.config, s.x);
  const save = await saveFor(m.id);
  assert.equal(save.visibility, 'private', 'the word "public" is not a command');
  assert.equal((await anon.request('GET', `/u/erin/${save.id}`)).status, 404);

  const m2 = s.fakeX.post(e.id, `@statedbot #public The private sector will add 2 million jobs by the end of ${NEXT}.`);
  await tick(s.db, s.config, s.x);
  const save2 = await saveFor(m2.id);
  assert.equal(save2.visibility, 'public');
  assert.equal((await one('select span from statements where id = $1', [save2.statement_id])).span, `The private sector will add 2 million jobs by the end of ${NEXT}.`);
  assert.equal((await one('select command from mention_events where event_id = $1', [m2.id])).command, '#public');

  const z = s.fakeX.addUser('701', 'zed');
  const m3 = s.fakeX.post(z.id, `@statedbot #public Rates will be cut by the end of ${NEXT}.`);
  await tick(s.db, s.config, s.x);
  assert.equal((await saveFor(m3.id)).visibility, 'private', 'no account, no public profile: stays private');
});

test('L2 (F11): a recycled handle cannot take over an earlier owner’s record links', async () => {
  const fern = s.fakeX.addUser('710', 'fern');
  const p = s.fakeX.post(fern.id, `Fern says inflation will be 2% by the end of ${NEXT}.`);
  const tag = s.fakeX.post(fern.id, '@statedbot', { replyTo: p.id });
  await tick(s.db, s.config, s.x);
  const save = await saveFor(tag.id);
  const fb = await s.signIn(fern);
  await fb.submit('/me/settings/publish', [['confirm', '1'], ['publish', String(save.id)], ['defaults', 'private']], { from: '/setup' });
  await tick(s.db, s.config, s.x);
  assert.equal((await anon.get(`/u/fern/${save.id}`)).status, 200);
  s.fakeX.users.get('710').username = 'fern_renamed';
  const imposter = s.fakeX.addUser('711', 'fern');
  const ib = await s.signIn(imposter);
  await ib.submit('/me/settings/publish', [['confirm', '1'], ['defaults', 'private']], { from: '/setup' });
  const old = await anon.get(`/u/fern/${save.id}`);
  assert.equal(old.status, 200, 'the old link still reaches the record');
  assert.doesNotMatch(old.url, /\/u\/fern\//, 'and leaves the handle that now names someone else');
  assert.match(old.text, /Fern says inflation/);
  assert.equal(JSON.parse((await anon.get('/api/u/fern')).text).predictions.length, 0);
  await s.signIn(s.fakeX.users.get('710'));
  assert.match((await anon.get(`/u/fern/${save.id}`)).url, new RegExp(`/u/fern_renamed/${save.id}$`));
});

test('a public X record whose words are missing is filled by the worker', async () => {
  const st = await one(`select st.id, src.id as source_id, src.platform_id from saves s join users u on u.id = s.owner_user_id
    join statements st on st.id = s.statement_id join sources src on src.id = st.source_id
    where u.x_username = 'fern_renamed' limit 1`);
  await s.db.query(`update sources set text = '' where id = $1`, [st.source_id]);
  await s.db.query(`update statements set span = 'X post ' || $2 where id = $1`, [st.id, st.platform_id]);
  const summary = await tick(s.db, s.config, s.x);
  assert.deepEqual(summary.textFilled.map(String), [String(st.source_id)]);
  assert.match((await one('select span from statements where id = $1', [st.id])).span, /^Fern says inflation/);
});

test('M9 (F12): an outcome needs evidence, an unclear one needs a reason, and a change needs a new note', async () => {
  const p = s.fakeX.post(dave.id, `The merger will close by the end of ${NEXT}, 80% chance.`);
  const tag = s.fakeX.post(dave.id, '@statedbot', { replyTo: p.id });
  await tick(s.db, s.config, s.x);
  const save = await saveFor(tag.id);
  const path = `/admin/resolve/${save.statement_id}`;
  const status = async () => (await one('select status from statements where id = $1', [save.statement_id])).status;
  const noEvidence = await adminB.submit(path, { outcome: 'no', url: '', note: 'nope' }, { from: '/admin' });
  assert.equal(noEvidence.status, 400);
  assert.match(noEvidence.text, /Add an https link to the evidence/);
  assert.equal(await status(), 'open');
  assert.equal((await adminB.submit(path, { outcome: 'ambiguous', url: '', note: '' }, { from: '/admin' })).status, 400);
  const today = new Date().toISOString().slice(0, 10);
  await adminB.submit(path, { outcome: 'no', url: 'https://example.com/merger', note: 'Deal called off.', known: today }, { from: '/admin' });
  assert.equal(await status(), 'no');
  const sameNote = await adminB.submit(path, { outcome: 'yes', url: 'https://example.com/merger-2', note: 'Deal called off.', known: today }, { from: '/admin' });
  assert.equal(sameNote.status, 400);
  assert.match(sameNote.text, /needs a new note/);
  const future = await adminB.submit(path, { outcome: 'yes', url: 'https://example.com/merger-2', note: 'Revived.', known: `${NEXT + 1}-01-01` }, { from: '/admin' });
  assert.equal(future.status, 400);
  assert.equal(await status(), 'no');
});

test('H4 (F13): a post link pasted at /me/track is read through the X API, never fetched from x.com', async () => {
  const p = s.fakeX.post(bob.id, `Housing starts will fall 5% by the end of ${NEXT}.`);
  const seen = [];
  const realRequest = https.request;
  https.request = (url) => {
    seen.push(String(url));
    const req = new EventEmitter();
    req.end = () => setImmediate(() => req.emit('error', new Error('stubbed: no network in tests')));
    req.destroy = () => {};
    return req;
  };
  let page;
  let refused;
  try {
    const a = await s.signIn(alice);
    page = await a.submit('/me/track', { url: `https://x.com/bob/status/${p.id}` }, { from: '/me/track' });
    refused = await a.submit('/me/track', { url: 'https://x.com/bob' }, { from: '/me/track' });
  } finally {
    https.request = realRequest;
  }
  assert.deepEqual(seen.filter((u) => /x\.com|twitter\.com/.test(u)), []);
  assert.equal(page.status, 200);
  assert.match(page.url, /\/me\/s\/\d+\?done=xsaved$/);
  const save = await one(`select s.visibility, s.relation from saves s join statements st on st.id = s.statement_id
    join sources src on src.id = st.source_id where src.platform_id = $1 and s.owner_x_user_id = $2`, [p.id, alice.id]);
  assert.deepEqual({ ...save }, { visibility: 'private', relation: 'following' });
  assert.equal(refused.status, 422);
  assert.match(refused.text, /single post/);
});

test('L3 (F14): visits count once per browser cookie a day; loops, rotating agents and crawlers do not count; stale sign-in states are purged', async () => {
  const fromReply = async () => JSON.parse((await adminB.get('/admin/metrics.json')).text).visits.fromReply;
  // A real browser loads the page, then its stylesheet with the cookie the page set.
  const visit = async (browser, path, headers = {}) => {
    await browser.request('GET', path, { headers });
    await browser.request('GET', '/static/stated.css', { headers: { ...headers, referer: new URL(path, s.base).toString() } });
  };
  const before = await fromReply();
  for (let i = 0; i < 25; i += 1) await new Browser(s.base).request('GET', '/?r=reply', { headers: { 'user-agent': `Mozilla/5.0 rotating-${i}` } });
  assert.equal((await fromReply()) - before, 0, 'requests that never come back with the cookie are not visits');
  await visit(new Browser(s.base), '/?r=reply', { 'user-agent': 'Twitterbot/1.0' });
  assert.equal((await fromReply()) - before, 0, 'crawlers are not counted');
  const real = new Browser(s.base);
  for (let i = 0; i < 3; i += 1) await visit(real, '/?r=reply');
  assert.equal((await fromReply()) - before, 1, 'one browser counts once a day');
  await visit(new Browser(s.base), '/?r=reply');
  assert.equal((await fromReply()) - before, 2, 'a second browser is a second visitor');
  await real.request('GET', '/static/stated.css', { headers: { referer: 'https://elsewhere.example/?r=reply' } });
  assert.equal((await fromReply()) - before, 2, 'a stylesheet load from another site counts nothing');
  await s.db.query(`insert into oauth_states (state, code_verifier, purpose, created_at) values ('stale-state', 'v', 'signin', now() - interval '2 hours')`);
  await new Browser(s.base).request('GET', '/signin/x');
  assert.equal(await one(`select 1 from oauth_states where state = 'stale-state'`), null);
});

test('L4 (F15): a reviewer fixing only the probability keeps the reviewed deadline', async () => {
  const p = s.fakeX.post(bob.id, `Silver will hit $80 by the end of ${NEXT}.`);
  const tag = s.fakeX.post(carol.id, '@statedbot', { replyTo: p.id });
  await tick(s.db, s.config, s.x);
  const save = await saveFor(tag.id);
  await adminB.submit(`/admin/terms/${save.statement_id}`, { deadline: `${NEXT}-06-30`, probability: '', condition: '', note: 'June' }, { from: '/admin' });
  await adminB.submit(`/admin/terms/${save.statement_id}`, { deadline: '', probability: '40', condition: '', note: 'Prob only' }, { from: '/admin' });
  const st = await one('select deadline_at, reviewed_probability from statements where id = $1', [save.statement_id]);
  assert.equal(new Date(st.deadline_at).toISOString().slice(0, 10), `${NEXT}-06-30`);
  assert.equal(Number(st.reviewed_probability), 0.4);
});

test('L5 (F16): a DM saying STOP turns messages off with one confirmation', async () => {
  await s.db.query('update users set dm_updates = true where x_user_id = $1', [alice.id]);
  const sent = s.fakeX.dmsSent.length;
  const out = await processDm(s.db, dmConfig, s.x, { id: 'dm-stop-1', sender_id: alice.id, text: 'STOP', event_type: 'MessageCreate' }, await s.x.identity());
  assert.equal(out.outcome, 'opted_out');
  assert.equal(s.fakeX.dmsSent.length, sent + 1);
  assert.match(s.fakeX.dmsSent.at(-1).text, /will not get messages/);
  const u = await one('select dm_updates, dm_opted_out_at from users where x_user_id = $1', [alice.id]);
  assert.equal(u.dm_updates, false);
  assert.ok(u.dm_opted_out_at);
  await s.db.query('update users set dm_updates = true where x_user_id = $1', [alice.id]);
  await addInbox(s.db, { ownerXUserId: alice.id, kind: 'deadline', body: 'A deadline is near.', dedupeKey: 'optout-check', deliverDm: true });
  await deliverDms(s.db, s.x, dmConfig);
  assert.equal(s.fakeX.dmsSent.filter((d) => d.to === alice.id).length, s.fakeX.dmsSent.slice(0, sent + 1).filter((d) => d.to === alice.id).length, 'no message after STOP');
});

test('L6: one failing DM does not stop the others, and it is retried', async () => {
  const p = s.fakeX.post(bob.id, `Wages will rise 5% by the end of ${NEXT}.`);
  s.fakeX.dmEvents = [
    { id: '9000000000000000002', event_type: 'MessageCreate', sender_id: dave.id, text: 'START' },
    { id: '9000000000000000001', event_type: 'MessageCreate', sender_id: dave.id, text: `https://x.com/bob/status/${p.id}` },
  ];
  const restore = failTweetLookups();
  let first;
  try {
    first = await pollDms(s.db, dmConfig, s.x);
  } finally {
    restore();
  }
  assert.equal(first.find((e) => e.id === '9000000000000000001').outcome, 'error');
  assert.equal(first.find((e) => e.id === '9000000000000000002').outcome, 'opted_in');
  const second = await pollDms(s.db, dmConfig, s.x);
  assert.equal(second.find((e) => e.id === '9000000000000000001').outcome, 'saved');
  s.fakeX.dmEvents = [];
});

test('L7: link intake by mention is rate limited, a tagger’s replies are capped, and duplicates get no reply', async () => {
  for (let i = 0; i < 20; i += 1) {
    await s.db.query(`insert into url_intakes (owner_x_user_id, url, route, status) values ($1, 'https://example.com', 'mention', 'failed')`, [dave.id]);
  }
  const m = s.fakeX.post(dave.id, `@statedbot ${base}/story`);
  await tick(s.db, s.config, s.x);
  assert.equal((await one('select outcome from mention_events where event_id = $1', [m.id])).outcome, 'rate_limited');

  const capped = { ...s.config, x: { ...s.config.x, repliesPerTaggerPerHour: 1 } };
  const h = s.fakeX.addUser('750', 'hal');
  const a1 = s.fakeX.post(bob.id, `Tin will hit $40k by the end of ${NEXT}.`);
  const a2 = s.fakeX.post(bob.id, `Zinc will hit $4k by the end of ${NEXT}.`);
  const t1 = s.fakeX.post(h.id, '@statedbot', { replyTo: a1.id });
  const t2 = s.fakeX.post(h.id, '@statedbot', { replyTo: a2.id });
  await tick(s.db, capped, s.x);
  const statuses = await s.db.many('select reply_status from mention_events where event_id in ($1, $2) order by event_id', [t1.id, t2.id]);
  assert.deepEqual(statuses.map((r) => r.reply_status).sort(), ['held', 'sent']);
});

test('L8: an out-of-range ID is a 404, not a server error', async () => {
  for (const path of ['/desk/99999999999999999999', '/u/mallory/99999999999999999999', '/api/u/mallory/999999999999999999', '/me/s/99999999999999999999']) {
    const res = await anon.request('GET', path);
    assert.ok([303, 404].includes(res.status), `${path} gave ${res.status}`);
  }
});

test('L9: deprecated IPv6 forms that embed a private address are blocked', () => {
  for (const address of ['::7f00:1', '::127.0.0.1', 'fec0::1', '2002:7f00:1::1', '2001:0:4136:e378:8000:63bf:3fff:fdd2']) {
    assert.equal(isBlockedAddress(address), true, address);
  }
  assert.equal(isBlockedAddress('2606:4700:4700::1111'), false);
});

test('L10: bot authorization is refused for any account but the configured bot', async () => {
  const before = await one('select x_user_id from bot_credentials where id = 1');
  s.config.x.botUserId = '500';
  try {
    const url = await startBotAuth(s.db, s.config);
    s.fakeX.consentAs = carol.id;
    const page = await new Browser(s.base).follow(url);
    s.fakeX.consentAs = null;
    assert.equal(page.status, 400);
    assert.match(page.text, /not the configured bot account/);
  } finally {
    s.config.x.botUserId = null;
  }
  assert.equal((await one('select x_user_id from bot_credentials where id = 1')).x_user_id, before.x_user_id);
});

test('L11: public pages and JSON must be revalidated by any cache', async () => {
  for (const path of ['/desk', '/api/search?q=x', `/u/mallory/${malloryPublic}`]) {
    assert.equal((await anon.request('GET', path)).headers.get('cache-control'), 'no-cache', path);
  }
});

test('M10 (F17): picks from the private link route stay private even when new saves default to public', async () => {
  const g = s.fakeX.addUser('720', 'gail');
  const gb = await s.signIn(g);
  await gb.submit('/me/settings/publish', [['confirm', '1'], ['defaults', 'public']], { from: '/setup' });
  const picker = await gb.submit('/me/track', { url: `${base}/story` }, { from: '/me/track' });
  const intakeId = picker.url.match(/(\d+)$/)?.[1];
  const intake = await one('select candidates from url_intakes where id = $1', [intakeId]);
  assert.ok(intake.candidates.length > 0);
  await gb.submit(`/me/track/${intakeId}`, intake.candidates.map((c) => ['pick', String(c.index)]));
  const save = await one(`select id, visibility from saves where owner_x_user_id = '720' order by id desc limit 1`);
  assert.equal(save.visibility, 'private');
  assert.equal((await anon.request('GET', `/u/gail/${save.id}`)).status, 404);
});

test('M11 (F18): a source check covers every due post, in batches of 100', async () => {
  await s.db.query('update sources set checked_at = now()');
  const owner = await one('select id from users where x_user_id = $1', [alice.id]);
  for (let i = 0; i < 101; i += 1) {
    const pid = String(9100000000000000000n + BigInt(i));
    const src = await one(`insert into sources (platform, platform_id, url, text, acquisition) values ('x', $1, $2, 'CAP-TEST text', 'mention') returning id`, [pid, `https://x.com/i/web/status/${pid}`]);
    const st = await one(`insert into statements (source_id, span, speaker) values ($1, $2, '@bob') returning id`, [src.id, `CAP-TEST ${pid}`]);
    await s.db.query(`insert into saves (owner_x_user_id, owner_user_id, statement_id, relation, intake) values ($1, $2, $3, 'following', 'mention')`, [alice.id, owner.id, st.id]);
  }
  const r = await checkSources(s.db, s.x);
  assert.equal(r.gone.length, 101);
  assert.equal(r.backlog, 0);
  assert.equal((await one(`select count(*)::int as n from sources where text = 'CAP-TEST text'`)).n, 0);
});

test('M12 (F19): one post has one statement, and an edit to it cannot abort the source check', async () => {
  await s.db.query('update sources set checked_at = now()');
  const h = s.fakeX.addUser('730', 'hank');
  const inline = s.fakeX.post(h.id, `The Lakers will win the title by the end of ${NEXT} @statedbot`);
  s.fakeX.post(alice.id, '@statedbot', { replyTo: inline.id });
  await tick(s.db, allText, s.x);
  const count = (await one(`select count(*)::int as n from statements st join sources src on src.id = st.source_id where src.platform_id = $1`, [inline.id])).n;
  assert.equal(count, 1, 'the inline and reply paths share one statement');
  const other = s.fakeX.post(bob.id, `Copper will hit $6 by the end of ${NEXT}.`);
  s.fakeX.post(carol.id, '@statedbot', { replyTo: other.id });
  await tick(s.db, allText, s.x);
  await s.db.query('update sources set checked_at = null where platform_id in ($1, $2)', [inline.id, other.id]);
  s.fakeX.edit(inline.id, `The Lakers will win the title by the end of ${NEXT + 1} @statedbot`);
  s.fakeX.deleted.add(other.id);
  const result = await checkSources(s.db, s.x);
  assert.deepEqual(result.errors, []);
  assert.equal((await one('select available from sources where platform_id = $1', [other.id])).available, false, 'the deletion in the same run is applied');
  const st = await one(`select st.span, st.proposed_deadline_at from statements st join sources src on src.id = st.source_id where src.platform_id = $1`, [inline.id]);
  assert.equal(st.span, `The Lakers will win the title by the end of ${NEXT + 1}`);
  assert.equal(new Date(st.proposed_deadline_at).getUTCFullYear(), NEXT + 1, 'the terms are read again from the edited post');
});

test('M3 (F20): records published after their outcome are listed but not counted in the public record', async () => {
  const k = s.fakeX.addUser('740', 'kim');
  const hit = s.fakeX.post(k.id, `Copper will top $5 by the end of ${NEXT}, 90% chance.`);
  const miss = s.fakeX.post(k.id, `Nickel will top $30k by the end of ${NEXT}, 90% chance.`);
  const t1 = s.fakeX.post(k.id, '@statedbot', { replyTo: hit.id });
  const t2 = s.fakeX.post(k.id, '@statedbot', { replyTo: miss.id });
  await tick(s.db, s.config, s.x);
  const s1 = await saveFor(t1.id);
  const s2 = await saveFor(t2.id);
  const kb = await s.signIn(k);
  await kb.submit('/setup', { profile: 'private', defaults: 'private' });
  const today = new Date().toISOString().slice(0, 10);
  await adminB.submit(`/admin/resolve/${s1.statement_id}`, { outcome: 'yes', url: 'https://example.com/cu', note: 'Hit.', known: today }, { from: '/admin' });
  await adminB.submit(`/admin/resolve/${s2.statement_id}`, { outcome: 'no', url: 'https://example.com/ni', note: 'Missed.', known: today }, { from: '/admin' });
  await kb.submit('/me/settings', { profile: 'public', defaults: 'private' });
  await kb.submit('/me/settings/publish', [['confirm', '1'], ['publish', String(s1.id)], ['defaults', 'private']]);
  const rec = JSON.parse((await anon.get('/api/u/kim')).text).record;
  assert.equal(rec.resolved, 0);
  assert.equal(rec.publishedLate, 1);
  assert.equal(rec.scored, 0);
  assert.match((await anon.get(`/u/kim/${s1.id}`)).text, /Published after its deadline or outcome/);
  assert.equal((await record(kb)).resolved, 2, 'the owner’s own record still counts both');
});
