// Bets made from replies: the whole loop against the test stack, a fake X and
// a fake NEAR that enforces the version 2 escrow rules. Every step goes through
// the production path: mention intake, the command queue, a reserved wallet
// request, a signed transaction, finalized verification and chain sync.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startStack } from './support/app.mjs';
import { FakeNear } from './support/fake-near.mjs';
import { tick } from '../src/worker.mjs';
import { accountNameFor, claimPlayAccount, playAccountFor, refillTreasury, refereeId, treasury, yocto } from '../src/play.mjs';
import { betReplies, parseBetCommand, runBetCommands, settleReplyBets } from '../src/reply-bets.mjs';
import { ensureJury, readEnclaveRuling } from '../src/enclave-ruling.mjs';
import { resolveStatement } from '../src/notify.mjs';
import { enclaveRulingFixture } from './support/enclave.mjs';

const NEXT = new Date().getUTCFullYear() + 1;
let s; let near; let X; let adminB;
const run = () => runBetCommands(s.db, s.config, near.chain, { fetchImpl: near.fetchImpl, botUsername: 'statedbot' });
const settle = () => settleReplyBets(s.db, s.config, near.chain, { fetchImpl: near.fetchImpl });
const one = (sql, params) => s.db.one(sql, params);
const botPosts = () => [...s.fakeX.posts.values()].filter((p) => p.author_id === '500');
const repliesTo = (id) => botPosts().filter((p) => (p.referenced_tweets || []).some((r) => r.id === id)).map((p) => p.text.replace(/^(@\w+ )+/, ''));
const tag = (user, text, replyTo) => s.fakeX.post(user.id, text, { replyTo: replyTo.id });
const resolve = async (post, outcome, note) => {
  const st = await one(`select st.id from statements st join sources src on src.id = st.source_id where src.platform_id = $1`, [post.id]);
  const res = await adminB.submit(`/admin/resolve/${st.id}`, { outcome, url: 'https://example.org/evidence', note, known: new Date().toISOString().slice(0, 10) }, { from: '/admin' });
  assert.equal(res.status, 200);
};
const balance = async (user) => BigInt(await near.chain.balance((await playAccountFor(s.db, user.id)).account_id));

// Move a funded fixture's deadline on both sides of chain verification.
async function moveDeadline(id, at = Date.now()) {
  const acceptBy = new Date(at - 60000);
  const resolveAt = new Date(at);
  await s.db.query('update bilateral_bets set accept_by=$2, resolve_at=$3 where id=$1', [id, acceptBy, resolveAt]);
  Object.assign(near.bets.get(id), { accept_by_ns: (BigInt(acceptBy.getTime()) * 1000000n).toString(),
    resolve_at_ns: (BigInt(resolveAt.getTime()) * 1000000n).toString() });
}

// A stand-in for NEAR Intents quotes, so the Bet page can be read with them on, off and failing.
const quoted = { mode: 'ok', calls: [] };
const intents = {
  async tokens() {
    return quoted.mode === 'down' ? [] : [
      { assetId: 'nep141:base-usdc.omft.near', symbol: 'USDC', chain: 'base', chainName: 'Base' },
      { assetId: 'nep141:btc.omft.near', symbol: 'BTC', chain: 'btc', chainName: 'Bitcoin' },
      { assetId: 'nep141:eth.omft.near', symbol: 'ETH', chain: 'eth', chainName: 'Ethereum' }];
  },
  async quote(assetId, stake) {
    quoted.calls.push([assetId, String(stake)]);
    if (quoted.mode === 'none') return { ok: false, reason: 'unavailable', at: new Date() };
    if (assetId.includes('btc')) return { ok: false, reason: 'minimum', minimumYocto: '1315773292956857495881383', at: new Date() };
    return { ok: true, amount: assetId.includes('eth') ? '0.000885475332109243' : '1.812585', usd: '1.81', seconds: 37, at: new Date('2026-11-10T22:44:21Z') };
  },
};

before(async () => {
  near = new FakeNear();
  s = await startStack({ STATED_NEAR_CONTRACT: 'escrow.testnet', STATED_PLAY: '1', STATED_PLAY_AUTOPROVISION: '1', STATED_PLAY_SETTLE_DELAY_SECONDS: '0' }, { fetchImpl: near.fetchImpl, chain: near.chain, intents });
  await s.connectBot(s.fakeX.addUser('500', 'statedbot'));
  X = Object.fromEntries(['lena', 'oskar', 'priya', 'Jun_M', '_odd_'].map((name, i) => [name, s.fakeX.addUser(String(7001 + i), name)]));
  adminB = await s.signIn(s.fakeX.addUser('900', 'reviewer'));
  await adminB.submit('/setup', { profile: 'private', defaults: 'private' });
});
after(async () => { await s?.close(); });

test('a supplied treasury never asks the faucet for a refill', async () => {
  const config = { tokenKey: 'test-only', play: {
    enabled: true, autoProvision: true, treasury: 'supplied.testnet', treasuryKey: 'test-only',
  } };
  const chain = { balance: async () => yocto('1'), newKey: () => assert.fail('a supplied treasury must not use the faucet') };
  assert.deepEqual(await refillTreasury(s.db, config, chain), { refilled: false, balance: null });
});

test('incomplete treasury credentials never fall back to the faucet', async () => {
  const config = { tokenKey: 'test-only', play: { enabled: true, autoProvision: true } };
  const chain = { newKey: () => assert.fail('incomplete credentials must not use the faucet') };
  for (const supplied of [{ treasury: 'supplied.testnet' }, { treasuryKey: 'test-only' }]) {
    await assert.rejects(treasury(s.db, { ...config, play: { ...config.play, ...supplied } }, chain),
      /Set both STATED_PLAY_TREASURY and STATED_PLAY_TREASURY_KEY/);
  }
});

test('a command is the whole reply, never a phrase inside a sentence', () => {
  assert.deepEqual(parseBetCommand('@statedbot bet 0.5 no'), { kind: 'bet', side: 'no', stake: '0.5' });
  assert.deepEqual(parseBetCommand('@lena @statedbot Bet 1 YES.'), { kind: 'bet', side: 'yes', stake: '1' });
  assert.deepEqual(parseBetCommand('@statedbot bet no'), { kind: 'bet', side: 'no', stake: '0.1' });
  assert.deepEqual(parseBetCommand('@statedbot bet yes 0.25 near'), { kind: 'bet', side: 'yes', stake: '0.25' });
  assert.deepEqual(parseBetCommand('@statedbot take'), { kind: 'take' });
  assert.deepEqual(parseBetCommand('@statedbot take it!'), { kind: 'take' });
  assert.equal(parseBetCommand('@statedbot I bet no one saw this coming by June'), null);
  assert.equal(parseBetCommand('@statedbot bet no way this ships'), null);
  assert.equal(parseBetCommand('@statedbot take a look at this'), null);
  assert.equal(parseBetCommand('@statedbot'), null);
  assert.equal(parseBetCommand('@statedbot bet 5 no').error, 'stake', 'over the 1 test NEAR limit');
  assert.equal(parseBetCommand('@statedbot bet 0 yes').error, 'stake');
});

