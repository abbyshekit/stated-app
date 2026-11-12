// PostgreSQL and HTTP are real; finalized NEAR snapshots below are synthetic fixtures.
// Covers the way from a shared Result into a new Bet: the settled public page's
// "Make a bet" action and the public page that opens the reply on X.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startStack } from './support/app.mjs';
import { createBet } from '../src/bets.mjs';
import { publishBet } from '../src/bet-public.mjs';
import { parseBetCommand } from '../src/reply-bets.mjs';
import { completeSetup, signInFromX } from '../src/store.mjs';
import { clearOembedCache } from '../src/xtext.mjs';

let s;
let plain;
let creator;

const ns = (value) => (BigInt(new Date(value).getTime()) * 1000000n).toString();
const binding = () => randomUUID().replaceAll('-', '').padEnd(64, 'a').slice(0, 64);
const filled = (text) => text.match(/class="(?:pill solid big|primary big)(?: [a-z]+)*"/g) || [];

async function publicBetIn(stack, owner, status) {
  const bet = await createBet(stack.db, owner, {
    requestId: randomUUID(), claim: 'Will the event occur?', criteria: 'Official result',
    evidenceSourceUrl: 'https://example.org/result', creatorSide: 'yes', stakeNear: '0.1',
    acceptBy: new Date(Date.now() + 86400000).toISOString(),
    resolveAt: new Date(Date.now() + 172800000).toISOString(),
  });
  const creatorBinding = binding();
  const settled = status === 'settled';
  const chain = {
    id: bet.id, terms_hash: bet.terms_hash, stake_yocto: bet.stake_yocto, creator_side: bet.creator_side,
    accept_by_ns: ns(bet.accept_by), resolve_at_ns: ns(bet.resolve_at), invited_account: null, referee: null,
    creator: 'creator.testnet', creator_binding_hash: creatorBinding, status,
    acceptor: settled ? 'joiner.testnet' : null,
    ...(settled ? { acceptor_binding_hash: binding() } : {}),
    proposal: settled ? { outcome: 'yes', proposer: 'creator.testnet', revision: '1' } : null,
  };
  await stack.db.query(`insert into bilateral_near_requests (id,bet_id,user_id,wallet_account,method,args,binding_hash,metadata)
    values ($1,$2,$3,'creator.testnet','create_bet','{}',$4,'{"fixture":"synthetic"}')`,
  [randomUUID(), bet.id, String(owner.id), creatorBinding]);
  await stack.db.query(`update bilateral_bets set chain_state=$2, creator_wallet='creator.testnet', acceptor_wallet=$3,
    status=$4, near_height=321, near_verified_at=clock_timestamp(),
    accepted_at=case when $3::text is null then null else clock_timestamp() end,
    settled_at=case when $4='settled' then clock_timestamp() else null end,
    outcome=case when $4='settled' then 'yes' else null end where id=$1`,
  [bet.id, chain, settled ? 'joiner.testnet' : null, status]);
  if (settled) {
    await stack.db.query(`insert into bilateral_bet_proposals (id,bet_id,revision,proposer_user_id,outcome,evidence_url,note)
      values ($1,$2,1,$3,'yes','https://private.example.org/evidence','private fixture note')`,
    [randomUUID(), bet.id, String(owner.id)]);
  }
  await publishBet(stack.db, owner, bet.id);
  return bet;
}

before(async () => {
  s = await startStack({ STATED_PLAY: '1', STATED_NEAR_CONTRACT: 'escrow.testnet' });
  await s.connectBot(s.fakeX.addUser('500', 'statedbot'));
  creator = await completeSetup(s.db, await signInFromX(s.db, { id: '82001', username: 'result_creator' }), { profileVisibility: 'private' });
  plain = await startStack();
});

after(async () => {
  await s?.close();
  await plain?.close();
});

