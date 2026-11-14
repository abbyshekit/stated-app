// INTEGRATION: standalone verifier output with injected dstack and NVIDIA transports; no database.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { DEFAULT_DSTACK_VERIFIER, parseVerifierArguments, verifyRulingAttestations, verifyCourtProposal,
  verifyHostedEnclaveRuling, verifyOfflineEnclaveRuling } from '../../scripts/verify-enclave-ruling.mjs';
import { fingerprint } from '../src/canonical.mjs';
import { sha256 } from '../src/attested-signature.mjs';
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
      return Response.json({ jsonrpc: '2.0', id: 'stated', result: { result: [...Buffer.from(JSON.stringify(value))] } });
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
  assert.match(checks[0].detail, /get_last_proposal_id.*deadline 30000ms.*request failed/);
});

const savedFile = fileURLToPath(new URL('../../evidence/enclave-ruling-c171de89.json', import.meta.url));
const scriptFile = fileURLToPath(new URL('../../scripts/verify-enclave-ruling.mjs', import.meta.url));
const savedDocument = async () => JSON.parse(await readFile(savedFile, 'utf8'));
const flipByte = text => `${text[0] === '0' ? '1' : '0'}${text.slice(1)}`;

function forbiddenTransport() {
  let calls = 0;
  return { fetchImpl: async () => { calls++; throw new Error('Fetch must never be called offline'); },
    assertUnused: () => assert.equal(calls, 0, 'offline verification made a fetch call') };
}

async function offlineDocument(document, options = {}) {
  const transport = forbiddenTransport();
  const result = await verifyHostedEnclaveRuling(undefined, undefined, { document, offline: true,
    ...options, fetchImpl: transport.fetchImpl });
  transport.assertUnused();
  return result;
}

function offlineCli(file) {
  // Catch accidental global fetch calls in the child too, including errors that
  // the verifier might swallow. No preload file or network service is needed.
  const guard = `let calls = 0; globalThis.fetch = async () => { calls++; throw new Error('Forbidden fetch'); };
    process.on('exit', () => { if (calls) { console.error('Unexpected fetch calls: ' + calls); process.exitCode = 97; } });`;
  return spawnSync(process.execPath, ['--import', `data:text/javascript,${encodeURIComponent(guard)}`,
    scriptFile, '--offline', ...(file === undefined ? [] : [file])], { encoding: 'utf8', timeout: 10_000 });
}

test('offline saved ruling passes every local check with zero fetch calls and unchanged input', async () => {
  const bytes = await readFile(savedFile);
  const transport = forbiddenTransport();
  const result = await verifyOfflineEnclaveRuling(savedFile, { fetchImpl: transport.fetchImpl });
  transport.assertUnused();
  assert.equal(result.exitCode, 2, 'offline is incomplete by design');
  assert.equal(result.summary, '9 checks passed, 0 failed, 21 not checked');
  assert.equal(result.firstLine, `Record read from file ${JSON.stringify(savedFile)}; sha256:${sha256(bytes)}`);
  assert.deepEqual(result.checks.filter(c => c.status === 'PASS').map(c => c.check), [
    'Arguments', 'Signed ruling', 'Intel TDX quotes', 'Bet coverage', 'Jury policy',
    'Signed model verdict', 'Signed model verdict', 'Signed model verdict', 'Stored Coinbase evidence',
  ]);
  assert.match(result.checks.find(c => c.check === 'Intel TDX quotes').detail, /event logs replay against RTMR3/);
  assert.match(result.checks.find(c => c.check === 'Bet coverage').detail, /0e83fba51534df5bbfcd94d949fcd90f1e3a7532bcae2474a8d27c4357164fd8/);
  const skipped = result.checks.filter(c => c.status === 'NOT CHECKED');
  assert.deepEqual([...new Set(skipped.map(c => c.check))], ['Dstack verifier', 'Court proposal',
    'Quote measurements', 'GPU attestation', 'Intel collateral', 'Coinbase source', 'Coinbase evidence hash',
    'Public claim', 'Public deadline', 'Public terms hash', 'Public outcome']);
  assert.ok(skipped.every(c => c.detail.endsWith('(offline: needs the network)')));
  assert.equal(skipped.filter(c => c.check === 'Quote measurements').length, 8);
  assert.equal(skipped.filter(c => c.check === 'GPU attestation').length, 4);
  const document = await savedDocument();
  const before = structuredClone(document);
  assert.equal((await offlineDocument(document)).exitCode, 2);
  assert.deepEqual(document, before);
  const cli = offlineCli(savedFile);
  assert.equal(cli.error, undefined);
  assert.equal(cli.status, 2, cli.stderr || cli.stdout);
  assert.equal(cli.stderr, '');
  assert.ok(cli.stdout.startsWith(`${result.firstLine}\n`));
  assert.ok(cli.stdout.endsWith(`${result.summary}\n`));
});

test('offline CLI rejects a single changed model-signature or response byte with exit 1', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'stated-offline-'));
  try {
    for (const field of ['signature', 'responseBody']) {
      const document = await savedDocument();
      const call = document.record.verdicts[0];
      if (field === 'signature') call.signature.signature = flipByte(call.signature.signature);
      else {
        const bytes = Buffer.from(call.responseBody, 'base64');
        bytes[0] ^= 1;
        call.responseBody = bytes.toString('base64');
      }
      const file = join(directory, `${field}.json`);
      await writeFile(file, JSON.stringify(document));
      const transport = forbiddenTransport();
      const result = await verifyOfflineEnclaveRuling(file, { fetchImpl: transport.fetchImpl });
      transport.assertUnused();
      assert.equal(result.exitCode, 1);
      const cli = offlineCli(file);
      assert.equal(cli.error, undefined);
      assert.equal(cli.status, 1, cli.stderr || cli.stdout);
      assert.match(cli.stdout, field === 'signature' ? /FAIL Signed ruling: Ed25519 signature verification failed/
        : /FAIL Signed ruling: responseHash does not match exact response bytes/);
      assert.match(cli.stdout, /1 failed/);
    }
  } finally { await rm(directory, { recursive: true, force: true }); }
});

