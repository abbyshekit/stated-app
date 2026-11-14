// INTEGRATION: Real Postgres verifies that only matching finalized NEAR state changes a bet.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { KeyPair } from 'near-api-js';
import { createBet } from '../src/bets.mjs';
import { cancelUnfundedBet, prepareNearAction, syncNearBet } from '../src/near-bets.mjs';
import { parseTestNear } from '../src/near-escrow.mjs';
import { completeSetup, signInFromX } from '../src/store.mjs';
import { startStack } from './support/app.mjs';

let s, creator, invitee, outsider;
const key = KeyPair.fromRandom('ed25519').getPublicKey().toString();
const config = () => ({ ...s.config, nearContract: 'escrow.testnet' });
const ns = (d) => (BigInt(new Date(d).getTime()) * 1000000n).toString();
const response = (data, headers = {}) => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'stated', ...data }), { status: 200, headers });
function rpc(chain, height = 1, permission = 'FullAccess', credit = '100000000000000000000000') {
  return { fetchImpl: async (_url, opts) => {
    const { params } = JSON.parse(opts.body);
    if (params.request_type === 'call_function') return response({ result: { block_height: height, result: [...Buffer.from(JSON.stringify(params.method_name === 'get_credit' ? credit : chain))] } });
    if (params.request_type === 'view_access_key') return response({ result: { nonce: 1, permission, block_hash: '11111111111111111111111111111111' } });
    throw new Error('Unexpected RPC request');
  } };
}
async function makeUser(id, username) {
  return completeSetup(s.db, await signInFromX(s.db, { id, username }), {});
}
async function makeBet(invited = true) {
  return createBet(s.db, creator, {
    requestId: randomUUID(), claim: 'Will the event occur?', criteria: 'Official result',
    evidenceSourceUrl: 'https://docs.near.org/', creatorSide: 'yes', stakeNear: '0.1',
    acceptBy: new Date(Date.now() + 86400000).toISOString(),
    resolveAt: new Date(Date.now() + 172800000).toISOString(),
    ...(invited ? { opponentUsername: invitee.x_username, opponentAccount: 'invitee.testnet' } : {}),
  });
}
function chainFor(bet, binding) {
  return { id: bet.id, terms_hash: bet.terms_hash, stake_yocto: bet.stake_yocto,
    creator_side: bet.creator_side, accept_by_ns: ns(bet.accept_by), resolve_at_ns: ns(bet.resolve_at),
    invited_account: bet.invited_wallet, creator: 'creator.testnet', creator_binding_hash: binding,
    acceptor: null, status: 'offered', proposal: null };
}
async function fund(bet) {
  const prepared = await prepareNearAction(s.db, config(), creator, bet.id,
    { action: 'fund', accountId: 'creator.testnet', publicKey: key }, rpc(null));
  return { prepared, chain: chainFor(bet, prepared.args.binding_hash) };
}
async function row(id) { return s.db.one('select status, chain_state, near_height, acceptor_user_id, current_proposal_id from bilateral_bets where id=$1', [id]); }

before(async () => {
  s = await startStack();
  creator = await makeUser('60001', 'near_creator');
  invitee = await makeUser('60002', 'near_invitee');
  outsider = await makeUser('60003', 'near_outsider');
});
after(async () => { if (s) await s.close(); });

