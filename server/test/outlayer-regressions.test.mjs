import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { InvalidNonceError, TransactionExpiredError } from 'near-api-js/rpc-errors';
import { canonicalJson, fingerprint } from '../src/canonical.mjs';
import { checkPlan, decide, materialHash } from '../src/enclave-ruling.mjs';
import { UserError } from '../src/store.mjs';
import { makeOutlayerMaterial } from '../src/outlayer.mjs';
import { parseBetCommand } from '../src/reply-bets.mjs';
import { outlayerTestFetch } from './support/outlayer-fetch.mjs';
import { walletPayload } from '../src/near-escrow.mjs';
import { assertMainnetStakeCap } from '../src/reputation.mjs';

// Execute the actual module with only its external boundaries replaced. This
// keeps durable-intent and keeper regressions runnable when PG cannot start.
async function sourceModule(name, dependencies, names) {
  const source = await readFile(process.env.STATED_TEST_SOURCE_ROOT ? `${process.env.STATED_TEST_SOURCE_ROOT}/${name}.mjs`
    : new URL(`../src/${name}.mjs`, import.meta.url), 'utf8');
  const body = source.replace(/^import .*?;\n/gm, '').replace(/^export \{.*?\};\n/gm, '').replace(/^export /gm, '');
  return new Function(...Object.keys(dependencies), `${body}\nreturn {${names.join(',')}};`)(...Object.values(dependencies));
}

const deps = { createHash, randomUUID, isIP, canonicalJson, fingerprint, checkPlan, decide, materialHash, UserError,
  InvalidNonceError, TransactionExpiredError, isNamedAccount: () => true };
const base = { id: 'test-bet', claim: 'The release ships.', madeAt: '2026-11-12T18:00:00.000Z',
  deadline: '2026-11-12T19:00:00.000Z', postUrl: 'https://www.sec.gov/release', creatorSide: 'yes', plan: { source: 'evidence' } };

test('OutLayer evidence accepts public news and release URLs under the contract policy', async () => {
  const { evidenceUrl } = await sourceModule('outlayer', deps, ['evidenceUrl']);
  for (const url of ['https://reuters.com/story', 'https://github.com/team/releases', 'HTTPS://WWW.NASA.GOV./news',
    'https://bücher.de/news', 'https://www.sec.gov/release']) assert.equal(evidenceUrl(url), url);
});

test('OutLayer evidence rejects every forbidden URL spelling before signing', async () => {
  const { evidenceUrl } = await sourceModule('outlayer', deps, ['evidenceUrl']);
  for (const url of ['https://www.sec.gov:443/a', 'https://www.sec.gov/a\u0000',
    'http://reuters.com/a', 'https://reuters.com:443/a', 'https://u@reuters.com/a',
    'https://@reuters.com/a', 'https://reuters.com/a#', 'https://reuters.com/a#part',
    'https://%72euters.com/a', 'https://localhost/a', 'https://host/a', 'https://host.local/a',
    'https://host.internal/a', 'https://host.intranet/a', 'https://host.lan/a', 'https://host.home/a',
    'https://host.onion/a', 'https://host.test/a', 'https://host.invalid/a', 'https://host.arpa/a',
    'https://x.com/a', 'https://news.twitter.com./a', 'https://127.1/a', 'https://[::1]/a',
    'https://-bad.com/a', 'https://bad_.com/a', 'https://a.c/a', 'https://reuters.com/a\u0000',
    'https://reuters.com/a\\b', `https://reuters.com/${'a'.repeat(600)}`,
    `https://reuters.com/${'é'.repeat(110)}`]) assert.throws(() => evidenceUrl(url), UserError, url);
});

test('new Open evidence windows use configuration and refuse more than three days', () => {
  const config = seconds => ({ play: { evidenceWindowSeconds: seconds } });
  assert.equal(makeOutlayerMaterial(base, config(120), { supports_open_evidence: true }).evidence.window_seconds, 120);
  assert.equal(makeOutlayerMaterial(base, config(259200), { supports_open_evidence: true }).evidence.window_seconds, 259200);
  for (const seconds of [0, -1, 259201, 604800, 1.5, NaN]) {
    assert.throws(() => makeOutlayerMaterial(base, config(seconds), { supports_open_evidence: true }), UserError);
  }
});

