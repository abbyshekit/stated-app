// Read-only proof verifier: synthetic RPC replies, no live connector or funds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { baseEncode } from 'near-api-js';
import proof from '../../evidence/hosted-real-x-testnet-20261111.json' with { type: 'json' };
import { useNetwork } from '../src/near-network.mjs';
import { verifyHostedPayout } from '../../scripts/verify-hosted-payout.mjs';

const endpoints = ['https://test.rpc.fastnear.com', 'https://rpc.testnet.near.org'];
const betId = new URL(proof.betUrl).pathname.split('/').pop();
const hash = n => baseEncode(Buffer.alloc(32, n));
const creator = 'chainabstracted.stated-play-6cf0876dd7.testnet';
const referee = 'referee.stated-play-6cf0876dd7.testnet';
const winner = proof.payout.recipient;
const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64');
const call = (method, args, gas = 100000000000000) => ({ FunctionCall: { method_name: method, args: encoded(args), gas, deposit: '0' } });
const outcome = (id, executor, children, status) => ({ id, outcome: { executor_id: executor, receipt_ids: children, status, logs: [] } });
const receipt = (id, predecessor, receiver, actions, { inputs = [], outputs = [], signer = winner } = {}) => ({
  receipt_id: id, predecessor_id: predecessor, receiver_id: receiver,
  receipt: { Action: { signer_id: signer, actions, input_data_ids: inputs, output_data_receivers: outputs } },
});

function fixture() {
  const root = hash(1), rulingRoot = hash(2), data = hash(3);
  const bet = { id: betId, terms_hash: 'a'.repeat(64), creator_binding_hash: 'b'.repeat(64), acceptor_binding_hash: 'c'.repeat(64),
    creator, acceptor: winner, creator_side: 'yes', stake_yocto: proof.stakeYoctoEach, referee,
    invited_account: null, accept_by_ns: '1794424140000000000', resolve_at_ns: '1794424200000000000',
    status: 'settled', proposal: null, resolution: { method: 'referee', outcome: proof.outcome, resolved_at_ns: '1794424920659029013' } };
  const refereeCall = call('referee_resolve', { id: betId, outcome: proof.outcome });
  const withdrawalCall = call('withdraw', { stated_request_id: '569859f6-1ed5-4987-b17f-47d075304a59' });
  const transaction = (txHash, signer, action) => ({ hash: txHash, signer_id: signer, receiver_id: proof.contract, actions: [action] });
  const transactionOutcome = (txHash, signer, child) => ({ id: txHash,
    outcome: { executor_id: signer, receipt_ids: [child], status: { SuccessReceiptId: child }, logs: [] } });
  const ruling = { final_execution_status: 'FINAL', status: { SuccessValue: '' },
    transaction: transaction(proof.transactions.refereeResolve, referee, refereeCall),
    transaction_outcome: transactionOutcome(proof.transactions.refereeResolve, referee, rulingRoot),
    receipts: [receipt(rulingRoot, referee, proof.contract, [refereeCall], { signer: referee })],
    receipts_outcome: [outcome(rulingRoot, proof.contract, [], { SuccessValue: '' })] };
  const withdrawal = { final_execution_status: 'FINAL', status: { SuccessValue: 'dHJ1ZQ==' },
    transaction: transaction(proof.transactions.withdraw, winner, withdrawalCall),
    transaction_outcome: transactionOutcome(proof.transactions.withdraw, winner, root),
    receipts: [
      receipt(root, winner, proof.contract, [withdrawalCall]),
      receipt(proof.payout.transferReceipt, proof.contract, winner, [{ Transfer: { deposit: proof.payout.amountYocto } }],
        { outputs: [{ data_id: data, receiver_id: proof.contract }] }),
      receipt(proof.payout.callbackReceipt, proof.contract, proof.contract,
        [call('on_withdraw', { account_id: winner, amount: proof.payout.amountYocto }, 10000000000000)], { inputs: [data] }),
    ],
    receipts_outcome: [
      outcome(root, proof.contract, [proof.payout.transferReceipt, proof.payout.callbackReceipt], { SuccessReceiptId: proof.payout.callbackReceipt }),
      outcome(proof.payout.transferReceipt, winner, [], { SuccessValue: '' }),
      outcome(proof.payout.callbackReceipt, proof.contract, [], { SuccessValue: 'dHJ1ZQ==' }),
    ] };
  return { bet, ruling, withdrawal };
}

