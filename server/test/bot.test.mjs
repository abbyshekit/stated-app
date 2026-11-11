// Bot intake against the fake X API, through the real worker, database and
// website. The fake proves the server's logic; only a live round-trip proves
// the X connector (docs/X-ACCESS.md, section 7).

import assert from 'node:assert/strict';
import http from 'node:http';
import { after, before, test } from 'node:test';
import { createDb, kvSet } from '../src/db.mjs';
import { processMention, sendPendingReplies } from '../src/intake.mjs';
import { metrics } from '../src/metrics.mjs';
import { createApp } from '../src/web.mjs';
import { tick } from '../src/worker.mjs';
import { botClient } from '../src/xapi.mjs';
import { startStack } from './support/app.mjs';

const YEAR = new Date().getUTCFullYear() + 1;
let s;
let bot;
let alice;
let bob;
let carol;
let dave;
let eve;
let article;

async function count(sql, params = []) {
  return (await s.db.one(`select count(*)::int as n from (${sql}) q`, params)).n;
}

before(async () => {
  s = await startStack();
  bot = s.fakeX.addUser('500', 'statedbot');
  alice = s.fakeX.addUser('100', 'alice');
  bob = s.fakeX.addUser('200', 'bob');
  carol = s.fakeX.addUser('300', 'carol');
  dave = s.fakeX.addUser('400', 'dave');
  eve = s.fakeX.addUser('600', 'eve', { protected: true });
  const page = await s.connectBot(bot);
  assert.match(page.text, /Bot connected as @statedbot/);
  article = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end(`<html><head><title>TEST FIXTURE article</title><meta name="author" content="Jane Writer"></head>
      <body><p>TEST FIXTURE. The index will top 6,000 by the end of ${YEAR}, according to this writer.</p></body></html>`);
  });
  await new Promise((resolve) => article.listen(0, '127.0.0.1', resolve));
});

after(async () => {
  await new Promise((resolve) => article.close(resolve));
  await s.close();
});

