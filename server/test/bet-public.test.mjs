// INTEGRATION: Public bet reads and writes use real Postgres and production modules.
// NEAR state below is a labelled database fixture, not a live connector check.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { sha256 } from '../src/attested-signature.mjs';
import { after, before, beforeEach, test } from 'node:test';
import { createBet } from '../src/bets.mjs';
import {
  consentToPublicBet, followPublicBet, followsFor, publicBet,
  publishBet, recentPublicBets, withdrawBetPublication, publicBetHall,
} from '../src/bet-public.mjs';
import { completeSetup, signInFromX } from '../src/store.mjs';
import { startStack } from './support/app.mjs';
import { resetDb } from './support/pg.mjs';

let s;
let creator;
let other;
let follower;

const ns = (value) => (BigInt(new Date(value).getTime()) * 1000000n).toString();
const binding = () => randomUUID().replaceAll('-', '').padEnd(64, 'a').slice(0, 64);

async function makeUser(id, username, setup = true) {
  const user = await signInFromX(s.db, { id, username });
  return setup ? completeSetup(s.db, user, { profileVisibility: 'private' }) : user;
}

async function makeBet(owner = creator, { refereeAccount } = {}) {
  return createBet(s.db, owner, {
    requestId: randomUUID(), claim: 'Will the event occur?', criteria: 'Official result',
    evidenceSourceUrl: 'https://example.org/result', creatorSide: 'yes', stakeNear: '0.1', refereeAccount,
    acceptBy: new Date(Date.now() + 86400000).toISOString(),
    resolveAt: new Date(Date.now() + 172800000).toISOString(),
  });
}

// Creates only the persisted evidence consumed by bet-public.mjs. It does not
// call NEAR or assert that any live escrow connector was exercised.
async function storeFinalizedSnapshot(bet, { status = 'offered', acceptor = null, acceptedUser = null, ageMs = 0 } = {}) {
  const creatorBinding = binding();
  const acceptorBinding = acceptor ? binding() : null;
  const proposal = status === 'settled'
    ? { outcome: 'yes', proposer: 'creator.testnet', revision: '1' }
    : null;
  const chain = {
    id: bet.id,
    terms_hash: bet.terms_hash,
    stake_yocto: bet.stake_yocto,
    creator_side: bet.creator_side,
    accept_by_ns: ns(bet.accept_by),
    resolve_at_ns: ns(bet.resolve_at),
    invited_account: bet.invited_wallet,
    referee: bet.referee_wallet,
    creator: 'creator.testnet',
    creator_binding_hash: creatorBinding,
    status,
    acceptor,
    ...(acceptorBinding ? { acceptor_binding_hash: acceptorBinding } : {}),
    proposal,
  };
  const creatorId = String(creator.id);
  await s.db.query(`insert into bilateral_near_requests
    (id,bet_id,user_id,wallet_account,method,args,binding_hash,metadata)
    values ($1,$2,$3,'creator.testnet','create_bet','{}',$4,'{"fixture":"synthetic"}')`,
  [randomUUID(), bet.id, creatorId, creatorBinding]);
  if (acceptor && acceptedUser) {
    await s.db.query(`insert into bilateral_near_requests
      (id,bet_id,user_id,wallet_account,method,args,binding_hash,metadata)
      values ($1,$2,$3,$4,'accept_bet','{}',$5,'{"fixture":"synthetic"}')`,
    [randomUUID(), bet.id, String(acceptedUser.id), acceptor, acceptorBinding]);
  }
  await s.db.query(`update bilateral_bets set chain_state=$2, creator_wallet='creator.testnet',
    acceptor_wallet=$3, acceptor_user_id=$4, status=$5, near_height=321,
    near_verified_at=clock_timestamp() - ($6::text || ' milliseconds')::interval,
    accepted_at=case when $3::text is null then null else clock_timestamp() end,
    settled_at=case when $5='settled' then clock_timestamp() else null end,
    outcome=case when $5='settled' then 'yes' else null end
    where id=$1`, [bet.id, chain, acceptor, acceptedUser ? String(acceptedUser.id) : null, status, ageMs]);
  await s.db.query(`insert into bilateral_bet_proposals
    (id,bet_id,revision,proposer_user_id,outcome,evidence_url,note)
    values ($1,$2,1,$3,'yes','https://private.example.org/evidence','private fixture note')`,
  [randomUUID(), bet.id, creatorId]);
  return chain;
}

