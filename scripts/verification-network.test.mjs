import test from 'node:test';
import assert from 'node:assert/strict';
import { verificationFetch } from './verification-network.mjs';
import { verifyHostedPayout } from './verify-hosted-payout.mjs';
import { verifyCourtProposal } from './verify-enclave-ruling.mjs';
import { proposalKind } from '../server/src/court-dao.mjs';
import { fingerprint } from '../server/src/canonical.mjs';
import ruling from '../evidence/enclave-ruling-3668aa04.json' with { type: 'json' };
import evidence from '../evidence/hosted-court-payout-testnet-20261112.json' with { type: 'json' };
import fixture from '../server/test/fixtures/hosted-court-payout-rpc.json' with { type: 'json' };

const endpoint = 'https://archival-rpc.testnet.fastnear.com';
const init = { method: 'POST', body: JSON.stringify({ jsonrpc: '2.0', method: 'query',
  params: { account_id: evidence.contract, method_name: 'get_bet' } }) };
const quiet = { diagnostic: () => {}, sleep: async () => {} };

test('transient HTTP, RPC and transport errors retry the same call with bounded backoff', async t => {
  for (const [name, failure] of [
    ['429', () => new Response(null, { status: 429 })],
    ['503', () => new Response('untrusted-body', { status: 503 })],
    ['RPC timeout', () => Response.json({ error: { message: 'Default RPC timeout' } })],
    ['timeout', () => { throw new DOMException('Default RPC timeout', 'TimeoutError'); }],
    ['reset', () => { throw Object.assign(new Error('reset'), { code: 'ECONNRESET' }); }],
  ]) await t.test(name, async () => {
    const calls = [], waits = [], logs = [];
    const request = verificationFetch(async (url, options) => {
      calls.push({ url, body: options.body });
      if (calls.length < 3) return failure();
      return Response.json({ result: 'ok' });
    }, { diagnostic: line => logs.push(line), sleep: async ms => waits.push(ms) });
    assert.deepEqual(await (await request(endpoint, init)).json(), { result: 'ok' });
    assert.deepEqual(waits, [250, 1000]);
    assert.equal(calls.length, 3);
    assert.ok(calls.every(call => call.url === endpoint && call.body === init.body));
    assert.match(logs.at(-1), /query .*\.get_bet.*attempt 3\/3.*\d+ms.*deadline 30000ms.*HTTP 200/);
    assert.doesNotMatch(logs.join('\n'), /untrusted-body|Default RPC timeout/);
  });
});

test('timeouts bound even an uncooperative fetch and a stalled body, then give up explicitly', async t => {
  for (const [name, fetchImpl] of [
    ['headers', async () => new Promise(() => {})],
    ['body', async () => new Response(new ReadableStream({ start() {} }))],
  ]) await t.test(name, async () => {
    const logs = [];
    const request = verificationFetch(fetchImpl, { ...quiet, timeoutMs: 5, diagnostic: line => logs.push(line) });
    await assert.rejects(request(endpoint, init), /get_bet.*attempt 3\/3.*deadline 5ms.*timeout/);
    assert.equal(logs.filter(line => line.includes('timeout')).length, 3);
    assert.match(logs.at(-1), /give up/);
  });
});

test('permanent errors and negative attestation verdicts are not retried', async () => {
  for (const response of [() => new Response('no', { status: 403 }),
    () => Response.json({ is_valid: false, details: {} }, { status: 500 })]) {
    let calls = 0;
    const request = verificationFetch(async () => { calls++; return response(); }, quiet);
    await request('https://verifier.test/verify');
    assert.equal(calls, 1);
  }
});

