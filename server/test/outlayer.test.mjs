import test, { before, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startStack } from './support/app.mjs';
import { FakeOutLayerNear, outlayerDeadlineMs } from './support/fake-outlayer.mjs';
import { enclaveEnv, fakeNearAi } from './support/enclave.mjs';
import { createBet } from '../src/bets.mjs';
import { completeSetup, signInFromX } from '../src/store.mjs';
import { ensurePlayAccount, playAction } from '../src/play.mjs';
import { ensureOutlayerRegistration, makeOutlayerMaterial, outlayerReadyAt, outlayerTermsHash, readOutlayerRuling, runOutlayerKeeper } from '../src/outlayer.mjs';
import { evidencePrompts, submitEvidence, runEvidenceCommands } from '../src/bet-evidence.mjs';
import { consentToPublicBet, publishBet, publicBet } from '../src/bet-public.mjs';
import { rulingOnEvidence } from '../src/settlement-view.mjs';
import { loadConfig } from '../src/config.mjs';
import { verifyBetTransaction } from '../src/near-execution-state.mjs';
import { runBetCommands, queueBetCommand, say } from '../src/reply-bets.mjs';
import { tick } from '../src/worker.mjs';
import { InvalidNonceError } from 'near-api-js/rpc-errors';
import { outlayerTestFetch } from './support/outlayer-fetch.mjs';

let s; let near; let alice; let bob; let outsider; let sequence = 0;
const ai = fakeNearAi({ respond: ({ input }) => /NEAR trades/.test(input.claim)
  ? { source: 'coinbase-candles', product: 'NEAR-USD', kind: 'moment', at: input.deadline } : { source: 'evidence' } });
const fetchImpl = outlayerTestFetch({ ai, near: () => near, xBase: () => s?.fakeX.base });
const options = () => ({ config: s.config, chain: near.chain, fetchImpl });
const keeper = (now = Date.now()) => runOutlayerKeeper(s.db, s.config, { chain: near.chain, fetchImpl, now });
async function setupStack() {
  near = new FakeOutLayerNear();
  const { STATED_ENCLAVE_RULINGS: _disabled, ...plannerEnv } = enclaveEnv;
  s = await startStack({ ...plannerEnv, STATED_NEAR_CONTRACT: near.contract, STATED_OUTLAYER_REFEREE: near.referee,
    STATED_PLAY: '1', STATED_PLAY_AUTOPROVISION: '1', STATED_REPUTATION_TIERS: 'off', STATED_EVIDENCE_WINDOW_SECONDS: '120' },
  { chain: near.chain, fetchImpl });
  sequence += 1;
  for (const [index, name] of [[1,'alice'],[2,'bob'],[3,'other']]) {
    const id = String(710000 + sequence * 10 + index); const username = `out_${name}${sequence}`;
    s.fakeX.addUser(id, username);
    const user = await completeSetup(s.db, await signInFromX(s.db, { id, username }), {});
    await ensurePlayAccount(s.db, s.config, near.chain, { xUserId: id, username });
    if (index === 1) alice = user;
    else if (index === 2) bob = user;
    else outsider = user;
  }
}
// Fail once at setup if PostgreSQL is unavailable; each runnable test still owns
// a fresh database, chain and pair of bettors, including after an assertion fails.
before(setupStack);
beforeEach(async () => { if (!s) await setupStack(); });
afterEach(async () => { await s?.close(); s = null; });

const terms = (extra = {}) => ({ requestId: randomUUID(), claim: 'Nightjar ships a stable release.',
  criteria: 'Yes if the stable release ships before the deadline.', evidenceSourceUrl: 'https://www.sec.gov/newsroom',
  creatorSide: 'yes', stakeNear: '0.1', acceptBy: new Date(Date.now() + 600000).toISOString(),
  resolveAt: new Date(Date.now() + 1200000).toISOString(), ...extra });

async function sourceTerms(extra = {}) {
  const input = terms(extra);
  const post = s.fakeX.post(alice.x_user_id, input.claim);
  const url = `https://x.com/${alice.x_username}/status/${post.id}`;
  const source = await s.db.one(`insert into sources (platform,platform_id,url,text,author_x_user_id,author_username,acquisition)
    values ('x',$1,$2,$3,$4,$5,'mention') returning id`, [post.id, url, input.claim, alice.x_user_id, alice.x_username]);
  const statement = await s.db.one(`insert into statements (source_id,span,speaker,speaker_x_user_id)
    values ($1,$2,$3,$4) returning id`, [source.id, input.claim, alice.x_username, alice.x_user_id]);
  const save = await s.db.one(`insert into saves (owner_x_user_id,owner_user_id,statement_id,relation,intake)
    values ($1,$2,$3,'mine','mention') returning id`, [alice.x_user_id, alice.id, statement.id]);
  return { ...input, evidenceSourceUrl: url, sourceSaveId: String(save.id) };
}

