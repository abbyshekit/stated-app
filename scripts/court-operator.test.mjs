// INTEGRATION: DB-free operator-script checks. All mutation paths use fake chains.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { HOSTED_COURT as H, assertRelayConfig, courtPolicy, createCourt, operatorError } from './create-court-dao.mjs';
import { assertDeploymentConfig, buildRelay, deployRelay, relayDeployActions, relayInit } from './deploy-jury-relay.mjs';
import { assertCouncilCanHarden, assertLockedRelay, hardenCourt as runHardenCourt } from './harden-court-dao.mjs';
import { courtLiveCheck, readCredentials } from './court-live-check.mjs';

const relay = 'jury-relay.treasury.testnet';
const config = { dao: H.dao, escrow: H.escrow, operator: H.operator, window_ns: '600000000000' };
const policy = () => courtPolicy({ relay, council: [H.council] });
const oldPolicy = () => { const p = policy(); p.roles[0].kind.Group = [H.operator]; p.roles[1].permissions = ['*:*']; return p; };
const quiet = () => {};
const hardenCourt = (options) => runHardenCourt({ readWasm: async () => Buffer.from('wasm'), encodeHash: () => 'HASH',
  query: async (_method, args) => args.request_type === 'view_account' ? { code_hash: 'HASH' } : { keys: [] }, ...options });
const councilEnv = { COURT_COUNCIL_ACCOUNT: H.council, COURT_COUNCIL_KEY: 'FAKE_TEST_ONLY' };
const temp = async (t) => { const dir = await mkdtemp(join(tmpdir(), 'court-operator-test-')); t.after(() => rm(dir, { recursive: true, force: true })); return dir; };

test('all operator modules import without commands, network, credentials or output', () => {
  const source = `globalThis.fetch=()=>{throw Error('network attempted')}; process.argv=['node','unrelated']; await Promise.all(${JSON.stringify([
    './scripts/create-court-dao.mjs', './scripts/deploy-jury-relay.mjs', './scripts/harden-court-dao.mjs', './scripts/court-live-check.mjs',
  ])}.map(p=>import(p)));`;
  assert.equal(execFileSync(process.execPath, ['--input-type=module', '-e', source], { cwd: resolve(import.meta.dirname, '..'), encoding: 'utf8' }), '');
});

test('frozen policy has relay-only jury and veto/remove-only council; defaults preserved', () => {
  const p = policy();
  assert.deepEqual(p.roles[0], { name: 'jury', kind: { Group: [relay] }, permissions: ['call:AddProposal', 'call:VoteApprove'], vote_policy: {} });
  assert.deepEqual(p.roles[1].permissions, ['call:VoteReject', 'call:VoteRemove']);
  assert.equal(p.proposal_bond, '0'); assert.equal(p.proposal_period, '604800000000000');
  assert.equal(p.bounty_bond, '0'); assert.equal(p.bounty_forgiveness_period, '86400000000000');
  assert.deepEqual(p.default_vote_policy, { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 2] });
  assert.throws(() => courtPolicy({ jury: H.operator, council: [H.council] }), /relay/);
  assert.throws(() => courtPolicy({ relay, council: [relay] }), /Council/);
  assert.throws(() => courtPolicy({ relay, council: [H.council, H.council] }), /Council/);
});

test('creation defaults to dry-run and rejects missing relay/mainnet before chain access', async () => {
  let calls = 0; const chain = { call() { calls++; throw Error('mutation'); } };
  const args = ['--name', 'test-court', '--relay', relay, '--council', H.council];
  assert.equal((await createCourt({ argv: args, env: {}, chain, log: quiet })).dryRun, true);
  assert.equal((await createCourt({ argv: [...args, '--yes', '--dry-run'], env: {}, chain, log: quiet })).dryRun, true);
  await assert.rejects(createCourt({ argv: args, env: { STATED_NEAR_NETWORK: 'mainnet' }, chain, log: quiet }), /Testnet/);
  await assert.rejects(createCourt({ argv: ['--name', 'test-court', '--council', H.council], env: {}, chain, log: quiet }), /relay/);
  assert.equal(calls, 0);
});

