// INTEGRATION: Production bet modules with real Postgres and simulated NEAR RPC.
// The RPC fixtures are synthetic and do not prove a live connector round trip.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createBet } from '../src/bets.mjs';
import { notifyBetChange } from '../src/bet-notify.mjs';
import { followPublicBet, publishBet, withdrawBetPublication } from '../src/bet-public.mjs';
import { prepareNearAction, syncNearBet } from '../src/near-bets.mjs';
import { completeSetup, signInFromX } from '../src/store.mjs';
import { startStack } from './support/app.mjs';

let s;
let creator;
let invitee;
let joiner;
let joiner2;
let follower;
const publicKey = 'ed25519:11111111111111111111111111111111';
const config = () => ({ ...s.config, nearContract: 'escrow.testnet' });
const ns = (value) => (BigInt(new Date(value).getTime()) * 1000000n).toString();
const response = (data) => new Response(JSON.stringify(data), { status: 200 });

function rpc(chain, height = 10, { fail = false, permission = 'FullAccess' } = {}) {
  return { fetchImpl: async (_url, options) => {
    if (fail) throw new Error('synthetic RPC failure');
    const { params } = JSON.parse(options.body);
    if (params.request_type === 'call_function') {
      return response({ result: { block_height: height, result: [...Buffer.from(JSON.stringify(chain))] } });
    }
    if (params.request_type === 'view_access_key') {
      return response({ result: { nonce: 1, permission, block_hash: '11111111111111111111111111111111' } });
    }
    throw new Error('Unexpected synthetic RPC request');
  } };
}

async function makeUser(id, username, setup = true) {
  const user = await signInFromX(s.db, { id, username });
  return setup ? completeSetup(s.db, user, {}) : user;
}

async function makeBet({ invited = true } = {}) {
  return createBet(s.db, creator, {
    requestId: randomUUID(), claim: 'Will the event occur?', criteria: 'Official result',
    evidenceSourceUrl: 'https://example.org/result', creatorSide: 'yes', stakeNear: '0.1',
    acceptBy: new Date(Date.now() + 86400000).toISOString(),
    resolveAt: new Date(Date.now() + 172800000).toISOString(),
    ...(invited ? { opponentUsername: invitee.x_username, opponentAccount: 'invitee.testnet' } : {}),
  });
}

function offeredChain(bet, binding) {
  return { id: bet.id, terms_hash: bet.terms_hash, stake_yocto: bet.stake_yocto,
    creator_side: bet.creator_side, accept_by_ns: ns(bet.accept_by), resolve_at_ns: ns(bet.resolve_at),
    invited_account: bet.invited_wallet, creator: 'creator.testnet', creator_binding_hash: binding,
    acceptor: null, status: 'offered', proposal: null };
}

async function prepareFund(bet, accountId = 'creator.testnet', options = {}) {
  return prepareNearAction(s.db, config(), creator, bet.id,
    { action: 'fund', accountId, publicKey }, rpc(null, 1, options));
}

async function fund(bet) {
  const prepared = await prepareFund(bet);
  return { prepared, chain: offeredChain(bet, prepared.args.binding_hash) };
}

async function inboxRows(bet) {
  return s.db.many('select owner_x_user_id, body, dedupe_key from inbox where bet_id=$1 order by owner_x_user_id', [bet.id]);
}

before(async () => {
  s = await startStack();
  creator = await makeUser('91001', 'wire_creator');
  invitee = await makeUser('91002', 'wire_invitee');
  joiner = await makeUser('91003', 'wire_joiner');
  joiner2 = await makeUser('91004', 'wire_joiner2');
  follower = await makeUser('91005', 'wire_follower', false);
});

after(async () => { if (s) await s.close(); });

test('concurrent funding preparation persists and reuses one binding', async () => {
  const bet = await makeBet();
  const [first, second] = await Promise.all([prepareFund(bet), prepareFund(bet)]);
  assert.equal(first.args.binding_hash, second.args.binding_hash);
  assert.equal(first.requestId, second.requestId);
  assert.equal(first.reused || second.reused, true);
  assert.equal((await s.db.one("select count(*)::int as n from bilateral_near_requests where bet_id=$1 and method='create_bet'", [bet.id])).n, 1);
  assert.equal((await s.db.one('select chain_state from bilateral_bets where id=$1', [bet.id])).chain_state, null);

  await assert.rejects(prepareFund(bet, 'changed.testnet'));
  assert.equal((await s.db.one("select count(*)::int as n from bilateral_near_requests where bet_id=$1 and method='create_bet'", [bet.id])).n, 1);
});

