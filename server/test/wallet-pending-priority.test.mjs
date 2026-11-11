// INTEGRATION: Real PostgreSQL and HTTP, FakeX auth and synthetic NEAR RPC only.
// These fixtures establish local UI behavior, not live connector verification.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { baseEncode } from 'near-api-js';
import { createBet } from '../src/bets.mjs';
import { publishBet } from '../src/bet-public.mjs';
import { prepareNearAction, syncNearBet } from '../src/near-bets.mjs';
import { TESTNET_RPC } from '../src/near-escrow.mjs';
import { completeSetup, signInFromX } from '../src/store.mjs';
import { startStack } from './support/app.mjs';

let s, creator, joiner, creatorBrowser, joinerBrowser;
const chains = new Map();
const ns = value => (BigInt(new Date(value).getTime()) * 1000000n).toString();
const fetchImpl = async (url, options) => {
  if (s && String(url).startsWith(s.fakeX.base)) return fetch(url, options);
  assert.equal(url, TESTNET_RPC, 'no live NEAR or X requests');
  const { method, params } = JSON.parse(options.body);
  if (method === 'tx') return Response.json({ result: { final_execution_status: 'INCLUDED' } });
  assert.equal(method, 'query');
  assert.equal(params.method_name, 'get_bet');
  const { id } = JSON.parse(Buffer.from(params.args_base64, 'base64'));
  return Response.json({ result: { block_height: 100, result: [...Buffer.from(JSON.stringify(chains.get(id) || null))] } });
};

before(async () => {
  s = await startStack({ STATED_NEAR_CONTRACT: 'escrow.testnet' }, { fetchImpl });
  creator = await completeSetup(s.db, await signInFromX(s.db, { id: '98201', username: 'pending_owner' }), {});
  joiner = await completeSetup(s.db, await signInFromX(s.db, { id: '98202', username: 'pending_taker' }), {});
  creatorBrowser = await s.signIn(s.fakeX.addUser('98201', 'pending_owner'));
  joinerBrowser = await s.signIn(s.fakeX.addUser('98202', 'pending_taker'));
});
after(async () => { if (s) await s.close(); });

async function fixture(action = 'fund') {
  const bet = await createBet(s.db, creator, { requestId: randomUUID(), claim: 'SYNTHETIC pending stake fixture',
    criteria: 'Official synthetic result', evidenceSourceUrl: 'https://example.org/result', creatorSide: 'yes', stakeNear: '0.1',
    acceptBy: new Date(Date.now() + 86400000).toISOString(), resolveAt: new Date(Date.now() + 172800000).toISOString() });
  const funding = await prepareNearAction(s.db, s.config, creator, bet.id, { action: 'fund', accountId: 'owner.testnet' }, { fetchImpl });
  const chain = { id: bet.id, terms_hash: bet.terms_hash, stake_yocto: bet.stake_yocto,
    creator_side: bet.creator_side, accept_by_ns: ns(bet.accept_by), resolve_at_ns: ns(bet.resolve_at),
    invited_account: null, creator: 'owner.testnet', creator_binding_hash: funding.args.binding_hash,
    acceptor: null, proposal: null, status: 'offered' };
  let request = funding;
  if (action === 'accept') {
    chains.set(bet.id, chain);
    await syncNearBet(s.db, s.config, creator, bet.id, { fetchImpl });
    await publishBet(s.db, creator, bet.id);
    request = await prepareNearAction(s.db, s.config, joiner, bet.id,
      { action: 'accept', accountId: 'taker.testnet', termsHash: bet.terms_hash }, { fetchImpl });
  }
  return { bet, chain, request, browser: action === 'fund' ? creatorBrowser : joinerBrowser,
    path: `/bets/${bet.id}${action === 'accept' ? '?join=1' : ''}`,
    wallet: action === 'fund' ? 'owner.testnet' : 'taker.testnet', action, hash: baseEncode(randomBytes(32)) };
}

