// All requests terminate in this fake. Receipt shapes come from captured native RPC evidence.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { main, judgeOptions, toBase58, MAINNET_ESCROW, ARCHIVAL } from './judge-chain.mjs';

const REFEREE = 'referee.example.near';
const JURY = Buffer.from('fake jury bytes; never downloaded from a network');
const sha = value => createHash('sha256').update(value).digest('hex');
const captured = JSON.parse(readFileSync(new URL('../server/test/fixtures/hosted-court-payout-rpc.json', import.meta.url))).providers[0].responses;
const capturedBet = JSON.parse(Buffer.from(captured.bet.result.result).toString());
const BET = capturedBet.id;
const BEFORE = toBase58(sha('previous block'));
const ESCROW_HASH = '6vSbm6dg1F6gyEggDNtd5t3MrDmGZBgSgE4NjHwEmS33';
const args = ['--outlayer', '--network', 'mainnet', '--referee', REFEREE,
  '--referee-sha256', sha('referee build'), '--jury-sha256', sha(JURY), '--wasm-url', 'https://artifacts.example.org/jury.wasm',
  '--secrets-owner', 'sponsor.near', '--bet-id', BET];

function state() {
  // Start from actual native get_bet + full transaction/receipt graph, changing the deployment identities.
  const tx = JSON.parse(JSON.stringify(captured.approve.result)
    .replaceAll(capturedBet.referee, REFEREE).replaceAll('stated-escrow-52081551be.testnet', MAINNET_ESCROW));
  const receipt = tx.receipts.find(r => r.receipt?.Action?.actions?.[0]?.FunctionCall?.method_name === 'referee_resolve');
  const outcome = tx.receipts_outcome.find(r => r.id === receipt.receipt_id);
  const bet = { ...structuredClone(capturedBet), referee: REFEREE,
    resolution: { ...capturedBet.resolution, resolved_at_ns: '12000' } };
  return { keys: [], codeHash: toBase58(sha('referee build')),
    historicalRefereeKeys: [], historicalRefereeHash: toBase58(sha('referee build')), escrowKeys: [], escrowCodeHash: ESCROW_HASH,
    config: { escrow: MAINNET_ESCROW, outlayer: 'outlayer.near', wasm_url: 'https://artifacts.example.org/jury.wasm',
      wasm_hash: sha(JURY), secrets_owner: 'sponsor.near', secrets_profile: 'jury' },
    bet, oldBet: { ...structuredClone(bet), status: 'accepted', resolution: null },
    ruling: { stage: 'settled', outcome: 'yes', terms_hash: bet.terms_hash },
    tx, receipt, outcome, blockHash: outcome.block_hash, jury: JURY,
    beforeCredits: { [bet.creator]: '7', [bet.acceptor]: '11' },
    afterCredits: { [bet.creator]: String(7n + 2n * BigInt(bet.stake_yocto)), [bet.acceptor]: '11' },
    calls: [], skipped: [],
  };
}

