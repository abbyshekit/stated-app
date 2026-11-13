import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, rm, symlink } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import { baseEncode } from 'near-api-js';
import { buildPreview, deployActions, deployOutlayer, parseOptions, validateOptions } from './outlayer-deploy.mjs';
import { checkOutlayer } from './outlayer-check.mjs';

const options = { network: 'testnet', parent: 'sponsor.testnet', account: 'ref.sponsor.testnet', wasm: '/no-read',
  'referee-hash': 'b'.repeat(64), 'jury-wasm': '/no-read-jury',
  escrow: 'escrow.testnet', 'wasm-url': 'https://example.org/jury.wasm', 'wasm-hash': 'a'.repeat(64),
  'secrets-owner': 'sponsor.testnet', 'amount-yocto': '1000000000000000000000000' };
const wasm = Buffer.from([0,97,115,109,1,0,0,0]);
const digest = bytes => createHash('sha256').update(bytes).digest('hex');
const config = { escrow: options.escrow, outlayer: 'outlayer.testnet', wasm_url: options['wasm-url'],
  wasm_hash: options['wasm-hash'], secrets_owner: options['secrets-owner'], secrets_profile: 'jury' };
const flags = values => Object.entries(values).flatMap(([k, v]) => v === true ? [`--${k}`] : [`--${k}`, v]);
const fetchWasm = async () => new Response(wasm);

for (const script of ['outlayer-check.mjs', 'outlayer-deploy.mjs']) {
  for (const kind of ['file', 'directory']) {
    test(`${script} validates arguments when launched through a ${kind} symlink`, async () => {
      const dir = await mkdtemp(join(tmpdir(), 'outlayer-entry-'));
      try {
        const target = fileURLToPath(new URL(script, import.meta.url));
        const link = join(dir, kind === 'file' ? script : 'scripts');
        await symlink(kind === 'file' ? target : fileURLToPath(new URL('.', import.meta.url)), link);
        const result = spawnSync(process.execPath, [kind === 'file' ? link : join(link, script), '--bogus'],
          { encoding: 'utf8', timeout: 10000 });
        assert.equal(result.error, undefined);
        assert.equal(result.status, 1, 'invalid CLI arguments must fail closed before any network or key access');
        assert.match(result.stderr, /Unknown|Invalid|Expected|Missing/i);
      } finally { await rm(dir, { recursive: true, force: true }); }
    });
  }
}
const accountQuery = async () => ({ code_hash: 'deployed-code' });
const checkOptions = { network: 'testnet', account: 'ref.testnet', 'code-hash': 'expected', escrow: config.escrow,
  'wasm-url': config.wasm_url, 'wasm-hash': config.wasm_hash, 'secrets-owner': config.secrets_owner,
  'secrets-profile': config.secrets_profile };
function inspectionQuery({ actualConfig = config, codeHash = 'expected', keys = [] } = {}) {
  return async ({ request_type, method_name }) => {
    if (request_type === 'view_account') return { code_hash: codeHash };
    if (request_type === 'view_access_key_list') return { keys };
    return { result: [...Buffer.from(JSON.stringify(method_name === 'get_config' ? actualConfig : '100000'))] };
  };
}
async function withDeployFixture(run) {
  const dir = await mkdtemp(join(tmpdir(), 'outlayer-preflight-'));
  try {
    const file = join(dir, 'ref.wasm');
    await writeFile(file, wasm);
    const args = { ...options, wasm: file, 'referee-hash': digest(wasm), 'jury-wasm': file, 'wasm-hash': digest(wasm) };
    await run(args);
  } finally { await rm(dir, { recursive: true, force: true }); }
}

