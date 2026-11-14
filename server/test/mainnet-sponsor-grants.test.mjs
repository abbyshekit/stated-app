// INTEGRATION: real Postgres reservations, with only NEAR account creation faked.
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db.mjs';
import { ensurePlayAccount, playAccountFor, yocto, referee, topUpReferee } from '../src/play.mjs';
import { useNetwork } from '../src/near-network.mjs';
import { startPostgres } from './support/pg.mjs';
import { FakeNear } from './support/fake-near.mjs';
import { FakeOutLayerNear } from './support/fake-outlayer.mjs';
import { ensureOutlayerRegistration, outlayerTermsHash } from '../src/outlayer.mjs';
import { randomUUID } from 'node:crypto';

const config = (play = {}) => ({ tokenKey: 'synthetic-token-key', near: { network: 'mainnet', real: true }, play: {
  enabled: true, treasury: 'stated.near', treasuryKey: 'synthetic-unused-key',
  pilotXIds: ['*'], fundsStakes: false, startNear: '1', newAccountsPerHour: 1000, ...play,
} });
let pg; let db; let near;
const person = (id) => ({ xUserId: String(id), username: `user${id}` });
const openAccount = (id, settings = config(), chain = near.chain) => ensurePlayAccount(db, settings, chain, person(id));

before(async () => {
  pg = await startPostgres(); db = createDb(pg.url); await db.migrate(); useNetwork('mainnet');
});
beforeEach(async () => {
  await db.query('truncate users, bilateral_bets, play_accounts, play_account_grants, kv cascade');
  near = new FakeNear({ contract: 'escrow.near' });
  near.accounts.set('stated.near', { balance: BigInt(yocto('100')), keys: new Set() });
});
after(async () => { await db?.close(); pg?.stop(); useNetwork('testnet'); });

test('concurrent first accounts allocate exactly the default lifetime quota and keep their actual grants', async () => {
  const accounts = await Promise.all(Array.from({ length: 40 }, (_, i) => openAccount(i + 1)));
  assert.equal(accounts.filter((row) => row.granted_yocto === yocto('1')).length, 25);
  assert.equal(accounts.filter((row) => row.granted_yocto === yocto('0.05')).length, 15);
  for (const row of accounts) assert.equal(await near.chain.balance(row.account_id), row.granted_yocto);
  const spend = yocto('25.75');
  assert.equal((BigInt(yocto('100')) - BigInt(await near.chain.balance('stated.near'))).toString(), spend);
  const retries = await Promise.all(Array.from({ length: 12 }, () => openAccount(1)));
  assert.ok(retries.every((row) => row.account_id === accounts[0].account_id));
  assert.equal((BigInt(yocto('100')) - BigInt(await near.chain.balance('stated.near'))).toString(), spend);
});

test('concurrent retries of an unfinished account create it and assign its grant once', async () => {
  let creates = 0;
  const original = near.chain.createAccount;
  near.chain.createAccount = async (input) => {
    creates++;
    const assignment = await db.one('select amount_yocto from play_account_grants where x_user_id=$1', ['41']);
    assert.equal(assignment.amount_yocto, input.amountYocto, 'assignment is committed before the chain call');
    assert.equal((await playAccountFor(db, '41')).granted_yocto, '0');
    await new Promise((resolve) => setTimeout(resolve, 20));
    return original(input);
  };
  const chain = near.chain;
  const rows = await Promise.all(Array.from({ length: 12 }, () => openAccount(41, config({ sponsorLimit: 1 }), chain)));
  assert.equal(creates, 1);
  assert.ok(rows.every((row) => row.account_id === rows[0].account_id && row.granted_yocto === yocto('1')));
});

test('a crash after account creation survives reconnect and configuration changes without another grant', async () => {
  const original = near.chain.broadcastCall;
  const chain = { ...near.chain, broadcastCall: async input => { await original(input); throw new Error('synthetic crash after chain creation'); } };
  await assert.rejects(openAccount(51, config({ sponsorLimit: 1 }), chain), /synthetic crash/);
  assert.equal((await playAccountFor(db, '51')).ready, false);
  const spent = await near.chain.balance('stated.near');
  await db.close(); db = createDb(pg.url); await db.migrate();
  const recovered = await openAccount(51, config({ startNear: '2', sponsorLimit: 1 }));
  assert.equal(recovered.granted_yocto, yocto('1'));
  assert.equal(await near.chain.balance('stated.near'), spent);
  assert.equal((await openAccount(52, config({ startNear: '2', sponsorLimit: 1 }))).granted_yocto, yocto('0.05'));
});

