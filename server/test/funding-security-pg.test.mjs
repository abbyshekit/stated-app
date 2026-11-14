import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { KeyPair, SignedTransaction, baseEncode } from 'near-api-js';
import { createDb } from '../src/db.mjs';
import { seal } from '../src/crypto.mjs';
import { refreshDeposit, refreshOpenDeposits, startDeposit } from '../src/funding.mjs';
import { assertSignerAvailable, claimPlayAccount, ensureFunds, nearChain, playAccountFor, reservePlaySigner, secretOf, withAvailablePlaySigner, yocto } from '../src/play.mjs';
import { UserError } from '../src/store.mjs';
import { useNetwork } from '../src/near-network.mjs';
import { startPostgres } from './support/pg.mjs';
import { FakeNear } from './support/fake-near.mjs';

let pg, db;
const config = { near: { real: true }, tokenKey: 'synthetic-funding-security-key',
  play: { enabled: true, pilotXIds: ['*'] }, intents: { deposits: true } };
before(async () => {
  useNetwork('mainnet');
  pg = await startPostgres();
  db = createDb(pg.url);
  await db.migrate();
});
after(async () => { await db?.close(); pg?.stop(); });

async function fixture({ kind = 'wrapped', claimed = false } = {}) {
  const xUserId = randomUUID();
  const accountId = `funding-${xUserId.slice(0, 8)}.stated.near`;
  const near = new FakeNear({ contract: 'escrow.stated.near' });
  near.accounts.set(accountId, { balance: BigInt(yocto('0.2')), keys: new Set() });
  near.wrapped.set(accountId, BigInt(yocto('0.6')));
  await db.query(`insert into play_accounts(x_user_id, account_id, public_key, secret_sealed, ready, claimed_at)
    values($1,$2,'ed25519:synthetic',$3,true,$4)`,
  [xUserId, accountId, claimed ? null : seal('synthetic-secret', config.tokenKey), claimed ? new Date() : null]);
  const destinationTx = '8'.repeat(44);
  const amount = yocto('0.1');
  const deliveries = new Map([[destinationTx, { final: true, kind, deliveredYocto: amount }]]);
  near.chain.depositDelivery = async ({ transactionHash }) => deliveries.get(transactionHash) || null;
  const status = { ok: true, state: 'SUCCESS', deliveredYocto: amount, destinationTx };
  const intents = { status: async () => status };
  const deposit = async () => {
    const row = await db.one(`insert into play_deposits(id,x_user_id,account_id,origin_asset,origin_symbol,origin_chain,
      near_yocto,amount_in,deposit_address,refund_to,deadline,signed)
      values($1,$2,$3,'synthetic-asset','TEST','Synthetic',$4,'1',$5,'synthetic-refund',now()+interval '1 hour','{}') returning *`,
    [randomUUID(), xUserId, accountId, amount, randomUUID()]);
    return row;
  };
  return { near, accountId, xUserId, status, intents, deliveries, deposit };
}

test('one destination proof can complete only one deposit, including concurrent refreshes', async () => {
  const f = await fixture({ kind: 'native' });
  const rows = await Promise.all([f.deposit(), f.deposit()]);
  const refreshed = await Promise.all(rows.map(row => refreshDeposit(db, config, f.near.chain, f.intents, row)));
  assert.equal(refreshed.filter(row => row.finished_at).length, 1);
  assert.equal((await db.one('select count(*)::int as n from play_deposit_deliveries where account_id=$1', [f.accountId])).n, 1);
  assert.equal(f.near.sent.length, 0);
});

test('provider amount changes cannot unwrap an amount different from the stored exact output', async () => {
  const f = await fixture();
  f.status.deliveredYocto = yocto('0.5');
  f.deliveries.set(f.status.destinationTx, { final: true, kind: 'wrapped', deliveredYocto: yocto('0.5') });
  const row = await refreshDeposit(db, config, f.near.chain, f.intents, await f.deposit());
  assert.equal(row.finished_at, null);
  assert.equal(f.near.sent.length, 0);
});