test('deployment preview specifies exactly four atomic actions with no access key', () => {
  const { init } = validateOptions(options);
  const preview = buildPreview(options, wasm, init);
  assert.deepEqual(preview.actions.map(action => action.type), ['CreateAccount','Transfer','DeployContract','FunctionCall']);
  assert.equal(preview.actions[2].code_base64, wasm.toString('base64'));
  assert.equal(preview.actions[3].args_base64, Buffer.from(JSON.stringify(init)).toString('base64'));
  assert.equal(preview.actions[3].method_name, 'new');
  assert.equal(preview.actions[3].deposit, '0');
  const actions = { createAccount: () => 'create', transfer: () => 'transfer', deployContract: () => 'deploy', functionCall: () => 'new' };
  assert.deepEqual(deployActions(actions, { wasm, amountYocto: options['amount-yocto'], init }), ['create','transfer','deploy','new']);
});

test('deployment rejects wrong network, parent namespace, unsafe URL and unapproved signing', () => {
  for (const patch of [{ network: 'unknown' }, { parent: 'sponsor.near' }, { account: 'someone.testnet' },
    { 'wasm-url': 'https://user:password@example.org/jury.wasm' }, { yes: true }, { 'amount-yocto': '1.0' }]) {
    assert.throws(() => validateOptions({ ...options, ...patch }));
  }
  assert.throws(() => parseOptions(['--yes','--yes']), /Duplicate/);
});

test('dry run never reads a supplied nonexistent key path or sends a transaction', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'outlayer-script-'));
  try {
    const file = join(dir, 'ref.wasm'); await writeFile(file, wasm);
    const argv = Object.entries({ ...options, wasm: file, 'referee-hash': digest(wasm), 'jury-wasm': file,
      'wasm-hash': digest(wasm), 'key-file': join(dir, 'does-not-exist') }).flatMap(([k,v]) => [`--${k}`,v]);
    const result = await deployOutlayer({ argv, fetch: fetchWasm, query: accountQuery,
      log: () => {}, send: () => assert.fail('dry run sent') });
    assert.equal(result.dryRun, true);
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('deployment verifies both artifact hashes before preview or signing', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'outlayer-artifacts-'));
  try {
    const referee = join(dir, 'ref.wasm'); const jury = join(dir, 'jury.wasm');
    const juryBytes = Buffer.from('jury artifact');
    await writeFile(referee, wasm); await writeFile(jury, juryBytes);
    const args = { ...options, wasm: referee, 'referee-hash': digest(wasm), 'jury-wasm': jury, 'wasm-hash': digest(juryBytes) };
    let previews = 0;
    const run = patch => deployOutlayer({ argv: Object.entries({ ...args, ...patch }).flatMap(([k,v]) => v === true ? [`--${k}`] : [`--${k}`,v]),
      fetch: async () => new Response(juryBytes), query: accountQuery,
      log: () => { previews += 1; }, send: () => assert.fail('unexpected send') });
    const result = await run({});
    assert.equal(result.preview.actions[3].args.wasm_hash, digest(juryBytes));
    previews = 0;
    await assert.rejects(run({ 'referee-hash': 'b'.repeat(64) }), /referee.*hash/i);
    await assert.rejects(run({ 'wasm-hash': 'b'.repeat(64) }), /jury.*hash/i);
    for (const patch of [{ 'referee-hash': 'b'.repeat(64) }, { 'wasm-hash': 'b'.repeat(64) }]) {
      await assert.rejects(run({ ...patch, yes: true, 'key-file': join(dir, 'must-not-be-read') }), /artifact hash mismatch/);
    }
    await assert.rejects(run({ 'jury-wasm': join(dir, 'missing') }));
    await assert.rejects(run({ 'referee-hash': '' }));
    assert.equal(previews, 0, 'mismatches must not emit a usable preview');
  } finally { await rm(dir, { recursive: true, force: true }); }
});

test('read-only inspection requires zero keys and verifies the supplied code hash', async () => {
  let keys = [];
  const query = async ({ request_type, method_name }) => {
    if (request_type === 'view_account') return { code_hash: 'expected' };
    if (request_type === 'view_access_key_list') return { keys };
    const value = method_name === 'get_config' ? config : '100000';
    return { result: [...Buffer.from(JSON.stringify(value))] };
  };
  const input = { argv: flags(checkOptions), query, log: () => {} };
  assert.equal((await checkOutlayer(input)).zeroKeys, true);
  keys = [{ public_key: 'ed25519:untrusted' }];
  await assert.rejects(checkOutlayer(input), /verification failed/);
  keys = [];
  await assert.rejects(checkOutlayer({ ...input, argv: flags({ ...checkOptions, 'code-hash': 'wrong' }) }), /verification failed/);
});

