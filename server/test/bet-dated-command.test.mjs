// Focused coverage for dated reply Bets and the public X composer.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startStack } from './support/app.mjs';
import { FakeNear } from './support/fake-near.mjs';
import { processMention } from '../src/intake.mjs';
import { betReplies, parseBetCommand, runBetCommands } from '../src/reply-bets.mjs';
import { betCommandText, replyComposerUrl } from '../src/bet-start.mjs';

const DAY = 86400000;
const fixedNow = new Date('2026-11-11T12:00:00.000Z');
const endOfDay = (date) => `${date}T23:59:59.000Z`;
const ymd = (date) => date.toISOString().slice(0, 10);
const commandDate = (date) => `${date.getUTCDate()} ${date.toLocaleString('en', { month: 'short', timeZone: 'UTC' })} ${date.getUTCFullYear()}`;
let stack;
let near;
let bot;
let replier;
let sequence = 0;

before(async () => {
  near = new FakeNear();
  stack = await startStack({
    STATED_NEAR_CONTRACT: 'escrow.testnet',
    STATED_PLAY: '1',
    STATED_PLAY_AUTOPROVISION: '1',
    STATED_PLAY_SETTLE_DELAY_SECONDS: '0',
  }, { fetchImpl: near.fetchImpl, chain: near.chain });
  bot = stack.fakeX.addUser('500', 'statedbot');
  replier = stack.fakeX.addUser('7001', 'lena');
  await stack.connectBot(bot);
});

after(async () => { await stack?.close(); });

const saveTerms = async (post) => stack.db.one(`
  select st.id, st.deadline_text, st.proposed_deadline_at, st.deadline_at, s.capture
    from sources src join statements st on st.source_id = src.id
    join saves s on s.statement_id = st.id
   where src.platform_id = $1 and s.owner_x_user_id = $2`, [post.id, replier.id]);

async function offer(command, sourceText, { sourceDate = null, at = new Date(), config = stack.config } = {}) {
  sequence += 1;
  const author = stack.fakeX.addUser(String(82000 + sequence), `author${sequence}`);
  const post = stack.fakeX.post(author.id, sourceText, { at: sourceDate || at });
  const mention = stack.fakeX.post(replier.id, `@statedbot ${command}`, { replyTo: post.id, at });
  const result = await processMention(stack.db, config, {
    mention,
    includes: { tweets: [post], users: [author, replier, bot] },
    bot: { userId: bot.id, username: bot.username },
  });
  assert.equal(result.outcome, 'saved');
  const queued = await stack.db.one('select * from bet_commands where event_id = $1', [mention.id]);
  assert.ok(queued, 'mention intake queued the offer');
  return { post, mention, queued };
}

const run = () => runBetCommands(stack.db, stack.config, near.chain, {
  fetchImpl: near.fetchImpl, botUsername: bot.username,
});

