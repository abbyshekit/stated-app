// Mainnet mode: real NEAR. The same stack as the reply-bet tests, with the
// process on mainnet, a fake NEAR that also models the wrapped-NEAR contract,
// and a stand-in for NEAR Intents. Nothing here reaches a network.
//
// What must hold with real NEAR: nobody outside the operator's list gets an
// account; the treasury pays a new account's network fees and never a stake;
// a stake is paid in by the person, from another chain or straight to the
// account; and what arrives wrapped is unwrapped before it is counted.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startStack } from './support/app.mjs';
import { FakeNear } from './support/fake-near.mjs';
import { assertNetworkConfig, loadConfig } from '../src/config.mjs';
import { refreshOpenDeposits } from '../src/funding.mjs';
import { isAccount, network } from '../src/near-network.mjs';
import { assertDatabaseNetwork, claimPlayAccount, ensureFunds, playAccountFor, shortfall, topUpReferee, yocto } from '../src/play.mjs';
import { prepareNearAction } from '../src/near-bets.mjs';
import { runBetCommands, settleReplyBets } from '../src/reply-bets.mjs';
import { createApp } from '../src/web.mjs';
import { tick } from '../src/worker.mjs';

const NEXT = new Date().getUTCFullYear() + 1;
const TREASURY = 'stated.near';
const NEAR = (n) => BigInt(yocto(n));
let s; let near; let X; let adminB;
const run = () => runBetCommands(s.db, s.config, near.chain, { fetchImpl: near.fetchImpl, botUsername: 'statedbot' });
const settle = () => settleReplyBets(s.db, s.config, near.chain, { fetchImpl: near.fetchImpl });
const one = (sql, params) => s.db.one(sql, params);
const botPosts = () => [...s.fakeX.posts.values()].filter((p) => p.author_id === '500');
const repliesTo = (id) => botPosts().filter((p) => (p.referenced_tweets || []).some((r) => r.id === id)).map((p) => p.text.replace(/^(@\w+ )+/, ''));
const tag = (user, text, replyTo) => s.fakeX.post(user.id, text, { replyTo: replyTo.id });
const held = (accountId) => near.accounts.get(accountId).balance;
const accountOf = async (user) => (await playAccountFor(s.db, user.id)).account_id;
// A payment is looked at no more than once every four seconds; a test that changes its state says the last look was long ago.
const due = (id) => s.db.query(`update play_deposits set checked_at = clock_timestamp() - interval '1 minute' where id = $1`, [id]);

// NEAR Intents, as funding.mjs uses it: a list of tokens, a real quote with an address, and where a payment stands.
const pay = { asked: [], states: new Map() };
const deliveries = new Map();
const intents = {
  async tokens() {
    return [{ assetId: 'nep141:base-usdc.omft.near', symbol: 'USDC', chain: 'base', chainName: 'Base' },
      { assetId: 'nep141:btc.omft.near', symbol: 'BTC', chain: 'btc', chainName: 'Bitcoin' }];
  },
  async quote(assetId) {
    return assetId.includes('btc') ? { ok: true, amount: '0.0000171', usd: '1.80', seconds: 1500, at: new Date('2026-11-10T22:44:21Z') }
      : { ok: true, amount: '0.725', usd: '0.72', seconds: 37, at: new Date('2026-11-10T22:44:21Z') };
  },
  async deposit(input) {
    pay.asked.push(input);
    if (input.assetId.includes('btc')) return { ok: false, reason: 'minimum', minimumYocto: '1315773292956857495881383' };
    if (input.refundTo.startsWith('0xbad')) return { ok: false, reason: 'refused', message: 'refundTo is not valid' };
    if (input.refundTo.startsWith('0xdown')) return { ok: false, reason: 'unavailable' };
    const depositAddress = `0xPayHere${pay.asked.length}`;
    pay.states.set(depositAddress, { state: 'PENDING_DEPOSIT' });
    return { ok: true, depositAddress, depositMemo: null, amountIn: '1801942', amountInFormatted: '1.801942', minAmountInFormatted: '1.783923',
      deadline: new Date(Date.now() + 3600 * 1000), seconds: 37, signed: { correlationId: 'corr-0001', signature: 'ed25519:sig', quote: {} } };
  },
  async status({ depositAddress }) {
    const found = pay.states.get(depositAddress);
    return found ? { ok: true, deliveredYocto: null, destinationTx: null, refunded: null, refundReason: null, ...found } : { ok: false, reason: 'unknown' };
  },
};

const MAINNET = {
  STATED_NEAR_NETWORK: 'mainnet', STATED_MAINNET: 'real-funds', STATED_TOKEN_KEY: 'k'.repeat(44),
  STATED_NEAR_CONTRACT: 'escrow.stated.near', STATED_PLAY: '1', STATED_PLAY_TREASURY: TREASURY, STATED_PLAY_TREASURY_KEY: 'ed25519:test-treasury-secret',
  STATED_PILOT_X_IDS: '7001,7002,7004', STATED_INTENTS_QUOTES: '1', STATED_INTENTS_DEPOSITS: '1', STATED_PLAY_SETTLE_DELAY_SECONDS: '0',
};