test('an unwrap is durable before broadcast and lost responses recover without signing or spending again', async () => {
  const f = await fixture();
  const row = await f.deposit();
  const broadcast = f.near.chain.broadcastCall;
  let loseResponse = true;
  const signedBytes = [];
  f.near.chain.broadcastCall = async (input) => {
    const persisted = await db.one('select unwrap_pending_tx, unwrap_signed_transaction from play_deposits where id=$1', [row.id]);
    assert.equal(persisted.unwrap_signed_transaction, input.signedTransaction);
    signedBytes.push(input.signedTransaction);
    const result = await broadcast(input);
    if (loseResponse) { loseResponse = false; throw new Error('Synthetic lost RPC response'); }
    return result;
  };
  const first = await refreshDeposit(db, config, f.near.chain, f.intents, row);
  assert.equal(first.finished_at, null);
  assert.ok(first.unwrap_pending_tx);
  const next = await refreshDeposit(db, config, f.near.chain, f.intents, row, { now: Date.now() + 5000 });
  assert.ok(next.finished_at);
  assert.equal(next.unwrap_tx, first.unwrap_pending_tx);
  assert.equal(f.near.prepared.size, 1);
  assert.equal(f.near.sent.filter(call => call.method === 'near_withdraw').length, 1);
  assert.equal(signedBytes.length, 1);
  assert.equal(f.near.wrapped.get(f.accountId), BigInt(yocto('0.5')));
});

test('a broadcast that never arrived retries the identical committed bytes', async () => {
  const f = await fixture();
  const broadcast = f.near.chain.broadcastCall;
  let calls = 0;
  const bytes = [];
  f.near.chain.broadcastCall = async (input) => {
    bytes.push(input.signedTransaction);
    if (++calls === 1) throw new Error('Synthetic request lost before transmission');
    return broadcast(input);
  };
  const row = await f.deposit();
  assert.equal((await refreshDeposit(db, config, f.near.chain, f.intents, row)).finished_at, null);
  assert.ok((await refreshDeposit(db, config, f.near.chain, f.intents, row, { now: Date.now() + 5000 })).finished_at);
  assert.deepEqual(bytes, [bytes[0], bytes[0]]);
  assert.equal(f.near.prepared.size, 1);
});

test('claimed accounts never sign unwraps and pending signed unwraps block key handover', async () => {
  const f = await fixture({ claimed: true });
  const row = await refreshDeposit(db, config, f.near.chain, f.intents, await f.deposit());
  assert.equal(row.finished_at, null);
  assert.equal(f.near.prepared.size, 0);
  assert.equal(f.near.sent.length, 0);
  const pending = await fixture();
  pending.near.chain.broadcastCall = async () => { throw new Error('Synthetic outage'); };
  await refreshDeposit(db, config, pending.near.chain, pending.intents, await pending.deposit());
  await assert.rejects(claimPlayAccount(db, config, pending.near.chain, pending.xUserId,
    'ed25519:8hSHprDq2StXwMtNd43wDTXQYsjXcD4MJTXQYsjXcc5'), /still being unwrapped/);
});

test('prepared unwrap retries honor their cooldown and failed attempts advance the worker schedule', async () => {
  const f = await fixture();
  let checks = 0;
  f.near.chain.unwrapDelivery = async () => { checks += 1; return false; };
  f.near.chain.broadcastCall = async () => { throw new Error('Synthetic outage'); };
  const row = await f.deposit();
  await refreshDeposit(db, config, f.near.chain, f.intents, row);
  const timestamp = (await db.one('select checked_at from play_deposits where id=$1', [row.id])).checked_at;
  await refreshDeposit(db, config, f.near.chain, f.intents, row);
  assert.equal(checks, 1);
  await refreshDeposit(db, config, f.near.chain, f.intents, row, { now: Date.now() + 5000 });
  assert.equal(checks, 2);
  assert.ok((await db.one('select checked_at from play_deposits where id=$1', [row.id])).checked_at >= timestamp);
});

