// Live smoke test of enclave rulings against the real NEAR AI Cloud and the real
// Coinbase candles feed. Not part of `npm test` (its glob is server/test/*.test.mjs).
//
//   NEARAI_LIVE_KEY=... node server/test/live/enclave-live.mjs
//   NEARAI_LIVE_MODELS=a,b,c   optional, the jury (and plan) models in order
//   LIVE_DRY=1 node server/test/live/enclave-live.mjs   the same script against the test fakes
//
// Everything else is the test stack: a throwaway Postgres, a fake NEAR chain and a fake X.
// The key is passed to the stack's configuration only and is never printed.
import { startStack } from '../support/app.mjs';
import { FakeNear } from '../support/fake-near.mjs';
import { enclaveEnv, fakeCoinbase, fakeNearAi, testRoots } from '../support/enclave.mjs';
import { setQuoteRootsForTests } from '../../src/attested-signature.mjs';
import { tick } from '../../src/worker.mjs';
import { runBetCommands } from '../../src/reply-bets.mjs';
import { refillTreasury } from '../../src/play.mjs';
import { ruleDue, verifyEnclaveRecord } from '../../src/enclave-ruling.mjs';

const KEY = process.env.NEARAI_LIVE_KEY || '';
const DRY = !KEY && process.env.LIVE_DRY === '1';
if (!KEY && !DRY) {
  console.log('Skipped: set NEARAI_LIVE_KEY for the live run, or LIVE_DRY=1 to run against the fakes.');
  process.exit(0);
}
const MODELS = (process.env.NEARAI_LIVE_MODELS || 'Qwen/Qwen3.8-27B,Qwen/Qwen3.6-35B-A3B-FP8,deepseek-ai/DeepSeek-V4.1-Flash-1017')
  .split(',').map((m) => m.trim()).filter(Boolean);
// The support module installs its test root on import. A live run trusts only the
// pinned Intel root, so it is put back; a dry run keeps the test root for its fake quotes.
if (!DRY) setQuoteRootsForTests(null);
const scrub = (text) => (KEY ? String(text).split(KEY).join('[key]') : String(text));
const NEXT = new Date().getUTCFullYear() + 1;

const CASES = [
  { name: 'NEAR price', claim: 'NEAR will be below $4 at 19:10 UTC on 11 November 2026',
    madeAt: '2026-11-11T18:55:00Z', deadline: '2026-11-11T19:10:00Z' },
  // madeAt is not given for this claim; the script uses 1 October 2026.
  { name: 'Bank of Canada', claim: 'The Bank of Canada will cut its policy rate before 1 November 2026',
    madeAt: '2026-10-01T00:00:00Z', deadline: '2026-10-31T23:59:59Z' },
];

// Fakes for LIVE_DRY: plausible plans and verdicts so the whole path runs.
const ai = fakeNearAi({ respond: ({ kind, input }) => {
  const price = /NEAR/.test(input.claim);
  if (kind === 'plan') {
    return price ? { source: 'coinbase-candles', product: 'NEAR-USD', kind: 'moment', at: '2026-11-11T19:10:00Z' }
      : { source: 'evidence' };
  }
  return price ? { outcome: 'yes', confidence: 0.97, reason: 'NEAR-USD closed near 2.50 in the 19:10 UTC minute, below $4.' }
    : { outcome: 'no', confidence: 0.85, reason: 'No credible evidence of a cut before the deadline was supplied.' };
} });
const coin = fakeCoinbase({ price: () => 2.5 });

const near = new FakeNear();
const s = await startStack({
  STATED_NEAR_CONTRACT: 'escrow.testnet', STATED_PLAY: '1', STATED_PLAY_AUTOPROVISION: '1', STATED_PLAY_SETTLE_DELAY_SECONDS: '0',
  ...enclaveEnv,
  NEARAI_RULING_MODELS: MODELS.join(','),
  NEARAI_MODEL: MODELS[0],
  ...(DRY ? {} : { NEARAI_API_KEY: KEY, NEARAI_BASE_URL: 'https://cloud-api.near.ai/v1' }),
  // Two new play accounts per case.
  STATED_PLAY_NEW_ACCOUNTS_PER_HOUR: '100',
}, { fetchImpl: near.fetchImpl, chain: near.chain });
if (DRY) s.config.nearai.quoteRoots = testRoots;