before(async () => {
  near = new FakeNear({ contract: 'escrow.stated.near' });
  near.chain.depositDelivery = async ({ transactionHash, accountId }) => {
    const delivery = deliveries.get(transactionHash);
    return delivery?.accountId === accountId ? delivery : null;
  };
  near.accounts.set(TREASURY, { balance: NEAR('10'), keys: new Set(['ed25519:treasury']) });
  s = await startStack(MAINNET, { fetchImpl: near.fetchImpl, chain: near.chain, intents });
  await s.connectBot(s.fakeX.addUser('500', 'statedbot'));
  X = Object.fromEntries(['oskar', 'priya', 'walkin', 'lena'].map((name, i) => [name, s.fakeX.addUser(String(7001 + i), name)]));
  adminB = await s.signIn(s.fakeX.addUser('900', 'reviewer'));
  await adminB.submit('/setup', { profile: 'private', defaults: 'private' });
});
after(async () => { await s?.close(); });

test('the browser wallet cannot prepare a real stake outside the pilot list', async () => {
  for (const action of ['fund', 'accept']) {
    await assert.rejects(prepareNearAction(null, s.config, { x_user_id: X.walkin.id }, 'unused', { action }), { status: 403 });
  }
});

test('the fee grant cannot fund even a small real stake', async () => {
  const account = { account_id: 'new.stated.near', granted_yocto: yocto('0.15') };
  const chain = { balance: async () => yocto('0.15'), callFunds: async () => ({ balance: NEAR('0.15'), reserve: NEAR('0.10682') }) };
  assert.equal(await shortfall(s.config, chain, account, yocto('0.00001')), yocto('0.00001'));
  assert.equal(await shortfall(s.config, { ...chain, callFunds: async () => ({ balance: NEAR('0.13'), reserve: NEAR('0.10682') }) }, account, '0'), '0',
    'withdrawing requires a fee reserve, even if fees have eaten into the original grant');
});

test('mainnet refuses a stake and a withdrawal when the account cannot cover the receipt gas', async () => {
  const account = { account_id: 'new.stated.near', granted_yocto: yocto('0.05') };
  const chain = { balance: async () => yocto('0.09'), callFunds: async () => ({ balance: NEAR('0.09'), reserve: NEAR('0.10682') }) };
  await assert.rejects(ensureFunds(null, s.config, chain, account, yocto('0.02')), { funds: true, shortYocto: yocto('0.03682') });
  await assert.rejects(ensureFunds(null, s.config, chain, account, '0'), { funds: true, shortYocto: yocto('0.01682') });
});

test('mainnet has to be asked for in so many words, with a treasury and a real sealing key', () => {
  const refused = (env, pattern) => assert.throws(() => assertNetworkConfig(loadConfig(env)), pattern);
  refused({ STATED_NEAR_NETWORK: 'mainnet' }, /STATED_MAINNET must be set to real-funds/);
  refused({ ...MAINNET, STATED_PLAY_TREASURY: '', STATED_PLAY_TREASURY_KEY: '' }, /there is no faucet on mainnet/);
  refused({ ...MAINNET, STATED_TOKEN_KEY: 'short' }, /at least 32 bytes/);
  refused({ ...MAINNET, STATED_NEAR_CONTRACT: 'escrow.testnet' }, /must be a \.near account/);
  refused({ ...MAINNET, STATED_PLAY_TREASURY: 'stated.testnet' }, /must be a \.near account/);
  assert.throws(() => createApp({ db: s.db, config: loadConfig({ STATED_NEAR_NETWORK: 'mainnet' }) }), /Mainnet configuration refused/, 'no app is built on an unacknowledged mainnet configuration');
  const config = loadConfig(MAINNET);
  assert.doesNotThrow(() => assertNetworkConfig(config));
  assert.equal(config.play.autoProvision, false, 'never the faucet');
  assert.equal(loadConfig({ ...MAINNET, STATED_PLAY_AUTOPROVISION: '1' }).play.autoProvision, false);
  assert.equal(config.play.startNear, '0.05');
  assert.equal(loadConfig({ ...MAINNET, STATED_INTENTS_DEPOSITS: '' }).intents.deposits, false);
  assert.equal(network().id, 'mainnet');
  assert.equal(isAccount('alice.near'), true);
  assert.equal(isAccount('alice.testnet'), false, 'a testnet name is not an account here');
});

test('a database belongs to one network', async () => {
  await assertDatabaseNetwork(s.db, s.config);
  await assertDatabaseNetwork(s.db, s.config);
  await assert.rejects(assertDatabaseNetwork(s.db, { near: { network: 'testnet' } }), /belongs to NEAR mainnet\. A testnet server needs a database of its own\./);
});

let post; let firstTry;

test('someone who is not on the list gets no account and one plain answer', async () => {
  post = s.fakeX.post(X.priya.id, `Nightjar 2.0 ships a stable release before March 1, ${NEXT}.`);
  const cmd = tag(X.walkin, '@statedbot bet 0.2 no', post);
  await tick(s.db, s.config, s.x);
  assert.deepEqual(await run(), { done: 0, refused: 1, retry: 0, failed: 0 });
  await tick(s.db, s.config, s.x);
  assert.deepEqual(repliesTo(cmd.id), ['Bets with real NEAR are invite-only for now.']);
  assert.equal(await playAccountFor(s.db, X.walkin.id), null);
  assert.equal(held(TREASURY), NEAR('10'), 'the treasury has paid for nothing');
  const b = await s.signIn(X.walkin);
  await b.submit('/setup', { profile: 'private', defaults: 'private' });
  const wallet = await b.get('/me/wallet');
  assert.match(wallet.text, /invite-only for now/);
  assert.doesNotMatch(wallet.text, /Open my account/);
});

