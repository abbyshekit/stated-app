// A prediction through revision, correction and evidence-backed resolution;
// what is scored and what is not; updates; and posts that change on X.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { checkSources, deliverDms, scanDeadlines } from '../src/notify.mjs';
import { recordOf } from '../src/store.mjs';
import { tick } from '../src/worker.mjs';
import { ADMIN_X_ID, Browser, startStack } from './support/app.mjs';

const NEXT = new Date().getUTCFullYear() + 1;
const LAST = new Date().getUTCFullYear() - 1;
let s;
let alice;
let bob;
let carol;
let dave;
let aliceB;
let carolB;
let bobB;
let adminB;
let anon;
let ids = {};

async function one(sql, params = []) {
  return s.db.one(sql, params);
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
  const p1 = s.fakeX.post(alice.id, `Bitcoin will close above $150k by the end of ${NEXT}, 60% chance.`);
  const old = s.fakeX.post(alice.id, `The merger will close by the end of ${LAST}.`);
  s.fakeX.post(alice.id, '@statedbot', { replyTo: p1.id });
  s.fakeX.post(carol.id, '@statedbot', { replyTo: p1.id });
  s.fakeX.post(alice.id, '@statedbot', { replyTo: old.id });
  await tick(s.db, s.config, s.x);
  ids.p1 = p1.id;
  const byPost = `select s.id from saves s join statements st on st.id = s.statement_id
    join sources src on src.id = st.source_id where s.owner_x_user_id = $1 and src.platform_id = $2`;
  ids.alice = (await one(byPost, [alice.id, p1.id])).id;
  ids.carol = (await one('select id from saves where owner_x_user_id = $1', [carol.id])).id;
  ids.old = (await one(byPost, [alice.id, old.id])).id;
  ids.statement = (await one('select statement_id from saves where id = $1', [ids.alice])).statement_id;
  aliceB = await s.signIn(alice);
  await aliceB.submit('/setup', { profile: 'private', defaults: 'private' });
  carolB = await s.signIn(carol);
  await carolB.submit('/me/settings/publish', [['confirm', '1'], ['publish', String(ids.carol)], ['defaults', 'private']], { from: '/setup' });
  bobB = await s.signIn(bob);
  await bobB.submit('/setup', { profile: 'private', defaults: 'private' });
  adminB = await s.signIn({ id: ADMIN_X_ID });
  await adminB.submit('/setup', { profile: 'private', defaults: 'private' });
  anon = new Browser(s.base);
});

after(() => s.close());

test('the author confirms and then revises the terms; both versions stay in the history', async () => {
  const page = await aliceB.get(`/me/s/${ids.alice}`);
  assert.match(page.text, /Confirm what you meant/);
  assert.match(page.text, /as Dec 31, \d{4}\. Not confirmed\./);
  await aliceB.submit(`/me/saves/${ids.alice}/terms`, { deadline: `${NEXT}-12-31`, probability: '60', condition: '', note: 'As posted', back: `/me/s/${ids.alice}` });
  const revised = await aliceB.submit(`/me/saves/${ids.alice}/terms`, { deadline: `${NEXT}-12-31`, probability: '65', condition: '', note: 'I meant 65', back: `/me/s/${ids.alice}` });
  assert.match(revised.text, /confirmed by the author/);
  assert.match(revised.text, /65%/);
  const history = await s.db.many(`select kind, before, after, note from revisions
    where statement_id = $1 and (save_id is null or save_id = $2) order by id`, [ids.statement, ids.alice]);
  assert.deepEqual(history.map((h) => h.kind), ['captured', 'author_terms', 'author_terms']);
  assert.equal(history[2].before.probability, 0.6);
  assert.equal(history[2].after.probability, 0.65);
  assert.match(revised.text, /I meant 65/);
});

test('the author’s private confirmation does not show on someone else’s public copy', async () => {
  const page = await anon.get(`/u/carol/${ids.carol}`);
  assert.equal(page.status, 200);
  // An encoded origin ending in port 65 produces "65%2F" without a private probability.
  const publicHtml = page.text.replaceAll(encodeURIComponent(s.base), encodeURIComponent('http://stated.test'));
  assert.doesNotMatch(publicHtml, /confirmed by the author|65%|I meant 65/);
  assert.match(page.text, /60%/, 'the reader sees what the post states');
  const api = JSON.parse((await anon.get(`/api/u/carol/${ids.carol}`)).text);
  assert.ok(api.history.every((h) => h.kind !== 'author_terms'));
});

test('only the author can confirm terms; a follower gets a reminder date instead', async () => {
  const refused = await carolB.submit(`/me/saves/${ids.carol}/terms`, { deadline: `${NEXT}-01-01`, probability: '10' });
  assert.equal(refused.status, 403);
  assert.match(refused.text, /Only the author can confirm/);
});