test('a reservation before failed creation retains its amount and consumes its quota across a restart', async () => {
  await assert.rejects(openAccount(61, config({ sponsorLimit: 1 }), { ...near.chain, broadcastCall: async () => { throw new Error('synthetic RPC outage'); } }), /synthetic RPC outage/);
  assert.equal((await playAccountFor(db, '61')).granted_yocto, '0', 'an uncreated account has received no grant');
  await db.close(); db = createDb(pg.url);
  await assert.rejects(openAccount(62, config({ sponsorLimit: 1 })), /treasury-funded account transaction is still pending/);
  assert.equal((await openAccount(61, config({ sponsorLimit: 1, startNear: '2' }))).granted_yocto, yocto('1'));
  assert.equal((await openAccount(62, config({ sponsorLimit: 1 }))).granted_yocto, yocto('0.05'));
});

test('zero quota disables sponsorship and deleting an account cannot reopen a consumed slot', async () => {
  assert.equal((await openAccount(71, config({ sponsorLimit: 0 }))).granted_yocto, yocto('0.05'));
  assert.equal((await openAccount(74, config({ startNear: undefined }))).granted_yocto, yocto('0.05'), 'sponsorship is off by default');
  await openAccount(72, config({ sponsorLimit: 1 }));
  await db.query('delete from play_accounts where x_user_id=$1', ['72']);
  const balance = await near.chain.balance('stated.near');
  await assert.rejects(openAccount(72, config({ sponsorLimit: 1 })), /already received its starting balance/);
  assert.equal(await near.chain.balance('stated.near'), balance, 'deleting a row cannot regrant the same X user');
  assert.equal((await openAccount(73, config({ sponsorLimit: 1 }))).granted_yocto, yocto('0.05'));
});

test('existing ready sponsored accounts count toward the lifetime cap after migration', async () => {
  await db.query(`insert into play_accounts(x_user_id, account_id, public_key, ready, granted_yocto)
    values('81', 'legacy.stated.near', 'synthetic-public-key', true, $1)`, [yocto('1')]);
  await db.migrate();
  assert.equal((await openAccount(82, config({ sponsorLimit: 1 }))).granted_yocto, yocto('0.05'));
});

test('testnet retains its configured starting grant regardless of sponsor quota', async () => {
  useNetwork('testnet');
  near.accounts.set('stated.testnet', { balance: BigInt(yocto('100')), keys: new Set() });
  try {
    const settings = { ...config(), near: { network: 'testnet', real: false }, play: { ...config().play,
      treasury: 'stated.testnet', startNear: '1.6', sponsorLimit: 0, fundsStakes: true } };
    assert.equal((await openAccount(91, settings)).granted_yocto, yocto('1.6'));
  } finally { useNetwork('mainnet'); }
});

test('an unfunded mainnet signup leaves its full sponsor slot available for a funded retry', async () => {
  near.accounts.get('stated.near').balance = BigInt(yocto('0.8849598982974804'));
  const settings = config({ startNear: '0.25', sponsorLimit: 1 });
  await assert.rejects(openAccount(101, settings), /treasury.*liquidity|liquidity.*treasury/i);
  assert.equal((await db.one('select count(*)::int as n from play_account_grants')).n, 0);
  assert.equal(await near.chain.balance('user101.stated.near'), null);
  near.accounts.get('stated.near').balance = BigInt(yocto('2'));
  assert.equal((await openAccount(101, settings)).granted_yocto, yocto('0.25'));
  assert.equal((await openAccount(102, settings)).granted_yocto, yocto('0.05'));
});

test('fee-only mainnet accounts also preserve keeper liquidity before assigning a grant', async () => {
  near.accounts.get('stated.near').balance = BigInt(yocto('0.9'));
  await assert.rejects(openAccount(111, config({ sponsorLimit: 0 })), /treasury.*liquidity|liquidity.*treasury/i);
  assert.equal((await db.one('select count(*)::int as n from play_account_grants')).n, 0);
});

