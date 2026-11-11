// Token and chain logos: which mark a token gets, and when it gets none.
import test from 'node:test';
import assert from 'node:assert/strict';
import { chainCode } from '../src/intents.mjs';
import { logoFile, LOGO_VERSION, nearMark, tokenMark } from '../src/token-logos.mjs';

const mark = (symbol, chain, options) => String(tokenMark({ symbol, chain }, options));

test('a chain is known by its code or its name', () => {
  assert.equal(chainCode('base'), 'base');
  assert.equal(chainCode('Base'), 'base');
  assert.equal(chainCode('BNB Chain'), 'bsc');
  assert.equal(chainCode('Made Up Chain'), 'made up chain', 'an unknown chain is never mapped to a known one');
  assert.equal(chainCode(null), '');
});

test('a token on another chain shows its own logo with the chain set into the corner', () => {
  const usdc = mark('USDC', 'Base');
  assert.match(usdc, new RegExp(`^<span class="tok"><img src="/static/tokens/token-usdc\\.png\\?v=${LOGO_VERSION}" alt="" width="32" height="32"><img class="on" src="/static/tokens/chain-base\\.png\\?v=${LOGO_VERSION}" alt="" width="16" height="16"></span>$`));
  assert.match(mark('ETH', 'base'), /chain-eth\.png[^>]*><img class="on" src="\/static\/tokens\/chain-base\.png/, 'ETH on Base is ETH, marked as being on Base');
  assert.match(mark('USDT', 'Tron'), /token-usdt\.png[^>]*><img class="on" src="\/static\/tokens\/chain-tron\.png/);
});

test('a chain’s own coin shows one logo, with nothing in the corner', () => {
  for (const [symbol, chain, file] of [['BTC', 'Bitcoin', 'chain-btc'], ['ETH', 'eth', 'chain-eth'], ['SOL', 'Solana', 'chain-sol'], ['wNEAR', 'near', 'chain-near']]) {
    const m = mark(symbol, chain);
    assert.match(m, new RegExp(`/static/tokens/${file}\\.png`));
    assert.doesNotMatch(m, /class="on"/);
  }
  assert.match(String(nearMark({ size: 'md' })), /^<span class="tok md"><img src="\/static\/tokens\/chain-near\.png/);
});

test('a token with no logo gets none: no stand-in, and never another token’s mark', () => {
  for (const symbol of ['TURBO', 'USDT0', 'cbBTC', 'USDC(DEPRECATED)', 'usdc', '', undefined]) {
    assert.equal(mark(symbol, 'Solana'), '', `${symbol} has no logo of its own`);
  }
  assert.equal(mark('TURBO', 'Solana', { keep: true }), '<span class="tok"></span>', 'a row keeps its place in the list');
  // A known token on a chain with no logo still shows the token, without a corner mark.
  const plain = mark('USDC', 'plasma');
  assert.match(plain, /token-usdc\.png/);
  assert.doesNotMatch(plain, /class="on"/);
});

test('every logo is a PNG of modest size, and only named files are served', () => {
  for (const name of ['chain-btc.png', 'chain-base.png', 'chain-near.png', 'token-usdc.png', 'token-usdt.png']) {
    const file = logoFile(name);
    assert.ok(file, `${name} is present`);
    assert.deepEqual([...file.subarray(0, 8)], [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    assert.ok(file.length < 40000);
  }
  for (const name of ['ATTRIBUTION.md', '../skin.css', 'chain-nope.png', 'token-usdc.svg', '']) assert.equal(logoFile(name), null);
  assert.match(LOGO_VERSION, /^[0-9a-f]{10}$/);
});
