// Privacy across every surface: pages, JSON API, search, exports, previews,
// aggregate statistics and the home feed, for the owner, another signed-in
// user and an anonymous reader. Annotations never leave the owner.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { resolveStatement } from '../src/notify.mjs';
import { tick } from '../src/worker.mjs';
import { ADMIN_X_ID, Browser, startStack } from './support/app.mjs';

const YEAR = new Date().getUTCFullYear() + 1;
const NOTE = 'SECRET-NOTE-7731';
let s;
let alice;
let bob;
let carol;
let ownerB;
let otherB;
let anon;
let ids;

async function saveId(sql, params) {
  return (await s.db.one(sql, params)).id;
}

// Every place a reader could find Alice's records without being Alice.
function surfaces() {
  return [
    ['profile page', '/u/alice'],
    ['saved prediction page', `/u/alice/${ids.mine}`],
    ['followed claim page', `/u/alice/${ids.follow}`],
    ['private prediction page', `/u/alice/${ids.privateMine}`],
    ['profile API', '/api/u/alice'],
    ['prediction API', `/api/u/alice/${ids.mine}`],
    ['followed claim API', `/api/u/alice/${ids.follow}`],
    ['private prediction API', `/api/u/alice/${ids.privateMine}`],
    ['public export', '/api/u/alice/export.json'],
    ['search page', '/search?q=Bitcoin'],
    ['search API', '/api/search?q=Bitcoin'],
    ['search API for the followed claim', '/api/search?q=Fed'],
    ['home page', '/'],
  ];
}

async function readAll(browser) {
  const out = {};
  for (const [name, path] of surfaces()) out[name] = await browser.request('GET', path, { headers: { 'user-agent': 'Twitterbot/1.0' } });
  return out;
}

before(async () => {
  s = await startStack();
  const bot = s.fakeX.addUser('500', 'statedbot');
  alice = s.fakeX.addUser('100', 'alice');
  bob = s.fakeX.addUser('200', 'bob');
  carol = s.fakeX.addUser('300', 'carol');
  s.fakeX.addUser(ADMIN_X_ID, 'reviewer');
  await s.connectBot(bot);
  const p1 = s.fakeX.post(alice.id, `Bitcoin will close above $150k by the end of ${YEAR}, 70% chance.`);
  const p2 = s.fakeX.post(bob.id, `The Fed will raise rates at the December 9, ${YEAR} meeting, 70% chance.`);
  const p3 = s.fakeX.post(alice.id, `Ethereum will flip Bitcoin by the end of ${YEAR}.`);
  s.fakeX.post(alice.id, '@statedbot', { replyTo: p1.id });
  s.fakeX.post(alice.id, '@statedbot', { replyTo: p2.id });
  s.fakeX.post(alice.id, '@statedbot', { replyTo: p3.id });
  s.fakeX.post(carol.id, '@statedbot', { replyTo: p2.id });
  await tick(s.db, s.config, s.x);
  const byPost = `select s.id from saves s join statements st on st.id = s.statement_id
    join sources src on src.id = st.source_id where s.owner_x_user_id = $1 and src.platform_id = $2`;
  ids = {
    mine: await saveId(byPost, [alice.id, p1.id]),
    privateMine: await saveId(byPost, [alice.id, p3.id]),
    follow: await saveId(`select id from saves where owner_x_user_id = $1 and relation = 'following'`, [alice.id]),
    carolFollow: await saveId(`select id from saves where owner_x_user_id = $1`, [carol.id]),
  };
  ownerB = await s.signIn(alice);
  await ownerB.submit('/setup', { profile: 'private', defaults: 'private' });
  await ownerB.submit(`/me/saves/${ids.mine}/note`, { note: NOTE, back: `/me/s/${ids.mine}` });
  await ownerB.submit(`/me/saves/${ids.follow}/note`, { note: NOTE, back: '/me' });
  otherB = await s.signIn(bob);
  await otherB.submit('/setup', { profile: 'private', defaults: 'private' });
  anon = new Browser(s.base);
});

after(() => s.close());