async function funded(extra = {}) {
  let bet = await createBet(s.db, alice, await sourceTerms(extra), options());
  ({ bet } = await playAction(s.db, s.config, near.chain, alice, bet.id, { action: 'fund' }, { fetchImpl }));
  ({ bet } = await playAction(s.db, s.config, near.chain, bob, bet.id, { action: 'accept', termsHash: bet.terms_hash }, { fetchImpl }));
  return bet;
}

test('OutLayer config fails closed on malformed or wrong-network accounts', () => {
  assert.equal(loadConfig({ STATED_OUTLAYER_REFEREE: 'ref.testnet' }).outlayer.referee, 'ref.testnet');
  for (const value of ['ref.near','Bad.testnet','bad..testnet','a']) assert.throws(() => loadConfig({ STATED_OUTLAYER_REFEREE: value }), /STATED_OUTLAYER_REFEREE/);
});

test('planner commits explicit Coinbase, Open and Submitted plans', () => {
  const base = { id: randomUUID(), claim: 'NEAR trades above US$3.30', madeAt: '2026-11-12T18:00:00.000Z',
    deadline: '2026-11-12T19:15:00.000Z', postUrl: 'https://x.com/ChainAbstracted/status/2120000000000000000' };
  const price = makeOutlayerMaterial({ ...base, plan: { source: 'coinbase-candles', product: 'NEAR-USD', kind: 'moment', at: base.deadline } }, s.config, {});
  assert.deepEqual(price.evidence, { kind: 'coinbase', product: 'NEAR-USD', window: { kind: 'moment', at: base.deadline } });
  const evidence = { ...base, claim: 'Nightjar ships.', postUrl: 'https://www.sec.gov/newsroom', creatorSide: 'yes', plan: { source: 'evidence' } };
  const open = makeOutlayerMaterial(evidence, s.config, { supports_open_evidence: true });
  assert.deepEqual(open.evidence, { kind: 'open', window_seconds: 120, max_per_side: 2 });
  for (const plan of [evidence.plan, { source: 'coinbase-candles', product: 'NEAR-USD', kind: 'moment', at: base.deadline }]) {
    const chosen = makeOutlayerMaterial({ ...base, creatorSide: 'yes', evidenceSourceUrl: evidence.postUrl, plan }, s.config,
      { supports_open_evidence: true });
    assert.deepEqual(chosen.evidence, plan.source === 'coinbase-candles'
      ? { kind: 'coinbase', product: 'NEAR-USD', window: { kind: 'moment', at: base.deadline } }
      : { kind: 'submitted', items: [{ side: 'yes', url: evidence.postUrl }] });
  }
  for (const supports_open_evidence of [undefined, false, 'true']) {
    assert.deepEqual(makeOutlayerMaterial(evidence, s.config, { supports_open_evidence }).evidence,
      { kind: 'submitted', items: [{ side: 'yes', url: evidence.postUrl }] });
  }
  assert.throws(() => makeOutlayerMaterial(base, s.config, {}));
  assert.equal(outlayerReadyAt(price), Date.parse(base.deadline) + 120000);
});

