import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { KeyPair, SignedTransaction, baseEncode } from 'near-api-js';
import { InvalidNonceError, TransactionExpiredError } from 'near-api-js/rpc-errors';
import { deliveryFromReceipts } from '../src/near-delivery.mjs';
import { nearChain } from '../src/play.mjs';
import { rpc, rpcUrls } from '../src/near-escrow.mjs';

const transactionHash = '9'.repeat(44);
const accountId = 'bettor.stated.testnet';
const wrapContractId = 'wrap.testnet';
const amountYocto = '100000000000000000000000';
const wanted = { transactionHash, accountId, wrapContractId, amountYocto };
const tx = (receipts, final = 'FINAL') => ({
  transaction: { hash: transactionHash, signer_id: receipts[0].sender, receiver_id: receipts[0].receiver,
    actions: receipts[0].transfer ? [{ Transfer: { deposit: receipts[0].transfer } }] : [] },
  final_execution_status: final, status: { SuccessValue: '' },
  transaction_outcome: { id: transactionHash, outcome: { executor_id: receipts[0].sender,
    status: { SuccessReceiptId: '0' }, receipt_ids: ['0'] } },
  receipts: receipts.map(({ receiver, sender, transfer, actions }, i) => ({
    receipt_id: String(i), receiver_id: receiver, predecessor_id: sender,
    receipt: { Action: { signer_id: receipts[0].sender, actions: actions || (transfer ? [{ Transfer: { deposit: transfer } }] : []) } },
  })),
  receipts_outcome: receipts.map(({ receiver, logs = [], failed, children, childResult }, i) => ({
    id: String(i), outcome: { executor_id: receiver, receipt_ids: children || (i === 0 ? receipts.slice(1).map((_r, index) => String(index + 1)) : []),
      status: failed ? { Failure: {} } : childResult ? { SuccessReceiptId: childResult } : { SuccessValue: '' }, logs },
  })),
});
const wrapped = (from, to, amount, receiver = wrapContractId) => ({
  receiver, sender: from, logs: ['EVENT_JSON:' + JSON.stringify({ standard: 'nep141', version: '1.0.0',
    event: 'ft_transfer', data: [{ old_owner_id: from, new_owner_id: to, amount }] })],
});

test('only a finalized successful transfer to the exact account proves native delivery', () => {
  const receipt = { sender: 'solver.testnet', receiver: accountId, transfer: amountYocto };
  assert.deepEqual(deliveryFromReceipts(tx([receipt, { ...receipt, sender: 'system' }]), wanted),
    { final: true, kind: 'native', deliveredYocto: amountYocto });
  for (const invalid of [tx([receipt], 'EXECUTED'), tx([{ ...receipt, failed: true }]),
    tx([{ ...receipt, receiver: 'someone.testnet' }]), tx([{ ...receipt, transfer: '1' }])]) {
    assert.equal(deliveryFromReceipts(invalid, wanted), null);
  }
});

test('only net wrapped delivery from the actual token contract counts', () => {
  const transfer = wrapped('solver.testnet', accountId, amountYocto);
  assert.deepEqual(deliveryFromReceipts(tx([transfer]), wanted), { final: true, kind: 'wrapped', deliveredYocto: amountYocto });
  assert.equal(deliveryFromReceipts(tx([wrapped('solver.testnet', accountId, amountYocto, 'fake.testnet')]), wanted), null);
  assert.equal(deliveryFromReceipts(tx([transfer, wrapped(accountId, 'solver.testnet', '1')]), wanted), null);
  assert.equal(deliveryFromReceipts(tx([{ ...transfer, failed: true }]), wanted), null);
  const older = { ...transfer, logs: [`Transfer ${amountYocto} from solver.testnet to ${accountId}`] };
  assert.deepEqual(deliveryFromReceipts(tx([older]), wanted), { final: true, kind: 'wrapped', deliveredYocto: amountYocto });
  assert.equal(deliveryFromReceipts(tx([{ ...older, logs: [...older.logs, `Refund 1 from ${accountId} to solver.testnet`] }]), wanted), null);
});