test('a listed person gets an account with network fees only, and a stake they have not paid in is refused with the way to add it', async () => {
  // The first real command also makes the referee account, which is the operator's own cost.
  const before = held(TREASURY) - NEAR('0.3');
  firstTry = tag(X.oskar, '@statedbot bet 0.2 no', post);
  await tick(s.db, s.config, s.x);
  assert.deepEqual(await run(), { done: 0, refused: 1, retry: 0, failed: 0 });
  const id = await accountOf(X.oskar);
  assert.equal(id, 'oskar.stated.near');
  assert.equal(held(id), NEAR('0.05'), 'enough for fees, not for a stake');
  assert.equal(held('referee.stated.near'), NEAR('0.3'));
  assert.equal(before - held(TREASURY), NEAR('0.05'), 'and that is all the treasury paid toward the person');
  await tick(s.db, s.config, s.x);
  assert.deepEqual(repliesTo(firstTry.id), [`Your account does not hold enough NEAR for that stake yet. Add some from any chain: ${s.config.baseUrl}/me/wallet`]);
  assert.equal(near.bets.size, 0, 'nothing reached the escrow');
  const offer = await one(`select status from bilateral_bets order by created_at desc limit 1`);
  assert.equal(offer.status, 'cancelled', 'the unfunded offer does not linger');
});

let oskarB; let firstPayment;