test('creation overrides court/server referee and stores a stable reveal before funding', async () => {
  const input = terms({ refereeAccount: 'court.testnet' });
  const beforePlans = ai.seen.plans.length;
  const bet = await createBet(s.db, alice, input, options());
  assert.equal(bet.referee_wallet, near.referee);
  assert.equal(bet.terms_hash, outlayerTermsHash(bet.outlayer_material, bet.terms_salt));
  const again = await createBet(s.db, alice, input, options());
  assert.deepEqual(again.outlayer_material, bet.outlayer_material);
  assert.equal(again.terms_salt, bet.terms_salt);
  assert.equal(ai.seen.plans.length - beforePlans, 1);
  assert.deepEqual(bet.outlayer_material.evidence, { kind: 'submitted', items: [{ side: 'yes', url: input.evidenceSourceUrl }] });
  assert.equal(bet.outlayer_material.claim, `${input.claim}\n\nCounts as yes:\n${input.criteria}`);
  const event = await s.db.one("select detail from bilateral_bet_events where bet_id=$1 and kind='created'", [bet.id]);
  assert.deepEqual(event.detail.evidencePlan.verdict, { source: 'evidence' });
  assert.equal(near.sent.filter(call => call.method === 'register_material' && call.args.material.bet_id === bet.id).length, 0);
  const priceInput = terms({ claim: 'NEAR trades above US$3.30',
    resolveAt: new Date(Date.now() + 2 * 3600000).toISOString() });
  const priceBefore = ai.seen.plans.length;
  const price = await createBet(s.db, alice, priceInput, options());
  const priceAgain = await createBet(s.db, alice, priceInput, options());
  assert.equal(ai.seen.plans.length - priceBefore, 1);
  assert.deepEqual(priceAgain.outlayer_material, price.outlayer_material);
  assert.deepEqual(price.outlayer_material.evidence,
    { kind: 'coinbase', product: 'NEAR-USD', window: { kind: 'moment', at: priceInput.resolveAt } });
  const priceEvent = await s.db.one("select detail from bilateral_bet_events where bet_id=$1 and kind='created'", [price.id]);
  assert.deepEqual(priceEvent.detail.evidencePlan.verdict,
    { source: 'coinbase-candles', product: 'NEAR-USD', kind: 'moment', at: priceInput.resolveAt });
});

test('acceptance registers treasury-paid material once, including concurrent retry', async () => {
  const bet = await funded();
  await Promise.all([ensureOutlayerRegistration(s.db, s.config, near.chain, bet, { fetchImpl }),
    ensureOutlayerRegistration(s.db, s.config, near.chain, bet, { fetchImpl })]);
  const sent = near.sent.filter(call => call.method === 'register_material' && call.args.material.bet_id === bet.id);
  assert.equal(sent.length, 1);
  assert.ok(BigInt(sent[0].depositYocto) > 0n);
  assert.notEqual(sent[0].signerId, bet.creator_wallet);
  assert.equal(near.outlayerView(near.referee, 'get_ruling', { bet_id: bet.id }).terms_hash, bet.terms_hash);
});

test('funded offers wait for acceptance before sponsor registration', async () => {
  let bet = await createBet(s.db, alice, terms(), options());
  ({ bet } = await playAction(s.db, s.config, near.chain, alice, bet.id, { action: 'fund' }, { fetchImpl }));
  const registrations = () => near.sent.filter(call => call.method === 'register_material' && call.args.material.bet_id === bet.id).length;
  assert.equal(registrations(), 0);
  assert.equal((await keeper()).errors, 0);
  assert.equal(registrations(), 0);
  await playAction(s.db, s.config, near.chain, bob, bet.id, { action: 'accept', termsHash: bet.terms_hash }, { fetchImpl });
  assert.equal(registrations(), 1);
});

test('agreement settlements leave the keeper only once the referee stage is settled or absent', async t => {
  for (const registered of [true, false]) {
    const bet = await funded();
    if (!registered) near.outlayers.get(near.referee).rulings.delete(bet.id);
    const chainBet = near.bets.get(bet.id);
    chainBet.status = 'settled';
    chainBet.resolution = { method: 'agreement', outcome: 'no' };
    const first = await keeper();
    assert.equal(first.errors, 0);
    assert.ok(first.results.some(result => result.betId === bet.id));
    const last = async () => (await s.db.one("select detail from bilateral_bet_events where bet_id=$1 and kind='outlayer_ruling' order by id desc limit 1", [bet.id])).detail;
    assert.equal((await last()).escrow_terminal, true);
    const worked = async () => (await keeper()).results.some(result => result.betId === bet.id);
    if (!registered) { assert.equal(await worked(), false); continue; }
    // A registered referee stage is still idle: the bet stays until it settles.
    assert.equal((await last()).ruling.stage, 'idle');
    assert.equal(await worked(), true);
    const calls = () => near.sent.filter(call => call.method === 'request_ruling' && call.args.bet_id === bet.id).length;
    assert.equal(calls(), 0);
    // Once the ruling window opens the keeper calls request_ruling; the referee settles and refunds the reserve.
    t.mock.timers.enable({ apis: ['Date'], now: outlayerReadyAt(bet.outlayer_material) + 1 });
    assert.equal(await worked(), true);
    assert.equal(calls(), 1);
    assert.equal((await last()).ruling.stage, 'settled');
    assert.equal(await worked(), false);
    t.mock.timers.reset();
    assert.equal(calls(), 1);
  }
});

