import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { processMention } from '../src/intake.mjs';
import { refreshEdited } from '../src/notify.mjs';
import { runBetCommands } from '../src/reply-bets.mjs';
import { startStack } from './support/app.mjs';
import { FakeOutLayerNear } from './support/fake-outlayer.mjs';
import { enclaveEnv, fakeNearAi } from './support/enclave.mjs';
import { outlayerTestFetch } from './support/outlayer-fetch.mjs';

// Public X API lookup captured 14 November 2026. Keep actual shortened tokens and entities.
const actual = JSON.parse(readFileSync(new URL('./fixtures/x-public-claim-20261114.json', import.meta.url), 'utf8'));
const sourceUrl = 'https://www.iana.org/domains/reserved';
const expectedClaim = 'Controlled Stated product test: IANA reserved-domains page will list https://example.com at 21:00 UTC on 14 November 2026. Source: ' + sourceUrl;
const now = Date.parse('2026-11-14T19:00:00.000Z');

async function controlledStack(t) {
  t.mock.timers.enable({ apis: ['Date'], now });
  const near = new FakeOutLayerNear({ contract: 'escrow.stated.near', referee: 'jury.stated.near' });
  Object.assign(near.outlayers.get(near.referee).config, { outlayer: 'outlayer.near', secrets_owner: 'sponsor.near' });
  const ai = fakeNearAi({ respond: () => ({ source: 'evidence' }) });
  let stack;
  const fetchImpl = outlayerTestFetch({ ai, near: () => near, xBase: () => stack?.fakeX.base });
  stack = await startStack({ ...enclaveEnv, STATED_ENCLAVE_RULINGS: '',
    STATED_NEAR_NETWORK: 'mainnet', STATED_MAINNET: 'real-funds', STATED_TOKEN_KEY: 'synthetic-mainnet-key'.repeat(3),
    STATED_NEAR_CONTRACT: 'escrow.stated.near', STATED_OUTLAYER_REFEREE: 'jury.stated.near',
    STATED_PLAY: '1', STATED_PLAY_TREASURY: 'stated.near', STATED_PLAY_TREASURY_KEY: 'ed25519:synthetic-treasury',
    STATED_PILOT_X_IDS: '*', STATED_REPLY_LINKS: '1',
  }, { chain: near.chain, fetchImpl });
  t.after(() => stack.close());
  const bot = stack.fakeX.addUser('2119638363397292032', 'statedforecast');
  const author = stack.fakeX.addUser(actual.includes.users[0].id, actual.includes.users[0].username);
  const [prediction, mention] = structuredClone(actual.data);
  stack.fakeX.posts.set(prediction.id, prediction); stack.fakeX.posts.set(mention.id, mention);
  return { stack, near, fetchImpl, bot, author, prediction, mention };
}

test('the controlled IANA X reply retains domain and evidence URL through intake and unsigned bet creation', async t => {
  const { stack, near, fetchImpl, bot, author, prediction, mention } = await controlledStack(t);
  const processed = await processMention(stack.db, stack.config, { mention,
    includes: { users: [author, bot], tweets: [prediction] }, bot: { userId: bot.id, username: bot.username } });
  assert.equal(processed.outcome, 'saved');
  const queued = await stack.db.one('select words from bet_commands where event_id=$1', [mention.id]);
  assert.equal(queued.words, expectedClaim);
  assert.equal(processed.source.text, '', 'private intake still stores no raw or expanded post text');
  assert.equal(processed.statement.span, 'X post ' + prediction.id);
  assert.equal((await stack.db.one("select count(*)::int as n from revisions where after::text like '%example.com%' or after::text like '%iana.org%'")).n, 0);
  const result = await runBetCommands(stack.db, stack.config, near.chain, { botUsername: bot.username, fetchImpl });
  const command = await stack.db.one('select bet_id,status,detail,words from bet_commands where event_id=$1', [mention.id]);
  assert.deepEqual(result, { done: 1, refused: 0, retry: 0, failed: 0 }, command.detail);
  const draft = await stack.db.one('select claim,evidence_source_url,outlayer_material,terms_hash,chain_state from bilateral_bets where id=$1', [command.bet_id]);
  assert(draft.claim.startsWith(expectedClaim + '\n\nCounts as yes:\n'));
  assert.equal(draft.evidence_source_url, sourceUrl);
  assert.deepEqual(draft.outlayer_material.evidence, { kind: 'submitted', items: [{ side: 'yes', url: sourceUrl }] });
  assert.equal(draft.chain_state, null); assert.equal(near.bets.size, 0);
  assert.equal(command.words, null, 'the consumed queue removes its temporary copy');
  assert.equal((await stack.db.one('select count(*)::int as n from bilateral_near_requests')).n, 0);
  assert.equal((await stack.db.one('select count(*)::int as n from play_account_grants')).n, 0);
  const source = await stack.db.one('select src.text,st.span from sources src join statements st on st.source_id=src.id where src.platform_id=$1', [prediction.id]);
  assert.deepEqual(source, { text: '', span: 'X post ' + prediction.id });
});