async function realSigningFixture(amounts) {
  const xUserId = randomUUID();
  const accountId = `real-${xUserId.slice(0, 8)}.stated.near`;
  const key = KeyPair.fromRandom('ed25519');
  await db.query(`insert into play_accounts(x_user_id,account_id,public_key,secret_sealed,ready)
    values($1,$2,$3,$4,true)`, [xUserId, accountId, key.getPublicKey().toString(), seal(key.toString(), config.tokenKey)]);
  const hash = text => baseEncode(createHash('sha256').update(text).digest());
  const state = { nonce: 10, height: 100, blockHash: hash('block100'), held: amounts.reduce((sum, amount) => sum + BigInt(amount), 0n),
    loseFirst: true, broadcasts: [], completed: new Map(), proofs: new Map(), signed: [], reject: null };
  const block = (height) => ({ header: { height, hash: hash('block' + height) } });
  const outcome = (id, executor, children, status, logs = []) => ({ id, outcome: {
    executor_id: executor, receipt_ids: children, status, logs } });
  const receipt = (id, sender, receiver, signer, actions) => ({ receipt_id: id, predecessor_id: sender, receiver_id: receiver,
    receipt: { Action: { signer_id: signer, actions } } });
  const graph = (transactionHash, signerId, receiverId, actions, amount, wrapped) => {
    const root = hash('root' + transactionHash), transfer = hash('transfer' + transactionHash);
    const rootLogs = wrapped ? [`Transfer ${amount} from ${signerId} to ${accountId}`] : [];
    const result = { final_execution_status: 'FINAL', status: { SuccessValue: '' },
      transaction: { hash: transactionHash, signer_id: signerId, receiver_id: receiverId, actions },
      transaction_outcome: outcome(transactionHash, signerId, [root], { SuccessReceiptId: root }),
      receipts: [receipt(root, signerId, receiverId, signerId, actions)],
      receipts_outcome: [outcome(root, receiverId, wrapped ? [] : [transfer],
        wrapped ? { SuccessValue: '' } : { SuccessReceiptId: transfer }, rootLogs)] };
    if (!wrapped) {
      result.receipts.push(receipt(transfer, 'wrap.near', accountId, signerId,
        [{ Transfer: { deposit: (BigInt(amount) + 1n).toString() } }]));
      result.receipts_outcome.push(outcome(transfer, accountId, [], { SuccessValue: '' }));
    }
    return result;
  };
  const chain = nearChain({ fetchImpl: async (_url, options) => {
    const { method, params, id } = JSON.parse(options.body);
    const reply = result => Response.json({ jsonrpc: '2.0', id, result });
    const failure = (name, invalid = null) => Response.json({ jsonrpc: '2.0', id,
      error: { code: -32000, name: 'HANDLER_ERROR', message: 'Server error', cause: { name },
        ...(invalid ? { data: { TxExecutionError: { InvalidTxError: invalid } } } : {}) } });
    if (method === 'gas_price') return reply({ gas_price: '1000000000' });
    if (method === 'EXPERIMENTAL_protocol_config') return reply({ transaction_validity_period: 100, protocol_version: 85,
      runtime_config: { min_gas_purchase_price: '1000000000', storage_amount_per_byte: '10000000000000000000' } });
    if (method === 'block') return reply(params.block_id ? (params.block_id === hash('block100') ? block(100) : block(state.height)) : block(state.height));
    if (method === 'query') {
      if (params.request_type === 'view_access_key') return reply({ nonce: state.nonce, permission: 'FullAccess' });
      if (params.request_type === 'view_account') return reply({ amount: yocto('0.5'), storage_usage: 182 });
      assert.equal(params.method_name, 'ft_balance_of');
      return reply({ block_height: state.height, result: [...Buffer.from(JSON.stringify(state.held.toString()))] });
    }
    if (method === 'tx_status' || method === 'tx') {
      const result = state.completed.get(params.tx_hash) || state.proofs.get(params.tx_hash);
      return result ? reply(result) : failure('UNKNOWN_TRANSACTION');
    }
    assert.equal(method, 'send_tx');
    state.broadcasts.push(params.signed_tx_base64);
    if (state.loseFirst) { state.loseFirst = false; throw new Error('Synthetic loss before transmission'); }
    const signed = SignedTransaction.decode(Buffer.from(params.signed_tx_base64, 'base64'));
    if (state.reject === 'Expired') return failure('INVALID_TRANSACTION', 'Expired');
    if (signed.transaction.nonce <= BigInt(state.nonce)) return failure('INVALID_TRANSACTION',
      { InvalidNonce: { ak_nonce: state.nonce, tx_nonce: Number(signed.transaction.nonce) } });
    const call = signed.transaction.actions[0].functionCall;
    if (call.methodName !== 'near_withdraw') {
      const transactionHash = baseEncode(createHash('sha256').update(signed.transaction.encode()).digest());
      state.pendingManaged = { signed, transactionHash };
      return reply({ final_execution_status: 'NONE', status: 'NotStarted', transaction: {
        hash: transactionHash, signer_id: accountId, receiver_id: signed.transaction.receiverId } });
    }
    const amount = JSON.parse(Buffer.from(call.args).toString()).amount;
    state.nonce = Number(signed.transaction.nonce);
    state.held -= BigInt(amount);
    const transactionHash = baseEncode(createHash('sha256').update(signed.transaction.encode()).digest());
    const result = graph(transactionHash, accountId, 'wrap.near', [{ FunctionCall: {
      method_name: call.methodName, args: Buffer.from(call.args).toString('base64'),
      deposit: call.deposit.toString(), gas: Number(call.gas) } }], amount, false);
    state.completed.set(transactionHash, result);
    return reply(result);
  } });
  const prepare = chain.prepareCall;
  chain.prepareCall = async input => {
    const prepared = await prepare(input);
    state.signed.push(prepared.hash);
    return prepared;
  };
  const rows = [];
  const statuses = new Map();
  for (const [index, amount] of amounts.entries()) {
    const destination = hash('destination' + xUserId + index);
    const address = randomUUID();
    state.proofs.set(destination, graph(destination, 'solver.near', 'wrap.near', [{ FunctionCall: {
      method_name: 'ft_transfer', deposit: '1', gas: 30000000000000,
      args: Buffer.from(JSON.stringify({ receiver_id: accountId, amount })).toString('base64') } }], amount, true));
    statuses.set(address, { ok: true, state: 'SUCCESS', destinationTx: destination, deliveredYocto: amount });
    rows.push(await db.one(`insert into play_deposits(id,x_user_id,account_id,origin_asset,origin_symbol,origin_chain,
      near_yocto,amount_in,deposit_address,refund_to,deadline,signed)
      values($1,$2,$3,'test','TEST','Synthetic',$4,'1',$5,'refund',now()+interval '1 hour','{}') returning *`,
    [randomUUID(), xUserId, accountId, amount, address]));
  }
  const failRoot = () => {
    const signed = SignedTransaction.decode(Buffer.from(state.broadcasts[0], 'base64'));
    const call = signed.transaction.actions[0].functionCall;
    const result = graph(state.signed[0], accountId, 'wrap.near', [{ FunctionCall: {
      method_name: call.methodName, args: Buffer.from(call.args).toString('base64'),
      deposit: call.deposit.toString(), gas: Number(call.gas) } }], amounts[0], false);
    result.status = { Failure: { ActionError: { index: 0, kind: { FunctionCallError: 'Synthetic root panic' } } } };
    result.receipts = result.receipts.slice(0, 1);
    result.receipts_outcome = result.receipts_outcome.slice(0, 1);
    result.receipts_outcome[0].outcome.receipt_ids = [];
    result.receipts_outcome[0].outcome.status = result.status;
    state.completed.set(state.signed[0], result);
  };
  const finalizeManaged = () => {
    const { signed, transactionHash } = state.pendingManaged;
    const call = signed.transaction.actions[0].functionCall;
    state.nonce = Number(signed.transaction.nonce);
    state.completed.set(transactionHash, { final_execution_status: 'FINAL', status: { SuccessValue: '' },
      transaction: { hash: transactionHash, signer_id: accountId, receiver_id: signed.transaction.receiverId,
        actions: [{ FunctionCall: { method_name: call.methodName, args: Buffer.from(call.args).toString('base64'),
          deposit: call.deposit.toString(), gas: Number(call.gas) } }] } });
  };
  return { state, chain, rows, xUserId, accountId, failRoot, finalizeManaged, intents: { status: async ({ depositAddress }) => statuses.get(depositAddress) } };
}