test('a settled public bet offers Make a bet as its one filled action, signed out', async () => {
  const closed = await publicBetIn(s, creator, 'settled');
  const alone = await s.browser().get(`/bets/${closed.id}`);
  assert.equal(alone.status, 200);
  assert.match(alone.text, new RegExp(`<a class="pill solid big" href="/bets/new\\?from=${closed.id}">Make your own bet</a>`));
  assert.equal(filled(alone.text).length, 1, 'one filled button on the page');
  assert.match(alone.text, /class="tl"[^>]*>Post the result</, 'sharing stays, as a quiet link');

  await publicBetIn(s, creator, 'offered');
  const withOffer = await s.browser().get(`/bets/${closed.id}`);
  assert.match(withOffer.text, new RegExp(`<a class="pill solid big" href="/bets/new\\?from=${closed.id}">Make your own bet</a>`));
  assert.doesNotMatch(withOffer.text, /Take another bet/, 'open offers are listed on the Make a bet page, not here');
  const start = await s.browser().get('/bets/new');
  assert.match(start.text, /<a class="tl" href="\/bets\/[0-9a-f-]{36}">Or take @result_creator’s open bet<\/a>/, 'the Make a bet page points at a funded open offer');
  assert.equal(filled(withOffer.text).length, 1);
});

test('the Make a bet page is public, needs no sign-in and sets nothing in motion', async () => {
  const before = await s.db.one('select (select count(*) from bilateral_bets)::int as bets, (select count(*) from users)::int as users');
  const page = await s.browser().get('/bets/new');
  assert.equal(page.status, 200);
  assert.match(page.text, /<form method="get" action="\/bets\/new"/);
  assert.match(page.text, /name="link"/);
  assert.match(page.text, /Use this post<\/button>/);
  assert.doesNotMatch(page.text, /name="side"|Reply on X/, 'a side and the reply come after a post is chosen');
  assert.ok(filled(page.text).length <= 1);
  assert.doesNotMatch(page.text, /name="csrf"/, 'a page that changes nothing carries no form token');
  // A browser applies form-action to the redirect that ends at the composer, so this page allows X and no other page does.
  assert.match(page.headers.get('content-security-policy'), /; form-action 'self' https:\/\/x\.com; /);
  assert.match((await s.browser().get('/')).headers.get('content-security-policy'), /; form-action 'self'; /);
  const after = await s.db.one('select (select count(*) from bilateral_bets)::int as bets, (select count(*) from users)::int as users');
  assert.deepEqual(after, before);
});