test('funding preparation binds a request; only a matching finalized snapshot funds it', async () => {
  const bet = await makeBet();
  const { prepared, chain } = await fund(bet);
  assert.equal(prepared.payload.contract, 'escrow.testnet');
  assert.equal(prepared.payload.accountId, 'creator.testnet');
  assert.equal(prepared.payload.method, 'create_bet');
  assert.equal(prepared.payload.gas, '100000000000000');
  assert.deepEqual(prepared.payload.args, prepared.args);
  const request = await s.db.one('select * from bilateral_near_requests where bet_id=$1', [bet.id]);
  assert.equal(request.binding_hash, prepared.args.binding_hash);
  assert.equal(request.user_id, creator.id);
  assert.equal((await row(bet.id)).chain_state, null);
  await syncNearBet(s.db, config(), creator, bet.id, rpc(null, 2));
  assert.equal((await row(bet.id)).chain_state, null);
  for (const bad of [
    { ...chain, terms_hash: 'wrong' }, { ...chain, stake_yocto: '1' },
    { ...chain, creator_binding_hash: 'wrong' }, { ...chain, creator: 'other.testnet' },
  ]) {
    await assert.rejects(syncNearBet(s.db, config(), creator, bet.id, rpc(bad, 3)));
    assert.equal((await row(bet.id)).chain_state, null);
  }
  await syncNearBet(s.db, config(), creator, bet.id, rpc(chain, 4));
  const stored = await row(bet.id);
  assert.deepEqual(stored.chain_state, chain);
  assert.equal(String(stored.near_height), '4');
  const reordered = Object.fromEntries(Object.entries(chain).reverse());
  await syncNearBet(s.db, config(), creator, bet.id, rpc(reordered, 5));
  assert.equal(String((await row(bet.id)).near_height), '5');
  assert.equal((await s.db.one("select count(*)::int as n from bilateral_bet_events where bet_id=$1 and kind='chain_verified'", [bet.id])).n, 1,
    'jsonb key ordering must not create another event for the same state');
});

test('acceptance requires the invited user and wallet with a matching private request', async () => {
  const bet = await makeBet();
  const { chain } = await fund(bet);
  await syncNearBet(s.db, config(), creator, bet.id, rpc(chain, 10));
  const action = (user, accountId, termsHash = bet.terms_hash) => prepareNearAction(s.db, config(), user, bet.id,
    { action: 'accept', accountId, termsHash, publicKey: key }, rpc(chain, 10));
  await assert.rejects(action(outsider, 'invitee.testnet'));
  await assert.rejects(action(invitee, 'wrong.testnet'));
  await assert.rejects(action(invitee, 'invitee.testnet', 'wrong'));
  const prepared = await action(invitee, 'invitee.testnet');
  assert.equal((await row(bet.id)).acceptor_user_id, null);
  const accepted = { ...chain, status: 'accepted', acceptor: 'invitee.testnet', acceptor_binding_hash: prepared.args.binding_hash };
  for (const bad of [{ ...accepted, acceptor_binding_hash: 'wrong' }, { ...accepted, acceptor: 'wrong.testnet' }]) {
    await assert.rejects(syncNearBet(s.db, config(), invitee, bet.id, rpc(bad, 11)));
    assert.equal((await row(bet.id)).status, 'offered');
  }
  await syncNearBet(s.db, config(), invitee, bet.id, rpc(accepted, 12));
  const stored = await row(bet.id);
  assert.equal(stored.status, 'accepted');
  assert.equal(String(stored.acceptor_user_id), String(invitee.id));
  await syncNearBet(s.db, config(), creator, bet.id, rpc(chain, 11));
  assert.equal((await row(bet.id)).status, 'accepted');
  assert.equal(String((await row(bet.id)).near_height), '12');
});

