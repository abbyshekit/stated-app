// INTEGRATION: standalone verifier output with injected dstack and NVIDIA transports; no database.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { DEFAULT_DSTACK_VERIFIER, parseVerifierArguments, verifyRulingAttestations, verifyCourtProposal } from '../../scripts/verify-enclave-ruling.mjs';
import { fingerprint } from '../src/canonical.mjs';
import { proposalKind } from '../src/court-dao.mjs';
import { enclaveRulingFixture, keyFor, testReport } from './support/enclave.mjs';

const verifier = 'https://verifier.example';
const wire = (details = {}, outer = {}) => ({ is_valid: true, details: {
  quote_verified: true, event_log_verified: true, os_image_hash_verified: true,
  acpi_tables_verified: true, os_image_is_dev: false, os_image_version: '0.5.12',
  tee_variant: 'dstack-tdx', tcb_status: 'UpToDate', advisory_ids: [],
  app_info: { os_image_hash: '91'.repeat(32), compose_hash: '87'.repeat(32) }, ...details,
}, reason: null, ...outer });
function fixture() {
  const record = enclaveRulingFixture();
  for (const call of [record.plan, ...record.verdicts]) {
    call.attestation.model_attestations.unshift(testReport(call.nonce, keyFor('other-candidate').address));
    for (const [index, report] of [call.attestation.gateway_attestation, ...call.attestation.model_attestations].entries()) {
      report.info = { vm_config: `{"index":${index}}` };
    }
  }
  return record;
}
async function run(record = fixture(), fetchImpl = async () => Response.json(wire())) {
  const checks = [];
  await verifyRulingAttestations(record, (status, check, detail) => checks.push({ status, check, detail }),
    { fetchImpl, dstackVerifierUrl: verifier });
  return checks;
}

test('CLI flag overrides environment and environment overrides the default, preserving positionals', () => {
  assert.deepEqual(parseVerifierArguments([], {}), { base: undefined, betId: undefined, dstackVerifierUrl: DEFAULT_DSTACK_VERIFIER });
  assert.equal(parseVerifierArguments([], { DSTACK_VERIFIER_URL: verifier }).dstackVerifierUrl, verifier);
  const args = parseVerifierArguments(['https://stated.example', '--dstack-verifier', 'http://localhost:8080', 'bet-id'],
    { DSTACK_VERIFIER_URL: verifier });
  assert.deepEqual(args, { base: 'https://stated.example', betId: 'bet-id', dstackVerifierUrl: 'http://localhost:8080' });
  for (const args of [['--dstack-verifier'], ['--dstack-verifier', 'http://remote.example'], ['--unknown'],
    ['a', 'b', 'c'], ['--dstack-verifier', verifier, '--dstack-verifier', verifier]]) {
    assert.throws(() => parseVerifierArguments(args, {}));
  }
});

test('live measurements cover gateway and signing model of the plan and every verdict', async () => {
  const bodies = [];
  const checks = await run(fixture(), async (url, options) => {
    assert.equal(url, `${verifier}/verify`);
    assert.equal(options.redirect, 'manual');
    bodies.push(JSON.parse(options.body));
    return Response.json(wire());
  });
  assert.equal(bodies.length, 6);
  assert.deepEqual(bodies.map(body => body.vm_config), Array.from({ length: 3 }, () => ['{"index":0}', '{"index":2}']).flat());
  const measurements = checks.filter(row => row.check === 'Quote measurements');
  assert.equal(measurements.length, 6);
  assert.ok(measurements.every(row => row.status === 'PASS' && row.detail.includes('MRTD and RTMR0-2 match the published dstack 0.5.12 image named by os_image_hash 919191919191; production build')));
  assert.deepEqual(checks.find(row => row.check === 'Intel collateral'), {
    status: 'PASS', check: 'Intel collateral', detail: 'TCB UpToDate, no advisories, for every report',
  });
  assert.equal(checks.some(row => row.check === 'Attestation limits'), false);
});

