// Real PostgreSQL and production HTTP routes; inference/evidence are synthetic.
import assert from 'node:assert/strict';
import { generateKeyPairSync, randomUUID, sign } from 'node:crypto';
import { before, after, beforeEach, test } from 'node:test';
import { createBet } from '../src/bets.mjs';
import { readPublicBet, publishBet, withdrawBetPublication } from '../src/bet-public.mjs';
import { publishPublicResultEvidence } from '../src/bet-result-evidence.mjs';
import { runAttestedCheck } from '../src/attested-check.mjs';
import { sha256 } from '../src/attested-signature.mjs';
import { completeSetup, signInFromX } from '../src/store.mjs';
import { startStack } from './support/app.mjs';
import { resetDb } from './support/pg.mjs';
import { testReport } from './support/enclave.mjs';

let s, creator, bet, admin, stranger;
const SENTINEL = 'PRIVATE_PROPOSAL_NOTE_NEVER_PUBLIC';
const ns = value => (BigInt(new Date(value).getTime()) * 1000000n).toString();
before(async () => { s = await startStack({ NEARAI_API_KEY: 'synthetic-test-key' }); });
after(async () => { await s?.close(); });
beforeEach(async () => {
  await resetDb(s.db);
  s.config.nearai.apiKey = 'synthetic-test-key';
  creator = await completeSetup(s.db, await signInFromX(s.db, { id: '1901', username: 'public_bettor' }), { profileVisibility: 'private' });
  const other = await completeSetup(s.db, await signInFromX(s.db, { id: '1902', username: 'other_bettor' }), { profileVisibility: 'private' });
  admin = await s.signIn(s.fakeX.addUser('900', 'check_reviewer'));
  stranger = await s.signIn(s.fakeX.addUser('1903', 'check_stranger'));
  bet = await createBet(s.db, creator, { requestId: randomUUID(), claim: 'The public event will occur.', criteria: 'The official result.',
    evidenceSourceUrl: 'https://example.org/result', creatorSide: 'yes', stakeNear: '0.1', refereeAccount: 'referee.testnet',
    acceptBy: new Date(Date.now() + 86400000).toISOString(), resolveAt: new Date(Date.now() + 172800000).toISOString() });
  const binding = 'a'.repeat(64);
  const chain = { id: bet.id, terms_hash: bet.terms_hash, stake_yocto: bet.stake_yocto, creator_side: 'yes',
    accept_by_ns: ns(bet.accept_by), resolve_at_ns: ns(bet.resolve_at), invited_account: null, referee: 'referee.testnet',
    creator: 'creator.testnet', creator_binding_hash: binding, status: 'settled', acceptor: 'other.testnet',
    acceptor_binding_hash: 'b'.repeat(64), resolution: { outcome: 'yes', method: 'referee' } };
  await s.db.query(`insert into bilateral_near_requests (id,bet_id,user_id,wallet_account,method,args,binding_hash)
    values ($1,$2,$3,'creator.testnet','create_bet','{}',$4)`, [randomUUID(), bet.id, creator.id, binding]);
  await s.db.query(`update bilateral_bets set chain_state=$2,creator_wallet='creator.testnet',acceptor_wallet='other.testnet',
    acceptor_user_id=$3,status='settled',outcome='yes',settled_at=clock_timestamp(),near_height=321,near_verified_at=clock_timestamp()
    where id=$1`, [bet.id, chain, other.id]);
  await s.db.query(`insert into bilateral_bet_events (bet_id,actor_user_id,kind,detail) values ($1,$2,'referee_resolved',$3)`,
    [bet.id, creator.id, { outcome: 'yes', referee: 'referee.testnet', transactionHash: '11111111111111111111111111111111' }]);
  await s.db.query(`insert into bilateral_bet_proposals (id,bet_id,revision,proposer_user_id,outcome,evidence_url,note)
    values ($1,$2,1,$3,'yes','https://private.example.org/note',$4)`, [randomUUID(), bet.id, creator.id, SENTINEL]);
  await publishBet(s.db, creator, bet.id);
});

const evidencePath = () => `/admin/bets/${bet.id}/evidence`;
const triggerPath = () => `/admin/bets/${bet.id}/attested-check`;
const jsonPath = () => `/bets/${bet.id}/attested-check.json`;
const checks = async () => (await s.db.one(`select count(*)::int as n from bilateral_bet_events where kind='attested_check'`)).n;