test('proposals enforce evidence and actor boundaries and stale snapshots cannot replace them', async () => {
  const bet = await makeBet();
  const { chain } = await fund(bet);
  await syncNearBet(s.db, config(), creator, bet.id, rpc(chain, 20));
  const accept = await prepareNearAction(s.db, config(), invitee, bet.id,
    { action: 'accept', accountId: 'invitee.testnet', publicKey: key, termsHash: bet.terms_hash }, rpc(chain, 20));
  const accepted = { ...chain, status: 'accepted', acceptor: 'invitee.testnet', acceptor_binding_hash: accept.args.binding_hash };
  await syncNearBet(s.db, config(), creator, bet.id, rpc(accepted, 21));
  const propose = (input) => prepareNearAction(s.db, config(), creator, bet.id,
    { action: 'propose', accountId: 'creator.testnet', publicKey: key, outcome: 'yes', ...input }, rpc(accepted, 21));
  await assert.rejects(propose({ note: '' }));
  await assert.rejects(propose({ note: 'x'.repeat(2001), evidenceUrl: 'https://docs.near.org/' }));
  await assert.rejects(propose({ note: 'reason', evidenceUrl: 'http://docs.near.org/' }));
  const prepared = await propose({ note: 'Official result', evidenceUrl: 'https://docs.near.org/' });
  const proposal = { id: prepared.args.proposal_id, revision: '1', outcome: 'yes', proposer: 'creator.testnet' };
  const proposed = { ...accepted, status: 'proposed', proposal };
  await syncNearBet(s.db, config(), creator, bet.id, rpc(proposed, 23));
  const saved = await s.db.one('select * from bilateral_bet_proposals where id=$1', [proposal.id]);
  assert.equal(saved.note, 'Official result');
  assert.equal(saved.evidence_url, 'https://docs.near.org/');
  await assert.rejects(prepareNearAction(s.db, config(), creator, bet.id,
    { action: 'confirm', accountId: 'creator.testnet', publicKey: key, proposalId: proposal.id }, rpc(proposed, 23)));
  await assert.rejects(prepareNearAction(s.db, config(), outsider, bet.id,
    { action: 'confirm', accountId: 'invitee.testnet', publicKey: key, proposalId: proposal.id }, rpc(proposed, 23)));
  await syncNearBet(s.db, config(), creator, bet.id, rpc(accepted, 22));
  assert.equal((await row(bet.id)).current_proposal_id, proposal.id);
  assert.equal((await row(bet.id)).status, 'proposed');
});

test('invalid network, amounts, accounts, and RPC failures leave state unchanged', async () => {
  for (const amount of ['0', '1.1', '01', '1e-2', '0.0000000000000000000000001']) assert.throws(() => parseTestNear(amount));
  const bet = await makeBet();
  const input = { action: 'fund', accountId: 'creator.testnet', publicKey: key };
  await assert.rejects(prepareNearAction(s.db, { ...config(), nearContract: 'escrow.near' }, creator, bet.id, input, rpc(null)));
  await assert.rejects(prepareNearAction(s.db, config(), creator, bet.id, { ...input, accountId: 'bad' }, rpc(null)));
  const failure = { fetchImpl: async () => response({ error: { message: 'unavailable' } }) };
  const oversized = { fetchImpl: async () => response({}, { 'content-length': '1048577' }) };
  await assert.rejects(syncNearBet(s.db, config(), creator, bet.id, failure));
  await assert.rejects(syncNearBet(s.db, config(), creator, bet.id, oversized));
  assert.equal((await row(bet.id)).chain_state, null);
  assert.equal((await s.db.one('select count(*)::int as n from bilateral_near_requests where bet_id=$1', [bet.id])).n, 0);
});

test('unbound direct acceptance preserves creator recovery without claiming an X identity', async () => {
  const bet = await makeBet(false);
  const { chain } = await fund(bet);
  await syncNearBet(s.db, config(), creator, bet.id, rpc(chain, 50));
  const direct = { ...chain, status: 'accepted', acceptor: 'direct.testnet', acceptor_binding_hash: 'f'.repeat(64) };
  const accepted = await syncNearBet(s.db, config(), creator, bet.id, rpc(direct, 51));
  assert.equal(accepted.acceptor_user_id, null);
  assert.equal(accepted.acceptor_wallet, 'direct.testnet');
  assert.equal(accepted.acceptor_unbound, true);
  const refunded = { ...direct, status: 'refunded' };
  await assert.rejects(prepareNearAction(s.db, config(), creator, bet.id,
    { action: 'withdraw', accountId: 'creator.testnet', publicKey: key }, rpc(refunded, 52, 'FullAccess', '0')), { status: 409 });
  const prepared = await prepareNearAction(s.db, config(), creator, bet.id,
    { action: 'withdraw', accountId: 'creator.testnet', publicKey: key }, rpc(refunded, 52));
  assert.equal(prepared.method, 'withdraw');
  assert.equal(prepared.withdrawalCreditYocto, bet.stake_yocto);
  assert.equal((await row(bet.id)).acceptor_user_id, null);
  await s.db.query("update bilateral_bets set near_verified_at=clock_timestamp()-interval '1 day' where id=$1", [bet.id]);
  await syncNearBet(s.db, config(), creator, bet.id, rpc(Object.fromEntries(Object.entries(refunded).reverse()), 53));
  assert.equal(String((await row(bet.id)).near_height), '53', 'unchanged terminal state refreshes after a jsonb round trip');
  assert.ok(Date.now() - new Date((await s.db.one('select near_verified_at from bilateral_bets where id=$1', [bet.id])).near_verified_at).getTime() < 10000);
});