test('prints stored results separately, then checks the same reports live', async () => {
  const record = fixture();
  record.plan.dstack = { gateway: { verifier, checkedAt: '2026-11-12T00:00:00.000Z', error: 'previous timeout' },
    model: { isValid: true, quoteVerified: true, eventLogVerified: true, osImageHashVerified: true,
      acpiTablesVerified: true, osImageIsDev: false, tcbStatus: 'UpToDate' } };
  const checks = await run(record);
  const stored = checks.filter(row => row.check === 'Stored dstack verification');
  assert.equal(stored.length, 2);
  assert.equal(stored[0].status, 'NOT CHECKED');
  assert.ok(stored[0].detail.includes('previous timeout'));
  assert.equal(stored[1].status, 'PASS');
  assert.ok(checks.indexOf(stored[0]) < checks.findIndex(row => row.detail.startsWith('Checked now:')));
  assert.equal(checks.filter(row => row.check === 'Quote measurements' && row.status === 'PASS').length, 6);
});

test('invalid quote, dev build, bad TCB, and advisories identify the offending report', async () => {
  for (const reply of [wire({}, { is_valid: false, reason: 'Quote rejected' }), wire({ os_image_is_dev: true }),
    wire({ tcb_status: 'OutOfDate' }), wire({ advisory_ids: ['INTEL-SA-1'] })]) {
    let calls = 0;
    const checks = await run(fixture(), async () => Response.json(++calls === 1 ? reply : wire()));
    assert.equal(calls, 6, 'every report is checked after a rejected one');
    const failure = checks.find(row => row.check === 'Intel collateral');
    assert.equal(failure.status, 'FAIL');
    assert.match(failure.detail, /plan .* gateway/);
  }
});

test('unreachable verifier retains reported measurements and the old attestation limits status', async () => {
  const checks = await run(fixture(), async () => { throw new Error('offline'); });
  const measurements = checks.filter(row => row.check === 'Quote measurements');
  assert.equal(measurements.length, 6);
  assert.ok(measurements.every(row => row.status === 'NOT CHECKED' && row.detail.startsWith('Reported, not compared:')
    && row.detail.includes('mrtd ') && row.detail.includes('request failed')));
  assert.equal(checks.find(row => row.check === 'Attestation limits').status, 'NOT CHECKED');
  assert.equal(checks.some(row => row.check === 'Intel collateral' && row.status === 'PASS'), false);
});

test('malformed verifier replies fail rather than claiming unavailable verification', async () => {
  const checks = await run(fixture(), async () => Response.json({}));
  assert.equal(checks.filter(row => row.check === 'Quote measurements' && row.status === 'FAIL').length, 6);
  assert.equal(checks.find(row => row.check === 'Intel collateral').status, 'FAIL');
});

test('raw stored GPU evidence is verified now with the record nonce, and NRAS rejection fails', async () => {
  const record = fixture();
  const NRAS = 'https://nras.attestation.nvidia.com';
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'script-test', alg: 'ES384' }] };
  for (const call of [record.plan, ...record.verdicts]) {
    call.attestation.model_attestations[1].nvidia_payload = JSON.stringify({ nonce: call.nonce, evidence_list: [] });
  }
  let rejected = false;
  const nonces = [];
  const fetchImpl = async (url, options) => {
    if (String(url).startsWith(verifier)) return Response.json(wire());
    if (String(url).endsWith('jwks.json')) return Response.json(jwks);
    assert.equal(String(url), `${NRAS}/v3/attest/gpu`);
    const { nonce } = JSON.parse(options.body);
    nonces.push(nonce);
    const input = [{ alg: 'ES384', kid: 'script-test' },
      { iss: NRAS, eat_nonce: nonce, 'x-nvidia-overall-att-result': !rejected }]
      .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
    return Response.json([['JWT', `${input}.${sign('sha384', Buffer.from(input),
      { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`]]);
  };
  const checks = await run(record, fetchImpl);
  const gpu = checks.filter(row => row.check === 'GPU attestation');
  assert.equal(gpu.length, 3);
  assert.ok(gpu.every(row => row.status === 'PASS' && row.detail.includes('NVIDIA NRAS verifies the stored evidence (checked now)')));
  assert.deepEqual(nonces, [record.plan, ...record.verdicts].map(call => call.nonce));
  rejected = true;
  assert.ok((await run(record, fetchImpl)).filter(row => row.check === 'GPU attestation').every(row => row.status === 'FAIL'));
});