test('deployment fetches the published jury without redirects before preview', async () => {
  await withDeployFixture(async args => {
    const events = [];
    const fetch = async (url, request) => {
      events.push('fetch');
      assert.equal(url, options['wasm-url']);
      assert.equal(request.redirect, 'error');
      return new Response(wasm);
    };
    const result = await deployOutlayer({ argv: flags(args), fetch, query: accountQuery, log: () => events.push('preview') });
    assert.equal(result.dryRun, true);
    assert.deepEqual(events, ['fetch', 'preview']);
  });
});

test('deployment applies the jury hash alias to the published artifact check', async () => {
  await withDeployFixture(async args => {
    const alias = { ...args, 'jury-hash': args['wasm-hash'] };
    delete alias['wasm-hash'];
    const result = await deployOutlayer({ argv: flags(alias), fetch: fetchWasm, query: accountQuery, log: () => {} });
    assert.equal(result.preview.actions[3].args.wasm_hash, digest(wasm));
    await assert.rejects(deployOutlayer({ argv: flags(alias), fetch: async () => new Response('wrong'),
      query: accountQuery, log: () => assert.fail('previewed') }), /published.*hash/i);
  });
});

test('deployment rejects unavailable redirected failed or mismatched published jury before preview or signing', async () => {
  await withDeployFixture(async args => {
    const failures = [async () => { throw new Error('redirect or unavailable'); },
      async () => new Response(wasm, { status: 404 }), async () => new Response(wasm, { status: 302 }),
      async () => new Response('different bytes')];
    for (const fetch of failures) {
      for (const signing of [false, true]) {
        let previews = 0;
        await assert.rejects(deployOutlayer({ argv: flags({ ...args,
          ...(signing ? { yes: true, 'key-file': '/must-not-read' } : {}) }), fetch, query: accountQuery,
        log: () => { previews += 1; }, send: () => assert.fail('unexpected signing') }), /published.*(jury|wasm)/i);
        assert.equal(previews, 0);
      }
    }
  });
});

test('deployment requires final existing escrow and secrets owner accounts with deployed escrow code', async () => {
  await withDeployFixture(async args => {
    const seen = [];
    const query = async params => {
      seen.push(params);
      return { code_hash: params.account_id === args.escrow ? 'escrow-code' : '11111111111111111111111111111111' };
    };
    await deployOutlayer({ argv: flags(args), fetch: fetchWasm, query, log: () => {} });
    assert.deepEqual(seen.map(p => [p.request_type, p.finality, p.account_id]).sort(),
      [['view_account', 'final', args.escrow], ['view_account', 'final', args['secrets-owner']]].sort());
    for (const missing of [args.escrow, args['secrets-owner']]) {
      let previews = 0;
      await assert.rejects(deployOutlayer({ argv: flags(args), fetch: fetchWasm,
        query: async params => params.account_id === missing ? { error: 'UNKNOWN_ACCOUNT' } : { code_hash: 'escrow-code' },
        log: () => { previews += 1; } }), /account|escrow/i);
      assert.equal(previews, 0);
    }
    await assert.rejects(deployOutlayer({ argv: flags(args), fetch: fetchWasm,
      query: async () => ({ code_hash: '11111111111111111111111111111111' }), log: () => assert.fail('previewed') }), /escrow.*code/i);
  });
});

