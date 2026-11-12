// INTEGRATION: database-free transport, completion, persisted-shape and page-copy checks.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import test from 'node:test';
import { dstackPasses, validateDstackRecord, verifyWithDstack } from '../src/dstack-verifier.mjs';
import { attestedCompletion } from '../src/attested-completion.mjs';
import { verifyAttestedRecord } from '../src/attested-signature.mjs';
import { verifyEnclaveRecord } from '../src/enclave-ruling.mjs';
import { dstackVerificationLines, registerBetRulingRoutes } from '../src/bet-ruling-pages.mjs';
import { loadConfig } from '../src/config.mjs';
import { enclaveRulingFixture, fakeNearAi, keyFor, NEARAI_BASE, testReport } from './support/enclave.mjs';

const URL = 'https://verifier.example';
// Keep a real corpus quote; transport tests deliberately replace only ancillary fields.
const corpus = JSON.parse(readFileSync(new globalThis.URL('./fixtures/nearai-attestation-20261111.json', import.meta.url)));
const report = { ...corpus.gateway_attestation, event_log: [], info: { ...corpus.gateway_attestation.info, vm_config: '{}' } };
const reply = (details = {}, outer = {}) => ({ is_valid: true, details: {
  quote_verified: true, event_log_verified: true, os_image_hash_verified: true,
  acpi_tables_verified: true, os_image_is_dev: false, os_image_version: '0.5.12',
  tee_variant: 'dstack-tdx', tcb_status: 'UpToDate', advisory_ids: [],
  app_info: { os_image_hash: '91'.repeat(32), compose_hash: '87'.repeat(32) }, ...details,
}, reason: null, ...outer });
const check = value => verifyWithDstack(report, { url: URL, fetchImpl: async () => Response.json(value) });
const saved = async () => { const result = await check(reply()); return { gateway: result, model: structuredClone(result) }; };

test('posts full quote, stringified event log and unchanged VM config without redirects', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => { requests.push({ url, options }); return Response.json(reply()); };
  for (const event_log of [[], '[{"imr":3}]']) {
    const result = await verifyWithDstack({ ...report, event_log }, { url: URL, fetchImpl });
    const request = requests.at(-1);
    assert.equal(request.url, `${URL}/verify`);
    assert.equal(request.options.method, 'POST');
    assert.equal(request.options.redirect, 'manual');
    assert.equal(request.options.headers['content-type'], 'application/json');
    assert.ok(request.options.signal instanceof AbortSignal);
    assert.deepEqual(JSON.parse(request.options.body), { quote: report.intel_quote,
      event_log: typeof event_log === 'string' ? event_log : '[]', vm_config: '{}' });
    assert.equal(result.verifier, URL);
    assert.equal(result.checkedAt, new Date(result.checkedAt).toISOString());
    assert.equal(dstackPasses(result), true);
    assert.equal(result.osImageVersion, '0.5.12');
    assert.deepEqual(result.advisoryIds, []);
    assert.equal(result.osImageHash, '91'.repeat(32));
  }
  assert.equal(requests.length, 2);
});

test('invalid quote, development image, and non-current TCB fail the policy', async () => {
  for (const value of [reply({ quote_verified: false }, { is_valid: false, reason: 'Invalid quote' }),
    reply({ os_image_is_dev: true }), reply({ tcb_status: 'OutOfDate' })]) {
    assert.equal(dstackPasses(await check(value)), false);
  }
  const result = await check(reply());
  for (const key of ['isValid', 'quoteVerified', 'eventLogVerified', 'osImageHashVerified', 'acpiTablesVerified']) {
    assert.equal(dstackPasses({ ...result, [key]: false }), false, key);
    assert.equal(dstackPasses({ ...result, [key]: 'true' }), false, key);
  }
  assert.equal(dstackPasses(undefined), false);
});

test('an explicit negative verifier verdict on HTTP 500 remains a policy rejection', async () => {
  // The live verifier returns this status and shape for a malformed quote.
  const value = reply({ quote_verified: false, event_log_verified: false, os_image_hash_verified: false,
    acpi_tables_verified: false, os_image_is_dev: null, os_image_version: null, tee_variant: null,
    tcb_status: null, app_info: null }, { is_valid: false, reason: 'Internal error: Failed to create attestation' });
  const result = await verifyWithDstack(report, { url: URL, fetchImpl: async () => Response.json(value, { status: 500 }) });
  assert.equal(dstackPasses(result), false);
  assert.equal(result.reason, value.reason);
});

