import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { canonicalJson, fingerprint } from '../src/canonical.mjs';
import { UserError } from '../src/store.mjs';
import { reservePlaySigner, withAvailablePlaySigner } from '../src/play.mjs';

const NOW = Date.parse('2026-11-13T12:00:00.000Z');
const ns = millis => (BigInt(millis) * 1000000n).toString();

// Run the production keeper and durable ledger with only DB/RPC boundaries replaced.
async function fixture({ status = 'accepted', budget = '1', evidence = [{ side: 'yes', url: 'https://www.sec.gov/release' }], ruling = {} } = {}) {
  const source = await readFile(new URL('../src/outlayer.mjs', import.meta.url), 'utf8');
  const body = source.replace(/^import .*?;\n/gm, '').replace(/^export \{.*?\};\n/gm, '').replace(/^export /gm, '');
  const warnings = [];
  const deps = { createHash, randomUUID, canonicalJson, fingerprint, UserError, reservePlaySigner, withAvailablePlaySigner,
    isNamedAccount: () => true, console: { warn(message) { warnings.push(message); } },
    syncNearBet: async () => bet, treasury: async () => ({ id: 'sponsor.testnet', secret: 'synthetic' }),
    verifyNearExecution: async () => { reconciled++; return { status: 'succeeded' }; } };
  const module = new Function(...Object.keys(deps), `${body}\nreturn {runOutlayerKeeper,outlayerTermsHash};`)(...Object.values(deps));
  const material = { bet_id: 'r7-keeper', claim: 'The release ships.', made_at: new Date(NOW - 3600000).toISOString(),
    deadline: new Date(NOW - 120000).toISOString(), post_url: 'https://www.sec.gov/release',
    evidence: { kind: 'open', window_seconds: 60, max_per_side: 2 } };
  const bet = { id: material.bet_id, creator_user_id: '1', status, claim: material.claim,
    resolve_at: material.deadline, terms_salt: 'a'.repeat(64), referee_wallet: 'ref.testnet',
    outlayer_material: material, chain_state: {} };
  bet.terms_hash = module.outlayerTermsHash(material, bet.terms_salt);
  const stored = { material_json: JSON.stringify(material), terms_hash: bet.terms_hash,
    stage: 'idle', outcome: null, nonce: '1', started_ns: '0', next_ns: '0',
    deadline_ns: ns(Date.parse(material.deadline)), evidence, failures: 0, admission_failures: 0,
    undecided: 0, accepted_nonce: null, last_error: null, ...ruling };
  const config = { nearContract: 'escrow.testnet', play: { enabled: true } };
  const requests = [], events = [], pauses = [], queries = [];
  let signed = 0, reconciled = 0, budgetReads = 0;
  const db = { tx: async fn => fn(db), many: async sql => {
    if (/select \* from bilateral_bets/.test(sql)) { queries.push(sql); return [bet]; }
    if (/outlayer_near_requests/.test(sql)) return [];
    throw Error(`Unexpected SQL: ${sql}`);
  }, one: async (sql, args = []) => {
    if (sql === 'select * from play_accounts where account_id = $1 for update') return null;
    if (/pg_try_advisory_lock/.test(sql)) return { locked: true };
    if (/select \* from users/.test(sql)) return { id: '1' };
    if (/select id from bilateral_bets/.test(sql)) return { id: bet.id };
    if (/select detail from bilateral_bet_events/.test(sql)) {
      const detail = /outlayer_compute_pause/.test(sql) ? pauses.at(-1) : events.at(-1);
      return detail ? { detail } : null;
    }
    if (/outlayer_near_requests/.test(sql)) {
      if (/count\(\*\)/.test(sql)) return { n: requests.length };
      if (/select updated_at/.test(sql)) return { updated_at: requests.at(-1)?.updated_at || new Date(NOW) };
      if (/^select/.test(sql.trim())) return requests.find(row => row.intent_key === args[/signer_account/.test(sql) ? 5 : 2]
        && (!/execution_status='pending'/.test(sql) || row.execution_status === 'pending')) || null;
      if (/insert/.test(sql)) {
        const row = { id: args[0], intent_key: args[8], execution_status: 'prepared', updated_at: new Date(NOW) };
        requests.push(row); return row;
      }
      if (/update/.test(sql)) {
        const row = requests.find(row => row.id === args[0]);
        Object.assign(row, { transaction_hash: args[1], signed_transaction: args[2], execution_status: 'pending' }); return row;
      }
    }
    throw Error(`Unexpected SQL: ${sql}`);
  }, query: async (sql, args = []) => {
    if (/insert into bilateral_bet_events/.test(sql)) (/outlayer_compute_pause/.test(sql) ? pauses : events).push(args[2]);
    if (/execution_status=\$2/.test(sql)) requests.find(row => row.id === args[0]).execution_status = args[1];
    return { rowCount: 1 };
  } };
  const chain = { view: async ({ method }) => {
    if (method === 'get_config') return { escrow: config.nearContract, timeout_seconds: 600 };
    if (method === 'get_ruling') return stored;
    if (method === 'get_compute_budget') { budgetReads++; return budget; }
    assert.fail(`Unexpected view ${method}`);
  }, prepareCall: async () => { signed++; return { hash: `hash-${signed}`, signedTransaction: 'synthetic' }; },
  broadcastCall: async () => ({}) };
  return { bet, ruling: stored, config, requests, events, pauses, queries, warnings,
    signed: () => signed, reconciled: () => reconciled, budgetReads: () => budgetReads,
    run: (now = NOW) => module.runOutlayerKeeper(db, config, { chain, now, fetchImpl: () => assert.fail('No network allowed') }) };
}