const front = page => page.text.split('<div class="folds">')[0];
const signingLabel = action => action === 'fund' ? 'Deposit stake' : 'Bet no';
async function pending(f) {
  const page = await f.browser.submit(`/bets/${f.bet.id}/transactions`, { requestId: f.request.requestId, transactionHash: f.hash }, { from: f.path });
  assert.equal(page.status, 200);
  assert.deepEqual(await s.db.one('select execution_status,transaction_hash from bilateral_near_requests where id=$1', [f.request.requestId]),
    { execution_status: 'pending', transaction_hash: f.hash });
  return page;
}

for (const action of ['fund', 'accept']) {
  test(`submitted pending ${action} prioritizes check over collapsed signing, preserves hidden ID and hash`, async () => {
    const f = await fixture(action);
    const returned = await pending(f);
    assert.match(front(returned), /class="primary big"[^>]*>Check transaction</,
      'the real POST redirect keeps the same actor in recovery, including public acceptance');
    await s.db.query('update bilateral_near_requests set execution_message=$2 where id=$1',
      [f.request.requestId, 'Check again <script>alert("wallet")</script>']);
    const page = await f.browser.get(f.path);
    assert.match(front(page), /class="primary big"[^>]*>Check transaction</);
    assert.doesNotMatch(front(page), new RegExp(`>${signingLabel(action)}<`));
    assert.match(page.text, /<details class="fold"><summary>Use a NEAR wallet<\/summary>/);
    assert.match(page.text, new RegExp(`class="big"[^>]*>${signingLabel(action)}<`));
    assert.equal((page.text.match(/class="primary big"/g) || []).length, 1, 'opening the fallback never reveals a second filled action');
    assert.match(page.text, new RegExp(`name="requestId" value="${f.request.requestId}"`));
    assert.match(page.text, new RegExp(`name="transactionHash" value="${f.hash}"`));
    assert.equal((page.text.match(/>Check transaction<\/button>/g) || []).length, 1);
    assert.equal((page.text.match(/Pending verification/g) || []).length, 1);
    assert.doesNotMatch(front(page), /class="notice" role="status"/);
    assert.match(front(page), /Check again &lt;script&gt;/);
    assert.doesNotMatch(page.text, /<script>alert/);
    assert.doesNotMatch(page.text.replace(/<[^>]*>/g, ''), new RegExp(f.request.requestId), 'internal request UUID is never visible');
  });

  test(`unknown approval ${action} continues its existing intent without claiming submission`, async () => {
    const f = await fixture(action);
    let page = await f.browser.get(f.path);
    assert.match(front(page), /class="primary big"[^>]*>Continue in wallet</);
    assert.doesNotMatch(front(page), new RegExp(`>${signingLabel(action)}<`));
    assert.match(front(page), /If you already approved this request, check its transaction before continuing\./);
    assert.match(page.text, /Awaiting wallet return/);
    assert.doesNotMatch(page.text, /Pending verification|Not submitted|unsigned/i);
    assert.match(front(page), new RegExp(`name="accountId" value="${f.wallet}"`));
    assert.doesNotMatch(front(page), />Check transaction<\/button>/);
    page = await f.browser.submit(`/bets/${f.bet.id}/${action}`, { accountId: f.wallet, termsHash: f.bet.terms_hash, publicConsent: '1' }, { from: f.path });
    assert.equal(page.status, 200);
    assert.match(page.text, /data-stated-wallet/);
    assert.match(page.text, new RegExp(`name="requestId" value="${f.request.requestId}"`));
    assert.equal((await s.db.one('select count(*)::int as n from bilateral_near_requests where bet_id=$1 and user_id=$2 and method=$3',
      [f.bet.id, action === 'fund' ? creator.id : joiner.id, action === 'fund' ? 'create_bet' : 'accept_bet'])).n, 1);
  });

  test(`failed ${action} keeps primary retry and its known account`, async () => {
    const f = await fixture(action);
    const message = 'Synthetic transaction failed <script>alert("wallet")</script>';
    await s.db.query("update bilateral_near_requests set execution_status='failed',transaction_hash=$2,execution_message=$3 where id=$1", [f.request.requestId, f.hash, message]);
    const page = await f.browser.get(f.path);
    assert.match(front(page), new RegExp(`>${signingLabel(action)}<`));
    assert.match(front(page), new RegExp(`name="accountId" value="${f.wallet}"`));
    assert.doesNotMatch(front(page), />Check transaction<\/button>/);
    assert.match(front(page), /class="notice" role="alert">Synthetic transaction failed &lt;script&gt;/);
    assert.ok(front(page).indexOf('Synthetic transaction failed') < front(page).indexOf(`>${signingLabel(action)}<`));
    assert.equal((page.text.match(/Synthetic transaction failed/g) || []).length, 1);
    assert.doesNotMatch(page.text, /<script>alert/);
    const checked = await f.browser.submit(`/bets/${f.bet.id}/transactions`, { requestId: f.request.requestId, transactionHash: f.hash }, { from: f.path });
    assert.equal(checked.status, 200);
    assert.match(front(checked), /class="notice" role="alert">Synthetic transaction failed &lt;script&gt;/,
      'a failed acceptance check returns its actor to the retry page');
    assert.match(front(checked), new RegExp(`>${signingLabel(action)}<`));
    const retry = await f.browser.submit(`/bets/${f.bet.id}/${action}`, { accountId: f.wallet, termsHash: f.bet.terms_hash, publicConsent: '1' }, { from: f.path });
    assert.equal(retry.status, 200);
    assert.match(retry.text, new RegExp(`name="requestId" value="${f.request.requestId}"`));
  });

  test(`succeeded ${action} has confirmed status and no transaction check`, async () => {
    const f = await fixture(action);
    await s.db.query("update bilateral_near_requests set execution_status='succeeded',transaction_hash=$2 where id=$1", [f.request.requestId, f.hash]);
    const page = await f.browser.get(f.path);
    assert.match(page.text, /Transaction confirmed/);
    assert.doesNotMatch(page.text, />Check transaction<\/button>/);
  });
}