test('the wallet page takes a payment from another chain: an amount, a token and the address it will come from', async () => {
  oskarB = await s.signIn(X.oskar);
  const wallet = await oskarB.get('/me/wallet');
  assert.match(wallet.text, /<p class="lead bal"><span class="tok md"><img src="\/static\/tokens\/chain-near\.png\?v=[0-9a-f]{10}" alt="" width="32" height="32"><\/span>0\.05 NEAR<span><\/span><\/p>/);
  // A logo is served from this origin, as a PNG that may be kept; anything not in the set is not found.
  const logo = await s.browser().get(/src="(\/static\/tokens\/chain-near\.png\?v=[0-9a-f]{10})"/.exec(wallet.text)[1]);
  assert.equal(logo.status, 200);
  assert.equal(logo.headers.get('content-type'), 'image/png');
  assert.match(logo.headers.get('cache-control'), /immutable/);
  assert.equal((await s.browser().get('/static/tokens/chain-nope.png')).status, 404);
  assert.equal((await s.browser().get('/static/tokens/ATTRIBUTION.md')).status, 404);
  assert.doesNotMatch(wallet.text, /test NEAR|testnet/);
  assert.match(wallet.text, /<label for="add-refund">Refund address<\/label>/);
  assert.match(wallet.text, /placeholder="Your own wallet, not an exchange"/);
  assert.match(wallet.text, /Add NEAR from another chain/);
  assert.match(wallet.text, /<option value="nep141:base-usdc\.omft\.near" selected>USDC on Base<\/option>/);
  assert.match(wallet.text, /https:\/\/nearblocks\.io\/address\/oskar\.stated\.near/);

  const tooSmall = await oskarB.submit('/me/wallet/pay', { near: '0.5', pay: 'nep141:btc.omft.near', refundTo: 'bc1qexampleaddress0000' }, { from: '/me/wallet' });
  assert.equal(tooSmall.status, 400);
  assert.match(tooSmall.text, /BTC on Bitcoin moves at least 1\.32 NEAR at a time\./);
  // The cost on the form is always for the token that is selected: it is asked for again, never carried over.
  assert.match(wallet.text, /<p class="cost" id="add-cost"><span class="tok sm"><img [^>]*><img class="on" [^>]*><\/span><span>0\.5 NEAR costs about 0\.725 USDC on Base\.<\/span><\/p>/);
  assert.match(tooSmall.text, /<p class="cost" id="add-cost"><span class="tok sm"><img [^>]*><\/span><span>0\.5 NEAR costs about 0\.0000171 BTC on Bitcoin\.<\/span><\/p>/);
  assert.doesNotMatch(tooSmall.text, /0\.725/);
  const badRefund = await oskarB.submit('/me/wallet/pay', { near: '0.5', pay: 'nep141:base-usdc.omft.near', refundTo: '0xbad0000000000000000000000000000000000000' }, { from: '/me/wallet' });
  assert.match(badRefund.text, /Check that the refund address is a Base address\./);
  assert.match(badRefund.text, /value="0xbad0000000000000000000000000000000000000"/, 'what was typed is kept');
  for (const nearAmount of ['5', 'abc', '0.01']) {
    const res = await oskarB.submit('/me/wallet/pay', { near: nearAmount, pay: 'nep141:base-usdc.omft.near', refundTo: '0x1111111111111111111111111111111111111111' }, { from: '/me/wallet' });
    assert.match(res.text, /id="add-near"[^>]* class="bad"[^>]*>\s*<p class="err" id="add-error" role="alert">Enter 0\.05 to 2 NEAR\.<\/p>/, 'the message sits under the field it is about');
  }
  const noAddress = await oskarB.submit('/me/wallet/pay', { near: '0.5', pay: 'nep141:btc.omft.near', refundTo: 'x' }, { from: '/me/wallet' });
  assert.match(noAddress.text, /Enter a Bitcoin address for refunds\./);
  const down = await oskarB.submit('/me/wallet/pay', { near: '0.5', pay: 'nep141:base-usdc.omft.near', refundTo: '0xdown00000000000000000000000000000000000' }, { from: '/me/wallet' });
  assert.equal(down.status, 503);
  assert.match(down.text, /<p class="err whole" id="add-error" role="alert">NEAR Intents could not be reached\. Nothing was started; try again shortly\.<\/p>\s*<button/, 'said on the form above the button, with what was typed kept');
  assert.doesNotMatch(down.text, /id="add-refund"[^>]* class="bad"/, 'no field is marked wrong for a fault that is not the person’s');
  assert.match(down.text, /value="0xdown00000000000000000000000000000000000"/);
  assert.equal(await one('select 1 as found from play_deposits limit 1'), null, 'a refused request records nothing');

  const page = await oskarB.submit('/me/wallet/pay', { near: '0.5', pay: 'nep141:base-usdc.omft.near', refundTo: '0x1111111111111111111111111111111111111111' }, { from: '/me/wallet' });
  assert.equal(page.status, 200);
  assert.match(page.url, /\/me\/wallet\/pay\/[0-9a-f-]{36}$/);
  assert.match(page.text, /<h1 class="send">Send <b class="sel" id="pay-amount">1\.801942<\/b> USDC<span>on Base, for 0\.5 NEAR<\/span><\/h1>/);
  assert.match(page.text, /<p class="payhead"><span class="tok lg"><img src="\/static\/tokens\/token-usdc\.png[^>]*><img class="on" src="\/static\/tokens\/chain-base\.png/, 'the token and its chain head the page');
  assert.match(page.text, /Only USDC, only on Base\. Send exactly this amount, once\./);
  assert.match(page.text, /<p class="lead timeleft">Expires in (59|60) min<span>at <time datetime="[0-9T:.\-]+Z">\d\d:\d\d UTC \d{1,2} [A-Z][a-z]{2} \d{4}<\/time><\/span><\/p>/);
  // The address is in blocks of four with no spaces between them, so it reads in groups and copies whole.
  assert.match(page.text, /<p class="payto" id="pay-address"><i>0x<\/i><i>PayH<\/i><i>ere\d+<\/i><\/p>/);
  // The address is also a code to scan and has copy buttons, which a small same-origin script turns on.
  assert.match(page.text, /<svg class="qr" viewBox="0 0 \d+ \d+" role="img" aria-label="QR code of the Base address to pay"/);
  assert.match(page.text, /<button class="pill solid" type="button" data-copy="pay-address" hidden>Copy address<\/button><button class="pill" type="button" data-copy="pay-amount" hidden>Copy amount<\/button>/);
  const script = /<script src="(\/static\/pay\.js\?v=[0-9a-f]{10})" defer><\/script>/.exec(page.text)?.[1];
  assert.ok(script, 'the script is loaded from this origin, never inline');
  const served = await s.browser().get(script);
  assert.equal(served.status, 200);
  assert.match(served.headers.get('content-type'), /^text\/javascript/);
  assert.match(served.text, /navigator\.clipboard\.writeText/);
  assert.match(page.text, /USDC on Base here is the token at <span class="acct">|About this payment/);
  // Pressing the button twice gives the same address, not a second one.
  const again = await oskarB.submit('/me/wallet/pay', { near: '0.5', pay: 'nep141:base-usdc.omft.near', refundTo: '0x1111111111111111111111111111111111111111' }, { from: '/me/wallet' });
  assert.equal(again.url, page.url);
  assert.equal((await one('select count(*)::int as n from play_deposits')).n, 1);
  assert.match(page.text, /Less than 1\.783923 USDC is refunded after the deadline/);
  assert.match(page.text, /0\.5 NEAR arrives in <span class="acct">oskar\.stated\.near<\/span>/);
  assert.match(page.text, /goes back to <span class="acct">0x1111111111111111111111111111111111111111<\/span>/);
  assert.equal(page.headers.get('refresh'), '30', 'the page asks again by itself, slowly enough that an address can be copied');
  firstPayment = page.url.split('/').pop();
  const asked = pay.asked.at(-1);
  assert.deepEqual({ ...asked }, { assetId: 'nep141:base-usdc.omft.near', yocto: yocto('0.5'), recipient: 'oskar.stated.near', refundTo: '0x1111111111111111111111111111111111111111' });
  // The account was registered with the wrapped-NEAR contract before the quote was asked for, once, from its own fee money.
  const registrations = near.sent.filter((t) => t.method === 'storage_deposit');
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].signerId, 'oskar.stated.near');
  assert.equal(registrations[0].gas, 30_000_000_000_000n, 'a new fee-only account can reserve this much gas');
  assert.equal(held('oskar.stated.near'), NEAR('0.05') - 1250000000000000000000n);
  const row = await one('select * from play_deposits where id = $1', [firstPayment]);
  assert.equal(row.signed.correlationId, 'corr-0001', 'the signed quote is kept');
  // Another person cannot read it.
  const other = await s.signIn(X.priya);
  await other.submit('/setup', { profile: 'private', defaults: 'private' });
  assert.equal((await other.get(`/me/wallet/pay/${firstPayment}`)).status, 404);
});