test('an earlier pending managed send reserves its nonce before broadcast and fences unwrap until exact finality', async () => {
  const f = await realSigningFixture([yocto('0.1')]);
  f.state.loseFirst = false;
  const user = await db.one("insert into users(x_user_id,x_username,setup_completed_at) values($1,'synthetic',now()) returning *", [f.xUserId]);
  const bet = await db.one(`insert into bilateral_bets(id,creator_user_id,request_id,claim,criteria,evidence_source_url,
    creator_side,stake_yocto,accept_by,resolve_at,terms_hash,terms_salt) values($1,$2,$3,'Synthetic','Synthetic','https://example.test',
    'yes',$4,now()+interval '1 hour',now()+interval '2 hours','hash','salt') returning *`, [randomUUID(), user.id, randomUUID(), yocto('0.1')]);
  const request = await db.one(`insert into bilateral_near_requests(id,bet_id,user_id,wallet_account,method,args,metadata)
    values($1,$2,$3,$4,'cancel_bet',$5,$6) returning *`, [randomUUID(), bet.id, user.id, f.accountId,
    { id: bet.id }, { contract: 'escrow.stated.near', depositYocto: '0' }]);
  const source = await readFile(process.env.STATED_TEST_SOURCE_ROOT ? `${process.env.STATED_TEST_SOURCE_ROOT}/play.mjs`
    : new URL('../src/play.mjs', import.meta.url), 'utf8');
  const body = source.slice(source.indexOf('async function performPlayAction('), source.indexOf('/** The referee settles'));
  const deps = { assertPlay: () => {}, playAccountFor, secretOf, ensureFunds, assertSignerAvailable, reservePlaySigner, UserError,
    prepareNearAction: async () => ({ requestId: request.id, method: request.method, args: request.args,
      depositYocto: '0', payload: { contract: 'escrow.stated.near' } }),
    verifyBetTransaction: async () => ({ status: 'pending' }), syncNearBet: async () => bet };
  const perform = new Function(...Object.keys(deps), `${body};return performPlayAction`)(...Object.values(deps));
  const broadcast = f.chain.broadcastCall;
  f.chain.broadcastCall = async prepared => {
    const committed = await db.one('select signer_intent from play_accounts where account_id=$1', [f.accountId]);
    const saved = await db.one('select transaction_hash,signed_transaction from bilateral_near_requests where id=$1', [request.id]);
    assert.equal(committed.signer_intent?.signedTransaction, prepared.signedTransaction, 'reservation committed before send');
    assert.equal(saved.signed_transaction, prepared.signedTransaction, 'request signature committed before send');
    return broadcast(prepared);
  };
  const sent = await perform(db, { ...config, play: { ...config.play, fundsStakes: false } }, f.chain, user, bet.id, { action: 'cancel' }, {});
  f.chain.broadcastCall = broadcast;
  assert.equal(sent.status, 'pending');
  const blocked = await refreshDeposit(db, config, f.chain, f.intents, f.rows[0]);
  assert.equal(blocked.unwrap_signed_transaction, null, 'an earlier managed send must prevent any unwrap signature');
  assert.equal(f.state.signed.length, 1, 'pending managed nonce 11 must prevent an unwrap from signing nonce 11');
  const stored = await db.one('select transaction_hash,signed_transaction from bilateral_near_requests where id=$1', [request.id]);
  assert.equal(stored.transaction_hash, sent.hash);
  assert.ok(stored.signed_transaction);
  const wrong = { final_execution_status: 'FINAL', status: { SuccessValue: '' },
    transaction: { hash: sent.hash, signer_id: 'wrong.near', receiver_id: 'escrow.stated.near' } };
  f.state.completed.set(sent.hash, wrong);
  await refreshDeposit(db, config, f.chain, f.intents, f.rows[0], { now: Date.now() + 5000 });
  assert.equal(f.state.signed.length, 1, 'unrelated finalized transaction cannot release the reservation');
  f.state.completed.delete(sent.hash);
  f.state.height = 1000;
  f.state.nonce = 11;
  await refreshDeposit(db, config, f.chain, f.intents, f.rows[0], { now: Date.now() + 10000 });
  assert.equal(f.state.signed.length, 1, 'unknown transaction plus a consumed nonce never releases the reservation');
  f.finalizeManaged();
  const completed = await refreshDeposit(db, config, f.chain, f.intents, f.rows[0], { now: Date.now() + 15000 });
  assert.ok(completed.finished_at);
  assert.equal(f.state.signed.length, 2);
  assert.equal(f.state.nonce, 12);
  assert.ok((await db.one('select signer_released_at from bilateral_near_requests where id=$1', [request.id])).signer_released_at);
});