test('parallel signups recheck the remaining treasury before consuming another full grant', async () => {
  near.accounts.get('stated.near').balance = BigInt(yocto('1.4'));
  const results = await Promise.allSettled([121, 122].map(id => openAccount(id, config({ startNear: '0.25' }))));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.match(results.find(result => result.status === 'rejected').reason.message, /keeper liquidity/);
  assert.equal((await db.one('select count(*)::int as n from play_account_grants')).n, 1);
});

test('an ambiguous creation fences other grants and resumes the identical signature after restart', async () => {
  const settings = config({ startNear: '0.25' });
  let signed = 0; const prepare = near.chain.prepareCreateAccount;
  const submitted = [];
  const chain = { ...near.chain, prepareCreateAccount: async input => { signed++; return prepare(input); },
    broadcastCall: async intent => { submitted.push(intent.signedTransaction); throw new Error('lost response'); } };
  await assert.rejects(openAccount(131, settings, chain), /lost response/);
  await assert.rejects(openAccount(132, settings), /treasury-funded account transaction is still pending/);
  assert.equal((await db.one('select count(*)::int as n from play_account_grants')).n, 1);
  await db.close(); db = createDb(pg.url);
  const broadcast = near.chain.broadcastCall;
  await openAccount(131, settings, { ...chain, broadcastCall: async intent => {
    submitted.push(intent.signedTransaction); return broadcast(intent);
  } });
  assert.equal(signed, 1);
  assert.deepEqual(submitted, [submitted[0], submitted[0]]);
  const balance = await near.chain.balance('stated.near');
  near.accounts.get('stated.near').balance = 0n;
  assert.equal((await openAccount(131, settings)).granted_yocto, yocto('0.25'), 'ready wallets do not need another admission');
  near.accounts.get('stated.near').balance = BigInt(balance);
});

async function acceptedOutlayerBet() {
  const creator = await db.one("insert into users(x_user_id,x_username) values($1,$1) returning id", [randomUUID()]);
  const id = randomUUID();
  const made = new Date(Date.now() - 3600000).toISOString();
  const deadline = new Date(Date.now() + 3600000).toISOString();
  const material = { bet_id: id, claim: 'A stable release ships.', made_at: made, deadline,
    post_url: 'https://www.sec.gov/newsroom', evidence: { kind: 'open', window_seconds: 120, max_per_side: 2 } };
  const salt = 'a'.repeat(64); const hash = outlayerTermsHash(material, salt);
  const bet = await db.one(`insert into bilateral_bets(id,creator_user_id,request_id,claim,criteria,evidence_source_url,
    creator_side,stake_yocto,accept_by,resolve_at,terms_hash,terms_salt,status,outlayer_material,referee_wallet,creator_wallet)
    values($1,$2,$3,$4,'Stable release','https://www.sec.gov/newsroom','yes',$5,$6,$7,$8,$9,'accepted',$10,$11,'alice.near') returning *`,
  [id, creator.id, randomUUID(), material.claim, yocto('0.1'), made, deadline, hash, salt, material, near.referee]);
  near.bets.set(id, { id, terms_hash: hash, referee: near.referee, creator: 'alice.near', acceptor: 'bob.near',
    status: 'accepted', resolve_at_ns: (BigInt(Date.parse(deadline)) * 1000000n).toString() });
  return bet;
}

test('registration reserves future ruling liquidity before quota or signing, then admits a funded retry', async () => {
  near = new FakeOutLayerNear({ contract: 'escrow.near', referee: 'ref.near' });
  near.accounts.set('stated.near', { balance: BigInt(yocto('0.6')), keys: new Set() });
  const bet = await acceptedOutlayerBet();
  const settings = { ...config(), nearContract: near.contract, outlayer: { registrationDailyLimit: 1 } };
  const register = () => ensureOutlayerRegistration(db, settings, near.chain, bet, { fetchImpl: near.fetchImpl });
  await assert.rejects(register(), /keeper liquidity/);
  assert.equal((await db.one('select count(*)::int as n from outlayer_near_requests')).n, 0);
  assert.equal(near.sent.length, 0);
  near.accounts.get('stated.near').balance = BigInt(yocto('1'));
  assert.ok(await register());
  const sent = near.sent.length;
  assert.ok(await register());
  assert.equal(near.sent.length, sent, 'an observed registration never spends again');
});