function fake(s) {
  return async (url, init = {}) => {
    s.calls.push({ url, ...(init.body ? JSON.parse(init.body) : {}) });
    if (!init.body) {
      assert.equal(url, 'https://artifacts.example.org/jury.wasm');
      assert.equal(init.redirect, 'error');
      return new Response(s.jury, { status: s.downloadStatus ?? 200 });
    }
    const { method, params } = JSON.parse(init.body);
    assert.ok(['query', 'block', 'EXPERIMENTAL_changes', 'EXPERIMENTAL_receipt', 'EXPERIMENTAL_receipt_to_tx', 'EXPERIMENTAL_tx_status'].includes(method), `read-only method ${method}`);
    if (s.down || method === s.failMethod) return Response.json({ error: { cause: { name: 'UNAVAILABLE' } } });
    let result;
    if (method === 'query') {
      const historical = params.block_id !== undefined;
      if (historical) {
        assert.equal(url, ARCHIVAL.mainnet);
        assert.equal(params.finality, undefined);
        assert.ok([s.blockHash, BEFORE].includes(params.block_id), 'explicit block hash, including skipped predecessor');
      }
      if (params.request_type === 'view_account') result = { code_hash: params.account_id === MAINNET_ESCROW ? s.escrowCodeHash
        : historical ? s.historicalRefereeHash : s.codeHash };
      else if (params.request_type === 'view_access_key_list') result = { keys: params.account_id === MAINNET_ESCROW ? s.escrowKeys
        : historical ? s.historicalRefereeKeys : s.keys };
      else {
        assert.equal(params.request_type, 'call_function');
        const input = JSON.parse(Buffer.from(params.args_base64, 'base64').toString());
        let value;
        if (params.method_name === 'get_config') value = s.config;
        else if (params.method_name === 'get_ruling') { assert.equal(input.bet_id, BET); value = s.ruling; }
        else if (params.method_name === 'get_bet') { assert.equal(input.id, BET); value = params.block_id === BEFORE ? s.oldBet : s.bet; }
        else if (params.method_name === 'get_credit') value = (params.block_id === BEFORE ? s.beforeCredits : s.afterCredits)[input.account_id];
        else assert.fail(`Unexpected view ${params.method_name}`);
        result = { result: [...Buffer.from(JSON.stringify(value))] };
      }
      result.block_hash = s.wrongBlock ? BEFORE : params.block_id;
    } else {
      assert.equal(url, ARCHIVAL.mainnet, 'transactions/discovery use the named archival RPC');
      if (method === 'block') {
        const height = params.finality ? 16 : params.block_id;
        if (s.skipped.includes(height)) return Response.json({ error: { cause: { name: 'UNKNOWN_BLOCK' } } });
        result = { header: { height, timestamp_nanosec: String(height * 1000), hash: height === 12 ? s.blockHash : toBase58(sha(String(height))), prev_hash: BEFORE } };
      } else if (method === 'EXPERIMENTAL_changes') result = { block_hash: s.blockHash,
        changes: [{ cause: { type: 'receipt_processing', receipt_hash: s.receipt.receipt_id } }] };
      else if (method === 'EXPERIMENTAL_receipt') result = s.receipt;
      else if (method === 'EXPERIMENTAL_receipt_to_tx') result = { transaction_hash: s.tx.transaction.hash, sender_account_id: s.tx.transaction.signer_id };
      else if (method === 'EXPERIMENTAL_tx_status') {
        assert.equal(params.wait_until, 'FINAL');
        assert.equal(params.tx_hash, s.tx.transaction.hash);
        assert.equal(params.sender_account_id, s.tx.transaction.signer_id);
        assert.notEqual(params.sender_account_id, REFEREE, 'keyless referee never signs the originating tx');
        result = s.tx;
      }
    }
    return Response.json({ result });
  };
}

async function run(s, flags = args, extra = {}) {
  const lines = [];
  const exit = await main(flags, line => lines.push(line), { fetchImpl: fake(s), sleep: async () => {}, env: {}, ...extra });
  return { lines, exit, failed: lines.filter(line => line.startsWith('FAIL')) };
}

test('OutLayer mainnet: twelve checks, automatic RPC discovery, exact credit deltas', async () => {
  const s = state();
  const result = await run(s);
  assert.equal(result.exit, 0, result.lines.join('\n'));
  assert.equal(result.lines.filter(line => line.startsWith('PASS')).length, 12);
  assert.match(result.lines.join('\n'), /wallet withdrawal not checked/);
  assert.ok(s.calls.some(call => call.method === 'EXPERIMENTAL_receipt_to_tx'));
  assert.equal(s.calls.filter(call => call.params?.method_name === 'get_credit').length, 4);
});