for (const amounts of [[yocto('0.1'), yocto('0.1')], [yocto('0.1'), yocto('0.2')]]) {
  test(`real SDK signing serializes two wrapped deposits of ${amounts.join(' and ')}`, async () => {
    const f = await realSigningFixture(amounts);
    const first = await Promise.all(f.rows.map(row => refreshDeposit(db, config, f.chain, f.intents, row)));
    assert.equal(first.filter(row => row.finished_at).length, 0);
    assert.equal(f.state.signed.length, 1, 'another deposit cannot allocate the same account nonce');
    let managedSigned = false;
    await assert.rejects(withAvailablePlaySigner(db, f.accountId, async () => { managedSigned = true; }), /still being unwrapped/);
    assert.equal(managedSigned, false);
    await assert.rejects(startDeposit(db, config, f.chain, {
      tokens: async () => [{ assetId: 'test', symbol: 'TEST', chainName: 'Synthetic' }],
    }, { x_user_id: f.xUserId }, { assetId: 'test', near: '0.1', refundTo: 'refund-address' }), /still being unwrapped/);
    for (const row of f.rows) await refreshDeposit(db, config, f.chain, f.intents, row, { now: Date.now() + 5000 });
    for (const row of f.rows) await refreshDeposit(db, config, f.chain, f.intents, row, { now: Date.now() + 10000 });
    const completed = await db.many('select * from play_deposits where account_id=$1', [f.accountId]);
    assert.equal(completed.filter(row => row.finished_at).length, 2);
    assert.equal(new Set(completed.map(row => row.unwrap_tx)).size, 2);
    assert.equal(f.state.completed.size, 2);
    assert.equal(f.state.held, 0n);
    assert.equal(f.state.nonce, 12);
  });
}

