// INTEGRATION: Exercises the shipped sentence script against browser-like forms and the real quick-bet endpoint.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { startStack } from './support/app.mjs';
import { FakeOutLayerNear } from './support/fake-outlayer.mjs';
import { enclaveEnv, fakeNearAi } from './support/enclave.mjs';
import { outlayerTestFetch } from './support/outlayer-fetch.mjs';
import { yocto } from '../src/play.mjs';

const key = 'stated.sentence-draft';
const script = () => readFileSync(new URL('../public/sentence.js', import.meta.url), 'utf8');

function storage(initial = {}) {
  const values = new Map(Object.entries(initial));
  return { getItem: k => values.get(k) ?? null, setItem: (k, v) => values.set(k, v),
    removeItem: k => values.delete(k) };
}

function run({ kind, store, href = 'https://stated.test/me/bets/new', value = '', action = 'https://stated.test/me/bets/new', source = script() }) {
  const fields = Object.fromEntries(['sentence', 'draftedAt', 'timeZone'].map(name => [name, { value: name === 'sentence' ? value : '' }]));
  const listeners = {};
  const button = { disabled: false };
  const status = { textContent: '' };
  const submissions = [];
  const form = {
    action, elements: { namedItem: name => fields[name] },
    addEventListener: (name, fn) => { listeners[name] = fn; },
    querySelector: selector => selector === '[data-sentence-status]' ? status : button,
    checkValidity: () => Boolean(fields.sentence.value),
    requestSubmit() { submissions.push(Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, v.value]))); listeners.submit?.({}); },
  };
  let destination;
  const context = { document: { querySelector: selector => selector === `form[data-bet-${kind}]` ? form : null },
    sessionStorage: store, crypto: { randomUUID: () => 'test-nonce' }, URL, Date, Intl,
    location: { href, assign: url => { destination = url; } }, window: { addEventListener() {} } };
  vm.runInNewContext(source, context, { filename: 'sentence.js' });
  return { fields, submissions, destination: () => destination, submit() {
    let prevented = false;
    listeners.submit({ preventDefault() { prevented = true; } });
    return prevented;
  } };
}

test('browser sentence handoff stores text and resumes exactly once', () => {
  const store = storage();
  const text = 'FAA lifts the ground stop, 0.25 NEAR on yes';
  const home = run({ kind: 'start', store, value: text });
  assert.equal(home.submit(), true);
  const destination = new URL(home.destination());
  assert.equal(destination.searchParams.get('draft'), 'test-nonce');
  assert.equal(destination.href.includes(text), false);
  const saved = JSON.parse(store.getItem(key));
  assert.equal(saved.sentence, text);
  const returned = run({ kind: 'sentence', store, href: destination.href });
  assert.equal(returned.submissions.length, 1);
  assert.equal(returned.submissions[0].sentence, text);
  assert.equal(returned.submissions[0].draftedAt, saved.draftedAt);
  assert.equal(store.getItem(key), null);
  assert.equal(run({ kind: 'sentence', store, href: destination.href }).submissions.length, 0);
});

test('browser sentence visit without Review does not submit; a mismatched nonce does not submit', () => {
  const saved = JSON.stringify({ id: 'other', sentence: 'A claim', draftedAt: new Date().toISOString() });
  const home = run({ kind: 'start', store: storage({ [key]: saved }) });
  assert.equal(home.fields.sentence.value, 'A claim');
  assert.equal(home.destination(), undefined);
  const mismatch = run({ kind: 'sentence', store: storage({ [key]: saved }), href: 'https://stated.test/me/bets/new?draft=different' });
  assert.equal(mismatch.submissions.length, 0);
});

test('browser sentence expires old storage and permits ordinary submission when storage is unavailable', () => {
  const store = storage({ [key]: JSON.stringify({ id: 'old', sentence: 'Old claim', draftedAt: '2000-01-01T00:00:00.000Z' }) });
  const expired = run({ kind: 'start', store });
  assert.equal(expired.fields.sentence.value, '');
  assert.equal(store.getItem(key), null);
  const unavailable = { getItem() { throw Error('disabled'); }, setItem() { throw Error('disabled'); }, removeItem() { throw Error('disabled'); } };
  const home = run({ kind: 'start', store: unavailable, value: 'A claim' });
  assert.equal(home.submit(), false);
  assert.equal(home.destination(), undefined);
});