async function courtChecks({ mutate = () => {}, proposals, fallback = false, outcome = 'yes' } = {}) {
  const record = fixture(); record.outcome = outcome;
  const betId = record.material.bets[0].id;
  const proposal = { id: 0, kind: proposalKind({ nearContract: 'stated-escrow-52081551be.testnet' }, betId,
    outcome === 'unclear' ? 'void' : outcome), description: `Stated enclave jury ruling sha256:${fingerprint(record)}` };
  mutate(proposal);
  const rows = proposals || [proposal];
  const calls = []; const checks = [];
  await verifyCourtProposal(record, betId, (status, check, detail) => checks.push({ status, check, detail }), {
    fetchImpl: async (url, options) => {
      calls.push(String(url));
      assert.equal(options.method, 'POST');
      assert.equal(options.redirect, 'error');
      const request = JSON.parse(options.body);
      assert.equal(request.method, 'query');
      assert.equal(request.params.finality, 'final');
      assert.equal(request.params.account_id, 'stated-court.sputnik-v2.testnet');
      if (fallback && String(url).includes('fastnear.com')) throw new Error('primary unavailable');
      const args = JSON.parse(Buffer.from(request.params.args_base64, 'base64').toString());
      const value = request.params.method_name === 'get_last_proposal_id' ? rows.length : rows.slice(args.from_index, args.from_index + args.limit);
      return Response.json({ result: { result: [...Buffer.from(JSON.stringify(value))] } });
    },
  });
  return { checks, calls };
}

test('court anchor checks exact canonical fetched record through archival RPC with fallback', async () => {
  const { checks, calls } = await courtChecks({ fallback: true });
  assert.equal(checks.length, 1);
  assert.equal(checks[0].status, 'PASS');
  assert.match(checks[0].detail, /ruling sha256:[a-f0-9]{64}/);
  assert.deepEqual([...new Set(calls)], ['https://archival-rpc.testnet.fastnear.com', 'https://archival-rpc.testnet.near.org']);
  assert.equal((await courtChecks({ outcome: 'unclear' })).checks[0].status, 'PASS');
});

test('court anchor rejects each mutated action field and missing, duplicate or different record hash', async () => {
  const mutations = [
    p => { p.kind.FunctionCall.receiver_id = 'other.testnet'; },
    p => { p.kind.FunctionCall.actions[0].method_name = 'other'; },
    p => { p.kind.FunctionCall.actions[0].deposit = '1'; },
    p => { p.kind.FunctionCall.actions[0].gas = '1'; },
    p => { const action = p.kind.FunctionCall.actions[0]; const args = JSON.parse(Buffer.from(action.args, 'base64')); args.outcome = 'no'; action.args = Buffer.from(JSON.stringify(args)).toString('base64'); },
    p => { p.kind.FunctionCall.actions.push(p.kind.FunctionCall.actions[0]); },
    p => { p.kind.extra = {}; },
    p => { p.description = 'missing hash'; },
    p => { p.description = `ruling sha256:${'0'.repeat(64)}`; },
    p => { p.description += ` ${p.description}`; },
  ];
  for (const mutate of mutations) assert.equal((await courtChecks({ mutate })).checks[0].status, 'FAIL', mutate.toString());
});

test('a Bet whose referee is not the Court has no proposal to check, and a Court Bet without one is not checked', async () => {
  const betId = fixture().material.bets[0].id;
  const answer = (value) => Response.json({ jsonrpc: '2.0', id: 'court-ruling',
    result: { result: [...Buffer.from(JSON.stringify(value))], logs: [], block_height: 1, block_hash: 'h' } });
  const chainWith = (referee) => async (url, options) => {
    const { params } = JSON.parse(options.body);
    if (params.method_name === 'get_last_proposal_id') return answer(0);
    if (params.method_name === 'get_bet') return answer({ id: betId, referee });
    throw new Error(`unexpected ${params.method_name}`);
  };
  for (const [referee, status] of [['referee.stated-play-6cf0876dd7.testnet', 'N/A'], ['stated-court.sputnik-v2.testnet', 'NOT CHECKED']]) {
    const checks = [];
    await verifyCourtProposal(fixture(), betId, (s, check, detail) => checks.push({ status: s, check, detail }), { fetchImpl: chainWith(referee) });
    assert.equal(checks[0].status, status, referee);
  }
});

test('court anchor reports no proposal separately and RPC outage never passes', async () => {
  assert.deepEqual((await courtChecks({ proposals: [] })).checks.map(c => c.status), ['NOT CHECKED']);
  const checks = [];
  await verifyCourtProposal(fixture(), fixture().material.bets[0].id, (status, check, detail) => checks.push({ status, check, detail }),
    { fetchImpl: async () => { throw new Error('offline'); } });
  assert.equal(checks[0].status, 'FAIL');
  assert.match(checks[0].detail, /offline/);
});
