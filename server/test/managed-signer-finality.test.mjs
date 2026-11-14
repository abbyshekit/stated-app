import test from 'node:test';
import assert from 'node:assert/strict';
import { baseEncode, KeyPair, PublicKey, SignedTransaction } from 'near-api-js';
import { nearChain } from '../src/play.mjs';
import { TransactionExpiredError } from 'near-api-js/rpc-errors';
import { assertTreasuryCreationAvailable, treasuryCreationKey } from '../src/treasury-liquidity.mjs';

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

test('durable account creation retires only after expiry and an unused finalized nonce', async () => {
  let height = 100; let nonce = 10;
  const reference = baseEncode(Buffer.alloc(32, 7)); const head = baseEncode(Buffer.alloc(32, 8));
  const chain = nearChain({ fetchImpl: async (_url, options) => {
    const { id, method, params } = JSON.parse(options.body);
    const reply = result => Response.json({ jsonrpc: '2.0', id, result });
    if (method === 'query') return reply({ nonce, permission: 'FullAccess' });
    if (method === 'block') return reply({ header: params.block_id === reference || height === 100
      ? { height: 100, hash: reference } : { height, hash: head } });
    if (method === 'EXPERIMENTAL_protocol_config') return reply({ transaction_validity_period: 100 });
    assert.ok(['tx', 'tx_status'].includes(method));
    return Response.json({ jsonrpc: '2.0', id, error: { code: -32000,
      message: 'Server error', cause: { name: 'UNKNOWN_TRANSACTION' } } });
  } });
  const publicKey = KeyPair.fromRandom('ed25519').getPublicKey().toString();
  const prepared = await chain.prepareCreateAccount({ parentId: 'sponsor.near', parentSecret: KeyPair.fromRandom('ed25519').toString(),
    accountId: 'user.sponsor.near', publicKey, amountYocto: '250000000000000000000000' });
  const signed = SignedTransaction.decode(Buffer.from(prepared.signedTransaction, 'base64'));
  assert.equal(signed.transaction.signerId, 'sponsor.near');
  assert.equal(signed.transaction.receiverId, 'user.sponsor.near');
  assert.equal(signed.transaction.actions.length, 3);
  assert.ok(signed.transaction.actions[0].createAccount);
  assert.equal(signed.transaction.actions[1].transfer.deposit, 250000000000000000000000n);
  assert.equal(PublicKey.from(signed.transaction.actions[2].addKey.publicKey).toString(), publicKey);
  const retry = () => chain.preparedRetrySafe({ ...prepared, transactionHash: prepared.hash }, new TransactionExpiredError());
  assert.equal(await retry(), false, 'a missing transaction can still execute');
  height = 201;
  assert.equal(await retry(), true, 'expired bytes with an unused nonce can be replaced');
  nonce = Number(signed.transaction.nonce);
  assert.equal(await retry(), false, 'a consumed nonce may represent this exact lost successful creation');
});

