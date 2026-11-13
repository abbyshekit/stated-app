// Real PostgreSQL/HTTP; every external transport is local or synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startStack } from './support/app.mjs';
import { FakeOutLayerNear } from './support/fake-outlayer.mjs';
import { enclaveEnv, fakeNearAi } from './support/enclave.mjs';
import { outlayerTestFetch } from './support/outlayer-fetch.mjs';
import { createBet } from '../src/bets.mjs';
import { prepareNearAction } from '../src/near-bets.mjs';
import { ensurePlayAccount, playAction, playAccountFor, yocto } from '../src/play.mjs';
import { queueBetCommand, runBetCommands, settleReplyBets } from '../src/reply-bets.mjs';
import { completeSetup, signInFromX } from '../src/store.mjs';

const terms = (extra = {}) => ({ requestId: randomUUID(), claim: 'A synthetic release ships.',
  criteria: 'Its official release is public.', evidenceSourceUrl: 'https://example.org/release', creatorSide: 'yes',
  stakeNear: '0.25', acceptBy: new Date(Date.now() + 600000).toISOString(),
  resolveAt: new Date(Date.now() + 1200000).toISOString(), ...extra });

test('mainnet creation, replies and legacy wallet actions enforce the cap with real PostgreSQL', async (t) => {
  const near = new FakeOutLayerNear({ contract: 'escrow.stated.near', referee: 'jury.stated.near' });
  near.accounts.set('stated.near', { balance: BigInt(yocto('100')), keys: new Set(['ed25519:treasury']) });
  const ai = fakeNearAi({ respond: () => ({ source: 'evidence' }) });
  let s;
  const fetchImpl = outlayerTestFetch({ ai, near: () => near, xBase: () => s?.fakeX.base });
  s = await startStack({ ...enclaveEnv, STATED_ENCLAVE_RULINGS: '', STATED_NEAR_NETWORK: 'mainnet',
    STATED_MAINNET: 'real-funds', STATED_TOKEN_KEY: 't'.repeat(44), STATED_NEAR_CONTRACT: near.contract,
    STATED_OUTLAYER_REFEREE: near.referee, STATED_PLAY: '1', STATED_PLAY_TREASURY: 'stated.near',
    STATED_PLAY_TREASURY_KEY: 'ed25519:test-only', STATED_PILOT_X_IDS: '*', STATED_REPUTATION_TIERS: 'off' },
  { chain: near.chain, fetchImpl });
  t.after(() => s.close());
  // Exercise a lower runtime cap independently of configuration-parser tests.
  s.config.play.maxStakeNear = '0.25';
  const maker = await completeSetup(s.db, await signInFromX(s.db, { id: '84001', username: 'cap_maker' }), {});
  const taker = await completeSetup(s.db, await signInFromX(s.db, { id: '84002', username: 'cap_taker' }), {});
  const options = { config: s.config, chain: near.chain, fetchImpl };
  const count = async (table) => (await s.db.one(`select count(*)::int as n from ${table}`)).n;

  await t.test('only a configured, reachable matching referee can create mainnet rows', async () => {
    const before = await count('bilateral_bets');
    const noReferee = { ...s.config, outlayer: { ...s.config.outlayer, referee: null } };
    await assert.rejects(createBet(s.db, maker, terms(), { ...options, config: noReferee }), { status: 503 });
    for (const view of [async () => { throw new Error('synthetic unavailable'); }, async () => ({ escrow: 'other.near' })]) {
      await assert.rejects(createBet(s.db, maker, terms(), { ...options, chain: { view } }), { status: 503 });
    }
    assert.equal(await count('bilateral_bets'), before);
    const allowed = await createBet(s.db, maker, terms(), options);
    assert.equal(allowed.stake_yocto, yocto('0.25'));
    assert.equal(allowed.referee_wallet, near.referee);
    assert.ok(allowed.outlayer_material);
    await assert.rejects(createBet(s.db, maker, terms({ stakeNear: '0.250000000000000000000001' }), options), { reason: 'cap' });
    assert.equal(await count('bilateral_bets'), before + 1);
  });

  await t.test('reply refusal explicitly names the cap before accounts or bets exist', async () => {
    const before = await count('bilateral_bets');
    await s.db.tx(tx => queueBetCommand(tx, { eventId: 'synthetic-mainnet-cap', xUserId: maker.x_user_id,
      username: maker.x_username, command: { kind: 'bet', side: 'yes', stake: '0.5' }, words: 'Synthetic claim' }));
    assert.deepEqual(await runBetCommands(s.db, s.config, near.chain, { fetchImpl }), { done: 0, refused: 1, retry: 0, failed: 0 });
    const reply = await s.db.one('select body from bot_outbox where dedupe_key=$1', ['refused:synthetic-mainnet-cap']);
    assert.match(reply.body, /mainnet stake cap is 0.25 NEAR/);
    assert.equal(await playAccountFor(s.db, maker.x_user_id), null);
    assert.equal(await count('bilateral_bets'), before);
    assert.equal(near.accounts.has('referee.stated.near'), false);
  });

  await t.test('under-cap funding refuses missing material and a referee changed or unreachable after creation', async () => {
    const draft = await createBet(s.db, maker, terms({ stakeNear: '0.1' }), options);
    const before = await count('bilateral_near_requests');
    const sent = near.sent.length;
    const fund = (policy, chain = near.chain) => prepareNearAction(s.db, policy, maker, draft.id,
      { action: 'fund', accountId: 'maker.near' }, { chain, fetchImpl });
    await assert.rejects(fund({ ...s.config, outlayer: { referee: null } }), { status: 503 });
    const material = draft.outlayer_material;
    await s.db.query('update bilateral_bets set outlayer_material=null where id=$1', [draft.id]);
    await assert.rejects(fund(s.config), /no committed OutLayer referee/);
    await s.db.query('update bilateral_bets set outlayer_material=$2 where id=$1', [draft.id, material]);
    await assert.rejects(fund({ ...s.config, outlayer: { referee: 'different.near' } }), /no committed OutLayer referee/);
    for (const view of [async () => { throw new Error('synthetic configuration outage'); }, async () => ({ escrow: 'other.near' })]) {
      await assert.rejects(fund(s.config, { ...near.chain, view }), { status: 503 });
    }
    assert.equal(await count('bilateral_near_requests'), before);
    assert.equal(near.sent.length, sent);
  });

  await t.test('direct legacy fund and accept cannot reserve requests above the cap', async () => {
    const legacy = { ...s.config, near: { ...s.config.near, real: false }, outlayer: { ...s.config.outlayer, referee: null } };
    const bet = await createBet(s.db, maker, terms({ stakeNear: '0.5' }), { ...options, config: legacy });
    const before = await count('bilateral_near_requests');
    await assert.rejects(prepareNearAction(s.db, s.config, maker, bet.id,
      { action: 'fund', accountId: 'maker.near' }, { chain: near.chain, fetchImpl }), { reason: 'cap' });
    assert.equal(await count('bilateral_near_requests'), before);
    for (const user of [maker, taker]) {
      await ensurePlayAccount(s.db, s.config, near.chain, { xUserId: user.x_user_id, username: user.x_username });
      const account = await playAccountFor(s.db, user.x_user_id);
      near.deliver(account.account_id, yocto('1'), { wrapped: false });
    }
    const priorCap = { ...s.config, near: { ...s.config.near, real: false }, play: { ...s.config.play, maxStakeNear: '1' } };
    const funded = await playAction(s.db, priorCap, near.chain, maker, bet.id, { action: 'fund' }, { fetchImpl });
    assert.equal(funded.bet.chain_state.status, 'offered');
    const requests = await count('bilateral_near_requests');
    const account = await playAccountFor(s.db, taker.x_user_id);
    await assert.rejects(prepareNearAction(s.db, s.config, taker, bet.id,
      { action: 'accept', accountId: account.account_id, termsHash: bet.terms_hash }, { chain: near.chain, fetchImpl }), { reason: 'cap' });
    await assert.rejects(playAction(s.db, s.config, near.chain, taker, bet.id,
      { action: 'accept', termsHash: bet.terms_hash }, { fetchImpl }), { reason: 'cap' });
    assert.equal(await count('bilateral_near_requests'), requests);
    assert.equal(near.bets.get(bet.id).status, 'offered');
  });

  await t.test('settlement polling never allocates a direct referee for OutLayer', async () => {
    assert.equal((await settleReplyBets(s.db, s.config, near.chain, { fetchImpl })).errors, 0);
    assert.equal(near.accounts.has('referee.stated.near'), false);
    assert.equal(await s.db.one("select value from kv where key='play_referee'"), null);
  });
});