const cases = [
  ['a key present', s => { s.keys.push({ public_key: 'ed25519:fake' }); }, /no access keys/],
  ['referee code hash mismatch', s => { s.codeHash = toBase58(sha('wrong build')); }, /reproducible code hash/],
  ['wrong escrow', s => { s.config.escrow = 'wrong.near'; }, /get_config.escrow/],
  ['wrong OutLayer contract', s => { s.config.outlayer = 'wrong.near'; }, /get_config.outlayer/],
  ['wrong jury URL', s => { s.config.wasm_url = 'https://elsewhere.example.org/jury.wasm'; }, /get_config.wasm_url/],
  ['wrong jury pin', s => { s.config.wasm_hash = sha('wrong jury'); }, /get_config.wasm_hash/],
  ['wrong secrets owner', s => { s.config.secrets_owner = 'wrong.near'; }, /get_config.secrets_owner/],
  ['wrong secrets profile', s => { s.config.secrets_profile = 'other'; }, /get_config.secrets_profile/],
  ['download hash mismatch', s => { s.jury = Buffer.from('tampered'); }, /jury download/],
  ['download HTTP failure', s => { s.downloadStatus = 404; }, /jury download/],
  ['wrong bet referee', s => { s.bet.referee = 'wrong.near'; }, /named referee/],
  ['missing bet', s => { s.bet = null; }, /named referee/],
  ['missing ruling', s => { s.ruling = null; }, /stage and outcome/],
  ['unknown ruling stage', s => { s.ruling.stage = 'invented'; }, /stage and outcome/],
  ['missing ruling outcome field', s => { delete s.ruling.outcome; }, /stage and outcome/],
  ['wrong material commitment', s => { s.ruling.terms_hash = sha('other'); }, /stage and outcome/],
  ['pending settlement', s => { s.bet.status = 'accepted'; s.bet.resolution = null; s.ruling.stage = 'running'; s.ruling.outcome = null; }, /settlement and credited side/],
  ['agreement instead of referee', s => { s.bet.resolution.method = 'agreement'; }, /settlement and credited side/],
  ['escrow outcome differs', s => { s.bet.resolution.outcome = 'no'; }, /settlement and credited side/],
  ['settlement transaction failed', s => { s.tx.status = { Failure: 'failed' }; }, /settlement and credited side/],
  ['settlement not final', s => { s.tx.final_execution_status = 'EXECUTED'; }, /settlement and credited side/],
  ['settlement receipt failed', s => { s.outcome.outcome.status = { Failure: 'failed' }; }, /settlement and credited side/],
  ['contradictory success/failure status', s => { s.tx.status.Failure = 'failed'; }, /settlement and credited side/],
  ['duplicate receipt ID', s => { s.tx.receipts.push(s.receipt); }, /settlement and credited side/],
  ['receipt executor mismatch', s => { s.outcome.outcome.executor_id = 'wrong.near'; }, /settlement and credited side/],
  ['detached successful receipt', s => { s.tx.transaction_outcome.outcome.receipt_ids = []; }, /settlement and credited side/],
  ['wrong predecessor', s => { s.receipt.predecessor_id = 'wrong.near'; }, /settlement and credited side/],
  ['receipt in another block', s => { s.outcome.block_hash = BEFORE; }, /settlement and credited side/],
  ['historical block not honored', s => { s.wrongBlock = true; }, /settlement and credited side/],
  ['already settled before receipt', s => { s.oldBet.status = 'settled'; }, /settlement and credited side/],
  ['payout to wrong side', s => {
    s.afterCredits[s.bet.creator] = s.beforeCredits[s.bet.creator];
    s.afterCredits[s.bet.acceptor] = String(BigInt(s.beforeCredits[s.bet.acceptor]) + 2n * BigInt(s.bet.stake_yocto));
  }, /settlement and credited side/],
  ['wrong payout amount', s => { s.afterCredits[s.bet.creator] = '8'; }, /settlement and credited side/],
  ['historical referee had a key despite being keyless now', s => { s.historicalRefereeKeys = [{ public_key: 'ed25519:fake' }]; }, /settlement and credited side/],
  ['historical referee used different code', s => { s.historicalRefereeHash = toBase58(sha('manual settlement')); }, /settlement and credited side/],
  ['escrow views match but historical code is wrong', s => { s.escrowCodeHash = toBase58(sha('fabricated credit views')); }, /settlement and credited side/],
  ['escrow had an access key', s => { s.escrowKeys = [{ public_key: 'ed25519:fake' }]; }, /settlement and credited side/],
  ['archival transaction unavailable', s => { s.failMethod = 'EXPERIMENTAL_tx_status'; }, /settlement and credited side/],
  ['receipt origin unsupported', s => { s.failMethod = 'EXPERIMENTAL_receipt_to_tx'; }, /settlement and credited side/],
];
for (const [name, mutate, expected] of cases) test(`OutLayer FAIL: ${name}`, async () => {
  const s = state(); mutate(s);
  const result = await run(s);
  assert.equal(result.exit, 1, result.lines.join('\n'));
  assert.ok(result.failed.some(line => expected.test(line)), result.lines.join('\n'));
});

test('settlement lookup accepts original tx+signer when receipt discovery is unsupported', async () => {
  const s = state(); s.failMethod = 'EXPERIMENTAL_receipt_to_tx';
  const result = await run(s, [...args, '--settlement-tx', s.tx.transaction.hash, '--settlement-signer', s.tx.transaction.signer_id]);
  assert.equal(result.exit, 0, result.lines.join('\n'));
  assert.ok(!s.calls.some(call => call.method === 'EXPERIMENTAL_receipt_to_tx'));
});

