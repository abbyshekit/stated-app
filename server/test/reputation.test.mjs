// Same HTTP/PostgreSQL, fake X and finalized fake-chain stack as reply-bets.test.mjs.
// Run the pure tier tests separately when PostgreSQL is unavailable.
import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startStack } from './support/app.mjs';
import { FakeNear } from './support/fake-near.mjs';
import { loadConfig } from '../src/config.mjs';
import { createBet } from '../src/bets.mjs';
import { dayMonth } from '../src/marked.mjs';
import { playAccountFor } from '../src/play.mjs';
import { betReplies, runBetCommands, settleReplyBets } from '../src/reply-bets.mjs';
import { aboveLimit, limitFor, limitHint, limitReply, recordFor } from '../src/reputation.mjs';
import { userByXId } from '../src/store.mjs';
import { tick } from '../src/worker.mjs';

const REFUSAL = 'New handles can stake up to 0.25 test NEAR. The limit rises to 0.5 after a settled bet and to 1 after three.';
const FIRST_HINT = 'Your limit is 0.25 test NEAR until you have settled a bet.';
const MIDDLE_HINT = 'Your limit is 0.5 test NEAR until you have settled three bets.';

test('reputation tiers use settled participation, exact decimals and the contract ceiling', () => {
  const config = loadConfig({});
  assert.deepEqual(config.play.reputationTiers, [
    { settled: 0, limit: '0.25' }, { settled: 1, limit: '0.5' }, { settled: 3, limit: '1' },
  ]);
  for (const [settled, limit] of [[0, '0.25'], [1, '0.5'], [2, '0.5'], [3, '1'], [12, '1']]) {
    assert.equal(limitFor(config, { settled, won: 0 }), limit, 'a loss counts toward access');
  }
  assert.equal(limitHint(config, { settled: 0 }), FIRST_HINT);
  assert.equal(limitHint(config, { settled: 1 }), MIDDLE_HINT);
  assert.equal(limitHint(config, { settled: 3 }), null);
  assert.equal(limitReply(config, '0.25'), REFUSAL);
  assert.equal(limitReply(config, '0.5'), 'New handles can stake up to 0.5 test NEAR. The limit rises to 0.5 after a settled bet and to 1 after three.');
  assert.equal(betReplies.refused('limit', { config, limit: '0.25' }), REFUSAL);
  assert.equal(aboveLimit('0.250000000000000000000001', '0.25'), true);
  assert.equal(aboveLimit('0.250000000000000000000000', '0.25'), false);
  const custom = loadConfig({ STATED_REPUTATION_TIERS: '2:0.75,0:0.125,5:9' });
  assert.equal(limitFor(custom, { settled: 0 }), '0.125');
  assert.equal(limitFor(custom, { settled: 2 }), '0.75');
  assert.equal(limitFor(custom, { settled: 5 }), '1');
  assert.equal(limitReply(custom, '0.125'), 'New handles can stake up to 0.125 test NEAR. The limit rises to 0.75 after 2 and to 1 after 5.');
  assert.equal(limitHint(custom, { settled: 0 }), 'Your limit is 0.125 test NEAR until you have settled 2 bets.');
});

test('reputation tiers reject malformed configuration and off removes reputation limits', () => {
  for (const tiers of ['', '1:0.5', '0:0', '0:NaN', '0:0.25,0:0.5', '0:0.5,1:0.25', '0:0.1,9007199254740992:1']) {
    assert.throws(() => loadConfig({ STATED_REPUTATION_TIERS: tiers }), /STATED_REPUTATION_TIERS/);
  }
  const off = loadConfig({ STATED_REPUTATION_TIERS: 'off' });
  assert.equal(off.play.reputationTiers, null);
  assert.equal(limitFor(off, { settled: 0 }), '1');
  assert.equal(limitHint(off, { settled: 0 }), null);
});

