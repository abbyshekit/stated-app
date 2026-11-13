import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { startStack } from './support/app.mjs';
import { FakeOutLayerNear } from './support/fake-outlayer.mjs';
import { enclaveEnv, fakeNearAi } from './support/enclave.mjs';
import { outlayerTestFetch } from './support/outlayer-fetch.mjs';
import { createBet } from '../src/bets.mjs';
import { completeSetup, signInFromX } from '../src/store.mjs';

test('PostgreSQL creation releases the user lock while the planner waits and reuses completed requests', async t => {
  const near = new FakeOutLayerNear();
  let entered;
  const planning = new Promise(resolve => { entered = resolve; });
  let release;
  const pending = new Promise(resolve => { release = resolve; });
  const ai = fakeNearAi({ respond: async () => { entered(); await pending; return { source: 'evidence' }; } });
  let s;
  const fetchImpl = outlayerTestFetch({ ai, near: () => near, xBase: () => s?.fakeX.base });
  s = await startStack({ ...enclaveEnv, STATED_ENCLAVE_RULINGS: '', STATED_NEAR_CONTRACT: near.contract,
    STATED_OUTLAYER_REFEREE: near.referee }, { chain: near.chain, fetchImpl });
  t.after(() => s.close());
  // Simulate an existing installation, then rerun the actual startup schema.
  await s.db.query('alter table bilateral_bets drop constraint bilateral_bets_claim_check');
  await s.db.query('alter table bilateral_bets add constraint bilateral_bets_claim_check check (length(claim) between 1 and 1000)');
  await s.db.query(await readFile(new URL('../src/schema.sql', import.meta.url), 'utf8'));
  const user = await completeSetup(s.db, await signInFromX(s.db, { id: '85001', username: 'slowplanner' }), {});
  const input = { requestId: randomUUID(), claim: '界'.repeat(1000), criteria: '界'.repeat(2000),
    evidenceSourceUrl: 'https://www.sec.gov/newsroom', creatorSide: 'yes', stakeNear: '0.1',
    acceptBy: new Date(Date.now() + 3600000).toISOString(), resolveAt: new Date(Date.now() + 7200000).toISOString() };
  const options = { config: s.config, chain: near.chain, fetchImpl };
  const creating = createBet(s.db, user, input, options);
  // Attach the rejection handler before awaiting the barrier.
  creating.catch(() => {});
  try {
    await Promise.race([planning, creating.then(() => assert.fail('planner barrier not reached'))]);
    await s.db.tx(async tx => {
      await tx.query("set local lock_timeout='100ms'");
      assert.ok(await tx.one('select id from users where id=$1 for update', [user.id]), 'planner holds no user lock');
    });
  } finally { release(); }
  const created = await creating;
  assert.equal(created.claim, `${input.claim}\n\nCounts as yes:\n${input.criteria}`);
  assert.deepEqual(created.outlayer_material.evidence, { kind: 'submitted', items: [{ side: 'yes', url: input.evidenceSourceUrl }] });
  assert.equal(ai.seen.plans.length, 1);
  assert.equal((await createBet(s.db, user, input, options)).terms_hash, created.terms_hash);
  assert.equal(ai.seen.plans.length, 1, 'idempotent retries never plan again');
  assert.equal((await s.db.one('select count(*)::int as n from bilateral_bets')).n, 1);
});
