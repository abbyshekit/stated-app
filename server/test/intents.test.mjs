// Quotes from NEAR Intents: the request is always a dry run for the exact
// stake, answers are kept briefly, and anything unexpected means "no quote".
import test from 'node:test';
import assert from 'node:assert/strict';
import { chainName, intentsQuotes, nearUp, shortAmount } from '../src/intents.mjs';

const USDC = 'nep141:base-0x833589fcd6edb6e08f4c7c32d4f71b54bda02913.omft.near';
const TOKENS = [
  { assetId: 'nep141:wrap.near', symbol: 'wNEAR', blockchain: 'near', decimals: 24 },
  { assetId: 'nep141:sol.omft.near', symbol: 'SOL', blockchain: 'sol', decimals: 9 },
  { assetId: USDC, symbol: 'USDC', blockchain: 'base', decimals: 6 },
  { assetId: 'nep141:btc.omft.near', symbol: 'BTC', blockchain: 'btc', decimals: 8 },
  { assetId: USDC, symbol: 'USDC', blockchain: 'base', decimals: 6 },
  { assetId: 'x'.repeat(300), symbol: 'LONG', blockchain: 'eth' },
  { symbol: 'NOID', blockchain: 'eth' },
];
const json = (status, body) => ({ ok: status >= 200 && status < 300, status, json: async () => body });

function double({ quote = () => json(201, { quote: { amountInFormatted: '1.812585', amountInUsd: '1.8118', timeEstimate: 37 } }), tokens = () => json(200, TOKENS) } = {}) {
  const calls = [];
  const fetchImpl = async (url, init = {}) => {
    calls.push({ url, method: init.method || 'GET', body: init.body ? JSON.parse(init.body) : null });
    return url.endsWith('/v0/tokens') ? tokens() : quote(JSON.parse(init.body));
  };
  return { calls, fetchImpl };
}

test('amounts are written for a sentence, and a minimum is never understated', () => {
  assert.equal(shortAmount('1.812585'), '1.81');
  assert.equal(shortAmount('0.000354190132843697'), '0.000354');
  assert.equal(shortAmount('0.00874444'), '0.00874');
  assert.equal(shortAmount('12345.678'), '12346');
  assert.equal(nearUp('1315773292956857495881383'), '1.32');
  assert.equal(nearUp('500000000000000000000000'), '0.5');
  assert.equal(chainName('base'), 'Base');
  assert.equal(chainName('hood'), 'hood', 'an unknown chain code is shown as it comes, never guessed');
});

test('the token list leaves out NEAR itself, repeats and malformed entries, and is asked for once', async () => {
  const d = double();
  const q = intentsQuotes({ fetchImpl: d.fetchImpl });
  const list = await q.tokens();
  assert.deepEqual(list.map((t) => `${t.symbol} on ${t.chainName}`), ['USDC on Base', 'BTC on Bitcoin', 'SOL on Solana']);
  await q.tokens();
  assert.equal(d.calls.length, 1, 'kept for ten minutes');
});

test('a quote is a dry run for exactly the stake, and is kept for a short while', async () => {
  const d = double();
  let clock = Date.parse('2026-11-10T22:44:00Z');
  const q = intentsQuotes({ fetchImpl: d.fetchImpl, now: () => clock });
  const got = await q.quote(USDC, '500000000000000000000000');
  assert.deepEqual({ ok: got.ok, amount: got.amount, usd: got.usd, seconds: got.seconds }, { ok: true, amount: '1.812585', usd: '1.8118', seconds: 37 });
  const sent = d.calls.find((c) => c.url.endsWith('/v0/quote'));
  assert.equal(sent.method, 'POST');
  assert.equal(sent.body.dry, true, 'never anything but a dry run');
  assert.equal(sent.body.swapType, 'EXACT_OUTPUT');
  assert.equal(sent.body.originAsset, USDC);
  assert.equal(sent.body.destinationAsset, 'nep141:wrap.near');
  assert.equal(sent.body.amount, '500000000000000000000000');
  assert.equal(sent.body.deadline, '2026-11-10T22:59:00.000Z');
  await q.quote(USDC, '500000000000000000000000');
  assert.equal(d.calls.filter((c) => c.url.endsWith('/v0/quote')).length, 1, 'the same question within 45 seconds is not asked again');
  clock += 46000;
  await q.quote(USDC, '500000000000000000000000');
  assert.equal(d.calls.filter((c) => c.url.endsWith('/v0/quote')).length, 2);
});

