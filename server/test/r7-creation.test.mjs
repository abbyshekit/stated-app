import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { createBet } from '../src/bets.mjs';
import { loadConfig } from '../src/config.mjs';
import { outlayerTermsHash } from '../src/outlayer.mjs';
import { betTerms } from '../src/bet-view.mjs';
import { UserError } from '../src/store.mjs';
import { enclaveEnv, fakeNearAi } from './support/enclave.mjs';

const NOW = Date.parse('2026-11-13T12:00:20.123Z');
const HOUR = 3600000;
const iso = value => new Date(value).toISOString();
const user = { id: '1', x_user_id: '70001', x_username: 'founder', kind: 'person', setup_completed_at: new Date(NOW) };

function fixture(plan, overrides = {}) {
  const input = { requestId: randomUUID(), claim: 'NEAR above $3 at the end of day tomorrow.',
    criteria: 'Coinbase NEAR-USD price decides.', evidenceSourceUrl: 'https://x.com/founder/status/123',
    creatorSide: 'yes', stakeNear: '0.1', acceptBy: iso(NOW + 30 * HOUR),
    resolveAt: '2026-11-14T23:59:00.000Z', ...overrides };
  const state = { row: null, created: null, replies: [], accounts: 0, now: NOW };
  const cmd = { event_id: 'reply-123', kind: 'bet', x_user_id: user.x_user_id, x_username: user.x_username,
    save_id: '9', words: input.claim, side: 'yes', stake_near: '0.1', attempts: 1 };
  const db = {
    tx: fn => fn(db),
    one: async sql => {
      if (/update bet_commands set updated_at/.test(sql)) return cmd;
      if (/select st.status/.test(sql)) return { status: 'open', deadline: input.resolveAt, url: input.evidenceSourceUrl };
      if (/select exclude/.test(sql)) return null;
      if (/from saves s join enclave_plans/.test(sql)) return null;
      if (/where s.id =/.test(sql)) return { available: true, status: 'open', published_at: new Date(NOW) };
      if (/select id, kind/.test(sql)) return user;
      if (/request_id =/.test(sql)) return state.row;
      if (/select detail/.test(sql)) return { detail: state.created };
      if (/clock_timestamp\(\) as at/.test(sql)) return { at: new Date(state.now) };
      if (/count\(\*\)/.test(sql)) return { n: 0 };
      if (/join users creator/.test(sql)) return state.row;
      throw new Error(`Unexpected read: ${sql}`);
    },
    many: async sql => /from bet_commands/.test(sql) ? [cmd] : [],
    query: async (sql, p) => {
      if (/insert into bilateral_bets/.test(sql)) state.row = { id: p[0], creator_user_id: p[1], claim: p[4], criteria: p[5],
        evidence_source_url: p[6], creator_side: p[7], stake_yocto: p[8], accept_by: p[9], resolve_at: p[10],
        terms_hash: p[11], status: 'offered', chain_state: {} };
      if (/outlayer_material=/.test(sql)) state.row.outlayer_material = p[1];
      if (/insert into bilateral_bet_events/.test(sql)) state.created = p[3];
      if (/insert into bot_outbox/.test(sql)) state.replies.push(p[2]);
    },
  };
  const ai = fakeNearAi({ respond: () => typeof plan === 'function' ? plan(input) : plan });
  const config = loadConfig({ ...enclaveEnv, STATED_REQUIRE_GPU_EVIDENCE: '0',
    STATED_NEAR_CONTRACT: 'escrow.testnet', STATED_OUTLAYER_REFEREE: 'jury.testnet' });
  const chain = { view: async ({ method, args }) => {
    if (method === 'get_config') return { escrow: config.nearContract, supports_open_evidence: true };
    if (method === 'terms_hash') return outlayerTermsHash(args.material, args.salt);
    assert.fail(method);
  } };
  const options = { config, chain, fetchImpl: ai.fetchImpl };
  return { input, state, db, cmd, ai, config, chain, options };
}

// Keep the real X command processing, offer construction and createBet. Replace
// account/funding/publication boundaries so this reproducer never sends a call.
async function reply(f) {
  const source = await readFile(new URL('../src/reply-bets.mjs', import.meta.url), 'utf8');
  const body = source.replace(/^import .*?;\n/gm, '').replace(/^export /gm, '');
  const deps = { createHash, createBet, UserError, userByXId: async () => user, inPilot: () => true,
    assertMainnetStakeCap: () => {}, assertStakeLimit: async () => {}, stakeCapReply: () => 'cap',
    requireCreationReferee: () => {}, ensurePlayAccount: async () => { f.state.accounts++; },
    syncNearBet: async () => f.state.row, publishBet: async () => {},
    network: () => ({ real: false }), unit: () => 'test NEAR', formatTestNear: () => '0.1', dayMonth: () => '14 Nov 2026' };
  const run = new Function(...Object.keys(deps), `${body}\nreturn runBetCommands;`)(...Object.values(deps));
  return run(f.db, f.config, f.chain, { fetchImpl: f.ai.fetchImpl });
}

