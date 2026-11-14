import assert from 'node:assert/strict';
import { test } from 'node:test';
import { kvSet } from '../src/db.mjs';
import { pollMentions } from '../src/worker.mjs';
import { botClient } from '../src/xapi.mjs';
import { startStack } from './support/app.mjs';

test('a post omitted by mentions reaches normal intake through one bounded search and replays safely', async t => {
  const stack = await startStack({ STATED_PLAY: '1', STATED_PILOT_X_IDS: '*',
    STATED_NEAR_NETWORK: 'mainnet', STATED_MAINNET: 'real-funds',
    STATED_TOKEN_KEY: 'synthetic-discovery-key'.repeat(3),
    STATED_NEAR_CONTRACT: 'escrow.stated.near', STATED_OUTLAYER_REFEREE: 'jury.stated.near',
    STATED_PLAY_TREASURY: 'stated.near', STATED_PLAY_TREASURY_KEY: 'ed25519:synthetic-treasury' });
  t.after(() => stack.close());
  const bot = stack.fakeX.addUser('500', 'statedbot');
  const owner = stack.fakeX.addUser('100', 'alice');
  await stack.connectBot(bot);
  const due = new Date(Date.now() + 3_600_000);
  const deadline = `${due.getUTCDate()} ${due.toLocaleString('en', { month: 'long', timeZone: 'UTC' })} ${due.getUTCFullYear()} at ${due.toISOString().slice(11, 16)} UTC`;
  const post = stack.fakeX.post(owner.id,
    `@statedbot IANA lists example.com by ${deadline}, 0.1 NEAR on yes Source: https://www.iana.org/domains/reserved`);
  await kvSet(stack.db, 'mentions_since_id', '99');
  await kvSet(stack.db, 'mentions_initialized', new Date().toISOString());
  let searches = 0;
  const x = botClient(stack.db, stack.config, async (input, options) => {
    const url = new URL(input);
    if (url.pathname === '/2/users/500/mentions') return Response.json({ data: [], meta: { result_count: 0 } });
    if (url.pathname === '/2/tweets/search/recent') {
      searches += 1;
      assert.equal(url.searchParams.get('query'), '@statedbot -from:statedbot -is:retweet');
      assert.equal(url.searchParams.get('max_results'), '10');
      assert.equal(url.searchParams.get('since_id'), '99');
      assert.match(url.searchParams.get('tweet.fields'), /entities/);
      assert.match(url.searchParams.get('expansions'), /referenced_tweets.id/);
      assert(options.signal instanceof AbortSignal);
      return Response.json({ data: [post], includes: { users: [owner, bot] }, meta: { result_count: 1 } });
    }
    return fetch(input, options);
  });
  const first = await pollMentions(stack.db, stack.config, x);
  assert.deepEqual(first.processed, []);
  assert.deepEqual(first.discovery, { status: 'ok', processed: 1, hasMore: false });
  const event = await stack.db.one('select outcome from mention_events where event_id=$1', [post.id]);
  assert.equal(event.outcome, 'saved');
  const command = await stack.db.one('select words,status from bet_commands where event_id=$1', [post.id]);
  assert.equal(command.status, 'queued');
  assert.match(JSON.parse(command.words).claim, /IANA lists example.com/);
  const second = await pollMentions(stack.db, stack.config, x);
  assert.equal(second.discovery.status, 'throttled');
  assert.equal(searches, 1);
  assert.equal((await stack.db.one('select count(*)::int as n from bet_commands where event_id=$1', [post.id])).n, 1);
  assert.equal((await stack.db.one('select count(*)::int as n from bilateral_near_requests')).n, 0);
  assert.equal((await stack.db.one('select count(*)::int as n from play_account_grants')).n, 0);
});