test('orphan, duplicate, missing and misattributed outcomes cannot prove a delivery', () => {
  const sender = 'solver.testnet';
  const transfer = { sender, receiver: accountId, transfer: amountYocto };
  const orphan = tx([{ sender, receiver: sender, children: [] }, transfer]);
  const duplicate = tx([transfer]);
  duplicate.receipts_outcome.push(structuredClone(duplicate.receipts_outcome[0]));
  const missing = tx([transfer]);
  missing.receipts_outcome[0].outcome.receipt_ids = ['missing-resolver'];
  const wrongSender = tx([{ sender, receiver: 'relay.testnet' }, transfer]);
  const mismatchedRoot = tx([transfer]);
  mismatchedRoot.transaction.actions[0].Transfer.deposit = '1';
  for (const result of [orphan, duplicate, missing, wrongSender, mismatchedRoot]) {
    assert.equal(deliveryFromReceipts(result, wanted), null);
  }
});

test('a native return to the original signer cannot prove new funds', () => {
  const relay = 'relay.testnet';
  const call = { FunctionCall: { method_name: 'refund', deposit: amountYocto } };
  const transfer = tx([{ sender: accountId, receiver: relay, actions: [call] }, { sender: relay, receiver: accountId, transfer: amountYocto }]);
  transfer.transaction.actions = [call];
  assert.equal(deliveryFromReceipts(transfer, wanted), null);
});

test('configured RPC URLs are normalized and malformed lists fail closed', () => {
  assert.deepEqual(rpcUrls({ STATED_NEAR_RPC: ' HTTPS://one.example:443, https://one.example/,https://two.example/near ' }),
    ['https://one.example/', 'https://two.example/near']);
  for (const value of ['https://ok.example,http://invalid.example', 'https://user:pass@host.example',
    'https://foo.example/#bar', 'garbage', 'https://one.example,', 'https://bad\\host.example']) {
    assert.throws(() => rpcUrls({ STATED_NEAR_RPC: value }), /STATED_NEAR_RPC/);
  }
  assert.ok(rpcUrls({}).length);
});

test('RPC requires a matching response envelope and bounds the response stream', async () => {
  const request = (answer) => rpc('status', [], { fetchImpl: async () => answer });
  await assert.rejects(request(Response.json({ jsonrpc: '2.0', id: 'wrong', result: {} })), /Invalid NEAR RPC response/);
  await assert.rejects(request(Response.json({ jsonrpc: '1.0', id: 'stated', result: {} })), /Invalid NEAR RPC response/);
  await assert.rejects(request(new Response(' '.repeat(1024 * 1024 + 1))), /response too large/);
});

for (const status of [400, 422]) {
  test(`HTTP ${status} preserves a bound RPC method error without accepting an error-status result`, async () => {
    const request = payload => rpc('tx_status', {}, { fetchImpl: async () => Response.json(payload, { status }) });
    await assert.rejects(request({ jsonrpc: '2.0', id: 'stated', error: { code: -32601, message: 'method is not available' } }),
      error => error.rpcCode === -32601);
    await assert.rejects(request({ jsonrpc: '2.0', id: 'wrong', error: { code: -32601, message: 'method is not available' } }),
      /Invalid NEAR RPC response/);
    await assert.rejects(request({ jsonrpc: '2.0', id: 'stated', result: { forged: true } }), /NEAR RPC HTTP/);
  });
}

