// Gaps from .review/final-findings.md, asserted as the fixed behaviour.
// Real server, throwaway Postgres, fake X. No network.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { runCompliance } from '../src/compliance.mjs';
import { tick } from '../src/worker.mjs';
import { ADMIN_X_ID, Browser, startStack } from './support/app.mjs';

const NEXT = new Date().getUTCFullYear() + 1;
const DAY = 86_400_000;
let s;
let carol;
let adminB;
let anon;

const one = (sql, p = []) => s.db.one(sql, p);
const saveFor = async (eventId) => one('select * from saves where origin_event_id = $1', [eventId]);
const dateOnly = (ms) => new Date(ms).toISOString().slice(0, 10);
const publicRecord = async (name) => JSON.parse((await anon.get(`/api/u/${name}`)).text).record;

async function person(id, name, { profile = 'private', defaults = 'private' } = {}) {
  const u = s.fakeX.addUser(id, name);
  const b = await s.signIn(u);
  if (profile === 'public') await b.submit('/me/settings/publish', [['confirm', '1'], ['defaults', defaults]], { from: '/setup' });
  else await b.submit('/setup', { profile: 'private', defaults: 'private' });
  return { u, b };
}

before(async () => {
  s = await startStack();
  const bot = s.fakeX.addUser('500', 'statedbot');
  carol = s.fakeX.addUser('300', 'carol');
  s.fakeX.addUser(ADMIN_X_ID, 'reviewer');
  await s.connectBot(bot);
  adminB = await s.signIn({ id: ADMIN_X_ID });
  await adminB.submit('/setup', { profile: 'private', defaults: 'private' });
  anon = new Browser(s.base);
});

after(async () => {
  await s.close();
});

test('A2: removing a prediction and saving the post again keeps the committed deadline', async () => {
  const { u: ana, b: ab } = await person('201', 'ana');
  const p = s.fakeX.post(ana.id, 'Ether will reach $10k.');
  const tag = s.fakeX.post(ana.id, '@statedbot', { replyTo: p.id });
  await tick(s.db, s.config, s.x);
  const s1 = await saveFor(tag.id);
  assert.equal((await ab.submit(`/me/saves/${s1.id}/terms`, { deadline: dateOnly(Date.now() + 2 * DAY), probability: '', condition: '', back: `/me/s/${s1.id}` })).status, 200);
  await s.db.query(`update saves set author_committed_deadline_at = now() - interval '1 day', author_deadline_at = now() - interval '1 day' where id = $1`, [s1.id]);
  await s.db.query(
    `update author_commitments set committed_deadline_at = now() - interval '1 day', deadline_at = now() - interval '1 day' where statement_id = $1`,
    [s1.statement_id],
  );
  assert.equal((await ab.submit(`/me/saves/${s1.id}/terms`, { deadline: `${NEXT + 5}-06-30`, probability: '', condition: '', back: `/me/s/${s1.id}` })).status, 400);
  await ab.submit(`/me/saves/${s1.id}/remove`, { back: '/me' }, { from: `/me/s/${s1.id}` });
  const re = await ab.submit('/me/track', { url: `https://x.com/ana/status/${p.id}` }, { from: '/me/track' });
  const s2 = re.url.match(/\/me\/s\/(\d+)/)[1];
  assert.equal((await ab.submit(`/me/saves/${s2}/terms`, { deadline: `${NEXT + 5}-06-30`, probability: '', condition: '', back: `/me/s/${s2}` })).status, 400, 'the old deadline still locks the new save');
  const kept = await one('select committed_deadline_at from author_commitments where owner_x_user_id = $1', [ana.id]);
  assert.ok(kept.committed_deadline_at);
  assert.ok(new Date(kept.committed_deadline_at).getTime() < Date.now());
});

test('A1: withdrawing resolved misses stays in the public counts, without the claims', async () => {
  const { u: bea, b: bb } = await person('202', 'bea', { profile: 'public', defaults: 'public' });
  const posts = ['Copper will top $5', 'Nickel will top $30k', 'Zinc will top $4k'].map((t) => s.fakeX.post(bea.id, `${t} by the end of ${NEXT}, 90% chance.`));
  const tags = posts.map((p) => s.fakeX.post(bea.id, '@statedbot', { replyTo: p.id }));
  await tick(s.db, s.config, s.x);
  const saves = await Promise.all(tags.map((t) => saveFor(t.id)));
  await s.db.query(`update saves set created_at = now() - interval '30 days', first_public_at = now() - interval '30 days' where id = any($1::bigint[])`, [saves.map((sv) => sv.id)]);
  const today = dateOnly(Date.now());
  const outcomes = ['yes', 'no', 'no'];
  for (let i = 0; i < saves.length; i += 1) {
    await adminB.submit(`/admin/resolve/${saves[i].statement_id}`, { outcome: outcomes[i], url: `https://example.com/m${i}`, note: 'Recorded.', known: today }, { from: '/admin' });
  }
  const before = await publicRecord('bea');
  assert.deepEqual([before.resolved, before.cameTrue, before.didNot], [3, 1, 2]);
  await bb.submit(`/me/saves/${saves[1].id}/visibility`, { visibility: 'private', back: '/me' }, { from: '/me' });
  await bb.submit(`/me/saves/${saves[2].id}/remove`, { back: '/me' }, { from: '/me' });
  const after = await publicRecord('bea');
  assert.equal(after.cameTrue, 1);
  assert.equal(after.didNot, 2, 'the withdrawn misses stay in the counts');
  assert.equal(after.withdrawnAfterOutcome, 2);
  const page = (await anon.get('/u/bea')).text;
  assert.match(page, /2 public predictions were withdrawn after the outcome was known/);
  assert.doesNotMatch(page, /Nickel will top|Zinc will top/);
});

