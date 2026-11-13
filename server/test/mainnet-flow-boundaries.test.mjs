// Direct handler and funding boundaries with synthetic state and transports.
// These tests do not replace the real PostgreSQL mainnet flow suites.
import test, { beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { registerBetRoutes } from '../src/bet-pages.mjs';
import { registerPlayRoutes } from '../src/play-pages.mjs';
import { useNetwork } from '../src/near-network.mjs';
import { ensureFunds, yocto } from '../src/play.mjs';
import { registerForWrapped, unwrap } from '../src/funding.mjs';
import { fundingPanel, fundingStatus } from '../src/funding-view.mjs';
import { nearUp } from '../src/intents.mjs';
import { seal } from '../src/crypto.mjs';
import { FakeNear } from './support/fake-near.mjs';

beforeEach(() => useNetwork('mainnet'));

function boundary({ claimed = false } = {}) {
  const config = { near: { real: true, network: 'mainnet' }, tokenKey: 'synthetic-only-test-sealing-key',
    play: { enabled: true, fundsStakes: false, pilotXIds: ['*'], treasury: 'stated.near',
      minStakeNear: '0.1', maxStakeNear: '0.25', reputationTiers: null }, intents: { deposits: true }, x: {} };
  const user = { id: '1', x_user_id: '7001', x_username: 'oskar', setup_completed_at: new Date() };
  const account = { account_id: 'oskar.stated.near', x_user_id: '7001', ready: true,
    granted_yocto: yocto('0.05'), claimed_at: claimed ? new Date() : null,
    secret_sealed: claimed ? null : seal('synthetic-only', config.tokenKey) };
  const near = new FakeNear({ contract: 'escrow.stated.near' });
  near.accounts.set(account.account_id, { balance: BigInt(yocto('0.05')), keys: new Set() });
  const routes = [];
  let response;
  const db = {
    async one(sql) {
      assert.match(sql, /^select \* from play_accounts where x_user_id = \$1$/);
      return account;
    },
    async many(sql) {
      assert.match(sql, /^select \* from play_deposits where x_user_id = \$1 order by created_at desc limit 5$/);
      return [];
    },
  };
  const common = { db, config, chain: () => near.chain,
    route: (method, pattern, handler) => routes.push({ method, pattern, handler }),
    needUser: async () => true, layout: async (_ctx, _title, body) => String(body), csrfField: () => '',
    send: (_res, status, body) => { response = { status, text: String(body) }; } };
  registerBetRoutes(common);
  registerPlayRoutes({ ...common, quotes: {
    tokens: async () => [{ assetId: 'base-usdc', symbol: 'USDC', chain: 'base', chainName: 'Base' }],
    quote: async () => ({ ok: true, amount: '0.725' }),
  } });
  return { config, account, near, routes, async get(path) {
    const ctx = { user, res: {}, url: new URL(path, 'http://synthetic.test') };
    const route = routes.find(item => item.method === 'GET' && item.pattern.test(ctx.url.pathname));
    assert.ok(route, `Registered GET handler for ${path}`);
    await route.handler(ctx);
    assert.equal(response.status, 200);
    return response.text;
  } };
}

test('mainnet creation form submits to a registered POST handler', async () => {
  const app = boundary();
  const page = await app.get('/me/bets/new');
  const action = /<form method="post" action="([^"]+)"/.exec(page)?.[1];
  assert.equal(action, '/me/bets');
  assert.ok(app.routes.some(route => route.method === 'POST' && route.pattern.test(action)));
  assert.match(page, /name="stakeNear" value="0\.1" checked/);
});

test('mainnet wallet renders the selected payment token chain logo', async () => {
  const page = await boundary().get('/me/wallet');
  assert.match(page, /src="\/static\/tokens\/chain-base\.png\?v=[0-9a-f]{10}"/);
  assert.match(page, /data-funding-balance>0\.05 NEAR/);
});

test('claimed mainnet wallet states key ownership and omits managed funding', async () => {
  const page = await boundary({ claimed: true }).get('/me/wallet');
  assert.match(page, /You hold the only key\./);
  assert.doesNotMatch(page, /Add NEAR from another chain|action="\/me\/wallet\/claim"/);
});

test('fee-only mainnet wallet registers with 30 Tgas and unwraps its own payment before staking', async () => {
  const { config, account, near } = boundary();
  await registerForWrapped(config, near.chain, account);
  assert.equal(near.sent[0].method, 'storage_deposit');
  assert.equal(near.sent[0].gas, 30_000_000_000_000n);
  const before = BigInt(await near.chain.balance(account.account_id));
  near.deliver(account.account_id, yocto('0.5'));
  assert.ok(await unwrap(config, near.chain, account));
  assert.equal(near.wrapped.get(account.account_id), 0n);
  assert.equal(BigInt(await near.chain.balance(account.account_id)), before + BigInt(yocto('0.5')));
  assert.equal(near.sent.filter(call => call.method === 'near_withdraw').length, 1);
  await ensureFunds(null, config, near.chain, account, yocto('0.21'));
});

test('plain mainnet payment needs no unwrap and covers its own stake', async () => {
  const { config, account, near } = boundary();
  near.deliver(account.account_id, yocto('0.5'), { wrapped: false });
  assert.equal(await unwrap(config, near.chain, account), null);
  assert.equal(await near.chain.balance(account.account_id), yocto('0.55'));
  assert.equal(near.sent.length, 0);
  await ensureFunds(null, config, near.chain, account, yocto('0.21'));
});

for (const [stake, missing, add] of [['0.2', '0.25682', '0.27'], ['0.1', '0.15682', '0.17']]) {
  test(`${stake} mainnet stake shows exact ${missing} shortfall and rounds checkout to ${add}`, async () => {
    const { config, account, near } = boundary();
    const status = await fundingStatus(config, near.chain, account, yocto(stake));
    assert.equal(status.missingNear, missing);
    assert.match(String(fundingPanel(status)), new RegExp(`data-funding-missing>${missing.replace('.', '\\.')} NEAR`));
    const deposit = nearUp((BigInt(yocto(status.missingNear)) + BigInt(yocto('0.01'))).toString());
    assert.equal(deposit, add);
    near.deliver(account.account_id, yocto(deposit), { wrapped: false });
    await ensureFunds(null, config, near.chain, account, yocto(stake));
  });
}