// The run fails (exit 1) unless both posts are ruled from a record that verifies.
let failed = false;
try {
  await s.connectBot(s.fakeX.addUser('500', 'statedbot'));
  const author = s.fakeX.addUser('7001', 'author');
  const run = () => runBetCommands(s.db, s.config, near.chain, { fetchImpl: near.fetchImpl, botUsername: 'statedbot' });
  const botPosts = () => [...s.fakeX.posts.values()].filter((p) => p.author_id === '500');

  // An accepted reply Bet through the real flow, on a placeholder post with a future date
  // (an offer needs one), then given the case's claim, publication time and deadline.
  async function acceptedBet(c, i) {
    const maker = s.fakeX.addUser(String(7100 + i), `maker${i}`);
    const taker = s.fakeX.addUser(String(7200 + i), `taker${i}`);
    await s.db.query(`delete from kv where key = 'play_treasury_refill_at'`);
    await refillTreasury(s.db, s.config, near.chain);
    const post = s.fakeX.post(author.id, `Placeholder claim ${i} comes true before March 1, ${NEXT}.`);
    const cmd = s.fakeX.post(maker.id, '@statedbot bet 0.1 no', { replyTo: post.id });
    await tick(s.db, s.config, s.x);
    if ((await run()).done !== 1) throw new Error(`${c.name}: the offer was not made`);
    await tick(s.db, s.config, s.x);
    const offer = botPosts().find((p) => (p.referenced_tweets || []).some((r) => r.id === cmd.id));
    s.fakeX.post(taker.id, '@statedbot take', { replyTo: offer.id });
    await tick(s.db, s.config, s.x);
    if ((await run()).done !== 1) throw new Error(`${c.name}: the offer was not taken`);
    const { bet_id: betId } = await s.db.one('select bet_id from bet_commands where event_id = $1', [cmd.id]);
    const st = await s.db.one(`select st.id, st.source_id from statements st join sources src on src.id = st.source_id
      where src.platform_id = $1`, [post.id]);
    // The engine reads the Bet's own funded deadline, so it moves in the database and on the fake chain alike.
    const at = new Date(c.deadline);
    const acceptBy = new Date(at.getTime() - 3600_000);
    const ns = (date) => (BigInt(date.getTime()) * 1000000n).toString();
    await s.db.query(`update bilateral_bets set claim = $2, accept_by = $3, resolve_at = $4,
      chain_state = chain_state || jsonb_build_object('accept_by_ns', $5::text, 'resolve_at_ns', $6::text) where id = $1`,
    [betId, c.claim, acceptBy, at, ns(acceptBy), ns(at)]);
    Object.assign(near.bets.get(betId), { accept_by_ns: ns(acceptBy), resolve_at_ns: ns(at) });
    await s.db.query('update statements set deadline_at = $2 where id = $1', [st.id, c.deadline]);
    await s.db.query('update sources set published_at = $2 where id = $1', [st.source_id, c.madeAt]);
    return { ...c, betId, statementId: st.id };
  }

  const bets = [];
  for (const [i, c] of CASES.entries()) bets.push(await acceptedBet(c, i));
  console.log(`${DRY ? 'Dry run against the fakes' : 'Live run against NEAR AI Cloud and Coinbase'}; models: ${MODELS.join(', ')}`);

  // Each pass moves the clock six minutes on, past the five-minute spacing between attempts,
  // so an undecided or failed attempt is retried on the next pass.
  const started = Date.now();
  const ruledAt = new Map();
  for (let pass = 0; pass < 6; pass += 1) {
    const offset = pass * 6 * 60_000;
    const passStart = Date.now();
    const result = await ruleDue(s.db, s.config, {
      now: () => new Date(Date.now() + offset),
      onError: (where, error) => console.log(`  pass ${pass + 1} ${where}: ${scrub(error?.message || error)}`),
      ...(DRY ? { fetchImpl: ai.fetchImpl, fetchEvidence: coin.fetchEvidence } : {}),
    });
    console.log(`pass ${pass + 1} (${((Date.now() - passStart) / 1000).toFixed(1)} s): ${JSON.stringify(result)}`);
    for (const bet of bets) {
      const st = await s.db.one('select status from statements where id = $1', [bet.statementId]);
      if (st.status !== 'open' && !ruledAt.has(bet.betId)) ruledAt.set(bet.betId, (Date.now() - started) / 1000);
    }
    if (ruledAt.size === bets.length) break;
  }

  for (const bet of bets) {
    console.log(`\n${bet.name}: ${bet.claim}`);
    console.log(`  made ${bet.madeAt}, deadline ${bet.deadline}`);
    const plan = await s.db.one('select source, closes_at, record from enclave_plans where statement_id = $1', [bet.statementId]);
    if (!plan) console.log('  plan: none stored');
    else {
      const p = plan.record.parsed;
      console.log(`  plan by ${plan.record.model}: ${p.source}${p.source === 'coinbase-candles'
        ? ` ${p.product} ${p.kind} ${p.start} to ${p.end}` : `, closes ${new Date(plan.closes_at).toISOString()}`}`);
      console.log(`  plan as the model gave it: ${scrub(JSON.stringify(plan.record.verdict))}`);
    }
    const event = await s.db.one(`select detail from bilateral_bet_events where bet_id = $1 and kind = 'enclave_ruling' order by id limit 1`, [bet.betId]);
    if (!event) { console.log('  ruling: none stored'); failed = true; }
    else {
      const record = event.detail;
      for (const v of record.verdicts) console.log(`  ${v.model}: ${v.parsed.outcome} at ${v.parsed.confidence}: ${scrub(v.parsed.reason)}`);
      console.log(`  jury outcome: ${record.outcome} (threshold ${record.minConfidence})`);
      if (record.evidence.kind === 'coinbase-candles') {
        for (const part of JSON.parse(record.evidence.text).segments) {
          console.log(`  evidence: ${part.received} of ${part.expected} candles every ${part.granularity} s from ${part.start} to ${part.end}`);
        }
        for (const url of record.evidence.urls) console.log(`    ${url}`);
      }
      else console.log(`  evidence: ${record.evidence.items.length} submitted items`);
      try { verifyEnclaveRecord(record); console.log('  verifyEnclaveRecord: passed'); }
      catch (error) { console.log(`  verifyEnclaveRecord: FAILED: ${error.message}`); failed = true; }
    }
    const tries = await s.db.many('select reason from enclave_ruling_attempts where statement_id = $1 order by id', [bet.statementId]);
    console.log(`  attempts: ${tries.map((t) => t.reason).join(', ') || 'none'}`);
    const st = await s.db.one('select status, resolution_note, resolution_url, outcome_at from statements where id = $1', [bet.statementId]);
    console.log(`  Result: ${st.status}${st.resolution_note ? `; note: ${scrub(st.resolution_note)}` : ''}${st.resolution_url ? `; url: ${st.resolution_url}` : ''}`);
    console.log(`  elapsed: ${ruledAt.has(bet.betId) ? `${ruledAt.get(bet.betId).toFixed(1)} s` : 'not ruled'}`);
    if (!ruledAt.has(bet.betId)) failed = true;
  }
  // LIVE_KEEP=1 leaves the stack serving, so scripts/verify-enclave-ruling.mjs can be pointed at a real record.
  if (process.env.LIVE_KEEP === '1') {
    console.log(`KEEP ${s.config.baseUrl} ${bets.map((bet) => bet.betId).join(' ')}`);
    await new Promise((resolve) => { process.once('SIGINT', resolve); process.once('SIGTERM', resolve); });
  }
} finally {
  await s.close();
}
console.log(failed ? '\nFAILED: a post was not ruled from a verified record.' : '\nPassed: both posts ruled from verified records.');
process.exitCode = failed ? 1 : 0;