test('exact root rollback or never-executed expiry permits replacement while ambiguous consumed nonces stay reserved', async () => {
  for (const rejection of ['nonce', 'Expired']) {
    const f = await realSigningFixture([yocto('0.1')]);
    const row = f.rows[0];
    await refreshDeposit(db, config, f.chain, f.intents, row);
    if (rejection === 'nonce') f.state.nonce = 20;
    else { f.state.height = 201; f.state.reject = 'Expired'; }
    let retired = await refreshDeposit(db, config, f.chain, f.intents, row, { now: Date.now() + 5000 });
    if (rejection === 'nonce') {
      assert.ok(retired.unwrap_signed_transaction, 'an unknown consumed nonce does not prove prior nonexecution');
      f.failRoot();
      retired = await refreshDeposit(db, config, f.chain, f.intents, row, { now: Date.now() + 10000 });
    }
    assert.equal(retired.unwrap_signed_transaction, null);
    assert.equal([...f.state.completed.values()].filter(result => result.status.SuccessValue != null).length, 0);
    f.state.reject = null;
    const done = await refreshDeposit(db, config, f.chain, f.intents, row, { now: Date.now() + 15000 });
    assert.ok(done.finished_at);
    assert.equal([...f.state.completed.values()].filter(result => result.status.SuccessValue != null).length, 1);
    assert.equal(f.state.held, 0n);
    assert.equal(new Set(f.state.signed).size, 2);
  }
});

test('failed prepared unwraps leave room for later payments in the next worker batch', async () => {
  const f = await fixture();
  let attempts = 0;
  f.near.chain.unwrapDelivery = async () => { attempts += 1; return false; };
  f.near.chain.broadcastCall = async () => { throw new Error('Synthetic persistent outage'); };
  const ids = [];
  for (let index = 0; index < 21; index += 1) {
    const row = await f.deposit();
    ids.push(row.id);
    await db.query(`update play_deposits set state='SUCCESS',unwrap_pending_tx=$2,unwrap_signed_transaction=$2
      where id=$1`, [row.id, 'synthetic-signed-' + index]);
  }
  // Scope this worker to its fixture while retaining the production ordering,
  // eligibility condition and batch limit.
  const scoped = { ...db, many: sql => db.many(sql.replace('where finished_at is null',
    'where id = any($1::uuid[]) and finished_at is null'), [ids]) };
  assert.equal(await refreshOpenDeposits(scoped, config, f.near.chain, f.intents), 20);
  assert.equal(attempts, 20);
  assert.equal(await refreshOpenDeposits(scoped, config, f.near.chain, f.intents), 1);
  assert.equal(attempts, 21);
});
