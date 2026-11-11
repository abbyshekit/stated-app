// INTEGRATION: Real Postgres and HTTP, simulated NEAR RPC; no live wallet claim.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { baseEncode } from 'near-api-js';
import { createBet } from '../src/bets.mjs';
import { prepareNearAction, syncNearBet } from '../src/near-bets.mjs';
import { syncNearBets } from '../src/near-worker.mjs';
import { syncPendingBetTransactions, verifyBetTransaction } from '../src/near-execution-state.mjs';
import { completeSetup, signInFromX } from '../src/store.mjs';
import { TESTNET_RPC } from '../src/near-escrow.mjs';
import { startStack } from './support/app.mjs';

let s, creator, browser, other;
let credit = '100000000000000000000000', outage = false, execution;
const txChecks = [];
let blockRequests = 0;
const chains = new Map();
const hash = '11111111111111111111111111111111';
const ns = value => (BigInt(new Date(value).getTime()) * 1000000n).toString();
const response = result => new Response(JSON.stringify({ result }), { headers: { 'content-type': 'application/json' } });
const fetchImpl = async (url, options) => {
  if (url !== TESTNET_RPC) return fetch(url, options);
  const { method, params } = JSON.parse(options.body);
  if (method === 'block') { blockRequests += 1; return response({ header: { height: 100, hash } }); }
  if (method === 'tx') { txChecks.push(params.tx_hash); return response(execution); }
  if (params.method_name === 'get_credit') {
    if (outage) throw new Error('Synthetic credit outage');
    return response({ block_height: 100, result: [...Buffer.from(JSON.stringify(credit))] });
  }
  if (params.method_name === 'get_bet') {
    const { id } = JSON.parse(Buffer.from(params.args_base64, 'base64'));
    return response({ block_height: 100, result: [...Buffer.from(JSON.stringify(chains.get(id) || null))] });
  }
  throw new Error('Unexpected synthetic RPC');
};

before(async () => {
  s = await startStack({ STATED_NEAR_CONTRACT: 'escrow.testnet' }, { fetchImpl });
  creator = await completeSetup(s.db, await signInFromX(s.db, { id: '96001', username: 'withdraw_creator' }), {});
  browser = await s.signIn(s.fakeX.addUser('96001', 'withdraw_creator'));
  other = await s.signIn(s.fakeX.addUser('96002', 'withdraw_other'));
});
after(async () => { if (s) await s.close(); });

async function cancelledBet(owner = creator, accountId = 'creator.testnet') {
  const bet = await createBet(s.db, owner, { requestId: randomUUID(), claim: 'SYNTHETIC: will it happen?',
    criteria: 'Official evidence', evidenceSourceUrl: 'https://example.org/result', creatorSide: 'yes', stakeNear: '0.1',
    acceptBy: new Date(Date.now() + 86400000).toISOString(), resolveAt: new Date(Date.now() + 172800000).toISOString() });
  const prepared = await prepareNearAction(s.db, s.config, owner, bet.id,
    { action: 'fund', accountId }, { fetchImpl });
  chains.set(bet.id, { id: bet.id, terms_hash: bet.terms_hash, stake_yocto: bet.stake_yocto,
    creator_side: 'yes', accept_by_ns: ns(bet.accept_by), resolve_at_ns: ns(bet.resolve_at), invited_account: null,
    creator: accountId, creator_binding_hash: prepared.args.binding_hash, acceptor: null, proposal: null, status: 'cancelled' });
  await syncNearBet(s.db, s.config, owner, bet.id, { fetchImpl });
  return bet;
}

async function withdrawal(bet, actorBrowser = browser, accountId = 'creator.testnet') {
  const page = await actorBrowser.submit(`/bets/${bet.id}/withdraw`, { accountId }, { from: `/bets/${bet.id}` });
  assert.equal(page.status, 200);
  assert.match(page.text, /data-stated-wallet/);
  assert.match(page.text, /\/static\/wallet\.js\?v=/);
  assert.doesNotMatch(page.text, /mynearwallet/);
  assert.doesNotMatch(page.headers.get('content-security-policy'), /unsafe-inline|unsafe-eval/);
  const id = page.text.match(/name="requestId" value="([a-f0-9-]+)"/)?.[1];
  assert.ok(id);
  const request = await s.db.one('select * from bilateral_near_requests where id=$1', [id]);
  assert.equal(request.args.stated_request_id, id);
  return request;
}