test('a tag under your own post saves it to My predictions for the tagger, once', async () => {
  const p1 = s.fakeX.post(alice.id, `Bitcoin will close above $150k by the end of ${YEAR}, 70% chance.`);
  const m1 = s.fakeX.post(alice.id, '@statedbot save this', { replyTo: p1.id });
  const summary = await tick(s.db, s.config, s.x);
  assert.deepEqual(summary.mentions.processed.map((p) => p.outcome), ['saved']);

  const save = await s.db.one(`select s.*, src.platform_id from saves s
    join statements st on st.id = s.statement_id join sources src on src.id = st.source_id
    where s.origin_event_id = $1`, [m1.id]);
  assert.equal(save.owner_x_user_id, alice.id);
  assert.equal(save.relation, 'mine');
  assert.equal(save.platform_id, p1.id, 'the saved source is the post, not the mention');
  assert.equal(save.visibility, 'private');
  assert.equal(save.owner_user_id, null, 'pending until Alice signs in');

  assert.equal(s.fakeX.created.length, 1);
  const reply = s.fakeX.created[0];
  assert.equal(reply.reply.in_reply_to_tweet_id, m1.id, 'the reply goes under the tagger’s post');
  assert.match(reply.text, /Only you can see it/);
  assert.doesNotMatch(reply.text, /https?:\/\//, 'replies carry no link unless STATED_REPLY_LINKS=1');
  assert.equal(await count(`select 1 from inbox where owner_x_user_id = $1 and kind = 'pending_terms'`, [alice.id]), 1);
});

test('a tag under someone else’s post follows it, credits the author, and keeps them out of the reply', async () => {
  const p2 = s.fakeX.post(bob.id, `The Fed will raise rates at the December 9, ${YEAR} meeting, 70% chance.`);
  const m2 = s.fakeX.post(alice.id, '@statedbot', { replyTo: p2.id });
  await tick(s.db, s.config, s.x);
  const save = await s.db.one(`select s.*, st.speaker, st.speaker_x_user_id from saves s
    join statements st on st.id = s.statement_id where s.origin_event_id = $1`, [m2.id]);
  assert.equal(save.owner_x_user_id, alice.id);
  assert.equal(save.relation, 'following');
  assert.equal(save.speaker, '@bob');
  assert.equal(save.speaker_x_user_id, bob.id);
  assert.equal(await count('select 1 from saves where owner_x_user_id = $1', [bob.id]), 0, 'the author is not enrolled');
  const reply = s.fakeX.created.find((r) => r.reply.in_reply_to_tweet_id === m2.id);
  assert.ok(reply);
  assert.deepEqual(reply.reply.exclude_reply_user_ids, [bob.id]);
  assert.doesNotMatch(reply.text, /@bob/);
});

test('replaying an event or redelivering mentions creates no second save and no second reply', async () => {
  const before = {
    saves: await count('select 1 from saves'),
    replies: s.fakeX.created.length,
    events: await count('select 1 from mention_events'),
  };
  const stored = await s.db.one(`select payload from mention_events where outcome = 'saved' order by received_at limit 1`);
  const replay = await processMention(s.db, s.config, {
    mention: stored.payload.mention,
    includes: stored.payload.includes,
    bot: await s.x.identity(),
  });
  assert.equal(replay.outcome, 'replay');
  assert.deepEqual(await sendPendingReplies(s.db, s.x), []);

  await s.db.query(`delete from kv where key = 'mentions_since_id'`);
  const again = await tick(s.db, s.config, s.x);
  assert.ok(again.mentions.processed.length >= 2);
  assert.ok(again.mentions.processed.every((p) => p.outcome === 'replay'));
  assert.equal(await count('select 1 from saves'), before.saves);
  assert.equal(await count('select 1 from mention_events'), before.events);
  assert.equal(s.fakeX.created.length, before.replies);
});

test('a second tag on the same post is a duplicate, not a second save', async () => {
  const p2 = [...s.fakeX.posts.values()].find((p) => p.text.startsWith('The Fed will raise'));
  const saves = await count('select 1 from saves');
  const m = s.fakeX.post(alice.id, '@statedbot again', { replyTo: p2.id });
  await tick(s.db, s.config, s.x);
  assert.equal(await count('select 1 from saves'), saves);
  const event = await s.db.one('select * from mention_events where event_id = $1', [m.id]);
  assert.equal(event.outcome, 'duplicate');
  assert.equal(event.reply_text, null, 'a duplicate tag costs no paid reply');
});

test('a reply in a thread the bot is already in is not a request', async () => {
  const m2 = [...s.fakeX.posts.values()].find((p) => p.author_id === alice.id && p.text.endsWith('@statedbot'));
  const chatter = s.fakeX.post(carol.id, 'agreed, this looks right', { replyTo: m2.id });
  assert.match(chatter.text, /@statedbot/, 'the hidden reply prefix carries the bot handle');
  const replies = s.fakeX.created.length;
  await tick(s.db, s.config, s.x);
  const event = await s.db.one('select * from mention_events where event_id = $1', [chatter.id]);
  assert.equal(event.outcome, 'ignored_implicit');
  assert.equal(await count('select 1 from saves where owner_x_user_id = $1', [carol.id]), 0);
  assert.equal(s.fakeX.created.length, replies);
});

test('a tag under a deleted post says so and saves nothing', async () => {
  const gone = s.fakeX.post(bob.id, `Oil will trade above $120 by the end of ${YEAR}.`);
  const m = s.fakeX.post(dave.id, '@statedbot', { replyTo: gone.id });
  s.fakeX.deleted.add(gone.id);
  await tick(s.db, s.config, s.x);
  const event = await s.db.one('select * from mention_events where event_id = $1', [m.id]);
  assert.equal(event.outcome, 'source_unavailable');
  assert.equal(event.reply_status, 'sent');
  assert.match(event.reply_text, /Unable to read that post/);
  assert.equal(await count('select 1 from saves where owner_x_user_id = $1', [dave.id]), 0);
});

test('an inline prediction is the tagger’s own; a greeting saves nothing and gets no reply', async () => {
  const own = s.fakeX.post(dave.id, `@statedbot The Lakers will win the ${YEAR} title.`);
  const hello = s.fakeX.post(dave.id, 'hi @statedbot');
  const replies = s.fakeX.created.length;
  await tick(s.db, s.config, s.x);
  const save = await s.db.one(`select s.*, st.span, src.platform_id from saves s join statements st on st.id = s.statement_id
    join sources src on src.id = st.source_id where s.origin_event_id = $1`, [own.id]);
  assert.equal(save.relation, 'mine');
  assert.equal(save.platform_id, own.id);
  assert.doesNotMatch(save.span, /@statedbot/);
  const event = await s.db.one('select * from mention_events where event_id = $1', [hello.id]);
  assert.equal(event.outcome, 'no_target');
  assert.equal(s.fakeX.created.length, replies + 1);
});

test('with replies off, the acknowledgement is held and nothing is posted', async () => {
  const quiet = { ...s.config, x: { ...s.config.x, repliesEnabled: false } };
  const p = s.fakeX.post(bob.id, `Gold will hit $5,000 by the end of ${YEAR}, 60% chance.`);
  const m = s.fakeX.post(carol.id, '@statedbot', { replyTo: p.id });
  const replies = s.fakeX.created.length;
  const page = await s.x.mentions({ sinceId: await s.db.one(`select value from kv where key = 'mentions_since_id'`).then((r) => r.value) });
  const mention = page.data.find((d) => d.id === m.id);
  const result = await processMention(s.db, quiet, { mention, includes: page.includes, bot: await s.x.identity() });
  assert.equal(result.outcome, 'saved');
  assert.equal(result.event.reply_status, 'held');
  await sendPendingReplies(s.db, s.x);
  assert.equal(s.fakeX.created.length, replies);
  assert.equal(await count(`select 1 from inbox where owner_x_user_id = $1 and kind = 'saved'`, [carol.id]), 1);
  await kvSet(s.db, 'mentions_since_id', m.id);
});

test('a protected author’s post stays private and cannot be published', async () => {
  const p = s.fakeX.post(eve.id, `Rents will fall 10% by the end of ${YEAR}.`);
  const m = s.fakeX.post(carol.id, '@statedbot public', { replyTo: p.id });
  await tick(s.db, s.config, s.x);
  const save = await s.db.one('select * from saves where origin_event_id = $1', [m.id]);
  assert.equal(save.visibility, 'private');
  const source = await s.db.one(`select src.author_protected from statements st join sources src on src.id = st.source_id where st.id = $1`, [save.statement_id]);
  assert.equal(source.author_protected, true);
});

test('a mention with an article link queues it and lands candidates in the tagger’s inbox', async () => {
  const link = `http://127.0.0.1:${article.address().port}/story`;
  const m = s.fakeX.post(dave.id, `@statedbot ${link}`);
  await tick(s.db, s.config, s.x);
  const event = await s.db.one('select * from mention_events where event_id = $1', [m.id]);
  assert.equal(event.outcome, 'article');
  const intake = await s.db.one('select * from url_intakes where id = $1', [event.intake_id]);
  assert.equal(intake.status, 'fetched');
  assert.equal(intake.owner_x_user_id, dave.id);
  assert.equal(await count(`select 1 from inbox where owner_x_user_id = $1 and kind = 'pick_predictions'`, [dave.id]), 1);
});

test('first sign-in claims the pending saves; setup defaults to private', async () => {
  const b = await s.signIn(alice);
  assert.match(b.lastPage.url, /\/setup$/);
  assert.match(b.lastPage.text, /id="pv-private" name="profile" value="private" checked/);
  assert.doesNotMatch(b.lastPage.text, /id="pv-public" name="profile" value="public" checked/);
  const done = await b.submit('/setup', { profile: 'private', defaults: 'private' });
  assert.match(done.url, /\/me/);
  const p1 = [...s.fakeX.posts.values()].find((p) => p.text.startsWith('Bitcoin will close above'));
  const p2 = [...s.fakeX.posts.values()].find((p) => p.text.startsWith('The Fed will raise'));
  assert.match(done.text, new RegExp(`A post by @alice[\\s\\S]*status/${p1.id}`), 'My predictions lists the post by its link, not its words');
  assert.doesNotMatch(done.text, new RegExp(`status/${p2.id}`), 'Following is a separate tab');
  const following = await b.get('/me?tab=following');
  assert.match(following.text, new RegExp(`A post by @bob[\\s\\S]*status/${p2.id}`));
  assert.doesNotMatch(following.text, /The Fed will raise/, 'a private post’s words are not shown unless asked for');
  const user = await s.db.one('select * from users where x_user_id = $1', [alice.id]);
  assert.equal(user.profile_visibility, 'private');
  assert.equal(await count('select 1 from saves where owner_x_user_id = $1 and owner_user_id is null', [alice.id]), 0);
});

test('state survives a restart: a new pool, worker and server resume from the stored cursor and session', async () => {
  const b = await s.signIn(alice);
  const saves = await count('select 1 from saves');
  const replies = s.fakeX.created.length;
  const db2 = createDb(s.config.databaseUrl);
  const x2 = botClient(db2, s.config);
  const handler = createApp({ db: db2, config: s.config });
  const server = http.createServer((req, res) => handler(req, res));
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  try {
    const p = s.fakeX.post(alice.id, `Inflation will be under 2% by the end of ${YEAR}.`);
    const m = s.fakeX.post(alice.id, '@statedbot', { replyTo: p.id });
    const first = await tick(db2, s.config, x2);
    assert.deepEqual(first.mentions.processed.map((x) => x.id), [m.id]);
    const second = await tick(db2, s.config, x2);
    assert.deepEqual(second.mentions.processed, []);
    assert.equal(await count('select 1 from saves'), saves + 1);
    assert.equal(s.fakeX.created.length, replies + 1);
    const res = await fetch(`http://127.0.0.1:${server.address().port}/me`, { headers: { cookie: b.cookieHeader() } });
    const text = await res.text();
    assert.equal(res.status, 200);
    assert.match(text, new RegExp(`status/${p.id}`));
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await db2.close();
  }
});

test('an expired bot token refreshes once and the new refresh token is stored', async () => {
  await s.db.query(`update bot_credentials set expires_at = now() - interval '1 minute'`);
  const before = await s.db.one('select refresh_token, updated_at from bot_credentials');
  const a = botClient(s.db, s.config);
  const b = botClient(s.db, s.config);
  await Promise.all([a.mentions({ sinceId: '1' }), b.mentions({ sinceId: '1' })]);
  const after = await s.db.one('select refresh_token, updated_at, expires_at from bot_credentials');
  assert.notEqual(after.refresh_token, before.refresh_token);
  assert.ok(new Date(after.expires_at) > new Date());
  assert.equal(s.fakeX.refreshGrants, 1, 'two clients racing spend the single-use refresh token once');
});

test('metrics count real tags, repeat savers and replies, without editorial records', async () => {
  const m = await metrics(s.db);
  assert.ok(m.tags.valid >= 8);
  assert.ok(m.tags.taggers >= 3);
  assert.ok(m.repeat.repeatSavers >= 1, 'Alice saved more than once');
  assert.equal(m.tags.savesPerValidTag <= 1, true);
  assert.ok(m.tags.repliesSent >= 6);
  assert.ok(m.collections.mine >= 2 && m.collections.following >= 2);
});
