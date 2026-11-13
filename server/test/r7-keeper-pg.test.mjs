import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { startPostgres } from './support/pg.mjs';
import { createDb } from '../src/db.mjs';
import { canonicalJson, fingerprint } from '../src/canonical.mjs';
import { outlayerTermsHash } from '../src/outlayer.mjs';
import { UserError } from '../src/store.mjs';
import { withManagedOperation } from '../src/play.mjs';

// Real SQL selection, locking and durable intents; only escrow reads and the
// signing/finality transport are synthetic. Run alongside outlayer-r3-ops-pg.
test('PostgreSQL keeper closes every terminal escrow stage, respects the cap, and stops selecting settled referees', async () => {
  const pg = await startPostgres(); const db = createDb(pg.url);
  try {
    await db.query(`create table users(id bigint primary key);
      insert into users values(1);
      create table bilateral_bets(id uuid primary key,creator_user_id bigint,status text,claim text,resolve_at timestamptz,
        terms_salt text,terms_hash text,referee_wallet text,outlayer_material jsonb,chain_state jsonb,
        near_verified_at timestamptz,outcome text);
      create table bilateral_bet_events(id bigserial primary key,bet_id uuid,actor_user_id bigint,kind text,detail jsonb);
      create table outlayer_near_requests(id uuid primary key,bet_id uuid references bilateral_bets(id),
        signer_account text,contract_account text,method text,args jsonb,deposit_yocto text,gas text,intent_key text,
        transaction_hash text unique,signed_transaction text,broadcast_started_at timestamptz,detail text,
        execution_status text default 'pending',created_at timestamptz default clock_timestamp(),updated_at timestamptz default clock_timestamp())`);
    const now = Date.now(); const rulings = new Map(); const prepared = new Map(); let signed = 0;
    const source = await readFile(new URL('../src/outlayer.mjs', import.meta.url), 'utf8');
    const body = source.replace(/^import .*?;\n/gm, '').replace(/^export \{.*?\};\n/gm, '').replace(/^export /gm, '');
    const deps = { createHash, randomUUID, canonicalJson, fingerprint, UserError, withManagedOperation,
      treasury: async () => ({ id: 'sponsor.testnet', secret: 'synthetic' }),
      syncNearBet: async (_db, _config, _user, id) => db.one('select * from bilateral_bets where id=$1', [id]),
      verifyNearExecution: async () => ({ status: 'succeeded' }) };
    const run = new Function(...Object.keys(deps), `${body}\nreturn runOutlayerKeeper;`)(...Object.values(deps));
    const chain = { view: async ({ method, args }) => {
      if (method === 'get_config') return { escrow: 'escrow.testnet', timeout_seconds: 600 };
      if (method === 'get_ruling') return rulings.get(args.bet_id) ?? null;
      assert.fail(`No compute or external view expected: ${method}`);
    }, prepareCall: async input => {
      assert.equal(input.method, 'request_ruling'); signed++;
      const hash = randomUUID(); prepared.set(hash, input.args.bet_id);
      return { hash, signedTransaction: hash };
    }, broadcastCall: async ({ signedTransaction }) => {
      rulings.get(prepared.get(signedTransaction)).stage = 'settled';
    } };
    for (const status of ['settled', 'refunded']) {
      for (const stage of ['idle', 'reading', 'pricing', 'running', 'paying', 'settled', null]) {
        const id = randomUUID();
        const material = { bet_id: id, claim: 'A release ships.', made_at: new Date(now - 3600000).toISOString(),
          deadline: new Date(now - 120000).toISOString(), post_url: 'https://www.sec.gov/newsroom',
          evidence: { kind: 'open', window_seconds: 60, max_per_side: 2 } };
        const salt = 'a'.repeat(64); const hash = outlayerTermsHash(material, salt);
        const ruling = stage === null ? null : { material_json: JSON.stringify(material), terms_hash: hash,
          stage, nonce: '1', outcome: null, next_ns: '0', started_ns: (BigInt(now - 600000) * 1000000n).toString(),
          deadline_ns: (BigInt(Date.parse(material.deadline)) * 1000000n).toString() };
        rulings.set(id, ruling);
        await db.query(`insert into bilateral_bets values($1,1,$2,$3,$4,$5,$6,'ref.testnet',$7,'{}',null,null)`,
          [id, status, material.claim, material.deadline, salt, hash, material]);
        await db.query(`insert into bilateral_bet_events(bet_id,actor_user_id,kind,detail)
          values($1,1,'outlayer_ruling',$2)`, [id, { escrow_terminal: true, ruling }]);
      }
    }
    const config = { nearContract: 'escrow.testnet', play: { enabled: true }, outlayer: { rulingDailyLimit: 0 } };
    const capped = await run(db, config, { chain, now });
    assert.equal(capped.checked, 10, 'only registered non-settled referees need cleanup');
    assert.equal(capped.errors, 10);
    assert.ok(capped.results.every(row => /daily ruling limit/.test(row.error)));
    assert.equal(signed, 0);
    config.outlayer.rulingDailyLimit = 1;
    const cleaned = await run(db, config, { chain, now });
    assert.equal(cleaned.checked, 10); assert.equal(cleaned.errors, 0);
    assert.equal(signed, 10);
    assert.equal((await db.one("select count(*)::int as n from outlayer_near_requests where execution_status='succeeded'")).n, 10);
    assert.equal((await run(db, config, { chain, now })).checked, 0, 'settled snapshots stop further polling');
  } finally { await db.close(); pg.stop(); }
});