test('rejects malformed fields, non-JSON, broken UTF-8, oversized and redirected replies', async () => {
  const bad = [null, {}, reply({}, { is_valid: 'true' }), reply({ quote_verified: 1 }),
    reply({ event_log_verified: null }), reply({ os_image_hash_verified: 'true' }),
    reply({ acpi_tables_verified: undefined }), reply({ os_image_is_dev: 0 }),
    reply({ os_image_version: 12 }), reply({ tee_variant: [] }), reply({ tcb_status: {} }),
    reply({ advisory_ids: ['INTEL-SA-1', 2] }), reply({ app_info: {} }),
    reply({ app_info: { os_image_hash: 'not-a-hash', compose_hash: null } }), reply({}, { reason: false })];
  for (const value of bad) await assert.rejects(check(value), error => !error.unavailable);
  const responses = [new Response('{}'), new Response('{', { headers: { 'content-type': 'application/json' } }),
    new Response(new Uint8Array([0xff]), { headers: { 'content-type': 'application/json' } }),
    new Response('x'.repeat(1_000_001), { headers: { 'content-type': 'application/json' } }),
    new Response('{}', { headers: { 'content-type': 'application/json', 'content-length': '1000001' } }),
    new Response(null, { status: 302, headers: { location: 'https://other.example' } })];
  const redirected = Response.json(reply());
  Object.defineProperty(redirected, 'redirected', { value: true });
  responses.push(redirected);
  for (const response of responses) await assert.rejects(verifyWithDstack(report, {
    url: URL, fetchImpl: async () => response,
  }), error => !error.unavailable);
});

test('distinguishes unavailable transport from a malformed answer or HTTP rejection', async () => {
  for (const fetchImpl of [async () => { throw new TypeError('connection refused'); },
    async () => new Response('', { status: 503 }),
    async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('socket closed')); } }),
      { headers: { 'content-type': 'application/json' } })]) {
    await assert.rejects(verifyWithDstack(report, { url: URL, fetchImpl }), error => error.unavailable === true);
  }
  await assert.rejects(verifyWithDstack(report, { url: URL, fetchImpl: async () => new Response('', { status: 400 }) }),
    error => !error.unavailable);
  const controller = new AbortController();
  controller.abort();
  let fetched = false;
  await assert.rejects(verifyWithDstack(report, { url: URL, signal: controller.signal,
    fetchImpl: async () => { fetched = true; } }));
  assert.equal(fetched, false);
});

test('native fetch rejects a verifier redirect without following it or softening it to unavailable', async (t) => {
  let followed = false;
  const server = createServer((req, res) => {
    if (req.url === '/elsewhere') followed = true;
    res.writeHead(302, { location: '/elsewhere' });
    res.end();
  });
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  await assert.rejects(verifyWithDstack(report, { url: `http://127.0.0.1:${server.address().port}` }),
    error => /redirect/i.test(error.message) && !error.unavailable);
  assert.equal(followed, false);
});

test('production rulings need the dstack verifier; only GPU-less test stacks run without it', () => {
  assert.throws(() => loadConfig({ NEARAI_API_KEY: 'k', STATED_ENCLAVE_RULINGS: '1' }), /STATED_DSTACK_VERIFIER_URL/);
  assert.equal(loadConfig({ NEARAI_API_KEY: 'k', STATED_ENCLAVE_RULINGS: '1', STATED_DSTACK_VERIFIER_URL: URL }).nearai.rulings, true);
  assert.equal(loadConfig({ NEARAI_API_KEY: 'k', STATED_ENCLAVE_RULINGS: '1', STATED_REQUIRE_GPU_EVIDENCE: '0',
    NEARAI_BASE_URL: 'https://nearai.test/v1' }).nearai.rulings, true);
  assert.equal(loadConfig({ NEARAI_API_KEY: 'k', STATED_ENCLAVE_RULINGS: '1', STATED_REQUIRE_GPU_EVIDENCE: '0',
    NEARAI_BASE_URL: 'http://127.0.0.1:4317/v1' }).nearai.rulings, true);
  assert.equal(loadConfig({ STATED_ENCLAVE_RULINGS: '1' }).nearai.rulings, false, 'no key, no rulings, no requirement');
});