test('offline retains core validation of evidence, outcome, policy, quotes and attachments', async () => {
  const mutations = [
    [d => { d.record.evidence.text += ' '; }, /evidence textHash/],
    [d => { d.record.outcome = 'yes'; }, /outcome does not follow/],
    [d => { d.record.jury.minConfidence = 0.7; }, /jury.minConfidence/],
    [d => { d.record.material.bets[0].termsHash = '0'.repeat(64); }, /materialHash/],
    [d => { d.record.plan.extra = true; }, /plan has unexpected fields/],
    [d => { d.record.plan.dstack = {}; }, /dstack/],
    [d => { d.record.plan.attestation.gateway_attestation.request_nonce = '0'.repeat(64); }, /request_nonce/],
    [d => {
      const report = d.record.plan.attestation.gateway_attestation;
      const events = typeof report.event_log === 'string' ? JSON.parse(report.event_log) : report.event_log;
      events.find(event => event.imr === 3).digest = '0'.repeat(48);
      report.event_log = events;
    }, /event log|digest/],
  ];
  for (const [mutate, message] of mutations) {
    const document = await savedDocument();
    mutate(document);
    const result = await offlineDocument(document);
    assert.equal(result.exitCode, 1, mutate.toString());
    assert.match(result.checks.find(c => c.status === 'FAIL').detail, message);
  }
  for (const document of [null, {}, { record: {}, recipe: '' }]) {
    assert.equal((await offlineDocument(document)).exitCode, 1);
  }
});

test('offline stored GPU tokens require explicit trusted keys and preserve local validation', async () => {
  const document = await savedDocument();
  const call = document.record.plan;
  const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
  const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'offline-test', alg: 'ES384' }] };
  const token = (claims = {}) => {
    const input = [{ alg: 'ES384', kid: 'offline-test' }, { iss: 'https://nras.attestation.nvidia.com',
      eat_nonce: call.nonce, 'x-nvidia-overall-att-result': true, ...claims }]
      .map(value => Buffer.from(JSON.stringify(value)).toString('base64url')).join('.');
    return `${input}.${sign('sha384', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
  };
  call.gpu = { jwt: token(), verdict: true, checkedAt: call.attestedAt };
  const before = structuredClone(document);
  const skipped = await offlineDocument(document);
  assert.equal(skipped.exitCode, 2);
  assert.deepEqual(document, before);
  const gpu = skipped.checks.filter(c => c.check === 'GPU attestation');
  assert.equal(gpu[0].status, 'NOT CHECKED');
  assert.match(gpu[0].detail, /signing keys are not supplied/);
  const verified = await offlineDocument(document, { jwks });
  assert.equal(verified.exitCode, 2);
  assert.equal(verified.checks.filter(c => c.check === 'GPU attestation' && c.status === 'PASS').length, 1);
  for (const mutate of [
    gpu => { gpu.jwt = `${gpu.jwt.slice(0, -128)}${flipByte(gpu.jwt.slice(-128))}`; },
    gpu => { gpu.jwt = token({ eat_nonce: '0'.repeat(64) }); },
    gpu => { gpu.jwt = token({ 'x-nvidia-overall-att-result': false }); },
    gpu => { gpu.checkedAt = '2000-01-01T00:00:00.000Z'; },
  ]) {
    const changed = structuredClone(document);
    mutate(changed.record.plan.gpu);
    assert.equal((await offlineDocument(changed, { jwks })).exitCode, 1, mutate.toString());
  }
  for (const mutate of [gpu => { gpu.verdict = false; }, gpu => { gpu.jwt = 'bad'; },
    gpu => { gpu.checkedAt = '2000-01-01T00:00:00.000Z'; }]) {
    const changed = structuredClone(document);
    mutate(changed.record.plan.gpu);
    assert.equal((await offlineDocument(changed)).exitCode, 1, mutate.toString());
  }
});

test('offline argument and file errors are clear, nonzero, and independent of verifier environment', async () => {
  assert.deepEqual(parseVerifierArguments(['--offline', savedFile], { DSTACK_VERIFIER_URL: 'invalid' }), { offlineFile: savedFile });
  for (const args of [['--offline'], ['--offline', '--unknown'], ['--offline', savedFile, '--offline', savedFile],
    ['--offline', savedFile, 'extra'], ['--offline', savedFile, '--dstack-verifier', verifier]]) {
    assert.throws(() => parseVerifierArguments(args, {}), /offline/);
  }
  const missingArgument = offlineCli();
  assert.equal(missingArgument.status, 1);
  assert.match(missingArgument.stdout, /FAIL Arguments: --offline requires one file path/);
  const missingFile = offlineCli(join(tmpdir(), `stated-missing-${process.pid}`, 'missing.json'));
  assert.equal(missingFile.status, 1);
  assert.match(missingFile.stdout, /FAIL Offline file: Cannot verify .*ENOENT/);
});