test('relay config requires exact hosted accounts and full on-chain window', () => {
  assert.doesNotThrow(() => assertRelayConfig(config));
  for (const key of ['dao', 'escrow', 'operator', 'window_ns']) assert.throws(() => assertRelayConfig({ ...config, [key]: 'wrong' }), /configuration/);
});

test('deployment action batch is atomic, initialized correctly and adds no key', () => {
  const actions = Object.fromEntries(['createAccount', 'transfer', 'deployContract', 'functionCall'].map((name) => [name, (...args) => ({ name, args })]));
  const batch = relayDeployActions(actions, { wasm: Buffer.from('wasm'), amountYocto: '123' });
  assert.deepEqual(batch.map((a) => a.name), ['createAccount', 'transfer', 'deployContract', 'functionCall']);
  assert.deepEqual(batch[3].args, ['new', { dao: H.dao, escrow: H.escrow, operator: H.operator, window_seconds: 600 }, 100_000_000_000_000n, 0n]);
});

test('cargo build uses locked near build and never receives signer env or key argv', async (t) => {
  const projectRoot = await temp(t); let called;
  const run = async (...args) => {
    called = args;
    const dir = join(projectRoot, 'contracts/jury-relay/target/near');
    await mkdir(dir, { recursive: true }); await writeFile(join(dir, 'stated_jury_relay.wasm'), 'wasm');
  };
  assert.equal(String(await buildRelay({ projectRoot, run, env: { PATH: '/bin', STATED_PLAY_TREASURY_KEY: 'hidden' } })), 'wasm');
  assert.deepEqual(called.slice(0, 2), ['cargo', ['near', 'build', 'non-reproducible-wasm', '--locked', '--no-abi']]);
  assert.equal(called[2].cwd, join(projectRoot, 'contracts/jury-relay'));
  assert.deepEqual(called[2].env, { PATH: '/bin' });
});

test('deployment dry-run builds but never queries chain, signs or requires a key', async () => {
  let builds = 0;
  const result = await deployRelay({ argv: ['--name', 'jury'], env: { STATED_PLAY_TREASURY: 'treasury.testnet' }, log: quiet,
    build: async () => { builds++; return Buffer.from('wasm'); }, send: () => assert.fail('sent'), chain: { balance: () => assert.fail('queried') } });
  assert.equal(result.dryRun, true); assert.equal(builds, 1); assert.deepEqual(result.init, relayInit());
});

test('deployment accepts explicit testnet initialization and verifies exactly those values', async () => {
  const argv = ['--name', 'jury', '--dao', 'custom.sputnik-v2.testnet', '--escrow', 'escrow.custom.testnet', '--operator', 'operator.custom.testnet', '--window-seconds', '120'];
  const result = await deployRelay({ argv, env: { STATED_PLAY_TREASURY: 'treasury.testnet' }, build: async () => Buffer.from('wasm'), log: quiet });
  assert.deepEqual(result.init, { dao: 'custom.sputnik-v2.testnet', escrow: 'escrow.custom.testnet', operator: 'operator.custom.testnet', window_seconds: 120 });
  assert.doesNotThrow(() => assertDeploymentConfig({ dao: result.init.dao, escrow: result.init.escrow, operator: result.init.operator, window_ns: '120000000000' }, result.init));
  assert.throws(() => assertDeploymentConfig(config, result.init), /differs/);
  for (const args of [['--window-seconds', '59'], ['--window-seconds', '86401'], ['--window-seconds', '1.5'], ['--dao', 'dao.near']]) {
    await assert.rejects(deployRelay({ argv: args, env: { STATED_PLAY_TREASURY: 'treasury.testnet' }, build: () => assert.fail('build'), log: quiet }), /Window|whole|testnet/);
  }
});

