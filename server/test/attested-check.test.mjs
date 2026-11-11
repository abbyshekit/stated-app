// INTEGRATION: loopback transport and database doubles exercise public-only checks.
// Synthetic quotes validate evidence shape only; no test claims hardware verification.
import assert from 'node:assert/strict';
import { generateKeyPairSync, sign } from 'node:crypto';
import { createServer } from 'node:http';
import { spawn } from 'node:child_process';
import { test } from 'node:test';
import { runAttestedCheck } from '../src/attested-check.mjs';
import { sha256, verifyAttestedRecord } from '../src/attested-signature.mjs';
import { verifyHostedCheck } from '../../scripts/verify-attested-check.mjs';
import { safeFetch } from '../src/articles.mjs';

const CLI = new URL('../../scripts/verify-attested-check.mjs', import.meta.url).pathname;
const BET = '0edb1716-79db-4cca-b795-d4b91cfc6b41';
const TRANSACTION = '11111111111111111111111111111111';
const MODEL = 'near/synthetic-test';
const PRIVATE_NOTE = 'PRIVATE_PROPOSAL_SENTINEL_DO_NOT_TRANSMIT';
const VERDICT = { agrees: true, reason: 'The published official result supports the recorded outcome before its deadline.' };
const ARTICLE = 'The official evidence confirms that the event occurred before the stated deadline. '.repeat(100);
const ns = (value) => (BigInt(new Date(value).getTime()) * 1000000n).toString();

