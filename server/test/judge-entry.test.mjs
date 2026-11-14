// Persisted synthetic snapshots only; no live NEAR transaction is claimed.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createBet } from '../src/bets.mjs';
import { consentToPublicBet, publishBet, withdrawBetPublication } from '../src/bet-public.mjs';
import { loadConfig } from '../src/config.mjs';
import { completeSetup, signInFromX } from '../src/store.mjs';
import { startStack } from './support/app.mjs';

let s;
const ns = (date) => (BigInt(new Date(date).getTime()) * 1000000n).toString();
const binding = (c) => c.repeat(64);
before(async () => { s = await startStack(); });
after(async () => { if (s) await s.close(); });

test('signed-out home exposes only an eligible testnet Bet', async () => {
  const user = async (id, username) => completeSetup(s.db, await signInFromX(s.db, { id, username }), { profileVisibility: 'private' });
  const creator = await user('83001', 'fixture_creator');
  const acceptor = await user('83002', 'fixture_acceptor');
  const bet = await createBet(s.db, creator, {
    requestId: randomUUID(), claim: 'Synthetic claim', criteria: 'Synthetic criterion',
    evidenceSourceUrl: 'https://example.org/result', creatorSide: 'yes', stakeNear: '0.1',
    acceptBy: new Date(Date.now() + 86400000).toISOString(), resolveAt: new Date(Date.now() + 172800000).toISOString(),
  });
  // The demo button is gone. A signed-out visitor reaches a Bet through the home list of published,
  // chain-verified Bets, and never sees an acceptor who has not consented to be named.
  const page = async (visible, { acceptorNamed = false } = {}) => {
    const res = await s.browser().get('/');
    assert.equal(res.status, 200);
    assert.doesNotMatch(res.text, /View test bet|Operator-controlled test on NEAR testnet/, 'the demo button and its line are gone');
    assert.equal(res.text.includes(`<a href="/bets/${bet.id}">`), visible);
    assert.equal(res.text.includes('Synthetic claim'), visible);
    if (visible) assert.match(res.text, new RegExp(`<section id="public-bets">[\\s\\S]*<a href="/bets/${bet.id}">Synthetic claim`));
    if (!acceptorNamed) assert.doesNotMatch(res.text, /fixture_acceptor|acceptor\.testnet/);
    assert.doesNotMatch(res.text, /private fixture note|Paid to your account/);
    // Mainnet starts with a sentence; testnet keeps its existing sign-in action.
    if (s.config.near.real) {
      assert.match(res.text, /<form method="get" action="\/me\/bets\/new" data-bet-start>/);
      assert.match(res.text, />Review bet<\/button>/);
    } else assert.match(res.text, /href="\/signin">Make a bet<\/a>/);
  };
  assert.equal(loadConfig({ STATED_DEMO_BET_ID: 'invalid' }).demoBetId, null);
  assert.equal(loadConfig({}).demoBetId, null);
  assert.equal(loadConfig({ STATED_DEMO_BET_ID: bet.id.toUpperCase() }).demoBetId, bet.id);
  await page(false);
  s.config.demoBetId = loadConfig({ STATED_DEMO_BET_ID: 'invalid' }).demoBetId;
  await page(false);
  s.config.demoBetId = bet.id;
  await page(false); // unpublished and unfunded
  const chain = { id: bet.id, terms_hash: bet.terms_hash, stake_yocto: bet.stake_yocto,
    creator_side: bet.creator_side, accept_by_ns: ns(bet.accept_by), resolve_at_ns: ns(bet.resolve_at),
    invited_account: bet.invited_wallet, referee: bet.referee_wallet, creator: 'creator.testnet',
    creator_binding_hash: binding('a'), acceptor: 'acceptor.testnet', acceptor_binding_hash: binding('b'),
    status: 'accepted', proposal: null };
  for (const [owner, wallet, method, hash] of [[creator, chain.creator, 'create_bet', binding('a')], [acceptor, chain.acceptor, 'accept_bet', binding('b')]]) {
    await s.db.query(`insert into bilateral_near_requests (id,bet_id,user_id,wallet_account,method,args,binding_hash,metadata)
      values ($1,$2,$3,$4,$5,'{}',$6,'{"fixture":"synthetic"}')`, [randomUUID(), bet.id, String(owner.id), wallet, method, hash]);
  }
  await s.db.query(`update bilateral_bets set chain_state=$2,creator_wallet=$3,acceptor_wallet=$4,
    acceptor_user_id=$5,status='accepted',near_height=321,near_verified_at=clock_timestamp(),accepted_at=clock_timestamp() where id=$1`,
  [bet.id, chain, chain.creator, chain.acceptor, String(acceptor.id)]);
  await publishBet(s.db, creator, bet.id);
  await page(true); // published and verified: listed, acceptor unnamed
  chain.status = 'settled'; chain.proposal = { outcome: 'yes', proposer: chain.creator, revision: '1' };
  await s.db.query("update bilateral_bets set chain_state=$2,status='settled',outcome='yes',settled_at=clock_timestamp() where id=$1", [bet.id, chain]);
  await page(true); // acceptor has not consented to identity publication: still unnamed
  await consentToPublicBet(s.db, acceptor, bet.id);
  await page(true, { acceptorNamed: true });
  assert.equal((await s.browser().get(`/bets/${bet.id}`)).status, 200);
  s.config.near.real = true;
  await page(true, { acceptorNamed: true });
  assert.doesNotMatch((await s.browser().get('/')).text, /join=1/, 'real NEAR offers no take link from home');
  s.config.near.real = false;
  chain.proposal.outcome = 'void';
  await s.db.query('update bilateral_bets set chain_state=$2 where id=$1', [bet.id, chain]);
  await page(true, { acceptorNamed: true });
  chain.proposal.outcome = 'yes';
  await s.db.query('update bilateral_bets set chain_state=$2,near_height=null where id=$1', [bet.id, chain]);
  await page(false); // unverified
  await s.db.query('update bilateral_bets set near_height=321 where id=$1', [bet.id]);
  await s.db.query('update bilateral_bets set near_verified_at=null where id=$1', [bet.id]);
  await page(false);
  await s.db.query('update bilateral_bets set near_verified_at=clock_timestamp() where id=$1', [bet.id]);
  await withdrawBetPublication(s.db, creator, bet.id);
  await page(false);
});
