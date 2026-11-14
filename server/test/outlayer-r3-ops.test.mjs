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
import { loadConfig } from '../src/config.mjs';
import { reservePlaySigner, withAvailablePlaySigner } from '../src/play.mjs';

// Exercise the production module with only transport/database boundaries replaced.
async function sourceModule(dependencies = {}, names = []) {
  const source = await readFile(new URL('../src/outlayer.mjs', import.meta.url), 'utf8');
  const body = source.replace(/^import .*?;\n/gm, '').replace(/^export \{.*?\};\n/gm, '').replace(/^export /gm, '');
  const deps = { createHash, randomUUID, isIP, canonicalJson, fingerprint, checkPlan, decide, materialHash, reservePlaySigner, withAvailablePlaySigner,
    UserError, InvalidNonceError, TransactionExpiredError, isNamedAccount: () => true, ...dependencies };
  return new Function(...Object.keys(deps), `${body}\nreturn {${names.join(',')}};`)(...Object.values(deps));
}

const base = { id: 'test-bet', claim: 'NEAR trades above US$3.', madeAt: '2026-11-12T18:00:00.000Z',
  createdAt: '2026-11-12T18:00:30.000Z', acceptBy: '2026-11-12T18:30:30.000Z',
  deadline: '2026-11-12T19:00:00.000Z', postUrl: 'https://x.com/person/status/123', creatorSide: 'yes' };
const range = { source: 'coinbase-candles', product: 'NEAR-USD', kind: 'range', start: base.madeAt, end: base.deadline };

test('ruling send limit defaults to twelve and accepts zero as a pause', () => {
  assert.equal(loadConfig({}).outlayer.rulingDailyLimit, 12);
  assert.equal(loadConfig({ STATED_OUTLAYER_RULING_DAILY_LIMIT: '0' }).outlayer.rulingDailyLimit, 0);
  for (const value of ['', '-1', '1.5', '1e2', '9007199254740992']) {
    assert.throws(() => loadConfig({ STATED_OUTLAYER_RULING_DAILY_LIMIT: value }), /STATED_OUTLAYER_RULING_DAILY_LIMIT/);
  }
});

test('Coinbase range starts at the first complete minute after acceptance closes', () => {
  const material = makeOutlayerMaterial({ ...base, plan: range }, {}, {});
  assert.equal(material.evidence.window.start, '2026-11-12T18:31:00.000Z');
  assert.throws(() => makeOutlayerMaterial({ ...base, acceptBy: base.deadline, plan: range }, {}, {}), /range/i);
});

test('Coinbase moment minute must be strictly later than acceptBy and creation', () => {
  for (const [acceptBy, at] of [[base.acceptBy, '2026-11-12T18:30:59.000Z'],
    ['2026-11-12T18:31:00.000Z', '2026-11-12T18:31:59.000Z']]) {
    assert.throws(() => makeOutlayerMaterial({ ...base, acceptBy,
      plan: { ...range, kind: 'moment', at } }, {}, {}), /accept|moment/i);
  }
  assert.throws(() => makeOutlayerMaterial({ ...base, acceptBy: 'bad', plan: range }, {}, {}));
  assert.equal(makeOutlayerMaterial({ ...base, plan: { ...range, kind: 'moment', at: base.deadline } }, {}, {}).evidence.kind, 'coinbase');
});

test('chosen non-price source remains Submitted and price plans retain Coinbase evidence', () => {
  const evidenceSourceUrl = 'https://www.sec.gov/release';
  assert.deepEqual(makeOutlayerMaterial({ ...base, evidenceSourceUrl, plan: { source: 'evidence' } }, {},
    { supports_open_evidence: true }).evidence, { kind: 'submitted', items: [{ side: 'yes', url: evidenceSourceUrl }] });
  assert.equal(makeOutlayerMaterial({ ...base, evidenceSourceUrl, plan: range }, {},
    { supports_open_evidence: true }).evidence.kind, 'coinbase');
  assert.throws(() => makeOutlayerMaterial({ ...base, evidenceSourceUrl: base.postUrl, plan: { source: 'evidence' } }, {},
    { supports_open_evidence: true }), /HTTPS link/);
  assert.equal(makeOutlayerMaterial({ ...base, plan: { source: 'evidence' } }, {},
    { supports_open_evidence: true }).evidence.kind, 'open');
});

