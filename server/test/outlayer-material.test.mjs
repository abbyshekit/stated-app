import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { outlayerTermsHash, makeOutlayerMaterial, outlayerReadyAt, readOutlayerRuling } from '../src/outlayer.mjs';
import { materialHash } from '../src/enclave-ruling.mjs';
import { outlayerDetail, outlayerRulingBody } from '../src/outlayer-pages.mjs';
import { rulingOnEvidence } from '../src/settlement-view.mjs';
import { loadConfig } from '../src/config.mjs';

const base = { id: '3668aa04-7009-4b85-b19d-debfabebbf96', claim: 'NEAR above US$3.30 on Coinbase',
  madeAt: '2026-11-12T18:00:00.000Z', deadline: '2026-11-12T19:15:00.000Z',
  postUrl: 'https://x.com/ChainAbstracted/status/2120000000000000000' };
const config = { play: { evidenceWindowSeconds: 86400 } };
const pricePlan = { source: 'coinbase-candles', product: 'NEAR-USD', kind: 'moment', at: base.deadline };

test('OutLayer material commits the supplied planner decision and never Auto or empty Submitted', () => {
  const price = makeOutlayerMaterial({ ...base, plan: pricePlan }, config, {});
  assert.equal(price.evidence.product, 'NEAR-USD');
  assert.equal(price.evidence.window.kind, 'moment');
  assert.equal(outlayerReadyAt(price), Date.parse(base.deadline) + 120000);
  const range = makeOutlayerMaterial({ ...base, plan: { source: 'coinbase-candles', product: 'BTC-USD',
    kind: 'range', start: base.madeAt, end: base.deadline } }, config, {});
  assert.equal(range.evidence.window.kind, 'range');
  for (const claim of ['Nightjar ships.', 'NEAR above $3 tomorrow', 'NEAR above $3 and ETH above $5',
    'NEAR validators earn over US$3 in rewards', 'The NEAR Foundation gives grants worth US$3 million']) {
    const input = { ...base, claim, plan: { source: 'evidence' }, postUrl: 'https://www.sec.gov/newsroom', creatorSide: 'no' };
    assert.deepEqual(makeOutlayerMaterial(input, config, {}).evidence,
      { kind: 'submitted', items: [{ side: 'no', url: input.postUrl }] });
    assert.deepEqual(makeOutlayerMaterial(input, { play: { evidenceWindowSeconds: 120 } }, { supports_open_evidence: true }).evidence,
      { kind: 'open', window_seconds: 120, max_per_side: 2 });
  }
  assert.throws(() => makeOutlayerMaterial(base, config, {}), /plan/i);
  assert.throws(() => makeOutlayerMaterial({ ...base, plan: { source: 'evidence' }, creatorSide: 'yes' }, config,
    { supports_open_evidence: 'true' }), /HTTPS link/);
  // A model's selected product and window override the old text heuristic.
  const chosen = { ...pricePlan, product: 'SOL-USD', at: '2026-11-12T19:00:00.000Z' };
  assert.deepEqual(makeOutlayerMaterial({ ...base, plan: chosen }, config, {}).evidence,
    { kind: 'coinbase', product: chosen.product, window: { kind: 'moment', at: chosen.at } });
});

test('OutLayer material follows the server checked plan when a product falls back to evidence', () => {
  const material = makeOutlayerMaterial({ ...base, plan: { ...pricePlan, product: 'NEAR-EUR' } }, config,
    { supports_open_evidence: true });
  assert.deepEqual(material.evidence, { kind: 'open', window_seconds: 86400, max_per_side: 2 });
});

test('commitment is key-order independent and binds every material field and salt', () => {
  const material = makeOutlayerMaterial({ ...base, plan: pricePlan }, config, {});
  const salt = 'c'.repeat(64);
  const expected = outlayerTermsHash(material, salt);
  assert.equal(outlayerTermsHash(Object.fromEntries(Object.entries(material).reverse()), salt), expected);
  for (const [key, value] of Object.entries(material)) {
    const changed = typeof value === 'string' ? value + 'x' : { kind: 'auto' };
    assert.notEqual(outlayerTermsHash({ ...material, [key]: changed }, salt), expected, key);
  }
  assert.notEqual(outlayerTermsHash(material, 'd'.repeat(64)), expected);
  assert.throws(() => outlayerTermsHash(material, 'C'.repeat(64)), /salt/);
});