test('RPC and account failures before wallet construction leave the bet unfunded', async () => {
  const bet = await makeBet();
  await assert.rejects(prepareNearAction(s.db, config(), creator, bet.id,
    { action: 'fund', accountId: 'invalid-account' }, rpc(null)));
  await assert.rejects(prepareNearAction(s.db, config(), creator, bet.id,
    { action: 'fund', accountId: 'creator.testnet', publicKey }, rpc(null, 1, { fail: true })));
  assert.equal((await s.db.one('select status, chain_state from bilateral_bets where id=$1', [bet.id])).status, 'offered');
  assert.equal((await s.db.one('select chain_state from bilateral_bets where id=$1', [bet.id])).chain_state, null);
  assert.equal((await s.db.one('select count(*)::int as n from bilateral_near_requests where bet_id=$1', [bet.id])).n, 0);
});

test('one X user retry reuses its accepting binding', async () => {
  const bet = await makeBet();
  const { chain } = await fund(bet);
  await syncNearBet(s.db, config(), creator, bet.id, rpc(chain, 11));
  const input = { action: 'accept', accountId: 'invitee.testnet', termsHash: bet.terms_hash, publicKey };
  const first = await prepareNearAction(s.db, config(), invitee, bet.id, input, rpc(chain, 11));
  const retry = await prepareNearAction(s.db, config(), invitee, bet.id, input, rpc(chain, 11));
  assert.equal(first.args.binding_hash, retry.args.binding_hash);
  assert.equal(first.requestId, retry.requestId);
  assert.equal(retry.reused, true);
  assert.equal((await s.db.one("select count(*)::int as n from bilateral_near_requests where bet_id=$1 and method='accept_bet'", [bet.id])).n, 1);
});

test('two eligible X joiners can prepare, but only the finalized binding gets linked', async () => {
  const bet = await makeBet({ invited: false });
  const { chain } = await fund(bet);
  await syncNearBet(s.db, config(), creator, bet.id, rpc(chain, 20));
  const prepare = (user, accountId) => prepareNearAction(s.db, config(), user, bet.id,
    { action: 'accept', accountId, termsHash: bet.terms_hash, publicKey }, rpc(chain, 20));
  const [pending1, pending2] = await Promise.all([
    prepare(joiner, 'joiner.testnet'), prepare(joiner2, 'joiner2.testnet'),
  ]);
  assert.notEqual(pending1.args.binding_hash, pending2.args.binding_hash);
  assert.equal((await s.db.one("select count(*)::int as n from bilateral_near_requests where bet_id=$1 and method='accept_bet'", [bet.id])).n, 2);

  const accepted = { ...chain, status: 'accepted', acceptor: 'joiner2.testnet', acceptor_binding_hash: pending2.args.binding_hash };
  await syncNearBet(s.db, config(), joiner2, bet.id, rpc(accepted, 21));
  const stored = await s.db.one('select acceptor_user_id, acceptor_wallet from bilateral_bets where id=$1', [bet.id]);
  assert.equal(String(stored.acceptor_user_id), String(joiner2.id));
  assert.equal(stored.acceptor_wallet, 'joiner2.testnet');
  assert.notEqual(String(stored.acceptor_user_id), String(joiner.id));
});

test('same finalized snapshot sync does not duplicate Inbox updates', async () => {
  const bet = await makeBet();
  const { chain } = await fund(bet);
  await syncNearBet(s.db, config(), creator, bet.id, rpc(chain, 30));
  const initial = await inboxRows(bet);
  await syncNearBet(s.db, config(), creator, bet.id, rpc(chain, 30));
  await syncNearBet(s.db, config(), creator, bet.id, rpc(chain, 30));
  assert.equal((await inboxRows(bet)).length, initial.length);
  assert.equal(initial.length, 1);
  assert.equal(initial[0].owner_x_user_id, creator.x_user_id);
});

