// Operator-runnable real PostgreSQL/HTTP regressions. External transports are
// synthetic and fail closed outside the local stack; no live services are used.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startStack } from './support/app.mjs';
import { FakeOutLayerNear } from './support/fake-outlayer.mjs';
import { enclaveEnv, fakeNearAi } from './support/enclave.mjs';
import { outlayerTestFetch } from './support/outlayer-fetch.mjs';
import { queueBetCommand, runBetCommands } from '../src/reply-bets.mjs';

const HOUR = 3600000;
const iso = value => new Date(value).toISOString();

function dateFields(name, value) {
  const date = new Date(value);
  return { [`${name}DateInput`]: '1', [`${name}Day`]: String(date.getUTCDate()),
    [`${name}Month`]: String(date.getUTCMonth() + 1), [`${name}Year`]: String(date.getUTCFullYear()),
    [`${name}Hour`]: String(date.getUTCHours()), [`${name}Minute`]: String(date.getUTCMinutes()) };
}

async function setup(t) {
  const near = new FakeOutLayerNear();
  const ai = fakeNearAi({ respond: ({ input }) => /NEAR/.test(input.claim)
    ? { source: 'coinbase-candles', product: 'NEAR-USD', ...(/reaches/.test(input.claim)
      ? { kind: 'range', start: input.madeAt, end: input.deadline }
      : { kind: 'moment', at: input.deadline }) }
    : { source: 'evidence' } });
  let s;
  const fetchImpl = outlayerTestFetch({ ai, near: () => near, xBase: () => s?.fakeX.base });
  s = await startStack({ ...enclaveEnv, STATED_ENCLAVE_RULINGS: '', STATED_NEAR_CONTRACT: near.contract,
    STATED_OUTLAYER_REFEREE: near.referee, STATED_PLAY: '1', STATED_PLAY_AUTOPROVISION: '1',
    STATED_REPUTATION_TIERS: 'off' }, { chain: near.chain, fetchImpl });
  t.after(() => s.close());
  const x = s.fakeX.addUser('87001', 'founder');
  const browser = await s.signIn(x);
  await browser.submit('/setup', { profile: 'private', defaults: 'private' });
  const user = await s.db.one('select * from users where x_user_id=$1', [x.id]);
  async function save(claim, due) {
    const post = s.fakeX.post(x.id, claim);
    const url = `https://x.com/founder/status/${post.id}`;
    const source = await s.db.one(`insert into sources(platform,platform_id,url,text,author_x_user_id,author_username,acquisition)
      values('x',$1,$2,$3,$4,'founder','mention') returning id`, [post.id, url, claim, x.id]);
    const statement = await s.db.one(`insert into statements(source_id,span,speaker,speaker_x_user_id,deadline_at)
      values($1,$2,'founder',$3,$4) returning id`, [source.id, claim, x.id, due]);
    const saved = await s.db.one(`insert into saves(owner_x_user_id,owner_user_id,statement_id,relation,intake)
      values($1,$2,$3,'mine','mention') returning id`, [x.id, user.id, statement.id]);
    return { id: String(saved.id), url };
  }
  return { s, near, browser, user, save, fetchImpl };
}