test('the GPU switch is refused for rulings against any NEAR AI host but a local or .test fake', () => {
  for (const NEARAI_BASE_URL of [undefined, 'https://cloud-api.near.ai/v1', 'https://nearai.test.example.com/v1', 'https://127.0.0.2/v1', 'not a url']) {
    assert.throws(() => loadConfig({ NEARAI_API_KEY: 'k', STATED_ENCLAVE_RULINGS: '1', STATED_REQUIRE_GPU_EVIDENCE: '0',
      ...(NEARAI_BASE_URL ? { NEARAI_BASE_URL } : {}) }), /only for test stacks/, String(NEARAI_BASE_URL));
  }
  assert.equal(loadConfig({ STATED_REQUIRE_GPU_EVIDENCE: '0' }).nearai.requireGpu, false, 'no rulings, nothing to refuse');
  assert.equal(loadConfig({ NEARAI_API_KEY: 'k', STATED_REQUIRE_GPU_EVIDENCE: '0' }).nearai.rulings, false, 'rulings off, nothing to refuse');
});

test('config is opt-in and restricts plaintext verification to test loopback', () => {
  assert.equal(loadConfig({}).nearai.dstackVerifierUrl, '');
  assert.equal(loadConfig({ STATED_DSTACK_VERIFIER_URL: URL }).nearai.dstackVerifierUrl, URL);
  for (const host of ['localhost', '127.0.0.1']) {
    assert.equal(loadConfig({ STATED_DSTACK_VERIFIER_URL: `http://${host}:8080`, STATED_FETCH_ALLOW_LOOPBACK: '1' })
      .nearai.dstackVerifierUrl, `http://${host}:8080`);
  }
  for (const url of ['http://example.org', 'http://127.0.0.2', 'ftp://localhost', `${URL}?key=x`,
    'https://user:password@example.org', 'bad-url', 'http://localhost:8080']) {
    assert.throws(() => loadConfig({ STATED_DSTACK_VERIFIER_URL: url }));
  }
});

async function complete({ response = reply(), responseStatus = 200, unreachable = false, malformed = false, enabled = true } = {}) {
  const ai = fakeNearAi({ respond: () => ({ agrees: true, reason: 'Evidence agrees.' }) });
  const seen = [];
  let signatureSeen = false;
  const fetchImpl = async (url, options) => {
    if (String(url).startsWith(URL)) {
      assert.equal(signatureSeen, true, 'dstack runs only after the signature is obtained');
      seen.push(JSON.parse(options.body));
      if (unreachable) throw new TypeError('connection refused');
      return Response.json(malformed ? {} : typeof response === 'function' ? response(seen.length) : response, { status: responseStatus });
    }
    const result = await ai.fetchImpl(url, options);
    if (String(url).includes('/signature/')) signatureSeen = true;
    if (!String(url).includes('/attestation/report?')) return result;
    const evidence = await result.json();
    const nonce = evidence.gateway_attestation.request_nonce;
    evidence.model_attestations.unshift(testReport(nonce, keyFor('non-signing-candidate').address));
    for (const [index, candidate] of [evidence.gateway_attestation, ...evidence.model_attestations].entries()) {
      candidate.info = { vm_config: `{"candidate":${index}}` };
    }
    return Response.json(evidence);
  };
  const record = await attestedCompletion({ nearai: { baseUrl: NEARAI_BASE, model: 'near/juror-a',
    apiKey: 'synthetic-test-only', ...(enabled ? { dstackVerifierUrl: URL } : {}) } }, {
    system: 'test', input: '{}', parse: JSON.parse, fetchImpl,
  });
  return { record, seen };
}

test('completion stores gateway and signing model results and feature-off records stay unchanged', async () => {
  const { record, seen } = await complete();
  assert.equal(seen.length, 2);
  assert.deepEqual(seen.map(body => body.vm_config), ['{"candidate":0}', '{"candidate":2}']);
  assert.ok(dstackPasses(record.dstack.gateway));
  assert.ok(dstackPasses(record.dstack.model));
  assert.doesNotThrow(() => verifyAttestedRecord(record));
  const off = await complete({ enabled: false });
  assert.equal(Object.hasOwn(off.record, 'dstack'), false);
  assert.equal(off.seen.length, 0);
});