test('NEAR that arrives wrapped is unwrapped, and the page stops asking', async () => {
  const address = (await one('select deposit_address from play_deposits where id = $1', [firstPayment])).deposit_address;
  pay.states.set(address, { state: 'PROCESSING' });
  await due(firstPayment);
  const moving = await oskarB.get(`/me/wallet/pay/${firstPayment}`);
  assert.match(moving.text, /<h1 role="status">0\.5 NEAR on its way<\/h1><p>paid with USDC on Base<\/p>/);
  assert.doesNotMatch(moving.text, /class="payto"|class="qr"|pay\.js/, 'once paid, the address, its code and the copy buttons are gone');
  assert.equal(moving.headers.get('refresh'), '8', 'with no address to copy, it asks more often');

  const beforeArrival = held('oskar.stated.near');
  const destinationTx = '9'.repeat(44);
  pay.states.set(address, { state: 'SUCCESS', deliveredYocto: yocto('0.5'), destinationTx });
  await due(firstPayment);
  const waiting = await oskarB.get(`/me/wallet/pay/${firstPayment}`);
  assert.match(waiting.text, /Confirming your payment/);
  assert.equal(waiting.headers.get('refresh'), '8');
  assert.equal((await one('select finished_at from play_deposits where id = $1', [firstPayment])).finished_at, null);
  deliveries.set(destinationTx, { final: true, kind: 'wrapped', accountId: 'oskar.stated.near', deliveredYocto: yocto('0.5') });
  near.deliver('oskar.stated.near', yocto('0.5'));
  await due(firstPayment);
  const done = await oskarB.get(`/me/wallet/pay/${firstPayment}`);
  assert.match(done.text, /<h1 role="status">0\.5 NEAR is in your account<\/h1>/);
  assert.doesNotMatch(done.text, /class="payto"/, 'a finished payment no longer shows where to pay');
  assert.match(done.text, new RegExp(`https://nearblocks\\.io/txns/${'9'.repeat(44)}`));
  assert.equal(done.headers.get('refresh'), null);
  const unwraps = near.sent.filter((t) => t.method === 'near_withdraw');
  assert.equal(unwraps.length, 1);
  assert.deepEqual(unwraps[0], { signerId: 'oskar.stated.near', method: 'near_withdraw', args: { amount: yocto('0.5') }, depositYocto: '1', gas: 30_000_000_000_000n });
  assert.equal(held('oskar.stated.near'), beforeArrival + NEAR('0.5'), 'plain NEAR, ready to stake');
  assert.equal(near.wrapped.get('oskar.stated.near'), 0n);
  const row = await one('select * from play_deposits where id = $1', [firstPayment]);
  assert.ok(row.finished_at);
  assert.ok(row.unwrap_tx);
  // Looking again does nothing more.
  await oskarB.get(`/me/wallet/pay/${firstPayment}`);
  assert.equal(near.sent.filter((t) => t.method === 'near_withdraw').length, 1);
  const after = await oskarB.get('/me/wallet');
  // With payments on the list, the form gives way to one button; asking for it brings it back.
  assert.match(after.text, /<a class="pill solid big" href="\/me\/wallet\?add#add">Add NEAR from another chain<\/a>/);
  assert.doesNotMatch(after.text, /id="add-refund"/);
  assert.match((await oskarB.get('/me/wallet?add')).text, /id="add-refund"/);
  assert.match(after.text, /<p class="lead bal"><span class="tok md"><img [^>]*><\/span>0\.55 NEAR<span><\/span><\/p>/);
  assert.match(after.text, /<summary>Past payments<\/summary><ul class="pays past"><li><a href="\/me\/wallet\/pay\/[0-9a-f-]{36}"><span class="tok"><img [^>]*><img class="on" [^>]*><\/span><b>0\.5 NEAR with USDC on Base<\/b><span>In your account<\/span>/, 'a finished payment is kept behind one row');
});

test('NEAR that arrives plain needs no unwrapping, and the worker finishes a payment with its page closed', async () => {
  const page = await oskarB.submit('/me/wallet/pay', { near: '0.1', pay: 'nep141:base-usdc.omft.near', refundTo: '0x1111111111111111111111111111111111111111' }, { from: '/me/wallet' });
  const id = page.url.split('/').pop();
  const address = (await one('select deposit_address from play_deposits where id = $1', [id])).deposit_address;
  assert.equal(near.sent.filter((t) => t.method === 'storage_deposit').length, 1, 'registered once, not again');
  near.deliver('oskar.stated.near', yocto('0.1'), { wrapped: false });
  const destinationTx = '8'.repeat(44);
  deliveries.set(destinationTx, { final: true, kind: 'native', accountId: 'oskar.stated.near', deliveredYocto: yocto('0.1') });
  pay.states.set(address, { state: 'SUCCESS', deliveredYocto: yocto('0.1'), destinationTx });
  await due(id);
  assert.equal(await refreshOpenDeposits(s.db, s.config, near.chain, intents), 1);
  const row = await one('select * from play_deposits where id = $1', [id]);
  assert.equal(row.state, 'SUCCESS');
  assert.ok(row.finished_at);
  assert.equal(row.unwrap_tx, null);
  assert.equal(near.sent.filter((t) => t.method === 'near_withdraw').length, 1, 'nothing was wrapped, so nothing was unwrapped');
});