for (const surface of ['web terms', 'X reply']) {
  for (const kind of ['moment', 'range']) {
    test(`${surface}: Coinbase ${kind} closes acceptance in 24h and preserves its price window`, async t => {
      t.mock.timers.enable({ apis: ['Date'], now: NOW });
      const f = fixture(input => ({ source: 'coinbase-candles', product: 'NEAR-USD', kind,
        ...(kind === 'moment' ? { at: input.resolveAt } : { start: iso(NOW), end: input.resolveAt }) }));
      if (surface === 'X reply') assert.equal((await reply(f)).done, 1);
      else await createBet(f.db, user, f.input, f.options);
      const bet = f.state.row;
      assert.equal(bet.accept_by, iso(NOW + 24 * HOUR));
      assert.equal(bet.outlayer_material.evidence.kind, 'coinbase');
      assert.deepEqual(bet.outlayer_material.evidence.window, kind === 'moment'
        ? { kind, at: f.input.resolveAt }
        : { kind, start: '2026-11-14T12:01:00.000Z', end: f.input.resolveAt });
      if (surface === 'web terms') {
        assert.equal((await createBet(f.db, user, f.input, f.options)).terms_hash, bet.terms_hash);
        assert.equal(f.ai.seen.plans.length, 1, 'retry reuses the original commitment');
      }
    });
  }
  test(`${surface}: a near moment uses moment minus 1h and refuses less than 10m to accept`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    const make = minutes => fixture(input => ({ source: 'coinbase-candles', product: 'NEAR-USD', kind: 'moment', at: input.resolveAt }),
      { resolveAt: iso(NOW + minutes * 60000), acceptBy: iso(NOW + (minutes - 1) * 60000) });
    const allowed = make(70);
    if (surface === 'X reply') assert.equal((await reply(allowed)).done, 1);
    else await createBet(allowed.db, user, allowed.input, allowed.options);
    assert.equal(allowed.state.row.accept_by, iso(NOW + 10 * 60000));
    const refused = make(69);
    if (surface === 'X reply') {
      assert.deepEqual(await reply(refused), { done: 0, refused: 1, retry: 0, failed: 0 });
      assert.match(refused.state.replies[0], /10 minutes/i);
      assert.equal(refused.state.accounts, 0);
    } else await assert.rejects(createBet(refused.db, user, refused.input, refused.options), /10 minutes/i);
    assert.equal(refused.state.row, null);
  });
  test(`${surface}: refuses a range with under 1h of complete candles after acceptance`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    const f = fixture(input => ({ source: 'coinbase-candles', product: 'NEAR-USD', kind: 'range', start: iso(NOW), end: input.resolveAt }),
      { resolveAt: '2026-11-13T12:59:00.000Z', acceptBy: '2026-11-13T12:58:00.000Z' });
    if (surface === 'X reply') {
      assert.deepEqual(await reply(f), { done: 0, refused: 1, retry: 0, failed: 0 });
      assert.match(f.state.replies[0], /one hour/i);
      assert.equal(f.state.accounts, 0);
    } else await assert.rejects(createBet(f.db, user, f.input, f.options), /one hour/i);
    assert.equal(f.state.row, null);
  });
  test(`${surface}: a near range closes one hour before its own end`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    const end = '2026-11-13T14:00:00.000Z';
    const f = fixture({ source: 'coinbase-candles', product: 'NEAR-USD', kind: 'range', start: iso(NOW), end },
      { resolveAt: '2026-11-13T15:00:00.000Z', acceptBy: '2026-11-13T14:59:00.000Z' });
    if (surface === 'X reply') assert.equal((await reply(f)).done, 1);
    else await createBet(f.db, user, f.input, f.options);
    assert.equal(f.state.row.accept_by, '2026-11-13T13:00:00.000Z');
    assert.deepEqual(f.state.row.outlayer_material.evidence.window,
      { kind: 'range', start: '2026-11-13T13:00:00.000Z', end });
  });
  test(`${surface}: a moment earlier than the supplied acceptance date uses its own clock`, async t => {
    t.mock.timers.enable({ apis: ['Date'], now: NOW });
    const at = '2026-11-14T09:00:00.000Z';
    const f = fixture({ source: 'coinbase-candles', product: 'NEAR-USD', kind: 'moment', at });
    if (surface === 'X reply') assert.equal((await reply(f)).done, 1);
    else await createBet(f.db, user, f.input, f.options);
    assert.equal(f.state.row.accept_by, '2026-11-14T08:00:00.000Z');
    assert.deepEqual(f.state.row.outlayer_material.evidence.window, { kind: 'moment', at });
  });
}