test('completion fails closed on a negative verdict, a malformed reply, an old TCB or an unreachable verifier', async () => {
  for (const response of [reply({}, { is_valid: false, reason: 'Quote rejected' }),
    reply({ os_image_is_dev: true }), reply({ os_image_hash_verified: false })]) {
    await assert.rejects(complete({ response }), /dstack .*verification failed/);
  }
  // The boot image verified, but the Intel TCB is behind: no verdict from this call.
  await assert.rejects(complete({ response: reply({ tcb_status: 'OutOfDate' }) }), /dstack (?:gateway|model) verification failed: Intel TCB status is OutOfDate/);
  await assert.rejects(complete({ malformed: true }), /dstack/);
  await assert.rejects(complete({ response: reply({}, { is_valid: false, reason: 'Quote rejected' }), responseStatus: 500 }), /Quote rejected/);
  // Unreachable is an infrastructure failure: it rejects as unavailable, and the caller retries later.
  await assert.rejects(complete({ unreachable: true }), error => error.unavailable === true);
});

test('either report can reject the call, and a verifier timeout fails it', async (t) => {
  for (const failedReport of [1, 2]) {
    await assert.rejects(complete({ response: index => index === failedReport
      ? reply({}, { is_valid: false, reason: 'Rejected report' }) : reply() }), /Rejected report/);
  }
  const realTimeout = AbortSignal.timeout.bind(AbortSignal);
  let verifierTimeouts = 0;
  t.mock.method(AbortSignal, 'timeout', ms => {
    if (ms !== 90_000) return realTimeout(ms);
    verifierTimeouts += 1;
    const controller = new AbortController();
    setTimeout(() => controller.abort(new DOMException('Verifier timed out', 'TimeoutError')), 5);
    return controller.signal;
  });
  const ai = fakeNearAi({ respond: () => ({ agrees: true, reason: 'Evidence agrees.' }) });
  await assert.rejects(attestedCompletion({ nearai: { baseUrl: NEARAI_BASE, model: 'near/juror-a',
    apiKey: 'synthetic-test-only', dstackVerifierUrl: URL } }, { system: 'test', input: '{}', parse: JSON.parse,
    fetchImpl: async (url, options) => {
      if (String(url).startsWith(URL)) return new Promise((resolve, reject) => {
        options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true });
      });
      const response = await ai.fetchImpl(url, options);
      if (!String(url).includes('/attestation/report?')) return response;
      const evidence = await response.json();
      for (const candidate of [evidence.gateway_attestation, ...evidence.model_attestations]) candidate.info = { vm_config: '{}' };
      return Response.json(evidence);
    } }), error => error.unavailable === true);
  assert.ok(verifierTimeouts >= 1);
});

test('production configuration refuses a completion whose signing model has no GPU evidence', async () => {
  assert.equal(loadConfig({}).nearai.requireGpu, true);
  assert.equal(loadConfig({ STATED_REQUIRE_GPU_EVIDENCE: '0' }).nearai.requireGpu, false);
  const ai = fakeNearAi({ respond: () => ({ agrees: true, reason: 'Evidence agrees.' }) });
  await assert.rejects(attestedCompletion({ nearai: { baseUrl: NEARAI_BASE, model: 'near/juror-a',
    apiKey: 'synthetic-test-only', requireGpu: true } }, { system: 'test', input: '{}', parse: JSON.parse,
    fetchImpl: ai.fetchImpl }), /no NVIDIA GPU evidence/);
  assert.equal(ai.seen.signature, 1, 'the call is refused after the signature names the signing model');
});

test('strict persisted records retain old exact bytes and reject malformed optional metadata', async () => {
  const record = enclaveRulingFixture();
  const old = JSON.stringify(record);
  assert.equal(verifyEnclaveRecord(record), record);
  assert.equal(JSON.stringify(record), old);
  for (const call of [record.plan, ...record.verdicts]) call.dstack = await saved();
  assert.equal(verifyEnclaveRecord(record), record);
  for (const bad of [null, {}, { gateway: null, model: null },
    { ...record.plan.dstack, extra: true },
    { ...record.plan.dstack, gateway: { ...record.plan.dstack.gateway, quoteVerified: 'true' } },
    { ...record.plan.dstack, gateway: { verifier: URL, checkedAt: 'yesterday', error: 'offline' } }]) {
    const changed = structuredClone(record);
    changed.plan.dstack = bad;
    assert.throws(() => verifyEnclaveRecord(changed), /dstack/i);
    changed.plan.dstack = record.plan.dstack;
    changed.verdicts[0].dstack = bad;
    assert.throws(() => verifyEnclaveRecord(changed), /dstack/i);
  }
  assert.doesNotThrow(() => validateDstackRecord(record.plan.dstack));
});