for (const surface of ['web form', 'X reply']) {
  for (const kind of ['moment', 'range']) {
    test(`PostgreSQL ${surface}: NEAR ${kind} offer closes before its committed price window`, async t => {
      const f = await setup(t);
      const tomorrow = new Date(); tomorrow.setUTCDate(tomorrow.getUTCDate() + 1); tomorrow.setUTCHours(23, 59, 0, 0);
      const claim = kind === 'moment' ? 'NEAR above $3 at the end of day tomorrow on Coinbase.'
        : 'NEAR reaches $3 before the end of day tomorrow on Coinbase.';
      const saved = await f.save(claim, tomorrow);
      let bet;
      if (surface === 'web form') {
        const page = await f.browser.get('/me/bets/new');
        assert.equal(page.status, 200);
        const response = await f.browser.submit('/me/bets', { requestId: randomUUID(), claim,
          criteria: 'Coinbase NEAR-USD minute candles decide.', evidenceSourceUrl: saved.url,
          creatorSide: 'yes', stakeNear: '0.1', ...dateFields('acceptBy', tomorrow.getTime() - 60000),
          ...dateFields('resolveAt', tomorrow) }, { from: '/me/bets/new' });
        assert.match(new URL(response.url).pathname, /^\/bets\/[a-f0-9-]+$/);
        bet = await f.s.db.one('select * from bilateral_bets where id=$1', [new URL(response.url).pathname.split('/').pop()]);
        assert.match(response.text, /Context link/);
        assert.match(response.text, /Coinbase NEAR-USD/);
      } else {
        const eventId = `r7-${kind}`;
        await f.s.db.tx(tx => queueBetCommand(tx, { eventId, xUserId: f.user.x_user_id, username: 'founder',
          command: { kind: 'bet', side: 'yes', stake: '0.1' }, saveId: saved.id, words: claim }));
        assert.deepEqual(await runBetCommands(f.s.db, f.s.config, f.near.chain, { fetchImpl: f.fetchImpl }),
          { done: 1, refused: 0, retry: 0, failed: 0 });
        bet = await f.s.db.one('select b.* from bilateral_bets b join bet_commands c on c.bet_id=b.id where c.event_id=$1', [eventId]);
      }
      const created = new Date(bet.created_at).getTime();
      assert.equal(iso(bet.accept_by), iso(Math.min(created + 24 * HOUR, tomorrow.getTime() - HOUR)));
      const evidence = bet.outlayer_material.evidence;
      assert.equal(evidence.kind, 'coinbase');
      assert.deepEqual(evidence.window, kind === 'moment' ? { kind, at: tomorrow.toISOString() }
        : { kind, start: iso(Math.ceil(new Date(bet.accept_by).getTime() / 60000) * 60000), end: tomorrow.toISOString() });
      assert.equal(f.near.sent.filter(call => call.method === 'register_material').length, 0);
    });
  }
}

test('PostgreSQL web form: X context works with and without a save; web context cannot replace Coinbase', async t => {
  const f = await setup(t);
  const due = iso(Date.now() + 3 * HOUR);
  for (const sourceSaveId of [null, 'saved']) {
    const saved = await f.save('A release ships.', due);
    const response = await f.browser.submit('/me/bets', { requestId: randomUUID(), claim: 'A release ships.',
      criteria: 'The release page confirms it.', evidenceSourceUrl: saved.url, creatorSide: 'yes', stakeNear: '0.1',
      ...(sourceSaveId ? { sourceSaveId: saved.id } : {}), ...dateFields('acceptBy', Date.now() + HOUR),
      ...dateFields('resolveAt', due) }, { from: '/me/bets/new' });
    assert.match(new URL(response.url).pathname, /^\/bets\/[a-f0-9-]+$/);
    const bet = await f.s.db.one('select * from bilateral_bets where id=$1', [new URL(response.url).pathname.split('/').pop()]);
    assert.equal(bet.outlayer_material.evidence.kind, 'open');
    assert.equal(bet.outlayer_material.post_url, saved.url);
  }
  const context = 'https://www.coinbase.com/price/near-protocol';
  const response = await f.browser.submit('/me/bets', { requestId: randomUUID(), claim: 'NEAR above $3 at the deadline.',
    criteria: 'Coinbase NEAR-USD price decides.', evidenceSourceUrl: context, creatorSide: 'yes', stakeNear: '0.1',
    ...dateFields('acceptBy', Date.now() + HOUR), ...dateFields('resolveAt', due) }, { from: '/me/bets/new' });
  assert.match(new URL(response.url).pathname, /^\/bets\/[a-f0-9-]+$/);
  const bet = await f.s.db.one('select * from bilateral_bets where id=$1', [new URL(response.url).pathname.split('/').pop()]);
  assert.equal(bet.outlayer_material.evidence.kind, 'coinbase');
  assert.equal(bet.outlayer_material.post_url, context);
  assert.match(response.text, /Context link/);
  assert.doesNotMatch(response.text, /jury reads the agreed source/);
});
