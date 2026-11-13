import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { FakeOutLayerNear, outlayerDeadlineMs } from './support/fake-outlayer.mjs';
import { outlayerTermsHash, outlayerReadyAt } from '../src/outlayer.mjs';
import { verifyNearExecution } from '../src/near-execution.mjs';

const vector = JSON.parse(readFileSync(new URL('./fixtures/outlayer-terms-vectors.json', import.meta.url), 'utf8'))[0];
const ns = date => (BigInt(Date.parse(date)) * 1000000n).toString();

test('OutLayer test clock preserves PostgreSQL Date milliseconds at evidence boundaries', () => {
  const iso = '2026-11-12T19:15:00.789Z';
  const expected = Date.parse(iso);
  for (const resolve_at of [new Date(iso), iso]) {
    const due = outlayerDeadlineMs({ resolve_at });
    assert.equal(due, expected);
    assert.ok(due + 1 >= expected, 'opening time must be after the committed deadline');
    assert.equal(due + 86400000, expected + 86400000);
  }
});
async function fixture(evidence = vector.material.evidence) {
  const near = new FakeOutLayerNear();
  const material = { ...vector.material, evidence };
  const hash = outlayerTermsHash(material, vector.salt);
  near.offsetMs = Date.parse(material.made_at) - Date.now();
  for (const name of ['alice.testnet','bob.testnet','sponsor.testnet','outsider.testnet']) {
    await near.chain.faucet(name, 'synthetic-key');
  }
  const args = { id: material.bet_id, terms_hash: hash, creator_side: 'yes', stake_yocto: '100000000000000000000000',
    accept_by_ns: ns('2026-11-12T18:30:00.000Z'), resolve_at_ns: ns(material.deadline), referee: near.referee,
    binding_hash: 'a'.repeat(64) };
  assert.ok((await near.chain.call({ signerId: 'alice.testnet', contractId: near.contract, method: 'create_bet', args,
    depositYocto: '110000000000000000000000' })).ok);
  assert.ok((await near.chain.call({ signerId: 'bob.testnet', contractId: near.contract, method: 'accept_bet',
    args: { id: material.bet_id, binding_hash: 'b'.repeat(64) }, depositYocto: '100000000000000000000000' })).ok);
  return { near, material, hash };
}

test('fake referee validates escrow commitment, registration deposit, gas, retry state and payout', async () => {
  const { near, material, hash } = await fixture();
  const register = async mat => near.chain.call({ signerId: 'sponsor.testnet', contractId: near.referee,
    method: 'register_material', args: { material: mat, salt: vector.salt }, depositYocto: '1000000000000000000000000' });
  const rejected = await register({ ...material, claim: material.claim + '?' });
  assert.equal(rejected.value, false);
  assert.equal(near.outlayerView(near.referee, 'get_ruling', { bet_id: material.bet_id }), null);
  assert.equal((await register(material)).value, true);
  assert.equal(near.outlayerView(near.referee, 'get_ruling', { bet_id: material.bet_id }).terms_hash, hash);
  const request = gas => near.chain.call({ signerId: 'sponsor.testnet', contractId: near.referee,
    method: 'request_ruling', args: { bet_id: material.bet_id }, depositYocto: '0', gas });
  assert.equal((await request(300000000000000n)).ok, false);
  near.offsetMs = outlayerReadyAt(material) + 1 - Date.now();
  assert.equal((await request(100000000000000n)).ok, false);
  assert.equal((await request(300000000000000n)).ok, true);
  assert.equal((await request(300000000000000n)).ok, false);
  near.advance(600001);
  near.queueRuling(material.bet_id, { outcome: 'yes' });
  const settled = await request(300000000000000n);
  assert.equal(settled.ok, true);
  const verified = await verifyNearExecution({ wallet_account: 'sponsor.testnet', method: 'request_ruling',
    args: { bet_id: material.bet_id }, metadata: { contract: near.referee, gas: '300000000000000', depositYocto: '0' } },
  settled.hash, { fetchImpl: near.fetchImpl });
  assert.equal(verified.status, 'succeeded');
  assert.equal(near.bets.get(material.bet_id).status, 'settled');
  assert.equal(near.credits.get('alice.testnet'), 200000000000000000000000n);
});

test('Open evidence accepts a bettor after deadline, rejects outsiders and bounds links per side', async () => {
  const { near, material } = await fixture({ kind: 'open', window_seconds: 120, max_per_side: 2 });
  await near.chain.call({ signerId: 'sponsor.testnet', contractId: near.referee, method: 'register_material',
    args: { material, salt: vector.salt }, depositYocto: '1000000000000000000000000' });
  const submit = (signerId, url) => near.chain.call({ signerId, contractId: near.referee, method: 'submit_evidence',
    args: { bet_id: material.bet_id, url }, depositYocto: '10000000000000000000000' });
  assert.equal((await submit('alice.testnet', 'https://www.sec.gov/one')).ok, false);
  near.offsetMs = Date.parse(material.deadline) + 1 - Date.now();
  assert.equal((await submit('outsider.testnet', 'https://www.sec.gov/one')).ok, false);
  assert.equal((await submit('alice.testnet', 'https://www.sec.gov/one')).ok, true);
  assert.equal((await submit('alice.testnet', 'https://www.sec.gov/one')).ok, true);
  assert.equal((await submit('alice.testnet', 'https://www.sec.gov/two')).ok, true);
  assert.equal((await submit('alice.testnet', 'https://www.sec.gov/three')).ok, false);
  assert.equal((await submit('bob.testnet', 'https://www.sec.gov/bob')).ok, true);
  near.advance(120001);
  assert.equal((await submit('bob.testnet', 'https://www.sec.gov/closed')).ok, false);
});

test('a void settlement preserves the unclear jury result and refunds both sides', async () => {
  const { near, material } = await fixture();
  await near.chain.call({ signerId: 'sponsor.testnet', contractId: near.referee, method: 'register_material',
    args: { material, salt: vector.salt }, depositYocto: '1000000000000000000000000' });
  near.offsetMs = outlayerReadyAt(material) + 1 - Date.now();
  near.queueRuling(material.bet_id, { outcome: 'void', undecided: 3 });
  await near.chain.call({ signerId: 'sponsor.testnet', contractId: near.referee, method: 'request_ruling',
    args: { bet_id: material.bet_id }, depositYocto: '0', gas: 300000000000000n });
  const ruling = near.outlayerView(near.referee, 'get_ruling', { bet_id: material.bet_id });
  assert.equal(ruling.outcome, 'void');
  assert.equal(ruling.result.outcome, 'unclear');
  assert.equal(ruling.result.verdicts.length, 3);
  for (const account of ['alice.testnet','bob.testnet']) assert.equal(near.credits.get(account), 100000000000000000000000n);
});
