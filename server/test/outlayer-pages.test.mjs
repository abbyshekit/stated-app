// INTEGRATION: DESIGN.md publication rules and settlement copy, using production
// readers and route handlers with synthetic persisted rows. No external transport.
import test from 'node:test';
import assert from 'node:assert/strict';
import { registerBetRoutes } from '../src/bet-pages.mjs';
import { betTerms } from '../src/bet-view.mjs';
import { outlayerDetail } from '../src/outlayer-pages.mjs';
import { outlayerTermsHash } from '../src/outlayer.mjs';
import { materialHash } from '../src/enclave-ruling.mjs';
import { publicBet, publicBetsForProfile, recentPublicBets } from '../src/bet-public.mjs';
import { loadConfig } from '../src/config.mjs';

const id = '00000000-0000-4000-8000-000000000081';
const now = new Date('2026-11-12T19:00:00.000Z');
const ns = value => (BigInt(new Date(value).getTime()) * 1000000n).toString();
const user = { id: '1', kind: 'person', x_user_id: '101', x_username: 'alice', setup_completed_at: now };

test('permissionless OutLayer settlement reports a verified payout without a local request hash', async () => {
  const { db, bet, record } = fixture({ accepted: true });
  bet.chain_state.status = 'settled';
  bet.chain_state.resolution = { method: 'referee', outcome: 'yes' };
  bet.settled_at = now;
  record.ruling.stage = 'settled'; record.ruling.outcome = 'yes';
  const material = bet.outlayer_material;
  record.ruling.result = { bet_id: id, terms_hash: bet.terms_hash, outcome: 'yes',
    material_hash: materialHash({ claim: material.claim, madeAt: material.made_at, deadline: material.deadline,
      postUrl: material.post_url, bets: [{ id, termsHash: bet.terms_hash }] }),
    verdicts: ['Qwen/Qwen3.8-27B', 'deepseek-ai/DeepSeek-V4.1-Flash-1017', 'z-ai/glm-5.3-flash']
      .map(model => ({ model, outcome: 'yes', confidence: 0.9 })) };
  const one = db.one;
  db.one = async sql => {
    if (/select detail->>'transactionHash'/.test(sql)) return { hash: null };
    if (/^select 1 from bilateral_near_requests r/.test(sql)) return { verified: 1 };
    return one(sql);
  };
  const result = await publicBet(db, id);
  assert.ok(result.outlayer?.result, 'the stored jury result is valid and bound to the settled escrow');
  assert.equal(result.settlement_transaction_hash, undefined);
  assert.equal(result.payout_completed, true);
});