test('a refunded payment says where the money went back to, and an unpaid address lapses', async () => {
  const page = await oskarB.submit('/me/wallet/pay', { near: '0.1', pay: 'nep141:base-usdc.omft.near', refundTo: '0x1111111111111111111111111111111111111111' }, { from: '/me/wallet' });
  const id = page.url.split('/').pop();
  const address = (await one('select deposit_address from play_deposits where id = $1', [id])).deposit_address;
  pay.states.set(address, { state: 'REFUNDED', refunded: '0.36', refundReason: 'Deposit below the minimum' });
  await due(id);
  const refunded = await oskarB.get(`/me/wallet/pay/${id}`);
  assert.match(refunded.text, /<h1 role="status">Refunded<\/h1><p>It was for 0\.1 NEAR with USDC on Base\. 0\.36 USDC went back to 0x1111…1111\. It needed 1\.801942 USDC\.<\/p>/);
  assert.match(refunded.text, /NEAR Intents gave this reason for the refund: Deposit below the minimum/);
  assert.match(refunded.text, /goes back to <span class="acct">0x1111111111111111111111111111111111111111<\/span>/, 'the whole refund address is under About this payment');
  assert.equal(refunded.headers.get('refresh'), null);

  const stale = await oskarB.submit('/me/wallet/pay', { near: '0.1', pay: 'nep141:base-usdc.omft.near', refundTo: '0x1111111111111111111111111111111111111111' }, { from: '/me/wallet' });
  assert.match(stale.text, /class="payto"/);
  const staleId = stale.url.split('/').pop();
  // The moment the deadline passes the address is gone from the page, though a payment sent just in time is still followed.
  await s.db.query(`update play_deposits set deadline = clock_timestamp() - interval '5 minutes', checked_at = null where id = $1`, [staleId]);
  const justPast = await oskarB.get(`/me/wallet/pay/${staleId}`);
  assert.match(justPast.text, /<h1>This address has expired<\/h1><p>It was for 0\.1 NEAR with USDC on Base\.<\/p><\/div>\s*<p class="lead">Do not send to it\.<\/p>/);
  assert.doesNotMatch(justPast.text, /class="payto"|class="qr"/, 'an address past its deadline is not shown, as text or as a code');
  assert.match(justPast.text, /Sent before it expired\? This page catches up when the payment is seen\./);
  assert.match(justPast.text, /href="\/me\/wallet\?add=0\.1#add">Get a new address</);
  assert.equal(justPast.headers.get('refresh'), '8', 'still followed, in case it was paid at the last minute');
  assert.equal((await one('select state from play_deposits where id = $1', [staleId])).state, 'PENDING_DEPOSIT');
  assert.match((await oskarB.get('/me/wallet')).text, /<ul class="pays"><li><a href="\/me\/wallet\/pay\/[0-9a-f-]{36}"><span class="tok"><img [^>]*><img class="on" [^>]*><\/span><b>0\.1 NEAR with USDC on Base<\/b><span>Expired<\/span>/, 'a payment still open is listed under the balance');
  // An hour later it is closed for good.
  await s.db.query(`update play_deposits set deadline = clock_timestamp() - interval '2 hours', checked_at = null where id = $1`, [staleId]);
  const lapsedPage = await oskarB.get(`/me/wallet/pay/${staleId}`);
  assert.match(lapsedPage.text, /This address has expired/);
  assert.match(lapsedPage.text, /Sent it anyway\? Give NEAR Intents this ID\./);
  assert.match(lapsedPage.text, /<span class="acct" id="pay-ref">corr-0001<\/span>/, 'the ID the button copies is under About this payment');
  assert.match(lapsedPage.text, /<button class="pill" type="button" data-copy="pay-ref" hidden>Copy ID<\/button>/);
  assert.equal(lapsedPage.headers.get('refresh'), null);
  assert.equal((await one('select state from play_deposits where id = $1', [staleId])).state, 'EXPIRED');
});