test('OutLayer ruling links disclose unreadable reasons and final URLs, including same-host redirects', () => {
  for (const kind of ['submitted', 'open']) {
    const bet = { id: base.id, outlayer: { referee: 'ref.testnet', config: {}, ruling: { stage: 'settled', outcome: 'no' },
      result: { outcome: 'no', verdicts: [], evidence_summary: { kind, items: [
        { side: 'yes', url: 'https://www.sec.gov/unavailable', textHash: 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855', unreadable: 'HTTP 404 <script>bad</script>' },
        { side: 'no', url: 'https://www.sec.gov/final', postedUrl: 'https://www.sec.gov/posted', textHash: 'a'.repeat(64) },
      ] } } } };
    const page = String(outlayerRulingBody(bet, ''));
    assert.match(page, /could not be read/);
    assert.match(page, /HTTP 404 &lt;script&gt;bad&lt;\/script&gt;/);
    assert.match(page, /href="https:\/\/www.sec.gov\/posted"/);
    assert.match(page, /Read from[\s\S]*href="https:\/\/www.sec.gov\/final"/);
    assert.doesNotMatch(page, /<script>/);
    bet.outlayer.result.evidence_summary.items.push({ side: 'yes', url: 'javascript:bad()', postedUrl: 'javascript:worse()', unreadable: '<img onerror="bad">' });
    assert.doesNotMatch(String(outlayerRulingBody(bet, '')), /href="javascript:|<img onerror/);
  }
});

test('server-built Open material matches the shared terms_hash vector', () => {
  const vectors = JSON.parse(readFileSync(new URL('./fixtures/outlayer-terms-vectors.json', import.meta.url), 'utf8'));
  const vector = vectors.find(item => item.material.evidence.kind === 'open');
  assert.ok(vector, 'an Open vector must be consumed by the existing Rust test');
  const m = vector.material;
  const built = makeOutlayerMaterial({ id: m.bet_id, claim: m.claim, madeAt: m.made_at, deadline: m.deadline,
    postUrl: m.post_url, plan: { source: 'evidence' } }, config, { supports_open_evidence: true });
  assert.deepEqual(built, m);
  assert.equal(outlayerTermsHash(built, vector.salt), vector.hash);
});

test('OutLayer account validation follows the selected NEAR network', () => {
  assert.equal(loadConfig({ STATED_OUTLAYER_REFEREE: 'ref.testnet' }).outlayer.referee, 'ref.testnet');
  for (const value of ['ref.near', 'Bad.testnet', 'bad..testnet', 'a']) assert.throws(
    () => loadConfig({ STATED_OUTLAYER_REFEREE: value }), /STATED_OUTLAYER_REFEREE/);
  assert.equal(loadConfig({ STATED_NEAR_NETWORK: 'mainnet', STATED_OUTLAYER_REFEREE: 'ref.near' }).outlayer.referee, 'ref.near');
  loadConfig({});
});

test('OutLayer pages escape provenance and eligibility requires actual evidence', () => {
  const bet = { id: base.id, outlayer: { referee: 'ref.testnet', config: { wasm_hash: '<script>evil</script>',
    wasm_url: 'javascript:evil()' }, ruling: { stage: 'settled', outcome: 'yes' },
    material: { evidence: { kind: 'open' } }, result: { outcome: 'yes', verdicts: [
      { model: 'Qwen/Qwen3.8-27B', outcome: 'yes', confidence: 0.9 },
      { model: 'deepseek-ai/DeepSeek-V4.1-Flash-1017', outcome: 'yes', confidence: 0.9 },
      { model: 'z-ai/glm-5.3-flash', outcome: 'yes', confidence: 0.9 }], evidence_summary: { kind: 'submitted', items: [] } } } };
  const page = String(outlayerDetail(bet));
  assert.match(page, /OutLayer enclave/);
  assert.equal((page.match(/90% sure/g) || []).length, 3);
  assert.doesNotMatch(page, /<script>|javascript:evil/);
  assert.equal(rulingOnEvidence(bet), false);
  bet.outlayer.result.evidence_summary.items.push({ url: 'https://www.sec.gov/' });
  assert.equal(rulingOnEvidence(bet), true);
});

test('JavaScript commitment matches the captured Rust terms_hash vectors', () => {
  const vectors = JSON.parse(readFileSync(new URL('./fixtures/outlayer-terms-vectors.json', import.meta.url), 'utf8'));
  assert.ok(vectors.length >= 3);
  for (const vector of vectors) assert.equal(outlayerTermsHash(vector.material, vector.salt), vector.hash);
});

test('ruling projection rejects substituted material, result hash, roster and decision', async () => {
  const vector = JSON.parse(readFileSync(new URL('./fixtures/outlayer-terms-vectors.json', import.meta.url), 'utf8'))[0];
  const material = vector.material;
  const result = { bet_id: material.bet_id, terms_hash: vector.hash, outcome: 'yes',
    material_hash: materialHash({ claim: material.claim, madeAt: material.made_at, deadline: material.deadline,
      postUrl: material.post_url, bets: [{ id: material.bet_id, termsHash: vector.hash }] }),
    evidence_summary: { priceAtMoment: 3.4206 }, verdicts: ['Qwen/Qwen3.8-27B','deepseek-ai/DeepSeek-V4.1-Flash-1017','z-ai/glm-5.3-flash']
      .map(model => ({ model, outcome: 'yes', confidence: 0.9 })) };
  const row = { id: material.bet_id, claim: material.claim, resolve_at: material.deadline,
    terms_hash: vector.hash, terms_salt: vector.salt, referee_wallet: 'ref.testnet', outlayer_material: material,
    recorded_at: material.deadline, detail: { referee: 'ref.testnet', config: { escrow: 'escrow.testnet' },
      ruling: { material_json: JSON.stringify(material), terms_hash: vector.hash, deadline_ns: (BigInt(Date.parse(material.deadline)) * 1000000n).toString(),
        started_ns: '0', next_ns: '0', nonce: 1, stage: 'settled', outcome: 'yes', result } } };
  const read = value => readOutlayerRuling({ one: async () => value }, material.bet_id);
  assert.equal((await read(row)).result.verdicts.length, 3);
  for (const change of [
    value => { value.claim += '?'; },
    value => { value.detail.ruling.result.material_hash = '0'.repeat(64); },
    value => { value.detail.ruling.result.verdicts.reverse(); },
    value => { value.detail.ruling.result.verdicts[0].confidence = 0.79; },
    value => { value.detail.ruling.result.terms_hash = '0'.repeat(64); },
  ]) {
    const changed = structuredClone(row); change(changed);
    assert.equal(await read(changed), null);
  }
});
