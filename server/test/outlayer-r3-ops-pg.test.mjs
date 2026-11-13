import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { startPostgres } from './support/pg.mjs';
import { createDb } from '../src/db.mjs';
import { UserError } from '../src/store.mjs';

// Keep the real SQL, transaction isolation, ledger, clock and lock behavior.
// Only NEAR signing/broadcast/finality are synthetic; no external calls occur.
async function persistentCallModule() {
  const source = await readFile(new URL('../src/outlayer.mjs', import.meta.url), 'utf8');
  const body = source.replace(/^import .*?;\n/gm, '').replace(/^export \{.*?\};\n/gm, '').replace(/^export /gm, '');
  return new Function('randomUUID', 'UserError', 'verifyNearExecution', `${body}\nreturn persistentCall;`)(
    randomUUID, UserError, async () => ({ status: 'succeeded' }));
}

test('PostgreSQL concurrent registrations enforce both bettors durable daily allowances', async () => {
  const pg = await startPostgres(); const db = createDb(pg.url);
  try {
    await db.query(`create table bilateral_bets(id uuid primary key,creator_user_id bigint not null,acceptor_user_id bigint);
      create table outlayer_near_requests(id uuid primary key,bet_id uuid not null references bilateral_bets(id),
        signer_account text,contract_account text,method text,args jsonb,deposit_yocto text,gas text,intent_key text,
        transaction_hash text unique,signed_transaction text,broadcast_started_at timestamptz,detail text,
        execution_status text default 'pending',created_at timestamptz default clock_timestamp(),updated_at timestamptz default clock_timestamp())`);
    const persistentCall = await persistentCallModule();
    // Shared acceptor, distinct creators: either bettor must consume a slot.
    const bets = Array.from({ length: 12 }, (_, i) => ({ id: randomUUID(), creator_user_id: String(i + 10),
      acceptor_user_id: '1', referee_wallet: 'ref.near' }));
    for (const bet of bets) await db.query('insert into bilateral_bets values($1,$2,$3)', [bet.id, bet.creator_user_id, bet.acceptor_user_id]);
    let signed = 0;
    const chain = { prepareCall: async () => { signed++; return { hash: randomUUID(), signedTransaction: 'synthetic' }; }, broadcastCall: async () => {} };
    const call = bet => persistentCall(db, chain, bet, { id: 'sponsor.near' }, 'register_material', {}, '1', '1', null,
      { signerLocked: true, registrationLimit: 5 });
    const results = await Promise.allSettled(bets.map(call));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 5);
    assert.equal(results.filter(result => result.status === 'rejected' && /daily sponsored registration limit/.test(result.reason.message)).length, 7);
    assert.equal(signed, 5);
    assert.equal((await db.one('select count(*)::int as n from outlayer_near_requests')).n, 5);
    const reserved = await db.one('select bet_id from outlayer_near_requests limit 1');
    const bet = bets.find(row => row.id === reserved.bet_id);
    await call(bet);
    assert.equal(signed, 5, 'reconciliation reuses the durable intent');
    await db.query("update outlayer_near_requests set execution_status='failed' where bet_id=$1", [reserved.bet_id]);
    await assert.rejects(call(bet), /daily sponsored registration limit/);
    // Old reservations survive, but no longer consume the current UTC budget.
    await db.query("update outlayer_near_requests set created_at=clock_timestamp()-interval '2 days'");
    await call(bet);
    assert.equal(signed, 6);
  } finally { await db.close(); pg.stop(); }
});

test('PostgreSQL concurrent ruling sends reserve twelve UTC slots and recover an existing intent', async () => {
  const pg = await startPostgres(); const db = createDb(pg.url);
  try {
    await db.query(`create table bilateral_bets(id uuid primary key);
      create table outlayer_near_requests(id uuid primary key,bet_id uuid not null references bilateral_bets(id),
        signer_account text,contract_account text,method text,args jsonb,deposit_yocto text,gas text,intent_key text,
        transaction_hash text unique,signed_transaction text,broadcast_started_at timestamptz,detail text,
        execution_status text default 'pending',created_at timestamptz default clock_timestamp(),updated_at timestamptz default clock_timestamp())`);
    const bet = { id: randomUUID(), referee_wallet: 'ref.near' };
    await db.query('insert into bilateral_bets values($1)', [bet.id]);
    const persistentCall = await persistentCallModule();
    let signed = 0;
    const chain = { prepareCall: async () => { signed++; return { hash: randomUUID(), signedTransaction: 'synthetic' }; },
      broadcastCall: async () => {} };
    const call = nonce => persistentCall(db, chain, bet, { id: 'sponsor.near' }, 'request_ruling', { bet_id: bet.id },
      '0', '300000000000000', null, { signerLocked: true, attemptKey: String(nonce), rulingDailyLimit: 12 });
    const results = await Promise.allSettled(Array.from({ length: 13 }, (_, nonce) => call(nonce)));
    assert.equal(results.filter(result => result.status === 'fulfilled').length, 12);
    assert.equal(results.filter(result => result.status === 'rejected' && /daily ruling limit/.test(result.reason.message)).length, 1);
    assert.equal(signed, 12);
    await call(0);
    assert.equal(signed, 12, 'existing signed intent is recoverable at the cap');
    await db.query("update outlayer_near_requests set created_at=clock_timestamp()-interval '2 days'");
    await call(12);
    assert.equal(signed, 13, 'UTC day rollover releases allowance');
  } finally { await db.close(); pg.stop(); }
});
