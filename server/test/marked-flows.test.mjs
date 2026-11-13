// Page-level checks for the Marked pages that involve a Bet: the dare on a
// Prediction, one way to sign in per screen, and the remembered testnet
// account. Chain state is a synthetic fixture; the NEAR RPC is faked.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startStack } from './support/app.mjs';
import { createBet } from '../src/bets.mjs';
import { publishBet } from '../src/bet-public.mjs';
import { tick } from '../src/worker.mjs';
import { TESTNET_RPC } from '../src/near-escrow.mjs';

const hash = '11111111111111111111111111111111';
const resp = (result) => new Response(JSON.stringify({ result }), { headers: { 'content-type': 'application/json' } });
const fetchImpl = async (url, options) => {
  if (url !== TESTNET_RPC) return fetch(url, options);
  const { method, params } = JSON.parse(options.body);
  if (method === 'block') return resp({ header: { height: 100, hash } });
  if (params?.method_name === 'get_credit') return resp({ block_height: 100, result: [...Buffer.from(JSON.stringify('0'))] });
  if (params?.method_name === 'get_bet') return resp({ block_height: 100, result: [...Buffer.from('null')] });
  throw new Error('unexpected rpc');
};

let s;
let lenaB; let priyaB; let oskarB; let anon;
let U = {};
let saveId; let openBet; let unfundedBet; let settledBet; let settledSave;

const ns = (v) => (BigInt(new Date(v).getTime()) * 1000000n).toString();
const bind = () => randomUUID().replaceAll('-', '').padEnd(64, 'a').slice(0, 64);

async function stage(bet, creator, { status = 'offered', acceptor = null, outcome = null } = {}) {
  const cw = `${creator.x_username}.testnet`;
  const aw = acceptor ? `${acceptor.x_username}.testnet` : null;
  const cb = bind();
  const ab = acceptor ? bind() : null;
  const chain = { id: bet.id, terms_hash: bet.terms_hash, stake_yocto: bet.stake_yocto, creator_side: bet.creator_side,
    accept_by_ns: ns(bet.accept_by), resolve_at_ns: ns(bet.resolve_at), invited_account: null, creator: cw, creator_binding_hash: cb,
    status, acceptor: aw, ...(ab ? { acceptor_binding_hash: ab } : {}), proposal: outcome ? { outcome, proposer: cw, revision: '1' } : null };
  await s.db.query(`insert into bilateral_near_requests (id,bet_id,user_id,wallet_account,method,args,binding_hash,metadata)
    values ($1,$2,$3,$4,'create_bet','{}',$5,'{"fixture":"synthetic"}')`, [randomUUID(), bet.id, String(creator.id), cw, cb]);
  if (acceptor) {
    await s.db.query(`insert into bilateral_near_requests (id,bet_id,user_id,wallet_account,method,args,binding_hash,metadata)
      values ($1,$2,$3,$4,'accept_bet','{}',$5,'{"fixture":"synthetic"}')`, [randomUUID(), bet.id, String(acceptor.id), aw, ab]);
  }
  await s.db.query(`update bilateral_bets set chain_state=$2, creator_wallet=$3, acceptor_wallet=$4, acceptor_user_id=$5, status=$6,
      near_height=321, near_verified_at=clock_timestamp(), accepted_at=case when $4::text is null then null else clock_timestamp() end,
      settled_at=case when $6='settled' then clock_timestamp() else null end, outcome=$7 where id=$1`,
    [bet.id, chain, cw, aw, acceptor ? String(acceptor.id) : null, status, outcome]);
  await publishBet(s.db, creator, bet.id);
  if (acceptor) await s.db.query('insert into bilateral_bet_public_consents (bet_id,user_id) values ($1,$2) on conflict do nothing', [bet.id, String(acceptor.id)]);
}

