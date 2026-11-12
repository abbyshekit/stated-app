import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { ADMIN_X_ID, startStack } from './support/app.mjs';
import { createBet } from '../src/bets.mjs';
import { completeSetup, removeSave, revisionsFor, signInFromX, UserError } from '../src/store.mjs';

let s; let owner;
before(async () => {
  s = await startStack();
  owner = await completeSetup(s.db, await signInFromX(s.db, { id: '99601', username: 'source_guard' }), {});
});
after(async () => { await s?.close(); });

async function sourceSave() {
  const source = await s.db.one(`insert into sources (platform,platform_id,url,text,acquisition)
    values ('web',$1,'https://example.org/result','A public result.','url_intake') returning id`, [randomUUID()]);
  const statement = await s.db.one(`insert into statements (source_id,span,speaker)
    values ($1,'The registry publishes the result.','Registry') returning id`, [source.id]);
  const save = await s.db.one(`insert into saves (owner_x_user_id,owner_user_id,statement_id,relation,intake)
    values ($1,$2,$3,'following','mention') returning id`, [owner.x_user_id, owner.id, statement.id]);
  return { saveId: save.id, statementId: statement.id, sourceId: source.id };
}

async function linkedBet(saveId) {
  return createBet(s.db, owner, { requestId: randomUUID(), claim: 'The registry publishes the result.',
    criteria: 'The official registry confirms the result.', evidenceSourceUrl: 'https://example.org/result',
    creatorSide: 'yes', stakeNear: '0.1', sourceSaveId: saveId,
    acceptBy: new Date(Date.now() + 3600_000).toISOString(), resolveAt: new Date(Date.now() + 7200_000).toISOString() });
}

for (const status of ['offered', 'accepted', 'settled', 'refunded']) {
  test(`a ${status} Bet protects its save in the application and database`, async () => {
    const { saveId, sourceId } = await sourceSave();
    const bet = await linkedBet(saveId);
    await s.db.query('update bilateral_bets set status=$2 where id=$1', [bet.id, status]);
    await assert.rejects(removeSave(s.db, owner, saveId), (error) => error instanceof UserError
      && error.status === 409 && /This post has a bet on it/.test(error.message));
    for (const [sql, params] of [
      ['delete from saves where id=$1', [saveId]],
      ['delete from users where id=$1', [owner.id]],
      ['delete from sources where id=$1', [sourceId]],
    ]) await assert.rejects(s.db.query(sql, params), { code: '23503' });
    assert.equal((await s.db.one('select source_save_id from bilateral_bets where id=$1', [bet.id])).source_save_id, saveId);
    assert.ok(await s.db.one('select id from saves where id=$1', [saveId]));
  });
}

test('a save with no Bet still deletes', async () => {
  const { saveId, statementId } = await sourceSave();
  assert.equal(await removeSave(s.db, owner, saveId), statementId);
  assert.equal(await s.db.one('select id from saves where id=$1', [saveId]), null);
});

test('migration replaces a populated legacy SET NULL constraint and is repeatable', async () => {
  const { saveId } = await sourceSave();
  const bet = await linkedBet(saveId);
  // NULL is legitimate for Bets created without a source and must stay valid.
  const unlinked = await linkedBet(null);
  await s.db.query(`alter table bilateral_bets drop constraint bilateral_bets_source_save_id_fkey;
    alter table bilateral_bets add constraint bilateral_bets_source_save_id_fkey
      foreign key (source_save_id) references saves(id) on delete set null`);
  const action = () => s.db.one(`select confdeltype from pg_constraint
    where conrelid='bilateral_bets'::regclass and conname='bilateral_bets_source_save_id_fkey'`);
  assert.equal((await action()).confdeltype, 'n');
  for (let run = 0; run < 2; run += 1) {
    await s.db.migrate();
    assert.equal((await action()).confdeltype, 'r');
    assert.equal((await s.db.one('select source_save_id from bilateral_bets where id=$1', [bet.id])).source_save_id, saveId);
    assert.equal((await s.db.one('select source_save_id from bilateral_bets where id=$1', [unlinked.id])).source_save_id, null);
    await assert.rejects(s.db.query('delete from saves where id=$1', [saveId]), { code: '23503' });
  }
});

test('all shared Result writers suppress private evidence, including existing rows on migration', async () => {
  const { saveId, statementId } = await sourceSave();
  await linkedBet(saveId);
  const values = [statementId, 'https://example.org/SECRET-LINK', 'SECRET-TITLE and SECRET-JURY-REASON'];
  const write = () => s.db.query(`update statements set status='yes', resolution_url=$2, resolution_note=$3 where id=$1`, values);
  const read = () => s.db.one('select resolution_url, resolution_note from statements where id=$1', [statementId]);
  await write();
  assert.deepEqual(await read(), { resolution_url: null, resolution_note: 'Result recorded. Bet evidence stays on its Bet page.' });
  // Reproduce a row written before the database privacy guard existed.
  await s.db.query('drop trigger statements_private_bet_result on statements');
  await write();
  assert.match(JSON.stringify(await read()), /SECRET-LINK/);
  await s.db.migrate();
  assert.deepEqual(await read(), { resolution_url: null, resolution_note: 'Result recorded. Bet evidence stays on its Bet page.' });
});

test('reviewer Results and historical private evidence stay off public save HTML and API', async () => {
  const { saveId, statementId } = await sourceSave();
  await linkedBet(saveId);
  await s.db.query(`update users set profile_visibility='public' where id=$1`, [owner.id]);
  await s.db.query(`update saves set visibility='public' where id=$1`, [saveId]);
  const admin = await s.signIn(s.fakeX.addUser(ADMIN_X_ID, 'security_reviewer'));
  await admin.submit('/setup', { profile: 'private', defaults: 'private' });
  const url = 'https://example.org/PRIVATE-REVIEW-LINK';
  const note = 'PRIVATE-REVIEW-TITLE and PRIVATE-JURY-REASON';
  const response = await admin.submit(`/admin/resolve/${statementId}`, {
    outcome: 'yes', url, note, known: new Date().toISOString().slice(0, 10),
  }, { from: '/admin' });
  assert.equal(response.status, 200);
  assert.deepEqual(await s.db.one('select resolution_url,resolution_note from statements where id=$1', [statementId]),
    { resolution_url: null, resolution_note: 'Result recorded. Bet evidence stays on its Bet page.' });
  // Legacy history can retain the original note and both previous/current links.
  await s.db.query(`insert into revisions (statement_id,kind,actor,before,after,note)
    values ($1,'resolution_changed','reviewer',$2,$2,$3)`, [statementId, { status: 'yes', url, note }, note]);
  const history = await revisionsFor(s.db, statementId, [saveId]);
  const anon = s.browser();
  for (const result of [
    { status: 200, text: JSON.stringify(history) },
    await anon.get(`/u/${owner.x_username}/${saveId}`),
    await anon.get(`/api/u/${owner.x_username}/${saveId}`),
  ]) {
    assert.equal(result.status, 200);
    assert.doesNotMatch(result.text, /PRIVATE-REVIEW-LINK|PRIVATE-REVIEW-TITLE|PRIVATE-JURY-REASON/);
  }
});