test('other actors and configured contracts cannot supply the pending primary', async () => {
  const f = await fixture('accept');
  await pending(f);
  let page = await creatorBrowser.get(`/bets/${f.bet.id}`);
  assert.doesNotMatch(front(page), />Check transaction<\/button>/);
  assert.doesNotMatch(page.text, new RegExp(f.request.requestId));
  await s.db.query(`update bilateral_near_requests set metadata=jsonb_set(metadata,'{contract}','"other.testnet"') where id=$1`, [f.request.requestId]);
  page = await joinerBrowser.get(f.path);
  assert.doesNotMatch(front(page), />Check transaction<\/button>/);
  assert.doesNotMatch(page.text, new RegExp(f.request.requestId));
  assert.match(front(page), />Bet no</);
});

test('historical pending funding does not displace the next phase action', async () => {
  const f = await fixture();
  await pending(f);
  chains.set(f.bet.id, f.chain);
  await syncNearBet(s.db, s.config, creator, f.bet.id, { fetchImpl });
  const page = await creatorBrowser.get(f.path);
  assert.match(front(page), />Review before posting</);
  assert.doesNotMatch(front(page), />Check transaction<\/button>/);
});

test('historical pending acceptance is not promoted after both stakes are recorded', async () => {
  const f = await fixture('accept');
  await pending(f);
  chains.set(f.bet.id, { ...f.chain, status: 'accepted', acceptor: f.wallet, acceptor_binding_hash: f.request.args.binding_hash });
  await syncNearBet(s.db, s.config, joiner, f.bet.id, { fetchImpl });
  const page = await f.browser.get(f.path);
  assert.doesNotMatch(front(page), />Check transaction<\/button>/);
  assert.doesNotMatch(front(page), />Bet no</);
});

