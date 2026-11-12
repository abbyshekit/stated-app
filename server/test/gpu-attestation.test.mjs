import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import test from 'node:test';
import { getGpuJwks, verifyGpuJwt, verifyGpuPayload } from '../src/gpu-attestation.mjs';
import { attestedCompletion } from '../src/attested-completion.mjs';
import { verifyEnclaveRecord, verifyEnclaveRecordWithGpu, verifyRulingGpu } from '../src/enclave-ruling.mjs';
import { enclaveRulingFixture, fakeNearAi, keyFor, NEARAI_BASE, testReport } from './support/enclave.mjs';

const NRAS = 'https://nras.attestation.nvidia.com';
const nonce = 'ab'.repeat(32);
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'secp384r1' });
const jwks = { keys: [{ ...publicKey.export({ format: 'jwk' }), kid: 'test-nras', alg: 'ES384', use: 'sig' }] };
const claimsFor = (given = {}) => ({ iss: NRAS, eat_nonce: nonce, 'x-nvidia-overall-att-result': true, ...given });
function token(claims = claimsFor(), header = {}) {
  const input = [ { alg: 'ES384', kid: 'test-nras', ...header }, claims ]
    .map(part => Buffer.from(JSON.stringify(part)).toString('base64url')).join('.');
  return `${input}.${sign('sha384', Buffer.from(input), { key: privateKey, dsaEncoding: 'ieee-p1363' }).toString('base64url')}`;
}
const corrupt = jwt => {
  const parts = jwt.split('.');
  const signature = Buffer.from(parts[2], 'base64url');
  signature[0] ^= 1;
  return `${parts[0]}.${parts[1]}.${signature.toString('base64url')}`;
};

function transport(jwt = token()) {
  const requests = [];
  return Object.assign(async (url, options) => {
    requests.push({ url: String(url), options });
    if (String(url) === `${NRAS}/v3/attest/gpu`) return Response.json([['JWT', jwt], { ignored: 'device tokens' }]);
    if (String(url) === `${NRAS}/.well-known/jwks.json`) return Response.json(jwks);
    throw new Error('Unexpected URL');
  }, { requests });
}

test('NRAS receives the decoded payload unchanged and its signed true verdict verifies', async () => {
  const fetchImpl = transport();
  const payload = { nonce: nonce.toUpperCase(), arch: 'HOPPER', evidence_list: [{ evidence: 'test-evidence', certificate: 'test-cert' }], optional: null };
  const result = await verifyGpuPayload(JSON.stringify(payload), nonce, { fetchImpl });
  assert.equal(result.verdict, true);
  assert.deepEqual(result.claims, claimsFor());
  assert.deepEqual(JSON.parse(fetchImpl.requests[0].options.body), payload);
  assert.equal(fetchImpl.requests[0].options.method, 'POST');
  assert.equal(fetchImpl.requests[0].options.redirect, 'error');
  assert.ok(fetchImpl.requests[0].options.signal instanceof AbortSignal);
  await verifyGpuPayload(JSON.stringify(payload), nonce, { fetchImpl });
  assert.equal(fetchImpl.requests.filter(r => r.url.endsWith('jwks.json')).length, 1, 'keys cached across attestations');
  assert.deepEqual(verifyGpuJwt(result.jwt, { jwks }), result);
});

test('payload nonce mismatch and malformed payloads fail before any network request', async () => {
  const fetchImpl = transport();
  for (const payload of [{ nonce: 'cd'.repeat(32) }, { nonce: 1 }, {}, [], null]) {
    await assert.rejects(verifyGpuPayload(JSON.stringify(payload), nonce, { fetchImpl }), /nonce|object/);
  }
  await assert.rejects(verifyGpuPayload('x'.repeat(1_000_001), nonce, { fetchImpl }), /1 MB/);
  assert.equal(fetchImpl.requests.length, 0);
});

test('false or nonboolean verdicts, signed nonce mismatch, bad signatures and unknown keys fail closed', async () => {
  for (const [jwt, error] of [
    [token(claimsFor({ 'x-nvidia-overall-att-result': false })), /verdict is not true/],
    [token(claimsFor({ 'x-nvidia-overall-att-result': 'true' })), /verdict is not true/],
    [token(claimsFor({ eat_nonce: 'cd'.repeat(32) })), /JWT nonce does not match/],
    [corrupt(token()), /signature verification failed/],
    [token(claimsFor(), { kid: 'unknown' }), /key id not found/],
    [token(claimsFor(), { alg: 'HS384' }), /requires ES384/],
    [token(claimsFor({ iss: 'https://attacker.example' })), /issuer/],
  ]) {
    await assert.rejects(verifyGpuPayload(JSON.stringify({ nonce }), nonce, { fetchImpl: transport(jwt) }), error);
  }
});