function fixture({ published = true, snapshot = true, accepted = false, bound = true } = {}) {
  const bet = { id, creator_user_id: user.id, creator_username: user.x_username,
    claim: 'Nightjar ships a stable release.', criteria: 'The official stable release is available.',
    evidence_source_url: 'https://www.sec.gov/newsroom', creator_wallet: 'alice.testnet',
    creator_side: 'yes', stake_yocto: '100000000000000000000000', status: accepted ? 'accepted' : 'offered',
    accept_by: new Date('2026-11-13T19:00:00.000Z'), resolve_at: new Date('2026-11-14T19:00:00.000Z'),
    created_at: new Date('2026-11-11T19:00:00.000Z'), published_at: now, read_at: now,
    near_verified_at: now, near_height: '100', creator_bound: true,
    referee_wallet: 'outlayer-referee.testnet', terms_salt: 'c'.repeat(64), terms_hash: 'd'.repeat(64) };
  if (accepted) {
    bet.resolve_at = new Date('2026-11-11T19:00:00.000Z');
    bet.accepted_at = new Date('2026-11-11T18:00:00.000Z');
    bet.acceptor_user_id = '2'; bet.acceptor_wallet = 'bob.testnet';
    bet.acceptor_username = 'bob'; bet.acceptor_bound = true; bet.acceptor_consented = true;
  }
  if (bound) {
    bet.outlayer_material = { bet_id: id, claim: bet.claim, made_at: bet.created_at.toISOString(),
      deadline: bet.resolve_at.toISOString(), post_url: bet.evidence_source_url,
      evidence: { kind: 'submitted', items: [{ side: 'yes', url: bet.evidence_source_url }] } };
    bet.terms_hash = outlayerTermsHash(bet.outlayer_material, bet.terms_salt);
  }
  bet.chain_state = { id, creator: bet.creator_wallet, creator_binding_hash: 'a'.repeat(64),
    terms_hash: bet.terms_hash, stake_yocto: bet.stake_yocto, creator_side: bet.creator_side,
    accept_by_ns: ns(bet.accept_by), resolve_at_ns: ns(bet.resolve_at), invited_account: null,
    referee: bet.referee_wallet, status: bet.status,
    ...(accepted ? { acceptor: bet.acceptor_wallet, acceptor_binding_hash: 'b'.repeat(64) } : {}) };
  const record = bound ? { referee: bet.referee_wallet, config: { escrow: 'escrow.testnet',
    wasm_hash: 'e'.repeat(64), wasm_url: 'https://artifacts.test/jury.wasm' },
  ruling: { material_json: JSON.stringify(bet.outlayer_material), terms_hash: bet.terms_hash,
    deadline_ns: ns(bet.resolve_at), nonce: 0, started_ns: '0', next_ns: '0', stage: 'idle', outcome: null } } : null;
  const calls = [];
  const db = {
    calls,
    async one(sql) {
      calls.push(sql);
      if (sql.includes('from bilateral_bets b\n  join bilateral_bet_publications')) return published ? bet : null;
      if (sql.startsWith('select b.*,e.detail')) return snapshot && record ? { ...bet, detail: record, recorded_at: now } : null;
      if (sql.startsWith('select b.*, creator.x_username') || sql.startsWith('select * from bilateral_bets where id =')) return bet;
      if (sql.startsWith('select creator_user_id,acceptor_user_id')) return bet;
      if (sql.startsWith('select w from')) return { w: 'bob.testnet' };
      if (sql.includes('from bilateral_bets b join saves')) return accepted ? { statement_id: '3', source: 'evidence', closes_at: now } : null;
      if (sql.startsWith('select source_save_id') || sql.includes('enclave_ruling') || sql.includes('from bot_outbox')) return null;
      throw new Error(`Unexpected one query: ${sql}`);
    },
    async many(sql) {
      calls.push(sql);
      if (sql.includes('from bilateral_bets b\n  join bilateral_bet_publications')) return published ? [bet] : [];
      if (sql.includes('bilateral_bet_events') || sql.includes('bilateral_bet_proposals')
        || sql.includes('bilateral_near_requests') || sql.includes('from users') || sql.includes('from bet_evidence')) return [];
      throw new Error(`Unexpected many query: ${sql}`);
    },
    async tx(fn) { return fn(db); },
  };
  return { db, bet, record };
}

async function page(db, viewer = null, { join = false } = {}) {
  const routes = [];
  const config = loadConfig({ STATED_BASE_URL: 'http://localhost', STATED_NEAR_CONTRACT: 'escrow.testnet' });
  config.play.reputationTiers = null;
  let response;
  registerBetRoutes({ db, config, route: (method, pattern, handler) => routes.push({ method, pattern, handler }),
    layout: async (_ctx, _title, body) => body, needUser: async () => true,
    csrfField: () => '', send: (_res, status, body) => { response = { status, body: String(body) }; },
    redirect: () => assert.fail('Unexpected redirect'), notFound: () => assert.fail('Unexpected 404'),
    isAdmin: () => false, fetchImpl: () => assert.fail('Pages must not fetch external services'),
    botUsername: async () => 'statedforecast' });
  const pathname = `/bets/${id}`;
  const route = routes.find(item => item.method === 'GET' && item.pattern.test(pathname));
  assert.ok(route);
  await route.handler({ user: viewer, params: [id], url: new URL(`${pathname}${join ? '?join=1' : ''}`, 'http://localhost'), res: {} });
  return response;
}

for (const evidence of [
  { kind: 'submitted', items: [{ side: 'yes', url: 'https://www.sec.gov/agreed-release' }] },
  { kind: 'open', window_seconds: 3600, max_per_side: 2 },
  { kind: 'coinbase', product: 'NEAR-USD', window: { kind: 'moment', at: '2026-11-14T19:00:00.000Z' } },
  { kind: 'coinbase', product: 'BTC-USD', window: { kind: 'range', start: '2026-11-14T18:00:00.000Z', end: '2026-11-14T19:00:00.000Z' } },
]) {
  test(`offer and participant pages disclose committed ${evidence.kind}${evidence.window ? ` ${evidence.window.kind}` : ''} evidence before acceptance`, async () => {
    const { db, bet } = fixture({ snapshot: false });
    bet.outlayer_material.evidence = evidence;
    bet.terms_hash = outlayerTermsHash(bet.outlayer_material, bet.terms_salt);
    bet.chain_state.terms_hash = bet.terms_hash;
    const expected = evidence.kind === 'submitted' ? /The jury reads the agreed source.*https:\/\/www.sec.gov\/agreed-release/s
      : evidence.kind === 'open' ? /Only links.*after the deadline.*3600 seconds.*2 links per side/s
      : new RegExp(`Coinbase ${evidence.product}.*${evidence.window.kind === 'moment' ? 'opening price' : 'candles'}`, 's');
    for (const viewer of [null, user]) {
      const response = await page(db, viewer);
      assert.equal(response.status, 200);
      assert.match(response.body, expected);
      const disclosure = response.body.indexOf('data-committed-evidence');
      assert.ok(disclosure >= 0);
      assert.ok(disclosure < response.body.indexOf('<div class="folds">'), 'disclosure stays outside collapsed Rules');
    }
    const taker = { ...user, id: '2', x_user_id: '102', x_username: 'bob' };
    const acceptance = await page(db, taker, { join: true });
    assert.match(acceptance.body, expected);
    const acceptForm = acceptance.body.indexOf(`action="/bets/${id}/accept"`);
    assert.ok(acceptForm >= 0, 'exercise the actual wallet acceptance form');
    assert.ok(acceptance.body.indexOf('data-committed-evidence') < acceptForm);
    if (evidence.kind === 'open') {
      const terms = String(betTerms(bet));
      assert.match(terms, /20:00 UTC 14 Nov 2026/);
      assert.match(terms, /Add evidence links during this window/);
    }
  });
}