before(async () => {
  s = await startStack({ STATED_NEAR_CONTRACT: 'escrow.testnet' }, { fetchImpl });
  const bot = s.fakeX.addUser('500', 'statedbot');
  await s.connectBot(bot);
  const X = { lena: s.fakeX.addUser('61001', 'lena'), priya: s.fakeX.addUser('61002', 'priya'), oskar: s.fakeX.addUser('61003', 'oskar') };
  const admin = s.fakeX.addUser('900', 'reviewer');
  const publish = async (user) => {
    const b = await s.signIn(user);
    await b.submit('/me/settings/publish', [['confirm', '1'], ['defaults', 'public']], { from: '/setup' });
    return b;
  };
  lenaB = await publish(X.lena); priyaB = await publish(X.priya); oskarB = await publish(X.oskar);
  const adminB = await s.signIn(admin);
  await adminB.submit('/setup', { profile: 'private', defaults: 'private' });
  anon = s.browser();
  for (const [key, user] of Object.entries(X)) U[key] = await s.db.one('select * from users where x_user_id = $1', [user.id]);

  const year = new Date().getUTCFullYear() + 1;
  const open = s.fakeX.post(X.lena.id, `Nightjar 2.0 ships a stable release before March 1, ${year}.`);
  const done = s.fakeX.post(X.lena.id, `Nightjar 1.8 ships before March 1, ${year}.`);
  s.fakeX.post(X.lena.id, '@statedbot', { replyTo: open.id });
  s.fakeX.post(X.lena.id, '@statedbot', { replyTo: done.id });
  await tick(s.db, s.config, s.x);
  const find = async (post) => s.db.one(`select s.id, s.statement_id from saves s join statements st on st.id = s.statement_id
    join sources src on src.id = st.source_id where s.owner_x_user_id = $1 and src.platform_id = $2`, [X.lena.id, post.id]);
  saveId = (await find(open)).id;
  settledSave = await find(done);

  const mk = (creator, source, side, claim) => createBet(s.db, creator, { requestId: randomUUID(), claim, criteria: 'The named source says so.',
    evidenceSourceUrl: 'https://example.org/result', creatorSide: side, stakeNear: '0.1', sourceSaveId: String(source),
    acceptBy: new Date(Date.now() + 86400000).toISOString(), resolveAt: new Date(Date.now() + 30 * 86400000).toISOString() });
  openBet = await mk(U.priya, saveId, 'no', 'Nightjar 2.0 ships a stable release before 1 March.');
  await stage(openBet, U.priya);
  settledBet = await mk(U.priya, settledSave.id, 'yes', 'Nightjar 1.8 ships before 1 March.');
  await stage(settledBet, U.priya, { status: 'settled', acceptor: U.oskar, outcome: 'yes' });
  unfundedBet = await mk(U.priya, saveId, 'yes', 'A second offer, not funded.');
  const today = new Date().toISOString().slice(0, 10);
  const res = await adminB.submit(`/admin/resolve/${settledSave.statement_id}`, { outcome: 'yes', url: 'https://example.org/evidence', note: 'Tagged.', known: today }, { from: '/admin' });
  assert.equal(res.status, 200);
});

after(async () => { await s?.close(); });

const signinLinks = (text) => text.match(/href="\/signin[^"]*"/g) || [];