for (const status of ['settled', 'refunded']) {
  test(`terminal ${status} escrow closes an idle referee without reading compute budget`, async () => {
    const f = await fixture({ status, budget: '0' });
    assert.equal((await f.run()).errors, 0);
    assert.equal(f.signed(), 1);
    assert.equal(f.budgetReads(), 0);
    assert.ok(f.events.every(event => event.escrow_terminal));
  });
}

test('terminal selection excludes only referee settled snapshots', async () => {
  const f = await fixture({ status: 'refunded' }); await f.run();
  assert.doesNotMatch(f.queries[0], /in \('idle','settled'\)/);
  assert.match(f.queries[0], /coalesce\(e\.detail->'ruling'->>'stage','idle'\)\s*=\s*'settled'/);
});

for (const [name, ruling, now] of [
  ['evidence ready time', {}, NOW - 60001],
  ['next_ns', { next_ns: ns(NOW + 1) }, NOW],
  ['busy timeout', { stage: 'running', started_ns: ns(NOW - 599999) }, NOW],
]) {
  test(`terminal cleanup respects ${name}`, async () => {
    const f = await fixture({ status: 'refunded', budget: '0', ruling });
    assert.equal((await f.run(now)).errors, 0); assert.equal(f.signed(), 0);
  });
}

test('terminal timed-out referee retries when all timing gates permit', async () => {
  const f = await fixture({ status: 'settled', budget: '0', ruling: { stage: 'running', started_ns: ns(NOW - 600000) } });
  assert.equal((await f.run()).errors, 0); assert.equal(f.signed(), 1);
});

test('terminal cleanup retains daily cap and reconciles committed intents at the cap', async () => {
  const f = await fixture({ status: 'refunded', budget: '0' }); f.config.outlayer = { rulingDailyLimit: 0 };
  assert.match((await f.run()).results[0].error, /daily ruling limit/); assert.equal(f.signed(), 0);
  f.requests.push({ id: 'prior', intent_key: '1', execution_status: 'pending', transaction_hash: 'prior-hash',
    signed_transaction: 'synthetic', updated_at: new Date(NOW) });
  assert.equal((await f.run()).errors, 0); assert.equal(f.reconciled(), 1); assert.equal(f.signed(), 0);
});

test('settled referee has no new request even with a terminal escrow', async () => {
  const f = await fixture({ status: 'refunded', ruling: { stage: 'settled' } });
  assert.equal((await f.run()).errors, 0); assert.equal(f.signed(), 0);
});

test('Open evidence with no submissions refunds without compute', async () => {
  const f = await fixture({ evidence: [], budget: '0' });
  assert.equal((await f.run()).errors, 0); assert.equal(f.signed(), 1); assert.equal(f.budgetReads(), 0);
});

