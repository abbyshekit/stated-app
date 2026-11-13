// A fake RPC stands in for NEAR. No network access.
import test from 'node:test';
import assert from 'node:assert/strict';
import { main, runJudge, toBase58, courtPolicyProblems, NETWORKS, TESTNET_ESCROW, MAINNET_ESCROW, RELAY, DAO, BET_ID } from './judge-chain.mjs';

const TESTNET_HASH = 'Bqr2TsgyFRNDw2GZ6q9aT7cMAnjZNERKdzaBstRgKaAg';
const MAINNET_HASH = '6vSbm6dg1F6gyEggDNtd5t3MrDmGZBgSgE4NjHwEmS33';

const policy = () => ({
  roles: [
    { name: 'jury', kind: { Group: [RELAY] }, permissions: ['call:AddProposal', 'call:VoteApprove'], vote_policy: {} },
    { name: 'council', kind: { Group: ['council.testnet'] }, permissions: ['call:VoteRemove', 'call:VoteReject'], vote_policy: {} },
  ],
  default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 2] },
});

function chainState() {
  return {
    keys: { [TESTNET_ESCROW]: [], [MAINNET_ESCROW]: [], [RELAY]: [] },
    codeHash: { [TESTNET_ESCROW]: TESTNET_HASH, [MAINNET_ESCROW]: MAINNET_HASH },
    version: { [TESTNET_ESCROW]: '2', [MAINNET_ESCROW]: '2' },
    policy: policy(),
    bet: { id: BET_ID, status: 'settled', resolution: { outcome: 'yes', method: 'referee' } },
  };
}

/** A fetch that answers JSON-RPC queries from `state`. `down` lists hosts that refuse. */
function fakeRpc(state, { down = [], calls = [] } = {}) {
  return async (url, init) => {
    const host = new URL(url).host;
    calls.push(host);
    if (down.includes(host)) return new Response('unavailable', { status: 503 });
    const { params } = JSON.parse(init.body);
    const id = params.account_id;
    let result;
    if (params.request_type === 'view_access_key_list') result = { keys: state.keys[id] };
    else if (params.request_type === 'view_account') result = { code_hash: state.codeHash[id] };
    else if (params.request_type === 'call_function') {
      const args = JSON.parse(Buffer.from(params.args_base64, 'base64').toString());
      const value = params.method_name === 'version' ? state.version[id]
        : params.method_name === 'get_policy' ? state.policy
          : params.method_name === 'get_bet' && args.id === BET_ID ? state.bet : null;
      result = { result: [...Buffer.from(JSON.stringify(value))] };
    }
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: 'judge', result }), { headers: { 'content-type': 'application/json' } });
  };
}

const run = (state, options) => runJudge({ fetchImpl: fakeRpc(state, options), sleep: async () => {}, ...options });
const failures = (results) => results.filter(r => !r.ok).map(r => r.name);

test('hex sha256 converts to the base58 code hash the chain reports', () => {
  assert.equal(toBase58('a1182e5ccc543058d1ae4121e7d4361f17822583f455dcc5140e3e092e20a2d5'), TESTNET_HASH);
  assert.equal(toBase58('57fb29aa0c444a1ce2463be3d1bbddb277348521920b586cd48b548a9f113d6a'), MAINNET_HASH);
  assert.equal(toBase58(TESTNET_HASH), TESTNET_HASH);
});

test('a passing chain: five PASS lines, exit 0', async () => {
  const lines = [];
  const code = await main([], line => lines.push(line), { fetchImpl: fakeRpc(chainState()), sleep: async () => {} });
  assert.equal(code, 0);
  assert.equal(lines.filter(l => l.startsWith('PASS')).length, 5);
  assert.equal(lines.filter(l => l.startsWith('FAIL')).length, 0);
  assert.match(lines.at(-1), /^judge-chain: PASS \(5 of 5 checks\)$/);
});

