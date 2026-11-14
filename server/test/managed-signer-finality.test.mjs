import test from 'node:test';
import assert from 'node:assert/strict';
import { baseEncode, KeyPair, SignedTransaction } from 'near-api-js';
import { nearChain } from '../src/play.mjs';

test('managed signer releases only the exact signed action after final execution', async () => {
  let observed;
  const chain = nearChain({ fetchImpl: async (_url, options) => {
    const { id, method } = JSON.parse(options.body);
    const result = method === 'query' ? { nonce: 10, permission: 'FullAccess' }
      : method === 'block' ? { header: { hash: baseEncode(Buffer.alloc(32, 7)), height: 100 } }
        : observed;
    if (!result) return Response.json({ jsonrpc: '2.0', id, error: { code: -32000,
      message: 'Server error', cause: { name: 'UNKNOWN_TRANSACTION' } } });
    return Response.json({ jsonrpc: '2.0', id, result });
  } });
  const secret = KeyPair.fromRandom('ed25519').toString();
  const prepared = await chain.prepareCall({ signerId: 'bettor.near', secret, contractId: 'escrow.near',
    method: 'cancel_bet', args: { id: 'synthetic' } });
  const signed = SignedTransaction.decode(Buffer.from(prepared.signedTransaction, 'base64'));
  const call = signed.transaction.actions[0].functionCall;
  const exact = { final_execution_status: 'FINAL', status: { SuccessValue: '' }, transaction: {
    hash: prepared.hash, signer_id: 'bettor.near', receiver_id: 'escrow.near', actions: [{ FunctionCall: {
      method_name: call.methodName, args: Buffer.from(call.args).toString('base64'),
      deposit: call.deposit.toString(), gas: call.gas.toString() } }] } };
  assert.equal(await chain.preparedFinalized(prepared), false);
  for (const mutate of [
    result => { result.final_execution_status = 'INCLUDED'; },
    result => { result.transaction.hash = baseEncode(Buffer.alloc(32, 8)); },
    result => { result.transaction.signer_id = 'other.near'; },
    result => { result.transaction.receiver_id = 'other.near'; },
    result => { result.transaction.actions[0].FunctionCall.method_name = 'withdraw'; },
    result => { result.transaction.actions[0].FunctionCall.deposit = '1'; },
    result => { result.status = 'NotStarted'; },
  ]) {
    observed = structuredClone(exact);
    mutate(observed);
    assert.equal(await chain.preparedFinalized(prepared), false);
  }
  observed = exact;
  assert.equal(await chain.preparedFinalized(prepared), true);
  observed.status = { Failure: { ActionError: {} } };
  assert.equal(await chain.preparedFinalized(prepared), true, 'final failed execution also consumes its nonce');

  const add = KeyPair.fromRandom('ed25519').getPublicKey().toString();
  const remove = KeyPair.fromString(secret).getPublicKey().toString();
  const rotation = await chain.prepareRotation({ accountId: 'bettor.near', secret,
    addPublicKey: add, removePublicKey: remove });
  observed = { final_execution_status: 'FINAL', status: { SuccessValue: '' }, transaction: {
    hash: rotation.hash, signer_id: 'bettor.near', receiver_id: 'bettor.near', actions: [
      { AddKey: { public_key: add, access_key: { nonce: 0, permission: 'FullAccess' } } },
      { DeleteKey: { public_key: remove } },
    ] } };
  assert.equal(await chain.preparedFinalized(rotation), true);
  observed.transaction.actions[0].AddKey.public_key = remove;
  assert.equal(await chain.preparedFinalized(rotation), false);
});

test('legacy signed-byte absence permits retry only with the exact recorded root rollback', async () => {
  const hash = baseEncode(Buffer.alloc(32, 1));
  const root = baseEncode(Buffer.alloc(32, 2));
  const row = { transaction_hash: hash, wallet_account: 'bettor.near', method: 'accept_bet',
    args: { id: 'synthetic', binding_hash: 'bound' }, metadata: { contract: 'escrow.near', depositYocto: '100000000000000000000000' } };
  const call = { FunctionCall: { method_name: row.method, args: Buffer.from(JSON.stringify(row.args)).toString('base64'),
    deposit: row.metadata.depositYocto, gas: '100000000000000' } };
  const failure = { Failure: { ActionError: { index: 0, kind: { FunctionCallError: 'Synthetic root panic' } } } };
  const exact = { final_execution_status: 'FINAL', status: failure,
    transaction: { hash, signer_id: row.wallet_account, receiver_id: row.metadata.contract, actions: [call] },
    transaction_outcome: { id: hash, outcome: { executor_id: row.wallet_account, receipt_ids: [root], status: { SuccessReceiptId: root } } },
    receipts: [{ receipt_id: root, receiver_id: row.metadata.contract, predecessor_id: row.wallet_account,
      receipt: { Action: { signer_id: row.wallet_account, actions: [call] } } }],
    receipts_outcome: [{ id: root, outcome: { executor_id: row.metadata.contract, receipt_ids: [], status: failure } }] };
  let result = exact;
  const chain = nearChain({ fetchImpl: async (_url, options) => Response.json({ jsonrpc: '2.0', id: JSON.parse(options.body).id, result }) });
  assert.equal(await chain.requestRetrySafe(row), true);
  assert.equal(await chain.requestRetrySafe({ ...row, args: { binding_hash: 'bound', id: 'synthetic' } }), true);
  for (const mutate of [
    value => { value.final_execution_status = 'INCLUDED'; },
    value => { value.transaction.signer_id = 'other.near'; },
    value => { value.transaction.actions[0].FunctionCall.deposit = '1'; },
    value => { value.receipts[0].receipt.Action.actions = []; },
    value => { value.receipts_outcome[0].outcome.status = { SuccessReceiptId: 'failed-callback' }; },
    value => { value.transaction_outcome.outcome.receipt_ids = []; },
  ]) {
    result = structuredClone(exact);
    mutate(result);
    assert.equal(await chain.requestRetrySafe(row), false);
  }
  result = exact;
  assert.equal(await chain.requestRetrySafe({ ...row, args: { id: 'different' } }), false);
});