test('parser handles exact date forms, keeps legacy shapes, and rejects prose or invalid tails', () => {
  assert.deepEqual(parseBetCommand('@statedbot bet 0.1 yes', { now: fixedNow }), {
    kind: 'bet', side: 'yes', stake: '0.1',
  });
  assert.deepEqual(parseBetCommand('@statedbot bet 0.1 yes by 30 nov', { now: fixedNow }), {
    kind: 'bet', side: 'yes', stake: '0.1', deadline: '2026-11-30T23:59:59.000Z',
  });
  assert.deepEqual(parseBetCommand('@statedbot bet 0.25 yes before 1 dec 2026', { now: fixedNow }), {
    kind: 'bet', side: 'yes', stake: '0.25', deadline: '2026-11-30T23:59:59.000Z',
  });
  assert.deepEqual(parseBetCommand('@statedbot bet no by friday', { now: fixedNow }), {
    kind: 'bet', side: 'no', stake: '0.1', deadline: '2026-11-13T23:59:59.000Z',
  });
  assert.deepEqual(parseBetCommand('@statedbot bet yes by tomorrow', { now: fixedNow }), {
    kind: 'bet', side: 'yes', stake: '0.1', deadline: '2026-11-12T23:59:59.000Z',
  });
  for (const text of ['@statedbot bet 0.25 yes', '@one @statedbot Bet 0.25 YES!', 'bet yes 0.25 near', 'bet 0.25 test near yes']) {
    assert.deepEqual(parseBetCommand(text, { now: fixedNow }), { kind: 'bet', side: 'yes', stake: '0.25' });
  }
  assert.deepEqual(parseBetCommand('@statedbot bet no', { defaultStake: '0.25', now: fixedNow }), {
    kind: 'bet', side: 'no', stake: '0.25',
  });
  assert.deepEqual(parseBetCommand('@statedbot take', { now: fixedNow }), { kind: 'take' });
  assert.equal(parseBetCommand('@statedbot bet yes by 31 feb', { now: fixedNow }), null);
  assert.equal(parseBetCommand('@statedbot bet yes by 30 nov and maybe later', { now: fixedNow }), null);
  assert.equal(parseBetCommand('@statedbot bet no one saw this coming by friday', { now: fixedNow }), null);
  assert.equal(parseBetCommand('@statedbot bet no way this ships', { now: fixedNow }), null);
  assert.equal(parseBetCommand('@statedbot bet 5 no', { now: fixedNow }).error, 'stake');
  assert.deepEqual(parseBetCommand('@statedbot yes https://example.org/evidence', { now: fixedNow }), {
    kind: 'evidence', side: 'yes', url: 'https://example.org/evidence',
  });
});

test('undated casual source takes a reply date before saving and funds its Bet', async () => {
  const now = new Date(Date.now());
  const due = new Date(now.getTime() + 2 * DAY);
  const phrase = `by ${commandDate(due)}`;
  const { post, mention } = await offer(`bet 0.1 yes ${phrase}`, 'bet you 2 bucks that the CEO has another scandal', { at: now });
  const terms = await saveTerms(post);
  assert.equal(terms.deadline_text, null, 'reply-provided date does not rewrite source wording');
  assert.equal(new Date(terms.proposed_deadline_at).toISOString(), endOfDay(ymd(due)));
  assert.equal(terms.capture, 'prospective');
  const saved = await stack.db.one('select relation, visibility from saves where origin_event_id = $1', [mention.id]);
  assert.deepEqual(saved, { relation: 'following', visibility: 'private' });
  const revision = await stack.db.one(`select after from revisions where statement_id = $1 and kind = 'captured'`, [terms.id]);
  assert.equal(new Date(revision.after.proposedDeadlineAt).toISOString(), endOfDay(ymd(due)));
  assert.deepEqual(await run(), { done: 1, refused: 0, retry: 0, failed: 0 });
  const done = await stack.db.one('select * from bet_commands where event_id = $1', [mention.id]);
  assert.equal(done.status, 'done');
  assert.equal(done.words, null);
  assert.ok(done.bet_id);
  const chainBet = near.bets.get(done.bet_id);
  assert.ok(chainBet, 'the fake NEAR chain has the funded offer');
  assert.equal(chainBet.status, 'offered');
  assert.equal(chainBet.creator_side, 'yes');
  assert.equal(chainBet.stake, BigInt('100000000000000000000000'));
  assert.equal(new Date((await stack.db.one('select resolve_at from bilateral_bets where id = $1', [done.bet_id])).resolve_at).toISOString(), endOfDay(ymd(due)));
});

test('tomorrow is relative to the reply rather than an older source post', async () => {
  const now = new Date();
  const { post, mention } = await offer('bet yes by tomorrow', 'The CEO faces another scandal.', {
    at: now, sourceDate: new Date(now.getTime() - 7 * DAY),
  });
  const deadline = endOfDay(ymd(new Date(now.getTime() + DAY)));
  assert.equal(new Date((await saveTerms(post)).proposed_deadline_at).toISOString(), deadline);
  assert.deepEqual(await run(), { done: 1, refused: 0, retry: 0, failed: 0 });
  const command = await stack.db.one('select bet_id from bet_commands where event_id = $1', [mention.id]);
  assert.equal(new Date((await stack.db.one('select resolve_at from bilateral_bets where id = $1', [command.bet_id])).resolve_at).toISOString(), deadline);
});