test('ruling page claims require both reports of the plan and every verdict to pass', async () => {
  const record = enclaveRulingFixture();
  assert.deepEqual(dstackVerificationLines(record), []);
  for (const call of [record.plan, ...record.verdicts]) call.dstack = await saved();
  assert.deepEqual(dstackVerificationLines(record), [
    'When this ruling was made, the official dstack verifier reported that the boot measurements match the published dstack OS 0.5.12 image, production build.',
    'It also reported the Intel TCB up to date with no security advisories. The command below asks the verifier again.',
  ]);
  for (const index of [0, 1, 2]) for (const role of ['gateway', 'model']) {
    for (const result of [undefined, { verifier: URL, checkedAt: new Date().toISOString(), error: 'offline' },
      { ...record.plan.dstack.gateway, isValid: false }, { ...record.plan.dstack.gateway, osImageIsDev: true },
      { ...record.plan.dstack.gateway, tcbStatus: 'OutOfDate' },
      { ...record.plan.dstack.gateway, advisoryIds: ['INTEL-SA-1'] }]) {
      const changed = structuredClone(record);
      [changed.plan, ...changed.verdicts][index].dstack[role] = result;
      assert.deepEqual(dstackVerificationLines(changed), [], `${index} ${role}`);
    }
  }
});

test('the ruling route renders both plain lines and suppresses them when the plan lacks verification', async () => {
  const record = enclaveRulingFixture();
  for (const call of [record.plan, ...record.verdicts]) call.dstack = await saved();
  const { material } = record;
  const row = { id: material.bets[0].id, terms_hash: material.bets[0].termsHash, claim: material.claim,
    resolve_at: material.deadline, created_at: material.madeAt, accept_by: material.madeAt,
    evidence_source_url: material.postUrl, status: 'accepted', creator_side: 'yes',
    creator_username: 'maker', acceptor_username: 'taker', stake_yocto: '100000000000000000000000',
    creator_wallet: 'maker.testnet', acceptor_wallet: 'taker.testnet', referee_wallet: 'referee.testnet',
    creator_user_id: '1', acceptor_user_id: '2', creator_bound: true, acceptor_bound: true,
    acceptor_consented: true, near_height: '1', near_verified_at: material.deadline,
    read_at: material.deadline };
  const ns = value => (BigInt(Date.parse(value)) * 1_000_000n).toString();
  row.chain_state = { id: row.id, terms_hash: row.terms_hash, stake_yocto: row.stake_yocto,
    creator_side: row.creator_side, creator: row.creator_wallet, acceptor: row.acceptor_wallet,
    creator_binding_hash: 'a'.repeat(64), acceptor_binding_hash: 'b'.repeat(64),
    accept_by_ns: ns(row.accept_by), resolve_at_ns: ns(row.resolve_at), status: 'accepted', referee: row.referee_wallet };
  const tx = { async one(sql) {
    if (sql.startsWith('select b.id, b.creator_user_id')) return row;
    if (sql.startsWith('select e.detail')) return { ...row, detail: record };
    if (sql.startsWith('select src.published_at')) return null;
    if (/^select (s.statement_id|source_save_id)/.test(sql)) return null;
    throw new Error(`Unexpected SQL: ${sql}`);
  }, async many() { return []; } };
  let handler;
  let page;
  let layoutOptions;
  registerBetRulingRoutes({ db: { tx: fn => fn(tx) }, config: { play: {}, baseUrl: 'https://stated.example' },
    route(method, expression, fn) { if (expression.test(`/bets/${row.id}/ruling`)) handler = fn; },
    layout: async (ctx, title, body, options) => { layoutOptions = options; return String(body); }, send(res, status, body) { assert.equal(status, 200); page = body; },
    notFound() { assert.fail('The verified fixture must render'); } });
  assert.equal(typeof handler, 'function');
  await handler({ params: [row.id], res: {} });
  assert.equal(layoutOptions.back, `/bets/${row.id}`);
  assert.match(page, /class="post-origin"/);
  assert.doesNotMatch(page, /class="post-time"|All (?:three|\d+) models said|>Back to bet<\/a>/);
  assert.match(page, /<summary>Check it yourself<\/summary>[\s\S]*<p>When this ruling was made, the official dstack verifier reported that the boot measurements match the published dstack OS 0\.5\.12 image, production build\.<\/p>/);
  assert.ok(page.includes('<p>It also reported the Intel TCB up to date with no security advisories. The command below asks the verifier again.</p>'));
  delete record.plan.dstack;
  await handler({ params: [row.id], res: {} });
  assert.doesNotMatch(page, /boot measurements match|Intel TCB up to date/);
});