test('parallel registrations reserve each existing bet ruling and skip unregistered accepted bets', async () => {
  near = new FakeOutLayerNear({ contract: 'escrow.near', referee: 'ref.near' });
  near.accounts.set('stated.near', { balance: BigInt(yocto('1.1')), keys: new Set() });
  const bets = await Promise.all(Array.from({ length: 4 }, acceptedOutlayerBet));
  const settings = { ...config(), nearContract: near.contract };
  const results = await Promise.allSettled(bets.map(bet => ensureOutlayerRegistration(db, settings, near.chain, bet, { fetchImpl: near.fetchImpl })));
  assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
  assert.ok(results.filter(result => result.status === 'rejected').every(result => /keeper liquidity/.test(result.reason.message)));
  assert.equal((await db.one('select count(*)::int as n from outlayer_near_requests')).n, 1);
});

test('pending registration exposure blocks a new grant and registration but reuses its existing intent', async () => {
  near = new FakeOutLayerNear({ contract: 'escrow.near', referee: 'ref.near' });
  near.accounts.set('stated.near', { balance: BigInt(yocto('3')), keys: new Set() });
  const [bet, other] = await Promise.all([acceptedOutlayerBet(), acceptedOutlayerBet()]);
  const settings = { ...config({ startNear: '0.25' }), nearContract: near.contract };
  const broadcast = near.chain.broadcastCall;
  const sent = [];
  const chain = { ...near.chain, broadcastCall: async intent => {
    sent.push(intent.signedTransaction); throw new Error('ambiguous registration');
  } };
  const register = (item, transport = chain) => ensureOutlayerRegistration(db, settings, transport, item, { fetchImpl: near.fetchImpl });
  await assert.rejects(register(bet), /ambiguous registration/);
  await assert.rejects(openAccount(141, settings), /transaction is still pending/);
  await assert.rejects(register(other), /transaction is still pending/);
  assert.equal((await db.one('select count(*)::int as n from play_account_grants')).n, 0);
  assert.equal((await db.one('select count(*)::int as n from outlayer_near_requests')).n, 1);
  assert.ok(await register(bet, { ...chain, broadcastCall: async intent => {
    sent.push(intent.signedTransaction); return broadcast(intent);
  } }));
  assert.deepEqual(sent, [sent[0], sent[0]], 'the retry broadcasts the existing signed intent');
  assert.equal((await db.one('select count(*)::int as n from outlayer_near_requests')).n, 1);
});

test('live gas repricing and missing chain capability fail closed before a grant assignment', async () => {
  near.accounts.get('stated.near').balance = BigInt(yocto('2'));
  const priced = { ...near.chain, callFunds: async () => ({ balance: BigInt(yocto('2')), reserve: BigInt(yocto('1')) }) };
  await assert.rejects(openAccount(151, config({ startNear: '0.25' }), priced), /keeper liquidity/);
  await assert.rejects(openAccount(152, config(), { ...near.chain, callFunds: undefined }), /callFunds/);
  await assert.rejects(openAccount(153, config(), { ...near.chain, prepareCreateAccount: undefined }), /durable transaction signing/);
  assert.equal((await db.one('select count(*)::int as n from play_account_grants')).n, 0);
});

test('an assigned full grant is never downgraded when a later retry lacks liquidity', async () => {
  const settings = config({ startNear: '0.25', sponsorLimit: 1 });
  await assert.rejects(openAccount(161, settings, { ...near.chain, prepareCreateAccount: async () => { throw new Error('signing unavailable'); } }), /signing unavailable/);
  assert.equal((await db.one('select amount_yocto from play_account_grants where x_user_id=$1', ['161'])).amount_yocto, yocto('0.25'));
  near.accounts.get('stated.near').balance = BigInt(yocto('0.9'));
  await assert.rejects(openAccount(161, config({ startNear: '0.05', sponsorLimit: 0 })), /keeper liquidity/);
  near.accounts.get('stated.near').balance = BigInt(yocto('2'));
  assert.equal((await openAccount(161, config({ startNear: '0.05', sponsorLimit: 0 }))).granted_yocto, yocto('0.25'));
});