test('latest proposal permits valid confirmation and dispute requests with exact revision binding', async () => {
  for (const action of ['confirm', 'dispute']) {
    const bet = await makeBet();
    const { chain } = await fund(bet);
    await syncNearBet(s.db, config(), creator, bet.id, rpc(chain, 60));
    const acceptance = await prepareNearAction(s.db, config(), invitee, bet.id,
      { action: 'accept', accountId: 'invitee.testnet', publicKey: key, termsHash: bet.terms_hash }, rpc(chain, 60));
    const accepted = { ...chain, status: 'accepted', acceptor: 'invitee.testnet', acceptor_binding_hash: acceptance.args.binding_hash };
    await syncNearBet(s.db, config(), creator, bet.id, rpc(accepted, 61));
    const proposal = await prepareNearAction(s.db, config(), creator, bet.id,
      { action: 'propose', accountId: 'creator.testnet', publicKey: key, outcome: 'yes', note: 'Synthetic evidence', evidenceUrl: 'https://example.org/result' }, rpc(accepted, 61));
    const proposed = { ...accepted, status: 'proposed', proposal: { id: proposal.args.proposal_id, revision: '1', outcome: 'yes', proposer: 'creator.testnet' } };
    const response = await prepareNearAction(s.db, config(), invitee, bet.id,
      { action, accountId: 'invitee.testnet', publicKey: key, proposalId: proposed.proposal.id,
        proposalRevision: '1', proposalOutcome: 'yes', note: 'Synthetic disagreement' }, rpc(proposed, 62));
    assert.equal(response.method, `${action}_outcome`);
    assert.equal(response.args.proposal_id, proposed.proposal.id);
    assert.equal(response.args.expected_revision, '1');
    const final = await syncNearBet(s.db, config(), creator, bet.id,
      rpc({ ...proposed, status: action === 'confirm' ? 'settled' : 'disputed' }, 63));
    assert.equal(final.status, action === 'confirm' ? 'settled' : 'disputed');
    assert.equal(final.current_proposal.id, proposed.proposal.id);
    assert.equal(final.current_proposal.revision, '1');
  }
});

test('unfunded cancellation requires finalized absence after any issued funding request', async () => {
  const immediate = await makeBet();
  await cancelUnfundedBet(s.db, config(), creator, immediate.id);
  assert.equal((await row(immediate.id)).status, 'cancelled');
  const bet = await makeBet();
  await fund(bet);
  const absentAt = timestamp => ({ fetchImpl: async (_url, options) => {
    const { method } = JSON.parse(options.body);
    return response({ result: method === 'block' ? { header: { timestamp_nanosec: timestamp } }
      : { block_height: 70, block_hash: '11111111111111111111111111111111', result: [...Buffer.from('null')] } });
  } });
  await assert.rejects(cancelUnfundedBet(s.db, config(), creator, bet.id,
    absentAt((BigInt(ns(bet.accept_by)) - 1n).toString())), { status: 409 });
  assert.equal((await row(bet.id)).status, 'offered');
  await cancelUnfundedBet(s.db, config(), creator, bet.id, absentAt(ns(bet.accept_by)));
  assert.equal((await row(bet.id)).status, 'cancelled');
});
