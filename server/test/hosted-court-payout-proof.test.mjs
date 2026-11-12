// INTEGRATION: Captured real hosted court payout RPC responses; no live connector or funds.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import fixture from './fixtures/hosted-court-payout-rpc.json' with { type: 'json' };
import evidence from '../../evidence/hosted-court-payout-testnet-20261112.json' with { type: 'json' };
import { verifyHostedPayout } from '../../scripts/verify-hosted-payout.mjs';

const endpoints = fixture.source.providers;
const verifierPath = fileURLToPath(new URL('../../scripts/verify-hosted-payout.mjs', import.meta.url));
const jsonResult = envelope => JSON.parse(Buffer.from(envelope.result.result).toString('utf8'));
const encoded = value => Buffer.from(JSON.stringify(value)).toString('base64');
const betId = new URL(evidence.betUrl).pathname.split('/').at(-1);
const approval = snapshots => snapshots[1].responses.approve.result;
const receiptCall = (snapshots, method) => approval(snapshots).receipts.find(receipt =>
  receipt.receipt?.Action?.actions?.[0]?.FunctionCall?.method_name === method);
const callAction = (snapshots, method) => receiptCall(snapshots, method).receipt.Action.actions[0].FunctionCall;

function makeRpc({ mutate = () => {}, proof = evidence } = {}) {
  const snapshots = structuredClone(fixture.providers);
  mutate(snapshots);
  const calls = [];
  const fetchImpl = async (endpoint, options) => {
    assert.ok(endpoints.includes(endpoint), `unexpected RPC endpoint: ${endpoint}`);
    assert.equal(options.method, 'POST');
    assert.equal(options.redirect, 'error');
    const body = JSON.parse(options.body);
    assert.equal(body.jsonrpc, '2.0');
    assert.ok(['query', 'tx_status'].includes(body.method), `unexpected method: ${body.method}`);
    const providerIndex = endpoints.indexOf(endpoint);
    const responses = snapshots[providerIndex].responses;
    calls.push({ endpoint, body });

    if (body.method === 'tx_status') {
      assert.equal(body.params.wait_until, 'FINAL');
      if (body.params.tx_hash === evidence.transactions.approve) {
        assert.equal(body.params.sender_account_id, proof.court.approveSigner);
        return Response.json(responses.approve);
      }
      assert.equal(body.params.tx_hash, evidence.transactions.withdraw);
      assert.equal(body.params.sender_account_id, proof.payout.recipient);
      return Response.json(responses.withdrawal);
    }

    assert.equal(body.params.finality, 'final');
    if (body.params.request_type === 'view_account') {
      assert.equal(body.params.account_id, evidence.contract);
      return Response.json(responses.account);
    }
    if (body.params.request_type === 'view_access_key_list') {
      const accountId = body.params.account_id;
      if (accountId === proof.contract) return Response.json(responses.access);
      assert.equal(accountId, proof.court.relay);
      return Response.json(responses.relayAccess);
    }

    assert.equal(body.params.request_type, 'call_function');
    const { account_id: accountId, method_name: methodName } = body.params;
    const args = JSON.parse(Buffer.from(body.params.args_base64, 'base64').toString('utf8'));
    if (accountId === proof.contract) {
      assert.equal(methodName, 'get_bet');
      assert.deepEqual(args, { id: evidence.betUrl.split('/').at(-1) });
      return Response.json(responses.bet);
    }
    if (accountId === proof.court.dao) {
      if (methodName === 'get_proposal') {
        assert.deepEqual(args, { id: evidence.court.proposalId });
        return Response.json(responses.proposal);
      }
      assert.equal(methodName, 'get_policy');
      assert.deepEqual(args, {});
      return Response.json(responses.policy);
    }
    assert.fail(`unexpected view call ${accountId}.${methodName}`);
  };
  return { fetchImpl, calls, snapshots };
}

function decode(snapshots, providerIndex, name) {
  return jsonResult(snapshots[providerIndex].responses[name]);
}

function setDecoded(snapshots, providerIndex, name, value) {
  const envelope = snapshots[providerIndex].responses[name];
  envelope.result.result = [...Buffer.from(JSON.stringify(value))];
}