test('an HTTP400 method error falls back to finalized legacy receipts for the exact payout', async () => {
  const recorded = JSON.parse(readFileSync(new URL('./fixtures/hosted-court-payout-rpc.json', import.meta.url)));
  const result = recorded.providers[0].responses.withdrawal.result;
  const calls = [];
  const chain = nearChain({ fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    calls.push(request.method);
    if (request.method === 'tx_status') return Response.json({ jsonrpc: '2.0', id: 'stated',
      error: { code: -32601, message: 'method is not available' } }, { status: 400 });
    assert.equal(request.method, 'EXPERIMENTAL_tx_status');
    assert.equal(request.params.tx_hash, result.transaction.hash);
    return Response.json({ jsonrpc: '2.0', id: 'stated', result });
  } });
  assert.deepEqual(await chain.depositDelivery({ transactionHash: result.transaction.hash,
    accountId: result.transaction.signer_id, amountYocto: '20000000000000000000000', wrapContractId, unwrap: true }),
  { final: true, kind: 'native', deliveredYocto: '20000000000000000000000' });
  assert.deepEqual(calls, ['tx_status', 'EXPERIMENTAL_tx_status']);
});

test('the recorded finalized NEAR receipt graph still proves its escrow payout', () => {
  const recorded = JSON.parse(readFileSync(new URL('./fixtures/hosted-court-payout-rpc.json', import.meta.url)));
  for (const provider of Object.values(recorded.providers)) {
    const result = provider.responses.withdrawal.result;
    const payment = { transactionHash: result.transaction.hash, accountId: result.transaction.signer_id,
      amountYocto: '20000000000000000000000', wrapContractId, unwrap: true };
    assert.deepEqual(deliveryFromReceipts(result, payment),
      { final: true, kind: 'native', deliveredYocto: payment.amountYocto });
    const missingRefund = structuredClone(result);
    missingRefund.receipts.pop();
    assert.equal(deliveryFromReceipts(missingRefund, payment), null);
  }
});

test('local self-call receipt omission and legacy RPC fallback preserve delivery verification', async () => {
  const destination = tx([{ sender: 'solver.testnet', receiver: 'solver.testnet' },
    { sender: 'solver.testnet', receiver: accountId, transfer: amountYocto }]);
  destination.receipts.shift();
  const methods = [];
  const chain = nearChain({ fetchImpl: async (_url, options) => {
    const { method, params } = JSON.parse(options.body);
    methods.push(method);
    assert.equal(params.wait_until, 'NONE');
    if (method === 'tx_status') return Response.json({ jsonrpc: '2.0', id: 'stated',
      error: { code: -32601, message: 'Method not found' } });
    return Response.json({ jsonrpc: '2.0', id: 'stated', result: destination });
  } });
  assert.deepEqual(await chain.depositDelivery(wanted), { final: true, kind: 'native', deliveredYocto: amountYocto });
  assert.deepEqual(methods, ['tx_status', 'EXPERIMENTAL_tx_status']);
});

test('old-style RPC missing-key results cannot authorize treasury or account recovery', async () => {
  const testChain = (result) => nearChain({ fetchImpl: async () => Response.json({ jsonrpc: '2.0', id: 'stated', result }) });
  assert.equal(await testChain({ error: 'access key ed25519:public does not exist while viewing' }).hasKey(accountId, 'ed25519:public'), false);
  assert.equal(await testChain({ nonce: 42, permission: 'FullAccess' }).hasKey(accountId, 'ed25519:public', { fullAccess: true }), true);
  assert.equal(await testChain({ nonce: 42, permission: { FunctionCall: {} } }).hasKey(accountId, 'ed25519:public', { fullAccess: true }), false);
  await assert.rejects(testChain({ error: 'internal error' }).hasKey(accountId, 'ed25519:public'), /Invalid NEAR access key/);
});