before(async () => { s = await startStack(); });

beforeEach(async () => {
  await resetDb(s.db);
  creator = await makeUser('81001', 'public_creator');
  other = await makeUser('81002', 'public_other');
  follower = await makeUser('81003', 'public_follower', false);
});

after(async () => { if (s) await s.close(); });

test('the hall lists every verified publication and distinguishes paid winnings from credit', async () => {
  const bets = [];
  for (let i = 0; i < 11; i += 1) {
    const bet = await makeBet(creator, { refereeAccount: 'referee.testnet' });
    const chain = await storeFinalizedSnapshot(bet, { status: 'settled', acceptor: 'joiner.testnet', acceptedUser: other });
    chain.resolution = { outcome: 'yes', method: 'referee' };
    await s.db.query('update bilateral_bets set chain_state=$2 where id=$1', [bet.id, chain]);
    if (i !== 10) await publishBet(s.db, creator, bet.id);
    await s.db.query(`update bilateral_bet_publications set published_at=clock_timestamp()+($2::int * interval '1 second') where bet_id=$1`, [bet.id, i]);
    bets.push(bet);
  }
  await withdrawBetPublication(s.db, creator, bets[9].id);
  await s.db.query('update bilateral_bets set near_height=null where id=$1', [bets[8].id]);
  const requestId = randomUUID();
  await s.db.query(`insert into bilateral_near_requests
    (id,bet_id,user_id,wallet_account,method,args,metadata,execution_status,transaction_hash,execution_checked_at)
    values ($1,$2,$3,'creator.testnet','withdraw',$4,'{}','succeeded',$5,clock_timestamp())`,
  [requestId, bets[0].id, creator.id, { stated_request_id: requestId }, '11111111111111111111111111111111']);
  let hall = await publicBetHall(s.db);
  assert.equal(hall.paidYocto, '0', 'a withdrawal without the per-Bet collector marker is not attributed');
  await s.db.query(`insert into bilateral_bet_events (bet_id,actor_user_id,kind) values ($1,$2,'play_paid_out')`, [bets[0].id, creator.id]);
  hall = await publicBetHall(s.db);
  assert.equal(hall.total, 8);
  assert.equal(hall.settled, 8);
  assert.equal(hall.paidYocto, '200000000000000000000000');
  assert.deepEqual(new Set(hall.rows.map((row) => row.id)), new Set(bets.slice(0, 8).map((bet) => bet.id)));
  for (const browser of [s.browser(), await s.signIn(s.fakeX.addUser('81001', 'public_creator'))]) {
    const page = await browser.get('/');
    assert.equal(page.status, 200);
    assert.match(page.text, /8 bets<\/a>, 8 settled, [0-9.]+ test NEAR won/);
    assert.match(page.text, /@public_creator won the 0\.2 test NEAR pot/);
    for (const bet of bets.slice(8)) assert.doesNotMatch(page.text, new RegExp(`/bets/${bet.id}`));
    assert.doesNotMatch(page.text, /private fixture note|private\.example\.org/);
  }
  await s.db.query(`update bilateral_near_requests set execution_status='failed' where id=$1`, [requestId]);
  assert.equal((await publicBetHall(s.db)).paidYocto, '0');
});

test('home renders without a hall when no Bet is published', async () => {
  const page = await s.browser().get('/');
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, / settled, [0-9.]+ test NEAR won/);
  assert.deepEqual(await publicBetHall(s.db), { rows: [], total: 0, settled: 0, paidYocto: '0', wonYocto: '0' });
});

test('unfunded and wrong-creator bets cannot be published', async () => {
  const bet = await makeBet();
  await assert.rejects(publishBet(s.db, creator, bet.id), (err) => err.status === 409);
  await storeFinalizedSnapshot(bet);
  await assert.rejects(publishBet(s.db, other, bet.id), (err) => err.status === 404);
  assert.equal(await publicBet(s.db, bet.id), null);
});

test('anonymous reads are empty until explicit publication consent', async () => {
  const bet = await makeBet();
  await storeFinalizedSnapshot(bet);
  assert.equal(await publicBet(s.db, bet.id), null);
  assert.deepEqual(await recentPublicBets(s.db), []);
});

