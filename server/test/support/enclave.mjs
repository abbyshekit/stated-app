// Test doubles for enclave rulings: a fake NEAR AI Cloud (attestation report with
// a TDX quote, completion, Ed25519 response signature) served through an injected
// fetch, a fake Coinbase candles feed, and a fixture that builds a record which
// passes verifyEnclaveRecord. Quotes chain to an ephemeral test root, which this
// module installs as the process's trust root on import: test code only.
import { generateKeyPairSync, randomBytes, sign } from 'node:crypto';
import { setQuoteRootsForTests, sha256 } from '../../src/attested-signature.mjs';
import { makeTestQuote, makeTestRoot } from '../../src/tdx-quote.mjs';
import {
  PLAN_PROMPT, VERDICT_PROMPT, candleEvidence, candleUrl, checkPlan, decide, juryPolicy, makeMaterial, materialHash,
  planInput, submittedEvidence, verdictInput, windowSegments,
} from '../../src/enclave-ruling.mjs';

export const NEARAI_BASE = 'https://nearai.test/v1';
export const PLANNER = 'near/planner-test'; // config.nearai.model; plans are asked of the jury models
export const JURORS = ['near/juror-a', 'near/juror-b'];

// One signing key per model, for the life of the process, so fixtures and the fake server agree.
const keys = new Map();
export function keyFor(model) {
  if (!keys.has(model)) {
    const pair = generateKeyPairSync('ed25519');
    keys.set(model, { ...pair, address: pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex') });
  }
  return keys.get(model);
}

// One ephemeral root per test process. Readers that take no configuration (stored
// records read for a page) use the process default, so it is installed here.
const ROOT = makeTestRoot();
export const testRoots = [ROOT.rootPem];
setQuoteRootsForTests(testRoots);

/** An attestation report whose TDX quote binds `address` and `nonce` under the test root. */
export function testReport(nonce, address, { quote } = {}) {
  return { signing_algo: 'ed25519', signing_address: address, request_nonce: nonce,
    intel_quote: quote ?? makeTestQuote({ signingAddress: address, nonceHex: nonce, rootKey: ROOT.rootKey }), event_log: '[]' };
}
const report = testReport;

function signatureFor(model, request, response, { bad = false } = {}) {
  const key = keyFor(model);
  const text = `${model}:${sha256(request)}:${sha256(response)}`;
  return { text, signature: bad ? '00'.repeat(64) : sign(null, Buffer.from(text), key.privateKey).toString('hex'),
    signing_address: key.address, signing_algo: 'ed25519', signature_kind: 'provider_tee' };
}

const requestBytes = (model, system, user) => Buffer.from(JSON.stringify({ model, stream: false,
  response_format: { type: 'json_object' }, max_tokens: 8192,
  messages: [{ role: 'system', content: system }, { role: 'user', content: user }] }));

/**
 * A fake NEAR AI Cloud. `respond({ kind: 'plan'|'verdict', model, input, user })`
 * returns the reply object (or a raw string); it may be async. `mode` 'bad-signature'
 * zeroes the signature; 'junk-quote' returns reports whose quote is not a real
 * quote; 'unbound-quote' returns a valid quote for another key; 'down' answers 503. `seen` counts every call and keeps
 * the parsed user inputs.
 */
export function fakeNearAi({ respond } = {}) {
  const seen = { attestation: 0, completion: 0, signature: 0, plans: [], verdicts: [] };
  const completions = new Map();
  const fake = {
    seen,
    mode: 'ok',
    respond: respond || (() => { throw new Error('no responder'); }),
    async fetchImpl(raw, init = {}) {
      const url = new URL(raw);
      if (url.origin !== new URL(NEARAI_BASE).origin) throw new Error(`fake NEAR AI got a request for ${url.origin}`);
      const json = (value, status = 200) => new Response(Buffer.from(typeof value === 'string' ? value : JSON.stringify(value)),
        { status, headers: { 'content-type': 'application/json' } });
      if (fake.mode === 'down') return json({}, 503);
      if (url.pathname === '/v1/attestation/report') {
        seen.attestation += 1;
        const nonce = url.searchParams.get('nonce');
        const { address } = keyFor(url.searchParams.get('model'));
        const quote = fake.mode === 'junk-quote' ? 'abcd'
          : fake.mode === 'unbound-quote' ? makeTestQuote({ signingAddress: keyFor('someone-else').address, nonceHex: nonce, rootKey: ROOT.rootKey })
            : undefined;
        return json({ gateway_attestation: report(nonce, address, { quote }), model_attestations: [report(nonce, address, { quote })] });
      }
      if (url.pathname === '/v1/chat/completions') {
        seen.completion += 1;
        const request = Buffer.from(init.body);
        const body = JSON.parse(request.toString('utf8'));
        const [system, user] = body.messages.map((m) => m.content);
        const kind = system === PLAN_PROMPT ? 'plan' : system === VERDICT_PROMPT ? 'verdict' : 'other';
        const input = JSON.parse(user);
        (kind === 'plan' ? seen.plans : seen.verdicts).push({ model: body.model, input, user });
        const reply = await fake.respond({ kind, model: body.model, input, user });
        const id = `chat-${seen.completion}-${randomBytes(4).toString('hex')}`;
        const response = Buffer.from(JSON.stringify({ id, choices: [{ message: { content: typeof reply === 'string' ? reply : JSON.stringify(reply) } }] }));
        completions.set(id, { model: body.model, request, response });
        return new Response(response, { status: 200, headers: { 'content-type': 'application/json' } });
      }
      const match = url.pathname.match(/^\/v1\/signature\/(.+)$/);
      if (match && completions.has(match[1])) {
        seen.signature += 1;
        const { model, request, response } = completions.get(match[1]);
        return json(signatureFor(model, request, response, { bad: fake.mode === 'bad-signature' }));
      }
      return json({}, 404);
    },
  };
  return fake;
}

/** Stack environment that turns rulings on against the fake NEAR AI. */
export const enclaveEnv = {
  NEARAI_API_KEY: 'synthetic-test-key',
  NEARAI_BASE_URL: NEARAI_BASE,
  NEARAI_MODEL: PLANNER,
  NEARAI_RULING_MODELS: JURORS.join(','),
  STATED_ENCLAVE_RULINGS: '1',
};

/**
 * A fake Coinbase candles feed. Answers like Coinbase: newest first, including
 * the candle at `end`. `price(timeMs)` gives the close; `urls` records every request.
 */
export function fakeCoinbase({ price = () => 100 } = {}) {
  const feed = {
    urls: [],
    price,
    body: null,
    async fetchEvidence(raw) {
      feed.urls.push(raw);
      if (feed.body != null) return feed.body;
      const url = new URL(raw);
      const step = Number(url.searchParams.get('granularity')) * 1000;
      const start = Date.parse(url.searchParams.get('start'));
      const end = Date.parse(url.searchParams.get('end'));
      const rows = [];
      for (let at = Math.ceil(start / step) * step; at <= end; at += step) {
        const close = feed.price(at);
        rows.push([at / 1000, close - 1, close + 1, close - 0.5, close, 12.5]);
      }
      return JSON.stringify(rows.reverse());
    },
  };
  return feed;
}

function attest(model, system, user, reply, at) {
  const nonce = randomBytes(32).toString('hex');
  const id = `chat-fixture-${randomBytes(6).toString('hex')}`;
  const request = requestBytes(model, system, user);
  const response = Buffer.from(JSON.stringify({ id, choices: [{ message: { content: JSON.stringify(reply) } }] }));
  const { address } = keyFor(model);
  return { model, requestBody: request.toString('base64'), responseBody: response.toString('base64'),
    requestHash: sha256(request), responseHash: sha256(response), completionId: id,
    signature: signatureFor(model, request, response), attestation: { gateway_attestation: report(nonce, address),
      model_attestations: [report(nonce, address)] }, nonce, verdict: structuredClone(reply),
    startedAt: at, attestedAt: at, completedAt: at };
}

/**
 * A signed record that passes verifyEnclaveRecord, for tests that insert
 * 'enclave_ruling' events directly. readEnclaveRuling also requires the
 * material to be about the Bet: claim = its claim, deadline = its resolve_at,
 * postUrl = its evidence_source_url, and bets listing { id, termsHash } with its
 * id and terms_hash. Pass `material` to suit. agrees is computed by
 * readEnclaveRuling, not read from here. The price plan is the minute containing
 * the deadline, so madeAt must be no later than a minute after the deadline.
 */
export function enclaveRulingFixture({ outcome = 'yes', mode = 'ruling', source = 'coinbase-candles', models = JURORS,
  material: given = {}, agrees, minConfidence = 0.8, confidence: asked, outcomes,
  reason = 'The market data shows the price held above the level before the deadline.' } = {}) {
  const material = makeMaterial({ claim: 'BTC trades above $100,000 before 1 November 2026.',
    madeAt: '2026-10-01T12:00:00.000Z', deadline: '2026-11-01T00:00:00.000Z', postUrl: 'https://x.com/someone/status/1',
    bets: [{ id: '00000000-0000-4000-8000-000000000001', termsHash: 'a'.repeat(64) }], ...given });
  const deadline = Date.parse(material.deadline);
  const planned = new Date(deadline + 120_000).toISOString();
  // The price at the deadline: a moment plan, which the server turns into the minute containing it.
  const raw = source === 'coinbase-candles' ? { source, product: 'BTC-USD', kind: 'moment', at: material.deadline } : { source: 'evidence' };
  const plan = { ...attest(models[0], PLAN_PROMPT, planInput(material), raw, planned), parsed: checkPlan(raw, material) };
  let evidence;
  let now;
  if (source === 'coinbase-candles') {
    const segments = windowSegments(plan.parsed);
    const bodies = segments.map((segment) => {
      const rows = [];
      for (let at = Date.parse(segment.start); at < Date.parse(segment.end); at += segment.granularity * 1000) {
        rows.push([at / 1000, 99_000, 101_500, 100_000, 101_000, 3]);
      }
      return JSON.stringify(rows);
    });
    const { text } = candleEvidence(plan.parsed, bodies);
    now = new Date(deadline + 180_000).toISOString();
    evidence = { kind: 'coinbase-candles', urls: segments.map(candleUrl), fetchedAt: now, text, textHash: sha256(Buffer.from(text)) };
  } else {
    const closesAt = new Date(deadline + 86400_000).toISOString();
    now = new Date(Date.parse(closesAt) + 60_000).toISOString();
    evidence = submittedEvidence([{ id: 1, side: outcome === 'no' ? 'no' : 'yes', url: 'https://news.example.org/report',
      final_url: 'https://news.example.org/report', title: 'Report', body: 'The official report says it happened.',
      at: material.deadline, x_username: 'fixture_bettor' }], closesAt);
  }
  // outcomes: one outcome per model, for a jury that disagrees; confidence: every model's.
  const confidence = asked ?? (outcome === 'unclear' ? 0.4 : 0.95);
  const jury = juryPolicy(models, minConfidence);
  const verdicts = models.map((model, i) => {
    const reply = { outcome: outcomes?.[i] ?? outcome, confidence, reason };
    return { ...attest(model, VERDICT_PROMPT, verdictInput(material, now, jury, evidence.text, mode), reply, now), parsed: structuredClone(reply) };
  });
  const decided = decide(verdicts.map((v) => v.parsed), minConfidence);
  return { version: 1, mode, material, materialHash: materialHash(material), plan, evidence, jury, verdicts, outcome: decided,
    agrees: mode === 'review' && decided !== 'unclear' ? (agrees ?? true) : null, minConfidence, decidedAt: now };
}