function fakeRpc({ change = () => {}, fault = null } = {}) {
  const calls = [];
  const fetchImpl = async (endpoint, options) => {
    assert.ok(endpoints.includes(endpoint), 'proof may contact only the two fixed testnet RPCs');
    assert.equal(options.method, 'POST'); assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    calls.push({ endpoint, method: body.method });
    assert.ok(['query', 'tx_status'].includes(body.method), 'a proof must never broadcast');
    if (fault && endpoint === endpoints[1]) return fault(options);
    const data = fixture(); change(data, endpoint);
    if (body.method === 'query') {
      assert.equal(body.params.request_type, 'call_function'); assert.equal(body.params.finality, 'final');
      assert.equal(body.params.account_id, proof.contract); assert.equal(body.params.method_name, 'get_bet');
      assert.deepEqual(JSON.parse(Buffer.from(body.params.args_base64, 'base64')), { id: betId });
      return Response.json({ result: { result: [...Buffer.from(JSON.stringify(data.bet))], block_height: endpoint === endpoints[0] ? 1000 : 1001, block_hash: hash(8) } });
    }
    assert.equal(body.params.wait_until, 'FINAL');
    if (body.params.tx_hash === proof.transactions.refereeResolve) {
      assert.equal(body.params.sender_account_id, data.bet.referee);
      return Response.json({ result: data.ruling });
    }
    assert.equal(body.params.tx_hash, proof.transactions.withdraw);
    assert.equal(body.params.sender_account_id, winner);
    return Response.json({ result: data.withdrawal });
  };
  return { fetchImpl, calls };
}

