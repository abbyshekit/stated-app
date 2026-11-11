// INTEGRATION: Source-linked bet permissions and persistence use captured Postgres saves.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { betDraft } from '../src/bet-draft.mjs';
import { createBet, sourceForBet } from '../src/bets.mjs';
import { completeSetup, signInFromX } from '../src/store.mjs';
import { tick } from '../src/worker.mjs';
import { startStack } from './support/app.mjs';

let s;
let alice;
let bob;
let publicUser;
let hiddenUser;
let saves;

before(async () => {
  s = await startStack();
  const bot = s.fakeX.addUser('500', 'statedbot');
  const people = [
    s.fakeX.addUser('9101', 'source_alice'),
    s.fakeX.addUser('9102', 'source_bob'),
    s.fakeX.addUser('9103', 'source_public'),
    s.fakeX.addUser('9104', 'source_hidden'),
  ];
  await s.connectBot(bot);
  alice = await completeSetup(s.db, await signInFromX(s.db, { id: people[0].id, username: people[0].username }), {});
  bob = await completeSetup(s.db, await signInFromX(s.db, { id: people[1].id, username: people[1].username }), {});
  publicUser = await completeSetup(s.db, await signInFromX(s.db, { id: people[2].id, username: people[2].username }), { profileVisibility: 'public' });
  hiddenUser = await completeSetup(s.db, await signInFromX(s.db, { id: people[3].id, username: people[3].username }), {});

  for (const [person, claim] of [
    [people[0], 'The event will happen.'],
    [people[1], 'The event will happen.'],
    [people[2], 'The event will happen.'],
    [people[3], 'The event will happen.'],
  ]) {
    const post = s.fakeX.post(person.id, claim);
    s.fakeX.post(person.id, '@statedbot track this', { replyTo: post.id });
  }
  await tick(s.db, s.config, s.x);
  const userIds = [alice.id, bob.id, publicUser.id, hiddenUser.id].map(String);
  saves = await s.db.many(`select s.id, s.owner_user_id, s.visibility, src.available, st.span, st.status
    from saves s join statements st on st.id=s.statement_id join sources src on src.id=st.source_id
    where s.owner_user_id = any($1::bigint[]) order by s.owner_user_id`,
    [userIds]);
  assert.equal(saves.length, 4, 'each captured X prediction must create a saved source');
  const publicSave = saves.find((save) => String(save.owner_user_id) === String(publicUser.id));
  await completeSetup(s.db, publicUser, { profileVisibility: 'public', publishIds: [String(publicSave.id)] });
  const hiddenSave = saves.find((save) => String(save.owner_user_id) === String(hiddenUser.id));
  await s.db.query("update saves set visibility='public' where id=$1", [hiddenSave.id]);
});

after(async () => { if (s) await s.close(); });

function getSave(user) {
  return saves.find((save) => String(save.owner_user_id) === String(user.id));
}

function terms(overrides = {}) {
  return {
    requestId: randomUUID(), claim: 'Synthetic linked bet claim',
    criteria: 'Resolve from the official result during the proposed Bet window.',
    evidenceSourceUrl: 'https://example.org/result', creatorSide: 'yes', stakeNear: '0.1',
    opponentUsername: '', opponentAccount: '',
    acceptBy: new Date(Date.now() + 3600000).toISOString(),
    resolveAt: new Date(Date.now() + 7200000).toISOString(),
    ...overrides,
  };
}

test('source access allows own private and published public saves only', async () => {
  assert.equal((await sourceForBet(s.db, alice, getSave(alice).id)).save_id, getSave(alice).id);
  await assert.rejects(sourceForBet(s.db, alice, getSave(bob).id), { status: 404 });
  assert.equal((await sourceForBet(s.db, alice, getSave(publicUser).id)).save_id, getSave(publicUser).id);
  await assert.rejects(sourceForBet(s.db, alice, getSave(hiddenUser).id), { status: 404 });
});

test('private X draft omits its stored placeholder and proposes a window without changing source terms', async () => {
  const source = await sourceForBet(s.db, alice, getSave(alice).id);
  assert.match(source.span, /^X post \d+$/);
  const before = await s.db.one(`select proposed_deadline_at from statements where id=$1`, [source.statement_id]);
  assert.equal(before.proposed_deadline_at, null);
  const now = new Date();
  const draft = betDraft(source, { now });
  assert.equal(draft.claim, '');
  assert.doesNotMatch(draft.claim, /^X post \d+$/);
  assert.equal(draft.dateOrigin, 'Proposed Bet window; does not change the source Prediction');
  assert.ok(new Date(draft.resolveAt).getTime() > now.getTime());
  assert.equal((await s.db.one(`select proposed_deadline_at from statements where id=$1`, [source.statement_id])).proposed_deadline_at, null);
});

test('linked creation persists source ID, replays idempotently and rejects changing source under a reused request ID', async () => {
  const sourceId = String(getSave(alice).id);
  const input = terms({ sourceSaveId: sourceId });
  const created = await createBet(s.db, alice, input);
  assert.equal(String(created.source_save_id), sourceId);
  const replay = await createBet(s.db, alice, input);
  assert.equal(replay.id, created.id);
  await assert.rejects(createBet(s.db, alice, { ...input, sourceSaveId: String(getSave(publicUser).id) }), { status: 409 });
});

test('removed and resolved predictions cannot be linked to a new bet', async () => {
  const removedId = getSave(alice).id;
  await s.db.query(`update sources set available=false where id=(
    select st.source_id from saves s join statements st on st.id=s.statement_id where s.id=$1
  )`, [removedId]);
  await assert.rejects(sourceForBet(s.db, alice, removedId), { status: 409 });
  await assert.rejects(createBet(s.db, alice, terms({ sourceSaveId: String(removedId) })), { status: 409 });

  const resolvedId = getSave(bob).id;
  await s.db.query("update statements set status='yes', outcome_at=clock_timestamp() where id=(select statement_id from saves where id=$1)", [resolvedId]);
  await assert.rejects(sourceForBet(s.db, bob, resolvedId), { status: 409 });
  await assert.rejects(createBet(s.db, bob, terms({ sourceSaveId: String(resolvedId) })), { status: 409 });
});

test('Prediction cards enforce profile privacy and Result sharing includes the assessment and evidence', async () => {
  const id = getSave(publicUser).id;
  const url = `${s.base}/share/predictions/${id}.png`;
  const image = await fetch(url);
  assert.equal(image.status, 200);
  const png = Buffer.from(await image.arrayBuffer());
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  assert.equal((await fetch(`${s.base}/share/predictions/${getSave(hiddenUser).id}.png`)).status, 404);
  await s.db.query(`update statements set status='yes', resolution_url='https://example.org/result',
    outcome_at=clock_timestamp() where id=(select statement_id from saves where id=$1)`, [id]);
  const page = await s.browser().get(`/u/${publicUser.x_username}/${id}`);
  assert.equal(page.status, 200);
  const intent = page.text.match(/href="(https:\/\/x\.com\/intent\/post[^"]+)"/);
  assert.ok(intent, 'Result has a user-initiated sharing link');
  const copy = new URL(intent[1].replaceAll('&amp;', '&')).searchParams.get('text');
  assert.match(copy, /Result: Yes/);
  assert.match(copy, /https:\/\/example.org\/result/);
  await s.db.query("update users set profile_visibility='private' where id=$1", [publicUser.id]);
  assert.equal((await fetch(url)).status, 404, 'profile withdrawal also withdraws an already-rendered image');
});
