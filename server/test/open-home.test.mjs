// PostgreSQL and HTTP are real; finalized NEAR snapshots below are synthetic fixtures.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { startStack } from './support/app.mjs';
import { createBet } from '../src/bets.mjs';
import { publishBet, nextOpenPublicBet } from '../src/bet-public.mjs';
import { tick } from '../src/worker.mjs';
import { signInFromX } from '../src/store.mjs';

let s, creator, invited, creatorBrowser, bet, save;
const ns = v => (BigInt(new Date(v).getTime()) * 1000000n).toString();
before(async () => {
  s = await startStack({ STATED_PLAY: '1', STATED_NEAR_CONTRACT: 'escrow.testnet' });
  const bot = s.fakeX.addUser('500', 'statedbot');
  await s.connectBot(bot);
  const author = s.fakeX.addUser('601', 'hidden_source_author');
  const x = s.fakeX.addUser('602', 'bet_creator');
  creatorBrowser = await s.signIn(x);
  await creatorBrowser.submit('/setup', { profile: 'private', defaults: 'private' });
  creator = await s.db.one('select * from users where x_user_id=$1', [x.id]);
  invited = await signInFromX(s.db, { id: '604', username: 'invited_person' });
  const post = s.fakeX.post(author.id, 'Private source words must remain hidden.');
  s.fakeX.post(x.id, '@statedbot', { replyTo: post.id });
  await tick(s.db, s.config, s.x);
  save = await s.db.one(`select s.id from saves s join statements st on st.id=s.statement_id
    join sources src on src.id=st.source_id where src.platform_id=$1`, [post.id]);
  assert.ok(save);
  bet = await createBet(s.db, creator, { requestId: randomUUID(), claim: 'Agreed public proposition', criteria: 'Public criteria',
    evidenceSourceUrl: 'https://example.org/result', creatorSide: 'yes', stakeNear: '0.1', sourceSaveId: String(save.id),
    acceptBy: new Date(Date.now() + 86400000).toISOString(), resolveAt: new Date(Date.now() + 172800000).toISOString() });
  const binding = randomUUID().replaceAll('-', '').padEnd(64, 'a');
  const chain = { id: bet.id, terms_hash: bet.terms_hash, stake_yocto: bet.stake_yocto, creator_side: bet.creator_side,
    accept_by_ns: ns(bet.accept_by), resolve_at_ns: ns(bet.resolve_at), invited_account: null, referee: null,
    creator: 'creator.testnet', creator_binding_hash: binding, status: 'offered', acceptor: null };
  await s.db.query(`insert into bilateral_near_requests (id,bet_id,user_id,wallet_account,method,args,binding_hash,metadata)
    values ($1,$2,$3,'creator.testnet','create_bet','{}',$4,'{}')`, [randomUUID(), bet.id, creator.id, binding]);
  await s.db.query(`update bilateral_bets set chain_state=$2,creator_wallet='creator.testnet',near_height=1,near_verified_at=clock_timestamp() where id=$1`, [bet.id, chain]);
  await publishBet(s.db, creator, bet.id);
});
after(async () => { await s?.close(); });

