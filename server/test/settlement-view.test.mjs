import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { juryLogos, jurySentence, settlementSentence } from '../src/settlement-view.mjs';

// Copy the public signed corpus; mutate projections, never its signed material.
const record = JSON.parse(readFileSync(new URL('../../evidence/enclave-ruling-3668aa04.json', import.meta.url))).record;
const payout = JSON.parse(readFileSync(new URL('../../evidence/hosted-court-payout-testnet-20261112.json', import.meta.url)));
const base = { id: record.material.bets[0].id, claim: record.material.claim,
  status: 'settled', settled_by: 'referee', outcome: record.outcome,
  referee_wallet: payout.court.dao, settlement_transaction_hash: payout.transactions.approve,
  settled_at: new Date(Number(BigInt(payout.court.submissionTimeNs) / 1000000n) + 600_000).toISOString(),
  enclave: { mode: record.mode, outcome: record.outcome, minConfidence: record.minConfidence,
    models: record.verdicts.map(v => v.model), verdicts: record.verdicts.map(v => ({ ...v.parsed })) },
};
const config = { court: { dao: payout.court.dao }, play: { settleDelaySeconds: Number(BigInt(payout.court.windowNs) / 1000000000n) } };
const detail = { dao: payout.court.dao, outcome: record.outcome,
  filedAt: new Date(Number(BigInt(payout.court.submissionTimeNs) / 1000000n)).toISOString() };
const db = { one: async () => ({ detail }) };

test('jury summary follows the saved verdict count, confidence and outcome', () => {
  assert.equal(jurySentence(base), 'All three models said yes.');
  const two = structuredClone(base); two.enclave.verdicts.pop();
  assert.equal(jurySentence(two), 'All 2 models said yes.');
  for (const mutate of [
    bet => { bet.enclave.mode = 'review'; },
    bet => { bet.enclave.verdicts[0].outcome = 'no'; },
    bet => { bet.enclave.verdicts[0].confidence = 0.2; },
    bet => { bet.enclave.outcome = 'unclear'; },
  ]) {
    const changed = structuredClone(base); mutate(changed);
    assert.equal(jurySentence(changed), '');
  }
  const logos = String(juryLogos(base.enclave.models));
  assert.equal((logos.match(/model-logo/g) || []).length, record.verdicts.length);
  assert.match(logos, /Qwen logo/); assert.match(logos, /DeepSeek logo/); assert.match(logos, /Z.ai logo/);
});

test('Court waiting and payment require matching filing, elapsed window and verified withdrawal', async () => {
  assert.equal(await settlementSentence(db, config, base), 'All three models said yes. Stated Court let it stand for ten minutes, then settled it.');
  assert.equal(await settlementSentence(db, config, { ...base, payout_completed: true }), 'All three models said yes. Stated Court let it stand for ten minutes, then it paid.');
  for (const changed of [
    { ...base, status: 'accepted' },
    { ...base, settled_by: 'agreement' },
    { ...base, settled_at: detail.filedAt },
    { ...base, referee_wallet: 'another.testnet' },
    { ...base, settlement_transaction_hash: null },
  ]) assert.equal(await settlementSentence(db, config, changed), 'All three models said yes.');
  for (const filed of [null, { ...detail, dao: 'another.testnet' }, { ...detail, outcome: 'no' }, { ...detail, filedAt: 'invalid' }]) {
    assert.equal(await settlementSentence({ one: async () => filed && ({ detail: filed }) }, config, base), 'All three models said yes.');
  }
  assert.equal(await settlementSentence(db, config, { ...base, outcome: 'no', payout_completed: true }), 'All three models said yes. A reviewer corrected the enclave’s ruling.');
  assert.equal(record.material.claim, base.claim);
});