test('a definitely absent prepared unwrap broadcasts once and verifies its real receipt graph', async () => {
  let prepared;
  let broadcasts = 0;
  let lookups = 0;
  const call = { FunctionCall: { method_name: 'near_withdraw', deposit: '1', gas: 30000000000000,
    args: Buffer.from(JSON.stringify({ amount: amountYocto })).toString('base64') } };
  const chain = nearChain({ fetchImpl: async (_url, options) => {
    const request = JSON.parse(options.body);
    const reply = (result) => Response.json({ jsonrpc: '2.0', id: request.id, result });
    if (request.method === 'query') return reply({ nonce: 10, permission: 'FullAccess' });
    if (request.method === 'block') return reply({ header: { hash: baseEncode(Buffer.alloc(32, 7)), height: 100 } });
    if (request.method === 'send_tx') {
      broadcasts += 1;
      assert.equal(request.params.signed_tx_base64, prepared.signedTransaction);
      assert.equal(request.params.wait_until, 'FINAL');
      return reply({ final_execution_status: 'FINAL', transaction: { hash: prepared.hash,
        signer_id: accountId, receiver_id: wrapContractId }, status: { SuccessValue: '' } });
    }
    assert.equal(request.method, 'tx_status');
    lookups += 1;
    if (!broadcasts) return Response.json({ jsonrpc: '2.0', id: request.id,
      error: { code: -32000, name: 'HANDLER_ERROR', message: 'Server error',
        cause: { name: 'UNKNOWN_TRANSACTION', info: { requested_transaction_hash: prepared.hash } } } });
    const result = tx([{ sender: accountId, receiver: wrapContractId, actions: [call] },
      { sender: wrapContractId, receiver: accountId, transfer: (BigInt(amountYocto) + 1n).toString() }]);
    result.transaction.hash = prepared.hash;
    result.transaction.actions = [call];
    result.transaction_outcome.id = prepared.hash;
    return reply(result);
  } });
  prepared = await chain.prepareCall({ signerId: accountId, secret: KeyPair.fromRandom('ed25519').toString(),
    contractId: wrapContractId, method: 'near_withdraw', args: { amount: amountYocto },
    depositYocto: '1', gas: 30000000000000n });
  const payment = { transactionHash: prepared.hash, accountId, amountYocto };
  if (!await chain.unwrapDelivery(payment)) await chain.broadcastCall(prepared);
  assert.equal(await chain.unwrapDelivery(payment), true);
  assert.equal(broadcasts, 1);
  assert.equal(lookups, 2);
});

test('unwrap lookup failures stay errors unless the RPC definitely names an unknown transaction', async () => {
  const payment = { transactionHash, accountId, amountYocto };
  for (const fetchImpl of [
    async () => { throw new Error('Synthetic RPC outage'); },
    async () => Response.json({ jsonrpc: '2.0', id: 'stated',
      error: { code: -32000, message: 'UNKNOWN_TRANSACTION without a structured cause' } }),
    async () => Response.json({ jsonrpc: '2.0', id: 'wrong', result: {} }),
  ]) await assert.rejects(nearChain({ fetchImpl }).unwrapDelivery(payment));
});

test('ordinary real SDK sends recover from a shared nonce conflict with a bounded retry', async () => {
  let nonce = 10;
  const sentNonces = [];
  const chain = nearChain({ fetchImpl: async (_url, options) => {
    const { id, method, params } = JSON.parse(options.body);
    const reply = result => Response.json({ jsonrpc: '2.0', id, result });
    if (method === 'query') return reply({ nonce, permission: 'FullAccess' });
    if (method === 'block') return reply({ header: { hash: baseEncode(Buffer.alloc(32, 7)), height: 100 } });
    if (method === 'tx') return Response.json({ jsonrpc: '2.0', id, error: {
      code: -32000, message: 'Server error', cause: { name: 'UNKNOWN_TRANSACTION' },
    } });
    assert.equal(method, 'send_tx');
    const signed = SignedTransaction.decode(Buffer.from(params.signed_tx_base64, 'base64'));
    const next = Number(signed.transaction.nonce);
    sentNonces.push(next);
    if (next <= nonce) return Response.json({ jsonrpc: '2.0', id, error: {
      code: -32000, name: 'HANDLER_ERROR', message: 'Server error', cause: { name: 'INVALID_TRANSACTION' },
      data: { TxExecutionError: { InvalidTxError: { InvalidNonce: { ak_nonce: nonce, tx_nonce: next } } } },
    } });
    nonce = next;
    return reply({ final_execution_status: 'FINAL', status: { SuccessValue: '' }, transaction: {
      hash: baseEncode(createHash('sha256').update(signed.transaction.encode()).digest()),
      signer_id: signed.transaction.signerId, receiver_id: signed.transaction.receiverId } });
  } });
  const secret = KeyPair.fromRandom('ed25519').toString();
  const results = await Promise.all(['alice.testnet', 'bob.testnet'].map(toId => chain.transfer({
    fromId: 'treasury.testnet', secret, toId, amountYocto: '1',
  })));
  assert.ok(results.every(result => result.ok));
  assert.deepEqual(sentNonces, [11, 11, 12]);
  assert.equal(new Set(results.map(result => result.hash)).size, 2);
  let rejected = 0;
  const alwaysStale = nearChain({ fetchImpl: async (_url, options) => {
    const { id, method } = JSON.parse(options.body);
    if (method === 'tx') return Response.json({ jsonrpc: '2.0', id, error: {
      code: -32000, message: 'Server error', cause: { name: 'UNKNOWN_TRANSACTION' },
    } });
    if (method !== 'send_tx') return Response.json({ jsonrpc: '2.0', id, result: method === 'query'
      ? { nonce: 10, permission: 'FullAccess' } : { header: { hash: baseEncode(Buffer.alloc(32, 7)), height: 100 } } });
    rejected += 1;
    return Response.json({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Server error',
      cause: { name: 'INVALID_TRANSACTION' },
      data: { TxExecutionError: { InvalidTxError: { InvalidNonce: { ak_nonce: 11, tx_nonce: 11 } } } } } });
  } });
  await assert.rejects(alwaysStale.transfer({ fromId: 'treasury.testnet', secret, toId: 'alice.testnet', amountYocto: '1' }), InvalidNonceError);
  assert.equal(rejected, 3);
});

