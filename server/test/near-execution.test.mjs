// INTEGRATION: Exercises verifyNearExecution against synthetic NEAR RPC responses; no database or live RPC calls.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { baseEncode } from 'near-api-js';
import { verifyNearExecution } from '../src/near-execution.mjs';

const hash = '11111111111111111111111111111111';
const otherHash = baseEncode(new Uint8Array(32).fill(1));
const request = {
  id: 'request-7', wallet_account: 'alice.testnet', method: 'withdraw',
  metadata: { contract: 'escrow.testnet', depositYocto: '25' },
  args: { account_id: 'alice.testnet', amount: '25', stated_request_id: 'request-7' },
};
const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64');

function execution(overrides = {}) {
  const tx = {
    hash, signer_id: request.wallet_account, receiver_id: request.metadata.contract,
    actions: [{ FunctionCall: {
      method_name: request.method, args: encoded(request.args), deposit: '25', gas: '100000000000000',
    } }],
  };
  return {
    final_execution_status: 'FINAL', transaction: tx, status: { SuccessValue: encoded(true) },
    ...overrides,
  };
}

function rpcFor(result, { fail = false } = {}) {
  const calls = [];
  const fetchImpl = async (_url, options) => {
    const body = JSON.parse(options.body);
    calls.push(body);
    if (fail) throw new Error('synthetic RPC outage');
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'stated', result }));
  };
  return { fetchImpl, calls };
}

test('a matching withdrawal waits for finality before confirming success', async () => {
  const rpc = rpcFor(execution());
  assert.equal((await verifyNearExecution(request, hash, { fetchImpl: rpc.fetchImpl })).status, 'succeeded');
  assert.deepEqual(rpc.calls[0].params, {
    tx_hash: hash, sender_account_id: request.wallet_account, wait_until: 'FINAL',
  });
});

test('canonical argument key order still matches the recorded request', async () => {
  const reordered = { ...request.args };
  const args = { stated_request_id: reordered.stated_request_id, amount: reordered.amount, account_id: reordered.account_id };
  const result = execution();
  result.transaction.actions[0].FunctionCall.args = encoded(args);
  assert.equal((await verifyNearExecution(request, hash, { fetchImpl: rpcFor(result).fetchImpl })).status, 'succeeded');
});

test('the live RPC integer gas representation matches exactly', async () => {
  const result = execution();
  result.transaction.actions[0].FunctionCall.gas = 100000000000000;
  assert.equal((await verifyNearExecution(request, hash, { fetchImpl: rpcFor(result).fetchImpl })).status, 'succeeded');
});

test('finalized false withdrawal result fails with restored-credit guidance', async () => {
  const result = execution({ status: { SuccessValue: encoded(false) } });
  const answer = await verifyNearExecution(request, hash, { fetchImpl: rpcFor(result).fetchImpl });
  assert.equal(answer.status, 'failed');
  assert.match(answer.explanation, /restored its credit/);
});

test('finalized Failure is failed; receipt and unknown success statuses remain pending', async t => {
  for (const [name, status] of [
    ['Failure', { Failure: { ActionError: {} } }],
    ['receipt success', { SuccessReceiptId: hash }],
    ['unknown success value', { SuccessValue: encoded({ paid: true }) }],
  ]) await t.test(name, async () => {
    const answer = await verifyNearExecution(request, hash, { fetchImpl: rpcFor(execution({ status })).fetchImpl });
    assert.equal(answer.status, name === 'Failure' ? 'failed' : 'pending');
  });
});

test('RPC errors and nonfinal executions remain pending', async t => {
  await t.test('RPC error', async () => {
    const answer = await verifyNearExecution(request, hash, { fetchImpl: rpcFor(null, { fail: true }).fetchImpl });
    assert.equal(answer.status, 'pending');
  });
  await t.test('nonfinal', async () => {
    const answer = await verifyNearExecution(request, hash, {
      fetchImpl: rpcFor(execution({ final_execution_status: 'EXECUTED' })).fetchImpl,
    });
    assert.equal(answer.status, 'pending');
  });
});

test('rejects forged hashes and any mismatch in the wallet transaction', async t => {
  await t.test('forged hash', async () => {
    await assert.rejects(verifyNearExecution(request, otherHash, { fetchImpl: rpcFor(execution()).fetchImpl }), { status: 409 });
  });

  const variants = [
    ['wrong signer', tx => { tx.signer_id = 'mallory.testnet'; }],
    ['wrong contract', tx => { tx.receiver_id = 'other.testnet'; }],
    ['wrong method', tx => { tx.actions[0].FunctionCall.method_name = 'transfer'; }],
    ['wrong args', tx => { tx.actions[0].FunctionCall.args = encoded({ ...request.args, amount: '26' }); }],
    ['wrong deposit', tx => { tx.actions[0].FunctionCall.deposit = '26'; }],
    ['wrong gas', tx => { tx.actions[0].FunctionCall.gas = '99999999999999'; }],
    ['multiple actions', tx => { tx.actions.push(structuredClone(tx.actions[0])); }],
    ['malformed base64 args', tx => { tx.actions[0].FunctionCall.args = 'eyJ4I==!'; }],
    ['missing withdrawal tag', tx => { tx.actions[0].FunctionCall.args = encoded({ account_id: 'alice.testnet', amount: '25' }); }],
  ];
  for (const [name, mutate] of variants) await t.test(name, async () => {
    const result = execution();
    mutate(result.transaction);
    await assert.rejects(verifyNearExecution(request, hash, { fetchImpl: rpcFor(result).fetchImpl }), { status: 409 });
  });
});

test('legacy withdrawal request without its unique tag is rejected before RPC', async () => {
  const legacy = { ...request, args: { account_id: 'alice.testnet', amount: '25' } };
  let called = false;
  await assert.rejects(verifyNearExecution(legacy, hash, {
    fetchImpl: async () => { called = true; throw new Error('must not call RPC'); },
  }), { status: 409 });
  assert.equal(called, false);
});

test('generic nonwithdraw action succeeds only after exact transaction match', async t => {
  const generic = {
    id: 'request-fund', wallet_account: request.wallet_account, method: 'create_bet',
    metadata: request.metadata, args: { id: 'bet-3', stake_yocto: '25' },
  };
  const result = execution();
  result.transaction.actions[0].FunctionCall.method_name = generic.method;
  result.transaction.actions[0].FunctionCall.args = encoded(generic.args);
  const successful = await verifyNearExecution(generic, hash, { fetchImpl: rpcFor(result).fetchImpl });
  assert.equal(successful.status, 'succeeded');
  assert.match(successful.explanation, /completed/);

  await t.test('mismatch remains rejected despite successful return', async () => {
    const forged = execution();
    forged.transaction.actions[0].FunctionCall.method_name = 'other_method';
    await assert.rejects(verifyNearExecution(generic, hash, { fetchImpl: rpcFor(forged).fetchImpl }), { status: 409 });
  });
  await t.test('empty return value succeeds after exact match', async () => {
    result.status = { SuccessValue: '' };
    assert.equal((await verifyNearExecution(generic, hash, { fetchImpl: rpcFor(result).fetchImpl })).status, 'succeeded');
  });
});