test('browser sentence handoff creates one unsigned quick-bet review over HTTP', async t => {
  const near = new FakeOutLayerNear({ contract: 'escrow.statedforecast.near', referee: 'referee.statedforecast.near' });
  near.accounts.set('play.statedforecast.near', { balance: BigInt(yocto('100')), keys: new Set() });
  const accounts = structuredClone(near.accounts);
  let chainWrites = 0;
  for (const method of ['faucet', 'createAccount', 'transfer', 'drain', 'rotateKey', 'call', 'prepareCall', 'prepareRotation', 'broadcastCall']) {
    assert.equal(typeof near.chain[method], 'function');
    near.chain[method] = async () => { chainWrites += 1; throw new Error(`Unexpected chain mutation: ${method}`); };
  }
  const noChainWrites = () => {
    assert.equal(chainWrites, 0);
    assert.equal(near.txs.size, 0);
    assert.equal(near.prepared.size, 0);
    assert.equal(near.broadcasts.size, 0);
    assert.equal(near.sent.length, 0);
    assert.equal(near.faucetCalls, 0);
    assert.equal(near.keySeq, 0);
    assert.deepEqual(near.accounts, accounts);
  };
  const ai = fakeNearAi({ respond: () => ({ source: 'evidence' }) });
  let s;
  const fetchImpl = outlayerTestFetch({ ai, near: () => near, xBase: () => s?.fakeX.base });
  s = await startStack({ ...enclaveEnv, STATED_ENCLAVE_RULINGS: '', STATED_NEAR_NETWORK: 'mainnet',
    STATED_MAINNET: 'real-funds', STATED_TOKEN_KEY: 'k'.repeat(44), STATED_NEAR_CONTRACT: near.contract,
    STATED_OUTLAYER_REFEREE: near.referee, STATED_PLAY: '1', STATED_PLAY_TREASURY: 'play.statedforecast.near',
    STATED_PLAY_TREASURY_KEY: 'synthetic-only', STATED_PILOT_X_IDS: '*', STATED_PLAY_START_NEAR: '1',
    STATED_SPONSOR_LIMIT: '1', STATED_REPUTATION_TIERS: 'off', STATED_EVIDENCE_WINDOW_SECONDS: '60' },
  { fetchImpl, chain: near.chain });
  t.after(() => s.close());
  const browser = s.browser();
  const noBets = async () => {
    assert.equal((await s.db.one('select count(*)::int as n from bilateral_bets')).n, 0);
    noChainWrites();
  };
  const initial = await browser.get('/');
  assert.match(initial.text, /data-bet-start/);
  const served = await browser.get('/static/sentence.js');
  assert.equal(served.status, 200);
  await noBets();
  const deadline = new Intl.DateTimeFormat('en-GB', { day: 'numeric', month: 'short', year: 'numeric', timeZone: 'UTC' })
    .format(new Date(Date.now() + 2 * 86400000));
  const text = `FAA lifts the ground stop by ${deadline}, 0.25 NEAR on yes`;
  const store = storage();
  const home = run({ kind: 'start', store, value: text, action: `${s.base}/me/bets/new`, source: served.text });
  assert.equal(home.submit(), true);
  const destination = new URL(home.destination());
  assert.equal(destination.searchParams.get('draft'), 'test-nonce');
  assert.equal(destination.href.includes(text), false);
  const draftedAt = JSON.parse(store.getItem(key)).draftedAt;
  const signin = await browser.get(destination.href);
  assert.equal(new URL(signin.url).pathname, '/signin');
  const returnPath = `${destination.pathname}${destination.search}`;
  assert.equal(new URL(signin.url).searchParams.get('return'), returnPath);
  await noBets();
  const user = s.fakeX.addUser('8751', 'quickmaker');
  s.fakeX.consentAs = user.id;
  const setup = await browser.follow(`/signin/x?return=${encodeURIComponent(returnPath)}`);
  s.fakeX.consentAs = null;
  assert.equal(new URL(setup.url).pathname, '/setup');
  assert.equal(new URL(setup.url).searchParams.get('return'), returnPath);
  await noBets();
  const page = await browser.submit('/setup', { profile: 'private', defaults: 'private', return: returnPath });
  assert.equal(new URL(page.url).pathname, destination.pathname);
  assert.equal(new URL(page.url).searchParams.get('draft'), 'test-nonce');
  assert.match(page.text, /data-bet-sentence/);
  await noBets();
  const requestId = /name="requestId" value="([^"]+)"/.exec(page.text)?.[1];
  assert.ok(requestId);
  const returned = run({ kind: 'sentence', store, href: page.url, source: served.text });
  assert.equal(returned.submissions.length, 1);
  assert.equal(returned.submissions[0].sentence, text);
  assert.equal(returned.submissions[0].draftedAt, draftedAt);
  const review = await browser.submit('/me/bets/quick', { ...returned.submissions[0], requestId });
  assert.equal(review.status, 200, review.text);
  assert.match(review.text, /Review bet/);
  const rows = await s.db.query('select id, status, chain_state, creator_wallet from bilateral_bets');
  assert.equal(rows.rows.length, 1);
  assert.equal(rows.rows[0].status, 'offered');
  assert.equal(rows.rows[0].chain_state, null);
  assert.equal(rows.rows[0].creator_wallet, null);
  const retry = await browser.submit('/me/bets/quick', { ...returned.submissions[0], requestId });
  assert.equal(retry.url, review.url);
  assert.equal((await s.db.one('select count(*)::int as n from bilateral_bets')).n, 1);
  const requests = await s.db.one('select count(*)::int as n from bilateral_near_requests');
  assert.equal(requests.n, 0);
  noChainWrites();
});