test('a route with a floor above the stake says what the floor is', async () => {
  const d = double({ quote: () => json(400, { message: 'Amount is too low for bridge, try at least 1315773292956857495881383' }) });
  const got = await intentsQuotes({ fetchImpl: d.fetchImpl }).quote('nep141:btc.omft.near', '200000000000000000000000');
  assert.equal(got.ok, false);
  assert.equal(got.reason, 'minimum');
  assert.equal(got.minimumYocto, '1315773292956857495881383');
});

test('anything unexpected is no quote: an unknown token, a bad amount, an error, a strange answer, no network', async () => {
  const fine = double();
  const q = intentsQuotes({ fetchImpl: fine.fetchImpl });
  assert.deepEqual(await q.quote('nep141:not-listed.near', '1'), { ok: false, reason: 'unknown' });
  assert.equal(fine.calls.some((c) => c.url.endsWith('/v0/quote')), false, 'a token that is not on the list is never sent on');
  assert.equal((await q.quote(USDC, '0')).reason, 'unavailable');
  assert.equal((await q.quote(USDC, '1e24')).reason, 'unavailable');
  for (const quote of [() => json(500, { message: 'down' }), () => json(201, { quote: { amountInFormatted: '-1' } }), () => json(201, { quote: {} }), () => { throw new Error('offline'); }]) {
    const got = await intentsQuotes({ fetchImpl: double({ quote }).fetchImpl }).quote(USDC, '500000000000000000000000');
    assert.deepEqual({ ok: got.ok, reason: got.reason }, { ok: false, reason: 'unavailable' });
  }
  const offline = intentsQuotes({ fetchImpl: double({ tokens: () => { throw new Error('offline'); } }).fetchImpl });
  assert.deepEqual(await offline.tokens(), []);
  assert.deepEqual(await offline.quote(USDC, '500000000000000000000000'), { ok: false, reason: 'unknown' });
});

// ---- real payments: a quote with an address to pay into, and where a payment stands

const REAL = { depositAddress: '0x76b4c56085ED136a8744D52bE956396624a730E8', amountIn: '1801942', amountInFormatted: '1.801942', minAmountIn: '1783923',
  amountOut: '500000000000000000000000', deadline: new Date(Date.now() + 3600 * 1000).toISOString(), timeEstimate: 37 };
const answer = (quote, quoteRequest) => json(201, { correlationId: 'c-1', timestamp: '2026-11-10T23:00:00Z', signature: 'ed25519:sig', quoteRequest, quote });
const WANT = { assetId: USDC, yocto: '500000000000000000000000', recipient: 'oskar.stated.near', refundTo: '0x1111111111111111111111111111111111111111' };

test('a real quote names the recipient, sends refunds to the payer’s own chain, and keeps the signed answer', async () => {
  const d = double({ quote: (request) => answer(REAL, request) });
  const made = await intentsQuotes({ fetchImpl: d.fetchImpl }).deposit(WANT);
  const sent = d.calls.find((c) => c.url.endsWith('/v0/quote')).body;
  assert.equal(sent.dry, false);
  assert.equal(sent.swapType, 'EXACT_OUTPUT');
  assert.equal(sent.amount, WANT.yocto, 'the person receives exactly the NEAR they asked for');
  assert.equal(sent.destinationAsset, 'nep141:wrap.near');
  assert.equal(sent.recipient, 'oskar.stated.near');
  assert.equal(sent.recipientType, 'DESTINATION_CHAIN');
  assert.equal(sent.depositType, 'ORIGIN_CHAIN');
  assert.equal(sent.refundTo, WANT.refundTo);
  assert.equal(sent.refundType, 'ORIGIN_CHAIN', 'a refund goes back to the payer, not into an account they cannot reach');
  assert.ok(new Date(sent.deadline).getTime() - Date.now() > 55 * 60 * 1000, 'about an hour to pay');
  assert.equal(made.ok, true);
  assert.equal(made.depositAddress, REAL.depositAddress);
  assert.equal(made.amountInFormatted, '1.801942');
  assert.equal(made.minAmountInFormatted, '1.783923', 'the smallest payment that still completes, in the token’s own units');
  assert.equal(made.depositMemo, null);
  assert.equal(made.seconds, 37);
  assert.deepEqual({ correlationId: made.signed.correlationId, signature: made.signed.signature }, { correlationId: 'c-1', signature: 'ed25519:sig' });
  assert.deepEqual(made.signed.quoteRequest, sent);
});

