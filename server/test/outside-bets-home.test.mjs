// INTEGRATION: real PostgreSQL and HTTP. NEAR snapshots are labelled database fixtures.
// The home page counts public bets taken by people outside the team, and only when there are some.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, beforeEach, test } from 'node:test';
import { createBet } from '../src/bets.mjs';
import { publishBet, withdrawBetPublication } from '../src/bet-public.mjs';
import { outsideBetsTaken } from '../src/metrics.mjs';
import { completeSetup, signInFromX } from '../src/store.mjs';
import { startStack, ADMIN_X_ID } from './support/app.mjs';
import { resetDb } from './support/pg.mjs';

const TEAM_X_ID = '82099';
let s;
let creator;

const ns = (value) => (BigInt(new Date(value).getTime()) * 1000000n).toString();
const binding = () => randomUUID().replaceAll('-', '').padEnd(64, 'a').slice(0, 64);
const homeText = async () => (await s.browser().get('/')).text;
const count = () => outsideBetsTaken(s.db, { exclude: s.config.excludeXIds, admins: s.config.adminXIds });

async function user(id, username) {
  return completeSetup(s.db, await signInFromX(s.db, { id, username }), { profileVisibility: 'private' });
}

// A bet whose finalized snapshot says `taker` accepted it, published unless told otherwise.
async function takenBet(taker, { publish = true } = {}) {
  const bet = await createBet(s.db, creator, {
    requestId: randomUUID(), claim: `Claim ${randomUUID().slice(0, 8)}`, criteria: 'Official result',
    evidenceSourceUrl: 'https://example.org/result', creatorSide: 'yes', stakeNear: '0.1',
    acceptBy: new Date(Date.now() + 86400000).toISOString(), resolveAt: new Date(Date.now() + 172800000).toISOString(),
  });
  const creatorBinding = binding();
  const acceptorBinding = binding();
  const acceptor = `taker-${taker.id}.testnet`;
  const chain = { id: bet.id, terms_hash: bet.terms_hash, stake_yocto: bet.stake_yocto, creator_side: 'yes',
    accept_by_ns: ns(bet.accept_by), resolve_at_ns: ns(bet.resolve_at), invited_account: null, referee: bet.referee_wallet,
    creator: 'creator.testnet', creator_binding_hash: creatorBinding, status: 'accepted', acceptor,
    acceptor_binding_hash: acceptorBinding, proposal: null };
  for (const [uid, wallet, method, hash] of [[creator.id, 'creator.testnet', 'create_bet', creatorBinding],
    [taker.id, acceptor, 'accept_bet', acceptorBinding]]) {
    await s.db.query(`insert into bilateral_near_requests (id,bet_id,user_id,wallet_account,method,args,binding_hash,metadata)
      values ($1,$2,$3,$4,$5,'{}',$6,'{"fixture":"synthetic"}')`, [randomUUID(), bet.id, String(uid), wallet, method, hash]);
  }
  await s.db.query(`update bilateral_bets set chain_state=$2, creator_wallet='creator.testnet', acceptor_wallet=$3,
    acceptor_user_id=$4, status='accepted', near_height=321, near_verified_at=clock_timestamp(),
    accepted_at=clock_timestamp() where id=$1`, [bet.id, chain, acceptor, String(taker.id)]);
  if (publish) await publishBet(s.db, creator, bet.id);
  return bet;
}

before(async () => { s = await startStack({ STATED_METRICS_EXCLUDE_X_IDS: TEAM_X_ID }); });
beforeEach(async () => {
  await resetDb(s.db);
  creator = await user('82001', 'team_creator');
});
after(async () => { if (s) await s.close(); });

test('N = 0: bets taken only by the team and the admin leave the line hidden', async () => {
  const team = await user(TEAM_X_ID, 'team_taker');
  const admin = await user(ADMIN_X_ID, 'admin_taker');
  await takenBet(team);
  await takenBet(admin);
  const page = await homeText();
  assert.match(page, /2 bets/, 'the existing bets line still shows');
  assert.doesNotMatch(page, /outside the team/);
  assert.equal(await count(), 0);
});

test('N = 0 with no bets at all', async () => {
  assert.doesNotMatch(await homeText(), /outside the team/);
  assert.equal(await count(), 0);
});

test('N = 2: outsiders count; team, admin, unpublished and withdrawn bets do not', async () => {
  const outsiderA = await user('82010', 'outsider_a');
  const outsiderB = await user('82011', 'outsider_b');
  const team = await user(TEAM_X_ID, 'team_taker');
  const admin = await user(ADMIN_X_ID, 'admin_taker');
  await takenBet(outsiderA);
  await takenBet(outsiderB);
  await takenBet(team);
  await takenBet(admin);
  await takenBet(outsiderA, { publish: false });
  const withdrawn = await takenBet(outsiderB);
  await withdrawBetPublication(s.db, creator, withdrawn.id);
  assert.match(await homeText(), /2 bets taken by people outside the team/);
  assert.equal(await count(), 2);
});

test('an offer nobody has taken is not counted', async () => {
  const bet = await takenBet(await user('82020', 'outsider_c'));
  await s.db.query(`update bilateral_bets set chain_state = chain_state - 'acceptor' where id=$1`, [bet.id]);
  assert.equal(await count(), 0);
  assert.doesNotMatch(await homeText(), /outside the team/);
});