test('Coinbase ranges exclude candles before the later post and bet creation time', () => {
  for (const madeAt of ['2026-11-12T17:00:00.000Z', '2026-11-12T18:20:30.000Z']) {
    const material = makeOutlayerMaterial({ ...base, madeAt, createdAt: '2026-11-12T18:15:30.000Z',
      plan: { source: 'coinbase-candles', product: 'NEAR-USD', kind: 'range', start: madeAt, end: base.deadline } }, {}, {});
    const floor = Math.max(Date.parse(madeAt), Date.parse('2026-11-12T18:15:30.000Z'));
    assert.ok(Date.parse(material.made_at) >= floor);
    assert.ok(Date.parse(material.evidence.window.start) >= floor);
    assert.equal(Date.parse(material.evidence.window.start) % 60000, 0);
  }
});

function intentDb(row) {
  const state = { ...row };
  const db = { state,
    tx: async fn => fn(db),
    one: async (sql, args) => {
      if (/pg_try_advisory_lock/.test(sql)) return { locked: true };
      if (/select id from bilateral_bets/.test(sql)) return { id: 'test-bet' };
      if (/select \* from outlayer_near_requests/.test(sql)) return { ...state };
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    query: async (sql, args) => {
      if (/execution_status=\$2/.test(sql)) state.execution_status = args[1];
      if (/execution_status='failed'/.test(sql)) state.execution_status = 'failed';
      return { rowCount: 1 };
    },
  };
  return db;
}

for (const [label, rejection] of [['nonce used', () => new InvalidNonceError(20, 19)],
  ['expired', () => new TransactionExpiredError()]]) {
  test(`OutLayer retries a previously broadcast intent when ${label} and RPC proves it unknown`, async () => {
    const db = intentDb({ id: 'intent', transaction_hash: 'hash', signed_transaction: 'bytes', execution_status: 'pending',
      broadcast_started_at: new Date(0) });
    db.tx = async fn => fn(db);
    const { persistentCall } = await sourceModule('outlayer', { ...deps,
      verifyNearExecution: async () => ({ status: 'pending' }),
      rpc: async () => { throw Object.assign(new Error('Unknown transaction'), { rpcCause: 'UNKNOWN_TRANSACTION' }); },
    }, ['persistentCall']);
    const result = await persistentCall(db, { prepareCall: () => assert.fail('must reuse signed bytes'),
      broadcastCall: async () => { throw rejection(); } }, { id: 'test-bet', referee_wallet: 'ref.testnet' },
    { id: 'sponsor.testnet', secret: 'synthetic' }, 'request_ruling', {}, '0', '300000000000000', () => assert.fail('no live fetch'));
    assert.equal(result.execution_status, 'failed');
    assert.equal(db.state.execution_status, 'failed');
  });
}

test('OutLayer never retires an ambiguous intent during an RPC outage', async () => {
  const db = intentDb({ id: 'intent', transaction_hash: 'hash', signed_transaction: 'bytes', execution_status: 'pending',
    broadcast_started_at: new Date(0) });
  db.tx = async fn => fn(db);
  const { persistentCall } = await sourceModule('outlayer', { ...deps,
    verifyNearExecution: async () => ({ status: 'pending' }), rpc: async () => { throw new Error('HTTP 429'); },
  }, ['persistentCall']);
  const result = await persistentCall(db, { prepareCall() {}, broadcastCall: async () => { throw new InvalidNonceError(20, 19); } },
    { id: 'test-bet', referee_wallet: 'ref.testnet' }, { id: 'sponsor.testnet' }, 'request_ruling', {}, '0', '300000000000000');
  assert.equal(result.execution_status, 'pending');
  assert.equal(db.state.execution_status, 'pending');
});

test('bound database calls acquire the shared OutLayer signer lock', async () => {
  const db = intentDb({ id: 'intent', execution_status: 'succeeded' });
  db.tx = async fn => fn(db);
  const queries = [];
  const one = db.one;
  db.one = async (sql, args) => { queries.push([sql, args]); return one(sql, args); };
  const { persistentCall } = await sourceModule('outlayer', deps, ['persistentCall']);
  await persistentCall(db, { prepareCall() {}, broadcastCall() {} }, { id: 'test-bet', referee_wallet: 'ref.testnet' },
    { id: 'sponsor.testnet' }, 'register_material', {}, '1', '100000000000000');
  assert.ok(queries.some(([sql, args]) => /pg_try_advisory_lock/.test(sql) && args[0] === 'outlayer-signer:sponsor.testnet'));
});

async function keeperFixture({ status = 'accepted', ruling = null, lastRequestAt = new Date(), clock = Date.now(), budget = '1' } = {}) {
  const warnings = [];
  const module = await sourceModule('outlayer', { ...deps,
    syncNearBet: async (_db, _config, _user, _id, options) => { assert.equal(options.skipOutlayerRegistration, true); return bet; },
    treasury: async () => ({ id: 'sponsor.testnet', secret: 'synthetic' }),
    verifyNearExecution: async () => ({ status: 'succeeded' }),
    console: { warn: message => warnings.push(message) },
  }, ['runOutlayerKeeper', 'outlayerTermsHash', 'ensureOutlayerRegistration', 'submitOutlayerEvidence']);
  const material = { bet_id: 'test-bet', claim: base.claim, made_at: new Date(clock - 3600000).toISOString(),
    deadline: new Date(clock - 120000).toISOString(), post_url: base.postUrl,
    evidence: { kind: 'open', window_seconds: 60, max_per_side: 2 } };
  const bet = { id: 'test-bet', creator_user_id: '1', acceptor_user_id: '2', creator_wallet: 'alice.testnet',
    status, claim: base.claim, resolve_at: material.deadline, terms_salt: 'a'.repeat(64), outlayer_material: material,
    referee_wallet: 'ref.testnet', chain_state: { creator: 'alice.testnet', acceptor: 'bob.testnet' } };
  bet.terms_hash = module.outlayerTermsHash(material, bet.terms_salt);
  const config = { nearContract: 'escrow.testnet', play: { enabled: true } };
  const view = { escrow: config.nearContract, supports_open_evidence: true };
  const stored = ruling ? { material_json: JSON.stringify(material), terms_hash: bet.terms_hash,
    stage: 'idle', outcome: null, nonce: '0', started_ns: '0', next_ns: '0',
    deadline_ns: (BigInt(Date.parse(material.deadline)) * 1000000n).toString(), ...ruling } : null;
  const events = []; const requests = []; const pauses = []; let signed = 0;
  const db = {
    tx: async fn => fn(db),
    many: async sql => {
      if (/select \* from bilateral_bets/.test(sql)) return [bet];
      if (/outlayer_near_requests/.test(sql)) return [];
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    one: async (sql, args) => {
      if (/pg_try_advisory_lock/.test(sql)) return { locked: true };
      if (/select \* from users/.test(sql)) return { id: '1' };
      if (/select id from bilateral_bets/.test(sql)) return { id: bet.id };
      if (/select detail from bilateral_bet_events/.test(sql)) {
        if (/outlayer_compute_pause/.test(sql)) return pauses.at(-1) ? { detail: pauses.at(-1) } : null;
        return events.at(-1) ? { detail: events.at(-1) } : null;
      }
      if (/outlayer_near_requests/.test(sql)) {
        if (/count\(\*\)/.test(sql)) return { n: requests.length };
        if (/^select/.test(sql.trim()) && /execution_status='pending'/.test(sql)) {
          return requests.find(row => row.intent_key === args[2] && row.execution_status === 'pending') || null;
        }
        if (/select/.test(sql)) return /updated_at/.test(sql) ? { updated_at: requests.at(-1)?.updated_at || lastRequestAt }
          : requests.find(row => row.intent_key === args[5]) || null;
        if (/insert/.test(sql)) { const row = { id: args[0], execution_status: 'prepared', intent_key: args[8], updated_at: new Date(clock) }; requests.push(row); return row; }
        if (/update/.test(sql)) return { ...requests.at(-1), transaction_hash: args[1], signed_transaction: args[2], execution_status: 'pending' };
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    query: async (sql, args) => {
      if (/insert into bilateral_bet_events/.test(sql)) {
        if (/outlayer_compute_pause/.test(sql)) pauses.push(args[2]);
        else events.push(args[2]);
      }
      if (/execution_status=\$2/.test(sql)) requests.find(row => row.id === args[0]).execution_status = args[1];
      return { rowCount: 1 };
    },
  };
  const chain = { view: async ({ method }) => {
    if (method === 'get_config') return view;
    if (method === 'get_ruling') return stored;
    if (method === 'get_compute_budget') return budget;
    throw new Error(`Unexpected method: ${method}`);
  }, prepareCall: async () => { signed++; return { hash: 'hash', signedTransaction: 'bytes' }; }, broadcastCall: async () => ({}) };
  return { module, bet, ruling: stored, config, chain, db, events, requests, pauses, warnings,
    setBudget: value => { budget = value; }, signed: () => signed };
}

test('offered escrows never spend sponsor registration deposits from sync or keeper entry points', async () => {
  const f = await keeperFixture({ status: 'offered' });
  assert.equal(await f.module.ensureOutlayerRegistration(f.db, f.config, f.chain, f.bet), null);
  assert.equal((await f.module.runOutlayerKeeper(f.db, f.config, { chain: f.chain })).errors, 0);
  assert.equal(f.signed(), 0);
});

test('syncNearBet registers only accepted escrow terms and never a funded offer', async () => {
  for (const status of ['offered', 'accepted']) {
    let registrations = 0;
    const acceptBy = '2026-11-12T18:30:00.000Z'; const resolveAt = base.deadline;
    const chain = { id: 'test-bet', status, creator: 'alice.testnet', creator_binding_hash: 'a'.repeat(64),
      ...(status === 'accepted' ? { acceptor: 'bob.testnet', acceptor_binding_hash: 'b'.repeat(64) } : {}),
      terms_hash: 'c'.repeat(64), stake_yocto: '1', creator_side: 'yes', referee: 'ref.testnet',
      accept_by_ns: (BigInt(Date.parse(acceptBy)) * 1000000n).toString(), resolve_at_ns: (BigInt(Date.parse(resolveAt)) * 1000000n).toString() };
    const bet = { id: chain.id, status, creator_user_id: '1', acceptor_user_id: status === 'accepted' ? '2' : null,
      outlayer_material: {}, terms_hash: chain.terms_hash, stake_yocto: '1', creator_side: 'yes', referee_wallet: chain.referee,
      chain_state: chain, accept_by: acceptBy, resolve_at: resolveAt };
    const db = { tx: async fn => fn(db), query: async () => ({}), one: async sql => {
      if (/select \* from bilateral_bets/.test(sql)) return bet;
      if (/method = 'create_bet'/.test(sql)) return { user_id: '1', wallet_account: chain.creator };
      if (/method = 'accept_bet'/.test(sql)) return { user_id: '2', wallet_account: chain.acceptor };
      throw new Error(`Unexpected SQL: ${sql}`);
    } };
    const { syncNearBet } = await sourceModule('near-bets', { fingerprint, UserError, isAccount: () => true,
      isNamedAccount: () => true, betFor: async () => bet, viewEscrowSnapshot: async () => ({ value: chain, blockHeight: '1' }),
      ensureOutlayerRegistration: async () => { registrations++; }, nearChain: () => ({}),
    }, ['syncNearBet']);
    await syncNearBet(db, { nearContract: 'escrow.testnet' }, { id: '1' }, bet.id);
    assert.equal(registrations, status === 'accepted' ? 1 : 0, status);
  }
});

test('keeper respects referee next_ns for idle pricing retries', async () => {
  const now = Date.now();
  const f = await keeperFixture({ clock: now, ruling: { last_error: 'Compute estimate unavailable, over cap or pool underfunded',
    next_ns: (BigInt(now + 600000) * 1000000n).toString() } });
  assert.equal((await f.module.runOutlayerKeeper(f.db, f.config, { chain: f.chain, now })).errors, 0);
  assert.equal(f.signed(), 0);
  f.setBudget('2');
  await f.module.runOutlayerKeeper(f.db, f.config, { chain: f.chain, now: now + 300001 });
  assert.equal(f.signed(), 0);
});

test('keeper respects next_ns after a busy timeout', async () => {
  const now = Date.now();
  const f = await keeperFixture({ clock: now, ruling: { stage: 'running', started_ns: '0',
    next_ns: (BigInt(now + 600000) * 1000000n).toString() } });
  await f.module.runOutlayerKeeper(f.db, f.config, { chain: f.chain, now: now + 300001 });
  assert.equal(f.signed(), 0);
  await f.module.runOutlayerKeeper(f.db, f.config, { chain: f.chain, now: now + 600001 });
  assert.equal(f.signed(), 1);
});

test('keeper retries an unchanged nonzero compute pool with bounded backoff and warns once', async () => {
  const now = Date.now();
  const f = await keeperFixture({ clock: now, lastRequestAt: new Date(now), budget: '11000000000000000000000',
    ruling: { nonce: '1', last_error: 'Compute estimate unavailable, over cap or pool underfunded' } });
  await f.module.runOutlayerKeeper(f.db, f.config, { chain: f.chain, now });
  await f.module.runOutlayerKeeper(f.db, f.config, { chain: f.chain, now: now + 299999 });
  assert.equal(f.signed(), 0);
  await f.module.runOutlayerKeeper(f.db, f.config, { chain: f.chain, now: now + 300001 });
  assert.equal(f.signed(), 1);
  f.requests.at(-1).updated_at = new Date(now + 300001);
  f.ruling.nonce = '2';
  await f.module.runOutlayerKeeper(f.db, f.config, { chain: f.chain, now: now + 2100000 });
  assert.equal(f.signed(), 1);
  await f.module.runOutlayerKeeper(f.db, f.config, { chain: f.chain, now: now + 2100002 });
  assert.equal(f.signed(), 2);
  f.requests.at(-1).updated_at = new Date(now + 2100002);
  f.ruling.nonce = '3';
  await f.module.runOutlayerKeeper(f.db, f.config, { chain: f.chain, now: now + 2100002 + 21599999 });
  assert.equal(f.signed(), 2);
  await f.module.runOutlayerKeeper(f.db, f.config, { chain: f.chain, now: now + 2100002 + 21600001 });
  assert.equal(f.signed(), 3);
  assert.equal(f.warnings.length, 1);
  assert.match(f.warnings[0], /ref\.testnet|compute pool/i);
});

test('keeper backs off repeated idle failures using counters outside the known pricing message', async () => {
  const now = Date.now();
  const f = await keeperFixture({ clock: now, lastRequestAt: new Date(now), budget: '1',
    ruling: { nonce: '1', failures: 1, last_error: 'Pricing service unavailable' } });
  await f.module.runOutlayerKeeper(f.db, f.config, { chain: f.chain, now });
  assert.equal(f.signed(), 0);
  await f.module.runOutlayerKeeper(f.db, f.config, { chain: f.chain, now: now + 300001 });
  assert.equal(f.signed(), 1);
  f.requests.at(-1).updated_at = new Date(now + 300001);
  f.ruling.nonce = '2';
  f.ruling.failures = 2;
  await f.module.runOutlayerKeeper(f.db, f.config, { chain: f.chain, now: now + 1800001 });
  assert.equal(f.signed(), 1);
});

test('keeper backs off consecutive identical pricing rejections', async () => {
  const now = Date.now();
  const f = await keeperFixture({ clock: now, lastRequestAt: new Date(now), budget: '1',
    ruling: { nonce: '1', last_error: 'Compute estimate unavailable, over cap or pool underfunded' } });
  await f.module.runOutlayerKeeper(f.db, f.config, { chain: f.chain, now });
  f.setBudget('2');
  await f.module.runOutlayerKeeper(f.db, f.config, { chain: f.chain, now: now + 299999 });
  assert.equal(f.signed(), 0);
  await f.module.runOutlayerKeeper(f.db, f.config, { chain: f.chain, now: now + 300001 });
  assert.equal(f.signed(), 1);
  f.requests.at(-1).updated_at = new Date(now + 300001);
  f.ruling.nonce = '2';
  f.setBudget('3');
  await f.module.runOutlayerKeeper(f.db, f.config, { chain: f.chain, now: now + 1800000 });
  assert.equal(f.signed(), 1);
  await f.module.runOutlayerKeeper(f.db, f.config, { chain: f.chain, now: now + 2100002 });
  assert.equal(f.signed(), 2);
});

test('empty compute pool warns once but does not block refund-floor recovery', async () => {
  const now = Date.now();
  const f = await keeperFixture({ clock: now, budget: '0', ruling: { stage: 'idle' } });
  for (const offset of [0, 300001, 21600001]) {
    const result = await f.module.runOutlayerKeeper(f.db, f.config, { chain: f.chain, now: now + offset });
    assert.equal(result.results[0].status, 'compute_unfunded');
  }
  assert.equal(f.signed(), 0);
  assert.equal(f.warnings.length, 1);
  await f.module.runOutlayerKeeper(f.db, f.config, { chain: f.chain, now: now + 7 * 86400000 });
  assert.equal(f.signed(), 1, 'request_ruling remains available to trigger the escrow refund floor');
});

test('keeper reconciles a signed pending ruling intent despite an empty compute pool', async () => {
  const f = await keeperFixture({ budget: '0', ruling: { stage: 'idle', last_error: 'Compute estimate unavailable, over cap or pool underfunded' } });
  f.requests.push({ id: 'prior', intent_key: '0', execution_status: 'pending', transaction_hash: 'old-hash',
    signed_transaction: 'signed-bytes', updated_at: new Date() });
  const result = await f.module.runOutlayerKeeper(f.db, f.config, { chain: f.chain });
  assert.equal(result.errors, 0);
  assert.equal(f.requests[0].execution_status, 'succeeded');
  assert.equal(f.requests.length, 1);
  assert.equal(f.signed(), 0);
  assert.equal(f.warnings.length, 0);
});

test('ruling intent ledger caps new sends at twelve per bet per UTC day and recovers prior intent', async () => {
  const { persistentCall } = await sourceModule('outlayer', { ...deps,
    verifyNearExecution: async () => ({ status: 'succeeded' }) }, ['persistentCall']);
  const rows = []; let signed = 0;
  const db = { tx: async fn => fn(db), one: async (sql, args = []) => {
    if (/select id from bilateral_bets/.test(sql)) return { id: 'test-bet' };
    if (/count\(\*\)/.test(sql)) return { n: rows.length };
    if (/select \* from outlayer_near_requests/.test(sql)) return rows.find(row => row.intent_key === args[5]) || null;
    if (/insert into outlayer_near_requests/.test(sql)) {
      const row = { id: args[0], intent_key: args[8], execution_status: 'pending' }; rows.push(row); return row;
    }
    if (/update outlayer_near_requests/.test(sql)) {
      const row = rows.find(value => value.id === args[0]);
      Object.assign(row, { transaction_hash: args[1], signed_transaction: args[2] }); return row;
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  }, query: async (sql, args) => {
    if (/execution_status=\$2/.test(sql)) rows.find(row => row.id === args[0]).execution_status = args[1];
    return { rowCount: 1 };
  } };
  const chain = { prepareCall: async () => ({ hash: `hash-${++signed}`, signedTransaction: 'synthetic' }),
    broadcastCall: async () => {} };
  const bet = { id: 'test-bet', referee_wallet: 'ref.testnet' };
  const signer = { id: 'sponsor.testnet', secret: 'synthetic' };
  const send = nonce => persistentCall(db, chain, bet, signer, 'request_ruling', { bet_id: bet.id }, '0', '300000000000000',
    null, { signerLocked: true, attemptKey: String(nonce), rulingDailyLimit: 12 });
  for (let nonce = 0; nonce < 12; nonce++) await send(nonce);
  await assert.rejects(send(12), /daily ruling limit/);
  await send(0);
  assert.equal(rows.length, 12);
  assert.equal(signed, 12);
});

for (const ruling of [null, { stage: 'idle' }, { stage: 'running' }]) {
  test(`terminal keeper snapshots preserve an ${ruling?.stage || 'absent'} ruling with an escrow terminal marker`, async () => {
    const f = await keeperFixture({ status: 'refunded', ruling });
    const result = await f.module.runOutlayerKeeper(f.db, f.config, { chain: f.chain });
    assert.equal(result.errors, 0);
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0].escrow_terminal, true);
    assert.equal(f.events[0].ruling?.stage || null, ruling?.stage || null);
  });
}

test('managed evidence releases its account transaction before signing and broadcasting', async () => {
  const now = Date.now();
  const f = await keeperFixture({ clock: now + 90000, ruling: { stage: 'idle' } });
  let depth = 0;
  const managed = { ready: true, account_id: 'alice.testnet', claimed_at: null };
  f.db.tx = async fn => { depth++; try { return await fn(f.db); } finally { depth--; } };
  const originalOne = f.db.one;
  f.db.one = async (sql, args) => {
    if (/play_accounts.*for update/.test(sql)) { assert.equal(depth, 1); return managed; }
    return originalOne(sql, args);
  };
  const { submitOutlayerEvidence } = await sourceModule('outlayer', { ...deps,
    syncNearBet: async () => f.bet, playAccountFor: async () => managed,
    secretOf: () => 'synthetic', verifyNearExecution: async () => ({ status: 'succeeded' }),
  }, ['submitOutlayerEvidence']);
  const prepare = f.chain.prepareCall;
  f.chain.prepareCall = async input => { assert.equal(depth, 0, 'account transaction committed before signing'); return prepare(input); };
  f.chain.broadcastCall = async () => { assert.equal(depth, 0, 'account transaction committed before RPC'); };
  const result = await submitOutlayerEvidence(f.db, f.config, f.chain, f.bet, { id: '1', x_user_id: 'alice' },
    { url: 'https://www.sec.gov/release' });
  assert.equal(result.status, 'succeeded');
});

test('public Reuters and GitHub evidence reach the referee submission payload unchanged', async () => {
  const f = await keeperFixture({ clock: Date.now() + 90000, ruling: { stage: 'idle' } });
  const { submitOutlayerEvidence } = await sourceModule('outlayer', { ...deps, walletPayload,
    syncNearBet: async () => f.bet, playAccountFor: async () => null,
    reserveNearRequest: async (_db, input) => ({ request: { id: 'request', method: input.method, args: input.args }, reused: false }),
  }, ['submitOutlayerEvidence']);
  for (const url of ['https://reuters.com/story', 'https://github.com/team/releases']) {
    const result = await submitOutlayerEvidence(f.db, f.config, f.chain, f.bet, { id: '1' }, { url });
    assert.equal(result.payload.contract, f.bet.referee_wallet);
    assert.equal(result.payload.method, 'submit_evidence');
    assert.deepEqual(result.args, { bet_id: f.bet.id, url });
  }
});

test('refused X evidence commands enqueue one short refusal reply', async () => {
  const replies = []; const statuses = [];
  const cmd = { event_id: 'command', x_user_id: 'alice', attempts: 1, side: 'yes', url: 'https://x.com/post' };
  const db = { tx: async fn => fn(db),
    many: async sql => /returning \*/.test(sql) ? [cmd] : [{ event_id: cmd.event_id }],
    one: async () => null,
    query: async (sql, args) => { if (/detail = \$3/.test(sql)) statuses.push(args[1]); return { rowCount: 0 }; } };
  const { runEvidenceCommands } = await sourceModule('bet-evidence', {
    UserError, createHash, randomUUID, say: async (_db, _config, reply) => replies.push(reply),
  }, ['runEvidenceCommands']);
  assert.equal((await runEvidenceCommands(db, { outlayer: { referee: 'ref.testnet' } })).refused, 1);
  assert.deepEqual(statuses, ['refused']);
  assert.equal(replies.length, 1);
  assert.equal(replies[0].inReplyTo, cmd.event_id);
  assert.match(replies[0].body, /Not a bettor/);
});

test('OutLayer recognizes invalid evidence links as commands so the worker can refuse them on X', () => {
  for (const url of ['https://x.com/post', 'http://reuters.com/story', 'https://www.sec.gov:443/a']) {
    assert.deepEqual(parseBetCommand(`@statedbot yes ${url}`, { outlayer: true }), { kind: 'evidence', side: 'yes', url });
  }
  assert.equal(parseBetCommand('@statedbot yes https://x.com/post'), null, 'legacy parser stays unchanged');
});

test('OutLayer test transport permits local FakeX OAuth and refuses unrelated network calls', async () => {
  const seen = [];
  const fetchImpl = outlayerTestFetch({ ai: { fetchImpl: () => assert.fail('not inference') },
    near: () => ({ fetchImpl: () => assert.fail('not NEAR') }), xBase: () => 'http://127.0.0.1:1234',
    localFetch: async (url, init) => { seen.push([url, init]); return new Response('connected'); } });
  const init = { method: 'POST', body: 'synthetic-code' };
  assert.equal(await (await fetchImpl('http://127.0.0.1:1234/2/oauth2/token', init)).text(), 'connected');
  assert.deepEqual(seen, [['http://127.0.0.1:1234/2/oauth2/token', init]]);
  assert.throws(() => fetchImpl('https://api.x.com/2/oauth2/token'), /Unexpected test fetch/);
});

test('OutLayer criteria bind the displayed claim and jury material while retries retain the original fingerprint', async () => {
  const at = new Date(); const events = []; let row; const plans = [];
  const user = { id: '1', kind: 'person', setup_completed_at: at };
  const db = { tx: async fn => fn(db),
    one: async (sql) => {
      if (/select id, kind, setup_completed_at/.test(sql)) return user;
      if (/count\(\*\)::int/.test(sql)) return { n: 0 };
      if (/where creator_user_id/.test(sql) || /select b\.\*, creator/.test(sql)) return row || null;
      if (/select detail/.test(sql)) return { detail: events[0] };
      if (/clock_timestamp\(\) as at/.test(sql)) return { at };
      throw new Error(`Unexpected SQL: ${sql}`);
    }, many: async () => [],
    query: async (sql, args) => {
      if (/insert into bilateral_bets/.test(sql)) row = { id: args[0], creator_user_id: args[1], claim: args[4], criteria: args[5],
        resolve_at: args[10], terms_hash: args[11], terms_salt: args[14], referee_wallet: args[16], status: 'offered' };
      else if (/update bilateral_bets/.test(sql)) row.outlayer_material = args[1];
      else if (/insert into bilateral_bet_events/.test(sql)) events.push(args[3]);
      else throw new Error(`Unexpected SQL: ${sql}`);
    } };
  const { outlayerTermsHash } = await import('../src/outlayer.mjs');
  const { createBet } = await sourceModule('bets', { createHash, randomUUID, assertMainnetStakeCap, checkPlan,
    randomBytes: (await import('node:crypto')).randomBytes, isIP, UserError, idOf: String,
    parseTestNear: () => '100000000000000000000000', isAccount: () => true,
    network: () => ({ id: 'testnet' }), unit: () => 'test NEAR', makeOutlayerMaterial, outlayerTermsHash,
    planForOutlayerCreation: async (_db, _config, plan) => { plans.push(plan); return { verdict: { source: 'evidence' } }; },
  }, ['createBet']);
  const config = { outlayer: { referee: 'ref.testnet' }, nearContract: 'escrow.testnet' };
  const chain = { view: async ({ method, args }) => method === 'get_config'
    ? { escrow: config.nearContract, supports_open_evidence: true } : outlayerTermsHash(args.material, args.salt) };
  const input = { requestId: randomUUID(), claim: 'The release ships.', criteria: 'Only the signed stable release counts.',
    creatorSide: 'yes', stakeNear: '0.1', evidenceSourceUrl: base.postUrl,
    acceptBy: new Date(+at + 600000).toISOString(), resolveAt: new Date(+at + 1200000).toISOString() };
  const created = await createBet(db, user, input, { config, chain });
  assert.equal(created.claim, `${input.claim}\n\nCounts as yes:\n${input.criteria}`);
  assert.equal(created.outlayer_material.claim, created.claim);
  assert.equal(plans[0].claim, created.claim, 'plan parser receives the complete committed claim and criteria');
  assert.equal((await createBet(db, user, input, { config, chain })).terms_hash, created.terms_hash);
  await assert.rejects(createBet(db, user, { ...input, criteria: 'Different condition.' }, { config, chain }), /different terms/);
});