for (const outcome of ['no', 'void']) test(`${outcome}: credit the acceptor or refund both sides`, async () => {
  const s = state(); s.bet.resolution.outcome = outcome; s.ruling.outcome = outcome;
  s.receipt.receipt.Action.actions[0].FunctionCall.args = Buffer.from(JSON.stringify({ id: BET, outcome })).toString('base64');
  const stake = BigInt(s.bet.stake_yocto);
  s.afterCredits[s.bet.creator] = String(7n + (outcome === 'void' ? stake : 0n));
  s.afterCredits[s.bet.acceptor] = String(11n + (outcome === 'void' ? stake : 2n * stake));
  const result = await run(s);
  assert.equal(result.exit, 0, result.lines.join('\n'));
});

test('block search tolerates skipped heights and uses prev_hash for historical state', async () => {
  const s = state(); s.skipped = [8, 9, 11];
  const result = await run(s);
  assert.equal(result.exit, 0, result.lines.join('\n'));
});

test('deployment-only run omits bet/settlement requests and labels saved scope', async () => {
  const s = state();
  const dir = mkdtempSync(join(tmpdir(), 'judge-save-'));
  try {
    const file = join(dir, 'pass.json');
    const result = await run(s, [...args.slice(0, -2), '--save', file]);
    assert.equal(result.exit, 0, result.lines.join('\n'));
    const report = JSON.parse(readFileSync(file));
    assert.equal(report.overall, 'PASS');
    assert.match(report.scope, /deployment only/);
    assert.equal(report.results.length, 9);
    assert.ok(!s.calls.some(call => ['get_bet', 'get_ruling'].includes(call.params?.method_name)));
    assert.ok(!JSON.stringify(report).includes(dir));
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('save records real FAIL results with no local paths, usernames, argv or environment', async () => {
  const s = state(); s.codeHash = 'wrong';
  const dir = mkdtempSync(join(tmpdir(), 'judge-save-'));
  try {
    const file = join(dir, 'fail.json');
    const result = await run(s, [...args, '--save', file], { env: { UNRELATED: 'private-username' } });
    assert.equal(result.exit, 1);
    const text = readFileSync(file, 'utf8');
    const report = JSON.parse(text);
    assert.equal(report.overall, 'FAIL');
    assert.equal(report.results.length, 12);
    assert.doesNotMatch(text, /private-username|judge-save-|\/Users\/|\/tmp\/|argv|environment/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('save failure returns nonzero, even when all checks passed', async () => {
  const result = await run(state(), [...args, '--save', '/nonexistent-parent-judge/result.json']);
  assert.equal(result.exit, 1);
  assert.match(result.lines.at(-1), /could not save/);
});

test('invalid configuration still saves a FAIL without making a request', async () => {
  const s = state();
  const dir = mkdtempSync(join(tmpdir(), 'judge-save-'));
  try {
    const file = join(dir, 'invalid.json');
    const result = await run(s, ['--outlayer', '--save', file]);
    assert.equal(result.exit, 1);
    assert.equal(s.calls.length, 0);
    const report = JSON.parse(readFileSync(file));
    assert.equal(report.overall, 'FAIL');
    assert.match(report.scope, /no chain checks run/);
  } finally { rmSync(dir, { recursive: true, force: true }); }
});

test('CLI validates configuration before any request; environment and flags share names', async () => {
  const invalid = [args.slice(0, 1), [...args, '--network', 'unknown'], [...args, '--referee-sha256', 'invalid'],
    [...args, '--wasm-url', 'file:///private/file'], [...args, '--secrets-owner', '../local'], [...args, '--unknown'], [...args, '--save']];
  for (const flags of invalid) {
    const s = state(); const result = await run(s, flags);
    assert.equal(result.exit, 1);
    assert.equal(s.calls.length, 0);
  }
  const env = { JUDGE_REFEREE: REFEREE, JUDGE_REFEREE_SHA256: sha('referee build'), JUDGE_JURY_SHA256: sha(JURY),
    JUDGE_WASM_URL: 'https://artifacts.example.org/jury.wasm', JUDGE_SECRETS_OWNER: 'sponsor.near', JUDGE_BET_ID: BET };
  const result = await run(state(), ['--outlayer'], { env });
  assert.equal(result.exit, 0, result.lines.join('\n'));
  assert.equal(judgeOptions(['--outlayer', '--secrets-profile', 'override'], env).secretsProfile, 'override');
});

test('base58 preserves leading zero bytes in SHA-256', () => {
  assert.equal(toBase58('00'.repeat(32)), '1'.repeat(32));
  assert.equal(toBase58(`${'00'.repeat(31)}01`), `${'1'.repeat(31)}2`);
});
