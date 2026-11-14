import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createBet } from '../src/bets.mjs';
import { assertStakeLimit, limitFor } from '../src/reputation.mjs';
import { betReplies } from '../src/reply-bets.mjs';
import { useNetwork } from '../src/near-network.mjs';
import { UserError } from '../src/store.mjs';
import { prepareNearAction } from '../src/near-bets.mjs';
import { FakeNear } from './support/fake-near.mjs';
import { yocto } from '../src/play.mjs';

const user = { id: '1', kind: 'person', setup_completed_at: new Date() };
const config = (extra = {}) => ({ near: { real: true }, nearContract: 'escrow.stated.near',
  play: { maxStakeNear: '0.25', reputationTiers: null }, ...extra });
const terms = (extra = {}) => ({ requestId: randomUUID(), claim: 'A synthetic public release ships.',
  criteria: 'The release is public.', evidenceSourceUrl: 'https://example.org/release', creatorSide: 'yes',
  stakeNear: '0.1', acceptBy: new Date(Date.now() + 600000).toISOString(),
  resolveAt: new Date(Date.now() + 1200000).toISOString(), ...extra });
const serviceFailure = (error) => error instanceof UserError && error.status === 503 && /OutLayer referee/.test(error.message);

test('mainnet creation rejects a missing OutLayer referee before opening a transaction', async () => {
  useNetwork('mainnet');
  let transactions = 0;
  const db = { tx() { transactions += 1; throw new Error('Database transaction reached'); } };
  await assert.rejects(createBet(db, user, terms({ refereeAccount: 'server.stated.near' }), { config: config() }), serviceFailure);
  await assert.rejects(createBet(db, user, terms()), serviceFailure);
  assert.equal(transactions, 0);
});

test('mainnet creation normalizes unreachable and mismatched referee config as actionable 503 failures', async () => {
  useNetwork('mainnet');
  let transactions = 0;
  const db = { tx() { transactions += 1; throw new Error('Database transaction reached'); } };
  for (const view of [async () => { throw new Error('private transport failure'); }, async () => null,
    async () => ({ escrow: 'other.near' })]) {
    await assert.rejects(createBet(db, user, terms(), { config: config({ outlayer: { referee: 'jury.stated.near' } }),
      chain: { view } }), serviceFailure);
  }
  assert.equal(transactions, 0);
});

test('mainnet stake cap applies with reputation disabled, before database access', async () => {
  useNetwork('mainnet');
  const db = { one() { throw new Error('Database read reached'); } };
  await assert.rejects(assertStakeLimit(db, config(), user.id, '0.250000000000000000000001'),
    (error) => error instanceof UserError && error.reason === 'cap' && error.limit === '0.25' && /0.25 NEAR/.test(error.message));
  await assertStakeLimit(db, config(), user.id, '0.250000000000000000000000');
  assert.equal(limitFor(config(), { settled: 999 }), '0.25');
  assert.match(betReplies.refused('cap', { config: config() }), /mainnet.*0.25 NEAR/i);
});

test('testnet stake policy ignores the mainnet cap', async () => {
  useNetwork('testnet');
  const testnet = config({ near: { real: false } });
  await assertStakeLimit(null, testnet, user.id, '1');
  assert.equal(limitFor(testnet, { settled: 0 }), '1');
});

async function rejectLegacyStake(stakeNear, reason) {
  useNetwork('mainnet');
  const near = new FakeNear({ contract: 'escrow.stated.near' });
  const id = randomUUID();
  const input = terms({ stakeNear });
  const row = { id, creator_user_id: '1', acceptor_user_id: null, status: 'offered', stake_yocto: yocto(stakeNear),
    terms_hash: 'a'.repeat(64), creator_side: 'yes', accept_by: input.acceptBy, resolve_at: input.resolveAt,
    invited_wallet: null, referee_wallet: null, chain_state: null };
  let reserved = 0;
  const db = { tx: async fn => fn(db), many: async () => [], query: async (sql) => {
    if (/insert into bilateral_near_requests/.test(sql)) reserved++;
  }, one: async (sql) => {
    if (/method = 'create_bet'/.test(sql)) return { user_id: '1', wallet_account: 'maker.near' };
    if (/from bet_commands/.test(sql)) return { allowed: true };
    if (/bilateral_bets/.test(sql)) return row;
    if (/bilateral_near_requests/.test(sql)) { reserved++; return null; }
    throw new Error(`Unexpected SQL: ${sql}`);
  } };
  const policy = config({ play: { maxStakeNear: '0.25', reputationTiers: null, pilotXIds: ['*'] } });
  await assert.rejects(prepareNearAction(db, policy, user, id, { action: 'fund', accountId: 'maker.near' },
    { chain: near.chain, fetchImpl: near.fetchImpl }), { reason });
  const chain = { id, status: 'offered', creator: 'maker.near', creator_binding_hash: 'b'.repeat(64),
    terms_hash: row.terms_hash, creator_side: row.creator_side, stake_yocto: row.stake_yocto,
    accept_by_ns: (BigInt(Date.parse(input.acceptBy)) * 1000000n).toString(),
    resolve_at_ns: (BigInt(Date.parse(input.resolveAt)) * 1000000n).toString() };
  row.chain_state = chain;
  const fundedView = async () => Response.json({ jsonrpc: '2.0', id: 'stated', result: { block_height: 1, block_hash: 'synthetic-block',
    result: [...Buffer.from(JSON.stringify(chain))] } });
  await assert.rejects(prepareNearAction(db, policy, { ...user, id: '2' }, id,
    { action: 'accept', accountId: 'taker.near', termsHash: row.terms_hash }, { chain: near.chain, fetchImpl: fundedView }), { reason });
  assert.equal(reserved, 0);
  assert.equal(near.sent.length, 0);
  useNetwork('testnet');
}

test('legacy direct fund and accept actions reject the cap before reserving a wallet request', async () => {
  await rejectLegacyStake('0.5', 'cap');
});

test('legacy direct fund and accept actions reject dust before reserving a wallet request', async () => {
  await rejectLegacyStake('0.099999999999999999999999', 'minimum');
});

test('mainnet web creation rejects dust before planning or touching the database', async () => {
  useNetwork('mainnet');
  const db = { tx: () => assert.fail('dust cannot reach a transaction') };
  await assert.rejects(createBet(db, user, terms({ stakeNear: '0.01' }),
    { config: config({ outlayer: { referee: 'jury.stated.near' } }), chain: { view: () => assert.fail('dust cannot reach the chain') } }),
  { reason: 'minimum' });
  useNetwork('testnet');
});
