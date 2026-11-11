// INTEGRATION: Real Postgres and HTTP with simulated NEAR RPC; no live wallet or external RPC calls.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { baseEncode } from 'near-api-js';
import { createBet } from '../src/bets.mjs';
import { prepareNearAction } from '../src/near-bets.mjs';
import { TESTNET_RPC } from '../src/near-escrow.mjs';
import { completeSetup, signInFromX } from '../src/store.mjs';
import { startStack } from './support/app.mjs';

let s, creator, browser;
let execution;
let rpcFailure = false;
const calls = [];
const fetchImpl = async (url, options) => {
  if (url !== TESTNET_RPC) {
    if (s && String(url).startsWith(s.fakeX.base)) return fetch(url, options);
    throw new Error(`Unexpected external request: ${url}`);
  }
  const body = JSON.parse(options.body);
  calls.push(body);
  if (body.method === 'tx') {
    if (rpcFailure) throw new Error('Synthetic RPC outage');
    const result = execution?.final_execution_status === 'FINAL' && body.params.wait_until !== 'FINAL'
      ? { final_execution_status: 'INCLUDED' } : execution;
    return new Response(JSON.stringify({ result }));
  }
  if (body.method === 'query' && body.params.method_name === 'get_bet') {
    return new Response(JSON.stringify({ result: { block_height: 100, result: [...Buffer.from('null')] } }));
  }
  throw new Error(`Unexpected synthetic NEAR RPC method: ${body.method}`);
};

before(async () => {
  s = await startStack({ STATED_NEAR_CONTRACT: 'escrow.testnet' }, { fetchImpl });
  creator = await completeSetup(s.db, await signInFromX(s.db, { id: '98101', username: 'finality_creator' }), {});
  browser = await s.signIn(s.fakeX.addUser('98101', 'finality_creator'));
});
after(async () => { if (s) await s.close(); });

async function requestFixture() {
  const bet = await createBet(s.db, creator, { requestId: randomUUID(), claim: 'SYNTHETIC finality check',
    criteria: 'Official evidence', evidenceSourceUrl: 'https://example.org/result', creatorSide: 'yes', stakeNear: '0.1',
    acceptBy: new Date(Date.now() + 86400000).toISOString(), resolveAt: new Date(Date.now() + 172800000).toISOString() });
  const prepared = await prepareNearAction(s.db, s.config, creator, bet.id,
    { action: 'fund', accountId: 'creator.testnet' }, { fetchImpl });
  return { bet, request: await s.db.one('select * from bilateral_near_requests where id=$1', [prepared.requestId]) };
}

function finalized(request, hash) {
  return { final_execution_status: 'FINAL', transaction: { hash, signer_id: request.wallet_account,
    receiver_id: request.metadata.contract, actions: [{ FunctionCall: { method_name: request.method,
      args: Buffer.from(JSON.stringify(request.args)).toString('base64'), deposit: request.metadata.depositYocto,
      gas: '100000000000000' } }] }, status: { SuccessValue: '' } };
}

test('the wallet callback waits for finality and renders confirmed on its first response', async () => {
  const { bet, request } = await requestFixture();
  const hash = baseEncode(new Uint8Array(32).fill(91));
  execution = finalized(request, hash);
  calls.length = 0;

  const page = await browser.submit(`/bets/${bet.id}/transactions`, { requestId: request.id, transactionHash: hash }, { from: `/bets/${bet.id}` });

  assert.equal(page.status, 200);
  assert.match(page.text, /transaction completed/i);
  assert.equal((await s.db.one('select execution_status from bilateral_near_requests where id=$1', [request.id])).execution_status, 'succeeded');
  const txCall = calls.find(call => call.method === 'tx');
  assert.equal(txCall.params.wait_until, 'FINAL');
});

test('nonfinal results and RPC failures remain pending with the submitted hash recoverable', async t => {
  await t.test('included result', async () => {
    const { bet, request } = await requestFixture();
    const hash = baseEncode(new Uint8Array(32).fill(92));
    execution = { final_execution_status: 'INCLUDED' };
    rpcFailure = false;
    const page = await browser.submit(`/bets/${bet.id}/transactions`, { requestId: request.id, transactionHash: hash }, { from: `/bets/${bet.id}` });
    assert.equal(page.status, 200);
    const stored = await s.db.one('select execution_status, transaction_hash from bilateral_near_requests where id=$1', [request.id]);
    assert.equal(stored.execution_status, 'pending');
    assert.equal(stored.transaction_hash, hash);
    assert.doesNotMatch(page.text, /transaction completed/i);
    assert.match(page.text, new RegExp(`value="${hash}"`), 'the recovery form retains the submitted hash');
  });

  await t.test('RPC failure', async () => {
    const { bet, request } = await requestFixture();
    const hash = baseEncode(new Uint8Array(32).fill(93));
    rpcFailure = true;
    const page = await browser.submit(`/bets/${bet.id}/transactions`, { requestId: request.id, transactionHash: hash }, { from: `/bets/${bet.id}` });
    assert.equal(page.status, 200);
    const stored = await s.db.one('select execution_status, transaction_hash from bilateral_near_requests where id=$1', [request.id]);
    assert.equal(stored.execution_status, 'pending');
    assert.equal(stored.transaction_hash, hash);
    assert.doesNotMatch(page.text, /transaction completed/i);
    assert.match(page.text, new RegExp(`value="${hash}"`), 'the recovery form retains the submitted hash');
  });
});