const cases = [
  ['a testnet escrow access key', s => { s.keys[TESTNET_ESCROW] = [{ public_key: 'ed25519:x' }]; }, /testnet escrow/],
  ['a mainnet escrow access key', s => { s.keys[MAINNET_ESCROW] = [{ public_key: 'ed25519:x' }]; }, /mainnet escrow/],
  ['testnet escrow version 1', s => { s.version[TESTNET_ESCROW] = '1'; }, /testnet escrow/],
  ['mainnet escrow version 3', s => { s.version[MAINNET_ESCROW] = '3'; }, /mainnet escrow/],
  ['a different testnet code hash', s => { s.codeHash[TESTNET_ESCROW] = MAINNET_HASH; }, /testnet escrow/],
  ['a different mainnet code hash', s => { s.codeHash[MAINNET_ESCROW] = TESTNET_HASH; }, /mainnet escrow/],
  ['a relay access key', s => { s.keys[RELAY] = [{ public_key: 'ed25519:x' }]; }, /relay/],
  ['a second jury member', s => { s.policy.roles[0].kind.Group.push('referee.testnet'); }, /Court DAO/],
  ['a jury that is not the relay', s => { s.policy.roles[0].kind.Group = ['referee.testnet']; }, /Court DAO/],
  ['a council that can approve', s => { s.policy.roles[1].permissions.push('call:VoteApprove'); }, /Court DAO/],
  ['a council with the old wildcard', s => { s.policy.roles[1].permissions = ['*:*']; }, /Court DAO/],
  ['a third role', s => { s.policy.roles.push({ name: 'extra', kind: { Group: ['x.testnet'] }, permissions: ['*:*'], vote_policy: {} }); }, /Court DAO/],
  ['a bet that is not settled', s => { s.bet.status = 'accepted'; }, /bet 3668aa04/],
  ['a bet settled no', s => { s.bet.resolution.outcome = 'no'; }, /bet 3668aa04/],
  ['a missing bet', s => { s.bet = null; }, /bet 3668aa04/],
];
for (const [name, mutate, which] of cases) {
  test(`fails on ${name}, and only that line`, async () => {
    const state = chainState();
    mutate(state);
    const lines = [];
    const code = await main([], line => lines.push(line), { fetchImpl: fakeRpc(state), sleep: async () => {} });
    const failed = lines.filter(l => l.startsWith('FAIL'));
    assert.equal(code, 1);
    assert.equal(failed.length, 1, failed.join('\n'));
    assert.match(failed[0], which);
    assert.equal(lines.filter(l => l.startsWith('PASS')).length, 4);
    assert.match(lines.at(-1), /^judge-chain: FAIL \(1 of 5 checks failed\)$/);
  });
}

test('the primary RPC host down: the fallback answers and every check still passes', async () => {
  const calls = [];
  const results = await run(chainState(), { down: [new URL(NETWORKS.testnet[0]).host, new URL(NETWORKS.mainnet[0]).host], calls });
  assert.deepEqual(failures(results), []);
  assert.ok(calls.includes(new URL(NETWORKS.testnet[1]).host));
  assert.ok(calls.includes(new URL(NETWORKS.mainnet[1]).host));
  assert.ok(calls.filter(h => h === new URL(NETWORKS.testnet[0]).host).length <= 3 * 4 * 2, 'retries are bounded');
});

test('every RPC host down: each check FAILs, none throws, exit 1', async () => {
  const down = [...NETWORKS.testnet, ...NETWORKS.mainnet].map(u => new URL(u).host);
  const calls = [];
  const lines = [];
  const code = await main([], line => lines.push(line), { fetchImpl: fakeRpc(chainState(), { down, calls }), sleep: async () => {} });
  assert.equal(code, 1);
  assert.equal(lines.filter(l => l.startsWith('FAIL')).length, 5);
  assert.ok(calls.length <= 5 * 3 * 2 * 3 + 40, `bounded calls, got ${calls.length}`);
});

test('missing evidence is a FAIL, not a pass on an unchecked value', async () => {
  const results = await run(chainState(), { evidenceDir: '/nonexistent-evidence-dir' });
  assert.equal(failures(results).filter(n => /escrow/.test(n)).length, 2);
});

test('courtPolicyProblems accepts the live policy and names each deviation', () => {
  assert.deepEqual(courtPolicyProblems(policy()), []);
  const p = policy(); p.roles[1].kind.Group = [];
  assert.match(courtPolicyProblems(p).join(), /council is empty/);
  const q = policy(); q.roles[0].vote_policy = { weight_kind: 'RoleWeight' };
  assert.match(courtPolicyProblems(q).join(), /own voting rule/);
  assert.match(courtPolicyProblems(null).join(), /expected exactly the roles/);
});

test('the script reads no key files and sends no transaction method', async () => {
  const { readFileSync } = await import('node:fs');
  const src = readFileSync(new URL('./judge-chain.mjs', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /broadcast_tx|send_tx|near-credentials|~\/\.keys|\.ssh|process\.env/);
});
