import assert from 'node:assert/strict';
import { test } from 'node:test';
import { processMention } from '../src/intake.mjs';
import { runBetCommands } from '../src/reply-bets.mjs';
import { startStack } from './support/app.mjs';
import { FakeOutLayerNear } from './support/fake-outlayer.mjs';
import { enclaveEnv, fakeNearAi } from './support/enclave.mjs';
import { outlayerTestFetch } from './support/outlayer-fetch.mjs';

test('a standalone wager with a labeled article source creates a wallet review draft', async t => {
  const near = new FakeOutLayerNear({ contract: 'escrow.stated.near', referee: 'jury.stated.near' });
  Object.assign(near.outlayers.get(near.referee).config, { outlayer: 'outlayer.near', secrets_owner: 'sponsor.near' });
  const ai = fakeNearAi({ respond: () => ({ source: 'evidence' }) });
  let stack;
  const fetchImpl = outlayerTestFetch({ ai, near: () => near, xBase: () => stack?.fakeX.base });
  stack = await startStack({
    ...enclaveEnv, STATED_ENCLAVE_RULINGS: '',
    STATED_NEAR_NETWORK: 'mainnet', STATED_MAINNET: 'real-funds', STATED_TOKEN_KEY: 'synthetic-mainnet-key'.repeat(3),
    STATED_NEAR_CONTRACT: 'escrow.stated.near', STATED_OUTLAYER_REFEREE: 'jury.stated.near',
    STATED_PLAY: '1', STATED_PLAY_TREASURY: 'stated.near', STATED_PLAY_TREASURY_KEY: 'ed25519:synthetic-treasury',
    STATED_PILOT_X_IDS: '*', STATED_REPLY_LINKS: '1',
  }, { chain: near.chain, fetchImpl });
  t.after(() => stack.close());
  const bot = stack.fakeX.addUser('500', 'statedforecast');
  const author = stack.fakeX.addUser('7001', 'wagerauthor');
  const createdAt = new Date();
  createdAt.setUTCDate(createdAt.getUTCDate() + 1);
  createdAt.setUTCHours(18, 0, 0, 0);
  const claim = 'FAA lifts the nationwide ground stop by midnight Eastern tonight';
  const evidenceUrl = 'https://www.fly.faa.gov/adv/advADB.jsp';
  const mention = stack.fakeX.post(author.id, `@statedforecast ${claim}, 0.25 NEAR on yes. Source: https://t.co/evidence`, { at: createdAt });
  mention.entities.urls[0].expanded_url = evidenceUrl;
  const processed = await processMention(stack.db, stack.config, {
    mention, includes: { users: [author, bot] }, bot: { userId: bot.id, username: bot.username },
  });
  assert.equal(processed.outcome, 'saved');
  assert.equal(processed.event.reply_text, null, 'the intake waits for the draft worker to provide the review link');
  assert.equal((await stack.db.one('select count(*)::int as n from url_intakes')).n, 0, 'the evidence source bypasses article tracking');
  const queued = await stack.db.one('select * from bet_commands where event_id = $1', [mention.id]);
  assert.equal(queued.status, 'queued');
  const structured = JSON.parse(queued.words);
  assert.equal(structured.claim, claim);
  assert.equal(structured.evidenceSourceUrl, evidenceUrl);
  assert.equal(structured.creatorSide, 'yes');
  assert.equal(structured.stakeNear, '0.25');
  const midnight = Object.fromEntries(new Intl.DateTimeFormat('en-CA', { timeZone: 'America/New_York',
    year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', hourCycle: 'h23',
  }).formatToParts(new Date(structured.resolveAt)).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
  const nextDay = new Date(createdAt.getTime() + 86400000).toISOString().slice(0, 10);
  assert.equal(`${midnight.year}-${midnight.month}-${midnight.day}`, nextDay);
  assert.equal(midnight.hour, '00');
  const result = await runBetCommands(stack.db, stack.config, near.chain, { botUsername: bot.username, fetchImpl });
  const done = await stack.db.one('select bet_id, status, detail from bet_commands where event_id = $1', [mention.id]);
  assert.deepEqual(result, { done: 1, refused: 0, retry: 0, failed: 0 }, done.detail);
  assert.equal(done.status, 'done');
  const draft = await stack.db.one('select claim, evidence_source_url, status, chain_state, outlayer_material from bilateral_bets where id = $1', [done.bet_id]);
  assert.equal(draft.claim, `${claim}\n\nCounts as yes:\n${structured.criteria}`);
  assert.equal(draft.evidence_source_url, evidenceUrl);
  assert.equal(draft.status, 'offered');
  assert.equal(draft.chain_state, null);
  assert.deepEqual(draft.outlayer_material.evidence, { kind: 'submitted', items: [{ side: 'yes', url: evidenceUrl }] });
  assert.ok(ai.seen.plans.length > 0, 'the normal attested evidence planner completed');
  const reply = await stack.db.one('select body from bot_outbox where in_reply_to = $1', [mention.id]);
  assert.equal(reply.body, `Your bet draft is ready for wallet review: ${stack.base}/bets/${done.bet_id}?review=1`);
  assert.equal((await stack.db.one('select count(*)::int as n from bilateral_near_requests')).n, 0);
  assert.equal(near.bets.size, 0, 'creating a draft leaves wallet funding for the proposer');
});