function keys() {
  const pair = generateKeyPairSync('ed25519');
  return { ...pair, address: pair.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex') };
}

function report(nonce, address) {
  return { signing_algo: 'ed25519', signing_address: address, request_nonce: nonce,
    intel_quote: 'abcd', event_log: '[]' };
}

function signature(key, request, response, kind = 'provider_tee') {
  const text = `${MODEL}:${sha256(request)}:${sha256(response)}`;
  return { text, signature: sign(null, Buffer.from(text), key.privateKey).toString('hex'),
    signing_address: key.address, signing_algo: 'ed25519', signature_kind: kind };
}

function standaloneRecord() {
  const key = keys();
  const nonce = 'ab'.repeat(32);
  const request = Buffer.from(JSON.stringify({ model: MODEL, messages: [] }));
  const response = Buffer.from(JSON.stringify({ id: 'chat-fixture', choices: [{ message: { content: JSON.stringify(VERDICT) } }] }));
  return { model: MODEL, requestBody: request.toString('base64'), responseBody: response.toString('base64'),
    requestHash: sha256(request), responseHash: sha256(response), completionId: 'chat-fixture',
    signature: signature(key, request, response), nonce,
    attestation: { gateway_attestation: report(nonce, key.address), model_attestations: [report(nonce, key.address)] },
    startedAt: '2026-11-11T00:00:00.000Z', attestedAt: '2026-11-11T00:00:01.000Z',
    completedAt: '2026-11-11T00:00:02.000Z', verdict: { ...VERDICT } };
}

function database() {
  const acceptBy = '2026-10-01T00:00:00.000Z';
  const resolveAt = '2026-10-02T00:00:00.000Z';
  const row = { id: BET, creator_user_id: '1', acceptor_user_id: '2', invited_user_id: null,
    claim: 'The event will occur.', criteria: 'The official result before the deadline.',
    evidence_source_url: 'https://public.example.org/result', creator_side: 'yes', stake_yocto: '100000000000000000000000',
    accept_by: acceptBy, resolve_at: resolveAt, created_at: '2026-09-30T00:00:00.000Z',
    accepted_at: acceptBy, settled_at: '2026-10-03T00:00:00.000Z',
    creator_wallet: 'creator.testnet', acceptor_wallet: 'acceptor.testnet', invited_wallet: null,
    referee_wallet: 'referee.testnet', terms_hash: 'a'.repeat(64), near_height: '321',
    near_verified_at: '2026-11-11T00:00:00.000Z', read_at: '2026-11-11T00:00:01.000Z',
    published_at: '2026-10-03T00:00:00.000Z', creator_username: 'public_creator', acceptor_username: 'public_acceptor',
    creator_bound: true, acceptor_bound: true, acceptor_consented: true, follower_count: '0' };
  row.chain_state = { id: BET, creator: row.creator_wallet, creator_binding_hash: 'b'.repeat(64),
    acceptor: row.acceptor_wallet, acceptor_binding_hash: 'c'.repeat(64), status: 'settled',
    terms_hash: row.terms_hash, stake_yocto: row.stake_yocto, creator_side: 'yes',
    accept_by_ns: ns(acceptBy), resolve_at_ns: ns(resolveAt), invited_account: null,
    referee: row.referee_wallet, resolution: { outcome: 'yes', method: 'referee' } };
  const state = { row, privateProposal: { note: PRIVATE_NOTE }, checks: [], sql: [] };
  function inspect(sql) {
    state.sql.push(sql);
    assert.doesNotMatch(sql, /bilateral_bet_proposals|\bnote\b/i, 'private proposal content cannot be queried');
  }
  const tx = {
    async one(sql, args) {
      inspect(sql);
      if (/select id from bilateral_bets .*for update/s.test(sql)) return { id: BET };
      if (/select b\.id, b\.creator_user_id/s.test(sql)) return structuredClone(row);
      if (/kind='referee_resolved'/.test(sql)) return { hash: TRANSACTION };
      if (/kind='public_result_evidence'/.test(sql)) return { at: '2026-10-03T00:00:00.000Z', detail: {
        outcome: 'yes', referee: row.referee_wallet, transactionHash: TRANSACTION,
        note: 'The official result supports yes.', url: 'https://public.example.org/result',
        knownAt: '2026-10-02T00:00:00.000Z' } };
      if (/kind='attested_check'/.test(sql)) return state.checks.length ? { detail: structuredClone(state.checks[0]) } : null;
      throw new Error(`Unexpected SQL: ${sql}`);
    },
    async query(sql, args) {
      inspect(sql);
      if (/^set local /.test(sql)) return;
      if (/insert into bilateral_bet_events/.test(sql) && /'attested_check'/.test(sql)) {
        assert.deepEqual(args.slice(0, 2), [BET, '3']);
        assert.equal(state.checks.length, 0, 'the first immutable event wins');
        state.checks.push(structuredClone(args[2]));
        return;
      }
      throw new Error(`Unexpected SQL: ${sql}`);
    },
  };
  return { state, async tx(fn) {
    const before = structuredClone(state.checks);
    try { return await fn(tx); } catch (error) { state.checks = before; throw error; }
  } };
}

async function fakeNear(t, { mode = 'success', reason = VERDICT.reason } = {}) {
  const key = keys();
  const seen = { attestation: 0, completion: 0, signature: 0, evidence: 0, request: null };
  let response;
  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://127.0.0.1');
      res.setHeader('content-type', 'application/json');
      if (url.pathname === '/v1/attestation/report') {
        seen.attestation += 1;
        assert.equal(url.searchParams.get('model'), MODEL);
        assert.equal(url.searchParams.get('provider'), 'near');
        assert.equal(url.searchParams.get('signing_algo'), 'ed25519');
        assert.equal(req.headers['x-no-aliasing'], 'true');
        const nonce = mode === 'bad-preflight' ? '00'.repeat(32) : url.searchParams.get('nonce');
        res.end(JSON.stringify({ gateway_attestation: report(nonce, key.address), model_attestations: [report(nonce, key.address)] }));
      } else if (url.pathname === '/v1/chat/completions') {
        seen.completion += 1;
        const chunks = [];
        for await (const chunk of req) chunks.push(chunk);
        seen.request = Buffer.concat(chunks);
        assert.equal(req.headers['accept-encoding'], 'identity');
        assert.equal(req.headers['x-no-aliasing'], 'true');
        if (mode === 'deadline') return;
        if (mode === 'api-failure') { res.statusCode = 503; res.end('{}'); return; }
        response = Buffer.from(JSON.stringify({ id: 'chat-test', choices: [{ message: { content: JSON.stringify({ agrees: true, reason }) } }] }));
        res.end(response);
      } else if (url.pathname === '/v1/signature/chat-test') {
        seen.signature += 1;
        assert.equal(url.searchParams.get('signing_algo'), 'ed25519');
        const proof = signature(key, seen.request, response, mode === 'gateway' ? 'gateway' : 'provider_tee');
        if (mode === 'tamper') proof.signature = '00'.repeat(64);
        res.end(JSON.stringify(proof));
      } else { res.statusCode = 404; res.end('{}'); }
    } catch (error) {
      seen.error = error;
      res.statusCode = 500;
      res.end('{}');
    }
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
    if (seen.error) throw seen.error;
  });
  const config = { nearai: { apiKey: 'synthetic-test-key', model: MODEL,
    baseUrl: `http://127.0.0.1:${server.address().port}/v1` }, fetch: { allowLoopback: true } };
  const fetchEvidence = async (url) => {
    seen.evidence += 1;
    assert.equal(url, 'https://public.example.org/result');
    return { url, body: `<article><p>${ARTICLE}</p></article>` };
  };
  return { config, seen, fetchEvidence };
}

