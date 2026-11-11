// INTEGRATION: Real Postgres and HTTP with fake X and synthetic NEAR RPC only.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { createBet } from '../src/bets.mjs';
import { publishBet } from '../src/bet-public.mjs';
import { prepareNearAction, syncNearBet } from '../src/near-bets.mjs';
import { TESTNET_RPC } from '../src/near-escrow.mjs';
import { completeSetup, signInFromX } from '../src/store.mjs';
import { startStack } from './support/app.mjs';

let s, creator, joiner, creatorBrowser, joinerBrowser, execution;
const chains = new Map();
const ns = value => (BigInt(new Date(value).getTime()) * 1000000n).toString();
const fetchImpl = async (url, options) => {
  if (url !== TESTNET_RPC) {
    if (s && String(url).startsWith(s.fakeX.base)) return fetch(url, options);
    throw new Error(`Unexpected external request: ${url}`);
  }
  const { method, params } = JSON.parse(options.body);
  if (method === 'tx') return new Response(JSON.stringify({ result: execution }));
  if (method === 'query' && params.method_name === 'get_bet') {
    const { id } = JSON.parse(Buffer.from(params.args_base64, 'base64'));
    return new Response(JSON.stringify({ result: { block_height: 100, result: [...Buffer.from(JSON.stringify(chains.get(id) || null))] } }));
  }
  throw new Error('Unexpected synthetic NEAR RPC');
};

before(async () => {
  // Fake X is started inside startStack; authentication below uses its local server.
  s = await startStack({ STATED_NEAR_CONTRACT: 'escrow.testnet' }, { fetchImpl });
  creator = await completeSetup(s.db, await signInFromX(s.db, { id: '98001', username: 'recovery_creator' }), {});
  joiner = await completeSetup(s.db, await signInFromX(s.db, { id: '98002', username: 'recovery_joiner' }), {});
  creatorBrowser = await s.signIn(s.fakeX.addUser('98001', 'recovery_creator'));
  joinerBrowser = await s.signIn(s.fakeX.addUser('98002', 'recovery_joiner'));
});
after(async () => { if (s) await s.close(); });

const validTerms = () => ({ claim: 'SYNTHETIC retained proposition', criteria: 'Official result retained',
  evidenceSourceUrl: 'https://example.org/result', creatorSide: 'yes', stakeNear: '0.1',
  acceptBy: new Date(Date.now() + 86400000).toISOString(), resolveAt: new Date(Date.now() + 172800000).toISOString() });

for (const missing of [['acceptBy', 'resolveAt'], ['acceptBy'], ['resolveAt']]) {
  test(`missing ${missing.join(' and ')} returns a usable form and creates no Bet`, async () => {
    const requestId = randomUUID();
    const fields = { ...validTerms(), requestId };
    for (const key of missing) delete fields[key];
    const page = await creatorBrowser.submit('/me/bets', fields, { from: '/me/bets/new' });
    assert.equal(page.status, 400);
    assert.match(page.text, /SYNTHETIC retained proposition/);
    assert.match(page.text, /Official result retained/);
    assert.match(page.text, /https:\/\/example\.org\/result/);
    for (const key of missing) {
      assert.match(page.text, new RegExp(`name="${key}DateInput" value="1"`));
      const day = page.text.match(new RegExp(`<select[^>]*name="${key}Day"[^>]*>([\\s\\S]*?)<\\/select>`))?.[1];
      assert.ok(day, 'the missing date remains editable');
      assert.match(day, /<option value="" selected>Day<\/option>/);
    }
    assert.equal((await s.db.one('select count(*)::int as n from bilateral_bets where request_id=$1', [requestId])).n, 0);
  });
}

async function fundedFixture() {
  const bet = await createBet(s.db, creator, { requestId: randomUUID(), ...validTerms() });
  const funding = await prepareNearAction(s.db, s.config, creator, bet.id, { action: 'fund', accountId: 'creator.testnet' }, { fetchImpl });
  return { bet, funding };
}

function recoveryForm(page, betId, requestId) {
  const forms = [...page.text.matchAll(/<form\b[^>]*>[\s\S]*?<\/form>/g)].map(match => match[0]);
  const form = forms.find(text => text.includes(`action="/bets/${betId}/transactions"`) && text.includes(`value="${requestId}"`));
  assert.ok(form, 'actor-owned request has a transaction recovery form');
  assert.match(form, /method="post"/i);
  assert.match(form, /name="csrf" value="[^"]+"/);
  assert.match(form, /name="transactionHash"/);
}