test('reputation limits across reply and web stake paths', async (t) => {
  const near = new FakeNear();
  const s = await startStack({ STATED_NEAR_CONTRACT: 'escrow.testnet', STATED_PLAY: '1',
    STATED_PLAY_AUTOPROVISION: '1', STATED_PLAY_SETTLE_DELAY_SECONDS: '0' },
  { fetchImpl: near.fetchImpl, chain: near.chain });
  t.after(() => s.close());
  await s.connectBot(s.fakeX.addUser('500', 'statedbot'));
  const author = s.fakeX.addUser('85000', 'record_author');
  const newcomer = s.fakeX.addUser('85001', 'record_new');
  const opponent = s.fakeX.addUser('85002', 'record_opponent');
  const highMaker = s.fakeX.addUser('85003', 'record_high');
  const highTaker = s.fakeX.addUser('85004', 'record_taker');
  const deadline = dayMonth(new Date(Date.now() + 30 * 86400000), { year: true });
  const off = { ...s.config, play: { ...s.config.play, reputationTiers: null } };
  const one = (sql, params) => s.db.one(sql, params);
  let serial = 0;
  const post = () => s.fakeX.post(author.id, `Nightjar ${++serial}.0 ships before ${deadline}.`);
  const repliesTo = (id) => [...s.fakeX.posts.values()].filter((p) => p.author_id === '500'
    && p.referenced_tweets?.some((r) => r.id === id)).map((p) => p.text.replace(/^(@\w+ )+/, ''));
  async function command(user, text, target, config = s.config) {
    const tagged = s.fakeX.post(user.id, text, { replyTo: target.id });
    await tick(s.db, s.config, s.x);
    const result = await runBetCommands(s.db, config, near.chain, { fetchImpl: near.fetchImpl, botUsername: 'statedbot' });
    await tick(s.db, s.config, s.x);
    return { tagged, result, row: await one('select * from bet_commands where event_id=$1', [tagged.id]) };
  }
  const offer = (user, stake, source, config) => command(user, `@statedbot bet ${stake} yes`, source, config);
  let source; let small; let high; let browser;

  await t.test('a new handle offering 0.5 is refused before anything is funded', async () => {
    source = post();
    const { tagged, row, result } = await offer(newcomer, '0.5', source);
    assert.deepEqual(result, { done: 0, refused: 1, retry: 0, failed: 0 });
    assert.equal(row.status, 'refused');
    assert.equal(row.detail, 'limit');
    assert.deepEqual(repliesTo(tagged.id), [REFUSAL]);
    assert.equal(near.sent.length, 0);
    assert.equal(near.faucetCalls, 0);
    assert.equal(await playAccountFor(s.db, newcomer.id), null);
    assert.equal((await one('select count(*)::int as n from bilateral_bets')).n, 0);
  });

  await t.test('a new handle cannot take a 0.5 offer or bypass its web refusal', async () => {
    // A pre-existing larger offer remains available to handles with a sufficient record.
    high = await offer(highMaker, '0.5', post(), off);
    assert.equal(high.row.status, 'done');
    const sent = near.sent.length;
    const accounts = near.accounts.size;
    const { tagged, row, result } = await command(highTaker, '@statedbot take', high.tagged);
    assert.deepEqual(result, { done: 0, refused: 1, retry: 0, failed: 0 });
    assert.equal(row.detail, 'limit');
    assert.deepEqual(repliesTo(tagged.id), [REFUSAL]);
    assert.equal(near.sent.length, sent);
    assert.equal(near.accounts.size, accounts);
    assert.equal(await playAccountFor(s.db, highTaker.id), null);
    const takerBrowser = await s.signIn(highTaker);
    for (const suffix of ['', '?join=1']) {
      const page = await takerBrowser.get(`/bets/${high.row.bet_id}${suffix}`);
      assert.equal(page.status, 200);
      assert.ok(page.text.includes(FIRST_HINT));
      assert.doesNotMatch(page.text, /action="[^\"]*\/(?:take|accept)"/);
    }
    const bet = await one('select * from bilateral_bets where id=$1', [high.row.bet_id]);
    const refused = await takerBrowser.submit(`/bets/${bet.id}/accept`, {
      publicConsent: '1', termsHash: bet.terms_hash, accountId: 'record-wallet.testnet',
    }, { from: `/bets/${bet.id}?join=1` });
    assert.equal(refused.status, 409);
    assert.ok(refused.text.includes(REFUSAL));
    assert.match(refused.text, /role="alert"/);
    assert.equal((await one("select count(*)::int as n from bilateral_near_requests where bet_id=$1 and method='accept_bet'", [bet.id])).n, 0);
    const managed = await takerBrowser.submit(`/bets/${bet.id}/take`, {
      publicConsent: '1', termsHash: bet.terms_hash,
    }, { from: `/bets/${bet.id}?join=1` });
    assert.equal(managed.status, 409);
    assert.ok(managed.text.includes(REFUSAL));
    assert.equal(near.sent.filter((call) => call.method === 'accept_bet').length, 0);
  });

  await t.test('the signed-in Make a bet page disables larger stakes and preserves CSP', async () => {
    browser = await s.signIn(newcomer);
    const link = encodeURIComponent(`https://x.com/${author.username}/status/${source.id}`);
    const path = `/bets/new?link=${link}`;
    const page = await browser.get(path);
    assert.equal(page.status, 200);
    assert.ok(page.text.includes(`<p class="gut quiet">${FIRST_HINT}</p>`));
    for (const value of ['0.5', '1']) assert.ok(page.text.includes(`name="stake" value="${value}" disabled`));
    for (const value of ['0.1', '0.25']) assert.doesNotMatch(page.text, new RegExp(`name="stake" value="${value.replace('.', '\\.')}"[^>]*disabled`));
    // The page's policy keeps scripts to this origin through default-src, with nothing inline allowed.
    assert.match(page.headers.get('content-security-policy'), /default-src 'self'/);
    assert.doesNotMatch(page.headers.get('content-security-policy'), /unsafe-inline/);
    const forged = await browser.request('GET', `${path}&side=yes&stake=0.5&go=1`);
    assert.equal(forged.status, 400);
    assert.equal(forged.location, null);
    assert.ok(forged.text.includes(REFUSAL));
    const anonymous = await s.browser().get(path);
    assert.doesNotMatch(anonymous.text, /name="stake"[^>]*disabled|Your limit is/);
  });

  await t.test('a web offer cannot reserve a stake request above its creator’s limit', async () => {
    const newUser = await userByXId(s.db, newcomer.id);
    const draft = await createBet(s.db, newUser, { requestId: randomUUID(), claim: 'Nightjar ships a web release.',
      criteria: 'Official release.', evidenceSourceUrl: 'https://example.org/result', creatorSide: 'yes', stakeNear: '0.5',
      acceptBy: new Date(Date.now() + 86400000).toISOString(), resolveAt: new Date(Date.now() + 172800000).toISOString() });
    const sent = near.sent.length;
    const page = await browser.submit(`/bets/${draft.id}/fund`, { accountId: 'record-wallet.testnet' }, { from: `/bets/${draft.id}` });
    assert.equal(page.status, 409);
    assert.ok(page.text.includes(REFUSAL));
    assert.match(page.text, /role="alert"/);
    assert.equal((await one('select count(*)::int as n from bilateral_near_requests where bet_id=$1', [draft.id])).n, 0);
    assert.equal(near.sent.length, sent);
  });

  await t.test('the existing 0.1 reply offer, take and settlement flow is unchanged', async () => {
    small = await offer(newcomer, '0.1', source);
    assert.equal(small.row.status, 'done');
    assert.equal(near.bets.get(small.row.bet_id).stake, 10n ** 23n);
    const taken = await command(opponent, '@statedbot take', small.tagged);
    assert.equal(taken.row.status, 'done');
    assert.equal(near.bets.get(small.row.bet_id).status, 'accepted');
    const newUser = await userByXId(s.db, newcomer.id);
    assert.deepEqual(await recordFor(s.db, newUser.id), { settled: 0, won: 0 });
    const admin = await s.signIn(s.fakeX.addUser('900', 'reviewer'));
    await admin.submit('/setup', { profile: 'private', defaults: 'private' });
    const st = await one(`select st.id from statements st join sources src on src.id=st.source_id where src.platform_id=$1`, [source.id]);
    const resolved = await admin.submit(`/admin/resolve/${st.id}`, { outcome: 'no',
      url: 'https://example.org/evidence', note: 'No release was published.', known: new Date().toISOString().slice(0, 10) }, { from: '/admin' });
    assert.equal(resolved.status, 200);
    const resolveAt = new Date();
    const acceptBy = new Date(resolveAt.getTime() - 60000);
    await s.db.query('update bilateral_bets set accept_by=$2,resolve_at=$3 where id=$1', [small.row.bet_id, acceptBy, resolveAt]);
    Object.assign(near.bets.get(small.row.bet_id), {
      accept_by_ns: (BigInt(acceptBy.getTime()) * 1000000n).toString(),
      resolve_at_ns: (BigInt(resolveAt.getTime()) * 1000000n).toString(),
    });
    assert.deepEqual(await settleReplyBets(s.db, s.config, near.chain, { fetchImpl: near.fetchImpl }), { settled: 1, reclaimed: 0, errors: 0 });
    assert.deepEqual(await recordFor(s.db, newUser.id), { settled: 1, won: 0 });
    const winner = await userByXId(s.db, opponent.id);
    assert.deepEqual(await recordFor(s.db, winner.id), { settled: 1, won: 1 });
    // A retry pointing at the same settled Bet must not earn extra reputation.
    await s.db.query(`insert into bet_commands(event_id,x_user_id,kind,bet_id,status) values('reputation-retry',$1,'bet',$2,'done')`, [newcomer.id, small.row.bet_id]);
    assert.deepEqual(await recordFor(s.db, newUser.id), { settled: 1, won: 0 });
    const webOnly = await createBet(s.db, newUser, { requestId: randomUUID(), claim: 'A web-only Bet.',
      criteria: 'Official release.', evidenceSourceUrl: 'https://example.org/result', creatorSide: 'yes', stakeNear: '0.1',
      acceptBy: new Date(Date.now() + 86400000).toISOString(), resolveAt: new Date(Date.now() + 172800000).toISOString() });
    await s.db.query("update bilateral_bets set status='settled',outcome='yes' where id=$1", [webOnly.id]);
    assert.deepEqual(await recordFor(s.db, newUser.id), { settled: 1, won: 0 }, 'wallet-only Bets do not count');
  });

  await t.test('after one settled Bet the same losing handle can offer 0.5', async () => {
    const page = await browser.get(`/bets/new?link=${encodeURIComponent(`https://x.com/${author.username}/status/${source.id}`)}`);
    assert.ok(page.text.includes(MIDDLE_HINT));
    assert.doesNotMatch(page.text, /name="stake" value="0\.5"[^>]*disabled/);
    assert.match(page.text, /name="stake" value="1" disabled/);
    const allowed = await offer(newcomer, '0.5', post());
    assert.equal(allowed.row.status, 'done');
    assert.equal(near.bets.get(allowed.row.bet_id).stake, 5n * 10n ** 23n);
  });

  await t.test('limits off restores larger reply offers, takes and web stake choices', async () => {
    const saved = s.config.play.reputationTiers;
    s.config.play.reputationTiers = null;
    try {
      const allowed = await command(highTaker, '@statedbot take', high.tagged);
      assert.equal(allowed.row.status, 'done');
      assert.equal(near.bets.get(high.row.bet_id).status, 'accepted');
      const fresh = s.fakeX.addUser('85005', 'record_off');
      const made = await offer(fresh, '1', post());
      assert.equal(made.row.status, 'done');
      const signedIn = await s.signIn(fresh);
      const page = await signedIn.get(`/bets/new?link=${encodeURIComponent(`https://x.com/${author.username}/status/${source.id}`)}`);
      assert.doesNotMatch(page.text, /name="stake"[^>]*disabled|Your limit is/);
    } finally { s.config.play.reputationTiers = saved; }
  });
});
