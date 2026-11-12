// INTEGRATION: real PostgreSQL and HTTP regressions. Run by the operator, not lane D.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { createBet } from '../src/bets.mjs';
import { startStack } from './support/app.mjs';
import { enclaveRulingFixture } from './support/enclave.mjs';

test('public pages and both exports paginate real rows; export histories use one query', async t => {
  const s = await startStack();
  t.after(() => s.close());
  const person = s.fakeX.addUser('9201', 'bounded_export');
  const browser = await s.signIn(person);
  await browser.submit('/setup', { profile: 'public', defaults: 'public' });
  const owner = await s.db.one('select * from users where x_user_id=$1', [person.id]);
  // Setup may require a publication confirmation; seed the fixture's explicit privacy choice.
  await s.db.query("update users set profile_visibility='public',setup_completed_at=now() where id=$1", [owner.id]);
  const source = await s.db.one(`insert into sources (platform,platform_id,url,text,acquisition)
    values ('web','lane-d-export','https://example.org/lane-d','Export fixture','url_intake') returning id`);
  const rows = await s.db.many(`insert into statements (source_id,span,speaker)
    select $1,'Export claim '||n,'@bounded_export' from generate_series(1,205) n returning id`, [source.id]);
  await s.db.query(`insert into saves (owner_x_user_id,owner_user_id,statement_id,relation,visibility,intake,annotation)
    select $1,$2,id,'mine','public','url','PRIVATE_ANNOTATION' from statements where source_id=$3`, [person.id, owner.id, source.id]);
  await s.db.query(`insert into revisions (statement_id,kind,actor,note)
    select id,'captured','system','Batch history' from statements where source_id=$1`, [source.id]);
  assert.equal(rows.length, 205);
  const originalMany = s.db.many;
  let revisionQueries = 0;
  s.db.many = async (sql, values) => {
    if (/from revisions r/.test(sql)) revisionQueries += 1;
    return originalMany(sql, values);
  };
  let path = '/api/u/bounded_export/export.json';
  const ids = [];
  let pages = 0;
  while (path) {
    const response = await s.browser().request('GET', path);
    assert.equal(response.status, 200);
    const data = JSON.parse(response.text);
    pages += 1;
    assert.ok(data.saves.length <= 50);
    assert.doesNotMatch(response.text, /PRIVATE_ANNOTATION/);
    assert.ok(data.saves.every(save => save.history.length === 1));
    ids.push(...data.saves.map(save => save.id));
    path = data.pagination.next;
  }
  assert.equal(new Set(ids).size, 205);
  assert.equal(ids.length, 205);
  assert.equal(revisionQueries, pages);
  const own = JSON.parse((await browser.request('GET', '/me/export.json')).text);
  assert.equal(own.saves.length, 200);
  assert.ok(own.saves.every(save => save.annotation === 'PRIVATE_ANNOTATION'));
  const last = JSON.parse((await browser.request('GET', own.pagination.next)).text);
  assert.equal(last.saves.length, 5);
  assert.equal(last.pagination.next, null);
  const profile = await s.browser().request('GET', '/u/bounded_export');
  assert.equal(profile.status, 200);
  assert.match(profile.text, /rel="next" href="\/u\/bounded_export\?before=/);
  const api = JSON.parse((await s.browser().request('GET', '/api/u/bounded_export')).text);
  assert.equal(api.predictions.length, 50);
  assert.ok(api.pagination.next);
  await s.db.query("update users set profile_visibility='private' where id=$1", [owner.id]);
  assert.equal((await s.browser().request('GET', '/api/u/bounded_export/export.json')).status, 404);
});

test('cached ruling JSON uses PostgreSQL event revisions and fresh publication locks before returning 304', async t => {
  const s = await startStack();
  t.after(() => s.close());
  const person = s.fakeX.addUser('9202', 'cached_ruling');
  const browser = await s.signIn(person);
  await browser.submit('/setup', { profile: 'private', defaults: 'private' });
  const owner = await s.db.one('select * from users where x_user_id=$1', [person.id]);
  const resolveAt = new Date(Math.ceil((Date.now() + 172800000) / 3600000) * 3600000).toISOString();
  const bet = await createBet(s.db, owner, { requestId: randomUUID(), claim: 'The public event will occur.',
    criteria: 'The official result.', evidenceSourceUrl: 'https://example.org/result', creatorSide: 'yes',
    stakeNear: '0.1', acceptBy: new Date(Date.now() + 86400000).toISOString(), resolveAt });
  const record = enclaveRulingFixture({ material: { claim: bet.claim, madeAt: bet.created_at, deadline: resolveAt,
    postUrl: bet.evidence_source_url, bets: [{ id: bet.id, termsHash: bet.terms_hash }] } });
  await s.db.query('insert into bilateral_bet_publications (bet_id,creator_user_id) values ($1,$2)', [bet.id, owner.id]);
  const event = await s.db.one(`insert into bilateral_bet_events (bet_id,actor_user_id,kind,detail)
    values ($1,$2,'enclave_ruling',$3) returning id`, [bet.id, owner.id, record]);
  const path = `/bets/${bet.id}/enclave-ruling.json`;
  const first = await s.browser().request('GET', path);
  assert.equal(first.status, 200);
  const etag = first.headers.get('etag');
  assert.match(etag, /^"[a-f0-9]{64}"$/);
  const cached = await s.browser().request('GET', path, { headers: { 'if-none-match': etag } });
  assert.equal(cached.status, 304);
  assert.equal(cached.text, '');
  await s.db.query("update bilateral_bet_events set detail=jsonb_set(detail,'{materialHash}',to_jsonb('tampered'::text)) where id=$1", [event.id]);
  assert.equal((await s.browser().request('GET', path, { headers: { 'if-none-match': etag } })).status, 404);
  await s.db.query('update bilateral_bet_events set detail=$2 where id=$1', [event.id, record]);
  assert.equal((await s.browser().request('GET', path)).status, 200);
  await s.db.query('update bilateral_bet_publications set withdrawn_at=now() where bet_id=$1', [bet.id]);
  assert.equal((await s.browser().request('GET', path, { headers: { 'if-none-match': etag } })).status, 404);
});