async function registrationFixture({ stake = '100000000000000000000000', config = {}, registered = false } = {}) {
  const material = { bet_id: base.id, claim: base.claim, made_at: base.madeAt, deadline: base.deadline,
    post_url: base.postUrl, evidence: { kind: 'open', window_seconds: 86400, max_per_side: 2 } };
  const module = await sourceModule({ verifyNearExecution: async () => ({ status: 'succeeded' }) },
    ['ensureOutlayerRegistration', 'outlayerTermsHash', 'persistentCall', 'recordSettlement', 'submitOutlayerEvidence', 'runOutlayerKeeper']);
  const bet = { id: base.id, creator_user_id: '1', acceptor_user_id: '2', creator_wallet: 'alice.near', status: 'accepted',
    claim: material.claim, resolve_at: material.deadline, stake_yocto: stake, terms_salt: 'a'.repeat(64),
    outlayer_material: material, referee_wallet: 'ref.near', chain_state: { creator: 'alice.near', acceptor: 'bob.near' } };
  bet.terms_hash = module.outlayerTermsHash(material, bet.terms_salt);
  const ruling = { material_json: JSON.stringify(material), terms_hash: bet.terms_hash, stage: 'idle', outcome: null,
    nonce: '0', started_ns: '0', next_ns: '0', deadline_ns: (BigInt(Date.parse(material.deadline)) * 1000000n).toString() };
  const rows = []; const events = []; const calls = []; const locks = [];
  const db = { tx: async fn => fn(db), many: async () => [],
    one: async (sql, args = []) => {
      if (sql === 'select * from play_accounts where account_id = $1 for update') return null;
      if (/pg_try_advisory_lock/.test(sql)) return { locked: true };
      if (/pg_advisory_xact_lock/.test(sql)) { locks.push(args[0]); return {}; }
      if (/select id from bilateral_bets/.test(sql)) return { id: bet.id };
      if (/count\(/.test(sql)) return { n: rows.length };
      if (/select detail from bilateral_bet_events/.test(sql)) return null;
      if (/select \* from outlayer_near_requests/.test(sql)) return rows.find(row => row.bet_id === args[0]) || null;
      if (/insert into outlayer_near_requests/.test(sql)) {
        const row = { id: args[0], bet_id: args[1], execution_status: 'pending', args: args[5] }; rows.push(row); return row;
      }
      if (/update outlayer_near_requests/.test(sql)) {
        const row = rows.find(row => row.id === args[0]); Object.assign(row, { transaction_hash: args[1], signed_transaction: args[2] }); return row;
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    }, query: async (sql, args) => {
      if (/execution_status=\$2/.test(sql)) rows.find(row => row.id === args[0]).execution_status = args[1];
      if (/insert into bilateral_bet_events/.test(sql)) events.push(args[2]);
      return { rowCount: 1 };
    } };
  const chain = { view: async ({ method }) => method === 'get_config' ? { escrow: 'escrow.near', supports_open_evidence: true }
    : registered ? ruling : null,
  prepareCall: async input => { calls.push(input); return { hash: `hash${calls.length}`, signedTransaction: 'synthetic' }; },
  broadcastCall: async () => { registered = true; } };
  return { module, bet, ruling, rows, events, calls, locks, db, chain,
    config: { near: { real: true }, nearContract: 'escrow.near', play: { treasury: 'sponsor.near', treasuryKey: 'synthetic' }, ...config } };
}

test('dust legacy mainnet bets cannot spend sponsored registration storage', async () => {
  const f = await registrationFixture({ stake: '1' });
  await assert.rejects(f.module.ensureOutlayerRegistration(f.db, f.config, f.chain, f.bet), /minimum|0\.1/);
  assert.equal(f.calls.length, 0);
});

test('registration allowance is reserved durably before signing and caps each account at five', async () => {
  const f = await registrationFixture();
  for (let i = 0; i < 6; i++) {
    const bet = { ...f.bet, id: `bet-${i}` };
    const options = { signerLocked: true, registrationLimit: 5 };
    const call = () => f.module.persistentCall(f.db, f.chain, bet, { id: 'sponsor.near' }, 'register_material', {}, '1', '1', null, options);
    if (i < 5) await call();
    else await assert.rejects(call(), /daily|limit/i);
  }
  assert.equal(f.rows.length, 5);
  assert.equal(f.calls.length, 5);
  assert.ok(f.locks.includes('outlayer-registration:1'));
  assert.ok(f.locks.includes('outlayer-registration:2'));
  // A repeated observation/retry does not consume a new allowance.
  await f.module.persistentCall(f.db, f.chain, { ...f.bet, id: 'bet-0' }, { id: 'sponsor.near' },
    'register_material', {}, '1', '1', null, { signerLocked: true, registrationLimit: 5 });
  assert.equal(f.rows.length, 5);
});

test('settlement survives nonce invalidation and permissionless requests without inventing a hash', async () => {
  for (const request of [null, { id: 'request', intent_key: '1', execution_status: 'succeeded', transaction_hash: 'executed-hash' }]) {
    const f = await registrationFixture();
    f.bet.status = 'settled'; f.bet.outcome = 'yes'; f.bet.chain_state.resolution = { method: 'referee' };
    f.ruling.stage = 'settled'; f.ruling.outcome = 'yes'; f.ruling.nonce = '3';
    f.db.one = async () => request;
    await f.module.recordSettlement(f.db, f.bet, f.ruling, () => assert.fail('no live fetch'));
    assert.equal(f.events.length, 1);
    assert.equal(f.events[0].outcome, 'yes');
    assert.equal(f.events[0].transactionHash || null, request?.transaction_hash || null);
  }
});

test('settlement selects the accepted attempt intent before the latest retry', async () => {
  const f = await registrationFixture();
  f.bet.status = 'settled'; f.bet.outcome = 'yes'; f.bet.chain_state.resolution = { method: 'referee' };
  Object.assign(f.ruling, { stage: 'settled', outcome: 'yes', nonce: '9', accepted_nonce: '2' });
  let exact = false;
  f.db.one = async (sql, args) => {
    if (!/outlayer_near_requests/.test(sql)) return {};
    exact = args[2] === '1'; return { execution_status: 'succeeded', transaction_hash: exact ? 'accepted-hash' : 'later-hash' };
  };
  await f.module.recordSettlement(f.db, f.bet, f.ruling);
  assert.equal(exact, true);
  assert.equal(f.events[0].transactionHash, 'accepted-hash');
});

test('evidence registration failure produces no evidence transaction or wallet payload', async () => {
  const f = await registrationFixture();
  const now = Date.now();
  f.bet.resolve_at = new Date(now - 1000).toISOString(); f.bet.outlayer_material.deadline = f.bet.resolve_at;
  f.bet.terms_hash = f.module.outlayerTermsHash(f.bet.outlayer_material, f.bet.terms_salt);
  let registered = 0;
  const module = await sourceModule({ syncNearBet: async () => f.bet,
    playAccountFor: async () => { assert.fail('must register before participant signing'); } }, ['submitOutlayerEvidence']);
  f.chain.view = async ({ method }) => method === 'get_config' ? { escrow: 'escrow.near', supports_open_evidence: true } : null;
  f.chain.prepareCall = async () => { registered++; throw new Error('registration unavailable'); };
  await assert.rejects(module.submitOutlayerEvidence(f.db, f.config, f.chain, f.bet, { id: '1' },
    { url: 'https://www.sec.gov/release' }), /registration unavailable/);
  assert.equal(registered, 1);
});

test('evidence submission registers material first and verifies it before returning a wallet payload', async () => {
  const f = await registrationFixture();
  const deadline = new Date(Date.now() - 1000).toISOString();
  f.bet.resolve_at = deadline; f.bet.outlayer_material.deadline = deadline;
  f.bet.terms_hash = f.module.outlayerTermsHash(f.bet.outlayer_material, f.bet.terms_salt);
  Object.assign(f.ruling, { material_json: JSON.stringify(f.bet.outlayer_material), terms_hash: f.bet.terms_hash,
    deadline_ns: (BigInt(Date.parse(deadline)) * 1000000n).toString() });
  const module = await sourceModule({ syncNearBet: async () => f.bet, playAccountFor: async () => null,
    verifyNearExecution: async () => ({ status: 'succeeded' }), walletPayload: input => input,
    reserveNearRequest: async (_db, input) => {
      assert.equal(f.calls.length, 1); assert.equal(f.calls[0].method, 'register_material');
      assert.equal((await f.chain.view({ method: 'get_ruling' })).terms_hash, f.bet.terms_hash);
      return { request: { id: 'evidence', method: input.method, args: input.args }, reused: false };
    } }, ['submitOutlayerEvidence']);
  const result = await module.submitOutlayerEvidence(f.db, f.config, f.chain, f.bet, { id: '1' },
    { url: 'https://www.sec.gov/release' });
  assert.equal(result.payload.methodName, 'submit_evidence');
  assert.equal(result.args.url, 'https://www.sec.gov/release');
});