for (const status of ['pending', 'failed']) test(`a native ${status} deposit stays primary when its actor also owns a different managed wallet`, async () => {
  const f = await fixture('accept');
  await pending(f);
  if (status === 'failed') await s.db.query("update bilateral_near_requests set execution_status='failed',execution_message='Synthetic failed native stake' where id=$1", [f.request.requestId]);
  await s.db.query(`insert into play_accounts(x_user_id,account_id,public_key,ready) values($1,'managed.testnet','synthetic-unused-public-key',true)`, [joiner.x_user_id]);
  s.config.play.enabled = true;
  try {
    // Persist a synthetic referee-backed offer to exercise the managed-take
    // alternative without provisioning, signing, or calling a live network.
    await s.db.query(`update bilateral_bets set referee_wallet='referee.testnet',chain_state=jsonb_set(chain_state,'{referee}','"referee.testnet"') where id=$1`, [f.bet.id]);
    const page = await f.browser.get(f.path);
    assert.match(front(page), status === 'pending' ? /class="primary big"[^>]*>Check transaction</ : /class="primary big"[^>]*>Bet no</);
    if (status === 'failed') assert.match(front(page), /name="accountId" value="taker.testnet"/);
    assert.doesNotMatch(page.text, new RegExp(`action="/bets/${f.bet.id}/take"`));
    assert.match(page.text, /name="accountId" value="taker.testnet"/);
  } finally {
    s.config.play.enabled = false;
    await s.db.query('delete from play_accounts where x_user_id=$1', [joiner.x_user_id]);
  }
});

test('an unclaimed managed signer is not promoted before its wallet has synced onto the Bet', async () => {
  const f = await fixture();
  await pending(f);
  await s.db.query(`insert into play_accounts(x_user_id,account_id,public_key,ready) values($1,'owner.testnet','synthetic-unused-public-key',true)`, [creator.x_user_id]);
  s.config.play.enabled = true;
  try {
    assert.equal((await s.db.one('select creator_wallet from bilateral_bets where id=$1', [f.bet.id])).creator_wallet, null);
    const page = await f.browser.get(f.path);
    assert.doesNotMatch(front(page), />Check transaction<\/button>/);
    assert.match(front(page), />Deposit stake</);
  } finally {
    s.config.play.enabled = false;
    await s.db.query('delete from play_accounts where x_user_id=$1', [creator.x_user_id]);
  }
});

test('a claimed Stated wallet uses native pending recovery', async () => {
  const f = await fixture();
  await pending(f);
  await s.db.query(`insert into play_accounts(x_user_id,account_id,public_key,ready,claimed_at)
    values($1,'owner.testnet','synthetic-unused-public-key',true,clock_timestamp())`, [creator.x_user_id]);
  s.config.play.enabled = true;
  try {
    assert.match(front(await f.browser.get(f.path)), /class="primary big"[^>]*>Check transaction</);
  } finally {
    s.config.play.enabled = false;
    await s.db.query('delete from play_accounts where x_user_id=$1', [creator.x_user_id]);
  }
});

test('native finalize_unanswered request uses the existing canonical display label', async () => {
  const f = await fixture();
  const id = randomUUID();
  await s.db.query(`insert into bilateral_near_requests(id,bet_id,user_id,wallet_account,method,args,metadata)
    values($1,$2,$3,'owner.testnet','finalize_unanswered',$4,$5)`, [id, f.bet.id, creator.id,
    { id: f.bet.id }, { contract: 'escrow.testnet', depositYocto: '0' }]);
  const page = await creatorBrowser.get(f.path);
  assert.match(page.text, /<span>Let the result stand<\/span>/);
  assert.match(page.text, new RegExp(`name="requestId" value="${id}"`));
  assert.doesNotMatch(page.text.replace(/<[^>]*>/g, ''), new RegExp(id));
});