test('OutLayer detail suppresses public-only links when links are disabled', () => {
  const { bet, record } = fixture();
  for (const result of [null, { verdicts: [], evidence_summary: { kind: 'submitted', items: [] } }]) {
    const detail = String(outlayerDetail({ ...bet, outlayer: { ...record, result } }, { links: false }));
    assert.match(detail, /OutLayer enclave/);
    assert.match(detail, /<summary>Verify OutLayer<\/summary>/);
    assert.match(detail, /OutLayer attestation verification/);
    assert.doesNotMatch(detail, new RegExp(`href="/bets/${id}/(?:ruling|outlayer-ruling\\.json)"`));
  }
});

test('unpublished participant page omits public-only OutLayer links', async () => {
  const { db } = fixture({ published: false });
  const response = await page(db, user);
  assert.equal(response.status, 200);
  assert.match(response.body, /Verify OutLayer/);
  assert.doesNotMatch(response.body, new RegExp(`href="/bets/${id}/(?:ruling|outlayer-ruling\\.json)"`));
});

test('published participant and visitor pages retain OutLayer ruling links', async () => {
  const { db } = fixture();
  for (const viewer of [user, null]) {
    const response = await page(db, viewer);
    assert.equal(response.status, 200);
    assert.ok(response.body.includes(`href="/bets/${id}/ruling"`));
    assert.ok(response.body.includes(`href="/bets/${id}/outlayer-ruling.json"`));
  }
});

test('public detail and list projections retain only an OutLayer binding flag before the first snapshot', async () => {
  const { db } = fixture({ snapshot: false });
  const detail = await publicBet(db, id);
  assert.equal(detail.outlayer, null);
  const recent = await recentPublicBets(db);
  const profile = await publicBetsForProfile(db, 'alice');
  assert.equal(recent.length, 1);
  assert.equal(profile.length, 1);
  for (const bet of [detail, ...recent, ...profile]) {
    assert.equal(bet.outlayer_bound, true);
    assert.equal(Object.hasOwn(bet, 'outlayer_material'), false);
    assert.equal(Object.hasOwn(bet, 'terms_salt'), false);
    assert.match(String(betTerms(bet)), /The OutLayer enclave jury decides/);
    assert.doesNotMatch(String(betTerms(bet)), /Stated’s recorded Result for the post decides/);
  }
});

test('public offer awaiting its OutLayer snapshot still describes OutLayer settlement', async () => {
  const { db } = fixture({ snapshot: false });
  const response = await page(db);
  assert.equal(response.status, 200);
  assert.match(response.body, /The OutLayer enclave jury decides/);
  assert.doesNotMatch(response.body, /Stated’s recorded Result for the post decides/);
});

test('public pending snapshot recognizes the bound jury for the deciding phase', async () => {
  const { db } = fixture({ snapshot: false, accepted: true });
  const response = await page(db);
  assert.equal(response.status, 200);
  assert.match(response.body, /The NEAR AI enclave jury is deciding/);
});

test('legacy public projection retains its existing settlement terms', async () => {
  const { db } = fixture({ bound: false, snapshot: false });
  const bet = await publicBet(db, id);
  assert.equal(bet.outlayer_bound, false);
  assert.equal(Object.hasOwn(bet, 'outlayer_material'), false);
  assert.match(String(betTerms(bet)), /Stated’s recorded Result for the post decides/);
  assert.doesNotMatch(String(betTerms(bet)), /The OutLayer enclave jury decides/);
});