test('deployment fake round-trip verifies hash, keys, config and records public evidence', async (t) => {
  const projectRoot = await temp(t); let sent = 0;
  const result = await deployRelay({ argv: ['--name', 'jury', '--yes'], env: { STATED_PLAY_TREASURY: 'treasury.testnet', STATED_PLAY_TREASURY_KEY: 'FAKE_TEST_ONLY' },
    projectRoot, log: quiet, build: async () => Buffer.from('wasm'), encodeHash: () => 'HASH',
    chain: { balance: async (id) => id === 'treasury.testnet' ? '10000000000000000000000000' : null, view: async () => config },
    query: async (_method, args) => args.request_type === 'view_account' ? { code_hash: 'HASH' } : { keys: [] },
    send: async (args) => { sent++; assert.deepEqual(args.init, relayInit()); assert.equal(args.secret, 'FAKE_TEST_ONLY'); return { ok: true, hash: 'TX' }; } });
  assert.equal(sent, 1); assert.equal(result.checks.verified, true); assert.equal(result.checks.accessKeys, 0);
  assert.doesNotMatch(JSON.stringify(result), /FAKE_TEST_ONLY/);
});

test('deployment fails closed on mainnet, absent signer and already-existing account', async () => {
  const build = async () => Buffer.from('wasm'); const send = () => assert.fail('sent');
  const base = { argv: ['--yes'], env: { STATED_PLAY_TREASURY: 'treasury.testnet' }, build, send, log: quiet };
  await assert.rejects(deployRelay({ ...base, env: { ...base.env, STATED_NEAR_NETWORK: 'mainnet' } }), /Testnet/);
  await assert.rejects(deployRelay(base), /TREASURY_KEY/);
  await assert.rejects(deployRelay({ ...base, env: { ...base.env, STATED_PLAY_TREASURY_KEY: 'FAKE' }, query: quiet, encodeHash: quiet,
    chain: { balance: async () => '1' } }), /already exists/);
});

test('deployment records verification failure for any access key instead of accepting lock', async (t) => {
  const projectRoot = await temp(t);
  await assert.rejects(deployRelay({ argv: ['--yes'], env: { STATED_PLAY_TREASURY: 'treasury.testnet', STATED_PLAY_TREASURY_KEY: 'FAKE' }, projectRoot,
    log: quiet, sleep: async () => {}, build: async () => Buffer.from('wasm'), encodeHash: () => 'HASH', send: async () => ({ ok: true, hash: 'TX' }),
    chain: { balance: async (id) => id === 'treasury.testnet' ? '10000000000000000000000000' : null, view: async () => config },
    query: async (_method, args) => args.request_type === 'view_account' ? { code_hash: 'HASH' } : { keys: [{}] } }), /verification failed/);
});

test('hardening dry-run validates config/current authority without signing', async () => {
  const chain = { view: async ({ method }) => method === 'get_config' ? config : oldPolicy(), call: () => assert.fail('sent') };
  assert.equal((await hardenCourt({ argv: ['--relay', relay], env: councilEnv, chain, log: quiet })).dryRun, true);
  await assert.rejects(hardenCourt({ argv: ['--relay', relay, '--yes'], env: councilEnv,
    chain: { ...chain, view: async ({ method }) => method === 'get_config' ? { ...config, operator: 'wrong.testnet' } : oldPolicy() }, log: quiet }), /configuration/);
});

test('hardening rejects a spoofed relay config if code is different or the relay has any key', async () => {
  for (const bad of ['code', 'keys']) {
    await assert.rejects(hardenCourt({ argv: ['--relay', relay, '--yes'], env: councilEnv, log: quiet,
      chain: { view: async ({ method }) => method === 'get_config' ? config : oldPolicy(), call: () => assert.fail('sent') },
      query: async (_method, args) => args.request_type === 'view_account' ? { code_hash: bad === 'code' ? 'OTHER' : 'HASH' } : { keys: bad === 'keys' ? [{}] : [] } }),
    bad === 'code' ? /code hash differs/ : /zero access keys/);
  }
});