function mutateDecoded(name, change, providerIndex = 1) {
  return snapshots => {
    const value = decode(snapshots, providerIndex, name);
    change(value);
    setDecoded(snapshots, providerIndex, name, value);
  };
}

test('untouched real hosted court responses pass through both providers', async () => {
  const rpc = makeRpc();
  const report = await verifyHostedPayout({ fetchImpl: rpc.fetchImpl, evidence });
  assert.equal(report.overall, 'PASS', JSON.stringify(report));
  assert.deepEqual(report.providers.map(provider => provider.status), ['PASS', 'PASS']);
  assert.deepEqual(rpc.calls.map(({ body }) => body.method).sort(), [
    'query', 'query', 'query', 'query', 'query', 'query', 'query', 'query', 'query', 'query', 'query', 'query',
    'tx_status', 'tx_status', 'tx_status', 'tx_status',
  ].sort());
  for (const endpoint of endpoints) {
    assert.equal(rpc.calls.filter(call => call.endpoint === endpoint && call.body.method === 'query').length, 6);
    assert.equal(rpc.calls.filter(call => call.endpoint === endpoint && call.body.method === 'tx_status').length, 2);
  }
  assert.doesNotMatch(JSON.stringify(report), /signer_public_key|secret|DATABASE_URL|\/Users\//);
});

test('approve signer comes from evidence and can be an unrelated valid account', async () => {
  const proof = structuredClone(evidence);
  proof.court.approveSigner = 'anyone.testnet';
  const rpc = makeRpc({ proof, mutate: snapshots => {
    for (const provider of snapshots) {
      const result = provider.responses.approve.result;
      result.transaction.signer_id = proof.court.approveSigner;
      result.transaction_outcome.outcome.executor_id = proof.court.approveSigner;
      const rootId = result.transaction_outcome.outcome.status.SuccessReceiptId;
      const root = result.receipts.find(receipt => receipt.receipt_id === rootId);
      root.predecessor_id = proof.court.approveSigner;
      for (const receipt of result.receipts) if (receipt.receipt?.Action?.signer_id === evidence.court.approveSigner) {
        receipt.receipt.Action.signer_id = proof.court.approveSigner;
      }
    }
  } });
  const report = await verifyHostedPayout({ fetchImpl: rpc.fetchImpl, evidence: proof });
  assert.equal(report.overall, 'PASS', JSON.stringify(report));
});

test('material court execution mutations fail proof', async t => {
  const cases = [
    ['failed approve transaction', snapshots => { approval(snapshots).status = { Failure: {} }; }],
    ['nonfinal approve transaction', snapshots => { approval(snapshots).final_execution_status = 'EXECUTED'; }],
    ['wrong outcome in resolve call', snapshots => { callAction(snapshots, 'referee_resolve').args = encoded({ id: betId, outcome: 'no' }); }],
    ['wrong predecessor on resolve call', snapshots => { receiptCall(snapshots, 'referee_resolve').predecessor_id = evidence.court.relay; }],
    ['proposal not approved', mutateDecoded('proposal', proposal => { proposal.status = 'Rejected'; })],
    ['proposal proposer differs from relay', mutateDecoded('proposal', proposal => { proposal.proposer = 'other.testnet'; })],
    ['relay has access key', snapshots => {
      snapshots[1].responses.relayAccess.result.keys = [{ public_key: 'ed25519:11111111111111111111111111111111',
        access_key: { nonce: 0, permission: 'FullAccess' } }];
    }],
    ['provider proposal disagreement', mutateDecoded('proposal', proposal => { proposal.description += ' changed'; })],
    ['wrong escrow account', snapshots => { snapshots[1].responses.withdrawal.result.transaction.receiver_id = 'other.testnet'; }],
    ['wrong proposal id', mutateDecoded('proposal', proposal => { proposal.id = 9; })],
    ['bet names a different court DAO', mutateDecoded('bet', bet => { bet.referee = 'other.sputnik-v2.testnet'; })],
    ['approve targets a different relay', snapshots => { approval(snapshots).transaction.receiver_id = 'other-relay.testnet'; }],
    ['wrong proposal id in approve args', snapshots => { approval(snapshots).transaction.actions[0].FunctionCall.args = encoded({ id: 9 }); }],
    ['wrong approve method', snapshots => { approval(snapshots).transaction.actions[0].FunctionCall.method_name = 'vote_reject'; }],
    ['wrong approve gas', snapshots => { approval(snapshots).transaction.actions[0].FunctionCall.gas = '1'; }],
    ['approve deposit attached', snapshots => { approval(snapshots).transaction.actions[0].FunctionCall.deposit = '1'; }],
    ['wrong resolve gas', mutateDecoded('proposal', proposal => { proposal.kind.FunctionCall.actions[0].gas = '1'; })],
    ['wrong resolve receiver', mutateDecoded('proposal', proposal => { proposal.kind.FunctionCall.receiver_id = 'other.testnet'; })],
    ['wrong withdraw identity', snapshots => { snapshots[1].responses.withdrawal.result.transaction.signer_id = 'other.testnet'; }],
    ['resolve receipt reparented away from act_proposal', snapshots => {
      const result = snapshots[1].responses.approve.result;
      const vote = result.receipts.find(item => item.receiver_id === evidence.court.dao && item.receipt.Action.actions[0]?.FunctionCall?.method_name === 'act_proposal');
      const resolution = result.receipts.find(item => item.receiver_id === evidence.contract && item.receipt.Action.actions[0]?.FunctionCall?.method_name === 'referee_resolve');
      const voteOutcome = result.receipts_outcome.find(item => item.id === vote.receipt_id).outcome;
      voteOutcome.receipt_ids = voteOutcome.receipt_ids.filter(id => id !== resolution.receipt_id);
      voteOutcome.status = { SuccessValue: '' };
      const rootId = result.transaction_outcome.outcome.receipt_ids[0];
      result.receipts_outcome.find(item => item.id === rootId).outcome.receipt_ids.push(resolution.receipt_id);
    }, 'court_resolution_unlinked'],
    ['vote uses another action', snapshots => {
      callAction(snapshots, 'act_proposal').args = encoded({ id: evidence.court.proposalId,
        action: 'VoteReject', proposal: decode(snapshots, 1, 'proposal').kind });
    }],
    ['vote receipt has wrong predecessor', snapshots => { receiptCall(snapshots, 'act_proposal').predecessor_id = evidence.court.dao; }],
    ['vote receipt has wrong gas', snapshots => { callAction(snapshots, 'act_proposal').gas = '1'; }],
    ['resolve receipt has wrong gas', snapshots => { callAction(snapshots, 'referee_resolve').gas = '1'; }],
    ['resolve receipt has attached deposit', snapshots => { callAction(snapshots, 'referee_resolve').deposit = '1'; }],
    ['failed resolve receipt', snapshots => {
      const id = receiptCall(snapshots, 'referee_resolve').receipt_id;
      approval(snapshots).receipts_outcome.find(item => item.id === id).outcome.status = { Failure: {} };
    }],
    ['proposal has extra action', mutateDecoded('proposal', proposal => { proposal.kind.FunctionCall.actions.push(structuredClone(proposal.kind.FunctionCall.actions[0])); })],
    ['extra jury group member', mutateDecoded('policy', policy => { policy.roles.find(role => role.name === 'jury').kind.Group.push('other.testnet'); })],
    ['wildcard jury group', mutateDecoded('policy', policy => { policy.roles.find(role => role.name === 'jury').kind.Group.push('*'); })],
    ['other role can approve calls', mutateDecoded('policy', policy => { policy.roles.find(role => role.name === 'council').permissions.push('call:VoteApprove'); })],
  ];
  for (const [name, mutate, reason] of cases) await t.test(name, async () => {
    const rpc = makeRpc({ mutate });
    const report = await verifyHostedPayout({ fetchImpl: rpc.fetchImpl, evidence });
    assert.equal(report.overall, 'FAIL', JSON.stringify(report));
    if (reason) assert.equal(report.providers[1].reason, reason, JSON.stringify(report));
    if (name === 'provider proposal disagreement') {
      assert.equal(report.reason, 'provider_disagreement');
      assert.deepEqual(report.providers.map(provider => [provider.status, provider.reason]), [
        ['FAIL', 'provider_disagreement'], ['FAIL', 'provider_disagreement'],
      ]);
    }
  });
});

test('providers may serialize equivalent court responses differently', async () => {
  const rpc = makeRpc({ mutate: snapshots => {
    const responses = snapshots[1].responses;
    const policy = decode(snapshots, 1, 'policy');
    for (const role of policy.roles) role.permissions.reverse();
    setDecoded(snapshots, 1, 'policy', policy);
    const approved = responses.approve.result;
    for (const action of approved.transaction.actions) if (action.FunctionCall) action.FunctionCall.gas = String(action.FunctionCall.gas);
    for (const receipt of approved.receipts) {
      for (const action of receipt.receipt?.Action?.actions ?? []) if (action.FunctionCall) action.FunctionCall.gas = String(action.FunctionCall.gas);
    }
    approved.receipts.reverse();
    approved.receipts_outcome.reverse();
  } });
  const report = await verifyHostedPayout({ fetchImpl: rpc.fetchImpl, evidence });
  assert.equal(report.overall, 'PASS', JSON.stringify(report));
});

test('CLI rejects invalid evidence paths and excess flags before RPC access', () => {
  const preload = 'data:text/javascript,globalThis.fetch=()=>{process.exit(91)}';
  const invalidPath = spawnSync(process.execPath, ['--import', preload, verifierPath, '/path/that/does/not/exist.json'], { encoding: 'utf8', timeout: 3000 });
  assert.notEqual(invalidPath.status, 0);
  assert.notEqual(invalidPath.status, 91);
  assert.equal(invalidPath.error, undefined);
  assert.equal(invalidPath.status, 1);
  assert.equal(JSON.parse(invalidPath.stdout).reason, 'invalid_evidence');
  const tooManyFlags = spawnSync(process.execPath, ['--import', preload, verifierPath, '/tmp/a.json', '/tmp/b.json'], { encoding: 'utf8', timeout: 3000 });
  assert.notEqual(tooManyFlags.status, 0);
  assert.notEqual(tooManyFlags.status, 91);
  assert.equal(tooManyFlags.error, undefined);
  assert.equal(tooManyFlags.status, 1);
  assert.equal(JSON.parse(tooManyFlags.stdout).reason, 'unsupported_arguments');
});

test('CLI accepts the optional evidence path with mocked real RPC responses', () => {
  const source = `
    import { readFileSync } from 'node:fs';
    const f = JSON.parse(readFileSync(new URL(${JSON.stringify(new URL('./fixtures/hosted-court-payout-rpc.json', import.meta.url).href)})));
    const e = ${JSON.stringify({ transactions: evidence.transactions, court: evidence.court, contract: evidence.contract })};
    globalThis.fetch = async (url, init) => {
      const p = JSON.parse(init.body);
      const r = f.providers.find(x => x.endpoint === url).responses;
      let key;
      if (p.method === 'tx_status') key = p.params.tx_hash === e.transactions.approve ? 'approve' : 'withdrawal';
      else if (p.params.request_type === 'view_account') key = 'account';
      else if (p.params.request_type === 'view_access_key_list') key = p.params.account_id === e.court.relay ? 'relayAccess' : 'access';
      else key = ({ get_bet: 'bet', get_proposal: 'proposal', get_policy: 'policy' })[p.params.method_name];
      return Response.json(r[key]);
    };`;
  const preload = `data:text/javascript,${encodeURIComponent(source)}`;
  const cli = spawnSync(process.execPath, ['--import', preload, verifierPath,
    fileURLToPath(new URL('../../evidence/hosted-court-payout-testnet-20261112.json', import.meta.url))],
  { encoding: 'utf8', timeout: 5000, maxBuffer: 2_000_000 });
  assert.equal(cli.status, 0, cli.stderr || cli.stdout);
  assert.equal(JSON.parse(cli.stdout).overall, 'PASS');
  assert.equal(cli.error, undefined);
});

test('CLI retains exit code two when the optional evidence RPCs are unavailable', () => {
  const preload = 'data:text/javascript,globalThis.fetch=async()=>new Response(null,{status:503})';
  const cli = spawnSync(process.execPath, ['--import', preload, verifierPath,
    fileURLToPath(new URL('../../evidence/hosted-court-payout-testnet-20261112.json', import.meta.url))],
  { encoding: 'utf8', timeout: 3000 });
  assert.equal(cli.error, undefined);
  assert.equal(cli.status, 2, cli.stderr || cli.stdout);
  assert.equal(JSON.parse(cli.stdout).overall, 'UNAVAILABLE');
});