test('home offers published terms from a private source without exposing it', async () => {
  const page = await s.browser().get('/');
  assert.equal(page.status, 200);
  assert.match(page.text, /Agreed public proposition/);
  assert.match(page.text, /bet_creator/);
  assert.match(page.text, /0\.1/);
  assert.match(page.text, new RegExp(`/bets/${bet.id}\\?join=1#accept`));
  const joinPage = await s.browser().get(`/bets/${bet.id}?join=1`);
  assert.match(joinPage.text, new RegExp(`/signin/x\\?return=${encodeURIComponent(`/bets/${bet.id}?join=1`)}`));
  assert.equal((page.text.match(/class="pill solid big/g) || []).length, 1);
  assert.equal((page.text.match(/href="\/signin[^\"]*"/g) || []).length, 1);
  assert.doesNotMatch(page.text, /Private source words|hidden_source_author/);
});

test('selection excludes stale and own offers', async () => {
  assert.equal((await nextOpenPublicBet(s.db)).id, bet.id);
  assert.equal(await nextOpenPublicBet(s.db, creator.id), null);
  await s.db.query(`update bilateral_bets set near_verified_at=clock_timestamp()-interval '10 minutes' where id=$1`, [bet.id]);
  assert.equal(await nextOpenPublicBet(s.db), null);
  await s.db.query(`update bilateral_bets set near_verified_at=clock_timestamp() where id=$1`, [bet.id]);
});

test('the creator cannot take their own offer from home', async () => {
  const page = await creatorBrowser.get('/');
  assert.equal(page.status, 200);
  assert.match(page.text, /Agreed public proposition/, 'the published offer remains in the hall');
  assert.doesNotMatch(page.text, new RegExp(`/bets/${bet.id}\\?join=1`));
  assert.doesNotMatch(page.text, /Take no/);
});

test('an unpublished funded offer does not appear', async () => {
  await s.db.query('delete from bilateral_bet_publications where bet_id=$1', [bet.id]);
  assert.equal(await nextOpenPublicBet(s.db), null);
  assert.doesNotMatch((await s.browser().get('/')).text, /Agreed public proposition/);
  await publishBet(s.db, creator, bet.id);
});

test('a newer stale publication does not hide the recent offer', async () => {
  const newer = await createBet(s.db, creator, { requestId: randomUUID(), claim: 'Newer stale offer', criteria: 'Public criteria',
    evidenceSourceUrl: 'https://example.org/result', creatorSide: 'no', stakeNear: '0.1',
    acceptBy: new Date(Date.now() + 86400000).toISOString(), resolveAt: new Date(Date.now() + 172800000).toISOString() });
  const binding = randomUUID().replaceAll('-', '').padEnd(64, 'a');
  const chain = { id: newer.id, terms_hash: newer.terms_hash, stake_yocto: newer.stake_yocto, creator_side: newer.creator_side,
    accept_by_ns: ns(newer.accept_by), resolve_at_ns: ns(newer.resolve_at), invited_account: null, referee: null,
    creator: 'creator.testnet', creator_binding_hash: binding, status: 'offered', acceptor: null };
  await s.db.query(`insert into bilateral_near_requests (id,bet_id,user_id,wallet_account,method,args,binding_hash,metadata)
    values ($1,$2,$3,'creator.testnet','create_bet','{}',$4,'{}')`, [randomUUID(), newer.id, creator.id, binding]);
  await s.db.query(`update bilateral_bets set chain_state=$2,creator_wallet='creator.testnet',near_height=1,near_verified_at=clock_timestamp() where id=$1`, [newer.id, chain]);
  await publishBet(s.db, creator, newer.id);
  await s.db.query(`update bilateral_bets set near_verified_at=clock_timestamp()-interval '10 minutes' where id=$1`, [newer.id]);
  assert.equal((await nextOpenPublicBet(s.db)).id, bet.id);
  assert.match((await s.browser().get('/')).text, /Agreed public proposition/);
});

test('home excludes withdrawn, unverified, expired, invited and incompatible offers', async () => {
  const cases = [
    [`update bilateral_bet_publications set withdrawn_at=clock_timestamp() where bet_id=$1`,
      `update bilateral_bet_publications set withdrawn_at=null where bet_id=$1`],
    [`update bilateral_bets set near_verified_at=null where id=$1`,
      `update bilateral_bets set near_verified_at=clock_timestamp() where id=$1`],
    [`update bilateral_bets set near_height=null where id=$1`,
      `update bilateral_bets set near_height=1 where id=$1`],
    [`update bilateral_bets set accept_by=clock_timestamp()-interval '1 second' where id=$1`,
      `update bilateral_bets set accept_by=$2 where id=$1`],
    [`update bilateral_bets set invited_wallet='invited.testnet' where id=$1`,
      `update bilateral_bets set invited_wallet=null where id=$1`],
    [`update bilateral_bets set invited_user_id=${invited.id} where id=$1`,
      `update bilateral_bets set invited_user_id=null where id=$1`],
    [`update bilateral_bets set chain_state=jsonb_set(chain_state,'{status}','"accepted"') where id=$1`,
      `update bilateral_bets set chain_state=jsonb_set(chain_state,'{status}','"offered"') where id=$1`],
    [`update bilateral_bets set chain_state=jsonb_set(chain_state,'{status}','"settled"') where id=$1`,
      `update bilateral_bets set chain_state=jsonb_set(chain_state,'{status}','"offered"') where id=$1`],
  ];
  for (const [disable, restore] of cases) {
    await s.db.query(disable, [bet.id]);
    assert.equal(await nextOpenPublicBet(s.db), null, disable);
    assert.doesNotMatch((await s.browser().get('/')).text.split(' settled, ')[0], /Agreed public proposition/, disable);
    await s.db.query(restore, restore.includes('$2') ? [bet.id, bet.accept_by] : [bet.id]);
  }
  const enabled = s.config.play.enabled;
  s.config.play.enabled = false;
  assert.doesNotMatch((await s.browser().get('/')).text.split(' settled, ')[0], /Agreed public proposition/);
  s.config.play.enabled = enabled;
  const real = s.config.near.real;
  s.config.near.real = true;
  assert.doesNotMatch((await s.browser().get('/')).text.split(' settled, ')[0], /Agreed public proposition/);
  s.config.near.real = real;
});

test('the fallback keeps an otherwise visible public prediction in the list', async () => {
  const publicUser = s.fakeX.addUser('603', 'public_author');
  const browser = await s.signIn(publicUser);
  await browser.submit('/me/settings/publish', [['confirm', '1'], ['defaults', 'public']], { from: '/setup' });
  const post = s.fakeX.post(publicUser.id, 'Public prediction remains visible next year.');
  s.fakeX.post(publicUser.id, '@statedbot', { replyTo: post.id });
  await tick(s.db, s.config, s.x);
  const page = await s.browser().get('/');
  assert.equal(page.status, 200);
  assert.match(page.text, /Agreed public proposition/);
  assert.match(page.text, /Public prediction remains visible next year/);
  assert.match(page.text, /class="posts"/);
  assert.doesNotMatch(page.text, /Private source words|hidden_source_author/);
});