test('unreturned funding request is recoverable only by its owner', async () => {
  const { bet, funding } = await fundedFixture();
  const page = await creatorBrowser.get(`/bets/${bet.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /name="accountId" value="creator.testnet"/);
  assert.doesNotMatch((await joinerBrowser.get(`/bets/${bet.id}`)).text, new RegExp(funding.requestId));
  assert.doesNotMatch((await s.browser().get(`/bets/${bet.id}`)).text, new RegExp(funding.requestId));
  recoveryForm(page, bet.id, funding.requestId);
});

test('acceptor can recover its own pending request without exposing creator request on public page', async () => {
  const { bet, funding } = await fundedFixture();
  const chain = { id: bet.id, terms_hash: bet.terms_hash, stake_yocto: bet.stake_yocto,
    creator_side: bet.creator_side, accept_by_ns: ns(bet.accept_by), resolve_at_ns: ns(bet.resolve_at),
    invited_account: null, creator: 'creator.testnet', creator_binding_hash: funding.args.binding_hash,
    acceptor: null, proposal: null, status: 'offered' };
  chains.set(bet.id, chain);
  await syncNearBet(s.db, s.config, creator, bet.id, { fetchImpl });
  await publishBet(s.db, creator, bet.id);
  const acceptance = await prepareNearAction(s.db, s.config, joiner, bet.id,
    { action: 'accept', accountId: 'joiner.testnet', termsHash: bet.terms_hash }, { fetchImpl });
  const page = await joinerBrowser.get(`/bets/${bet.id}?join=1`);
  assert.match(page.text, /name="accountId" value="joiner.testnet"/);
  assert.doesNotMatch(page.text, new RegExp(funding.requestId));
  const publicPage = await s.browser().get(`/bets/${bet.id}`);
  assert.equal(publicPage.status, 200);
  assert.doesNotMatch(publicPage.text, new RegExp(`${funding.requestId}|${acceptance.requestId}`));
  recoveryForm(page, bet.id, acceptance.requestId);
});

for (const status of ['pending', 'failed']) test(`${status} request message renders escaped and without a success claim`, async () => {
  const { bet, funding } = await fundedFixture();
  const message = '<script>alert("wallet")</script>';
  await s.db.query('update bilateral_near_requests set execution_status=$2, execution_message=$3 where id=$1', [funding.requestId, status, message]);
  const page = await creatorBrowser.get(`/bets/${bet.id}`);
  assert.match(page.text, new RegExp(status, 'i'));
  assert.match(page.text, /&lt;script&gt;alert/);
  assert.doesNotMatch(page.text, /<script>alert/);
  assert.doesNotMatch(page.text, /transaction (?:completed|succeeded)/i);
});

test('the recovery form verifies the exact transaction and stops offering an already confirmed check', async () => {
  const { bet, funding } = await fundedFixture();
  let page = await creatorBrowser.get(`/bets/${bet.id}`);
  recoveryForm(page, bet.id, funding.requestId);
  const request = await s.db.one('select * from bilateral_near_requests where id=$1', [funding.requestId]);
  const transactionHash = '11111111111111111111111111111111';
  execution = { final_execution_status: 'FINAL', transaction: { hash: transactionHash,
    signer_id: request.wallet_account, receiver_id: request.metadata.contract,
    actions: [{ FunctionCall: { method_name: request.method, args: Buffer.from(JSON.stringify(request.args)).toString('base64'),
      deposit: request.metadata.depositYocto, gas: 100000000000000 } }] }, status: { SuccessValue: '' } };
  chains.set(bet.id, { id: bet.id, terms_hash: bet.terms_hash, stake_yocto: bet.stake_yocto,
    creator_side: bet.creator_side, accept_by_ns: ns(bet.accept_by), resolve_at_ns: ns(bet.resolve_at),
    invited_account: null, creator: 'creator.testnet', creator_binding_hash: funding.args.binding_hash,
    acceptor: null, proposal: null, status: 'offered' });
  page = await creatorBrowser.submit(`/bets/${bet.id}/transactions`, { requestId: request.id, transactionHash });
  assert.equal(page.status, 200);
  assert.match(page.text, /Transaction confirmed/);
  assert.match(page.text, new RegExp(`https://testnet.nearblocks.io/txns/${transactionHash}`));
  assert.doesNotMatch(page.text, new RegExp(`name="requestId" value="${request.id}"`));
  const stored = await s.db.one('select execution_status,transaction_hash from bilateral_near_requests where id=$1', [request.id]);
  assert.equal(stored.execution_status, 'succeeded');
  assert.equal(stored.transaction_hash, transactionHash);
});

test('a request from another configured contract never becomes a recovery control', async () => {
  const { bet, funding } = await fundedFixture();
  await s.db.query(`update bilateral_near_requests set metadata=jsonb_set(metadata,'{contract}','"another.testnet"') where id=$1`, [funding.requestId]);
  const page = await creatorBrowser.get(`/bets/${bet.id}`);
  assert.equal(page.status, 200);
  assert.doesNotMatch(page.text, new RegExp(funding.requestId));
});
