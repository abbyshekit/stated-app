// INTEGRATION: Real Postgres queue, synthetic NEAR RPC; no live integration claim.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, test } from 'node:test';
import { createBet } from '../src/bets.mjs';
import { prepareNearAction } from '../src/near-bets.mjs';
import { syncNearBets } from '../src/near-worker.mjs';
import { signInFromX, completeSetup } from '../src/store.mjs';
import { startStack } from './support/app.mjs';

let s, creator;
const key = 'ed25519:11111111111111111111111111111111';
const ns = date => (BigInt(new Date(date).getTime()) * 1000000n).toString();
const states = new Map();
let failing = false;
const fetchImpl = async (_url, options) => {
  if (failing) throw new Error('Synthetic RPC outage');
  const { method, params } = JSON.parse(options.body);
  let result;
  if (method === 'block') result = { header: { timestamp_nanosec: ns(new Date()) } };
  else if (params.request_type === 'call_function') {
    const { id } = JSON.parse(Buffer.from(params.args_base64, 'base64'));
    result = { block_height: 100, block_hash: '11111111111111111111111111111111', result: [...Buffer.from(JSON.stringify(states.get(id) || null))] };
  } else if (params.request_type === 'view_access_key') {
    result = { nonce: 1, permission: 'FullAccess', block_hash: '11111111111111111111111111111111' };
  } else throw new Error('Unexpected RPC');
  return new Response(JSON.stringify({ result }));
};
const config = () => ({ ...s.config, nearContract: 'escrow.testnet' });
before(async () => {
  s = await startStack();
  creator = await completeSetup(s.db, await signInFromX(s.db, { id: '88001', username: 'queue_creator' }), {});
});
after(async () => { if (s) await s.close(); });

async function offer() {
  const bet = await createBet(s.db, creator, { requestId: randomUUID(), claim: 'SYNTHETIC queue test',
    criteria: 'Official result', evidenceSourceUrl: 'https://example.org/result', creatorSide: 'yes', stakeNear: '0.1',
    acceptBy: new Date(Date.now() + 3600000).toISOString(), resolveAt: new Date(Date.now() + 7200000).toISOString() });
  const request = await prepareNearAction(s.db, config(), creator, bet.id,
    { action: 'fund', accountId: 'creator.testnet', publicKey: key }, { fetchImpl });
  return { bet, request };
}

test('bounded reconciliation funds matching state, adds an Inbox item and backs off without X calls', async () => {
  const { bet, request } = await offer();
  states.set(bet.id, { id: bet.id, terms_hash: bet.terms_hash, creator_side: bet.creator_side,
    stake_yocto: bet.stake_yocto, accept_by_ns: ns(bet.accept_by), resolve_at_ns: ns(bet.resolve_at),
    invited_account: null, creator: 'creator.testnet', creator_binding_hash: request.args.binding_hash,
    acceptor: null, status: 'offered', proposal: null });
  const xBefore = s.fakeX.calls.length;
  assert.deepEqual(await syncNearBets(s.db, config(), { fetchImpl, limit: 1 }), { checked: 1, changed: 1, errors: 0 });
  assert.equal((await s.db.one('select count(*)::int as n from inbox where bet_id=$1', [bet.id])).n, 1);
  assert.deepEqual(await syncNearBets(s.db, config(), { fetchImpl }), { checked: 0, changed: 0, errors: 0 });
  assert.equal(s.fakeX.calls.length, xBefore);
});

test('outages back off and preserve unfunded state; an expired absent escrow stops only after finalized proof', async () => {
  const { bet } = await offer();
  failing = true;
  assert.deepEqual(await syncNearBets(s.db, config(), { fetchImpl }), { checked: 1, changed: 0, errors: 1 });
  assert.equal((await s.db.one('select chain_state from bilateral_bets where id=$1', [bet.id])).chain_state, null);
  failing = false;
  await s.db.query("update bilateral_bets set accept_by=clock_timestamp()-interval '1 day', near_attempted_at=null where id=$1", [bet.id]);
  assert.deepEqual(await syncNearBets(s.db, config(), { fetchImpl }), { checked: 1, changed: 0, errors: 0 });
  assert.equal((await s.db.one('select near_absent_after_expiry from bilateral_bets where id=$1', [bet.id])).near_absent_after_expiry, true);
  await s.db.query('update bilateral_bets set near_attempted_at=null where id=$1', [bet.id]);
  assert.deepEqual(await syncNearBets(s.db, config(), { fetchImpl }), { checked: 0, changed: 0, errors: 0 });
  await assert.rejects(syncNearBets(s.db, config(), { limit: 11 }), RangeError);
});