test('public evidence includes this Bet and public siblings without disclosing private siblings', async () => {
  const current = await makeBet();
  const shared = await makeBet();
  const hidden = await makeBet(other);
  const source = await s.db.one(`insert into sources (platform,platform_id,url,text,acquisition)
    values ('x',$1,'https://example.org/post','Shared post','mention') returning id`, [randomUUID()]);
  const statement = await s.db.one(`insert into statements (source_id,span,speaker)
    values ($1,'Shared post','@author') returning id`, [source.id]);
  const save = await s.db.one(`insert into saves (owner_x_user_id,owner_user_id,statement_id,relation,intake)
    values ($1,$2,$3,'following','mention') returning id`, [creator.x_user_id, creator.id, statement.id]);
  for (const sibling of [current, shared, hidden]) {
    await s.db.query('update bilateral_bets set source_save_id=$2 where id=$1', [sibling.id, save.id]);
  }
  for (const sibling of [current, shared]) {
    await storeFinalizedSnapshot(sibling);
    await publishBet(s.db, creator, sibling.id);
  }
  for (const [sibling, user, label] of [[current, creator, 'current'], [shared, creator, 'shared'], [hidden, other, 'private']]) {
    const body = `${label} evidence body`;
    await s.db.query(`insert into bet_evidence (statement_id,bet_id,user_id,side,url,final_url,title,body,body_hash,via)
      values ($1,$2,$3,'yes',$4,$5,$6,$7,$8,'page')`,
    [statement.id, sibling.id, user.id, `https://posted.example.org/${label}`,
      `https://final.example.net/${label}`, `${label} evidence title`, body, sha256(Buffer.from(body))]);
  }
  let projection = await publicBet(s.db, current.id);
  assert.deepEqual(projection.evidence.items.map(item => item.title), ['current evidence title', 'shared evidence title']);
  assert.equal(projection.evidence.privateItemCount, 0, 'unread private links are not counted');
  assert.equal(projection.evidence.items[0].url, 'https://final.example.net/current');
  assert.equal(projection.evidence.items[0].postedUrl, 'https://posted.example.org/current');
  assert.doesNotMatch(JSON.stringify(projection.evidence), /private evidence|\/private|public_other/);
  const shown = await s.browser().get(`/bets/${current.id}`);
  assert.equal(shown.status, 200);
  assert.match(shown.text, /href="https:\/\/final\.example\.net\/current"/);
  assert.match(shown.text, /<span class="quiet">final\.example\.net<\/span>/);
  assert.match(shown.text, /<span class="quiet">posted as posted\.example\.org<\/span>/);
  assert.doesNotMatch(shown.text, /private evidence|\/private|public_other|href="https:\/\/posted\.example\.org/);
  await withdrawBetPublication(s.db, creator, shared.id);
  projection = await publicBet(s.db, current.id);
  assert.deepEqual(projection.evidence.items.map(item => item.title), ['current evidence title']);
});

test('private-profile creator can publish a narrow projection without private account data', async () => {
  const bet = await makeBet();
  await storeFinalizedSnapshot(bet);
  await s.db.query(`update users set profile_visibility='private' where id=$1`, [String(creator.id)]);
  const published = await publishBet(s.db, creator, bet.id);
  assert.equal(published.id, bet.id);
  assert.equal(published.funded, true);
  assert.equal(published.creator_username, creator.x_username);
  for (const field of ['terms_salt', 'source_save_id', 'metadata', 'notes', 'events', 'proposals', 'saves']) {
    assert.equal(Object.hasOwn(published, field), false, `${field} must not be in the public projection`);
  }
  assert.equal((await s.db.one('select profile_visibility from users where id=$1', [String(creator.id)])).profile_visibility, 'private');
});

test('public identity requires a bound acceptance and separate consent', async () => {
  const bet = await makeBet();
  await storeFinalizedSnapshot(bet, { status: 'accepted', acceptor: 'joiner.testnet' });
  await publishBet(s.db, creator, bet.id);
  assert.equal((await publicBet(s.db, bet.id)).acceptor_username, null, 'a wallet without an X binding has no username');
  await assert.rejects(consentToPublicBet(s.db, other, bet.id), (err) => err.status === 403);

  const boundBet = await makeBet();
  await storeFinalizedSnapshot(boundBet, { status: 'accepted', acceptor: 'joiner.testnet', acceptedUser: other });
  await publishBet(s.db, creator, boundBet.id);
  assert.equal((await publicBet(s.db, boundBet.id)).acceptor_username, null, 'binding alone is not identity consent');
  await consentToPublicBet(s.db, other, boundBet.id);
  assert.equal((await publicBet(s.db, boundBet.id)).acceptor_username, other.x_username);
});

test('settled and refunded public bets remain readable from finalized snapshots', async () => {
  for (const status of ['settled', 'refunded']) {
    const bet = await makeBet();
    await storeFinalizedSnapshot(bet, { status, acceptor: 'joiner.testnet' });
    await publishBet(s.db, creator, bet.id);
    const result = await publicBet(s.db, bet.id);
    assert.equal(result.status, status);
    assert.equal(result.chain_verification, 'finalized_snapshot');
    assert.equal(result.funded, true);
  }
});

test('public settlement proof requires a matching referee event and publication', async () => {
  const hash = '11111111111111111111111111111111'; // Base58 encoding of 32 zero bytes
  const refereeAccount = 'referee.testnet';
  const seedSettlement = async ({ outcome = 'yes', method = 'referee', event = true,
    eventHash = hash, eventOutcome = outcome, eventReferee = refereeAccount, actor = creator,
    publish = true } = {}) => {
    const bet = await makeBet(creator, { refereeAccount });
    const chain = await storeFinalizedSnapshot(bet, {
      status: 'accepted', acceptor: 'joiner.testnet', acceptedUser: other,
    });
    if (publish) await publishBet(s.db, creator, bet.id);
    chain.status = 'settled';
    chain.resolution = { outcome, method };
    await s.db.query(`update bilateral_bets set chain_state=$2, status='settled',
      outcome=$3, settled_at=clock_timestamp() where id=$1`, [bet.id, chain, outcome]);
    if (event) {
      await s.db.query(`insert into bilateral_bet_events (bet_id, actor_user_id, kind, detail)
        values ($1,$2,'referee_resolved',$3)`, [bet.id, String(actor.id), {
        outcome: eventOutcome, referee: eventReferee, transactionHash: eventHash,
      }]);
    }
    return bet;
  };

  const valid = await seedSettlement();
  const projection = await publicBet(s.db, valid.id);
  assert.equal(projection.settlement_transaction_hash, hash);
  const page = await s.browser().get(`/bets/${valid.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, new RegExp(`<a[^>]+href="https://testnet\\.nearblocks\\.io/txns/${hash}"[^>]*>Verify settlement</a>`));
  assert.match(page.text, /<b>Came true<\/b>/);
  assert.doesNotMatch(page.text, /private\.example\.org\/evidence|private fixture note|Paid to your account/);

  const evidencePath = `/admin/bets/${valid.id}/evidence`;
  const admin = await s.signIn(s.fakeX.addUser('900', 'result_reviewer'));
  assert.equal((await admin.get(evidencePath)).status, 200, 'reviewer can deliberately publish new public evidence');
  assert.equal((await s.db.one(`select count(*)::int as n from bilateral_bet_events where kind='public_result_evidence'`)).n, 0,
    'reading the approval form publishes nothing');
  assert.equal((await s.browser().get(evidencePath)).status, 404);
  const owner = await s.signIn(s.fakeX.addUser('81001', 'public_creator'));
  assert.equal((await owner.get(evidencePath)).status, 404, 'being a bettor does not grant reviewer access');
  assert.equal((await admin.request('POST', evidencePath, { form: { note: 'Unapproved' } })).status, 403);
  const input = { note: 'The official result confirms this claim. <script>alert(1)</script>',
    url: 'https://example.org/public-outcome', knownAt: new Date(Date.now() - 3600000).toISOString() };
  for (const bad of [{ url: 'javascript:alert(1)' }, { note: 'x'.repeat(601) },
    { knownAt: new Date(Date.now() + 3600000).toISOString() }]) {
    const rejected = await admin.submit(evidencePath, { ...input, ...bad });
    assert.equal(rejected.status, 400);
    assert.equal((await publicBet(s.db, valid.id)).result_evidence, undefined);
  }
  const publishedEvidence = await admin.submit(evidencePath, input);
  assert.equal(publishedEvidence.status, 200);
  const evidenced = await publicBet(s.db, valid.id);
  assert.equal(evidenced.result_evidence.note, input.note);
  assert.equal(evidenced.result_evidence.url, input.url);
  assert.equal(evidenced.result_evidence.knownAt, input.knownAt);
  assert.ok(evidenced.result_evidence.publishedAt);
  const publicEvidencePage = await s.browser().get(`/bets/${valid.id}`);
  assert.match(publicEvidencePage.text, /Verify settlement/);
  assert.match(publicEvidencePage.text, /href="https:\/\/example\.org\/public-outcome"[^>]*>Result source<\/a>/);
  assert.match(publicEvidencePage.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(publicEvidencePage.text, /<script>alert|private fixture note|private\.example\.org/);
  await Promise.all([admin.submit(evidencePath, { ...input, note: 'Replacement A' }),
    admin.submit(evidencePath, { ...input, note: 'Replacement B' })]);
  assert.equal((await publicBet(s.db, valid.id)).result_evidence.note, input.note,
    'replays cannot replace the first approved explanation');
  assert.equal((await s.db.one(`select count(*)::int as n from bilateral_bet_events
    where bet_id=$1 and kind='public_result_evidence'`, [valid.id])).n, 1);
  await s.db.query(`update bilateral_bet_proposals set note='changed private note' where bet_id=$1`, [valid.id]);
  assert.equal((await publicBet(s.db, valid.id)).result_evidence.note, input.note);

  const privateWinner = await seedSettlement({ outcome: 'no' });
  const privatePage = await s.browser().get(`/bets/${privateWinner.id}`);
  assert.match(privatePage.text, /<span class="struck">/);
  const shareText = (response) => new URL(response.text.match(/href="(https:\/\/x\.com\/intent\/post\?[^"]+)"/)[1]
    .replaceAll('&amp;', '&')).searchParams.get('text');
  assert.equal(shareText(privatePage), 'Result: No. The no side won the 0.2 test NEAR pot.');
  await consentToPublicBet(s.db, other, privateWinner.id);
  assert.equal(shareText(await s.browser().get(`/bets/${privateWinner.id}`)),
    'Result: No. @public_other won the 0.2 test NEAR pot.');

  const invalidCases = [
    ['agreement resolution', { method: 'agreement' }],
    ['missing event', { event: false }],
    ['mismatched event outcome', { eventOutcome: 'no' }],
    ['mismatched referee', { eventReferee: 'another.testnet' }],
    ['mismatched actor', { actor: other }],
    ['invalid transaction hash', { eventHash: '1'.repeat(33) }],
    ['void resolution', { outcome: 'void' }],
  ];
  for (const [label, options] of invalidCases) {
    const bet = await seedSettlement(options);
    const result = await publicBet(s.db, bet.id);
    assert.equal(result.status, 'settled', label);
    assert.equal(Boolean(result.settlement_transaction_hash), false, label);
    assert.doesNotMatch((await s.browser().get(`/bets/${bet.id}`)).text, /Verify settlement/, label);
    assert.equal((await admin.get(`/admin/bets/${bet.id}/evidence`)).status, 404, label);
  }

  const unpublished = await seedSettlement({ publish: false });
  assert.equal(await publicBet(s.db, unpublished.id), null);
  const cardPath = `${s.base}/share/bets/${valid.id}.png`;
  assert.equal((await fetch(cardPath)).status, 200);
  await withdrawBetPublication(s.db, creator, valid.id);
  assert.equal(await publicBet(s.db, valid.id), null);
  assert.equal((await fetch(cardPath)).status, 404);
});

test('a taken bet offers Follow and a closed bet links to a takeable offer', async () => {
  const bet = await makeBet();
  await storeFinalizedSnapshot(bet, { status: 'accepted', acceptor: 'joiner.testnet', acceptedUser: other });
  await publishBet(s.db, creator, bet.id);
  const path = `/bets/${bet.id}`;
  const anonymous = await s.browser().get(`${path}?done=following`);
  assert.match(anonymous.text, /Follow the result/);
  assert.doesNotMatch(anonymous.text, /Updates will appear in your Inbox/);
  const followerBrowser = await s.signIn(s.fakeX.addUser('81003', 'public_follower'));
  const confirmation = await followerBrowser.get(`${path}?follow=1`);
  assert.match(confirmation.text, /<button class="primary big" type="submit">Follow the result<\/button>/);
  await followerBrowser.submit(`${path}/follow`, {}, { from: `${path}?follow=1` });
  await followerBrowser.submit(`${path}/follow`, {}, { from: path });
  const followed = await followerBrowser.get(path);
  assert.match(followed.text, /Updates will appear in your Inbox/);
  assert.doesNotMatch(followed.text, /Follow the result/);
  assert.equal((await publicBet(s.db, bet.id)).follower_count, '1');

  const closed = await makeBet();
  await storeFinalizedSnapshot(closed, { status: 'settled', acceptor: 'joiner.testnet' });
  await publishBet(s.db, creator, closed.id);
  const offer = await makeBet();
  await storeFinalizedSnapshot(offer);
  await publishBet(s.db, creator, offer.id);
  const result = await s.browser().get(`/bets/${closed.id}`);
  assert.match(result.text, new RegExp(`<a class="pill solid big" href="/bets/${offer.id}">Take another bet</a>`));
});

test('a signed-in person can follow without setup or a wallet, with one follower count', async () => {
  const bet = await makeBet();
  await storeFinalizedSnapshot(bet);
  await publishBet(s.db, creator, bet.id);
  await assert.rejects(followPublicBet(s.db, null, bet.id), (err) => err.status === 401);
  await followPublicBet(s.db, follower, bet.id);
  await followPublicBet(s.db, follower, bet.id);
  assert.equal((await publicBet(s.db, bet.id)).follower_count, '1');
  assert.equal((await followsFor(s.db, follower)).length, 1);
});

test('withdrawal removes public, discovery and follow reads while preserving the bet row', async () => {
  const bet = await makeBet();
  await storeFinalizedSnapshot(bet);
  await publishBet(s.db, creator, bet.id);
  await followPublicBet(s.db, follower, bet.id);
  await withdrawBetPublication(s.db, creator, bet.id);
  assert.equal(await publicBet(s.db, bet.id), null);
  assert.equal((await recentPublicBets(s.db)).some((row) => row.id === bet.id), false);
  assert.equal((await followsFor(s.db, follower)).some((row) => row.id === bet.id), false);
  assert.equal((await s.db.one('select id from bilateral_bets where id=$1', [bet.id])).id, bet.id);
});

test('old verification timestamps are labelled stale and invalid references are rejected', async () => {
  const bet = await makeBet();
  await storeFinalizedSnapshot(bet, { ageMs: 6 * 60 * 1000 });
  await publishBet(s.db, creator, bet.id);
  assert.equal((await publicBet(s.db, bet.id)).chain_freshness, 'stale');
  await assert.rejects(publicBet(s.db, 'not-a-uuid'), (err) => err.status === 400);
  await assert.rejects(recentPublicBets(s.db, 0), (err) => err.status === 400);
});

test('public Bet HTML and PNG share the publication gate, including an already-rendered card', async () => {
  const bet = await makeBet();
  await storeFinalizedSnapshot(bet);
  const imageUrl = `${s.base}/share/bets/${bet.id}.png`;
  assert.equal((await fetch(imageUrl)).status, 404);
  await publishBet(s.db, creator, bet.id);
  const page = await s.browser().get(`/bets/${bet.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /summary_large_image/);
  assert.ok(page.text.includes(`/share/bets/${bet.id}.png`));
  const image = await fetch(imageUrl);
  assert.equal(image.status, 200);
  assert.equal(image.headers.get('cache-control'), 'no-store');
  assert.equal(image.headers.get('content-type'), 'image/png');
  const png = Buffer.from(await image.arrayBuffer());
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  await withdrawBetPublication(s.db, creator, bet.id);
  assert.equal((await fetch(imageUrl)).status, 404, 'cached bytes cannot bypass current publication authorization');
});

test('an already-rendered Bet card changes when acceptance closes', async () => {
  const bet = await makeBet();
  await storeFinalizedSnapshot(bet);
  await publishBet(s.db, creator, bet.id);
  const realNow = Date.now;
  let clock = new Date(bet.accept_by).getTime() - 1000;
  Date.now = () => clock;
  try {
    const url = `${s.base}/share/bets/${bet.id}.png`;
    const before = Buffer.from(await (await fetch(url)).arrayBuffer());
    clock = new Date(bet.accept_by).getTime() + 1000;
    const after = Buffer.from(await (await fetch(url)).arrayBuffer());
    assert.notDeepEqual(after, before, 'expired card cannot reuse the cached open-seat image');
  } finally { Date.now = realNow; }
});
