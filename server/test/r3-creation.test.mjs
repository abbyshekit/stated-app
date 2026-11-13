import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createBet } from '../src/bets.mjs';
import { loadConfig } from '../src/config.mjs';
import { outlayerTermsHash } from '../src/outlayer.mjs';
import { enclaveEnv, fakeNearAi } from './support/enclave.mjs';

function database() {
  const state = { depth: 0, row: null, created: null };
  const db = { state,
    tx: async fn => { state.depth++; try { return await fn(db); } finally { state.depth--; } },
    one: async sql => {
      if (/select id, kind/.test(sql)) return { id: '1', kind: 'person', setup_completed_at: new Date() };
      if (/request_id =/.test(sql)) return state.row;
      if (/select detail/.test(sql)) return { detail: state.created };
      if (/clock_timestamp\(\) as at/.test(sql)) return { at: new Date() };
      if (/count\(\*\)/.test(sql)) return { n: 0 };
      if (/join users creator/.test(sql)) return state.row;
      throw new Error(`Unexpected read: ${sql}`);
    },
    many: async () => [],
    query: async (sql, p) => {
      if (/insert into bilateral_bets/.test(sql)) state.row = { id: p[0], creator_user_id: p[1],
        claim: p[4], criteria: p[5], terms_hash: p[11], status: 'offered' };
      if (/outlayer_material=/.test(sql)) state.row.outlayer_material = p[1];
      if (/insert into bilateral_bet_events/.test(sql)) state.created = p[3];
    },
  };
  return db;
}

async function creation(check, overrides = {}) {
  const db = database();
  const input = { requestId: randomUUID(), claim: 'The release ships.', criteria: 'The official page publishes version 2.',
    evidenceSourceUrl: 'https://www.sec.gov/newsroom', creatorSide: 'yes', stakeNear: '0.1',
    acceptBy: new Date(Date.now() + 3600000).toISOString(), resolveAt: new Date(Date.now() + 7200000).toISOString(), ...overrides };
  const ai = fakeNearAi({ respond: call => { check({ kind: 'plan', db, call, input }); return { source: 'evidence' }; } });
  const config = loadConfig({ ...enclaveEnv, STATED_REQUIRE_GPU_EVIDENCE: '0',
    STATED_NEAR_CONTRACT: 'escrow.testnet', STATED_OUTLAYER_REFEREE: 'jury.testnet' });
  const chain = { view: async ({ method, args }) => {
    check({ kind: method, db, input });
    if (method === 'get_config') return { escrow: config.nearContract, supports_open_evidence: true };
    if (method === 'terms_hash') return outlayerTermsHash(args.material, args.salt);
    assert.fail(method);
  } };
  const user = { id: '1', kind: 'person', setup_completed_at: new Date() };
  return { result: await createBet(db, user, input, { config, chain, fetchImpl: ai.fetchImpl }), db, input, ai };
}

test('creation planner and chain views run outside database transactions', async () => {
  const seen = [];
  await creation(({ kind, db }) => { seen.push(kind); assert.equal(db.state.depth, 0, kind); });
  assert.deepEqual(seen, ['get_config', 'plan', 'terms_hash']);
});

test('creation plans the combined claim and criteria that the jury receives', async () => {
  const { result, ai, input } = await creation(() => {});
  const combined = `${input.claim}\n\nCounts as yes:\n${input.criteria}`;
  assert.equal(ai.seen.plans[0].input.claim, combined);
  assert.equal(result.outlayer_material.claim, combined);
});

test('creation commits the chosen source URL as Submitted even on Open-capable referees', async () => {
  const { result, input } = await creation(() => {});
  assert.deepEqual(result.outlayer_material.evidence, { kind: 'submitted', items: [{ side: 'yes', url: input.evidenceSourceUrl }] });
});

test('full-length bettor input fits the migrated committed claim constraint and referee material', async () => {
  const { result } = await creation(() => {}, { claim: '界'.repeat(1000), criteria: '界'.repeat(2000) });
  assert.equal(result.outlayer_material.claim, result.claim);
  const schema = await readFile(new URL('../src/schema.sql', import.meta.url), 'utf8');
  const limits = [...schema.matchAll(/check\s*\(length\(claim\) between 1 and (\d+)\)/g)];
  assert.ok(result.claim.length <= Number(limits.at(-1)[1]), 'persisted committed text exceeds the database claim constraint');
  assert.match(schema, /alter table bilateral_bets drop constraint if exists bilateral_bets_claim_check/i,
    'existing installations need an explicit migration');
  const referee = await readFile(new URL('../../contracts/outlayer-referee/src/lib.rs', import.meta.url), 'utf8');
  const max = Number(referee.match(/const MAX_MATERIAL: usize = ([\d_]+)/)[1].replaceAll('_', ''));
  assert.ok(Buffer.byteLength(JSON.stringify(result.outlayer_material)) <= max);
});

test('bettor claim limit stays at 1000 before planning', async () => {
  let plans = 0;
  await assert.rejects(creation(({ kind }) => { if (kind === 'plan') plans++; }, { claim: 'a'.repeat(1001) }), /1000 characters/);
  assert.equal(plans, 0);
});

test('oversized escaped combined text gets a clear error before planning', async () => {
  let plans = 0;
  await assert.rejects(creation(({ kind }) => { if (kind === 'plan') plans++; },
    { claim: '\u0001'.repeat(1000), criteria: '\u0001'.repeat(2000) }), /claim and criteria together.*too long.*shorten/i);
  assert.equal(plans, 0);
});
