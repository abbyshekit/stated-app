// Real PostgreSQL and HTTP routes. All X, NEAR and inference transports are synthetic.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startStack } from './support/app.mjs';
import { FakeOutLayerNear, outlayerDeadlineMs } from './support/fake-outlayer.mjs';
import { enclaveEnv, fakeNearAi } from './support/enclave.mjs';
import { outlayerTestFetch } from './support/outlayer-fetch.mjs';
import { playAccountFor, yocto } from '../src/play.mjs';
import { runOutlayerKeeper } from '../src/outlayer.mjs';
import { settleReplyBets } from '../src/reply-bets.mjs';

async function stack(t) {
  const near = new FakeOutLayerNear({ contract: 'escrow.statedforecast.near', referee: 'referee.statedforecast.near' });
  near.accounts.set('play.statedforecast.near', { balance: BigInt(yocto('100')), keys: new Set() });
  near.chain.readAccessKeys = async id => { assert.equal(id, near.referee); return []; };
  const ai = fakeNearAi({ respond: () => ({ source: 'evidence' }) });
  let s;
  const fetchImpl = outlayerTestFetch({ ai, near: () => near, xBase: () => s?.fakeX.base });
  s = await startStack({ ...enclaveEnv, STATED_ENCLAVE_RULINGS: '', STATED_NEAR_NETWORK: 'mainnet',
    STATED_MAINNET: 'real-funds', STATED_TOKEN_KEY: 'k'.repeat(44), STATED_NEAR_CONTRACT: near.contract,
    STATED_OUTLAYER_REFEREE: near.referee, STATED_PLAY: '1', STATED_PLAY_TREASURY: 'play.statedforecast.near',
    STATED_PLAY_TREASURY_KEY: 'synthetic-only', STATED_PILOT_X_IDS: '*', STATED_PLAY_START_NEAR: '1',
    STATED_SPONSOR_LIMIT: '1', STATED_REPUTATION_TIERS: 'off', STATED_EVIDENCE_WINDOW_SECONDS: '60' },
  { fetchImpl, chain: near.chain });
  t.after(() => s.close());
  const signIn = async (id, name) => {
    const user = s.fakeX.addUser(id, name);
    const b = await s.signIn(user);
    await b.submit('/setup', { profile: 'private', defaults: 'private' });
    return b;
  };
  return { s, near, signIn, fetchImpl };
}