test('accepted unclear result resets cumulative failure backoff despite stale error text', async () => {
  const f = await fixture({ ruling: { failures: 2, last_error: 'Old failure' } });
  await f.run(); assert.equal(f.signed(), 0);
  f.ruling.failures = 3; await f.run(NOW + 1);
  Object.assign(f.ruling, { failures: 4, admission_failures: 2 }); await f.run(NOW + 2);
  assert.equal(f.pauses.at(-1).consecutive, 3);
  Object.assign(f.ruling, { accepted_nonce: '1', undecided: 1, next_ns: ns(NOW + 60000) });
  await f.run(NOW + 60000);
  assert.equal(f.signed(), 1, 'accepted progress clears the prior six-hour failure run');
  assert.equal(f.pauses.at(-1).consecutive, 0);
  Object.assign(f.ruling, { nonce: '2', failures: 5 });
  await f.run(NOW + 60001);
  assert.equal(f.pauses.at(-1).consecutive, 1, 'a subsequent real failure starts a fresh run');
});

test('older accepted unclear resets failure run after newer attempts were invalidated', async () => {
  const f = await fixture({ ruling: { nonce: '5', accepted_nonce: '2', undecided: 1, failures: 4,
    admission_failures: 1, last_error: 'Old failure' } });
  assert.equal((await f.run()).errors, 0); assert.equal(f.signed(), 1);
});

test('counter progress backs off failures without any error text and ignores error spelling changes', async () => {
  const f = await fixture({ ruling: { failures: 1 } });
  await f.run(); assert.equal(f.signed(), 0);
  f.ruling.last_error = 'Different diagnostic'; await f.run(NOW + 1);
  assert.equal(f.pauses.at(-1).consecutive, 1);
  Object.assign(f.ruling, { failures: 2, admission_failures: 1, nonce: '2', last_error: null });
  await f.run(NOW + 300001); assert.equal(f.signed(), 0);
  assert.equal(f.pauses.at(-1).consecutive, 2);
});

test('pricing attempts back off from nonce progress without relying on error messages', async () => {
  const f = await fixture(); await f.run(); assert.equal(f.signed(), 0);
  await f.run(NOW + 300001); assert.equal(f.signed(), 1);
  f.requests.at(-1).updated_at = new Date(NOW + 300001); f.ruling.nonce = '2';
  await f.run(NOW + 1800001); assert.equal(f.signed(), 1);
  assert.equal(f.pauses.at(-1).consecutive, 2);
});

test('missing Open evidence view does not infer a free refund', async () => {
  const f = await fixture({ evidence: undefined, budget: '0' });
  delete f.ruling.evidence;
  assert.equal((await f.run()).errors, 0); assert.equal(f.signed(), 0); assert.equal(f.budgetReads(), 1);
});

test('a fresh idle ruling ignores diagnostic text without a failed attempt', async () => {
  const f = await fixture({ ruling: { nonce: '0', last_error: 'Stale diagnostic' } });
  assert.equal((await f.run()).errors, 0); assert.equal(f.signed(), 1); assert.equal(f.pauses.length, 0);
});

test('invalid retry counters fail before signing', async () => {
  for (const ruling of [{ failures: -1 }, { admission_failures: 256 }, { undecided: 1.5 },
    { accepted_nonce: '2' }, { accepted_nonce: Number.MAX_SAFE_INTEGER + 1 }]) {
    const f = await fixture({ ruling });
    assert.match((await f.run()).results[0].error, /invalid retry counters/); assert.equal(f.signed(), 0);
  }
});

test('terminal cleanup validates the registered material before signing', async () => {
  const f = await fixture({ status: 'refunded', ruling: { terms_hash: 'invalid' } });
  assert.match((await f.run()).results[0].error, /does not match the funded terms/); assert.equal(f.signed(), 0);
});

test('observing a rejection after its delay warns once without persisting the warning flag', async () => {
  const f = await fixture({ ruling: { failures: 1 } });
  assert.equal((await f.run(NOW + 300001)).errors, 0);
  await f.run(NOW + 300002);
  assert.equal(f.warnings.length, 1);
  assert.ok(f.pauses.every(pause => !Object.hasOwn(pause, 'warn')));
});