test('a lost send response followed by failover InvalidNonce never signs a second transfer', async () => {
  for (const historyAvailable of [true, false]) {
    let nonce = 10;
    let executed = null;
    let debits = 0;
    const attempts = [];
    const signedBytes = [];
    const chain = nearChain({ urls: ['https://first-rpc.example', 'https://second-rpc.example'],
      fetchImpl: async (url, options) => {
        const { id, method, params } = JSON.parse(options.body);
        const reply = result => Response.json({ jsonrpc: '2.0', id, result });
        if (method === 'query') return reply({ nonce, permission: 'FullAccess' });
        if (method === 'block') return reply({ header: { hash: baseEncode(Buffer.alloc(32, 7)), height: 100 } });
        if (method === 'tx') {
          assert.equal(params.tx_hash, executed.transaction.hash);
          return historyAvailable ? reply(executed) : Response.json({ jsonrpc: '2.0', id,
            error: { code: -32000, message: 'Server error', cause: { name: 'UNKNOWN_TRANSACTION' } } });
        }
        assert.equal(method, 'send_tx');
        const signed = SignedTransaction.decode(Buffer.from(params.signed_tx_base64, 'base64'));
        attempts.push(Number(signed.transaction.nonce));
        signedBytes.push(params.signed_tx_base64);
        if (signed.transaction.nonce <= BigInt(nonce)) return Response.json({ jsonrpc: '2.0', id,
          error: { code: -32000, message: 'Server error', cause: { name: 'INVALID_TRANSACTION' },
            data: { TxExecutionError: { InvalidTxError: { InvalidNonce: { ak_nonce: nonce,
              tx_nonce: Number(signed.transaction.nonce) } } } } } });
        debits += 1;
        nonce = Number(signed.transaction.nonce);
        executed = { final_execution_status: 'FINAL', status: { SuccessValue: '' }, transaction: {
          hash: baseEncode(createHash('sha256').update(signed.transaction.encode()).digest()),
          signer_id: signed.transaction.signerId, receiver_id: signed.transaction.receiverId } };
        if (url === 'https://first-rpc.example' && debits === 1) throw new TypeError('Synthetic response lost after execution');
        return reply(executed);
      } });
    const result = await chain.transfer({ fromId: 'treasury.testnet', secret: KeyPair.fromRandom('ed25519').toString(),
      toId: 'alice.testnet', amountYocto: '100' });
    assert.equal(debits, 1);
    assert.deepEqual(attempts, [11, 11]);
    assert.equal(new Set(signedBytes).size, 1);
    assert.equal(result.hash, executed.transaction.hash);
    assert.equal(result.ok, historyAvailable);
    if (!historyAvailable) assert.match(result.failure, /Final success not established/);
  }
});