test('an expired partial payment hides instructions and preserves the exact amount on retry', async () => {
  const page = await oskarB.submit('/me/wallet/pay', { near: '0.0549', pay: 'nep141:base-usdc.omft.near',
    refundTo: '0x1111111111111111111111111111111111111111' }, { from: '/me/wallet' });
  const id = page.url.split('/').pop();
  const { deposit_address: address } = await one('select deposit_address from play_deposits where id = $1', [id]);
  pay.states.set(address, { state: 'INCOMPLETE_DEPOSIT' });
  await s.db.query(`update play_deposits set deadline = clock_timestamp() - interval '2 hours', checked_at = null where id = $1`, [id]);
  const expired = await oskarB.get(`/me/wallet/pay/${id}`);
  assert.match(expired.text, /This address has expired/);
  assert.match(expired.text, /\?add=0\.0549#add/);
  assert.doesNotMatch(expired.text, /class="payto"|class="qr"|Send the rest/);
  assert.equal(expired.headers.get('refresh'), '8');
  pay.states.set(address, { state: 'REFUNDED', refunded: '0.36' });
  await due(id);
  assert.match((await oskarB.get(`/me/wallet/pay/${id}`)).text, /<h1 role="status">Refunded<\/h1>/);
});

let offerCmd; let betId;

test('with their own NEAR in the account, the same reply funds the bet, and the treasury pays nothing', async () => {
  const treasuryBefore = held(TREASURY);
  const mine = held('oskar.stated.near');
  offerCmd = tag(X.oskar, '@statedbot bet 0.2 no', post);
  await tick(s.db, s.config, s.x);
  assert.deepEqual(await run(), { done: 1, refused: 0, retry: 0, failed: 0 });
  betId = (await one('select bet_id from bet_commands where event_id = $1', [offerCmd.id])).bet_id;
  assert.equal(near.bets.get(betId).creator, 'oskar.stated.near');
  assert.equal(mine - held('oskar.stated.near'), NEAR('0.21'), 'the stake and the storage fee came out of the person’s own NEAR');
  assert.equal(held(TREASURY), treasuryBefore);
  await tick(s.db, s.config, s.x);
  assert.deepEqual(repliesTo(offerCmd.id), [`0.2 NEAR says this does not happen by 28 Feb ${NEXT}. To take the other side, reply here with "@statedbot take".`]);
});

test('the other side opens an account on the site, sends NEAR straight to it, takes the bet and is paid when right', async () => {
  const priyaB = await s.signIn(X.priya);
  const empty = await priyaB.get('/me/wallet');
  assert.match(empty.text, /Open my account/);
  assert.match(empty.text, /<p class="say">priya\.stated\.near<\/p>/, 'the name the account will have, before it is opened');
  assert.match(empty.text, /It holds real NEAR/);
  const opened = await priyaB.submit('/me/wallet/open', {}, { from: '/me/wallet' });
  assert.match(opened.text, /<p class="lead bal"><span class="tok md"><img [^>]*><\/span>0\.05 NEAR<span><\/span><\/p>/);
  assert.match(opened.text, /Add NEAR from a NEAR wallet/);
  const id = await accountOf(X.priya);
  assert.equal(id, 'priya.stated.near');
  const join = await priyaB.get('/bets/' + betId + '?join=1');
  assert.ok(join.text.includes('Add 0.27 NEAR'), 'the stake also needs a gas reserve and funding overhead');
  near.deliver(id, yocto('0.3'), { wrapped: false });

  const offerPost = botPosts().find((p) => p.text.includes('To take the other side'));
  const takeCmd = tag(X.priya, '@statedbot take', offerPost);
  await tick(s.db, s.config, s.x);
  assert.deepEqual(await run(), { done: 1, refused: 0, retry: 0, failed: 0 });
  await tick(s.db, s.config, s.x);
  assert.deepEqual(repliesTo(takeCmd.id), [`It’s on. 0.4 NEAR is held on NEAR until 28 Feb ${NEXT}. @oskar says no; @priya says yes.`]);

  const bet = await s.browser().get(`/bets/${betId}`);
  assert.equal(bet.status, 200);
  assert.doesNotMatch(bet.text, /test NEAR|testnet/, 'nothing on a mainnet page calls the stake test NEAR');
  assert.doesNotMatch(bet.text, /Cross-chain quote|Pay from another chain/, 'an accepted Bet cannot ask a visitor to fund the open seat');

  const st = await one(`select st.id from statements st join sources src on src.id = st.source_id where src.platform_id = $1`, [post.id]);
  await adminB.submit(`/admin/resolve/${st.id}`, { outcome: 'yes', url: 'https://example.org/evidence', note: 'Release 2.0.0 is tagged.', known: new Date().toISOString().slice(0, 10) }, { from: '/admin' });
  const before = held(id);
  const result = await settle();
  assert.equal(result.errors, 0);
  await tick(s.db, s.config, s.x);
  assert.deepEqual(repliesTo(offerCmd.id).slice(1), ['It happened. @priya wins the 0.4 NEAR pot.']);
  assert.equal(held(id) - before, NEAR('0.4'), 'the pot is in the winner’s account');
  const paid = await priyaB.get(`/bets/${betId}`);
  assert.match(paid.text, /Paid to your account\. <a class="tl" href="https:\/\/nearblocks\.io\/txns\/[1-9A-HJ-NP-Za-km-z]+"/, 'the payout links to the mainnet explorer');
  assert.doesNotMatch(paid.text, /test NEAR|testnet/);
});

test('a database that already holds testnet accounts is refused by a mainnet server', async () => {
  await s.db.query(`delete from kv where key = 'near_network'`);
  await assert.rejects(assertDatabaseNetwork(s.db, s.config), /already holds testnet accounts or Bets/);
  await s.db.query(`insert into kv (key, value) values ('near_network', 'mainnet')`);
});

test('an account its owner has taken is paid into from their own wallet, not through the site', async () => {
  await claimPlayAccount(s.db, s.config, near.chain, X.priya.id, 'ed25519:8hSHprDq2StXwMtNd43wDTXQYsjXcD4MJTXQYsjXcc5');
  const priyaB = await s.signIn(X.priya);
  const wallet = await priyaB.get('/me/wallet');
  assert.match(wallet.text, /<span>yours<\/span>/);
  assert.doesNotMatch(wallet.text, /Add NEAR from another chain/);
  const res = await priyaB.submit('/me/wallet/pay', { near: '0.5', pay: 'nep141:base-usdc.omft.near', refundTo: '0x1111111111111111111111111111111111111111' }, { from: '/me/wallet' });
  assert.equal(res.status, 409);
  assert.match(res.text, /Send NEAR to it from your own wallet/);
});

test('the referee refills below the actual call reserve and stops once funded', async () => {
  const id = 'referee.stated.near';
  near.accounts.get(id).balance = NEAR('0.103');
  const before = held(TREASURY);
  assert.equal(await topUpReferee(s.db, s.config, near.chain), true);
  assert.equal(held(id), NEAR('0.303'));
  assert.equal(before - held(TREASURY), NEAR('0.2'));
  assert.equal(await topUpReferee(s.db, s.config, near.chain), false);
  assert.equal(held(id), NEAR('0.303'));
});

test('with Stated Court the referee is kept able to reserve a 300-Tgas filing or approval', async () => {
  const id = 'referee.stated.near';
  const court = { ...s.config, court: { ...(s.config.court || {}), dao: 'stated-court.sputnik-v2.near' } };
  const { reserve } = await near.chain.callFunds(id, 300_000_000_000_000n);
  const { reserve: ordinary } = await near.chain.callFunds(id);
  // Enough for an ordinary call, one yoctoNEAR short of a Court filing: the state that stalled the first jury ruling.
  near.accounts.get(id).balance = reserve - 1n;
  assert.ok(held(id) >= ordinary);
  assert.equal(await topUpReferee(s.db, s.config, near.chain), false, 'without a Court the ordinary reserve applies');
  const before = held(TREASURY);
  assert.equal(await topUpReferee(s.db, court, near.chain), true);
  assert.equal(held(id), reserve + NEAR('0.2'));
  assert.equal(before - held(TREASURY), NEAR('0.2') + 1n);
  assert.equal(await topUpReferee(s.db, court, near.chain), false);
});

test('a Bet link carries a new user through wallet setup and sufficient funding back to the exact offer', async () => {
  const source = s.fakeX.post(X.priya.id, 'Peregrine 3.0 ships a stable release before March 1, ' + NEXT + '.');
  const offer = tag(X.oskar, '@statedbot bet 0.1 no', source);
  await tick(s.db, s.config, s.x);
  assert.deepEqual(await run(), { done: 1, refused: 0, retry: 0, failed: 0 });
  const { bet_id: ref } = await one('select bet_id from bet_commands where event_id = $1', [offer.id]);
  const path = '/bets/' + ref;
  const take = path + '?join=1';
  const opening = '/me/wallet?bet=' + ref;
  const lenaB = await s.signIn(X.lena);
  await lenaB.submit('/setup', { profile: 'private', defaults: 'private' });
  assert.ok((await lenaB.get(take)).text.includes(opening));
  assert.equal(await playAccountFor(s.db, X.lena.id), null, 'opening the offer does not create a wallet');
  const opened = await lenaB.submit('/me/wallet/open', { bet: ref }, { from: opening });
  assert.equal(new URL(opened.url).pathname, path);
  assert.match(opened.text, /Add 0[.]17 NEAR/);
  const fund = opening + '&add=0.17#add';
  const wallet = await lenaB.get(fund);
  assert.match(wallet.text, /name="near"[^>]+value="0[.]17"/);
  assert.ok(wallet.text.includes('name="bet" value="' + ref + '"'));
  const payment = await lenaB.submit('/me/wallet/pay', {
    near: '0.17', pay: 'nep141:base-usdc.omft.near',
    refundTo: '0x1111111111111111111111111111111111111111', bet: ref,
  }, { from: fund });
  const paymentUrl = new URL(payment.url);
  assert.equal(paymentUrl.searchParams.get('bet'), ref);
  const paymentId = paymentUrl.pathname.split('/').at(-1);
  const row = await one('select * from play_deposits where id = $1', [paymentId]);
  const account = await accountOf(X.lena);
  const destinationTx = '8'.repeat(44);
  assert.equal(row.near_yocto, yocto('0.17'));
  pay.states.set(row.deposit_address, { state: 'SUCCESS', deliveredYocto: row.near_yocto, destinationTx });
  deliveries.set(destinationTx, { final: true, kind: 'wrapped', accountId: account, deliveredYocto: row.near_yocto });
  near.deliver(account, row.near_yocto);
  await due(paymentId);
  const received = await lenaB.get(paymentUrl.pathname + paymentUrl.search);
  assert.ok(received.text.includes('href="' + take + '#accept">Back to bet'));
  const ready = await lenaB.get(take);
  assert.ok(ready.text.includes('action="' + path + '/take"'));
  assert.doesNotMatch(ready.text, /Add 0[.]17 NEAR/);
  const termsHash = (await one('select terms_hash from bilateral_bets where id = $1', [ref])).terms_hash;
  assert.equal((await lenaB.request('POST', path + '/take', { form: { termsHash, publicConsent: '1', csrf: 'wrong' } })).status, 403);
  assert.equal((await lenaB.submit(path + '/take', { termsHash }, { from: take })).status, 400);
  assert.equal(near.bets.get(ref).status, 'offered');
  assert.equal((await lenaB.submit(path + '/take', { termsHash: 'wrong', publicConsent: '1' }, { from: take })).status, 409);
  assert.equal(near.bets.get(ref).status, 'offered');
  const treasuryBefore = held(TREASURY);
  const accepted = await lenaB.submit(path + '/take', { termsHash, publicConsent: '1' }, { from: take });
  assert.match(accepted.text, /Both sides are in/);
  assert.equal(near.bets.get(ref).acceptor, account);
  assert.equal(held(TREASURY), treasuryBefore);
  const requests = near.sent.filter((request) => request.method === 'accept_bet' && request.args.id === ref);
  assert.equal(requests.length, 1);
  await lenaB.submit(path + '/take', { termsHash, publicConsent: '1' }, { from: take });
  assert.equal(near.sent.filter((request) => request.method === 'accept_bet' && request.args.id === ref).length, 1);
});