test('a private profile: the owner sees everything, another user and an anonymous reader see nothing', async () => {
  const own = await ownerB.get(`/me/s/${ids.mine}`);
  assert.equal(own.status, 200);
  assert.doesNotMatch(own.text, /Bitcoin will close above/, 'the words are not fetched until the owner asks');
  const shown = await ownerB.get(`/me/s/${ids.mine}?words=1`);
  assert.match(shown.text, /Bitcoin will close above/, 'the owner reads the post, shown from X on request');
  assert.match(shown.text, /Stated does not store these words/);
  assert.match(own.text, new RegExp(NOTE));
  const stored = await s.db.many(`select src.text, st.span from sources src join statements st on st.source_id = src.id where src.platform = 'x'`);
  assert.ok(stored.every((r) => r.text === '' && /^X post \d+$/.test(r.span)), 'no words of a privately saved post are stored');
  const api = JSON.parse((await ownerB.get('/api/me')).text);
  assert.equal(api.predictions.length, 2);
  assert.equal(api.following.length, 1);
  assert.equal(api.predictions.find((p) => p.id === ids.mine).annotation, NOTE);
  const exported = JSON.parse((await ownerB.get('/me/export.json')).text);
  assert.equal(exported.saves.length, 3);
  assert.ok(exported.saves.some((x) => x.annotation === NOTE));

  for (const [who, browser] of [['anonymous', anon], ['another user', otherB]]) {
    const pages = await readAll(browser);
    for (const [name, res] of Object.entries(pages)) {
      assert.doesNotMatch(res.text, new RegExp(NOTE), `${who}: ${name} leaked the note`);
      assert.doesNotMatch(res.text, /Bitcoin will close above|The Fed will raise/, `${who}: ${name} leaked a private record`);
      assert.doesNotMatch(res.text, /og:title/, `${who}: ${name} has a preview`);
    }
    assert.equal(pages['profile page'].status, 404);
    assert.equal(pages['profile API'].status, 404);
    assert.equal(pages['public export'].status, 404);
    assert.deepEqual(JSON.parse(pages['search API'].text).results, []);
  }
  assert.equal((await otherB.request('GET', `/me/s/${ids.mine}`)).status, 404);
  assert.equal(JSON.parse((await otherB.get('/api/me')).text).predictions.length, 0);
  const tamper = await otherB.submit(`/me/saves/${ids.mine}/note`, { note: 'overwritten' });
  assert.equal(tamper.status, 404);
  assert.equal((await s.db.one('select annotation from saves where id = $1', [ids.mine])).annotation, NOTE);
  assert.equal((await anon.request('GET', '/api/me')).status, 401);
  assert.equal((await anon.request('GET', '/me/export.json')).status, 401);
  assert.equal((await anon.request('GET', `/me/s/${ids.mine}`)).status, 303);
});

test('going public asks which saves to publish, and publishes only those', async () => {
  const ask = await ownerB.submit('/me/settings', { profile: 'public', defaults: 'private' });
  assert.match(ask.url, /\/me\/settings\/publish/);
  assert.match(ask.text, /Choose what to publish/);
  assert.equal((await anon.request('GET', '/u/alice')).status, 404, 'nothing is public until the selection is confirmed');
  assert.doesNotMatch(ask.text, /name="publish" value="\d+" checked/, 'nothing is pre-ticked');

  await ownerB.submit('/me/settings/publish', [['confirm', '1'], ['publish', String(ids.mine)], ['defaults', 'private']]);
  await tick(s.db, s.config, s.x);
  const words = await s.db.many(`select platform_id from sources where platform = 'x' and text <> ''`);
  assert.deepEqual(words.map((w) => w.platform_id), [(await s.db.one(`select src.platform_id from saves s join statements st on st.id = s.statement_id join sources src on src.id = st.source_id where s.id = $1`, [ids.mine])).platform_id], 'only the published post’s words are stored');
  const pages = await readAll(anon);
  assert.equal(pages['profile page'].status, 200);
  assert.match(pages['profile page'].text, /Bitcoin will close above/);
  assert.doesNotMatch(pages['profile page'].text, /The Fed will raise|Ethereum will flip/);
  assert.match(pages['profile page'].text, /og:title/);
  assert.equal(pages['saved prediction page'].status, 200);
  assert.equal(pages['followed claim page'].status, 404);
  assert.equal(pages['private prediction page'].status, 404);
  assert.equal(pages['private prediction API'].status, 404);
  const profile = JSON.parse(pages['profile API'].text);
  assert.equal(profile.predictions.length, 1);
  assert.equal(profile.following.length, 0);
  assert.equal(profile.record.predictions, 1, 'statistics count public entries only');
  assert.equal(JSON.parse(pages['search API'].text).results.length, 1);
  assert.deepEqual(JSON.parse(pages['search API for the followed claim'].text).results, []);
  const exported = JSON.parse(pages['public export'].text);
  assert.equal(exported.saves.length, 1);
  assert.equal('annotation' in exported.saves[0], false);
  assert.match(pages['home page'].text, /Bitcoin will close above/);
  for (const [name, res] of Object.entries(pages)) {
    assert.doesNotMatch(res.text, new RegExp(NOTE), `${name} leaked the note`);
    assert.doesNotMatch(res.text, /Ethereum will flip/, `${name} leaked a private prediction`);
  }
});