test('legacy referee creation and top-ups cannot bypass keeper liquidity or pending funding fences', async () => {
  near.accounts.get('stated.near').balance = BigInt(yocto('1'));
  await assert.rejects(referee(db, config(), near.chain), /keeper liquidity/);
  assert.equal(await near.chain.balance('referee.stated.near'), null);
  near.accounts.get('stated.near').balance = BigInt(yocto('3'));
  const judge = await referee(db, config(), near.chain);
  near.accounts.get(judge.id).balance = 0n;
  near.accounts.get('stated.near').balance = BigInt(yocto('1'));
  await assert.rejects(topUpReferee(db, config(), near.chain), /keeper liquidity/);
  assert.equal(await near.chain.balance(judge.id), '0');
  near.accounts.get('stated.near').balance = BigInt(yocto('3'));
  const broadcast = near.chain.broadcastCall; const submitted = [];
  const chain = { ...near.chain, broadcastCall: async intent => {
    submitted.push(intent.signedTransaction); await broadcast(intent); throw new Error('lost transfer response');
  } };
  await assert.rejects(topUpReferee(db, config(), chain), /lost transfer response/);
  const before = await near.chain.balance('stated.near');
  assert.equal((await openAccount(171)).granted_yocto, yocto('1'), 'another caller reconciles the exact finalized transfer');
  assert.deepEqual(submitted, [submitted[0]], 'reconciliation never rebroadcasts the completed top-up');
  const after = await near.chain.balance('stated.near');
  assert.equal(BigInt(before) - BigInt(after), BigInt(yocto('1')));
  assert.equal(await topUpReferee(db, config(), near.chain), false);
  assert.equal(await near.chain.balance('stated.near'), after, 'a finalized transfer is never paid twice');
});

test('abandoned finalized wallet funding automatically releases unrelated wallets and keeper registration', async () => {
  near = new FakeOutLayerNear({ contract: 'escrow.near', referee: 'ref.near' });
  near.accounts.set('stated.near', { balance: BigInt(yocto('5')), keys: new Set() });
  const settings = { ...config({ startNear: '0.25' }), nearContract: near.contract };
  const bet = await acceptedOutlayerBet();
  const broadcast = near.chain.broadcastCall;
  let creates = 0; const create = near.chain.createAccount;
  near.chain.createAccount = async input => { creates++; return create(input); };
  await assert.rejects(openAccount(181, settings, { ...near.chain, broadcastCall: async intent => {
    await broadcast(intent); throw new Error('lost finalized creation response');
  } }), /lost finalized creation response/);
  assert.equal((await playAccountFor(db, '181')).ready, false);
  assert.ok(await ensureOutlayerRegistration(db, settings, near.chain, bet, { fetchImpl: near.fetchImpl }));
  assert.equal((await openAccount(182, settings)).granted_yocto, yocto('0.25'));
  assert.equal(creates, 2, 'unrelated callers reconcile without resending the abandoned creation');
  assert.equal((await playAccountFor(db, '181')).ready, false, 'reconciliation does not impersonate the absent wallet owner');
});

test('a recipient balance cannot clear an account funding fence while exact history remains ambiguous', async () => {
  const broadcast = near.chain.broadcastCall;
  const chain = { ...near.chain, preparedFinalized: async () => false, preparedRetrySafe: async () => false,
    broadcastCall: async intent => { await broadcast(intent); throw new Error('lost funding history'); } };
  await assert.rejects(openAccount(191, config(), chain), /lost funding history/);
  assert.equal(await near.chain.balance('user191.stated.near'), yocto('1'));
  await assert.rejects(openAccount(191, config(), chain), /funding is still pending/);
  await assert.rejects(openAccount(192, config(), chain), /transaction is still pending/);
  assert.equal((await db.one('select count(*)::int as n from play_account_grants')).n, 1);
});