test('hardening rejects council privilege/quorum drift and economic defaults drift', async () => {
  const none = oldPolicy(); none.roles[1].permissions = ['call:VoteReject'];
  assert.throws(() => assertCouncilCanHarden(none, H.council), /permissions/);
  const many = oldPolicy(); many.roles[1].kind.Group.push('other.testnet');
  assert.throws(() => assertCouncilCanHarden(many, H.council), /single-member/);
  const drift = oldPolicy(); drift.proposal_bond = '42';
  await assert.rejects(hardenCourt({ argv: ['--relay', relay, '--yes'], env: councilEnv, log: quiet,
    chain: { view: async ({ method }) => method === 'get_config' ? config : drift, call: () => assert.fail('sent') } }), /proposal_bond differs/);
});

test('hardening fake round-trip sends ChangePolicy then exactly one current-council approval', async (t) => {
  let final = false; let kind; const calls = [];
  const result = await hardenCourt({ argv: ['--relay', relay, '--yes'], env: councilEnv, evidenceRoot: await temp(t), log: quiet,
    chain: { view: async ({ method }) => method === 'get_config' ? config : method === 'get_policy' ? (final ? policy() : oldPolicy())
      : { kind, status: final ? 'Approved' : 'InProgress' }, call: async (args) => {
      calls.push(args); if (args.method === 'add_proposal') { kind = args.args.proposal.kind; return { ok: true, value: 3, hash: 'ADD' }; }
      final = true; return { ok: true, hash: 'VOTE' };
    } } });
  assert.equal(result.verified, true); assert.equal(calls.length, 2); assert.equal(calls[0].depositYocto, '0');
  assert.deepEqual(calls[0].args.proposal.kind, { ChangePolicy: { policy: policy() } });
  assert.equal(calls[1].args.action, 'VoteApprove'); assert.equal(calls[1].signerId, H.council);
  assert.doesNotMatch(JSON.stringify(result), /FAKE_TEST_ONLY/);
});

test('hardening refuses mutated proposal before voting and skips terminal proposal approval', async (t) => {
  let calls = 0;
  const base = { argv: ['--relay', relay, '--yes'], env: councilEnv, evidenceRoot: await temp(t), log: quiet };
  await assert.rejects(hardenCourt({ ...base, chain: { view: async ({ method }) => method === 'get_config' ? config : method === 'get_policy' ? oldPolicy()
    : { status: 'InProgress', kind: { ChangePolicy: { policy: {} } } }, call: async () => { calls++; return { ok: true, value: 1 }; } } }), /content differs/);
  assert.equal(calls, 1);
  calls = 0; let kind; let added = false;
  const result = await hardenCourt({ ...base, chain: { view: async ({ method }) => method === 'get_config' ? config : method === 'get_policy' ? (added ? policy() : oldPolicy())
    : { status: 'Approved', kind }, call: async (args) => { calls++; added = true; kind = args.args.proposal.kind; return { ok: true, value: 1 }; } } });
  assert.equal(result.verified, true); assert.equal(calls, 1);
});

test('already-hardened policy is idempotent even with --yes', async () => {
  const result = await hardenCourt({ argv: ['--relay', relay, '--yes'], env: councilEnv, log: quiet,
    chain: { view: async ({ method }) => method === 'get_config' ? config : policy(), call: () => assert.fail('sent') } });
  assert.equal(result.alreadyHardened, true);
});

test('live check dry-run reads no credentials, creates no account and makes no chain calls', async () => {
  const result = await courtLiveCheck({ argv: ['--relay', relay], env: {}, log: quiet, read: () => assert.fail('read'),
    makeAccount: () => assert.fail('account'), chain: { call: () => assert.fail('sent'), view: () => assert.fail('view') } });
  assert.equal(result.dryRun, true);
});