test('operator RPC overrides preserve canonical defaults and reject unsafe endpoints', async () => {
  assert.equal(validateOptions({ ...options, rpc: 'https://rpc.example.org/near' }).network.rpc, 'https://rpc.example.org/near');
  assert.equal(validateOptions(options).network.rpc, 'https://rpc.testnet.near.org');
  const mainnet = { ...options, network: 'mainnet', parent: 'sponsor.near', account: 'ref.sponsor.near',
    escrow: 'escrow.near', 'secrets-owner': 'sponsor.near' };
  assert.equal(validateOptions(mainnet).network.rpc, 'https://rpc.mainnet.near.org');
  for (const rpc of ['file:///tmp/rpc', 'https://user:secret@example.org']) {
    assert.throws(() => validateOptions({ ...options, rpc }), /rpc/i);
    await assert.rejects(checkOutlayer({ argv: flags({ ...checkOptions, rpc }), query: inspectionQuery(), log: () => {} }), /rpc/i);
  }
  const result = await checkOutlayer({ argv: flags({ ...checkOptions, rpc: 'https://rpc.example.org/near' }),
    query: inspectionQuery(), log: () => {} });
  assert.equal(result.rpc, 'https://rpc.example.org/near');
  assert.equal((await checkOutlayer({ argv: flags(checkOptions), query: inspectionQuery(), log: () => {} })).rpc,
    'https://rpc.testnet.near.org');
  const mainnetConfig = { ...config, escrow: 'escrow.near', outlayer: 'outlayer.near', secrets_owner: 'sponsor.near' };
  const checkedMainnet = await checkOutlayer({ argv: flags({ ...checkOptions, network: 'mainnet', account: 'ref.near',
    escrow: mainnetConfig.escrow, 'secrets-owner': mainnetConfig.secrets_owner }),
  query: inspectionQuery({ actualConfig: mainnetConfig }), log: () => {} });
  assert.equal(checkedMainnet.rpc, 'https://rpc.mainnet.near.org');
});

test('inspection rejects an unpinned legacy invocation before reading chain state', async () => {
  await assert.rejects(checkOutlayer({ argv: ['--network', 'testnet', '--account', 'ref.testnet'],
    query: inspectionQuery(), log: () => {} }), /required|expected/i);
});

test('inspection fails closed when any deployment expectation is missing', async () => {
  for (const name of ['code-hash', 'escrow', 'wasm-url', 'wasm-hash', 'secrets-owner', 'secrets-profile']) {
    const args = { ...checkOptions }; delete args[name];
    await assert.rejects(checkOutlayer({ argv: flags(args), query: inspectionQuery(), log: () => {} }),
      /required|expected/i, name);
  }
});

test('inspection compares every immutable configuration field and canonical OutLayer account', async () => {
  for (const [field, wrong] of Object.entries({ escrow: 'wrong.testnet', outlayer: 'wrong.testnet',
    wasm_url: 'https://example.org/other.wasm', wasm_hash: 'b'.repeat(64), secrets_owner: 'wrong.testnet', secrets_profile: 'other' })) {
    await assert.rejects(checkOutlayer({ argv: flags(checkOptions),
      query: inspectionQuery({ actualConfig: { ...config, [field]: wrong } }), log: () => {} }), /verification failed/i, field);
  }
  const alternate = { ...config, outlayer: 'alternate.testnet' };
  const result = await checkOutlayer({ argv: flags({ ...checkOptions, outlayer: alternate.outlayer }),
    query: inspectionQuery({ actualConfig: alternate }), log: () => {} });
  assert.equal(result.configMatches, true);
  assert.deepEqual(result.expectedConfig, alternate);
});

test('inspection can pin code through a local WASM and rejects contradictory hashes', async () => {
  await withDeployFixture(async args => {
    const codeHash = baseEncode(createHash('sha256').update(wasm).digest());
    const expected = { ...checkOptions, wasm: args.wasm };
    delete expected['code-hash'];
    const result = await checkOutlayer({ argv: flags(expected), query: inspectionQuery({ codeHash }), log: () => {} });
    assert.equal(result.codeMatches, true);
    assert.equal(result.expectedCodeHash, codeHash);
    await assert.rejects(checkOutlayer({ argv: flags({ ...expected, 'code-hash': 'wrong' }),
      query: inspectionQuery(), log: () => {} }), /disagree/i);
  });
});
