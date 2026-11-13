import test from 'node:test';
import assert from 'node:assert/strict';
import * as rulings from '../src/enclave-ruling.mjs';
import { loadConfig } from '../src/config.mjs';
import { enclaveRulingFixture, fakeNearAi, enclaveEnv } from './support/enclave.mjs';

const material = { claim: 'NEAR above US$3.30 on Coinbase', madeAt: '2026-11-12T18:00:00.000Z',
  deadline: '2026-11-12T19:15:00.000Z', postUrl: 'https://x.com/ChainAbstracted/status/2120000000000000000' };
const config = loadConfig({ ...enclaveEnv, STATED_REQUIRE_GPU_EVIDENCE: '0' });

test('OutLayer creation reuses the stored server plan without another planner call', async () => {
  const record = enclaveRulingFixture({ material }).plan;
  const db = { one: async (sql, args) => {
    assert.match(sql, /enclave_plans/);
    assert.deepEqual(args, ['123']);
    return { record };
  } };
  const plan = await rulings.planForOutlayerCreation(db, config, material, {
    sourceSaveId: '123', fetchImpl: () => assert.fail('stored plan must not call the model'),
  });
  assert.deepEqual(plan, record);
});

test('OutLayer creation plans unknown material exactly once and keeps the checked product and window', async () => {
  const raw = { source: 'coinbase-candles', product: 'SOL-USD', kind: 'range',
    start: '2026-11-12T18:30:00.000Z', end: material.deadline };
  const ai = fakeNearAi({ respond: ({ kind }) => { assert.equal(kind, 'plan'); return raw; } });
  const plan = await rulings.planForOutlayerCreation({ one: () => assert.fail('no source to look up') }, config,
    material, { fetchImpl: ai.fetchImpl });
  assert.equal(ai.seen.plans.length, 1);
  assert.deepEqual(plan.verdict, raw);
  assert.deepEqual(plan.parsed, rulings.checkPlan(raw, material));
});

test('OutLayer creation never reuses a server plan for different claim or dates', async () => {
  for (const changed of [{ claim: 'Different claim' }, { deadline: '2026-11-12T19:00:00.000Z' },
    { madeAt: '2026-11-12T17:00:00.000Z' }, { postUrl: 'https://www.sec.gov/report' }]) {
    const record = enclaveRulingFixture({ material: { ...material, ...changed } }).plan;
    const ai = fakeNearAi({ respond: () => ({ source: 'evidence' }) });
    const plan = await rulings.planForOutlayerCreation({ one: async () => ({ record }) }, config, material,
      { sourceSaveId: '123', fetchImpl: ai.fetchImpl });
    assert.equal(ai.seen.plans.length, 1);
    assert.deepEqual(plan.parsed, { source: 'evidence' });
  }
});