test('live signer files must match hosted operator and council account ids', async () => {
  const read = async () => JSON.stringify({ account_id: H.council, private_key: 'ed25519:FAKE' });
  await assert.rejects(readCredentials('path', H.operator, read), /must belong/);
  assert.equal((await readCredentials('path', H.council, read)).id, H.council);
});

test('error reporting strips private key text and environment secrets', () => {
  assert.equal(operatorError(Error('bad ed25519:abcdefgh and hidden'), { COURT_COUNCIL_KEY: 'hidden' }), 'bad [redacted] and [redacted]');
});

test('live fake chain proves timing, negative permissions, veto, settlement and withdrawal', async (t) => {
  let time = 1_800_000_000_000; let next = 0; let credit = 0n; let withdrawn = false;
  const proposals = new Map(); const bets = new Map(); const calls = [];
  const ok = (value) => ({ ok: true, value, hash: `TX${calls.length}` });
  const fail = (failure) => ({ ok: false, failure, hash: `TX${calls.length}` });
  const chain = {
    balance: async () => String(10n ** 24n + (withdrawn ? 2n * STAKE : 0n)),
    view: async ({ method, args }) => {
      if (method === 'get_config') return config;
      if (method === 'get_policy') return policy();
      if (method === 'version') return 2;
      if (method === 'get_proposal') return proposals.get(args.id);
      if (method === 'get_bet') return bets.get(args.id);
      if (method === 'get_credit') return String(credit);
      throw Error(`Unexpected view ${method}`);
    },
    call: async (c) => {
      calls.push(c);
      if (c.method === 'create_bet') { bets.set(c.args.id, { status: 'open' }); return ok(); }
      if (c.method === 'accept_bet') { bets.get(c.args.id).status = 'accepted'; return ok(); }
      if (c.method === 'file') {
        if (c.signerId !== H.operator) return fail('Operator only');
        const id = next++; proposals.set(id, { proposer: relay, status: 'InProgress', kind: { test: c.args.id }, bet: c.args.id,
          submission_time: String(BigInt(time) * 1_000_000n) }); return ok(id);
      }
      if (c.method === 'add_proposal') return fail('ERR_PERMISSION_DENIED');
      if (c.method === 'act_proposal') {
        if (c.args.action === 'VoteApprove') return fail('ERR_PERMISSION_DENIED');
        proposals.get(c.args.id).status = 'Rejected'; return ok();
      }
      if (c.method === 'approve') {
        assert.equal(c.gas, 300_000_000_000_000n);
        const p = proposals.get(c.args.id);
        if (p.status !== 'InProgress') return fail('proposal is terminal');
        if (time < Number(BigInt(p.submission_time) / 1_000_000n) + 600_000) return fail('correction window not elapsed');
        p.status = 'Approved'; bets.set(p.bet, { status: 'settled', resolution: { method: 'referee', outcome: 'yes' } }); credit = 2n * STAKE; return ok();
      }
      if (c.method === 'withdraw') { credit = 0n; withdrawn = true; return ok(); }
      throw Error(`Unexpected call ${c.method}`);
    },
  };
  const STAKE = 10n ** 23n;
  const result = await courtLiveCheck({ argv: ['--relay', relay, '--yes'], env: {}, chain, log: quiet, evidenceRoot: await temp(t),
    now: () => time, sleep: async (ms) => { time += ms; }, makeAccount: async (name) => ({ id: `${name}.testnet`, secret: 'FAKE' }),
    read: async (file) => JSON.stringify({ account_id: file.includes(H.operator) ? H.operator : H.council, private_key: 'ed25519:FAKE' }) });
  assert.equal(result.passed, true); assert.equal(result.steps.every((s) => s.pass), true);
  assert.equal(calls.filter((c) => c.method === 'file' && c.signerId === H.operator).length, 2);
  assert.equal(calls.filter((c) => c.method === 'approve').every((c) => c.signerId === 'b.testnet'), true);
  assert.doesNotMatch(JSON.stringify(result), /ed25519|FAKE/);
});