test('any treasury caller releases funding fences only after exact finality or conclusive expiry', async () => {
  let observed; let height = 100; let nonce = 10;
  const reference = baseEncode(Buffer.alloc(32, 7)); const head = baseEncode(Buffer.alloc(32, 8));
  const chain = nearChain({ fetchImpl: async (_url, options) => {
    const { id, method, params } = JSON.parse(options.body);
    const reply = result => Response.json({ jsonrpc: '2.0', id, result });
    if (method === 'query') return reply({ nonce, permission: 'FullAccess' });
    if (method === 'block') return reply({ header: params.block_id === reference || height === 100
      ? { height: 100, hash: reference } : { height, hash: head } });
    if (method === 'EXPERIMENTAL_protocol_config') return reply({ transaction_validity_period: 100 });
    assert.ok(['tx', 'tx_status'].includes(method), 'reconciliation never broadcasts a transaction');
    return observed ? reply(observed) : Response.json({ jsonrpc: '2.0', id, error: { code: -32000,
      message: 'Server error', cause: { name: 'UNKNOWN_TRANSACTION' } } });
  } });
  const secret = KeyPair.fromRandom('ed25519').toString();
  const publicKey = KeyPair.fromRandom('ed25519').getPublicKey().toString();
  for (const creation of [true, false]) {
    nonce = 10; height = 100;
    const amount = '250000000000000000000000';
    const prepared = creation ? await chain.prepareCreateAccount({ parentId: 'sponsor.near', parentSecret: secret,
      accountId: 'user.sponsor.near', publicKey, amountYocto: amount })
      : await chain.prepareTransfer({ fromId: 'sponsor.near', secret, toId: 'user.sponsor.near', amountYocto: amount });
    const signed = SignedTransaction.decode(Buffer.from(prepared.signedTransaction, 'base64'));
    const exact = { final_execution_status: 'FINAL', status: { SuccessValue: '' }, transaction: {
      hash: prepared.hash, signer_id: 'sponsor.near', receiver_id: 'user.sponsor.near', actions: creation
        ? ['CreateAccount', { Transfer: { deposit: amount } }, { AddKey: { public_key: publicKey,
          access_key: { nonce: 0, permission: 'FullAccess' } } }]
        : [{ Transfer: { deposit: amount } }] } };
    const intent = JSON.stringify({ ...prepared, accountId: 'user.sponsor.near' });
    let stored;
    const db = { one: async () => stored ? { value: stored } : null, query: async (sql, args) => {
      if (sql.startsWith('insert into kv')) return;
      assert.equal(sql, 'delete from kv where key=$1 and value=$2');
      assert.deepEqual(args, [treasuryCreationKey('sponsor.near'), intent]); stored = null;
    } };
    const reconcile = () => assertTreasuryCreationAvailable(db, chain, 'sponsor.near', 'other.sponsor.near');
    for (const mutate of [
      result => { result.transaction.hash = baseEncode(Buffer.alloc(32, 9)); },
      result => { result.transaction.receiver_id = 'other.near'; },
      result => { result.transaction.signer_id = 'other.near'; },
      result => { result.transaction.actions[creation ? 1 : 0].Transfer.deposit = '1'; },
      result => { result.final_execution_status = 'INCLUDED'; result.status = { Failure: { ActionError: {} } }; },
      result => { result.status = { SuccessReceiptId: 'unfinished-receipt' }; },
      result => { result.status.Failure = { ActionError: {} }; },
    ]) {
      stored = intent; observed = structuredClone(exact); mutate(observed);
      await assert.rejects(reconcile(), /transaction is still pending/);
      assert.equal(stored, intent, 'ambiguous or mismatched proof retains the durable fence');
    }
    for (const status of [{ SuccessValue: '' }, { Failure: { ActionError: {} } }]) {
      stored = intent; observed = { ...exact, status };
      assert.equal(await reconcile(), null);
      assert.equal(stored, null, 'an exact terminal result releases the signer without resending');
    }
    stored = intent; observed = null;
    await assert.rejects(reconcile(), /transaction is still pending/);
    height = 201; nonce = Number(signed.transaction.nonce);
    await assert.rejects(reconcile(), /transaction is still pending/, 'consumed nonce can be this lost successful transaction');
    nonce = 10;
    assert.equal(await reconcile(), null, 'expired bytes and an unused finalized nonce cannot execute later');
    assert.equal(stored, null);
  }
});