test('followers without setup receive lifecycle updates while withdrawn followers stop', async () => {
  const bet = await makeBet();
  const { chain } = await fund(bet);
  await syncNearBet(s.db, config(), creator, bet.id, rpc(chain, 40));
  await publishBet(s.db, creator, bet.id);
  await followPublicBet(s.db, follower, bet.id);

  const acceptInput = { action: 'accept', accountId: 'invitee.testnet', termsHash: bet.terms_hash, publicKey };
  const accepting = await prepareNearAction(s.db, config(), invitee, bet.id, acceptInput, rpc(chain, 40));
  const accepted = { ...chain, status: 'accepted', acceptor: 'invitee.testnet', acceptor_binding_hash: accepting.args.binding_hash };
  await syncNearBet(s.db, config(), invitee, bet.id, rpc(accepted, 41));
  const acceptedRows = await inboxRows(bet);
  assert.deepEqual(new Set(acceptedRows.map((row) => row.owner_x_user_id)), new Set([
    creator.x_user_id, invitee.x_user_id, follower.x_user_id,
  ]));

  await withdrawBetPublication(s.db, creator, bet.id);
  const settled = { ...accepted, status: 'settled', proposal: {
    id: randomUUID(), revision: '1', outcome: 'yes', proposer: 'creator.testnet',
  } };
  await s.db.tx((tx) => notifyBetChange(tx, {
    before: { id: bet.id, creator_user_id: creator.id, acceptor_user_id: invitee.id, chain_state: accepted },
    after: { id: bet.id, creator_user_id: creator.id, acceptor_user_id: invitee.id, chain_state: settled },
    eventKey: 'a'.repeat(64),
  }));
  const rows = await inboxRows(bet);
  const owners = rows.map((row) => row.owner_x_user_id);
  assert.equal(owners.filter((owner) => owner === follower.x_user_id).length, 1);
  assert.equal(owners.filter((owner) => owner === creator.x_user_id).length, 3);
  assert.equal(owners.filter((owner) => owner === invitee.x_user_id).length, 2);
  assert.ok(rows.find((row) => row.owner_x_user_id === follower.x_user_id && row.body.includes('Both participants deposited')));
});

test('unbound accepting wallet never becomes a fake X identity', async () => {
  const bet = await makeBet({ invited: false });
  const { chain } = await fund(bet);
  await syncNearBet(s.db, config(), creator, bet.id, rpc(chain, 50));
  const direct = { ...chain, status: 'accepted', acceptor: 'unbound.testnet', acceptor_binding_hash: 'f'.repeat(64) };
  const synced = await syncNearBet(s.db, config(), creator, bet.id, rpc(direct, 51));
  assert.equal(synced.acceptor_user_id, null);
  assert.equal(synced.acceptor_unbound, true);
  const rows = await inboxRows(bet);
  assert.deepEqual([...new Set(rows.map((row) => row.owner_x_user_id))], [creator.x_user_id]);
  assert.equal(rows.length, 2, 'creator receives funding and unbound acceptance updates');
});

test('Inbox lifecycle text omits private material and describes credits accurately', async () => {
  const bet = await makeBet();
  const { chain } = await fund(bet);
  await syncNearBet(s.db, config(), creator, bet.id, rpc(chain, 60));
  const accepted = { ...chain, status: 'accepted', acceptor: 'invitee.testnet', acceptor_binding_hash: 'b'.repeat(64) };
  await s.db.tx((tx) => notifyBetChange(tx, {
    before: { id: bet.id, creator_user_id: creator.id, chain_state: chain },
    after: { id: bet.id, creator_user_id: creator.id, chain_state: accepted },
    eventKey: 'c'.repeat(64),
  }));
  const settled = { ...accepted, status: 'settled', proposal: {
    id: randomUUID(), revision: '1', outcome: 'yes', proposer: 'creator.testnet',
  } };
  await s.db.tx((tx) => notifyBetChange(tx, {
    before: { id: bet.id, creator_user_id: creator.id, acceptor_user_id: invitee.id, chain_state: accepted },
    after: { id: bet.id, creator_user_id: creator.id, acceptor_user_id: invitee.id, chain_state: settled },
    eventKey: 'd'.repeat(64),
  }));
  const bodies = (await inboxRows(bet)).map((row) => row.body);
  assert.ok(bodies.some((body) => body.includes('credited for withdrawal')));
  assert.ok(bodies.every((body) => !/paid|claim|Official result|private\.example|evidence|result evidence/i.test(body)));
});