test('an open Prediction with a Bet waiting leads with the dare, and a signed-out visitor gets exactly one way to sign in', async () => {
  const page = await anon.get(`/u/lena/${saveId}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /<p class="lead">@priya dares you<span>Offer closes in \d+ (?:minutes?|hours?|days?), \d{2}:\d{2} UTC \d{1,2} \w{3} \d{4}<\/span><\/p>/);
  assert.match(page.text, /<b>You\?<\/b><span>bet yes<\/span>/);
  assert.match(page.text, /<b>@priya<\/b><span>bet no<\/span>/);
  const join = encodeURIComponent(`/bets/${openBet.id}?join=1#accept`);
  assert.match(page.text, new RegExp(`<a class="pill solid big" href="/signin\\?return=${join.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}">Bet yes</a>`));
  assert.equal(signinLinks(page.text.split('<footer')[0].split('<section class="folds"')[0]).length, 1, 'no second sign-in in the header');
  assert.doesNotMatch(page.text, /class="hl|class="struck"/, 'an open prediction carries no mark');
});

test('signed in, the open seat shows the viewer and the one filled button takes the bet; the person who offered it is not invited to their own bet', async () => {
  const page = await oskarB.get(`/u/lena/${saveId}`);
  assert.match(page.text, new RegExp(`<a class="seat" href="/bets/${openBet.id}\\?join=1#accept">`));
  assert.match(page.text, new RegExp(`<a class="pill solid big" href="/bets/${openBet.id}\\?join=1#accept">Bet yes</a>`));
  assert.equal((page.text.match(/class="pill solid big"/g) || []).length, 1, 'one filled button');
  assert.match(page.text, /<a class="pill" href="\/me\/track\?url=[^"]+">Follow<\/a>/, 'following moves beside the face');

  const own = await priyaB.get(`/u/lena/${saveId}`);
  assert.match(own.text, /<p class="lead">Your bet is open/);
  assert.match(own.text, /<b>Anyone<\/b><span>bet yes<\/span>/);
  assert.doesNotMatch(own.text, /\?join=1#accept/);
});

test('a Prediction that came true marks the words, rings the Bet winner in yellow terms, and offers the result to post', async () => {
  const page = await anon.get(`/u/lena/${settledSave.id}`);
  assert.match(page.text, /<p class="said"><span class="hl sweep">Nightjar 1\.8 ships before March 1, \d{4}\.<\/span><\/p>/);
  assert.match(page.text, /<p class="verdict yes"><b>Yes<\/b>/);
  assert.match(page.text, /<div class="versus">/, 'the Result is Yes, so the ring may be yellow');
  assert.match(page.text, /<div class="seat won">[\s\S]*?<b>@priya<\/b><span>bet yes<\/span>/);
  assert.equal((page.text.split('<footer')[0].match(/class="hl/g) || []).length, 1, 'the mark is on the words only: a marked name reads as a chip');
  assert.match(page.text, /<div class="seat lost">[\s\S]*?<b>@oskar<\/b><span>bet no<\/span>/);
  assert.match(page.text, /Post the result<\/a>/);
  assert.match(page.text, new RegExp(`/share/predictions/${settledSave.id}\\.png`));
  // The Bet's own page never borrows the Prediction's colour: it was settled by agreement.
  const bet = await anon.get(`/bets/${settledBet.id}`);
  assert.match(bet.text, /<div class="versus agreed">/);
  assert.doesNotMatch(bet.text.split('<footer')[0], /class="hl/, 'no marker on a Bet page');
});

test('the public Bet page for a signed-out visitor has one sign-in, and it returns to the join step', async () => {
  const page = await anon.get(`/bets/${openBet.id}`);
  assert.equal(page.status, 200);
  const main = page.text.split('<footer')[0];
  assert.equal(signinLinks(main).filter((l) => l.includes('join')).length, 1);
  assert.doesNotMatch(main, /<a class="pill" href="\/signin/, 'the header pill is dropped when the page has its own');
  assert.match(page.text, /summary_large_image/);
  assert.match(page.text, new RegExp(`/share/bets/${openBet.id}\\.png`));
  assert.doesNotMatch(page.text, /stroke-dasharray|class="stubs"|\bFOR\b|\bAGAINST\b/);
});

test('the testnet account used last time is filled in on the next deposit', async () => {
  const mine = await priyaB.get(`/bets/${unfundedBet.id}`);
  assert.equal(mine.status, 200);
  assert.match(mine.text, /Deposit stake<\/button>/);
  assert.match(mine.text, /name="accountId" value="priya\.testnet"/, 'remembered from the funded Bet');
  // Someone with no history gets an empty field, never another person's account.
  const join = await lenaB.get(`/bets/${openBet.id}?join=1`);
  assert.match(join.text, /name="accountId" value=""/);
  assert.doesNotMatch(join.text, /value="priya\.testnet"|value="oskar\.testnet"/);
  // Oskar accepted a Bet before, so his account is remembered when he takes another.
  const again = await oskarB.get(`/bets/${openBet.id}?join=1`);
  assert.match(again.text, /name="accountId" value="oskar\.testnet"/);
  assert.match(again.text, /name="publicConsent" value="1" required/, 'consent is still asked every time');
});

test('lists show one line for a Bet on an open Prediction, with a way to take it', async () => {
  const home = await oskarB.get('/');
  assert.match(home.text, new RegExp(`<p class="meta bet">[\\s\\S]*?@priya bet no\\.</span><a href="/bets/${openBet.id}\\?join=1#accept">Bet yes</a></p>`));
  const own = await priyaB.get('/');
  assert.match(own.text, new RegExp(`You bet no\\.</span><a href="/bets/${openBet.id}">Open the bet</a>`));
});

// ---- States: what a person sees when something fails, or when there is nothing yet ----

test('a deposit that fails comes back to the Bet, with the reason above the button it belongs to', async () => {
  await priyaB.get(`/bets/${unfundedBet.id}`);
  const res = await priyaB.submit(`/bets/${unfundedBet.id}/fund`, { accountId: 'not a wallet' });
  assert.ok(res.status >= 400 && res.status < 500, `status ${res.status}`);
  assert.match(res.text, /<p class="notice" role="alert">[^<]+<\/p>/);
  assert.match(res.text, /Deposit stake<\/button>/, 'the action is still on the page');
  assert.ok(res.text.indexOf('role="alert"') < res.text.indexOf('Deposit stake</button>'), 'reason sits above the button');
  assert.doesNotMatch(res.text, /That didn’t work|Unable to continue/);
  assert.match(res.text, /<p class="prop bet-claim">A second offer, not funded\.<\/p>/, 'still on the same Bet');
  assert.match(res.text, /name="accountId" value="not a wallet"/, 'what they typed is kept, to correct');
});

test('taking a public Bet without agreeing to be named comes back to the join step, and stores no consent', async () => {
  await oskarB.get(`/bets/${openBet.id}?join=1`);
  const res = await oskarB.submit(`/bets/${openBet.id}/accept`, { accountId: 'oskar.testnet', termsHash: openBet.terms_hash });
  assert.equal(res.status, 400);
  assert.match(res.text, /role="alert">Tick the box to show your X name and wallet on this public bet\./);
  assert.match(res.text, /<form method="post" action="\/bets\/[^"]+\/accept" id="accept">/, 'the join form, not the public page');
  assert.match(res.text, /<span>Show my X name and wallet on this public bet\.<\/span>/);
  const stored = await s.db.one('select count(*)::int as n from bilateral_bet_public_consents where bet_id=$1 and user_id=$2', [openBet.id, String(U.oskar.id)]);
  assert.equal(stored.n, 0);
});

test('the wallet step says what leaves which account in one line, and keeps the full request one tap away', async () => {
  await priyaB.get(`/bets/${unfundedBet.id}`);
  const res = await priyaB.submit(`/bets/${unfundedBet.id}/fund`, { accountId: 'priya.testnet' });
  assert.equal(res.status, 200);
  assert.match(res.text, /<p class="wallet-debit">Deposit 0\.11 test NEAR from priya\.testnet<\/p>/, 'stake plus the storage fee and paying account');
  assert.equal((res.text.match(/class="wallet-debit"/g) || []).length, 1, 'one prominent debit statement');
  assert.match(res.text, /<summary>This request<\/summary><dl class="bet-terms"><dt>Network<\/dt><dd>NEAR testnet<\/dd><dt>Wallet<\/dt><dd>priya\.testnet<\/dd>/);
  assert.match(res.text, /<dt>Contract<\/dt><dd>escrow\.testnet<\/dd><dt>Action<\/dt><dd>create_bet<\/dd>/);
  assert.match(res.text, /data-connect-wallet>Connect wallet<\/button>/);
  assert.doesNotMatch(res.text, /<div class="notice"><dl/, 'no boxed table above the button');
});

test('an error with nowhere better to go names what happened and leads back to the page it came from', async () => {
  await priyaB.get(`/bets/${openBet.id}/publication`);
  const res = await priyaB.request('POST', `/bets/${openBet.id}/publish`, {
    form: [['csrf', priyaB.csrf()]], headers: { referer: `${s.base}/bets/${openBet.id}/publication` } });
  assert.equal(res.status, 400);
  assert.match(res.text, /<h1>That didn’t work<\/h1>/);
  assert.match(res.text, /<p class="notice" role="alert">Review and approve the public invitation before publishing\.<\/p>/);
  assert.match(res.text, new RegExp(`<a class="pill solid big" href="/bets/${openBet.id}/publication">Go back</a>`));
  // A referrer from another site is never used as the way back.
  const away = await priyaB.request('POST', `/bets/${openBet.id}/publish`, {
    form: [['csrf', priyaB.csrf()]], headers: { referer: 'https://example.org/elsewhere' } });
  assert.match(away.text, /<a class="pill solid big" href="\/me">Go back<\/a>/);
});

test('a link that cannot be read fails on the field, in place', async () => {
  await lenaB.get('/me');
  const res = await lenaB.submit('/me/track', { url: 'not a link' });
  assert.equal(res.status, 422);
  assert.match(res.text, /<form class="paste bad" method="post" action="\/me\/track">/);
  assert.match(res.text, /<p class="err" id="url-error" role="alert">[^<]+<\/p>/);
  assert.match(res.text, /aria-invalid="true" aria-describedby="url-error"/);
  assert.match(res.text, /value="not a link"/, 'what they typed is kept');
});

test('empty lists say what will fill them', async () => {
  const bets = await lenaB.get('/me/bets');
  assert.match(bets.text, /<p class="blank">No bets yet\. Open a prediction and bet on it, or make one from scratch\.<\/p>/);
  assert.match(bets.text, /<a class="pill solid big" href="\/me\/bets\/new">Make a bet<\/a>/);
  const following = await lenaB.get('/me?tab=following');
  assert.match(following.text, /class="blank"/);
  await priyaB.get('/me/inbox');
  for (const id of (priyaB.lastPage.text.match(/action="\/me\/inbox\/\d+\/done"/g) || [])) {
    await priyaB.submit(id.slice(8, -1), {});
    await priyaB.get('/me/inbox');
  }
  assert.match(priyaB.lastPage.text, /<p class="blank">Nothing yet\. Results and bet updates show up here\.<\/p>/);
});

test('the Inbox shows a result as who and Yes or No, and leaves the scoring sentence to the Prediction page', async () => {
  const stored = await s.db.one(`select body from inbox where owner_x_user_id = $1 and kind = 'outcome' order by id desc limit 1`, ['61001']);
  assert.match(stored.body, /^Outcome recorded for a prediction by .+: It came true\. Tagged\. It counts toward your record\.$/, 'the stored notice is unchanged');
  const page = await lenaB.get('/me/inbox');
  assert.match(page.text, /<a class="what" href="\/me\/s\/\d+">@lena: Yes<\/a>/);
  assert.match(page.text, /<p class="meta">Missing: probability\. Confirm what you meant before the deadline\.<\/p>/, 'the save notice loses its scoring sentence too');
  assert.match(page.text, /Tagged\./);
  assert.doesNotMatch(page.text.split('<footer')[0], /counts toward your record|Outcome recorded for a prediction/);
  assert.match(page.text, /<span>\d{1,2} \w{3} \d{4}/, 'dates in the same form as everywhere else');
});

test('a far-off Prediction asks for the Bet dates beside the button, with the reason, and not again in Terms', async () => {
  const year = new Date().getUTCFullYear() + 4;
  const far = s.fakeX.post('61001', `Fusion power is on a commercial grid before March 1, ${year}.`);
  s.fakeX.post('61001', '@statedbot', { replyTo: far.id });
  await tick(s.db, s.config, s.x);
  const save = await s.db.one(`select s.id from saves s join statements st on st.id = s.statement_id join sources src on src.id = st.source_id
    where s.owner_x_user_id = $1 and src.platform_id = $2`, ['61001', far.id]);
  const page = await oskarB.get(`/me/bets/new?save=${save.id}&side=no`);
  assert.equal(page.status, 200);
  const dates = page.text.indexOf('<div class="dates">');
  const button = page.text.indexOf('Offer the bet</button>');
  assert.ok(dates > 0 && dates < button, 'date fields come before the button');
  assert.match(page.text, /<p>The post is dated more than a year out, so the dates are yours to set\. A bet has to finish within a year\.<\/p>/);
  assert.doesNotMatch(page.text, /aria-invalid="true"/, 'untouched dates have no error');
  assert.equal((page.text.match(/name="acceptByDateInput"/g) || []).length, 1, 'asked once');
  assert.doesNotMatch(page.text, /<h3>Dates<\/h3>/);
  // A near-dated Prediction keeps its dates in Terms, prefilled, and shows no warning.
  const near = await oskarB.get(`/me/bets/new?save=${saveId}&side=yes`);
  assert.doesNotMatch(near.text, /class="dates"|class="err"/);
  assert.match(near.text, /<h3>Dates<\/h3>/);
});

test('signed-out home is one line and a button above the list; settings offer no switch for something that is off', async () => {
  const home = await anon.get('/');
  assert.match(home.text, /Reply to any post on X with <span class="mention">@statedbot bet 0\.1 no<\/span>\. Three AI models judge it and NEAR pays the winner\./);
  assert.doesNotMatch(home.text, /class="hero"/);
  assert.doesNotMatch(home.text.split('<footer')[1], /<p>/, 'the footer is links only');
  const settings = await lenaB.get('/me/settings');
  assert.equal(/name="dm"/.test(settings.text), Boolean(s.config.x.dmEnabled));
  assert.doesNotMatch(settings.text, /not available yet/);
});

test('a full-length post steps its words down a size on its own page', async () => {
  const text = 'Unpopular opinion, and I will happily eat this in public if I am wrong: every one of the five largest container shipping lines will run at least one ammonia-fuelled vessel on a scheduled Asia to Europe service before June 30, 2027, and nobody will call it a pilot.';
  const post = s.fakeX.post('61001', text);
  s.fakeX.post('61001', '@statedbot', { replyTo: post.id });
  await tick(s.db, s.config, s.x);
  const save = await s.db.one(`select s.id from saves s join statements st on st.id = s.statement_id join sources src on src.id = st.source_id
    where s.owner_x_user_id = $1 and src.platform_id = $2`, ['61001', post.id]);
  const page = await anon.get(`/u/lena/${save.id}`);
  assert.match(page.text, /<p class="said long">Unpopular opinion/);
  const short = await anon.get(`/u/lena/${saveId}`);
  assert.match(short.text, /<p class="said">Nightjar 2\.0/);
  const css = (await anon.get('/static/skin.css')).text;
  assert.match(css, /\.post \.said\.long \{ font-size: 20px/);
  assert.match(css, /\.prow \.said \{[^}]*-webkit-line-clamp: 4/);
});