test('funding freshness uses the finalized recipient receipt block rather than transaction inclusion', async () => {
  const reference = baseEncode(Buffer.alloc(32, 7)); const receiptBlock = baseEncode(Buffer.alloc(32, 9));
  const root = baseEncode(Buffer.alloc(32, 6));
  let observed; let receiptHeight = 120; const blockReads = [];
  const chain = nearChain({ fetchImpl: async (_url, options) => {
    const { id, method, params } = JSON.parse(options.body);
    const reply = result => Response.json({ jsonrpc: '2.0', id, result });
    if (method === 'query') return reply({ nonce: 10, permission: 'FullAccess' });
    if (method === 'block') {
      blockReads.push(params.block_id);
      return reply({ header: params.block_id === receiptBlock ? { hash: receiptBlock, height: receiptHeight }
        : { hash: reference, height: 100 } });
    }
    assert.ok(['tx', 'tx_status'].includes(method)); return reply(observed);
  } });
  const prepared = await chain.prepareTransfer({ fromId: 'sponsor.near', secret: KeyPair.fromRandom('ed25519').toString(),
    toId: 'judge.sponsor.near', amountYocto: '200000000000000000000000' });
  const success = { SuccessValue: '' };
  const exact = { final_execution_status: 'FINAL', status: success,
    transaction: { hash: prepared.hash, signer_id: 'sponsor.near', receiver_id: 'judge.sponsor.near',
      actions: [{ Transfer: { deposit: '200000000000000000000000' } }] },
    transaction_outcome: { id: prepared.hash, block_hash: reference,
      outcome: { executor_id: 'sponsor.near', receipt_ids: [root], status: { SuccessReceiptId: root } } },
    receipts_outcome: [{ id: root, block_hash: receiptBlock,
      outcome: { executor_id: 'judge.sponsor.near', status: success } }] };
  observed = exact;
  assert.deepEqual(await chain.preparedFundingFinalized(prepared), { blockHeight: 120, succeeded: true });
  assert.equal(blockReads.at(-1), receiptBlock);
  for (const height of [undefined, '120', -1, Number.MAX_SAFE_INTEGER + 1]) {
    receiptHeight = height;
    assert.equal(await chain.preparedFundingFinalized(prepared), null, 'malformed receipt heights cannot authorize funding');
  }
  receiptHeight = 120;
  for (const mutate of [
    result => { result.receipts_outcome[0].id = 'different-receipt'; },
    result => { result.receipts_outcome[0].outcome.executor_id = 'other.near'; },
    result => { result.receipts_outcome[0].outcome.status = { SuccessReceiptId: 'pending' }; },
    result => { delete result.receipts_outcome[0].block_hash; },
  ]) {
    observed = structuredClone(exact); mutate(observed);
    assert.equal(await chain.preparedFundingFinalized(prepared), null);
  }
  observed = structuredClone(exact);
  observed.status = { Failure: { ActionError: {} } };
  observed.receipts_outcome[0].outcome.status = observed.status;
  assert.deepEqual(await chain.preparedFundingFinalized(prepared), { blockHeight: 120, succeeded: false });

  const call = await chain.prepareCall({ signerId: 'sponsor.near', secret: KeyPair.fromRandom('ed25519').toString(),
    contractId: 'judge.sponsor.near', method: 'request_ruling', args: { bet_id: 'synthetic' }, gas: 300000000000000n });
  const signedCall = SignedTransaction.decode(Buffer.from(call.signedTransaction, 'base64')).transaction.actions[0].functionCall;
  const action = { FunctionCall: { method_name: signedCall.methodName, args: Buffer.from(signedCall.args).toString('base64'),
    deposit: signedCall.deposit.toString(), gas: signedCall.gas.toString() } };
  observed = structuredClone(exact);
  observed.transaction.hash = call.hash; observed.transaction.actions = [action]; observed.transaction_outcome.id = call.hash;
  observed.receipts_outcome[0].outcome.status = { SuccessReceiptId: 'asynchronous-callback' };
  assert.equal(await chain.preparedFundingFinalized(call), null, 'an asynchronous call is not a direct funding transfer');
  assert.deepEqual(await chain.preparedSpendFinalized(call), { blockHeight: 120, succeeded: true }, 'its finalized root receipt still proves the treasury debit');
  observed.status = { Failure: { ActionError: {} } };
  observed.receipts_outcome[0].outcome.status = observed.status;
  observed.receipts = [{ receipt_id: root, receiver_id: 'judge.sponsor.near', predecessor_id: 'sponsor.near',
    receipt: { Action: { signer_id: 'sponsor.near', actions: [action] } } }];
  assert.equal(await chain.preparedRetrySafe({ ...call, transactionHash: call.hash }, new TransactionExpiredError()), true);
  assert.equal(await chain.preparedNeverExecuted(call), false, 'an executed root rollback still spent treasury gas');
});