test('a recovered referee top-up cannot pay again from a recipient view predating its final receipt', async () => {
  const settings = config();
  const judge = await referee(db, settings, near.chain);
  near.accounts.get(judge.id).balance = 0n;
  const broadcast = near.chain.broadcastCall;
  await assert.rejects(topUpReferee(db, settings, { ...near.chain, broadcastCall: async intent => {
    await broadcast(intent); throw new Error('lost finalized top-up response');
  } }), /lost finalized top-up response/);
  const before = await near.chain.balance('stated.near');
  let prepared = 0;
  const prepare = near.chain.prepareTransfer;
  const funds = near.chain.callFunds;
  const stale = { ...near.chain, callFunds: async (accountId, gas, options) => {
    const result = await funds(accountId, gas, options);
    return accountId === judge.id ? { ...result, balance: 0n, blockHeight: 1 } : result;
  }, prepareTransfer: async input => { prepared++; return prepare(input); } };
  await topUpReferee(db, settings, stale).catch(error => assert.match(error.message, /balance.*(stale|catch|confirm)|funding.*(confirm|recovered)/i));
  await topUpReferee(db, settings, stale).catch(error => assert.match(error.message, /balance.*(stale|catch|confirm)|funding.*(confirm|recovered)/i));
  assert.equal(prepared, 0, 'neither recovery nor a subsequent stale read can authorize another payment');
  assert.equal(await near.chain.balance('stated.near'), before);
  await db.close(); db = createDb(pg.url);
  assert.equal(await topUpReferee(db, settings, near.chain), false, 'a fresh view confirms that the recovered top-up remains spendable');
  near.accounts.get(judge.id).balance = 0n; near.height++;
  assert.equal(await topUpReferee(db, settings, near.chain), true, 'later legitimate spending can receive a fresh top-up');
  assert.equal(BigInt(before) - BigInt(await near.chain.balance('stated.near')), BigInt(yocto('0.2')));
});

test('settled and refunded escrows retain registration cleanup liquidity until the latest referee snapshot is terminal', async () => {
  near = new FakeOutLayerNear({ contract: 'escrow.near', referee: 'ref.near' });
  near.accounts.set('stated.near', { balance: BigInt(yocto('5')), keys: new Set() });
  const settings = { ...config({ startNear: '0.25' }), nearContract: near.contract };
  const old = await Promise.all([acceptedOutlayerBet(), acceptedOutlayerBet()]);
  for (const [i, bet] of old.entries()) {
    await ensureOutlayerRegistration(db, settings, near.chain, bet, { fetchImpl: near.fetchImpl });
    await db.query('update bilateral_bets set status=$2 where id=$1', [bet.id, i ? 'refunded' : 'settled']);
    await db.query("insert into bilateral_bet_events(bet_id,actor_user_id,kind,detail) values($1,$2,'outlayer_ruling',$3)",
      [bet.id, bet.creator_user_id, { escrow_terminal: true, ruling: { stage: 'idle' } }]);
  }
  const fresh = await acceptedOutlayerBet();
  near.accounts.get('stated.near').balance = BigInt(yocto('1.35'));
  const intents = (await db.one('select count(*)::int as n from outlayer_near_requests')).n;
  await assert.rejects(openAccount(201, settings), /keeper liquidity/);
  await assert.rejects(ensureOutlayerRegistration(db, settings, near.chain, fresh, { fetchImpl: near.fetchImpl }), /keeper liquidity/);
  assert.equal((await db.one('select count(*)::int as n from play_account_grants')).n, 0);
  assert.equal((await db.one('select count(*)::int as n from outlayer_near_requests')).n, intents);
  for (const [i, bet] of old.entries()) await db.query(
    "insert into bilateral_bet_events(bet_id,actor_user_id,kind,detail) values($1,$2,'outlayer_ruling',$3)",
    [bet.id, bet.creator_user_id, { escrow_terminal: true, ruling: i ? null : { stage: 'settled' } }]);
  assert.equal((await openAccount(201, settings)).granted_yocto, yocto('0.25'));
  assert.ok(await ensureOutlayerRegistration(db, settings, near.chain, fresh, { fetchImpl: near.fetchImpl }));
});

test('a lost final failed creation can retry its immutable grant after exact failure reconciliation', async () => {
  const settings = config({ startNear: '0.25', sponsorLimit: 1 });
  let creates = 0; const create = near.chain.createAccount;
  near.chain.createAccount = async input => ++creates === 1
    ? near.record({ signer: input.parentId, receiver: input.accountId, failure: 'synthetic creation rollback' }) : create(input);
  const broadcast = near.chain.broadcastCall;
  const before = await near.chain.balance('stated.near');
  await assert.rejects(openAccount(211, settings, { ...near.chain, broadcastCall: async intent => {
    await broadcast(intent); throw new Error('lost failed creation response');
  } }), /lost failed creation response/);
  assert.equal(await near.chain.balance('user211.stated.near'), null);
  assert.equal((await openAccount(211, settings)).granted_yocto, yocto('0.25'));
  assert.equal(creates, 2);
  assert.equal(BigInt(before) - BigInt(await near.chain.balance('stated.near')), BigInt(yocto('0.25')));
  assert.equal((await db.one('select count(*)::int as n from play_account_grants')).n, 1);
});