test('a reader’s correction goes to review and the accepted reading is public, with history', async () => {
  const form = await bobB.get(`/u/carol/${ids.carol}`);
  assert.match(form.text, /Request a correction/);
  const sent = await bobB.submit('/corrections', {
    statement: String(ids.statement), kind: 'interpretation',
    body: 'The post means the daily close, so the deadline is the last trading day.',
    evidence: 'https://example.com/close-rules', back: `/u/carol/${ids.carol}`,
  });
  assert.match(sent.text, /Sent to review/);
  const queue = await adminB.get('/admin');
  assert.match(queue.text, /Correction requests \(1\)/);
  assert.doesNotMatch(queue.text, /bob/i, 'reviewers do not see who asked');
  const correction = await one(`select id from correction_requests where status = 'open'`);
  await adminB.submit(`/admin/terms/${ids.statement}`, {
    correction: String(correction.id), deadline: `${NEXT}-12-30`, probability: '', condition: '', note: 'Last trading day',
  }, { from: '/admin' });
  assert.equal((await one('select status from correction_requests where id = $1', [correction.id])).status, 'accepted');
  const page = await anon.get(`/u/carol/${ids.carol}`);
  assert.match(page.text, /confirmed in review/);
  assert.match(page.text, /Terms corrected in review/);
  assert.match(page.text, /Last trading day/);
});

test('an evidence-backed outcome scores the author’s prediction and not the follower', async () => {
  await adminB.submit(`/admin/resolve/${ids.statement}`, {
    outcome: 'yes', url: 'https://example.com/btc-close', note: `Closed above $150k on Dec 30, ${NEXT}.`, known: new Date().toISOString().slice(0, 10),
  }, { from: '/admin' });
  const mine = JSON.parse((await aliceB.get('/api/me')).text);
  assert.equal(mine.record.resolved, 1);
  assert.equal(mine.record.cameTrue, 1);
  assert.equal(mine.record.scored, 1);
  assert.ok(Math.abs(mine.record.averageBaseline - 26.30) < 0.1, 'scored from the 60% the post stated, not the 65% added later');
  const carols = JSON.parse((await carolB.get('/api/me')).text);
  assert.equal(carols.record.predictions, 0);
  assert.equal(carols.following[0].scored, false);
  const inbox = await s.db.many(`select owner_x_user_id, body from inbox where kind = 'outcome' order by id`);
  assert.match(inbox.find((i) => i.owner_x_user_id === alice.id).body, /counts toward your record/);
  assert.match(inbox.find((i) => i.owner_x_user_id === carol.id).body, /does not count toward your score/);
  const page = await anon.get(`/u/carol/${ids.carol}`);
  assert.match(page.text, /Came true/);
  assert.match(page.text, /https:\/\/example\.com\/btc-close/);
});

test('a changed or disputed outcome keeps the earlier one in the history and stops scoring', async () => {
  await adminB.submit(`/admin/resolve/${ids.statement}`, { outcome: 'no', url: 'https://example.com/revised', note: 'The exchange revised the close.', known: new Date().toISOString().slice(0, 10) }, { from: '/admin' });
  await adminB.submit(`/admin/resolve/${ids.statement}`, { outcome: 'disputed', url: '', note: 'Two exchanges disagree.' }, { from: '/admin' });
  const kinds = (await s.db.many('select kind, before from revisions where statement_id = $1 order by id', [ids.statement])).map((r) => r.kind);
  assert.deepEqual(kinds.slice(-3), ['resolved', 'resolution_changed', 'disputed']);
  const mine = JSON.parse((await aliceB.get('/api/me')).text).record;
  assert.equal(mine.scored, 0);
  assert.equal(mine.unscorable, 1);
  const page = await anon.get(`/u/carol/${ids.carol}`);
  assert.match(page.text, /Outcome changed/);
  assert.match(page.text, /Outcome disputed/);
});

test('a prediction saved after its deadline is backfill: labelled, listed and never scored', async () => {
  const save = await one('select capture from saves where id = $1', [ids.old]);
  assert.equal(save.capture, 'backfill');
  const statement = await one('select statement_id from saves where id = $1', [ids.old]);
  await adminB.submit(`/admin/resolve/${statement.statement_id}`, { outcome: 'yes', url: 'https://example.com/merger', note: 'Closed.', known: new Date().toISOString().slice(0, 10) }, { from: '/admin' });
  const record = JSON.parse((await aliceB.get('/api/me')).text).record;
  assert.equal(record.backfill, 1);
  assert.equal(record.resolved, 0, 'the backfilled hit is not counted');
  const page = await aliceB.get(`/me/s/${ids.old}`);
  assert.match(page.text, /Backfill/);
  assert.match(page.text, /never scored as a forecast/);
});