test('the check stores one public-only immutable event and replays without fetching', async (t) => {
  const near = await fakeNear(t);
  const db = database();
  const record = await runAttestedCheck(db, near.config, BET, '3', { fetchEvidence: near.fetchEvidence });
  assert.equal(db.state.checks.length, 1);
  assert.deepEqual(record, db.state.checks[0]);
  assert.equal(verifyAttestedRecord(record).hardwareAttestation, 'not_verified');
  const request = JSON.parse(near.seen.request);
  const content = JSON.parse(request.messages[1].content);
  assert.equal(content.evidenceText.length, 6000);
  assert.equal(record.evidenceTextHash, sha256(Buffer.from(content.evidenceText)));
  assert.equal(content.evidenceText, ARTICLE.trim().slice(0, 6000));
  assert.equal(content.claim, db.state.row.claim);
  assert.equal(content.outcome, 'yes');
  assert.doesNotMatch(near.seen.request.toString('utf8'), new RegExp(PRIVATE_NOTE));
  assert.ok(db.state.sql.some((sql) => /for update/.test(sql)));
  const counts = { ...near.seen };
  record.verdict.reason = 'Caller mutation';
  const replay = await runAttestedCheck(db, near.config, BET, '3', { fetchEvidence: near.fetchEvidence });
  assert.deepEqual(replay, db.state.checks[0]);
  assert.equal(replay.verdict.reason, VERDICT.reason);
  for (const key of ['attestation', 'completion', 'signature', 'evidence']) assert.equal(near.seen[key], counts[key]);
  assert.equal(db.state.checks.length, 1);
});

test('a missing key never calls the database or inference', async () => {
  await assert.rejects(runAttestedCheck({ tx() { throw new Error('must not read'); } },
    { nearai: { apiKey: '' } }, BET, '3'), error => error.status === 404);
});

test('evidence fetch keeps private-address guards and accepts caller cancellation', async (t) => {
  await assert.rejects(safeFetch('http://127.0.0.1/evidence'), /private network/);
  const server = createServer(() => {});
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise(resolve => server.close(resolve));
  });
  await assert.rejects(safeFetch(`http://127.0.0.1:${server.address().port}/evidence`, {
    allowLoopback: true, signal: AbortSignal.timeout(50),
  }), error => error.name === 'AbortError');
});