async function publishEvidence() {
  const reviewer = await s.db.one("select id from users where x_user_id='900'");
  await s.db.tx(async tx => {
    await tx.one('select id from bilateral_bets where id=$1 for update', [bet.id]);
    await publishPublicResultEvidence(tx, reviewer.id, await readPublicBet(tx, bet.id), {
      note: 'The official public result confirms the event.', url: 'https://example.org/result',
      knownAt: new Date(Date.now() - 60000).toISOString(),
    });
  });
  return reviewer.id;
}

test('admin-only POST requires CSRF and published evidence; GET never triggers', async () => {
  assert.equal((await s.browser().get(triggerPath())).status, 404);
  assert.equal((await admin.get(triggerPath())).status, 404);
  assert.equal((await stranger.submit(triggerPath())).status, 404);
  assert.equal((await admin.request('POST', triggerPath(), { form: {} })).status, 403);
  const page = await admin.submit(triggerPath(), {}, { from: evidencePath() });
  assert.equal(page.status, 409);
  assert.match(page.text, /class="err" role="alert"/);
  assert.doesNotMatch(page.text, /Run enclave check/);
  assert.equal(await checks(), 0);
});

test('a saved signed check renders publicly, excludes private notes, and the admin replay calls no API', async () => {
  const reviewer = await publishEvidence();
  assert.match((await admin.get(evidencePath())).text, /Run enclave check/);
  const key = generateKeyPairSync('ed25519');
  const address = key.publicKey.export({ type: 'spki', format: 'der' }).subarray(-32).toString('hex');
  let request, response, calls = 0;
  const record = await runAttestedCheck(s.db, s.config, bet.id, reviewer, {
    fetchEvidence: async url => ({ url, body: '<article><p>The public official result confirms the event occurred.</p></article>' }),
    fetchImpl: async (url, options) => {
      calls += 1;
      if (url.includes('/attestation/report?')) {
        const nonce = new URL(url).searchParams.get('nonce');
        const report = testReport(nonce, address);
        return Response.json({ gateway_attestation: report, model_attestations: [report] });
      }
      if (url.endsWith('/chat/completions')) {
        request = Buffer.from(options.body);
        response = Buffer.from(JSON.stringify({ id: 'chat-pages', choices: [{ message: { content: JSON.stringify({ agrees: false, reason: 'The evidence needs a dated official result.' }) } }] }));
        return new Response(response);
      }
      const text = `${s.config.nearai.model}:${sha256(request)}:${sha256(response)}`;
      return Response.json({ signature_kind: 'provider_tee', signing_algo: 'ed25519', signing_address: address,
        text, signature: sign(null, Buffer.from(text), key.privateKey).toString('hex') });
    },
  });
  assert.equal(await checks(), 1);
  assert.equal(calls, 3);
  assert.doesNotMatch(request.toString(), new RegExp(SENTINEL));
  const page = await s.browser().get(`/bets/${bet.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /NEAR AI signed second opinion:.*disagrees/);
  assert.match(page.text, new RegExp(`href="${jsonPath()}"`));
  assert.doesNotMatch(page.text, new RegExp(`${SENTINEL}|private.example.org`));
  const json = await s.browser().get(jsonPath());
  assert.equal(json.status, 200);
  assert.match(json.headers.get('content-type'), /application\/json/);
  assert.equal(JSON.parse(json.text).requestBody, record.requestBody);
  assert.doesNotMatch(Buffer.from(JSON.parse(json.text).requestBody, 'base64').toString(), new RegExp(SENTINEL));
  assert.doesNotMatch(Buffer.from(JSON.parse(json.text).responseBody, 'base64').toString(), new RegExp(SENTINEL));
  assert.doesNotMatch(json.text, new RegExp(SENTINEL));
  assert.doesNotMatch((await admin.get(evidencePath())).text, /Run enclave check/);
  assert.equal((await admin.submit(triggerPath(), {}, { from: evidencePath() })).status, 200);
  assert.equal(await checks(), 1);
  s.config.nearai.apiKey = '';
  assert.doesNotMatch((await s.browser().get(`/bets/${bet.id}`)).text, /signed second opinion|attested-check.json/);
  assert.doesNotMatch((await admin.get(evidencePath())).text, /Run enclave check/);
  assert.equal((await s.browser().get(jsonPath())).status, 404);
  s.config.nearai.apiKey = 'synthetic-test-key';
  await withdrawBetPublication(s.db, creator, bet.id);
  assert.equal((await s.browser().get(jsonPath())).status, 404);
});