test('saving your own post after its outcome is recorded is backfill too', async () => {
  const p = s.fakeX.post(dave.id, `Tesla will ship robotaxis by the end of ${NEXT}.`);
  s.fakeX.post(bob.id, '@statedbot', { replyTo: p.id });
  await tick(s.db, s.config, s.x);
  const st = await one(`select st.id from statements st join sources src on src.id = st.source_id where src.platform_id = $1`, [p.id]);
  await adminB.submit(`/admin/resolve/${st.id}`, { outcome: 'yes', url: 'https://example.com/robotaxi', note: 'Shipped.', known: new Date().toISOString().slice(0, 10) }, { from: '/admin' });
  s.fakeX.post(dave.id, '@statedbot', { replyTo: p.id });
  await tick(s.db, s.config, s.x);
  const daves = await one(`select relation, capture from saves where owner_x_user_id = $1`, [dave.id]);
  assert.equal(daves.relation, 'mine');
  assert.equal(daves.capture, 'backfill');
  const rows = await s.db.many(`select s.relation, s.capture as save_capture, st.capture as statement_capture, st.status, st.probability,
      s.author_confirmed_at, s.author_probability, st.reviewed_probability from saves s join statements st on st.id = s.statement_id
      where s.owner_x_user_id = $1`, [dave.id]);
  assert.equal(recordOf(rows).resolved, 0);
});

test('deadline updates reach the inbox; a DM goes only to someone who wrote first; nothing is posted', async () => {
  const p = s.fakeX.post(bob.id, `Unemployment will reach 5% by the end of ${NEXT}.`);
  s.fakeX.post(carol.id, '@statedbot', { replyTo: p.id });
  s.fakeX.post(alice.id, '@statedbot', { replyTo: p.id });
  await tick(s.db, s.config, s.x);
  await s.db.query(`update users set dm_updates = true where x_user_id in ($1, $2)`, [alice.id, carol.id]);
  await s.db.query(`insert into dm_events (event_id, sender_x_user_id, outcome) values ('dm-from-carol', $1, 'no_link')`, [carol.id]);
  const posts = s.fakeX.created.length;
  const created = await scanDeadlines(s.db, new Date(Date.UTC(NEXT, 11, 30)));
  const owners = new Set(created.map((c) => c.owner_x_user_id));
  assert.ok(owners.has(alice.id) && owners.has(carol.id));
  assert.ok(created.every((c) => /within two days/.test(c.body)));
  assert.equal((await scanDeadlines(s.db, new Date(Date.UTC(NEXT, 11, 30)))).length, 0, 'one update per window');

  const dm = { ...s.config, x: { ...s.config.x, dmEnabled: true } };
  s.fakeX.failDms = true;
  const failed = await deliverDms(s.db, s.x, dm);
  const statusOf = async (owner) => (await one(`select dm_status, dm_error, done_at from inbox where kind = 'deadline' and owner_x_user_id = $1 order by id desc limit 1`, [owner]));
  assert.ok(failed.length >= 2);
  assert.equal((await statusOf(carol.id)).dm_status, 'failed');
  assert.equal((await statusOf(carol.id)).done_at, null, 'a failed DM stays in the inbox');
  assert.equal((await statusOf(alice.id)).dm_status, 'unavailable', 'Alice never wrote to the bot');
  assert.equal(s.fakeX.created.length, posts, 'no public fallback');
  const inbox = await carolB.get('/me/inbox');
  assert.match(inbox.text, /The direct message failed\. This copy is kept here\./);
});

test('a deleted post loses its stored text and its public page; an edit shows the current text', async () => {
  await s.db.query(`update sources set checked_at = null`);
  const edited = s.fakeX.post(bob.id, `Apple will ship glasses by the end of ${NEXT}.`);
  s.fakeX.post(carol.id, '@statedbot', { replyTo: edited.id });
  await tick(s.db, s.config, s.x);
  const carolEdited = (await one(`select s.id from saves s join statements st on st.id = s.statement_id
    join sources src on src.id = st.source_id where s.owner_x_user_id = $1 and src.platform_id = $2`, [carol.id, edited.id])).id;
  await carolB.submit(`/me/saves/${carolEdited}/visibility`, { visibility: 'public', back: '/me' });
  await tick(s.db, s.config, s.x);
  assert.match((await one(`select text from sources where platform_id = $1`, [edited.id])).text, /Apple will ship glasses/, 'publishing stores the words');
  await s.db.query(`update sources set checked_at = null`);
  s.fakeX.edit(edited.id, `Apple will ship glasses by the end of ${NEXT + 1}.`);
  s.fakeX.deleted.add(ids.p1);
  const result = await checkSources(s.db, s.x);
  assert.equal(result.gone.length, 1);
  assert.equal(result.edited.length, 1);
  const source = await one(`select text, available from sources where platform_id = $1`, [ids.p1]);
  assert.equal(source.text, '');
  assert.equal(source.available, false);
  const page = await anon.request('GET', `/u/carol/${ids.carol}`);
  assert.equal(page.status, 404, 'the save went private');
  const own = await carolB.get(`/me/s/${ids.carol}`);
  assert.doesNotMatch(own.text, /Bitcoin will close above/);
  assert.match(own.text, /no longer available on X/);
  const span = await one(`select st.span from statements st join sources src on src.id = st.source_id where src.platform_id = $1`, [edited.id]);
  assert.match(span.span, new RegExp(`${NEXT + 1}`));
});