test('an account is named after the handle when NEAR can spell it, and after the X id when it cannot', () => {
  assert.equal(accountNameFor('Chain_Abstracted', '42', 'play.testnet'), 'chain_abstracted.play.testnet');
  assert.equal(accountNameFor('_odd_', '42', 'play.testnet'), 'x42.play.testnet');
  assert.equal(accountNameFor('a__b', '42', 'play.testnet'), 'x42.play.testnet');
  assert.equal(accountNameFor('referee', '42', 'play.testnet'), 'x42.play.testnet', 'the referee name is reserved');
  assert.equal(accountNameFor('x99', '42', 'play.testnet'), 'x42.play.testnet', 'cannot pose as another id');
  assert.ok(accountNameFor('fifteen_chars_x', '42', `${'p'.repeat(50)}.testnet`).length <= 64);
});

let post; let offerCmd; let betId;

test('“bet 0.5 no” under a post funds an offer from an account named after the handle and answers in the thread', async () => {
  post = s.fakeX.post(X.lena.id, `Nightjar 2.0 ships a stable release before March 1, ${NEXT}.`);
  offerCmd = tag(X.oskar, '@statedbot bet 0.5 no', post);
  await tick(s.db, s.config, s.x);
  const queued = await one('select * from bet_commands where event_id = $1', [offerCmd.id]);
  assert.equal(queued.status, 'queued');
  assert.equal(queued.side, 'no');
  assert.match(queued.words, /Nightjar 2\.0 ships/);
  assert.deepEqual(repliesTo(offerCmd.id), [], 'no “Saved” reply for a bet, and nothing said before the stake is final');
  assert.deepEqual(await run(), { done: 1, refused: 0, retry: 0, failed: 0 });

  const done = await one('select * from bet_commands where event_id = $1', [offerCmd.id]);
  assert.equal(done.status, 'done');
  assert.equal(done.words, null, 'the queue keeps no copy of the post');
  betId = done.bet_id;
  const account = await playAccountFor(s.db, X.oskar.id);
  assert.match(account.account_id, /^oskar\.stated-play-[0-9a-f]{10}\.testnet$/);
  assert.doesNotMatch(account.secret_sealed, /secret-/, 'the key is sealed at rest');
  const chain = near.bets.get(betId);
  assert.equal(chain.status, 'offered');
  assert.equal(chain.creator, account.account_id);
  assert.equal(chain.creator_side, 'no');
  assert.equal(chain.stake, BigInt(yocto('0.5')));
  assert.equal(chain.referee, await refereeId(s.db, s.config), 'the referee is in the funded terms');
  const bet = await one('select * from bilateral_bets where id = $1', [betId]);
  assert.equal(bet.status, 'offered');
  assert.match(bet.claim, /^Nightjar 2\.0 ships a stable release before March 1/);
  assert.match(bet.criteria, /Stated’s recorded Result for this post, with its evidence link, decides\./);
  assert.equal(new Date(bet.resolve_at).toISOString().slice(0, 10), `${NEXT}-02-28`);

  await tick(s.db, s.config, s.x);
  assert.deepEqual(repliesTo(offerCmd.id), [`0.5 test NEAR says this does not happen by 28 Feb ${NEXT}. To take the other side, reply here with "@statedbot take".`]);
  // The author of the post being bet on did not summon the bot, so the reply does not mention them.
  const offerPost = botPosts().find((p) => p.text.includes('To take the other side'));
  assert.match(offerPost.text, /^@oskar /);
  assert.doesNotMatch(offerPost.text, /@lena/);
  const page = await s.browser().get(`/bets/${betId}`);
  assert.equal(page.status, 200, 'the Bet is public: the reply was the public act');
  assert.match(page.text, /@oskar/);
  assert.ok(page.text.includes(`id="bet-link" href="${s.base}/bets/${betId}"`));
  assert.match(page.text, /data-copy="bet-link" hidden>Copy bet link<\/button>/);
  assert.ok(page.text.includes(`https://x.com/intent/tweet?in_reply_to=${offerPost.id}&amp;text=%40statedbot+take`));
  // The bettor's profile and the save made by tagging stay private.
  const user = await one('select profile_visibility, setup_completed_at from users where x_user_id = $1', [X.oskar.id]);
  assert.equal(user.profile_visibility, 'private');
  assert.ok(user.setup_completed_at);
  assert.equal((await one('select visibility from saves where owner_x_user_id = $1', [X.oskar.id])).visibility, 'private');
  assert.equal((await s.browser().get('/u/oskar')).status, 404);
});

