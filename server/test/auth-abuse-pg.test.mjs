import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { createDb } from '../src/db.mjs';
import { createApp } from '../src/web.mjs';
import { Browser, startStack } from './support/app.mjs';

async function replica(stack, t) {
  const db = createDb(stack.pg.url);
  const server = http.createServer(createApp({ db, config: stack.config }));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
    await db.close();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${server.address().port}`;
}

test('spoofed forwarding headers and new cookies do not bypass the sign-in address limit', async t => {
  const stack = await startStack();
  t.after(() => stack.close());
  const requests = await Promise.all(Array.from({ length: 28 }, (_, index) =>
    stack.browser().request('GET', '/signin/x', { headers: { 'x-real-ip': `192.0.2.${index + 1}`, 'x-forwarded-for': `192.0.2.${index + 1}` } })));
  assert.equal(requests.filter(result => result.status === 303).length, 24);
  const refused = requests.filter(result => result.status === 429);
  assert.equal(refused.length, 4);
  for (const response of refused) {
    assert.ok(Number(response.headers.get('retry-after')) > 0);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    assert.equal(response.headers.get('set-cookie'), null);
    assert.equal(response.location, null);
  }
  assert.deepEqual(await stack.db.one("select count(*)::int as n from oauth_states where purpose = 'signin'"), { n: 24 });
});

test('simultaneous sign-in starts on separate app instances share capacity, releasing it on expiry', async t => {
  const stack = await startStack();
  t.after(() => stack.close());
  const other = await replica(stack, t);
  await stack.db.query(`insert into oauth_states (state, code_verifier, purpose)
    select 'pending-' || i, 'v', 'signin' from generate_series(1, 1023) as i`);
  const results = await Promise.all([stack.browser(), new Browser(other)].map(browser => browser.request('GET', '/signin/x')));
  assert.deepEqual(results.map(result => result.status).sort(), [303, 429]);
  const refused = results.find(result => result.status === 429);
  assert.ok(Number(refused.headers.get('retry-after')) > 0);
  assert.equal(refused.headers.get('set-cookie'), null);
  assert.deepEqual(await stack.db.one("select count(*)::int as n from oauth_states where purpose = 'signin'"), { n: 1024 });

  const bot = stack.fakeX.addUser('500', 'statedbot');
  assert.equal((await stack.connectBot(bot)).status, 200, 'the operator can connect the bot while the sign-in capacity is full');
  await stack.db.query("update oauth_states set created_at = now() - interval '16 minutes' where state = 'pending-1'");
  const person = stack.fakeX.addUser('100', 'alice');
  const signedIn = stack.browser();
  const start = await signedIn.request('GET', '/signin/x');
  stack.fakeX.consentAs = person.id;
  const consent = await signedIn.request('GET', start.location);
  stack.fakeX.consentAs = null;
  assert.equal((await stack.browser().request('GET', consent.location)).status, 400, 'the state stays browser-bound');
  assert.equal((await signedIn.request('GET', consent.location)).status, 303);
  assert.ok(signedIn.jar.has('stated_sid'));
  assert.equal((await signedIn.request('GET', consent.location)).status, 400, 'a callback remains single-use');
  assert.equal(await stack.db.one("select state from oauth_states where state = 'pending-1'"), null);
  assert.deepEqual(await stack.db.one("select count(*)::int as n from oauth_states where purpose = 'signin'"), { n: 1023 });
});

test('parallel correction requests share a requester quota without blocking another requester', async t => {
  const stack = await startStack();
  t.after(() => stack.close());
  const other = await replica(stack, t);
  const alice = await stack.signIn(stack.fakeX.addUser('100', 'alice'));
  const bob = await stack.signIn(stack.fakeX.addUser('101', 'bob'));
  const requester = await stack.db.one("select id from users where x_user_id = '100'");
  const bobUser = await stack.db.one("select id from users where x_user_id = '101'");
  const source = await stack.db.one(`insert into sources (platform, platform_id, url, text, acquisition)
    values ('web', 'corrections', 'https://example.test/corrections', 'A story with forecasts.', 'editorial') returning id`);
  const statements = await stack.db.many(`insert into statements (source_id, span, speaker)
    select $1, 'Forecast ' || n, 'Author' from generate_series(1, 10) as n returning id`, [source.id]);
  await stack.db.query(`insert into saves (owner_x_user_id, owner_user_id, statement_id, relation, intake)
    select u.x_user_id, u.id, st.id, 'following', 'url' from users u cross join statements st
    where u.id in ($1, $2) and st.source_id = $3`, [requester.id, bobUser.id, source.id]);
  const bobSession = await stack.db.one('select csrf from sessions where user_id = $1', [bobUser.id]);
  const aliceSession = await stack.db.one('select csrf from sessions where user_id = $1', [requester.id]);
  const aliceReplica = new Browser(other);
  aliceReplica.jar = new Map(alice.jar);
  const submit = (browser, csrf, statement, body = 'The stated deadline should be reviewed.') =>
    browser.request('POST', '/corrections', { form: { statement, body, kind: 'interpretation', csrf } });

  const duplicate = await Promise.all([alice, aliceReplica].map(browser => submit(browser, aliceSession.csrf, statements[0].id)));
  assert.deepEqual(duplicate.map(result => result.status).sort(), [303, 409]);
  assert.equal((await submit(bob, bobSession.csrf, statements[0].id)).status, 303);
  const results = await Promise.all(statements.slice(1, 7).map((row, index) =>
    submit(index % 2 ? aliceReplica : alice, aliceSession.csrf, row.id)));
  assert.equal(results.filter(result => result.status === 303).length, 4);
  assert.equal(results.filter(result => result.status === 429).length, 2);
  assert.deepEqual(await stack.db.one('select count(*)::int as n from correction_requests where requester_user_id = $1', [requester.id]), { n: 5 });
  await stack.db.query("update correction_requests set status = 'rejected' where requester_user_id = $1", [requester.id]);
  const stillLimited = await submit(aliceReplica, aliceSession.csrf, statements[9].id);
  assert.equal(stillLimited.status, 429, 'review decisions do not reset the hourly quota');
  assert.ok(Number(stillLimited.headers.get('retry-after')) > 0);
  await stack.db.query("update correction_requests set status = 'open' where requester_user_id = $1", [requester.id]);

  await stack.db.query("update correction_requests set created_at = now() - interval '61 minutes' where requester_user_id = $1", [requester.id]);
  assert.equal((await submit(alice, aliceSession.csrf, statements[0].id)).status, 409, 'an old open correction still prevents a duplicate');
  assert.equal((await submit(alice, aliceSession.csrf, statements[9].id)).status, 303, 'a new correction can be filed after the quota window');
  await stack.db.query(`insert into correction_requests (statement_id, requester_user_id, kind, body, created_at)
    select id, $1, 'resolution', 'A pending review of the recorded result.', now() - interval '61 minutes'
    from statements where source_id = $2 order by id limit 4`, [requester.id, source.id]);
  assert.equal((await submit(alice, aliceSession.csrf, statements[8].id)).status, 429, 'pending work remains bounded across quota windows');
  assert.deepEqual(await stack.db.one("select count(*)::int as n from correction_requests where requester_user_id = $1 and status = 'open'", [requester.id]), { n: 10 });
});