for (const mode of ['api-failure', 'tamper', 'gateway', 'bad-preflight']) {
  test(`${mode} cannot persist a check`, async (t) => {
    const near = await fakeNear(t, { mode });
    const db = database();
    await assert.rejects(runAttestedCheck(db, near.config, BET, '3', { fetchEvidence: near.fetchEvidence }), (error) => error.status === 502);
    assert.equal(db.state.checks.length, 0);
    if (mode === 'bad-preflight') assert.equal(near.seen.completion, 0);
  });
}

test('a completion exceeding its abort deadline cannot persist a check', async (t) => {
  const near = await fakeNear(t, { mode: 'deadline' });
  const db = database();
  await assert.rejects(runAttestedCheck(db, near.config, BET, '3', {
    fetchEvidence: near.fetchEvidence, signal: AbortSignal.timeout(100),
  }), (error) => error.status === 502);
  assert.equal(db.state.checks.length, 0);
  assert.equal(near.seen.completion, 1);
  assert.equal(near.seen.signature, 0);
});

test('a verdict beyond forty words cannot persist a check', async (t) => {
  const near = await fakeNear(t, { reason: Array(41).fill('word').join(' ') });
  const db = database();
  await assert.rejects(runAttestedCheck(db, near.config, BET, '3', { fetchEvidence: near.fetchEvidence }), (error) => error.status === 502);
  assert.equal(db.state.checks.length, 0);
});

test('the standalone verifier accepts signed bytes and rejects a changed response byte', () => {
  const record = standaloneRecord();
  assert.deepEqual(verifyAttestedRecord(record), { requestHash: true, responseHash: true,
    signature: true, modelSigner: true, hardwareAttestation: 'not_verified' });
  const bytes = Buffer.from(record.responseBody, 'base64');
  bytes[10] ^= 1;
  record.responseBody = bytes.toString('base64');
  assert.throws(() => verifyAttestedRecord(record), /responseHash/);
});

async function cli(base) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [CLI, base, BET], { stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk) => { stdout += chunk; });
    child.stderr.on('data', (chunk) => { stderr += chunk; });
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
  });
}

test('hosted verifier and CLI distinguish valid, mismatched and unavailable records', async (t) => {
  let mode = 'valid';
  const record = standaloneRecord();
  const server = createServer((req, res) => {
    assert.equal(req.url, `/bets/${BET}/attested-check.json`);
    res.setHeader('content-type', 'application/json');
    if (mode === 'unavailable') { res.statusCode = 404; res.end('{}'); return; }
    const value = structuredClone(record);
    if (mode === 'mismatch') value.responseHash = '00'.repeat(32);
    res.end(JSON.stringify(value));
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  t.after(async () => {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  for (const [scenario, expected] of [['valid', 0], ['mismatch', 1], ['unavailable', 2]]) {
    mode = scenario;
    const hosted = await verifyHostedCheck(base, BET);
    assert.equal(hosted.exitCode, expected);
    const child = await cli(base);
    assert.equal(child.code, expected, child.stderr);
    assert.equal(JSON.parse(child.stdout).pass, expected === 0);
    if (expected === 0) assert.equal(JSON.parse(child.stdout).hardwareAttestation, 'not_verified');
  }
});

test('the verifier bounds streaming downloads and distinguishes an interrupted body', async () => {
  let chunks = 0;
  const oversized = new ReadableStream({
    pull(controller) { chunks += 1; controller.enqueue(new Uint8Array(1_000_000)); },
  });
  const large = await verifyHostedCheck('https://example.org', BET, {
    fetchImpl: async () => new Response(oversized),
  });
  assert.equal(large.exitCode, 1);
  assert.ok(chunks <= 7, `stopped after ${chunks} chunks`);
  const interrupted = await verifyHostedCheck('https://example.org', BET, {
    fetchImpl: async () => new Response(new ReadableStream({ start(controller) { controller.error(new Error('Socket closed')); } })),
  });
  assert.equal(interrupted.exitCode, 2);
  assert.equal(interrupted.report.unavailable, true);
});