for (const sourceSaveId of [null, '9']) {
  test(`X context URL is accepted without commitment (sourceSaveId=${sourceSaveId})`, async () => {
    const f = fixture({ source: 'evidence' }, { sourceSaveId });
    const bet = await createBet(f.db, user, f.input, f.options);
    assert.equal(bet.outlayer_material.evidence.kind, 'open');
    assert.equal(bet.outlayer_material.post_url, f.input.evidenceSourceUrl);
    assert.equal(bet.evidence_source_url, f.input.evidenceSourceUrl);
  });
}

test('Coinbase evidence takes priority over a supplied web URL, which is shown as context', async () => {
  const f = fixture(input => ({ source: 'coinbase-candles', product: 'NEAR-USD', kind: 'moment', at: input.resolveAt }),
    { evidenceSourceUrl: 'https://www.coinbase.com/price/near-protocol' });
  const bet = await createBet(f.db, user, f.input, f.options);
  assert.equal(bet.outlayer_material.evidence.kind, 'coinbase');
  assert.equal(bet.outlayer_material.post_url, f.input.evidenceSourceUrl);
  assert.match(String(betTerms(bet)), /Context link/);
  assert.doesNotMatch(String(betTerms(bet)), /jury reads the agreed source/);
});

test('non-price web terms keep the chosen acceptance deadline and Submitted evidence', async () => {
  const f = fixture({ source: 'evidence' }, { evidenceSourceUrl: 'https://www.sec.gov/newsroom' });
  const bet = await createBet(f.db, user, f.input, f.options);
  assert.equal(bet.accept_by, f.input.acceptBy);
  assert.deepEqual(bet.outlayer_material.evidence, { kind: 'submitted', items: [{ side: 'yes', url: f.input.evidenceSourceUrl }] });
  assert.match(String(betTerms(bet)), /Agreed source/);
});

test('non-price X reply keeps its deadline-minus-minute acceptance rule', async t => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const f = fixture({ source: 'evidence' });
  assert.equal((await reply(f)).done, 1);
  assert.equal(f.state.row.accept_by, iso(Date.parse(f.input.resolveAt) - 60000));
});

test('range starts at rounded acceptance even if the planner proposed a later start', async () => {
  const f = fixture(input => ({ source: 'coinbase-candles', product: 'NEAR-USD', kind: 'range',
    start: '2026-11-14T18:00:00.000Z', end: input.resolveAt }));
  const bet = await createBet(f.db, user, f.input, f.options);
  assert.equal(bet.outlayer_material.evidence.window.start, '2026-11-14T12:01:00.000Z');
});

test('slow planning cannot save a moment offer with less than ten minutes left to accept', async () => {
  const f = fixture(input => {
    f.state.now += 60000;
    return { source: 'coinbase-candles', product: 'NEAR-USD', kind: 'moment', at: input.resolveAt };
  }, { resolveAt: iso(NOW + 70 * 60000), acceptBy: iso(NOW + 60 * 60000) });
  await assert.rejects(createBet(f.db, user, f.input, f.options), /10 minutes/);
  assert.equal(f.state.row, null);
});

test('slow planning refuses a range whose derived acceptance deadline has elapsed', async () => {
  const f = fixture(input => {
    f.state.now += HOUR;
    return { source: 'coinbase-candles', product: 'NEAR-USD', kind: 'range', start: iso(NOW), end: input.resolveAt };
  }, { resolveAt: iso(NOW + 90 * 60000), acceptBy: iso(NOW + 60 * 60000) });
  await assert.rejects(createBet(f.db, user, f.input, f.options), { reason: 'price_range' });
  assert.equal(f.state.row, null);
});

for (const host of ['twitter.com', 'www.x.com.']) {
  test(`${host} source is context even without a save`, async () => {
    const f = fixture({ source: 'evidence' }, { evidenceSourceUrl: `https://${host}/founder/status/123` });
    const bet = await createBet(f.db, user, f.input, f.options);
    assert.equal(bet.outlayer_material.evidence.kind, 'open');
  });
}