test('a real quote that is missing its address, its amount or a future deadline is no quote at all', async () => {
  for (const broken of [{ ...REAL, depositAddress: undefined }, { ...REAL, depositAddress: 'has a space' }, { ...REAL, amountIn: '1.5' },
    { ...REAL, amountInFormatted: '0' }, { ...REAL, deadline: '2020-01-01T00:00:00Z' }, { ...REAL, deadline: 'soon' }]) {
    const d = double({ quote: () => answer(broken) });
    assert.deepEqual(await intentsQuotes({ fetchImpl: d.fetchImpl }).deposit(WANT), { ok: false, reason: 'unavailable' });
  }
  const memo = double({ quote: () => answer({ ...REAL, depositMemo: '12345' }) });
  assert.equal((await intentsQuotes({ fetchImpl: memo.fetchImpl }).deposit(WANT)).depositMemo, '12345');
});

test('a refused real quote says whether the route has a floor or the request was wrong, and an unlisted token asks nothing', async () => {
  const floor = double({ quote: () => json(400, { message: 'Amount is too low for bridge, try at least 1315773292956857495881383' }) });
  assert.deepEqual(await intentsQuotes({ fetchImpl: floor.fetchImpl }).deposit(WANT), { ok: false, reason: 'minimum', minimumYocto: '1315773292956857495881383' });
  const wrong = double({ quote: () => json(400, { message: 'refundTo is not valid' }) });
  assert.deepEqual(await intentsQuotes({ fetchImpl: wrong.fetchImpl }).deposit(WANT), { ok: false, reason: 'refused', message: 'refundTo is not valid' });
  const down = double({ quote: () => json(503, {}) });
  assert.deepEqual(await intentsQuotes({ fetchImpl: down.fetchImpl }).deposit(WANT), { ok: false, reason: 'unavailable' });
  const d = double();
  assert.deepEqual(await intentsQuotes({ fetchImpl: d.fetchImpl }).deposit({ ...WANT, assetId: 'nep141:made-up.near' }), { ok: false, reason: 'unknown' });
  assert.equal(d.calls.filter((c) => c.url.endsWith('/v0/quote')).length, 0);
});

test('the status of a payment is read by its address, and only a state the API documents is believed', async () => {
  const seen = [];
  const reply = (status, body) => async (url) => { seen.push(String(url)); return json(status, body); };
  const hash = 'F8mPZ8Wz1Yq6sQ7b5tVxkK1p4W8n3LrT9cGdHj2uXyAa';
  const done = await intentsQuotes({ fetchImpl: reply(200, { status: 'SUCCESS', swapDetails: { amountOut: '500000000000000000000000', destinationChainTxHashes: [{ hash, explorerUrl: 'https://example.invalid' }] } }) })
    .status({ depositAddress: '0xabc', depositMemo: '77' });
  assert.deepEqual(done, { ok: true, state: 'SUCCESS', deliveredYocto: '500000000000000000000000', destinationTx: hash, refunded: null, refundReason: null });
  assert.match(seen[0], /\/v0\/status\?depositAddress=0xabc&depositMemo=77$/);
  const back = await intentsQuotes({ fetchImpl: reply(200, { status: 'REFUNDED', swapDetails: { refundedAmountFormatted: '0.36', refundReason: 'Deposit below the minimum' } }) }).status({ depositAddress: '0xabc' });
  assert.deepEqual(back, { ok: true, state: 'REFUNDED', deliveredYocto: null, destinationTx: null, refunded: '0.36', refundReason: 'Deposit below the minimum' });
  assert.deepEqual(await intentsQuotes({ fetchImpl: reply(404, {}) }).status({ depositAddress: '0xabc' }), { ok: false, reason: 'unknown' });
  assert.deepEqual(await intentsQuotes({ fetchImpl: reply(200, { status: 'PAID_PROBABLY' }) }).status({ depositAddress: '0xabc' }), { ok: false, reason: 'unavailable' });
  assert.deepEqual(await intentsQuotes({ fetchImpl: async () => { throw new Error('down'); } }).status({ depositAddress: '0xabc' }), { ok: false, reason: 'unavailable' });
});