test('source date wins over a later reply date and the worker funds at the source deadline', async () => {
  const now = new Date(Date.now());
  const sourceDue = new Date(now.getTime() + 3 * DAY);
  const later = new Date(now.getTime() + 4 * DAY);
  const sourcePhrase = `The bridge opens to traffic by ${commandDate(sourceDue)}.`;
  const { post, mention } = await offer(`bet 0.1 no by ${commandDate(later)}`, sourcePhrase, { at: now });
  const terms = await saveTerms(post);
  assert.equal(new Date(terms.proposed_deadline_at).toISOString(), endOfDay(ymd(sourceDue)));
  assert.deepEqual(await run(), { done: 1, refused: 0, retry: 0, failed: 0 });
  const done = await stack.db.one('select * from bet_commands where event_id = $1', [mention.id]);
  assert.equal(done.status, 'done');
  const bet = await stack.db.one('select resolve_at from bilateral_bets where id = $1', [done.bet_id]);
  assert.equal(new Date(bet.resolve_at).toISOString(), endOfDay(ymd(sourceDue)));
  assert.equal(near.bets.get(done.bet_id).status, 'offered');
});

test('worker refuses missing, nine-minute, and 366-day deadlines with the matching reason', async () => {
  const now = new Date();
  const soon = new Date(now.getTime() + 9 * 60000);
  const cases = [
    { command: 'bet 0.1 yes', source: 'A casual post with no deadline.', reason: 'no_date' },
    { command: `bet 0.1 yes by ${commandDate(soon)} at ${String(soon.getUTCHours()).padStart(2, '0')}:${String(soon.getUTCMinutes()).padStart(2, '0')} UTC`, source: 'A casual post with no deadline.', reason: 'too_soon' },
    { command: `bet 0.1 yes by ${commandDate(new Date(now.getTime() + 366 * DAY))}`, source: 'A casual post with no deadline.', reason: 'too_far' },
  ];
  const depositsBefore = near.sent.filter((request) => request.method === 'create_bet').length;
  for (const item of cases) {
    const { post, mention } = await offer(item.command, item.source, { at: now });
    const before = await saveTerms(post);
    assert.equal(before.proposed_deadline_at, null, 'a refused date must never be written during intake');
    assert.equal(before.deadline_at, null);
    const result = await run();
    assert.deepEqual(result, { done: 0, refused: 1, retry: 0, failed: 0 });
    const command = await stack.db.one('select status, detail from bet_commands where event_id = $1', [mention.id]);
    assert.equal(command.status, 'refused');
    assert.equal(command.detail, item.reason);
    const reply = await stack.db.one('select body from bot_outbox where in_reply_to = $1', [mention.id]);
    assert.equal(reply.body, betReplies.refused(item.reason));
    assert.deepEqual(await saveTerms(post), before, 'worker refusal leaves the statement terms unchanged');
  }
  assert.equal(near.sent.filter((request) => request.method === 'create_bet').length, depositsBefore);
  assert.equal(betReplies.refused('no_date'), 'Add a date to make it a bet, like: bet 0.1 yes by 30 Nov.');
});