test('offline verifier rejects malformed tokens, unsupported keys and unsigned claims', () => {
  for (const jwt of ['', 'a.b', 'e30.e30.AA', token().replace(/.$/, '=')]) {
    assert.throws(() => verifyGpuJwt(jwt, { jwks }));
  }
  assert.throws(() => verifyGpuJwt(token(), { jwks: { keys: [jwks.keys[0], jwks.keys[0]] } }), /uniquely/);
  assert.throws(() => verifyGpuJwt(token(), { jwks: { keys: [{ ...jwks.keys[0], crv: 'P-256' }] } }), /permit ES384/);
  const parts = token().split('.');
  parts[1] = Buffer.from(JSON.stringify(claimsFor({ eat_nonce: 'cd'.repeat(32) }))).toString('base64url');
  assert.throws(() => verifyGpuJwt(parts.join('.'), { jwks }), /signature verification failed/);
});

test('NRAS errors, oversized responses, malformed bundles and failed JWKS do not verify', async () => {
  const payload = JSON.stringify({ nonce });
  for (const response of [new Response('unavailable', { status: 503 }), new Response('x'.repeat(1_000_001)),
    Response.json([]), Response.json([['not-JWT', token()]]), Response.json({ jwt: token() })]) {
    await assert.rejects(verifyGpuPayload(payload, nonce, { fetchImpl: async () => response }));
  }
  const fetchImpl = async url => String(url).endsWith('jwks.json') ? new Response('down', { status: 503 }) : Response.json([['JWT', token()]]);
  await assert.rejects(verifyGpuPayload(payload, nonce, { fetchImpl }), /HTTP 503/);
  const controller = new AbortController();
  controller.abort();
  const stopped = transport();
  await assert.rejects(verifyGpuPayload(payload, nonce, { fetchImpl: stopped, signal: controller.signal }), /abort/i);
  assert.equal(stopped.requests.length, 0);
});

test('parallel JWKS readers share one fetch, and failed loads may retry', async () => {
  const fetchImpl = transport();
  await Promise.all([getGpuJwks({ fetchImpl }), getGpuJwks({ fetchImpl })]);
  assert.equal(fetchImpl.requests.length, 1);
  let attempts = 0;
  const retry = async () => ++attempts === 1 ? new Response('', { status: 503 }) : Response.json(jwks);
  await assert.rejects(getGpuJwks({ fetchImpl: retry }));
  assert.deepEqual(await getGpuJwks({ fetchImpl: retry }), jwks);
  assert.equal(attempts, 2);
});

test('ruling records accept optional signed GPU evidence, reject tampering, and retain old records', () => {
  const record = enclaveRulingFixture();
  assert.equal(verifyEnclaveRecord(record), record);
  assert.deepEqual(verifyRulingGpu(record.plan), { checked: false, verdict: null, reason: 'GPU not checked: no GPU evidence stored' });
  const calls = [record.plan, ...record.verdicts];
  for (const call of calls) call.gpu = { jwt: token(claimsFor({ eat_nonce: call.nonce })), verdict: true, checkedAt: call.attestedAt };
  assert.equal(verifyEnclaveRecord(record, { jwks }), record);
  const changed = structuredClone(record);
  changed.verdicts[0].gpu.jwt = corrupt(changed.verdicts[0].gpu.jwt);
  assert.throws(() => verifyEnclaveRecord(changed, { jwks }), /signature verification failed/);
  changed.verdicts[0].gpu.jwt = token(claimsFor());
  assert.throws(() => verifyEnclaveRecord(changed, { jwks }), /GPU JWT nonce/);
  changed.verdicts[0].gpu = { ...record.verdicts[0].gpu, verdict: false };
  assert.throws(() => verifyEnclaveRecord(changed, { jwks }), /gpu.verdict/);
  changed.verdicts[0].gpu = { ...record.verdicts[0].gpu, checkedAt: '2020-01-01T00:00:00Z' };
  assert.throws(() => verifyEnclaveRecord(changed, { jwks }), /within the call/);
  changed.verdicts[0].gpu = null;
  assert.throws(() => verifyEnclaveRecord(changed, { jwks }), /gpu must be an object/);
});

test('one verification run fetches JWKS once for plan and all verdicts; explicit keys stay offline', async () => {
  const record = enclaveRulingFixture();
  for (const call of [record.plan, ...record.verdicts]) {
    call.gpu = { jwt: token(claimsFor({ eat_nonce: call.nonce })), verdict: true, checkedAt: call.attestedAt };
  }
  const fetchImpl = transport();
  assert.equal(await verifyEnclaveRecordWithGpu(record, { fetchImpl }), record);
  assert.equal(fetchImpl.requests.length, 1);
  assert.equal(await verifyEnclaveRecordWithGpu(record, { jwks, fetchImpl: async () => { throw new Error('must remain offline'); } }), record);
});