test('registration recovers signing failures and a lost broadcast response using its persisted hash', async () => {
  const bet = await createBet(s.db, alice, terms(), options());
  await playAction(s.db, s.config, near.chain, alice, bet.id, { action: 'fund' }, { fetchImpl });
  const prepare = near.chain.prepareCall;
  const broadcast = near.chain.broadcastCall;
  near.chain.prepareCall = async () => { throw new Error('Synthetic failure before signing'); };
  try {
    await playAction(s.db, s.config, near.chain, bob, bet.id, { action: 'accept', termsHash: bet.terms_hash }, { fetchImpl });
  } finally { near.chain.prepareCall = prepare; }
  const stored = await s.db.one('select * from bilateral_bets where id=$1', [bet.id]);
  const failed = await s.db.one("select * from outlayer_near_requests where bet_id=$1 and method='register_material'", [bet.id]);
  assert.equal(failed.execution_status, 'failed');
  assert.equal(failed.transaction_hash, null);
  let sentBytes;
  near.chain.broadcastCall = async input => { sentBytes = input.signedTransaction; throw new Error('Synthetic RPC failure before delivery'); };
  await assert.rejects(ensureOutlayerRegistration(s.db, s.config, near.chain, stored, { fetchImpl }), /Synthetic RPC/);
  const pending = await s.db.one("select * from outlayer_near_requests where bet_id=$1 and execution_status='pending'", [bet.id]);
  assert.equal(pending.signed_transaction, sentBytes);
  assert.ok(pending.transaction_hash);
  near.chain.broadcastCall = async input => { assert.equal(input.signedTransaction, sentBytes); return broadcast(input); };
  try {
    await ensureOutlayerRegistration(s.db, s.config, near.chain, stored, { fetchImpl });
  } finally { near.chain.broadcastCall = broadcast; }
  assert.equal(near.sent.filter(call => call.method === 'register_material' && call.args.material.bet_id === bet.id).length, 1);
  assert.equal((await s.db.one('select execution_status from outlayer_near_requests where id=$1', [pending.id])).execution_status, 'succeeded');
});

test('a definitive first-broadcast nonce rejection permits a fresh signed registration', async () => {
  const bet = await createBet(s.db, alice, terms(), options());
  await playAction(s.db, s.config, near.chain, alice, bet.id, { action: 'fund' }, { fetchImpl });
  const broadcast = near.chain.broadcastCall;
  near.chain.broadcastCall = async () => { throw new InvalidNonceError(20, 19); };
  try { await playAction(s.db, s.config, near.chain, bob, bet.id, { action: 'accept', termsHash: bet.terms_hash }, { fetchImpl }); }
  finally { near.chain.broadcastCall = broadcast; }
  const prior = await s.db.one("select * from outlayer_near_requests where bet_id=$1 and method='register_material'", [bet.id]);
  assert.equal(prior.execution_status, 'failed');
  await ensureOutlayerRegistration(s.db, s.config, near.chain,
    await s.db.one('select * from bilateral_bets where id=$1', [bet.id]), { fetchImpl });
  const registered = near.outlayerView(near.referee, 'get_ruling', { bet_id: bet.id });
  assert.equal(registered.terms_hash, bet.terms_hash);
});

