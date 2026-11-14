import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { demoPage, demoReady } from '../src/demo-page.mjs';

const recorded = JSON.parse(readFileSync(new URL('../../evidence/mainnet-demo-20261114.json', import.meta.url)));

test('the public demo renders both recorded controlled payouts and their verification links', () => {
  assert.equal(demoReady(recorded), true);
  const page = String(demoPage({ evidence: recorded }));
  for (const item of recorded.cases) {
    assert.ok(page.includes(`https://nearblocks.io/txns/${item.payout.hash}`));
    assert.ok(page.includes(`https://nearblocks.io/txns/${item.settlement.hash}`));
    assert.match(page, new RegExp(`id="${item.id}"`));
    assert.ok(page.includes(item.claim.split('\n\n')[0]));
  }
  assert.equal((page.match(/Verified payout: 0\.2 NEAR/g) || []).length, 2);
  assert.match(page, /Operator-controlled mainnet tests/);
  assert.match(page, /does not independently verify model attestation/);
  assert.match(page, /href="#yes"/);
  assert.match(page, /href="#no"/);
  assert.match(page, /View the full testnet walkthrough/);
  assert.match(page, /\/demo\/evidence\.json/);
});

test('the public demo links each withdrawal and settlement and anchors cases by id', () => {
  const page = String(demoPage({ evidence: recorded }));
  for (const item of recorded.cases) {
    assert.match(page, new RegExp(`href="https://nearblocks\\.io/txns/${item.settlement.hash}"[^>]*>View settlement</a>`));
    assert.match(page, new RegExp(`<section class="demo-example" id="${item.id}"`));
  }
});

test('inconsistent payout or jury evidence never renders as verified money', () => {
  const mutations = [
    value => { value.cases[0].payout.amountYocto = '1'; },
    value => { value.cases[1].verdicts[0].outcome = 'yes'; },
    value => { value.checks[0].ok = false; },
    value => { value.cases[0].payout.recipient = 'another.near'; },
    value => { value.cases[0].id = 'not-a-uuid'; },
    value => { value.cases[1].settlement.hash = 'invalid-hash'; },
  ];
  for (const mutate of mutations) {
    const value = structuredClone(recorded);
    mutate(value);
    assert.equal(demoReady(value), false);
    const page = String(demoPage({ evidence: value }));
    assert.doesNotMatch(page, /Verified payout/);
    assert.match(page, /Mainnet examples are unavailable/);
  }
});