test('a sender outside the pilot cannot set a post date, and a later allowed offer can', async () => {
  const config = { ...stack.config, near: { ...stack.config.near, real: true },
    play: { ...stack.config.play, pilotXIds: [] } };
  const due = new Date(Date.now() + 2 * DAY);
  const command = `bet 0.1 yes by ${commandDate(due)}`;
  const { post, mention } = await offer(command, 'The company will announce its decision.', { config });
  const before = await saveTerms(post);
  assert.equal(before.proposed_deadline_at, null);
  assert.equal(before.deadline_at, null);
  assert.deepEqual(await runBetCommands(stack.db, config, near.chain, { fetchImpl: near.fetchImpl }),
    { done: 0, refused: 1, retry: 0, failed: 0 });
  assert.equal((await stack.db.one('select detail from bet_commands where event_id=$1', [mention.id])).detail, 'pilot');
  assert.deepEqual(await saveTerms(post), before);

  const retry = stack.fakeX.post(replier.id, `@statedbot ${command}`, { replyTo: post.id });
  await processMention(stack.db, stack.config, { mention: retry, includes: { tweets: [post], users: [replier, bot] },
    bot: { userId: bot.id, username: bot.username } });
  assert.equal(new Date((await saveTerms(post)).proposed_deadline_at).toISOString(), endOfDay(ymd(due)));
  assert.deepEqual(await run(), { done: 1, refused: 0, retry: 0, failed: 0 });
});

test('composer helper includes dates in real and simulated reply commands', () => {
  const postId = '1234567890123456789';
  const date = '2026-11-30';
  for (const stake of ['0.1', '0.25', '0.5', '1']) {
    for (const side of ['yes', 'no']) {
      assert.deepEqual(parseBetCommand(betCommandText('statedbot', stake, side), { now: fixedNow }), {
        kind: 'bet', side, stake,
      });
      const command = betCommandText('statedbot', stake, side, date);
      assert.match(command, / by 30 Nov 2026$/);
      assert.deepEqual(parseBetCommand(command, { now: fixedNow }), {
        kind: 'bet', side, stake, deadline: '2026-11-30T23:59:59.000Z',
      });
      const url = new URL(replyComposerUrl({ x: {} }, 'statedbot', postId, stake, side, date));
      assert.equal(url.searchParams.get('in_reply_to'), postId);
      assert.equal(url.searchParams.get('text'), command);
      assert.equal(url.searchParams.get('date'), null);
      const simulated = new URL(replyComposerUrl({ x: { simulatedOrigin: 'http://127.0.0.1:1234' } }, 'statedbot', postId, stake, side, date));
      assert.equal(simulated.searchParams.get('c'), postId);
      assert.equal(simulated.searchParams.get('say'), command.replace(/^@\w+ /, ''));
    }
  }
  assert.equal(betCommandText('statedbot', '0.1', 'yes'), '@statedbot bet 0.1 yes');
  assert.match(betCommandText('statedbot', '0.1', 'yes', new Date('2026-11-30T00:00:00Z')), /by 30 Nov 2026$/);
});