test('a chosen post asks for a side with the smallest stake and a month chosen', async () => {
  const link = encodeURIComponent('https://x.com/someone/status/1234567890123456789');
  const page = await s.browser().get(`/bets/new?link=${link}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /name="side" value="yes" required>/);
  assert.match(page.text, /name="side" value="no" required>/);
  assert.doesNotMatch(page.text, /name="side" value="(?:yes|no)" required checked/, 'no side is picked for them');
  assert.match(page.text, /name="stake" value="0\.1" checked/);
  assert.match(page.text, /name="datePreset" value="month" checked/);
  assert.match(page.text, /<label for="date-week">1 week<\/label>/);
  assert.match(page.text, /<label for="date-month">1 month<\/label>/);
  if (page.text.includes('id="date-year"')) {
    assert.match(page.text, /<label for="date-year">31 Dec<\/label>/);
    assert.match(page.text, /class="date-year"/);
  }
  assert.match(page.text, /<label for="date-custom">Other<\/label>/);
  assert.match(page.text, /<p class="lead">Bet on this post<\/p>/);
  assert.match(page.text, /<nav aria-label="More"><a href="\/search">Search<\/a><a href="\/privacy">Privacy<\/a><\/nav>/);
  assert.match(page.text, /<p class="meta stake-label">Your side<\/p>\s*<div class="seg side-choice"/);
  assert.match(page.text, /<p class="meta stake-label">Stake each, in test NEAR<\/p>\s*<div class="seg side-choice/);
  assert.match(page.text, /<p class="meta stake-label" id="deadline-label">Deadline, 23:59 UTC<\/p>\s*<div class="seg side-choice/);
  assert.equal((page.text.match(/>Deadline\b/g) || []).length, 1, 'one Deadline label');
  assert.doesNotMatch(page.text, /<label for="bet-date">/);
  assert.match(page.text, /type="date" id="bet-date" name="date" value="" min="\d{4}-\d{2}-\d{2}" max="\d{4}-\d{2}-\d{2}"/);
  assert.match(page.text, /<span class="need">Choose yes or no<\/span><span class="go">[\s\S]*?Reply on X<\/span><\/button>/, 'the button asks for a side until one is chosen');
  assert.doesNotMatch(page.text, /href="\/signin/, 'nothing on this path offers a sign-in it does not need');
  assert.match(page.text, /Replying to @someone</, 'the handle in the pasted link names whose post it is');
  assert.match(page.text, /<p class="said cmd"><b>@statedbot<\/b> bet <i class="k0">0\.1<\/i><i class="k1">0\.25<\/i><i class="k2">0\.5<\/i><i class="k3">1<\/i> <i class="yes">yes<\/i><i class="no">no<\/i><i class="unset">yes or no<\/i>[\s\S]*class="date-week"[\s\S]*class="date-month"[\s\S]*class="date-custom"[\s\S]*<\/p>/,
    'the reply is drawn with every choice the stylesheet can show');
  const anonymousLink = await s.browser().get(`/bets/new?link=${encodeURIComponent('https://x.com/i/web/status/1234567890123456789')}`);
  assert.match(anonymousLink.text, /<p class="lead">Bet on this post<\/p>/);
  assert.doesNotMatch(anonymousLink.text, /Pick a date for this post\./);
  assert.match(page.text, /<a class="tl unread" href="https:\/\/x\.com\/i\/web\/status\/1234567890123456789" rel="noopener noreferrer">x\.com\/someone\/status\/1234567890123456789<\/a>/, 'an unread post is named by its own link and can be opened');
  assert.equal(filled(page.text).length, 1);
});

test('a pasted public post is shown from oEmbed with escaped author and words, and unavailable posts keep the link fallback', async () => {
  const author = s.fakeX.addUser('83001', 'previewauthor', { name: '<img src=x onerror=alert(1)>' });
  const post = s.fakeX.post(author.id, '<script>alert("x")</script> & a claim');
  const link = encodeURIComponent(`https://x.com/i/web/status/${post.id}`);
  clearOembedCache();
  const before = s.fakeX.calls.filter((call) => call.path === '/oembed').length;
  const page = await s.browser().get(`/bets/new?link=${link}`);
  assert.match(page.text, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(page.text, /&lt;script&gt;alert\(&quot;x&quot;\)&lt;\/script&gt; &amp; a claim/);
  assert.match(page.text, /<span>@previewauthor<\/span>/);
  assert.doesNotMatch(page.text, /<script>alert\("x"\)<\/script>|<img src=x/);
  assert.equal(s.fakeX.calls.filter((call) => call.path === '/oembed').length, before + 1);
  const unavailable = await s.browser().get('/bets/new?link=' + encodeURIComponent('https://x.com/i/web/status/1999999999999999999'));
  assert.match(unavailable.text, /<p class="lead">Bet on this post<\/p>/);
  assert.doesNotMatch(unavailable.text, /Pick a date for this post\./);
  assert.match(unavailable.text, /x\.com\/i\/web\/status\/1999999999999999999/);
});

test('a pasted post link opens the reply on X with the command typed', async () => {
  const link = encodeURIComponent('https://x.com/someone/status/1234567890123456789?s=20');
  const missing = await s.browser().request('GET', `/bets/new?link=${link}&side=no&stake=0.25&datePreset=custom&go=1`);
  assert.equal(missing.status, 400);
  assert.equal(missing.location, null);
  assert.match(missing.text, /<p class="err" role="alert">Choose a date from tomorrow to a year away\.<\/p>/);
  const date = new Date(Date.now() + 2 * 86400000).toISOString().slice(0, 10);
  const res = await s.browser().request('GET', `/bets/new?link=${link}&side=no&stake=0.25&date=${date}&go=1`);
  assert.equal(res.status, 303);
  const to = new URL(res.location);
  assert.equal(to.origin, 'https://x.com');
  assert.equal(to.pathname, '/intent/tweet');
  assert.equal(to.searchParams.get('in_reply_to'), '1234567890123456789');
  const chosen = new Date(`${date}T00:00:00Z`);
  const dateText = `${chosen.getUTCDate()} ${['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'][chosen.getUTCMonth()]} ${chosen.getUTCFullYear()}`;
  assert.equal(to.searchParams.get('text'), `@statedbot bet 0.25 no by ${dateText}`);
  assert.deepEqual([...to.searchParams.keys()].sort(), ['in_reply_to', 'text']);
});

test('every command the page can type is one the bot accepts', () => {
  for (const stake of ['0.1', '0.25', '0.5', '1']) {
    for (const side of ['yes', 'no']) {
      assert.deepEqual(parseBetCommand(`@statedbot bet ${stake} ${side}`), { kind: 'bet', side, stake });
    }
  }
});

test('a bad link, side or stake stays on the page with the reason and what was typed', async () => {
  const typed = 'https://example.org/not-a-post?a=1&b="2"';
  const bad = await s.browser().request('GET', `/bets/new?link=${encodeURIComponent(typed)}`);
  assert.equal(bad.status, 400);
  assert.equal(bad.location, null);
  assert.match(bad.text, /<p class="err" role="alert">Paste a link to one post on X, like x\.com\/name\/status\/123\.<\/p>/);
  assert.match(bad.text, /value="https:\/\/example\.org\/not-a-post\?a=1&amp;b=&quot;2&quot;"/, 'the typed link is kept, escaped');

  const empty = await s.browser().request('GET', '/bets/new?link=&side=no&stake=0.1&go=1');
  assert.equal(empty.status, 400);
  assert.match(empty.text, /role="alert">Paste a link to one post on X/);

  const post = encodeURIComponent('https://x.com/someone/status/42');
  const noSide = await s.browser().request('GET', `/bets/new?link=${post}&stake=0.5&go=1`);
  assert.equal(noSide.status, 400);
  assert.equal(noSide.location, null);
  assert.match(noSide.text, /<p class="err" role="alert">Choose bet yes or bet no\.<\/p>/);
  assert.match(noSide.text, /name="stake" value="0\.5" checked/, 'the chosen stake is kept');
  const invalidDate = await s.browser().request('GET', `/bets/new?link=${post}&side=no&stake=0.25&datePreset=custom&date=2026-02-31&go=1`);
  assert.equal(invalidDate.status, 400);
  assert.match(invalidDate.text, /type="text" id="bet-date" name="date" value="2026-02-31"[^>]*placeholder="YYYY-MM-DD" aria-invalid="true"/);
  assert.match(invalidDate.text, /role="alert">31 Feb 2026 is not a date\./);
  assert.match(invalidDate.text, /name="side" value="no" required checked/);
  assert.match(invalidDate.text, /name="stake" value="0\.25" checked/);
  assert.match(invalidDate.text, /name="datePreset" value="custom" checked/);
  for (const query of [`link=${post}&side=maybe&stake=0.1&go=1`, `link=${post}&side=no&stake=5&go=1`, `link=${post}&side=no&stake=0.1%20no&go=1`]) {
    const res = await s.browser().request('GET', `/bets/new?${query}`);
    assert.equal(res.status, 400, query);
    assert.equal(res.location, null, query);
  }
});

test('the back link returns to the Result the visitor came from, and only to a bet', async () => {
  const closed = await publicBetIn(s, creator, 'settled');
  const from = await s.browser().get(`/bets/new?from=${closed.id}`);
  assert.match(from.text, new RegExp(`href="/bets/${closed.id}"`));
  assert.match(from.text, new RegExp(`name="from" value="${closed.id}"`));
  const forged = await s.browser().get(`/bets/new?from=${encodeURIComponent('//evil.example/x')}`);
  assert.equal(forged.status, 200);
  assert.match(forged.text, /<a class="back" href="\/"/, 'an invalid origin falls back to home');
  assert.doesNotMatch(forged.text, /name="from"/);
  assert.doesNotMatch(forged.text, /href="[^"]*\/\/evil\.example/, 'no link leaves for the forged origin');
});

test('with reply bets off, Make a bet hands over to the wallet form and the Result page is unchanged', async () => {
  const res = await plain.browser().request('GET', '/bets/new');
  assert.equal(res.status, 303);
  assert.equal(res.location, '/me/bets/new');
  const owner = await completeSetup(plain.db, await signInFromX(plain.db, { id: '82002', username: 'plain_creator' }), { profileVisibility: 'private' });
  const closed = await publicBetIn(plain, owner, 'settled');
  const page = await plain.browser().get(`/bets/${closed.id}`);
  assert.doesNotMatch(page.text, /Make your own bet/);
  assert.match(page.text, /class="pill solid big"[^>]*>(?:<svg[\s\S]*?<\/svg>)?Post the result/);
});