test('mainnet home shows honest counters and all bet sections; court reads actual keys and outages', async t => {
  const { s, near } = await stack(t);
  const home = await s.browser().get('/');
  assert.equal(home.status, 200);
  for (const words of ['0 bets', '0 settled', '0 NEAR won', '0 bets taken by people outside the team',
    'Open offers', 'Bets in progress', 'Finished bets', 'Sign in with X, add NEAR']) assert.ok(home.text.includes(words), words);
  const court = await s.browser().get('/court');
  assert.equal(court.status, 200);
  assert.match(court.text, /0 access keys/);
  assert.match(court.text, /nearblocks\.io\/address\/referee\.statedforecast\.near#contract/);
  for (const model of ['Qwen/Qwen3.8-27B', 'deepseek-ai/DeepSeek-V4.1-Flash-1017', 'z-ai/glm-5.3-flash']) assert.ok(court.text.includes(model));
  assert.doesNotMatch(court.text, /Sputnik|Stated Court/);
  near.chain.readAccessKeys = async () => { throw new Error('synthetic outage'); };
  const down = await s.browser().get('/court');
  assert.equal(down.status, 503);
  assert.doesNotMatch(down.text, /0 access keys/);
});

test('sponsored wallet reports actual grant, falls back after quota, refreshes only the signed-in account', async t => {
  const { s, near, signIn } = await stack(t);
  const alice = await signIn('8701', 'launchalice');
  const need = yocto('0.21');
  const opening = await alice.get(`/me/wallet?need=${need}`);
  assert.match(opening.text, new RegExp(`name="need" value="${need}"`));
  const opened = await alice.submit('/me/wallet/open', { need });
  assert.match(opened.text, /Stated put 1 NEAR in this account\. It is yours to bet or withdraw/);
  assert.match(opened.text, /data-funding-balance>1 NEAR/);
  assert.match(opened.text, /Needed for this bet: <b>0\.21 NEAR/);
  assert.match(opened.text, /data-copy="funding-account"/);
  const account = await playAccountFor(s.db, '8701');
  near.deliver(account.account_id, yocto('0.25'), { wrapped: false });
  const updated = await alice.get(`/me/wallet/balance?need=${need}`);
  assert.equal(updated.status, 200);
  assert.equal(JSON.parse(updated.text).balanceNear, '1.25');
  assert.equal(updated.headers.get('cache-control'), 'no-store');
  const bob = await signIn('8702', 'launchbob');
  const fallback = await bob.submit('/me/wallet/open', {});
  assert.match(fallback.text, /data-funding-balance>0\.05 NEAR/);
  assert.doesNotMatch(fallback.text, /Stated put 1 NEAR/);
  const other = JSON.parse((await bob.get(`/me/wallet/balance?need=${need}`)).text);
  assert.equal(other.accountId, 'launchbob.play.statedforecast.near');
  assert.equal(other.balanceNear, '0.05');
  assert.equal((await bob.get('/me/wallet/balance?need=-1')).status, 400);
  assert.equal((await s.browser().request('GET', '/me/wallet/balance')).status, 303);
});

for (const outcome of ['yes', 'void']) test(`new X users make, fund and take a web bet, then see the OutLayer ${outcome} ruling and payout`, async t => {
  const { s, near, signIn, fetchImpl } = await stack(t);
  const alice = await signIn('8801', 'webmaker');
  await alice.submit('/me/wallet/open', {});
  const form = await alice.get('/me/bets/new');
  const requestId = /name="requestId" value="([^"]+)"/.exec(form.text)[1];
  const action = /<form method="post" action="(\/me\/bets)"/.exec(form.text)[1];
  const made = await alice.submit(action, { requestId, claim: 'A synthetic release ships.',
    criteria: 'The official release is public.', evidenceSourceUrl: 'https://www.sec.gov/newsroom',
    creatorSide: 'yes', stakeNear: '0.1', acceptBy: new Date(Date.now() + 3600000).toISOString(),
    resolveAt: new Date(Date.now() + 7200000).toISOString() });
  assert.equal(made.status, 200);
  const id = /\/bets\/([a-f0-9-]{36})/.exec(made.url)[1];
  assert.match(made.text, /name="managed" value="1"/);
  const funded = await Promise.all(Array.from({ length: 3 }, () => alice.submit(`/bets/${id}/fund`, { managed: '1' })));
  assert.ok(funded.every(result => result.status === 200));
  assert.equal(near.sent.filter(tx => tx.method === 'create_bet' && tx.args.id === id).length, 1, 'concurrent web funding signs once');
  assert.equal((await alice.submit(`/bets/${id}/fund`, { managed: '1' })).status, 200);
  assert.equal(near.sent.filter(tx => tx.method === 'create_bet' && tx.args.id === id).length, 1, 'repeating a funded request only recovers its state');
  assert.equal(near.bets.get(id).status, 'offered');
  await alice.get(`/bets/${id}/publication`);
  assert.equal((await alice.submit(`/bets/${id}/publish`, { confirm: '1' })).status, 200);
  const bob = await signIn('8802', 'webtaker');
  await bob.submit('/me/wallet/open', {});
  const empty = await bob.get(`/bets/${id}?join=1`);
  assert.match(empty.text, /webtaker\.play\.statedforecast\.near/);
  assert.match(empty.text, /Needed for this bet: <b>0\.1 NEAR/);
  assert.match(empty.text, /data-copy="funding-account"/);
  assert.match(empty.text, /Use a NEAR wallet/);
  near.deliver('webtaker.play.statedforecast.near', yocto('0.3'), { wrapped: false });
  const row = await s.db.one('select * from bilateral_bets where id=$1', [id]);
  const taken = await bob.submit(`/bets/${id}/take`, { termsHash: row.terms_hash, publicConsent: '1' });
  assert.equal(taken.status, 200);
  assert.equal(near.bets.get(id).status, 'accepted');
  assert.match((await s.browser().get('/')).text, /Bets in progress/);
  t.mock.timers.enable({ apis: ['Date'], now: outlayerDeadlineMs(row) + 61000 });
  near.queueRuling(id, { outcome });
  assert.equal((await runOutlayerKeeper(s.db, s.config, { chain: near.chain, fetchImpl })).errors, 0);
  assert.equal((await settleReplyBets(s.db, s.config, near.chain, { fetchImpl })).errors, 0);
  assert.equal(near.bets.get(id).status, 'settled');
  const court = await s.browser().get('/court');
  // This status-only referee fixture has no accepted-attempt nonce. The
  // verified latest request is linked without claiming it caused settlement.
  assert.match(court.text, /Ruling request/);
  assert.match(court.text, outcome === 'yes' ? /Yes/ : /Void/);
  const home = await s.browser().get('/');
  assert.match(home.text, /1 settled/);
  assert.match(home.text, outcome === 'yes' ? /0\.2 NEAR won/ : /0 NEAR won/);
  assert.match(home.text, /Finished bets/);
});