test('a sentence period after the source entity stays in the claim but outside the evidence URL', async t => {
  const { stack, near, fetchImpl, bot, author, prediction, mention } = await controlledStack(t);
  prediction.text += '.';
  const processed = await processMention(stack.db, stack.config, { mention,
    includes: { users: [author, bot], tweets: [prediction] }, bot: { userId: bot.id, username: bot.username } });
  assert.equal(processed.outcome, 'saved');
  const queued = await stack.db.one('select words from bet_commands where event_id=$1', [mention.id]);
  assert.deepEqual(JSON.parse(queued.words), {
    format: 'x-source-entity-v1', claim: expectedClaim + '.', evidenceSourceUrl: sourceUrl,
  });
  const result = await runBetCommands(stack.db, stack.config, near.chain, { botUsername: bot.username, fetchImpl });
  assert.deepEqual(result, { done: 1, refused: 0, retry: 0, failed: 0 });
  const command = await stack.db.one('select bet_id from bet_commands where event_id=$1', [mention.id]);
  const draft = await stack.db.one('select claim,evidence_source_url from bilateral_bets where id=$1', [command.bet_id]);
  assert(draft.claim.startsWith(expectedClaim + '.\n\nCounts as yes:\n'));
  assert.equal(draft.evidence_source_url, sourceUrl);
});

async function assertRefusedWithoutBet(stack, near, mention, reason) {
  const command = await stack.db.one('select status,detail,words,bet_id from bet_commands where event_id=$1', [mention.id]);
  assert.deepEqual(command, { status: 'refused', detail: reason, words: null, bet_id: null });
  assert.equal((await stack.db.one('select count(*)::int as n from bilateral_bets')).n, 0);
  assert.equal((await stack.db.one('select count(*)::int as n from bilateral_near_requests')).n, 0);
  assert.equal((await stack.db.one('select count(*)::int as n from play_account_grants')).n, 0);
  assert.equal(near.bets.size, 0);
  const reply = await stack.db.one('select body from bot_outbox where dedupe_key=$1', [`refused:${mention.id}`]);
  assert.equal(reply.body, reason === 'claim_too_long'
    ? 'That post is too long for a bet. Make a shorter post, then reply to it with your bet.'
    : 'This bet request could not be read. Reply to the post with your bet again.');
}

test('oversized entity source claims refuse without queuing truncated words or creating a bet', async t => {
  const { stack, near, fetchImpl, bot, author, prediction, mention } = await controlledStack(t);
  prediction.entities.urls[1].expanded_url = 'https://example.com/' + 'a'.repeat(1000);
  prediction.text += '.';
  const processed = await processMention(stack.db, stack.config, { mention,
    includes: { users: [author, bot], tweets: [prediction] }, bot: { userId: bot.id, username: bot.username } });
  assert.equal(processed.outcome, 'saved');
  const queued = await stack.db.one('select detail,words from bet_commands where event_id=$1', [mention.id]);
  assert.deepEqual(queued, { detail: 'claim_too_long', words: null });
  assert.deepEqual(await runBetCommands(stack.db, stack.config, near.chain, { botUsername: bot.username, fetchImpl }),
    { done: 0, refused: 1, retry: 0, failed: 0 });
  await assertRefusedWithoutBet(stack, near, mention, 'claim_too_long');
});