test('the hosted payout needs two attributable final RPC checks and no mutable credit query', async () => {
  const rpc = fakeRpc();
  const report = await verifyHostedPayout({ fetchImpl: rpc.fetchImpl });
  assert.equal(report.overall, 'PASS', JSON.stringify(report));
  assert.equal(report.providers.length, 2);
  assert.deepEqual(report.providers.map(p => p.status), ['PASS', 'PASS']);
  for (const endpoint of endpoints) {
    assert.equal(rpc.calls.filter(c => c.endpoint === endpoint && c.method === 'query').length, 1);
    assert.equal(rpc.calls.filter(c => c.endpoint === endpoint && c.method === 'tx_status').length, 2);
  }
  assert.doesNotMatch(JSON.stringify(report), /569859f6|signer_public_key|FunctionCall|input_data_ids|secret|DATABASE_URL|\/Users\//);
});

test('plausible but mismatched settlement or payout data cannot pass either endpoint', async t => {
  const cases = [
    ['wrong bet', d => { d.bet.id = '00000000-0000-4000-8000-000000000001'; }],
    ['wrong outcome', d => { d.bet.resolution.outcome = 'yes'; }],
    ['wrong stake', d => { d.bet.stake_yocto = '100000000000000000000001'; }],
    ['wrong winner', d => { d.bet.creator_side = 'no'; }],
    ['unsettled bet', d => { d.bet.status = 'accepted'; }],
    ['wrong referee signer', d => { d.ruling.transaction.signer_id = creator; }],
    ['wrong referee action args', d => { d.ruling.transaction.actions[0].FunctionCall.args = encoded({ id: betId, outcome: 'yes' }); }],
    ['referee extra action', d => { d.ruling.transaction.actions.push({ Transfer: { deposit: '1' } }); }],
    ['nonfinal ruling', d => { d.ruling.final_execution_status = 'EXECUTED'; }],
    ['failed ruling receipt', d => { d.ruling.receipts_outcome[0].outcome.status = { Failure: { error_message: 'synthetic failure' } }; }],
    ['wrong withdrawal signer', d => { d.withdrawal.transaction.signer_id = creator; }],
    ['wrong escrow receiver', d => { d.withdrawal.transaction.receiver_id = 'other.testnet'; }],
    ['withdrawal extra action', d => { d.withdrawal.transaction.actions.push({ Transfer: { deposit: '1' } }); }],
    ['withdrawal attached deposit', d => { d.withdrawal.transaction.actions[0].FunctionCall.deposit = '1'; }],
    ['withdrawal wrong method', d => { d.withdrawal.transaction.actions[0].FunctionCall.method_name = 'refund_unresolved'; }],
    ['nonfinal withdrawal', d => { d.withdrawal.final_execution_status = 'EXECUTED'; }],
    ['false withdrawal result', d => { d.withdrawal.status.SuccessValue = 'ZmFsc2U='; }],
    ['wrong transfer recipient', d => { d.withdrawal.receipts[1].receiver_id = creator; }],
    ['wrong transfer predecessor', d => { d.withdrawal.receipts[1].predecessor_id = creator; }],
    ['wrong transfer amount', d => { d.withdrawal.receipts[1].receipt.Action.actions[0].Transfer.deposit = '200000000000000000000001'; }],
    ['different transfer receipt with the right amount', d => {
      const replacement = hash(9);
      d.withdrawal.receipts[1].receipt_id = replacement;
      d.withdrawal.receipts_outcome[1].id = replacement;
      d.withdrawal.receipts_outcome[0].outcome.receipt_ids[0] = replacement;
    }],
    ['failed transfer receipt', d => { d.withdrawal.receipts_outcome[1].outcome.status = { Failure: {} }; }],
    ['failed callback receipt', d => { d.withdrawal.receipts_outcome[2].outcome.status = { Failure: {} }; }],
    ['missing callback', d => { d.withdrawal.receipts.splice(2, 1); d.withdrawal.receipts_outcome.splice(2, 1); }],
    ['callback restored credit', d => { d.withdrawal.receipts_outcome[2].outcome.status = { SuccessValue: 'ZmFsc2U=' }; }],
    ['callback for another account', d => { d.withdrawal.receipts[2].receipt.Action.actions[0] = call('on_withdraw', { account_id: creator, amount: proof.payout.amountYocto }, 10000000000000); }],
    ['unrelated callback data', d => { d.withdrawal.receipts[2].receipt.Action.input_data_ids = [hash(9)]; }],
    ['detached receipt graph', d => { d.withdrawal.receipts_outcome[0].outcome.receipt_ids = [proof.payout.transferReceipt]; }],
    ['duplicate receipt identity', d => { d.withdrawal.receipts.push(structuredClone(d.withdrawal.receipts[1])); }],
    ['duplicate outcome identity', d => { d.withdrawal.receipts_outcome.push(structuredClone(d.withdrawal.receipts_outcome[1])); }],
  ];
  for (const [name, change] of cases) await t.test(name, async () => {
    const rpc = fakeRpc({ change });
    const report = await verifyHostedPayout({ fetchImpl: rpc.fetchImpl });
    assert.equal(report.overall, 'FAIL', JSON.stringify(report));
    assert.ok(report.providers.every(provider => provider.status === 'FAIL'), 'both responses carry the mismatched evidence');
  });
});

test('a single provider mismatch is a failure rather than a fallback pass', async () => {
  const rpc = fakeRpc({ change: (data, endpoint) => { if (endpoint === endpoints[1]) data.withdrawal.status.SuccessValue = 'ZmFsc2U='; } });
  const report = await verifyHostedPayout({ fetchImpl: rpc.fetchImpl });
  assert.equal(report.overall, 'FAIL');
  assert.deepEqual(report.providers.map(p => p.status), ['PASS', 'FAIL']);
});

test('valid 32-byte receipt hashes retain leading zero bytes', async () => {
  const root = hash(0);
  assert.equal(root.length, 32);
  const rpc = fakeRpc({ change: data => {
    data.withdrawal.transaction_outcome.outcome.receipt_ids = [root];
    data.withdrawal.transaction_outcome.outcome.status.SuccessReceiptId = root;
    data.withdrawal.receipts[0].receipt_id = root;
    data.withdrawal.receipts_outcome[0].id = root;
  } });
  const report = await verifyHostedPayout({ fetchImpl: rpc.fetchImpl });
  assert.equal(report.overall, 'PASS', JSON.stringify(report));
});

test('providers must agree on the same immutable terms even when both payouts look valid', async () => {
  const rpc = fakeRpc({ change: (data, endpoint) => { if (endpoint === endpoints[1]) data.bet.terms_hash = 'd'.repeat(64); } });
  const report = await verifyHostedPayout({ fetchImpl: rpc.fetchImpl });
  assert.equal(report.overall, 'FAIL');
  assert.equal(report.reason, 'provider_disagreement');
});

test('the same payout cannot conceal conflicting immutable executions', async t => {
  const cases = [
    ['withdrawal root', data => {
      const root = hash(9);
      data.withdrawal.transaction_outcome.outcome.receipt_ids = [root];
      data.withdrawal.transaction_outcome.outcome.status.SuccessReceiptId = root;
      data.withdrawal.receipts[0].receipt_id = root;
      data.withdrawal.receipts_outcome[0].id = root;
    }],
    ['referee root', data => {
      const root = hash(9);
      data.ruling.transaction_outcome.outcome.receipt_ids = [root];
      data.ruling.transaction_outcome.outcome.status.SuccessReceiptId = root;
      data.ruling.receipts[0].receipt_id = root;
      data.ruling.receipts_outcome[0].id = root;
    }],
    ['withdrawal arguments', data => {
      data.withdrawal.transaction.actions[0] = call('withdraw', {});
      data.withdrawal.receipts[0].receipt.Action.actions[0] = call('withdraw', {});
    }],
    ['different encoded referee arguments', data => {
      data.ruling.transaction.actions[0].FunctionCall.args = encoded({ outcome: proof.outcome, id: betId });
    }],
    ['transfer-to-callback data dependency', data => {
      data.withdrawal.receipts[1].receipt.Action.output_data_receivers[0].data_id = hash(9);
      data.withdrawal.receipts[2].receipt.Action.input_data_ids = [hash(9)];
    }],
  ];
  for (const [name, change] of cases) await t.test(name, async () => {
    const rpc = fakeRpc({ change: (data, endpoint) => { if (endpoint === endpoints[1]) change(data); } });
    const report = await verifyHostedPayout({ fetchImpl: rpc.fetchImpl });
    assert.equal(report.overall, 'FAIL', 'contradictory immutable execution cannot be corroborated');
    assert.equal(report.reason, 'provider_disagreement');
  });
});

test('RPC serialization differences do not change equivalent validated execution facts', async () => {
  const rpc = fakeRpc({ change: (data, endpoint) => {
    if (endpoint !== endpoints[1]) return;
    for (const result of [data.ruling, data.withdrawal]) {
      for (const action of result.transaction.actions) if (action.FunctionCall) action.FunctionCall.gas = String(action.FunctionCall.gas);
      for (const receipt of result.receipts) for (const action of receipt.receipt.Action.actions) {
        if (action.FunctionCall) action.FunctionCall.gas = String(action.FunctionCall.gas);
      }
      result.receipts.reverse(); result.receipts_outcome.reverse();
    }
  } });
  const report = await verifyHostedPayout({ fetchImpl: rpc.fetchImpl });
  assert.equal(report.overall, 'PASS', JSON.stringify(report));
});

test('orphaned and cyclic receipt graphs are rejected', async t => {
  for (const [name, change, reason] of [
    ['orphan', data => {
      data.withdrawal.receipts.push(receipt(hash(7), proof.contract, winner, []));
      data.withdrawal.receipts_outcome.push(outcome(hash(7), winner, [], { SuccessValue: '' }));
    }, 'unlinked_receipt'],
    ['cycle', data => {
      data.withdrawal.receipts_outcome[1].outcome.receipt_ids = [data.withdrawal.receipts[0].receipt_id];
    }, 'invalid_receipt_graph'],
  ]) await t.test(name, async () => {
    const rpc = fakeRpc({ change });
    const report = await verifyHostedPayout({ fetchImpl: rpc.fetchImpl });
    assert.equal(report.overall, 'FAIL');
    assert.ok(report.providers.every(provider => provider.reason === reason), JSON.stringify(report));
  });
});

test('noncanonical public call arguments fail at their decoding boundary', async t => {
  const duplicate = `{"id":"00000000-0000-4000-8000-000000000001","id":"${betId}","outcome":"${proof.outcome}"}`;
  for (const [name, args] of [
    ['invalid base64', '!'], ['invalid UTF-8', Buffer.from([255]).toString('base64')],
    ['duplicate JSON keys', Buffer.from(duplicate).toString('base64')],
    ['oversized arguments', Buffer.from(' '.repeat(24577)).toString('base64')],
  ]) await t.test(name, async () => {
    const rpc = fakeRpc({ change: data => { data.ruling.transaction.actions[0].FunctionCall.args = args; } });
    const report = await verifyHostedPayout({ fetchImpl: rpc.fetchImpl });
    assert.equal(report.overall, 'FAIL');
    assert.ok(report.providers.every(provider => provider.reason === 'invalid_call_arguments'), JSON.stringify(report));
  });
});

test('an unavailable provider is explicit and neither leaks its message nor becomes a pass', async () => {
  for (const fault of [() => Response.json({ error: { message: 'untrusted-upstream-marker' } }),
    () => new Response('untrusted-upstream-marker', { status: 503 })]) {
    const rpc = fakeRpc({ fault });
    const report = await verifyHostedPayout({ fetchImpl: rpc.fetchImpl });
    assert.equal(report.overall, 'UNAVAILABLE');
    assert.deepEqual(report.providers.map(p => p.status), ['PASS', 'UNAVAILABLE']);
    assert.doesNotMatch(JSON.stringify(report), /untrusted-upstream-marker/);
  }
});

test('a stalled endpoint is bounded instead of silently omitted', { timeout: 2000 }, async () => {
  const rpc = fakeRpc({ fault: options => new Promise((resolve, reject) => {
    if (options.signal.aborted) return reject(new Error('synthetic aborted'));
    options.signal.addEventListener('abort', () => reject(new Error('synthetic aborted')), { once: true });
  }) });
  const report = await verifyHostedPayout({ fetchImpl: rpc.fetchImpl, timeoutMs: 30 });
  assert.equal(report.overall, 'UNAVAILABLE');
  assert.equal(report.providers[1].status, 'UNAVAILABLE');
});

test('a response-body transport interruption remains unavailable', async () => {
  const rpc = fakeRpc({ fault: () => new Response(new ReadableStream({
    start(controller) { controller.error(new TypeError('terminated')); },
  })) });
  const report = await verifyHostedPayout({ fetchImpl: rpc.fetchImpl });
  assert.equal(report.overall, 'UNAVAILABLE');
  assert.deepEqual(report.providers.map(provider => provider.status), ['PASS', 'UNAVAILABLE']);
});

test('mainnet state and invalid local evidence fail before any network read', async () => {
  let calls = 0;
  const fetchImpl = async () => { calls++; throw new Error('Unexpected network read'); };
  try {
    useNetwork('mainnet');
    const mainnet = await verifyHostedPayout({ fetchImpl });
    assert.equal(mainnet.overall, 'FAIL'); assert.equal(calls, 0);
  } finally { useNetwork('testnet'); }
  const wrongEvidence = structuredClone(proof); wrongEvidence.contract = 'escrow.near';
  const invalid = await verifyHostedPayout({ fetchImpl, evidence: wrongEvidence });
  assert.equal(invalid.overall, 'FAIL'); assert.equal(calls, 0);
  for (const invalidHash of ['z'.repeat(44), '1'.repeat(43)]) {
    const malformed = structuredClone(proof); malformed.transactions.withdraw = invalidHash;
    const rejected = await verifyHostedPayout({ fetchImpl, evidence: malformed });
    assert.equal(rejected.overall, 'FAIL', 'transaction hashes must decode to exactly 32 bytes');
    assert.equal(calls, 0, 'invalid hashes must fail before an RPC request');
  }
});

test('import has no effects and unsupported CLI arguments fail before network access', () => {
  const script = new URL('../../scripts/verify-hosted-payout.mjs', import.meta.url);
  const imported = spawnSync(process.execPath, ['--input-type=module', '-e',
    `globalThis.fetch=()=>{process.exit(91)}; await import(${JSON.stringify(script.href)});`], { encoding: 'utf8', timeout: 3000 });
  assert.equal(imported.status, 0, imported.stderr); assert.equal(imported.stdout, '');
  const preload = 'data:text/javascript,globalThis.fetch=()=>{process.exit(91)}';
  const invalid = spawnSync(process.execPath, ['--import', preload, script.pathname, '--broadcast'], { encoding: 'utf8', timeout: 3000 });
  assert.notEqual(invalid.status, 0); assert.notEqual(invalid.status, 91); assert.equal(invalid.error, undefined);
});