test('X creation and evidence replies route to OutLayer with local inference disabled', async t => {
  const connected = await s.connectBot(s.fakeX.addUser('500', 'statedbot'));
  assert.equal(connected.status, 200);
  assert.match(connected.text, /Bot connected as @statedbot/);
  const post = s.fakeX.post(alice.x_user_id, `Nightjar ships a stable release before March 1, ${new Date().getUTCFullYear() + 1}.`);
  const command = s.fakeX.post(alice.x_user_id, '@statedbot bet 0.1 yes', { replyTo: post.id });
  await tick(s.db, s.config, s.x);
  assert.equal((await runBetCommands(s.db, s.config, near.chain, { fetchImpl, botUsername: 'statedbot' })).done, 1);
  let row = await s.db.one('select * from bet_commands where event_id=$1', [command.id]);
  let bet = await s.db.one('select * from bilateral_bets where id=$1', [row.bet_id]);
  assert.equal(bet.referee_wallet, near.referee);
  assert.equal(bet.outlayer_material.evidence.kind, 'open');
  ({ bet } = await playAction(s.db, s.config, near.chain, bob, bet.id, { action: 'accept', termsHash: bet.terms_hash }, { fetchImpl }));
  t.mock.timers.enable({ apis: ['Date'], now: outlayerDeadlineMs(bet) + 1 });
  assert.equal(s.config.nearai.rulings, false);
  // PostgreSQL's clock is independent of the mocked contract clock. Move only
  // the prompt schedule into its open window (accept_by stays before resolve_at), then restore the committed dates.
  await s.db.query("update bilateral_bets set accept_by=clock_timestamp()-interval '2 seconds', resolve_at=clock_timestamp()-interval '1 second' where id=$1", [bet.id]);
  try {
    const postPrompt = (message, tx) => say(tx, s.config, message);
    assert.deepEqual(await evidencePrompts(s.db, s.config, { say: postPrompt }), { prompted: 1 });
    assert.deepEqual(await evidencePrompts(s.db, s.config, { say: postPrompt }), { prompted: 0 });
    const prompts = await s.db.many('select in_reply_to from bot_outbox where dedupe_key=$1', [`evidence-prompt:${bet.id}`]);
    assert.deepEqual(prompts, [{ in_reply_to: command.id }]);
  } finally {
    await s.db.query('update bilateral_bets set resolve_at=$2, accept_by=$3 where id=$1', [bet.id, bet.resolve_at, bet.accept_by]);
  }
  await s.db.tx(tx => queueBetCommand(tx, { eventId: 'synthetic-evidence-command', xUserId: alice.x_user_id,
    username: alice.x_username, command: { kind: 'evidence', side: 'no', url: 'https://www.sec.gov/reply' }, targetRef: command.id }));
  assert.equal((await runEvidenceCommands(s.db, s.config, { chain: near.chain, fetchImpl })).done, 1);
  assert.equal(near.outlayers.get(near.referee).evidence.get(bet.id)[0].side, 'yes');
});

test('keeper observes Open close, running timeout, retry delay and final settlement', async t => {
  const bet = await funded();
  const due = outlayerDeadlineMs(bet);
  const windowMs = bet.outlayer_material.evidence.window_seconds * 1000;
  t.mock.timers.enable({ apis: ['Date'], now: due + windowMs - 1 });
  assert.equal(near.nowNs(), BigInt(Date.now()) * 1000000n);
  await keeper();
  assert.equal(near.sent.filter(call => call.method === 'request_ruling' && call.args.bet_id === bet.id).length, 0);
  t.mock.timers.setTime(due + windowMs + 1);
  assert.equal(near.nowNs(), BigInt(Date.now()) * 1000000n);
  assert.equal((await keeper()).errors, 0);
  const ruling = near.outlayers.get(near.referee).rulings.get(bet.id);
  assert.equal(ruling.stage, 'running');
  const count = () => near.sent.filter(call => call.method === 'request_ruling' && call.args.bet_id === bet.id).length;
  await keeper(); assert.equal(count(), 1);
  t.mock.timers.setTime(due + windowMs + 600002);
  near.queueRuling(bet.id, { stage: 'idle', next_ns: (BigInt(Date.now() + 300000) * 1000000n).toString(), outcome: null, undecided: 1 });
  await keeper(); assert.equal(count(), 2);
  await keeper(); assert.equal(count(), 2);
  t.mock.timers.setTime(Date.now() + 300001);
  near.queueRuling(bet.id, { outcome: 'yes' });
  assert.equal((await keeper()).errors, 0);
  assert.equal(near.bets.get(bet.id).status, 'settled');
  assert.equal((await s.db.one('select status from bilateral_bets where id=$1', [bet.id])).status, 'settled');
  for (const call of near.sent.filter(call => call.method === 'request_ruling')) {
    assert.deepEqual(Object.keys(call.args), ['bet_id']);
    assert.equal(call.gas, 300000000000000n); assert.equal(call.depositYocto, '0');
  }
  assert.equal((await readOutlayerRuling(s.db, bet.id)).result.verdicts.length, 3);
  // A settled snapshot must not stop reconciliation of its pending transaction.
  await s.db.query("delete from bilateral_bet_events where bet_id=$1 and kind='referee_resolved'", [bet.id]);
  await s.db.query("update outlayer_near_requests set execution_status='pending' where bet_id=$1 and method='request_ruling'", [bet.id]);
  assert.equal((await keeper()).errors, 0);
  assert.ok(await s.db.one("select id from bilateral_bet_events where bet_id=$1 and kind='referee_resolved'", [bet.id]));
});

