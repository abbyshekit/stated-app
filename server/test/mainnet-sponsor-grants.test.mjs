// INTEGRATION: real Postgres reservations, with only NEAR account creation faked.
import test, { after, before, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import { createDb } from '../src/db.mjs';
import { ensurePlayAccount, playAccountFor, yocto } from '../src/play.mjs';
import { useNetwork } from '../src/near-network.mjs';
import { startPostgres } from './support/pg.mjs';
import { FakeNear } from './support/fake-near.mjs';

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
  await db.query('truncate play_accounts, play_account_grants, kv cascade');
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
  const chain = { ...near.chain, createAccount: async (input) => {
    creates++;
    const assignment = await db.one('select amount_yocto from play_account_grants where x_user_id=$1', ['41']);
    assert.equal(assignment.amount_yocto, input.amountYocto, 'assignment is committed before the chain call');
    assert.equal((await playAccountFor(db, '41')).granted_yocto, '0');
    await new Promise((resolve) => setTimeout(resolve, 20));
    return original(input);
  } };
  const rows = await Promise.all(Array.from({ length: 12 }, () => openAccount(41, config({ sponsorLimit: 1 }), chain)));
  assert.equal(creates, 1);
  assert.ok(rows.every((row) => row.account_id === rows[0].account_id && row.granted_yocto === yocto('1')));
});

test('a crash after account creation survives reconnect and configuration changes without another grant', async () => {
  const original = near.chain.createAccount;
  const chain = { ...near.chain, createAccount: async (input) => { await original(input); throw new Error('synthetic crash after chain creation'); } };
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
  await assert.rejects(openAccount(61, config({ sponsorLimit: 1 }), { ...near.chain, createAccount: async () => { throw new Error('synthetic RPC outage'); } }), /synthetic RPC outage/);
  assert.equal((await playAccountFor(db, '61')).granted_yocto, '0', 'an uncreated account has received no grant');
  await db.close(); db = createDb(pg.url);
  assert.equal((await openAccount(62, config({ sponsorLimit: 1 }))).granted_yocto, yocto('0.05'));
  assert.equal((await openAccount(61, config({ sponsorLimit: 1, startNear: '2' }))).granted_yocto, yocto('1'));
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