test('a public profile can hold private saves, and counts only public followers', async () => {
  await ownerB.submit(`/me/saves/${ids.follow}/visibility`, { visibility: 'public' });
  await tick(s.db, s.config, s.x);
  const page = await anon.get(`/u/alice/${ids.follow}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /The Fed will raise/);
  assert.match(page.text, /1 public profile follows this claim/, 'Carol follows privately and is not counted');
  assert.doesNotMatch(page.text, /carol/i);
  assert.doesNotMatch(page.text, new RegExp(NOTE));
  const api = JSON.parse((await anon.get(`/api/u/alice/${ids.follow}`)).text);
  assert.equal(api.publicFollowers, 1);
  assert.equal(api.annotation, undefined);
  await ownerB.submit(`/me/saves/${ids.follow}/visibility`, { visibility: 'private' });
  assert.equal((await anon.request('GET', `/u/alice/${ids.follow}`)).status, 404);
});

test('statistics on a public profile ignore private predictions even once they resolve', async () => {
  const reviewer = { id: null };
  const statement = async (id) => (await s.db.one('select statement_id from saves where id = $1', [id])).statement_id;
  const known = new Date();
  await resolveStatement(s.db, { statementId: await statement(ids.privateMine), outcome: 'yes', note: 'Test resolution', url: 'https://example.com/a', reviewer, outcomeAt: known });
  await resolveStatement(s.db, { statementId: await statement(ids.mine), outcome: 'no', note: 'Test resolution', url: 'https://example.com/b', reviewer, outcomeAt: known });
  const record = JSON.parse((await anon.get('/api/u/alice')).text).record;
  assert.equal(record.resolved, 1);
  assert.equal(record.cameTrue, 0);
  assert.equal(record.didNot, 1);
  const own = JSON.parse((await ownerB.get('/api/me')).text).record;
  assert.equal(own.resolved, 2, 'the owner’s own record counts both');
});

test('going private withdraws every public page, preview, export and search result', async () => {
  await ownerB.submit('/me/settings', { profile: 'private', defaults: 'private' });
  const pages = await readAll(anon);
  for (const [name, res] of Object.entries(pages)) {
    assert.doesNotMatch(res.text, /Bitcoin will close above|The Fed will raise/, `${name} still shows a record`);
    assert.doesNotMatch(res.text, /og:title/, `${name} still has a preview`);
  }
  assert.equal(pages['profile page'].status, 404);
  assert.equal(pages['saved prediction page'].status, 404);
  assert.equal(pages['public export'].status, 404);
  const texts = await s.db.many(`select text from sources where platform = 'x' and text <> ''`);
  assert.equal(texts.length, 0, 'withdrawing the record drops the stored words too');

  const ask = await ownerB.submit('/me/settings', { profile: 'public', defaults: 'private' });
  assert.match(ask.url, /\/me\/settings\/publish/, 'returning to public asks again');
  await ownerB.submit('/me/settings/publish', [['confirm', '1'], ['defaults', 'private']]);
  const profile = JSON.parse((await anon.get('/api/u/alice')).text);
  assert.equal(profile.predictions.length + profile.following.length, 0, 'earlier choices are not silently restored');
});

test('forms need the session’s CSRF token', async () => {
  const forged = await ownerB.follow(`/me/saves/${ids.mine}/note`, { method: 'POST', form: { note: 'forged', csrf: 'wrong' } });
  assert.equal(forged.status, 403);
  assert.equal((await s.db.one('select annotation from saves where id = $1', [ids.mine])).annotation, NOTE);
});