test('Open evidence is bettor signed, idempotent, bounded and capability gated', async t => {
  const bet = await funded();
  const send = (user, url) => submitEvidence(s.db, s.config, { betId: bet.id, userId: user.id, side: 'no', url,
    via: 'page', chain: near.chain, fetchImpl });
  await assert.rejects(send(alice, 'https://www.sec.gov/one'), /window/);
  t.mock.timers.enable({ apis: ['Date'], now: outlayerDeadlineMs(bet) + 1 });
  await assert.rejects(send(outsider, 'https://www.sec.gov/one'), /bettors/);
  await send(alice, 'https://www.sec.gov/one');
  await send(alice, 'https://www.sec.gov/one');
  await send(alice, 'https://www.sec.gov/two');
  await assert.rejects(send(alice, 'https://www.sec.gov/three'), /transaction failed/);
  const calls = near.sent.filter(call => call.method === 'submit_evidence' && call.args.bet_id === bet.id);
  assert.equal(calls.length, 3);
  assert.ok(calls.every(call => call.signerId === bet.creator_wallet));
  assert.ok(calls.every(call => BigInt(call.depositYocto) > 0n));
  const referee = near.outlayers.get(near.referee);
  referee.config.supports_open_evidence = false;
  await assert.rejects(send(bob, 'https://www.sec.gov/bob'), /does not accept/);
  referee.config.supports_open_evidence = true;
});

test('claimed bettors receive an actor-scoped wallet request for the referee', async t => {
  const bet = await funded();
  await s.db.query('update play_accounts set claimed_at=clock_timestamp() where x_user_id=$1', [bob.x_user_id]);
  t.mock.timers.enable({ apis: ['Date'], now: outlayerDeadlineMs(bet) + 1 });
  const prepared = await submitEvidence(s.db, s.config, { betId: bet.id, userId: bob.id, side: 'yes',
    url: 'https://www.sec.gov/claimed', via: 'page', chain: near.chain, fetchImpl });
  assert.equal(prepared.payload.contract, near.referee);
  assert.equal(prepared.payload.method, 'submit_evidence');
  const sent = await near.chain.call({ signerId: bet.acceptor_wallet, contractId: prepared.payload.contract,
    method: prepared.method, args: prepared.args, depositYocto: prepared.depositYocto });
  assert.equal((await verifyBetTransaction(s.db, s.config, bob, bet.id,
    { requestId: prepared.requestId, transactionHash: sent.hash }, { fetchImpl })).status, 'succeeded');
  await assert.rejects(verifyBetTransaction(s.db, s.config, alice, bet.id,
    { requestId: prepared.requestId, transactionHash: sent.hash }, { fetchImpl }), /unavailable/);
  await s.db.query('update play_accounts set claimed_at=null where x_user_id=$1', [bob.x_user_id]);
});

test('public bet and ruling pages expose OutLayer provenance without legacy attestations', async t => {
  const bet = await funded({ claim: 'NEAR trades above US$3.30',
    resolveAt: new Date(Date.now() + 80 * 60000).toISOString() });
  assert.equal(bet.outlayer_material.evidence.kind, 'coinbase');
  await publishBet(s.db, alice, bet.id);
  await consentToPublicBet(s.db, bob, bet.id);
  t.mock.timers.enable({ apis: ['Date'], now: outlayerReadyAt(bet.outlayer_material) + 1 });
  near.queueRuling(bet.id, { outcome: 'yes' });
  await keeper();
  const projected = await publicBet(s.db, bet.id);
  assert.ok(rulingOnEvidence(projected));
  const browser = s.browser();
  const page = await browser.get(`/bets/${bet.id}`);
  assert.equal(page.status, 200); assert.match(page.text, /OutLayer enclave/);
  const ruling = await browser.get(`/bets/${bet.id}/ruling`);
  assert.equal(ruling.status, 200); assert.match(ruling.text, /Jury WASM SHA256/);
  assert.match(ruling.text, new RegExp(near.referee));
  assert.equal((ruling.text.match(/90% sure/g) || []).length, 3);
  assert.doesNotMatch(ruling.text, /every signature checked out/);
  const json = await browser.get(`/bets/${bet.id}/outlayer-ruling.json`);
  assert.equal(JSON.parse(json.text).material.bet_id, bet.id);
  const home = await browser.get('/'); assert.equal(home.status, 200);
  assert.match(home.text, /settled-feature/);
});