test('ruling Court reads recover on the same endpoint and report retry exhaustion', async () => {
  const betId = ruling.record.material.bets[0].id;
  const calls = new Map(), logs = [], checks = [];
  const request = async (url, options) => {
    const { params } = JSON.parse(options.body);
    const key = `${url}|${params.method_name}`;
    calls.set(key, (calls.get(key) || 0) + 1);
    if (calls.get(key) === 1) return new Response(null, { status: 429 });
    const value = params.method_name === 'get_last_proposal_id' ? 1 : [{ id: 0,
      kind: proposalKind({ nearContract: evidence.contract }, betId, ruling.record.outcome),
      description: `ruling sha256:${fingerprint(ruling.record)}` }];
    return Response.json({ result: { result: [...Buffer.from(JSON.stringify(value))] } });
  };
  await verifyCourtProposal(ruling.record, betId, (...args) => checks.push(args), {
    fetchImpl: request, networkOptions: { ...quiet, diagnostic: line => logs.push(line) },
  });
  assert.equal(checks[0][0], 'PASS');
  assert.equal(calls.size, 2);
  assert.ok([...calls].every(([key, count]) => key.startsWith(endpoint) && count === 2));
  assert.ok(logs.some(line => /get_proposals.*attempt 2\/3.*HTTP 200/.test(line)));
  let failures = 0;
  const failedChecks = [];
  await verifyCourtProposal(ruling.record, betId, (...args) => failedChecks.push(args), {
    fetchImpl: async () => { failures++; throw new DOMException('Default RPC timeout', 'TimeoutError'); },
    networkOptions: quiet,
  });
  assert.equal(failures, 6, 'three attempts per fixed archival endpoint');
  assert.equal(failedChecks[0][0], 'FAIL');
  assert.match(failedChecks[0][2], /get_last_proposal_id.*attempt 3\/3.*deadline 30000ms.*timeout/);
});

test('NVIDIA and dstack diagnostics state their own deadlines', async () => {
  const logs = [];
  const request = verificationFetch(async () => Response.json({ ok: true }), { ...quiet, diagnostic: line => logs.push(line) });
  await request('https://nras.attestation.nvidia.com/.well-known/jwks.json');
  await request('https://verifier.test/verify', { method: 'POST' });
  assert.match(logs[0], /deadline 20000ms/);
  assert.match(logs[1], /deadline 90000ms/);
});

function payoutFetch({ alwaysFail = false, disagree = false } = {}) {
  const calls = new Map();
  return { calls, fetchImpl: async (url, options) => {
    const body = JSON.parse(options.body);
    const key = `${url}|${options.body}`;
    calls.set(key, (calls.get(key) || 0) + 1);
    if (url === fixture.source.providers[1] && (alwaysFail || calls.get(key) === 1)) return new Response(null, { status: 503 });
    const responses = structuredClone(fixture.providers[fixture.source.providers.indexOf(url)].responses);
    if (disagree && url === fixture.source.providers[1]) {
      const bet = JSON.parse(Buffer.from(responses.bet.result.result));
      bet.terms_hash = 'd'.repeat(64);
      responses.bet.result.result = [...Buffer.from(JSON.stringify(bet))];
    }
    const params = body.params;
    const name = body.method === 'tx_status' ? params.tx_hash === evidence.transactions.approve ? 'approve' : 'withdrawal'
      : params.request_type === 'view_account' ? 'account'
      : params.request_type === 'view_access_key_list' ? params.account_id === evidence.contract ? 'access' : 'relayAccess'
      : ({ get_bet: 'bet', get_proposal: 'proposal', get_policy: 'policy' })[params.method_name];
    assert.ok(name, 'only known read-only calls');
    return Response.json(responses[name]);
  } };
}

test('payout retries stay attributable and both providers must still agree', async () => {
  const rpc = payoutFetch();
  const report = await verifyHostedPayout({ evidence, fetchImpl: rpc.fetchImpl, networkOptions: quiet });
  assert.equal(report.overall, 'PASS');
  assert.deepEqual(report.providers.map(p => p.endpoint), fixture.source.providers);
  assert.ok([...rpc.calls].some(([key, count]) => key.startsWith(fixture.source.providers[1]) && count === 2));
  const conflict = await verifyHostedPayout({ evidence, fetchImpl: payoutFetch({ disagree: true }).fetchImpl, networkOptions: quiet });
  assert.equal(conflict.overall, 'FAIL');
  assert.equal(conflict.reason, 'provider_disagreement');
  const failed = payoutFetch({ alwaysFail: true });
  const unavailable = await verifyHostedPayout({ evidence, fetchImpl: failed.fetchImpl, networkOptions: quiet });
  assert.equal(unavailable.overall, 'UNAVAILABLE');
  assert.deepEqual(unavailable.providers.map(p => p.status), ['PASS', 'UNAVAILABLE']);
  assert.equal([...failed.calls].find(([key]) => key.startsWith(fixture.source.providers[1]))[1], 3);
});