test('treasury admission rejects stale spent balances across recipients and database restarts', async () => {
  const settings = config({ startNear: '0.25' });
  near.accounts.get('stated.near').balance = BigInt(yocto('1.4'));
  const funds = near.chain.callFunds; const prepare = near.chain.prepareCreateAccount; let signatures = 0;
  const stale = { ...near.chain, callFunds: async (id, gas, options) => {
    const current = await funds(id, gas, options);
    return id === 'stated.near' ? { ...current, balance: BigInt(yocto('1.4')), blockHeight: 1 } : current;
  }, prepareCreateAccount: async input => { signatures++; return prepare(input); } };
  assert.equal((await openAccount(221, settings, stale)).granted_yocto, yocto('0.25'));
  await assert.rejects(openAccount(222, settings, stale), /balance.*stale|keeper liquidity/);
  await db.close(); db = createDb(pg.url);
  await assert.rejects(openAccount(223, settings, stale), /balance.*stale|keeper liquidity/);
  assert.equal(signatures, 1);
  assert.equal((await db.one('select count(*)::int as n from play_account_grants')).n, 1);
  assert.equal(await near.chain.balance('stated.near'), yocto('1.15'));
  await assert.rejects(openAccount(222, settings), /keeper liquidity/);
  near.accounts.get('stated.near').balance = BigInt(yocto('2')); near.height++;
  assert.equal((await openAccount(222, settings)).granted_yocto, yocto('0.25'));
});

test('registration spending also advances the durable treasury admission watermark', async () => {
  near = new FakeOutLayerNear({ contract: 'escrow.near', referee: 'ref.near' });
  near.accounts.set('stated.near', { balance: BigInt(yocto('1.4')), keys: new Set() });
  const settings = { ...config(), nearContract: near.contract };
  const [first, second] = await Promise.all([acceptedOutlayerBet(), acceptedOutlayerBet()]);
  const funds = near.chain.callFunds; const prepare = near.chain.prepareCall; let signatures = 0;
  const stale = { ...near.chain, callFunds: async (id, gas, options) => {
    const current = await funds(id, gas, options);
    return id === 'stated.near' ? { ...current, balance: BigInt(yocto('1.4')), blockHeight: 1 } : current;
  }, prepareCall: async input => { signatures++; return prepare(input); } };
  const register = (bet, chain = stale) => ensureOutlayerRegistration(db, settings, chain, bet, { fetchImpl: near.fetchImpl });
  assert.ok(await register(first));
  await db.query("delete from kv where key like 'treasury-spend-%'");
  await db.query("update outlayer_near_requests set execution_status='pending' where bet_id=$1", [first.id]);
  assert.ok(await register(first), 'read-only reconciliation recovers an older durable registration spend');
  assert.equal(signatures, 1);
  await db.close(); db = createDb(pg.url);
  await assert.rejects(register(second), /balance.*stale|keeper liquidity/);
  assert.equal(signatures, 1);
  assert.equal((await db.one('select count(*)::int as n from outlayer_near_requests')).n, 1);
  near.accounts.get('stated.near').balance = BigInt(yocto('2')); near.height++;
  assert.ok(await register(second, near.chain));
});

test('unknown finalized spend receipts cannot reopen treasury admission after restart', async () => {
  const settings = config({ startNear: '0.25' });
  const unknown = { ...near.chain, preparedSpendFinalized: async () => null, preparedNeverExecuted: async () => false };
  assert.equal((await openAccount(231, settings, unknown)).granted_yocto, yocto('0.25'));
  await db.close(); db = createDb(pg.url);
  await assert.rejects(openAccount(232, settings, unknown), /Treasury spending is awaiting confirmation/);
  assert.equal((await db.one('select count(*)::int as n from play_account_grants')).n, 1);
  assert.equal((await openAccount(232, settings)).granted_yocto, yocto('0.25'), 'exact spend proof restores admission');
  assert.equal((await db.one("select count(*)::int as n from kv where key like 'treasury-spend-pending:%'")).n, 0);
});