test('retiring an unwrap requires healthy absence plus finalized nonce or expiry evidence', async () => {
  let prepared, existing = false, outage = false, rootFailure = false, finalNonce = 10, height = 200;
  const referenceHash = baseEncode(Buffer.alloc(32, 7));
  const chain = nearChain({ fetchImpl: async (_url, options) => {
    const { id, method, params } = JSON.parse(options.body);
    const reply = result => Response.json({ jsonrpc: '2.0', id, result });
    if (method === 'tx_status') {
      if (outage) throw new Error('Synthetic status outage');
      if (rootFailure) {
        const signed = SignedTransaction.decode(Buffer.from(prepared.signedTransaction, 'base64'));
        const call = signed.transaction.actions[0].functionCall;
        const actions = [{ FunctionCall: { method_name: call.methodName, deposit: call.deposit.toString(),
          gas: Number(call.gas), args: Buffer.from(call.args).toString('base64') } }];
        const result = tx([{ sender: accountId, receiver: wrapContractId, actions, failed: true }]);
        result.transaction.hash = prepared.hash;
        result.transaction.actions = actions;
        result.transaction_outcome.id = prepared.hash;
        result.status = { Failure: { ActionError: { index: 0, kind: { FunctionCallError: 'Synthetic root panic' } } } };
        return reply(result);
      }
      if (existing) return reply({ final_execution_status: 'INCLUDED' });
      return Response.json({ jsonrpc: '2.0', id, error: { code: -32000, message: 'Server error',
        cause: { name: 'UNKNOWN_TRANSACTION' } } });
    }
    if (method === 'query') return reply({ nonce: finalNonce, permission: 'FullAccess' });
    if (method === 'EXPERIMENTAL_protocol_config') return reply({ transaction_validity_period: 100 });
    assert.equal(method, 'block');
    const reference = params.block_id === referenceHash || !prepared;
    return reply({ header: { hash: reference ? referenceHash : baseEncode(Buffer.alloc(32, 8)),
      height: reference ? 100 : height } });
  } });
  // Prepare against reference block 100, then bind that exact block hash in the
  // mocked archival view used to prove the later expiration boundary.
  prepared = await chain.prepareCall({ signerId: accountId, secret: KeyPair.fromRandom('ed25519').toString(),
    contractId: wrapContractId, method: 'near_withdraw', args: { amount: amountYocto }, depositYocto: '1' });
  const payment = { signedTransaction: prepared.signedTransaction, transactionHash: prepared.hash };
  const nonceError = new InvalidNonceError(11, 11);
  assert.equal(await chain.unwrapRetrySafe(payment, nonceError), false);
  finalNonce = 11;
  assert.equal(await chain.unwrapRetrySafe(payment, nonceError), false,
    'a consumed nonce may represent a successful unwrap whose response was lost');
  rootFailure = true;
  assert.equal(await chain.unwrapRetrySafe(payment, nonceError), true);
  rootFailure = false;
  existing = true;
  assert.equal(await chain.unwrapRetrySafe(payment, nonceError), false);
  existing = false;
  outage = true;
  await assert.rejects(chain.unwrapRetrySafe(payment, nonceError), /Synthetic status outage/);
  outage = false;
  assert.equal(await chain.unwrapRetrySafe(payment, new Error('Ambiguous send')), false);
  // The signed block is block 100 in this fixture. Its 100-block window must
  // have elapsed in finalized history before an expired signature is retired.
  finalNonce = 10;
  height = 200;
  assert.equal(await chain.unwrapRetrySafe(payment, new TransactionExpiredError()), false);
  height = 201;
  assert.equal(await chain.unwrapRetrySafe(payment, new TransactionExpiredError()), true);
});