test('a malformed entity source envelope refuses before draft or funding side effects', async t => {
  const { stack, near, fetchImpl, bot, author, prediction, mention } = await controlledStack(t);
  prediction.text += '.';
  const processed = await processMention(stack.db, stack.config, { mention,
    includes: { users: [author, bot], tweets: [prediction] }, bot: { userId: bot.id, username: bot.username } });
  assert.equal(processed.outcome, 'saved');
  await stack.db.query('update bet_commands set words=$2 where event_id=$1',
    [mention.id, '{"format":"x-source-entity-v1","claim":']);
  assert.deepEqual(await runBetCommands(stack.db, stack.config, near.chain, { botUsername: bot.username, fetchImpl }),
    { done: 0, refused: 1, retry: 0, failed: 0 });
  await assertRefusedWithoutBet(stack, near, mention, 'invalid_claim');
});

test('entity enrichment preserves raw source comparison, while real edits retain links without rewriting bet terms', async t => {
  const { stack, near, fetchImpl, bot, author, prediction, mention } = await controlledStack(t);
  const browser = await stack.signIn(author);
  await browser.submit('/setup', { profile: 'public', defaults: 'public' });
  const processed = await processMention(stack.db, stack.config, { mention,
    includes: { users: [author, bot], tweets: [prediction] }, bot: { userId: bot.id, username: bot.username } });
  assert.equal(processed.source.text, prediction.text, 'source text stays in the original API representation');
  assert.equal(processed.statement.span, expectedClaim);
  await runBetCommands(stack.db, stack.config, near.chain, { botUsername: bot.username, fetchImpl });
  const command = await stack.db.one('select bet_id from bet_commands where event_id=$1', [mention.id]);
  const before = await stack.db.one('select claim,terms_hash,outlayer_material from bilateral_bets where id=$1', [command.bet_id]);
  prediction.entities.urls[0].unwound_url = 'https://www.iana.org/help/example-domains';
  const x = { identity: async () => ({ username: bot.username }), posts: async () => ({ data: [prediction], includes: { users: [author] } }) };
  assert.deepEqual(await refreshEdited(stack.db, x, [prediction.id]), []);
  assert.equal((await stack.db.one("select count(*)::int as n from revisions where kind='source_edited'")).n, 0);
  prediction.text = prediction.text.replace('Controlled Stated product test:', 'Updated controlled Stated product test:');
  assert.deepEqual(await refreshEdited(stack.db, x, [prediction.id]), [processed.source.id]);
  const edited = await stack.db.one('select span from statements where id=$1', [processed.statement.id]);
  assert.equal(edited.span, expectedClaim.replace('Controlled Stated product test:', 'Updated controlled Stated product test:'));
  assert.deepEqual(await stack.db.one('select claim,terms_hash,outlayer_material from bilateral_bets where id=$1', [command.bet_id]), before);
});

test('the same entity-bearing prediction from a protected author remains private and retains no words', async t => {
  const { stack, bot, author, prediction, mention } = await controlledStack(t);
  author.protected = true;
  const processed = await processMention(stack.db, stack.config, { mention,
    includes: { users: [author, bot], tweets: [prediction] }, bot: { userId: bot.id, username: bot.username } });
  assert.equal(processed.save.visibility, 'private');
  assert.equal(processed.source.author_protected, true);
  assert.equal(processed.source.text, ''); assert.equal(processed.statement.span, 'X post ' + prediction.id);
  assert.equal((await stack.db.one("select count(*)::int as n from revisions where after::text like '%example.com%' or after::text like '%iana.org%'")).n, 0);
});