test('A3: a minted visitor cookie does not count, and ?r= on sign-in does not set attribution', async () => {
  const metric = async () => JSON.parse((await adminB.get('/admin/metrics.json')).text);
  const before = await metric();
  for (let i = 0; i < 5; i += 1) {
    const res = await fetch(`${s.base}/static/stated.css`, {
      headers: { cookie: `stated_vid=minted-${i}`, referer: `${s.base}/?r=reply`, 'user-agent': 'Mozilla/5.0' },
    });
    await res.text();
  }
  assert.equal((await metric()).visits.fromReply, before.visits.fromReply);
  const newbie = s.fakeX.addUser('209', 'newbie');
  const b = new Browser(s.base);
  s.fakeX.consentAs = newbie.id;
  await b.follow('/signin/x?r=reply');
  s.fakeX.consentAs = null;
  assert.equal((await one(`select acquired_via from users where x_user_id = '209'`)).acquired_via, null);
});

test('batch compliance deletes a removed post and falls back when the app is not enrolled', async () => {
  const { u: gus, b: gb } = await person('210', 'gus');
  const p = s.fakeX.post(gus.id, `Barley will top $7 by the end of ${NEXT}.`);
  const tag = s.fakeX.post(gus.id, '@statedbot', { replyTo: p.id });
  await tick(s.db, s.config, s.x);
  const save = await saveFor(tag.id);
  s.fakeX.deleted.add(p.id);
  const config = { ...s.config, x: { ...s.config.x, complianceBearer: 'app-bearer' } };
  const first = await runCompliance(s.db, config);
  assert.equal(first.mode, 'batch');
  assert.equal(first.erased, 1);
  const source = await one('select platform_id, url, author_username, available from sources where id = (select source_id from statements where id = $1)', [save.statement_id]);
  assert.equal(source.available, false);
  assert.match(source.platform_id, /^removed-/);
  assert.equal(source.author_username, null);
  assert.equal(source.url, '');
  const again = await runCompliance(s.db, config);
  assert.equal(again.erased, 0, 'a second run does not erase again');
  s.fakeX.compliance403 = true;
  const fallback = await runCompliance(s.db, config);
  assert.equal(fallback.mode, 'fallback');
  const beforeReads = s.fakeX.calls.filter((c) => c.path === '/2/tweets').length;
  await tick(s.db, config, s.x, { sourceCheck: true });
  const lookup = s.fakeX.calls.filter((c) => c.path === '/2/tweets').slice(beforeReads);
  assert.ok(lookup.length > 0, 'the weekly lookup runs when batch compliance is refused');
  assert.equal(lookup[0].query.expansions, undefined, 'the fallback lookup does not expand authors');
  assert.match(lookup[0].query['tweet.fields'], /author_id/);
  await gb.get('/me');
});

test('A4: a reviewed deadline before the save is backfill even after the author named a later one', async () => {
  const { u: ada, b: ab } = await person('211', 'ada');
  const { u: fred } = await person('212', 'fred');
  const p = s.fakeX.post(ada.id, 'Tin will top $40k.');
  const own = s.fakeX.post(ada.id, '@statedbot', { replyTo: p.id });
  s.fakeX.post(fred.id, '@statedbot', { replyTo: p.id });
  await tick(s.db, s.config, s.x);
  const mine = await saveFor(own.id);
  await ab.submit(`/me/saves/${mine.id}/terms`, { deadline: `${NEXT}-12-31`, probability: '', condition: '', back: `/me/s/${mine.id}` });
  const last = new Date().getUTCFullYear() - 1;
  await adminB.submit(`/admin/terms/${mine.statement_id}`, { deadline: `${last}-01-31`, probability: '', condition: '', note: 'It was last January' }, { from: '/admin' });
  const rows = await s.db.many('select relation, capture from saves where statement_id = $1 order by relation', [mine.statement_id]);
  assert.deepEqual(rows.map((r) => r.capture), ['backfill', 'backfill']);
});

test('A6: a public post X says is gone is not read again on the next tick', async () => {
  const { u } = await person('213', 'ned', { profile: 'public', defaults: 'public' });
  const p = s.fakeX.post(u.id, `Rye will top $8 by the end of ${NEXT}.`);
  const tag = s.fakeX.post(u.id, '@statedbot', { replyTo: p.id });
  await tick(s.db, s.config, s.x);
  const save = await saveFor(tag.id);
  await s.db.query(`update sources set text = '' where platform_id = $1`, [p.id]);
  await s.db.query(`update statements set span = 'X post ' || $1 where id = $2`, [p.id, save.statement_id]);
  s.fakeX.deleted.add(p.id);
  const readsOf = () => s.fakeX.calls.filter((c) => c.path === '/2/tweets' && String(c.query.ids || '').split(',').includes(p.id));
  const before = readsOf().length;
  await tick(s.db, s.config, s.x);
  await tick(s.db, s.config, s.x);
  await tick(s.db, s.config, s.x);
  assert.equal(readsOf().length - before, 1, 'marked gone after one read');
  assert.equal((await one('select available from sources where platform_id = $1', [p.id])).available, false);
});

test('A5: the outcome date is empty until a reviewer enters it', async () => {
  const page = (await adminB.get('/admin')).text;
  assert.match(page, /name="known" required/);
  assert.doesNotMatch(page, /name="known"[^>]*value=/);
});