test('completion preflight checks GPU evidence before inference and stores the signing candidate token', async () => {
  const ai = fakeNearAi({ respond: () => ({ agrees: true, reason: 'Evidence agrees.' }) });
  const gpuFetch = transport();
  const posted = [];
  let rejectOther = false;
  const fetchImpl = async (url, options) => {
    if (String(url).startsWith(NRAS)) {
      if (String(url).endsWith('/gpu')) {
        const payload = JSON.parse(options.body);
        posted.push(payload);
        return Response.json([['JWT', token(claimsFor({ eat_nonce: payload.nonce, candidate: payload.candidate || 'signer',
          'x-nvidia-overall-att-result': !(rejectOther && payload.candidate === 'other') }))]]);
      }
      return gpuFetch(url, options);
    }
    const response = await ai.fetchImpl(url, options);
    if (String(url).includes('/attestation/report?')) {
      const report = await response.json();
      for (const candidate of report.model_attestations) candidate.nvidia_payload = JSON.stringify({ nonce: candidate.request_nonce, evidence_list: [] });
      const extra = testReport(report.model_attestations[0].request_nonce, keyFor('other-candidate').address);
      extra.nvidia_payload = JSON.stringify({ nonce: extra.request_nonce, evidence_list: [], candidate: 'other' });
      report.model_attestations.push(extra);
      return Response.json(report);
    }
    return response;
  };
  const config = { nearai: { baseUrl: NEARAI_BASE, apiKey: 'test-only', model: 'near/juror-a' } };
  const completion = await attestedCompletion(config, { fetchImpl, system: 'test', input: '{}', parse: JSON.parse, checkContent: value => value });
  assert.equal(completion.gpu.verdict, true);
  assert.equal(verifyGpuJwt(completion.gpu.jwt, { jwks }).claims.eat_nonce, completion.nonce);
  assert.equal(verifyGpuJwt(completion.gpu.jwt, { jwks }).claims.candidate, 'signer');
  assert.ok(Number.isFinite(Date.parse(completion.gpu.checkedAt)));
  assert.equal(gpuFetch.requests.length, 1, 'candidate attestations share a JWKS fetch');
  assert.equal(posted.length, 2, 'all model candidates are checked before inference');
  rejectOther = true;
  await assert.rejects(attestedCompletion(config, { fetchImpl, system: 'test', input: '{}', parse: JSON.parse, checkContent: value => value }), /verdict is not true/);
  assert.equal(ai.seen.completion, 1, 'a failing non-signing candidate also blocks inference');
  const aiFailed = fakeNearAi();
  const unavailable = async (url, options) => {
    if (String(url).startsWith(NRAS)) return new Response('unavailable', { status: 503 });
    const response = await aiFailed.fetchImpl(url, options);
    if (!String(url).includes('/attestation/report?')) return response;
    const report = await response.json();
    report.model_attestations[0].nvidia_payload = JSON.stringify({ nonce: report.model_attestations[0].request_nonce });
    return Response.json(report);
  };
  await assert.rejects(attestedCompletion(config, { fetchImpl: unavailable, system: 'test', input: '{}', parse: JSON.parse, checkContent: value => value }), /HTTP 503/);
  assert.equal(aiFailed.seen.completion, 0, 'inference is blocked when GPU preflight fails');
});

test('completion retains legacy shape when no GPU evidence is returned', async () => {
  const ai = fakeNearAi({ respond: () => ({ agrees: true, reason: 'Evidence agrees.' }) });
  const config = { nearai: { baseUrl: NEARAI_BASE, apiKey: 'test-only', model: 'near/juror-a' } };
  const completion = await attestedCompletion(config, { fetchImpl: ai.fetchImpl, system: 'test', input: '{}', parse: JSON.parse });
  assert.equal(Object.hasOwn(completion, 'gpu'), false);
});

test('cached NVIDIA keys expire after one hour', async () => {
  const originalNow = Date.now;
  let now = originalNow();
  Date.now = () => now;
  try {
    const fetchImpl = transport();
    await getGpuJwks({ fetchImpl });
    now += 3_599_999;
    await getGpuJwks({ fetchImpl });
    assert.equal(fetchImpl.requests.length, 1);
    now += 1;
    await getGpuJwks({ fetchImpl });
    assert.equal(fetchImpl.requests.length, 2);
  } finally { Date.now = originalNow; }
});