test('a Bet’s page says what its stake would cost from another chain, as a quote and nothing more', async () => {
  const bet = await one('select id, stake_yocto from bilateral_bets where id = $1', [betId]);
  quoted.calls.length = 0;
  const page = await s.browser().get(`/bets/${bet.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /<details class="fold" id="pay"><summary>Cross-chain quote<\/summary>/);
  assert.deepEqual(quoted.calls, [], 'opening a Bet does not request a quote');
  assert.match(page.text, /<optgroup label="Bitcoin"><option value="nep141:btc\.omft\.near">BTC on Bitcoin<\/option><\/optgroup>/);

  const basePath = `/bets/${bet.id}?pay=${encodeURIComponent('nep141:base-usdc.omft.near')}`;
  const base = await s.browser().get(basePath);
  assert.match(base.text, /<details class="fold" id="pay" open>/);
  assert.match(base.text, /For 0\.5 NEAR, NEAR Intents quotes <b>1\.81 USDC<\/b> on Base, with an estimated transfer time of 37 seconds\./);
  assert.deepEqual(quoted.calls, [['nep141:base-usdc.omft.near', bet.stake_yocto]], 'the quote is for exactly this stake');
  assert.match(base.text, /NEAR Intents dry-run quote from 10 Nov 2026, 22:44 UTC\. Requesting a quote moves no funds\./);

  const eth = await s.browser().get(`/bets/${bet.id}?pay=${encodeURIComponent('nep141:eth.omft.near')}`);
  assert.match(eth.text, /<details class="fold" id="pay" open>/);
  assert.match(eth.text, /quotes <b>0\.000885 ETH<\/b> on Ethereum/);
  assert.match(eth.text, /<option value="nep141:eth\.omft\.near" selected>ETH on Ethereum<\/option>/);

  const btc = await s.browser().get(`/bets/${bet.id}?pay=${encodeURIComponent('nep141:btc.omft.near')}`);
  assert.match(btc.text, /BTC on Bitcoin moves at least 1\.32 NEAR at a time\. This stake is 0\.5\./);

  const odd = await s.browser().get(`/bets/${bet.id}?pay=${encodeURIComponent('"><script>alert(1)</script>')}`);
  assert.doesNotMatch(odd.text, /<script>alert/);
  assert.match(odd.text, /quotes <b>1\.81 USDC<\/b> on Base/, 'a token that is not on the list falls back to the default');

  quoted.mode = 'none';
  assert.match((await s.browser().get(basePath)).text, /<p class="payline">No quote for USDC on Base right now\.<\/p>/);
  quoted.mode = 'down';
  assert.doesNotMatch((await s.browser().get(`/bets/${bet.id}`)).text, /Cross-chain quote/, 'with no token list the page simply has no such fold');
  quoted.mode = 'ok';
});

test('running the queue again, or replaying the mention, makes no second Bet and says nothing twice', async () => {
  assert.deepEqual(await run(), { done: 0, refused: 0, retry: 0, failed: 0 });
  await tick(s.db, s.config, s.x);
  await tick(s.db, s.config, s.x);
  assert.equal((await one('select count(*)::int as n from bilateral_bets')).n, 1);
  assert.equal(repliesTo(offerCmd.id).length, 1);
  assert.equal(near.sent.filter((t) => t.method === 'create_bet').length, 1);
});

test('the person who made the bet cannot take it', async () => {
  const offerReply = botPosts().find((p) => p.text.includes('To take the other side'));
  const own = tag(X.oskar, '@statedbot take', offerReply);
  await tick(s.db, s.config, s.x);
  assert.deepEqual(await run(), { done: 0, refused: 1, retry: 0, failed: 0 });
  await tick(s.db, s.config, s.x);
  assert.deepEqual(repliesTo(own.id), ['That is your own bet. Someone else has to take the other side.']);
  assert.equal(near.bets.get(betId).status, 'offered');
});

test('“take” under the offer matches the stake, and the thread says it is on', async () => {
  const offerReply = botPosts().find((p) => p.text.includes('To take the other side'));
  const takeCmd = tag(X.lena, '@statedbot take', offerReply);
  await tick(s.db, s.config, s.x);
  assert.deepEqual(await run(), { done: 1, refused: 0, retry: 0, failed: 0 });
  const chain = near.bets.get(betId);
  assert.equal(chain.status, 'accepted');
  assert.equal(chain.acceptor, (await playAccountFor(s.db, X.lena.id)).account_id);
  const bet = await one('select b.status, u.x_username from bilateral_bets b join users u on u.id = b.acceptor_user_id where b.id = $1', [betId]);
  assert.deepEqual(bet, { status: 'accepted', x_username: 'lena' });
  await tick(s.db, s.config, s.x);
  assert.deepEqual(repliesTo(takeCmd.id), [`It’s on. 1 test NEAR is held on NEAR testnet until 28 Feb ${NEXT}. @oskar says no; @lena says yes.`]);
  quoted.calls.length = 0;
  const page = await s.browser().get(`/bets/${betId}?pay=nep141:base-usdc.omft.near`);
  assert.match(page.text, /@lena/, 'the taker is named: the public reply was their consent');
  assert.doesNotMatch(page.text, /Cross-chain quote/);
  assert.deepEqual(quoted.calls, [], 'a matched Bet needs no funding quote');

  // A late second taker is told it is gone, and no stake of theirs moves.
  const late = tag(X.priya, '@statedbot take', offerReply);
  await tick(s.db, s.config, s.x);
  assert.deepEqual(await run(), { done: 0, refused: 1, retry: 0, failed: 0 });
  await tick(s.db, s.config, s.x);
  assert.deepEqual(repliesTo(late.id), ['Someone took that bet first, or it has closed.']);
  assert.equal(near.sent.filter((t) => t.method === 'accept_bet').length, 1);
});

test('when the Result is recorded, the referee settles on NEAR, the winner is paid, and the thread hears it', async () => {
  const before = await balance(X.lena);
  assert.deepEqual(await settle(), { settled: 0, reclaimed: 0, errors: 0 }, 'nothing settles before there is a Result');
  await resolve(post, 'yes', 'Release 2.0.0 is tagged.');
  await moveDeadline(betId);
  assert.deepEqual(await settle(), { settled: 1, reclaimed: 0, errors: 0 });
  const chain = near.bets.get(betId);
  assert.equal(chain.status, 'settled');
  assert.deepEqual({ outcome: chain.resolution.outcome, method: chain.resolution.method }, { outcome: 'yes', method: 'referee' });
  const judge = near.sent.find((t) => t.method === 'referee_resolve');
  assert.equal(judge.signerId, await refereeId(s.db, s.config));
  assert.equal(await balance(X.lena), before + BigInt(yocto('1')), 'both stakes reached the winner’s account');
  assert.equal(near.credits.get((await playAccountFor(s.db, X.lena.id)).account_id), 0n);
  const bet = await one('select status, outcome from bilateral_bets where id = $1', [betId]);
  assert.deepEqual(bet, { status: 'settled', outcome: 'yes' });
  await tick(s.db, s.config, s.x);
  assert.deepEqual(repliesTo(offerCmd.id).slice(1), ['It happened. @lena wins the 1 test NEAR pot.']);
  const page = await s.browser().get(`/bets/${betId}`);
  assert.match(page.text, /@lena won/);
  assert.doesNotMatch(page.text, /Cross-chain quote/);
  assert.match(page.text, /<p class="prop"><span class="hl">Nightjar 2\.0 ships/, 'settled from the post’s Result, so the words carry the post’s mark');
  assert.match(page.text, /<div class="versus">/, 'and the winner’s ring may be yellow');
  assert.deepEqual(await settle(), { settled: 0, reclaimed: 0, errors: 0 }, 'a settled Bet is never settled again');
  assert.equal(near.sent.filter((t) => t.method === 'referee_resolve').length, 1);
});

test('refusals are fixed sentences: no date, an amount out of range, nothing to take', async () => {
  const undated = s.fakeX.post(X.lena.id, 'Rates will come down eventually, mark my words.');
  const a = tag(X.priya, '@statedbot bet 0.2 yes', undated);
  const dated = s.fakeX.post(X.lena.id, `Copper tops $6 by June 30, ${NEXT}.`);
  const b = tag(X.priya, '@statedbot bet 5 no', dated);
  const c = tag(X.priya, '@statedbot take', dated);
  await tick(s.db, s.config, s.x);
  assert.deepEqual(await run(), { done: 0, refused: 3, retry: 0, failed: 0 });
  await tick(s.db, s.config, s.x);
  assert.deepEqual(repliesTo(a.id), [betReplies.refused('no_date')]);
  assert.deepEqual(repliesTo(b.id), [betReplies.refused('stake')]);
  assert.deepEqual(repliesTo(c.id), [betReplies.refused('no_offer')]);
  assert.equal((await one('select count(*)::int as n from bilateral_bets')).n, 1, 'no Bet came of any of them');
  // A sentence that only contains the words is saved as a prediction, as before.
  const claim = s.fakeX.post(X.priya.id, `@statedbot I bet no one ships a foldable phone under $500 by June 30, ${NEXT}.`);
  await tick(s.db, s.config, s.x);
  assert.equal(await one('select 1 as found from bet_commands where event_id = $1', [claim.id]), null);
  assert.equal((await one('select outcome from mention_events where event_id = $1', [claim.id])).outcome, 'saved');
});

test('a network failure mid-command retries the same Bet, never a second one', async () => {
  const p = s.fakeX.post(X.lena.id, `Tin tops $40k by June 30, ${NEXT}.`);
  const cmd = tag(X.priya, '@statedbot bet 0.1 yes', p);
  await tick(s.db, s.config, s.x);
  const realCall = near.chain.call;
  let failures = 1;
  near.chain.call = async (input) => { if (failures) { failures -= 1; throw new Error('socket hang up'); } return realCall(input); };
  try {
    assert.deepEqual(await run(), { done: 0, refused: 0, retry: 1, failed: 0 });
    const mid = await one('select status, bet_id, attempts from bet_commands where event_id = $1', [cmd.id]);
    assert.equal(mid.status, 'queued');
    assert.ok(mid.bet_id, 'the Bet row exists and is reused');
    // The retry waits out its backoff.
    await s.db.query(`update bet_commands set updated_at = clock_timestamp() - interval '2 minutes' where event_id = $1`, [cmd.id]);
    assert.deepEqual(await run(), { done: 1, refused: 0, retry: 0, failed: 0 });
    const after = await one('select bet_id from bet_commands where event_id = $1', [cmd.id]);
    assert.equal(after.bet_id, mid.bet_id);
    assert.equal(near.bets.get(mid.bet_id).status, 'offered');
    assert.equal((await one(`select count(*)::int as n from bilateral_bets where claim like 'Tin tops%'`)).n, 1);
  } finally { near.chain.call = realCall; }
});

test('an offer nobody took gets its stake back once the post has a Result', async () => {
  const cmd = await one(`select c.event_id, c.bet_id from bet_commands c join bilateral_bets b on b.id = c.bet_id where b.claim like 'Tin tops%'`);
  const before = await balance(X.priya);
  const tin = [...s.fakeX.posts.values()].find((p) => p.text.startsWith('Tin tops'));
  await resolve(tin, 'no', 'Closed below.');
  assert.deepEqual(await settle(), { settled: 0, reclaimed: 1, errors: 0 });
  assert.equal(near.bets.get(cmd.bet_id).status, 'cancelled');
  assert.equal(await balance(X.priya), before + BigInt(yocto('0.1')), 'the stake is back; the storage fee is not');
  await tick(s.db, s.config, s.x);
  assert.equal(repliesTo(cmd.event_id).length, 1, 'only the original offer was announced');
});

test('the wallet page shows the account and its balance, and the claim step fails in place on a bad key', async () => {
  const b = await s.signIn(X.oskar);
  const page = await b.get('/me/wallet');
  assert.equal(page.status, 200);
  const account = await playAccountFor(s.db, X.oskar.id);
  assert.match(page.text, /<p class="prop">@oskar<\/p>/, 'the handle is the name of the account');
  assert.match(page.text, new RegExp(`<span class="acct">${account.account_id.replaceAll('.', '\\.')}</span>`), 'the full account id is one tap away');
  assert.match(page.text, /<p class="lead bal"><span class="tok md"><img [^>]*><\/span>\d+\.\d{2} test NEAR<span>on testnet<\/span><\/p>/);
  assert.match(page.text, /<a href="\/me\/wallet" aria-current="page">Wallet<\/a>/);
  assert.equal((page.text.match(/class="primary big"/g) || []).length, 1);
  assert.match(page.text, /<details class="fold"><summary>Use your own NEAR wallet<\/summary>/, 'the claim step is folded away until it is wanted');
  const bad = await b.submit('/me/wallet/claim', { publicKey: 'nope' });
  assert.equal(bad.status, 400);
  assert.match(bad.text, /That didn’t go through\.<\/b> Enter a public key that starts with ed25519:/);
  assert.match(bad.text, /name="publicKey"[^>]* value="nope" class="bad" aria-invalid="true"/, 'what was typed is kept, and the field is marked');
  assert.match(bad.text, /<details class="fold" open><summary>Use your own NEAR wallet<\/summary>/, 'the fold is open on the error');
  assert.ok((await playAccountFor(s.db, X.oskar.id)).secret_sealed, 'nothing changed');
  const mine = near.chain.newKey().publicKey;
  const ok = await b.submit('/me/wallet/claim', { publicKey: mine });
  assert.equal(new URL(ok.url).pathname, '/me/wallet');
  assert.match(ok.text, /This account is yours now\. Only your wallet can move it\./);
  assert.match(ok.text, /<span>yours<\/span>/);
  assert.match(ok.text, /You hold the only key\./);
  assert.doesNotMatch(ok.text, /name="publicKey"/);
  assert.deepEqual([...near.accounts.get(account.account_id).keys], [mine]);
  // Someone with no play account is told how to get one, and sees no form.
  const fresh = await s.signIn(X.Jun_M);
  await fresh.submit('/setup', { profile: 'private', defaults: 'private' });
  const empty = await fresh.get('/me/wallet');
  assert.match(empty.text, /Bet once from a reply on X and an account is made for you/);
  assert.match(empty.text, /<p class="say">@\w+ bet 0\.\d+ no<\/p>/, 'and the reply to type');
  assert.doesNotMatch(empty.text, /name="publicKey"/);
});

test('claiming the account puts the person’s key on it and takes the server’s off', async () => {
  const account = await playAccountFor(s.db, X.lena.id);
  const mine = near.chain.newKey().publicKey;
  await assert.rejects(claimPlayAccount(s.db, s.config, near.chain, X.lena.id, 'not-a-key'), /public key that starts with ed25519:/);
  await assert.rejects(claimPlayAccount(s.db, s.config, near.chain, X.lena.id, account.public_key), /key this server already holds/);
  const claimed = await claimPlayAccount(s.db, s.config, near.chain, X.lena.id, mine);
  assert.equal(claimed.accountId, account.account_id);
  assert.deepEqual([...near.accounts.get(account.account_id).keys], [mine]);
  const row = await playAccountFor(s.db, X.lena.id);
  assert.equal(row.secret_sealed, null, 'the stored key is erased');
  assert.ok(row.claimed_at);
  // From here a reply cannot move this account's money: the server has no key.
  const p = s.fakeX.post(X.oskar.id, `Zinc tops $4k by June 30, ${NEXT}.`);
  const cmd = tag(X.lena, '@statedbot bet 0.1 no', p);
  await tick(s.db, s.config, s.x);
  assert.deepEqual(await run(), { done: 0, refused: 1, retry: 0, failed: 0 });
  await tick(s.db, s.config, s.x);
  assert.deepEqual(repliesTo(cmd.id), [betReplies.refused('claimed')]);
  assert.equal(near.sent.filter((t) => t.signerId === account.account_id && t.method === 'create_bet').length, 0);
});

test('a handle NEAR cannot spell still gets an account, and a version 1 contract refuses a referee', async () => {
  const p = s.fakeX.post(X.lena.id, `Lead tops $3k by June 30, ${NEXT}.`);
  tag(X._odd_, '@statedbot bet 0.1 yes', p);
  await tick(s.db, s.config, s.x);
  assert.deepEqual(await run(), { done: 1, refused: 0, retry: 0, failed: 0 });
  assert.match((await playAccountFor(s.db, X._odd_.id)).account_id, /^x7005\.stated-play-/);

  const old = new FakeNear({ contract: 'old-escrow.testnet', version: 1 });
  const v1 = await startStack({ STATED_NEAR_CONTRACT: 'old-escrow.testnet', STATED_PLAY: '1', STATED_PLAY_AUTOPROVISION: '1' }, { fetchImpl: old.fetchImpl });
  try {
    await v1.connectBot(v1.fakeX.addUser('500', 'statedbot'));
    const a = v1.fakeX.addUser('8001', 'ana');
    const post1 = v1.fakeX.post(a.id, `Nickel tops $20k by June 30, ${NEXT}.`);
    const cmd = v1.fakeX.post(v1.fakeX.addUser('8002', 'ben').id, '@statedbot bet 0.1 no', { replyTo: post1.id });
    await tick(v1.db, v1.config, v1.x);
    const result = await runBetCommands(v1.db, v1.config, old.chain, { fetchImpl: old.fetchImpl, botUsername: 'statedbot' });
    assert.deepEqual(result, { done: 0, refused: 0, retry: 1, failed: 0 });
    assert.match((await v1.db.one('select detail from bet_commands where event_id = $1', [cmd.id])).detail, /cannot name a referee/);
    assert.equal(old.bets.size, 0, 'nothing was funded on a contract that cannot enforce the referee');
  } finally { await v1.close(); }
});

test('one person’s commands earn at most the hourly number of paid replies; past that the reply is held', async () => {
  const noisy = s.fakeX.addUser('7099', 'noisy');
  const undated = s.fakeX.post(X.lena.id, 'Things will get better eventually, I am sure of it.');
  const cap = s.config.x.repliesPerTaggerPerHour;
  const cmds = [];
  for (let i = 0; i < cap + 2; i += 1) cmds.push(tag(noisy, '@statedbot take', undated));
  await tick(s.db, s.config, s.x);
  for (let i = 0; i < 4; i += 1) await run();
  await tick(s.db, s.config, s.x);
  const rows = await s.db.many(`select o.status from bot_outbox o join bet_commands c on c.event_id = o.in_reply_to where c.x_user_id = '7099'`);
  assert.equal(rows.length, cap + 2, 'every refusal is recorded');
  assert.equal(rows.filter((r) => r.status === 'sent').length, cap);
  assert.equal(rows.filter((r) => r.status === 'held').length, 2);
  assert.equal(cmds.filter((c) => repliesTo(c.id).length === 1).length, cap, 'only that many were posted');
});

test('new play accounts stop at the hourly number, silently, and replies stop at the daily number', async () => {
  const limited = { ...s.config, play: { ...s.config.play, newAccountsPerHour: (await one('select count(*)::int as n from play_accounts')).n } };
  const p = s.fakeX.post(X.lena.id, `Silver tops $40 by June 30, ${NEXT}.`);
  const newcomer = s.fakeX.addUser('7098', 'newcomer');
  const cmd = tag(newcomer, '@statedbot bet 0.1 yes', p);
  await tick(s.db, s.config, s.x);
  const before = near.accounts.size;
  assert.deepEqual(await runBetCommands(s.db, limited, near.chain, { fetchImpl: near.fetchImpl, botUsername: 'statedbot' }), { done: 0, refused: 1, retry: 0, failed: 0 });
  assert.equal((await one('select detail from bet_commands where event_id = $1', [cmd.id])).detail, 'paused');
  assert.equal(near.accounts.size, before, 'no account was made and nothing was funded');
  await tick(s.db, s.config, s.x);
  assert.deepEqual(repliesTo(cmd.id), [], 'no paid reply for a paused newcomer');

  // The daily ceiling: with it already reached, a new reply is recorded as held and never posted.
  const capped = { ...s.config, play: { ...s.config.play, repliesPerDay: 0 } };
  const undated = s.fakeX.post(X.lena.id, 'Someday this all makes sense.');
  const quiet = tag(X.priya, '@statedbot take', undated);
  await tick(s.db, s.config, s.x);
  await runBetCommands(s.db, capped, near.chain, { fetchImpl: near.fetchImpl, botUsername: 'statedbot' });
  await tick(s.db, s.config, s.x);
  assert.equal((await one('select status from bot_outbox where in_reply_to = $1', [quiet.id])).status, 'held');
  assert.deepEqual(repliesTo(quiet.id), []);
});

test('on the site, a result the other side never answers can be let stand after two days, and not before', async () => {
  // Two people with their own wallets (the browser-wallet path), on the version 2 contract with no referee.
  const maker = s.fakeX.addUser('7201', 'maker');
  const taker = s.fakeX.addUser('7202', 'taker');
  const mb = await s.signIn(maker); await mb.submit('/setup', { profile: 'private', defaults: 'private' });
  const tb = await s.signIn(taker); await tb.submit('/setup', { profile: 'private', defaults: 'private' });
  await near.chain.faucet('maker-w.testnet', 'ed25519:m');
  await near.chain.faucet('taker-w.testnet', 'ed25519:t');
  const { randomUUID } = await import('node:crypto');
  const created = await mb.submit('/me/bets', { requestId: randomUUID(), claim: 'Rain falls on the first of the month.', criteria: 'The named source says so.',
    evidenceSourceUrl: 'https://example.org/result', creatorSide: 'yes', stakeNear: '0.1',
    acceptBy: new Date(Date.now() + 2500).toISOString(), resolveAt: new Date(Date.now() + 3500).toISOString() }, { from: '/me/bets/new' });
  const id = new URL(created.url).pathname.split('/').pop();
  const sign = async (browser, wallet, action, extra = {}) => {
    const page = await browser.submit(`/bets/${id}/${action}`, { accountId: wallet, ...extra }, { from: `/bets/${id}` });
    assert.equal(page.status, 200, `${action}: ${page.text.match(/role="alert">([^<]*(?:<b>[^<]*<\/b>[^<]*)?)/)?.[1] || page.status}`);
    const payload = JSON.parse(page.text.match(/name="walletPayload" value="([^"]+)"/)[1].replaceAll('&quot;', '"').replaceAll('&amp;', '&'));
    const sent = near.call({ signerId: wallet, contractId: payload.contract, method: payload.method, args: payload.args, depositYocto: payload.depositYocto });
    await browser.submit(`/bets/${id}/transactions`, { requestId: payload.requestId, transactionHash: sent.hash }, { from: `/bets/${id}` });
    return sent;
  };
  assert.ok((await sign(mb, 'maker-w.testnet', 'fund')).ok);
  const bet = await one('select terms_hash from bilateral_bets where id = $1', [id]);
  assert.ok((await sign(tb, 'taker-w.testnet', 'accept', { termsHash: bet.terms_hash })).ok);
  await new Promise((ok) => setTimeout(ok, 3600));
  assert.ok((await sign(mb, 'maker-w.testnet', 'propose', { outcome: 'yes', note: 'It rained.', evidenceUrl: 'https://example.org/rain' })).ok);

  let page = await mb.get(`/bets/${id}`);
  assert.match(page.text, /The other side has until \d{1,2} \w{3} \d{4} to agree or disagree\. After that you can let this result stand\./);
  assert.doesNotMatch(page.text, /Let the result stand<\/button>/);
  // Too early: the server refuses nothing it cannot know, and the contract refuses the transaction.
  const early = await sign(mb, 'maker-w.testnet', 'finalize');
  assert.equal(early.ok, false);
  assert.match(early.failure, /Response window remains open/);
  assert.equal(near.bets.get(id).status, 'proposed');

  // Two days later, as the chain records it.
  near.bets.get(id).proposal.proposed_at_ns = (BigInt(Date.now() - 2 * 86400000 - 60000) * 1000000n).toString();
  await mb.submit(`/bets/${id}/verify`, {}, { from: `/bets/${id}` });
  page = await mb.get(`/bets/${id}`);
  assert.match(page.text, /The other side did not answer in two days\./);
  assert.match(page.text, /Let the result stand<\/button>/);
  // The side that did not propose is never offered it.
  assert.doesNotMatch((await tb.get(`/bets/${id}`)).text, /Let the result stand/);
  const stood = await sign(mb, 'maker-w.testnet', 'finalize');
  assert.ok(stood.ok, stood.failure);
  assert.deepEqual({ status: near.bets.get(id).status, method: near.bets.get(id).resolution.method }, { status: 'settled', method: 'unanswered' });
  await mb.submit(`/bets/${id}/verify`, {}, { from: `/bets/${id}` });
  assert.deepEqual(await one('select status, outcome from bilateral_bets where id = $1', [id]), { status: 'settled', outcome: 'yes' });
  assert.match((await mb.get(`/bets/${id}`)).text, /Unanswered \d{1,2} \w{3}/, 'said for what it was, not as an agreement');
});

test('a crash after the transaction was sent, but before it was recorded, finishes the same Bet on retry', async () => {
  const a = s.fakeX.addUser('7301', 'crash_a');
  const b = s.fakeX.addUser('7302', 'crash_b');
  const p = s.fakeX.post(X.lena.id, `Platinum tops $1500 by June 30, ${NEXT}.`);
  const offerPost = tag(a, '@statedbot bet 0.1 no', p);
  await tick(s.db, s.config, s.x);
  const realCall = near.chain.call;
  // The network accepts the transaction, then the connection drops before the answer arrives.
  const dropAfter = (method) => { near.chain.call = async (input) => { const sent = await realCall(input); if (input.method === method) { near.chain.call = realCall; throw new Error('socket hang up'); } return sent; }; };
  const backoff = (id) => s.db.query(`update bet_commands set updated_at = clock_timestamp() - interval '2 minutes' where event_id = $1`, [id]);
  try {
    dropAfter('create_bet');
    assert.deepEqual(await run(), { done: 0, refused: 0, retry: 1, failed: 0 });
    const { bet_id: id } = await one('select bet_id from bet_commands where event_id = $1', [offerPost.id]);
    assert.equal(near.bets.get(id).status, 'offered', 'the deposit did land');
    await backoff(offerPost.id);
    assert.deepEqual(await run(), { done: 1, refused: 0, retry: 0, failed: 0 }, 'the retry sees it funded and carries on');
    assert.equal(near.sent.filter((t) => t.method === 'create_bet' && t.args.id === id).length, 1, 'no second deposit');
    await tick(s.db, s.config, s.x);
    assert.equal(repliesTo(offerPost.id).length, 1);

    const offerReply = botPosts().find((post) => (post.referenced_tweets || []).some((r) => r.id === offerPost.id));
    const takePost = tag(b, '@statedbot take', offerReply);
    await tick(s.db, s.config, s.x);
    dropAfter('accept_bet');
    assert.deepEqual(await run(), { done: 0, refused: 0, retry: 1, failed: 0 });
    assert.equal(near.bets.get(id).status, 'accepted', (await one('select detail from bet_commands where event_id = $1', [takePost.id])).detail);
    await backoff(takePost.id);
    assert.deepEqual(await run(), { done: 1, refused: 0, retry: 0, failed: 0 }, 'the taker is not told someone else took it');
    await tick(s.db, s.config, s.x);
    assert.match(repliesTo(takePost.id)[0], /^It’s on\./);
    assert.equal(near.sent.filter((t) => t.method === 'accept_bet' && t.args.id === id).length, 1);

    // On a Bet with a referee, an unanswered result does not stand: the contract and the server both refuse it.
    const chainBet = near.bets.get(id);
    assert.throws(() => near.apply(chainBet.creator, 'finalize_unanswered', { id, proposal_id: 'x', expected_revision: '1' }, 0n), /Bet is not active|Proposal is not open|A referee decides this bet/);
    chainBet.status = 'proposed';
    chainBet.proposal = { id: '00000000-0000-4000-8000-00000000000a', revision: '1', outcome: 'no', proposer: chainBet.creator, proposed_at_ns: '1' };
    assert.throws(() => near.apply(chainBet.creator, 'finalize_unanswered', { id, proposal_id: chainBet.proposal.id, expected_revision: '1' }, 0n), /A referee decides this bet/);
    chainBet.status = 'accepted';
    chainBet.proposal = null;
  } finally { near.chain.call = realCall; }
});

test('the referee waits out the settlement delay, rules from the Result as it stands, and a payout that fails is retried', async () => {
  const platinum = [...s.fakeX.posts.values()].find((post) => post.text.startsWith('Platinum tops'));
  const { id } = await one(`select id from bilateral_bets where claim like 'Platinum tops%'`);
  await moveDeadline(id);
  await resolve(platinum, 'no', 'Closed below.');
  const slow = { ...s.config, play: { ...s.config.play, settleDelaySeconds: 3600 } };
  assert.deepEqual(await settleReplyBets(s.db, slow, near.chain, { fetchImpl: near.fetchImpl }), { settled: 0, reclaimed: 0, errors: 0 }, 'a fresh Result is not acted on yet');
  assert.equal(near.bets.get(id).status, 'accepted');

  // The payout fails once; the ruling still counts, and the next pass pays.
  const realCall = near.chain.call;
  let fail = true;
  near.chain.call = async (input) => {
    if (input.method !== 'withdraw' || !fail) return realCall(input);
    fail = false;
    return near.record({ signer: input.signerId, receiver: input.contractId, method: input.method,
      args: input.args, deposit: input.depositYocto, value: 'false' });
  };
  try {
    const first = await settle();
    assert.equal(first.settled, 1);
    assert.equal(first.errors, 1, 'the failed payout is reported');
    assert.deepEqual({ status: near.bets.get(id).status, outcome: near.bets.get(id).resolution.outcome }, { status: 'settled', outcome: 'no' });
    const winner = near.bets.get(id).creator;
    assert.ok(near.credits.get(winner) > 0n, 'the winnings are still credit in the contract');
    assert.equal(await one("select 1 from bilateral_bet_events where bet_id=$1 and kind='play_paid_out'", [id]), null);
    const winnerBrowser = await s.signIn(s.fakeX.users.get('7301'));
    const awaitingPayout = await winnerBrowser.get(`/bets/${id}`);
    assert.equal(awaitingPayout.status, 200);
    assert.match(awaitingPayout.text, /Your payout is being sent to your Stated account/);
    assert.doesNotMatch(awaitingPayout.text, /Withdraw tokens|Resume withdrawal|Paid to your account/);
    await s.db.query(`update bilateral_bets set settle_checked_at = clock_timestamp() - interval '10 minutes' where id = $1`, [id]);
    await settle();
    assert.equal(near.credits.get(winner), 0n, 'the sweep paid it out');
    assert.equal((await one(`select count(*)::int as n from bilateral_bet_events where bet_id = $1 and kind = 'play_paid_out'`, [id])).n, 1);
    assert.equal(near.sent.filter((t) => t.method === 'referee_resolve' && t.args.id === id).length, 1, 'ruled once');
    const paid = await winnerBrowser.get(`/bets/${id}`);
    assert.match(paid.text, /Paid to your account/);
    assert.doesNotMatch(paid.text, /Your payout is being sent|Withdraw tokens|Resume withdrawal/);
  } finally { near.chain.call = realCall; }
});

test('a jury Result settles only Bets with their own matching ruling; a human Result still settles the others', async () => {
  const source = s.fakeX.post(X.lena.id, `The registry will publish its decision before March 1, ${NEXT}.`);
  const makers = [s.fakeX.addUser('7401', 'jury_first'), s.fakeX.addUser('7402', 'jury_second')];
  const taker = s.fakeX.addUser('7403', 'jury_taker');
  const bets = [];
  for (const creator of makers) {
    const command = tag(creator, '@statedbot bet 0.1 yes', source);
    await tick(s.db, s.config, s.x);
    assert.deepEqual(await run(), { done: 1, refused: 0, retry: 0, failed: 0 });
    const offer = await one('select bet_id from bet_commands where event_id=$1', [command.id]);
    tag(taker, '@statedbot take', command);
    await tick(s.db, s.config, s.x);
    assert.deepEqual(await run(), { done: 1, refused: 0, retry: 0, failed: 0 });
    await moveDeadline(offer.bet_id);
    bets.push(await one('select * from bilateral_bets where id=$1', [offer.bet_id]));
  }
  const [ruled, unruled] = bets;
  const { statement_id: statementId } = await one('select statement_id from saves where id=$1', [ruled.source_save_id]);
  assert.equal((await one('select statement_id from saves where id=$1', [unruled.source_save_id])).statement_id, statementId);
  const jury = await ensureJury(s.db);
  const recordFor = (bet, outcome) => enclaveRulingFixture({ outcome, material: {
    claim: bet.claim, madeAt: source.created_at, deadline: bet.resolve_at, postUrl: bet.evidence_source_url,
    bets: [{ id: bet.id, termsHash: bet.terms_hash }],
  } });
  await s.db.query(`insert into bilateral_bet_events (bet_id,actor_user_id,kind,detail)
    values ($1,$2,'enclave_ruling',$3)`, [ruled.id, jury, recordFor(ruled, 'yes')]);
  assert.equal((await readEnclaveRuling(s.db, ruled.id))?.outcome, 'yes', 'the fixture is a verified ruling about this Bet');
  await resolveStatement(s.db, { statementId, outcome: 'yes', url: 'https://example.org/jury',
    note: 'The enclave jury found the published decision.', reviewer: { id: jury }, outcomeAt: new Date().toISOString() });

  assert.deepEqual(await settle(), { settled: 1, reclaimed: 0, errors: 0 });
  assert.equal((await one('select status from bilateral_bets where id=$1', [ruled.id])).status, 'settled');
  assert.equal((await one('select status from bilateral_bets where id=$1', [unruled.id])).status, 'accepted');
  assert.equal(near.bets.get(unruled.id).status, 'accepted');
  assert.equal(await one(`select id from bilateral_bet_events where bet_id=$1 and kind='enclave_ruling'`, [unruled.id]), null);
  assert.equal(near.sent.filter((request) => request.method === 'referee_resolve' && request.args.id === unruled.id).length, 0);

  await s.db.query(`insert into bilateral_bet_events (bet_id,actor_user_id,kind,detail)
    values ($1,$2,'enclave_ruling',$3)`, [unruled.id, jury, recordFor(unruled, 'no')]);
  assert.equal((await readEnclaveRuling(s.db, unruled.id))?.outcome, 'no');
  await s.db.query(`update bilateral_bets set settle_checked_at=clock_timestamp()-interval '2 minutes' where id=$1`, [unruled.id]);
  assert.deepEqual(await settle(), { settled: 0, reclaimed: 0, errors: 0 }, 'a verified but conflicting ruling also leaves the Bet open');

  await resolve(source, 'yes', 'A reviewer independently confirmed the published decision.');
  await s.db.query(`update bilateral_bets set settle_checked_at=clock_timestamp()-interval '2 minutes' where id=$1`, [unruled.id]);
  assert.deepEqual(await settle(), { settled: 1, reclaimed: 0, errors: 0 }, 'a human Result keeps the existing settlement behavior');
  assert.equal(near.bets.get(unruled.id).resolution.outcome, 'yes');
});

async function settlementFixture(t, { future = false, jury = false, ruling = true, outcome = 'yes' } = {}) {
  const source = s.fakeX.post(X.lena.id, `The registry will publish a new decision before March 1, ${NEXT}.`);
  const maker = s.fakeX.users.get('7401');
  const taker = s.fakeX.users.get('7403');
  const command = tag(maker, '@statedbot bet 0.1 yes', source);
  await tick(s.db, s.config, s.x);
  assert.equal((await run()).done, 1);
  const { bet_id: id } = await one('select bet_id from bet_commands where event_id=$1', [command.id]);
  tag(taker, '@statedbot take', command);
  await tick(s.db, s.config, s.x);
  assert.equal((await run()).done, 1);
  t.after(() => s.db.query(`update bilateral_bets set settle_checked_at=clock_timestamp()+interval '1 day' where id=$1`, [id]));
  await moveDeadline(id, Date.now() + (future ? 3600000 : -1000));
  const bet = await one('select * from bilateral_bets where id=$1', [id]);
  const { statement_id: statementId } = await one('select statement_id from saves where id=$1', [bet.source_save_id]);
  const human = await one('select id from users where x_user_id=$1', ['900']);
  const reviewer = jury ? { id: await ensureJury(s.db) } : human;
  if (jury && ruling) {
    await s.db.query(`insert into bilateral_bet_events (bet_id,actor_user_id,kind,detail)
      values ($1,$2,'enclave_ruling',$3)`, [id, reviewer.id, enclaveRulingFixture({ outcome: 'yes', material: {
      claim: bet.claim, madeAt: new Date(new Date(bet.resolve_at).getTime() - 86400000), deadline: bet.resolve_at,
      postUrl: bet.evidence_source_url, bets: [{ id, termsHash: bet.terms_hash }],
    } })]);
    assert.ok(await readEnclaveRuling(s.db, id));
  }
  await resolveStatement(s.db, { statementId, outcome, url: 'https://example.org/decision',
    note: 'The registry published its decision.', reviewer, outcomeAt: new Date(Date.now() - 60000).toISOString() });
  await s.db.query(`update statements set resolved_at=clock_timestamp()-interval '2 hours' where id=$1`, [statementId]);
  return { bet, statementId, human };
}

function afterDueSelection(betId, change) {
  let changed = false;
  return { ...s.db, many: async (sql, params) => {
    const rows = await s.db.many(sql, params);
    if (!changed && /st\.resolved_at/.test(sql) && rows.some((row) => row.id === betId)) {
      changed = true;
      await change();
    }
    return rows;
  } };
}

async function correctionIsBlocked(statementId, human) {
  try {
    await s.db.tx(async (tx) => {
      await tx.query("set local lock_timeout = '100ms'");
      await tx.query(`update statements set status='no', resolved_by=$2, resolved_at=clock_timestamp(),
        outcome_at=clock_timestamp() where id=$1`, [statementId, human.id]);
    });
    return false;
  } catch (error) {
    if (error.code !== '55P03') throw error;
    return true;
  }
}

test('a correction after due selection starts its own settlement delay', async (t) => {
  const { bet, statementId, human } = await settlementFixture(t);
  const slow = { ...s.config, play: { ...s.config.play, settleDelaySeconds: 3600 } };
  let corrected = false;
  const raced = afterDueSelection(bet.id, async () => {
    await resolveStatement(s.db, { statementId, outcome: 'no', url: 'https://example.org/correction',
      note: 'The registry corrected its decision.', reviewer: human, outcomeAt: new Date().toISOString() });
    corrected = true;
  });
  assert.deepEqual(await settleReplyBets(raced, slow, near.chain, { fetchImpl: near.fetchImpl }), { settled: 0, reclaimed: 0, errors: 0 });
  assert.equal(corrected, true);
  assert.equal(near.bets.get(bet.id).status, 'accepted');
  assert.equal(near.sent.filter((call) => call.method === 'referee_resolve' && call.args.id === bet.id).length, 0);
  await s.db.query(`update statements set resolved_at=clock_timestamp()-interval '2 hours' where id=$1`, [statementId]);
  await s.db.query('update bilateral_bets set settle_checked_at=null where id=$1', [bet.id]);
  assert.equal((await settleReplyBets(s.db, slow, near.chain, { fetchImpl: near.fetchImpl })).settled, 1);
  assert.equal(near.bets.get(bet.id).resolution.outcome, 'no');
});

test('status and jury provenance come from one locked statement version', async (t) => {
  const { bet, statementId, human } = await settlementFixture(t, { jury: true, ruling: false });
  let attempted = false;
  let blocked = false;
  const observe = (reader) => ({ ...reader, one: async (sql, params) => {
    const row = await reader.one(sql, params);
    if (!attempted && /select st\.(?:id, st\.)?status/.test(sql) && String(params?.[0]) === String(bet.source_save_id)) {
      attempted = true;
      blocked = await correctionIsBlocked(statementId, human);
    }
    return row;
  } });
  const raced = { ...observe(s.db), tx: (fn) => s.db.tx((tx) => fn(observe(tx))) };
  assert.deepEqual(await settleReplyBets(raced, s.config, near.chain, { fetchImpl: near.fetchImpl }), { settled: 0, reclaimed: 0, errors: 0 });
  assert.equal(attempted, true, 'the correction raced the statement read');
  assert.equal(blocked, true, 'a human correction cannot replace jury provenance between reads');
  assert.equal(near.sent.filter((call) => call.method === 'referee_resolve' && call.args.id === bet.id).length, 0);
});

test('human and jury Results stay share locked through the referee broadcast', async (t) => {
  for (const jury of [false, true]) {
    const { bet, statementId, human } = await settlementFixture(t, { jury });
    if (jury) await s.db.query('update statements set outcome_at=clock_timestamp() where id=$1', [statementId]);
    const realCall = near.chain.call;
    let broadcast = false;
    let blocked = false;
    near.chain.call = async (input) => {
      if (input.method === 'referee_resolve' && input.args.id === bet.id) {
        broadcast = true;
        blocked = await correctionIsBlocked(statementId, human);
      }
      return realCall(input);
    };
    try {
      assert.deepEqual(await settle(), { settled: 1, reclaimed: 0, errors: 0 });
      assert.equal(broadcast, true);
      assert.equal(blocked, true);
      assert.equal(near.bets.get(bet.id).resolution.outcome, 'yes');
    } finally { near.chain.call = realCall; }
    assert.equal(await correctionIsBlocked(statementId, human), false, 'the lock closes after settlement');
  }
});

test('before its own deadline a Bet waits for a No, a void or any jury Result', async (t) => {
  // A reviewer's No cannot be known before the date, and the jury only rules after it.
  for (const options of [{ outcome: 'no' }, { jury: true }]) {
    const { bet } = await settlementFixture(t, { future: true, ...options });
    assert.deepEqual(await settle(), { settled: 0, reclaimed: 0, errors: 0 });
    assert.equal((await one('select settle_checked_at from bilateral_bets where id=$1', [bet.id])).settle_checked_at, null);
    assert.equal(near.sent.filter((call) => call.method === 'referee_resolve' && call.args.id === bet.id).length, 0);
  }
});

test('a reviewer’s Yes settles before the deadline: the thing already happened', async (t) => {
  const { bet } = await settlementFixture(t, { future: true });
  assert.deepEqual(await settle(), { settled: 1, reclaimed: 0, errors: 0 });
  assert.equal(near.bets.get(bet.id).resolution.outcome, 'yes');
});

test('after one successful referee transaction a lagging chain view is re-read, never sent again', async (t) => {
  const { bet, human } = await settlementFixture(t);
  await s.db.query(`insert into bilateral_bet_events (bet_id,actor_user_id,kind,detail) values ($1,$2,'referee_resolved',$3)`,
    [bet.id, human.id, { outcome: 'yes', transactionHash: 'earlier-success', referee: 'referee.testnet' }]);
  assert.deepEqual(await settle(), { settled: 0, reclaimed: 0, errors: 0 }, 'the chain still shows the Bet open, so nothing is paid yet');
  assert.equal(near.sent.filter((call) => call.method === 'referee_resolve' && call.args.id === bet.id).length, 0);
});

test('the Bet deadline is checked again after due selection', async (t) => {
  const { bet } = await settlementFixture(t, { outcome: 'no' });
  let moved = false;
  const raced = afterDueSelection(bet.id, async () => {
    await moveDeadline(bet.id, Date.now() + 3600000);
    moved = true;
  });
  assert.deepEqual(await settleReplyBets(raced, s.config, near.chain, { fetchImpl: near.fetchImpl }), { settled: 0, reclaimed: 0, errors: 0 });
  assert.equal(moved, true);
  assert.equal(near.bets.get(bet.id).status, 'accepted');
  assert.equal(near.sent.filter((call) => call.method === 'referee_resolve' && call.args.id === bet.id).length, 0);
});

test('a human Yes known after the Bet deadline stays open for review without an error', async (t) => {
  const { bet, statementId } = await settlementFixture(t);
  // A reviewer records a day, so "after the deadline" means a later day.
  await s.db.query(`update statements set outcome_at=$2::timestamptz + interval '1 day' where id=$1`, [statementId, bet.resolve_at]);
  assert.deepEqual(await settle(), { settled: 0, reclaimed: 0, errors: 0 });
  assert.equal(near.bets.get(bet.id).status, 'accepted');
  assert.equal(near.sent.filter((call) => call.method === 'referee_resolve' && call.args.id === bet.id).length, 0);
  await s.db.query('update statements set outcome_at=$2 where id=$1', [statementId, bet.resolve_at]);
  await s.db.query('update bilateral_bets set settle_checked_at=null where id=$1', [bet.id]);
  assert.deepEqual(await settle(), { settled: 1, reclaimed: 0, errors: 0 }, 'a Yes known exactly at the deadline is eligible');
});