function finalized(request, result = true, transactionHash = hash) {
  return { final_execution_status: 'FINAL', transaction: { hash: transactionHash,
    signer_id: request.wallet_account, receiver_id: request.metadata.contract,
    actions: [{ FunctionCall: { method_name: request.method, args: Buffer.from(JSON.stringify(request.args)).toString('base64'),
      deposit: request.metadata.depositYocto, gas: 100000000000000 } }] },
  status: { SuccessValue: Buffer.from(JSON.stringify(result)).toString('base64') } };
}

test('terminal pages show real credit and a finalized withdrawal hides the spent action', async () => {
  const bet = await cancelledBet();
  credit = '0';
  let page = await browser.get(`/bets/${bet.id}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /Available wallet credit: 0 test NEAR/);
  assert.doesNotMatch(page.text, />Withdraw tokens</);
  assert.doesNotMatch(page.text, /withdrawal transfer completed/);
  credit = '250000000000000000000000';
  page = await browser.get(`/bets/${bet.id}`);
  assert.match(page.text, />Withdraw tokens</);
  assert.match(page.text.split('<div class="folds">')[0], /Available wallet credit: 0\.25 test NEAR in this contract\./,
    'show the verified wallet-wide credit before the action, independently of this Bet’s 0.1 stake');
  const request = await withdrawal(bet);
  execution = finalized(request);
  credit = '0';
  page = await browser.submit(`/bets/${bet.id}/transactions`, { requestId: request.id, transactionHash: hash });
  assert.equal(page.status, 200);
  assert.match(page.text, /withdrawal transfer completed/);
  assert.doesNotMatch(page.text.split('<div class="folds">')[0], /Available wallet credit:/);
  assert.doesNotMatch(page.text, />Withdraw tokens</);
  assert.match(page.text, /testnet.nearblocks.io\/txns\//);
  assert.equal((await s.db.one('select execution_status from bilateral_near_requests where id=$1', [request.id])).execution_status, 'succeeded');
  credit = '100000000000000000000000';
  const next = await withdrawal(bet);
  assert.notEqual(next.id, request.id, 'equal new credit needs a new unique intent');
  assert.notEqual(next.args.stated_request_id, request.args.stated_request_id);
});

test('pending terminal withdrawals reconcile in the NEAR-only worker; false restores credit', async () => {
  const bet = await cancelledBet();
  credit = '100000000000000000000000';
  const request = await withdrawal(bet);
  const pendingHash = '11111111111111111111111111111112';
  execution = { final_execution_status: 'INCLUDED' };
  let page = await browser.submit(`/bets/${bet.id}/transactions`, { requestId: request.id, transactionHash: pendingHash });
  assert.equal(page.status, 200);
  assert.match(page.text, /earlier withdrawal is unverified/);
  execution = finalized(request, false, pendingHash);
  const result = await syncNearBets(s.db, s.config, { fetchImpl });
  assert.equal(result.errors, 0);
  assert.equal((await s.db.one('select execution_status from bilateral_near_requests where id=$1', [request.id])).execution_status, 'failed');
  page = await browser.get(`/bets/${bet.id}`);
  assert.match(page.text, /contract restored its credit/);
  assert.match(page.text, />Withdraw tokens</);
});

test('request ownership, CSRF and exact transaction match protect completion; outages stay actionable', async () => {
  const bet = await cancelledBet();
  credit = '100000000000000000000000';
  const request = await withdrawal(bet);
  execution = finalized(request, true, '11111111111111111111111111111113');
  let page = await other.submit(`/bets/${bet.id}/transactions`, { requestId: request.id, transactionHash: execution.transaction.hash });
  assert.equal(page.status, 404);
  page = await browser.request('POST', `/bets/${bet.id}/transactions`, { form: { requestId: request.id, transactionHash: execution.transaction.hash } });
  assert.equal(page.status, 403);
  execution.transaction.signer_id = 'other.testnet';
  page = await browser.submit(`/bets/${bet.id}/transactions`, { requestId: request.id, transactionHash: execution.transaction.hash });
  assert.equal(page.status, 409);
  assert.equal((await s.db.one('select transaction_hash from bilateral_near_requests where id=$1', [request.id])).transaction_hash, null);
  outage = true;
  page = await browser.get(`/bets/${bet.id}`);
  assert.match(page.text, /credit could not be checked/);
  assert.doesNotMatch(page.text, />Withdraw tokens</);
  outage = false;
});

test('unresolved references cannot starve later transactions in the bounded queue', async () => {
  const bet = await cancelledBet();
  execution = { final_execution_status: 'INCLUDED' };
  for (let i = 0; i < 6; i += 1) {
    const id = randomUUID();
    await s.db.query(`insert into bilateral_near_requests(id,bet_id,user_id,wallet_account,method,args,metadata,transaction_hash)
      values($1,$2,$3,'creator.testnet','withdraw',$4,$5,$6)`, [id, bet.id, creator.id,
      { stated_request_id: id }, { contract: 'escrow.testnet', depositYocto: '0' }, baseEncode(new Uint8Array(32).fill(i + 20))]);
  }
  txChecks.length = 0;
  await syncPendingBetTransactions(s.db, s.config, bet.id, { fetchImpl });
  await syncPendingBetTransactions(s.db, s.config, bet.id, { fetchImpl });
  assert.equal(new Set(txChecks).size, 6, 'every pending reference must get a check across bounded passes');
});

test('an unresolved public hash cannot reserve another person’s valid transaction', async () => {
  const firstBet = await cancelledBet();
  const first = await withdrawal(firstBet);
  const person = await completeSetup(s.db, await signInFromX(s.db, { id: '96002', username: 'withdraw_other' }), {});
  const secondBet = await cancelledBet(person, 'other.testnet');
  const second = await withdrawal(secondBet, other, 'other.testnet');
  const publicHash = baseEncode(new Uint8Array(32).fill(70));
  execution = { final_execution_status: 'INCLUDED' };
  await verifyBetTransaction(s.db, s.config, creator, firstBet.id, { requestId: first.id, transactionHash: publicHash }, { fetchImpl });
  execution = finalized(second, true, publicHash);
  const result = await verifyBetTransaction(s.db, s.config, person, secondBet.id, { requestId: second.id, transactionHash: publicHash }, { fetchImpl });
  assert.equal(result.status, 'succeeded');
});

test('a stale background lookup cannot overwrite a corrected pending hash', async () => {
  const bet = await cancelledBet();
  const request = await withdrawal(bet);
  const oldHash = baseEncode(new Uint8Array(32).fill(71));
  const correctedHash = baseEncode(new Uint8Array(32).fill(72));
  execution = { final_execution_status: 'INCLUDED' };
  await verifyBetTransaction(s.db, s.config, creator, bet.id, { requestId: request.id, transactionHash: oldHash }, { fetchImpl });
  let began, release;
  const started = new Promise(resolve => { began = resolve; });
  const delayed = new Promise(resolve => { release = resolve; });
  const worker = syncPendingBetTransactions(s.db, s.config, bet.id, { fetchImpl: async () => {
    began(); await delayed; return response({ final_execution_status: 'INCLUDED' });
  } });
  await started;
  await verifyBetTransaction(s.db, s.config, creator, bet.id, { requestId: request.id, transactionHash: correctedHash }, { fetchImpl });
  release(); await worker;
  const stored = await s.db.one('select transaction_hash from bilateral_near_requests where id=$1', [request.id]);
  assert.equal(stored.transaction_hash, correctedHash);
});

test('a failed funding execution can be retried without replacing its participant binding', async () => {
  const bet = await createBet(s.db, creator, { requestId: randomUUID(), claim: 'SYNTHETIC: retry funding', criteria: 'Official evidence',
    evidenceSourceUrl: 'https://example.org/result', creatorSide: 'yes', stakeNear: '0.1',
    acceptBy: new Date(Date.now() + 86400000).toISOString(), resolveAt: new Date(Date.now() + 172800000).toISOString() });
  const first = await prepareNearAction(s.db, s.config, creator, bet.id, { action: 'fund', accountId: 'creator.testnet' }, { fetchImpl });
  const request = await s.db.one('select * from bilateral_near_requests where id=$1', [first.requestId]);
  const failedHash = baseEncode(new Uint8Array(32).fill(73));
  execution = finalized(request, true, failedHash);
  execution.status = { Failure: { ActionError: {} } };
  await verifyBetTransaction(s.db, s.config, creator, bet.id, { requestId: request.id, transactionHash: failedHash }, { fetchImpl });
  const retry = await prepareNearAction(s.db, s.config, creator, bet.id, { action: 'fund', accountId: 'creator.testnet' }, { fetchImpl });
  assert.equal(retry.requestId, request.id);
  assert.equal(retry.args.binding_hash, request.args.binding_hash);
  const paidHash = baseEncode(new Uint8Array(32).fill(74));
  execution = finalized(request, true, paidHash);
  execution.status = { SuccessValue: '' };
  const result = await verifyBetTransaction(s.db, s.config, creator, bet.id, { requestId: request.id, transactionHash: paidHash }, { fetchImpl });
  assert.equal(result.status, 'succeeded');
});

test('overlapping explicit corrections preserve the first completed replacement', async () => {
  const bet = await cancelledBet();
  const request = await withdrawal(bet);
  const oldHash = baseEncode(new Uint8Array(32).fill(81));
  const staleHash = baseEncode(new Uint8Array(32).fill(82));
  const currentHash = baseEncode(new Uint8Array(32).fill(83));
  execution = { final_execution_status: 'INCLUDED' };
  await verifyBetTransaction(s.db, s.config, creator, bet.id, { requestId: request.id, transactionHash: oldHash }, { fetchImpl });
  let began, release;
  const started = new Promise(resolve => { began = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const slow = verifyBetTransaction(s.db, s.config, creator, bet.id,
    { requestId: request.id, transactionHash: staleHash }, { fetchImpl: async () => {
      began(); await gate; return response({ final_execution_status: 'INCLUDED' });
    } });
  await started;
  await verifyBetTransaction(s.db, s.config, creator, bet.id, { requestId: request.id, transactionHash: currentHash }, { fetchImpl });
  release();
  await slow;
  assert.equal((await s.db.one('select transaction_hash from bilateral_near_requests where id=$1', [request.id])).transaction_hash, currentHash);
});

test('a slow transaction check does not serialize the bounded reconciliation batch', async () => {
  const bet = await cancelledBet();
  for (let i = 0; i < 5; i += 1) {
    const id = randomUUID();
    await s.db.query(`insert into bilateral_near_requests(id,bet_id,user_id,wallet_account,method,args,metadata,transaction_hash)
      values($1,$2,$3,'creator.testnet','withdraw',$4,$5,$6)`, [id, bet.id, creator.id,
      { stated_request_id: id }, { contract: 'escrow.testnet', depositYocto: '0' }, baseEncode(new Uint8Array(32).fill(90 + i))]);
  }
  let began = 0, allStarted, release;
  const started = new Promise(resolve => { allStarted = resolve; });
  const gate = new Promise(resolve => { release = resolve; });
  const work = syncPendingBetTransactions(s.db, s.config, bet.id, { fetchImpl: async () => {
    began += 1;
    if (began === 5) allStarted();
    await gate;
    return response({ final_execution_status: 'INCLUDED' });
  } });
  let timer;
  await Promise.race([started, new Promise(resolve => { timer = setTimeout(resolve, 500); })]);
  clearTimeout(timer);
  const concurrent = began;
  release();
  await work;
  assert.equal(concurrent, 5, 'all five checks must start before the slow lookup completes');
});

test('the wallet block lookup stays authenticated, read-only, bounded and cached', async () => {
  const input = { jsonrpc: '2.0', id: 'wallet-block', method: 'block', params: { finality: 'optimistic' } };
  const send = (body = JSON.stringify(input), headers = {}, authenticated = true) => fetch(`${s.base}/near/block`, {
    method: 'POST', redirect: 'manual', headers: { 'content-type': 'application/json', origin: s.base,
      ...(authenticated ? { cookie: browser.cookieHeader() } : {}), ...headers }, body,
  });
  assert.equal((await send(undefined, {}, false)).status, 303);
  assert.equal((await send(JSON.stringify({ ...input, method: 'send_tx', params: { signed_tx_base64: 'not-a-transaction' } }))).status, 400);
  assert.equal((await send(undefined, { origin: 'https://other.example' })).status, 403);
  assert.equal((await send('"' + 'x'.repeat(2048) + '"')).status, 413);
  assert.equal((await send('{')).status, 400);
  assert.equal(blockRequests, 0, 'invalid requests never reach NEAR');
  const pages = await Promise.all([send(), send()]);
  for (const page of pages) {
    assert.equal(page.status, 200);
    assert.equal(page.headers.get('cache-control'), 'no-store');
    assert.deepEqual(await page.json(), { jsonrpc: '2.0', id: 'wallet-block', result: { header: { height: 100, hash } } });
  }
  assert.equal(blockRequests, 1);
});