test('public date composer validates missing and impossible dates, then redirects with date in command', async () => {
  const postId = '1234567890123456789';
  const link = encodeURIComponent(`https://x.com/someone/status/${postId}`);
  const page = await stack.browser().get(`/bets/new?link=${link}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /type="date"[^>]*name="date"(?![^>]*required)/);
  assert.match(page.text, /name="datePreset" value="month" checked/);
  assert.match(page.text, /role="radiogroup" aria-label="Deadline"/);
  const min = page.text.match(/\bmin="(\d{4}-\d{2}-\d{2})"/)?.[1];
  const max = page.text.match(/\bmax="(\d{4}-\d{2}-\d{2})"/)?.[1];
  assert.equal(min, ymd(new Date(Date.now() + DAY)));
  assert.ok(new Date(endOfDay(max)).getTime() <= Date.now() + 365 * DAY);
  assert.ok(new Date(endOfDay(max)).getTime() > Date.now() + 363 * DAY);
  assert.match(page.text, /class="date-month"/);
  assert.match(page.text, /class="date-custom"/);
  assert.equal((page.text.match(/class="(?:pill solid big|primary big)(?: [a-z]+)*"/g) || []).length, 1);
  assert.doesNotMatch(page.text, /<script\b(?![^>]*\bsrc=)[^>]*>/i);

  for (const preset of ['week', 'month', 'year']) {
    if (!page.text.includes(`name="datePreset" value="${preset}"`)) continue;
    const preview = page.text.match(new RegExp(`class="date-${preset}"> by ([^<]+)</i>`))?.[1]?.replace(/\u00a0/g, ' ');
    assert.ok(preview, `the ${preset} date is drawn in the reply`);
    const selected = await stack.browser().request('GET', `/bets/new?link=${link}&side=yes&stake=0.1&datePreset=${preset}&date=not-a-date&go=1`);
    assert.equal(selected.status, 303, `${preset} ignores an unused custom date`);
    assert.equal(new URL(selected.location).searchParams.get('text'), `@statedbot bet 0.1 yes by ${preview}`);
    const parsed = parseBetCommand(new URL(selected.location).searchParams.get('text'));
    assert.match(parsed.deadline, /T23:59:59\.000Z$/);
  }
  const defaultDate = await stack.browser().request('GET', `/bets/new?link=${link}&side=yes&stake=0.1&go=1`);
  assert.equal(defaultDate.status, 303);
  assert.equal(new URL(defaultDate.location).searchParams.get('text'), `@statedbot bet 0.1 yes by ${page.text.match(/class="date-month"> by ([^<]+)<\/i>/)[1].replace(/\u00a0/g, ' ')}`);

  const missing = await stack.browser().request('GET', `/bets/new?link=${link}&side=yes&stake=0.1&datePreset=custom&go=1`);
  assert.equal(missing.status, 400);
  assert.match(missing.text, /name="datePreset" value="custom" checked/);
  const impossible = await stack.browser().request('GET', `/bets/new?link=${link}&side=yes&stake=0.1&datePreset=custom&date=2026-02-31&go=1`);
  assert.equal(impossible.status, 400);
  assert.match(impossible.text, /Choose a date/);
  assert.match(impossible.text, /name="date" value="2026-02-31"/);
  for (const date of [ymd(new Date()), ymd(new Date(Date.now() + 366 * DAY))]) {
    const outOfRange = await stack.browser().request('GET', `/bets/new?link=${link}&side=yes&stake=0.1&date=${date}&go=1`);
    assert.equal(outOfRange.status, 400);
  }

  const date = ymd(new Date(Date.now() + 2 * DAY));
  const chosen = await stack.browser().request('GET', `/bets/new?link=${link}&side=no&stake=0.25&date=${date}&go=1`);
  assert.equal(chosen.status, 303);
  const to = new URL(chosen.location);
  assert.equal(to.searchParams.get('in_reply_to'), postId);
  assert.match(to.searchParams.get('text'), /^@statedbot bet 0\.25 no by \d{1,2} [A-Z][a-z]{2} \d{4}$/);
  assert.deepEqual(parseBetCommand(to.searchParams.get('text')), {
    kind: 'bet', side: 'no', stake: '0.25', deadline: endOfDay(date),
  });
  assert.deepEqual([...to.searchParams.keys()].sort(), ['in_reply_to', 'text']);
});

test('known dated source hides date input and ignores malformed date query', async () => {
  const author = stack.fakeX.addUser('82999', 'datedauthor');
  const due = new Date(Date.now() + 3 * DAY);
  const post = stack.fakeX.post(author.id, `The bridge opens by ${commandDate(due)}.`, { at: new Date() });
  const mention = stack.fakeX.post(replier.id, '@statedbot bet 0.1 yes', { replyTo: post.id });
  await processMention(stack.db, stack.config, {
    mention, includes: { tweets: [post], users: [author, replier, bot] },
    bot: { userId: bot.id, username: bot.username },
  });
  await run();
  const link = encodeURIComponent(`https://x.com/datedauthor/status/${post.id}`);
  const page = await stack.browser().get(`/bets/new?link=${link}`);
  assert.doesNotMatch(page.text, /name="date"/);
  const redirect = await stack.browser().request('GET', `/bets/new?link=${link}&side=yes&stake=0.1&date=not-a-date&go=1`);
  assert.equal(redirect.status, 303);
  const to = new URL(redirect.location);
  assert.equal(to.searchParams.get('text'), '@statedbot bet 0.1 yes');
});
