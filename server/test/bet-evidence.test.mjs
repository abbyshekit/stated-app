import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import https from 'node:https';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startStack } from './support/app.mjs';
import { createBet } from '../src/bets.mjs';
import { completeSetup, UserError } from '../src/store.mjs';
import { processMention } from '../src/intake.mjs';
import { tick } from '../src/worker.mjs';
import { betReplies, parseBetCommand, say, sendBetReplies } from '../src/reply-bets.mjs';
import { evidenceFor, evidencePrompts, evidenceSettled, parseEvidenceCommand, runEvidenceCommands, submitEvidence, targetEvidenceBet } from '../src/bet-evidence.mjs';
import { extractArticle } from '../src/articles.mjs';
import { registerBetEvidenceRoutes } from '../src/bet-evidence-pages.mjs';
import { esc } from '../src/html.mjs';

let s, server, fixtureBase, certDir, oldCa, creator, acceptor, stranger, creatorBrowser, strangerBrowser, bet, statementId, post, offer, offerCommand;
const html = '<html><head><title>Official result</title></head><body><article><p>The official record confirms that the event happened before the deadline. The registry published its complete decision and supporting details for public inspection.</p><p>The responsible authority recorded the result after reviewing the evidence and issued the decision to the public.</p></article></body></html>';
const digest = (text) => createHash('sha256').update(text).digest('hex');
const future = (ms) => new Date(Date.now() + ms).toISOString();
const page = async (url) => ({ url, body: html });

async function freshEvidenceBet() {
  const sourcePost = s.fakeX.post(post.author_id, 'The registry publishes its decision.');
  const source = await s.db.one(`insert into sources (platform,platform_id,url,text,acquisition)
    values ('x',$1,$2,'The registry publishes its decision.','mention') returning id`,
  [sourcePost.id, `https://x.com/evidence_author/status/${sourcePost.id}`]);
  const statement = await s.db.one(`insert into statements (source_id,span,speaker)
    values ($1,'The registry publishes its decision.','evidence_author') returning id`, [source.id]);
  const save = await s.db.one(`insert into saves (owner_x_user_id,owner_user_id,statement_id,relation,intake)
    values ($1,$2,$3,'following','mention') returning id`, [creator.x_user_id, creator.id, statement.id]);
  // This file makes more offers for one person than the hourly ceiling allows; age the earlier ones.
  await s.db.query(`update bilateral_bets set created_at = created_at - interval '2 hours' where creator_user_id = $1`, [creator.id]);
  const fresh = await createBet(s.db, creator, { requestId: randomUUID(), claim: 'The registry publishes its decision',
    criteria: 'The public registry confirms the decision.', evidenceSourceUrl: 'https://example.org/result',
    creatorSide: 'yes', stakeNear: '0.1', sourceSaveId: String(save.id),
    acceptBy: future(86400000), resolveAt: future(172800000) });
  await s.db.query(`update bilateral_bets set status='accepted', acceptor_user_id=$2,
    accepted_at=clock_timestamp()-interval '1 day', referee_wallet='referee.testnet', chain_state='{}' where id=$1`, [fresh.id, acceptor.id]);
  await s.db.query(`insert into enclave_plans (statement_id,source,closes_at,record) values ($1,'evidence',$2,'{}')`, [statement.id, future(86400000)]);
  const thread = s.fakeX.post('500', 'Evidence thread');
  await s.db.query(`insert into bot_outbox (dedupe_key,in_reply_to,body,bet_id,status,post_id)
    values ($1,$2,'Evidence thread',$3,'sent',$4)`, [`offer:${fresh.id}`, sourcePost.id, fresh.id, thread.id]);
  return { bet: fresh, statementId: statement.id, thread, sourcePost };
}

before(async () => {
  certDir = mkdtempSync(join(tmpdir(), 'stated-evidence-cert-'));
  const keyPath = join(certDir, 'key.pem');
  const certPath = join(certDir, 'cert.pem');
  execFileSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', keyPath,
    '-out', certPath, '-subj', '/CN=localhost', '-addext', 'subjectAltName=IP:127.0.0.1', '-days', '1'], { stdio: 'ignore' });
  const cert = readFileSync(certPath);
  oldCa = https.globalAgent.options.ca;
  https.globalAgent.options.ca = cert;
  server = https.createServer({ key: readFileSync(keyPath), cert }, (req, res) => {
    if (req.url === '/missing') { res.writeHead(503); res.end('Unavailable'); return; }
    const slowHop = req.url.match(/^\/deadline-redirect-(\d)$/);
    if (slowHop) {
      setTimeout(() => {
        res.writeHead(302, { location: Number(slowHop[1]) < 2 ? `/deadline-redirect-${Number(slowHop[1]) + 1}` : '/result' });
        res.end();
      }, 150);
      return;
    }
    const redirects = { '/redirect-result': '/result', '/redirect-x': 'https://x.com/official/status/1',
      '/redirect-twitter': 'https://mobile.twitter.com/official/status/1', '/redirect-private': 'https://169.254.169.254/result' };
    if (redirects[req.url]) { res.writeHead(302, { location: redirects[req.url] }); res.end(); return; }
    res.writeHead(200, { 'content-type': 'text/html' }); res.end(html);
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  fixtureBase = `https://127.0.0.1:${server.address().port}`;
  s = await startStack({ STATED_PLAY: '1', STATED_NEAR_CONTRACT: 'escrow.testnet',
    STATED_ENCLAVE_RULINGS: '1', NEARAI_API_KEY: 'test-only' });
  const bot = s.fakeX.addUser('500', 'statedbot');
  await s.connectBot(bot);
  const author = s.fakeX.addUser('61011', 'evidence_author');
  const cx = s.fakeX.addUser('61012', 'ev_creator');
  const ax = s.fakeX.addUser('61013', 'ev_acceptor');
  const sx = s.fakeX.addUser('61014', 'ev_stranger');
  creatorBrowser = await s.signIn(cx);
  await creatorBrowser.submit('/setup', { profile: 'private', defaults: 'private' });
  const acceptorBrowser = await s.signIn(ax);
  await acceptorBrowser.submit('/setup', { profile: 'private', defaults: 'private' });
  strangerBrowser = await s.signIn(sx);
  creator = await s.db.one('select * from users where x_user_id=$1', [cx.id]);
  acceptor = await s.db.one('select * from users where x_user_id=$1', [ax.id]);
  stranger = await s.db.one('select * from users where x_user_id=$1', [sx.id]);
  post = s.fakeX.post(author.id, `The public registry will publish its decision before the end of ${new Date().getUTCFullYear() + 1}.`);
  s.fakeX.post(cx.id, '@statedbot', { replyTo: post.id });
  await tick(s.db, s.config, s.x);
  const save = await s.db.one(`select s.id, s.statement_id from saves s join statements st on st.id=s.statement_id
    join sources src on src.id=st.source_id where src.platform_id=$1 and s.owner_x_user_id=$2`, [post.id, cx.id]);
  assert.ok(save);
  statementId = save.statement_id;
  bet = await createBet(s.db, creator, { requestId: randomUUID(), claim: 'The registry publishes its decision',
    criteria: 'The public registry confirms the decision.', evidenceSourceUrl: 'https://example.org/result',
    creatorSide: 'yes', stakeNear: '0.1', sourceSaveId: String(save.id),
    acceptBy: future(86400000), resolveAt: future(172800000) });
  await s.db.query(`update bilateral_bets set status='accepted', acceptor_user_id=$2, accepted_at=clock_timestamp(),
    creator_wallet='creator.testnet', acceptor_wallet='acceptor.testnet', referee_wallet='referee.testnet',
    chain_state=$3, near_height=1, near_verified_at=clock_timestamp() where id=$1`,
  [bet.id, acceptor.id, { status: 'accepted', creator: 'creator.testnet', acceptor: 'acceptor.testnet', referee: 'referee.testnet' }]);
  offer = s.fakeX.post(bot.id, 'Evidence thread');
  offerCommand = s.fakeX.post(cx.id, '@statedbot bet yes', { replyTo: post.id });
  await s.db.query(`insert into bet_commands (event_id,x_user_id,x_username,kind,side,bet_id,status,exclude)
    values ($1,$2,$3,'bet','yes',$4,'done',$5)`, [offerCommand.id, cx.id, cx.username, bet.id, [author.id]]);
  await s.db.query(`insert into bot_outbox (dedupe_key,in_reply_to,body,bet_id,status,post_id)
    values ($1,$2,'Evidence thread',$3,'sent',$4)`, [`offer:${bet.id}`, post.id, bet.id, offer.id]);
  await s.db.query(`insert into enclave_plans (statement_id,source,closes_at,record) values ($1,'evidence',$2,'{}')`,
    [statementId, future(86400000)]);
});
after(async () => {
  await s?.close();
  if (server?.listening) await new Promise((resolve) => server.close(resolve));
  https.globalAgent.options.ca = oldCa;
  if (certDir) rmSync(certDir, { recursive: true, force: true });
});

test('evidence commands require the whole reply and an HTTPS non-X link', () => {
  for (const [text, side, url] of [
    ['@statedbot yes https://example.org/Report?Case=A', 'yes', 'https://example.org/Report?Case=A'],
    ['@person @statedbot NO https://example.org/no', 'no', 'https://example.org/no'],
  ]) {
    const expected = { kind: 'evidence', side, url };
    assert.deepEqual(parseEvidenceCommand(text), expected);
    assert.deepEqual(parseBetCommand(text), expected);
  }
  for (const text of ['@statedbot yes this happened https://example.org/a', '@statedbot yes https://example.org/a really',
    '@statedbot no http://example.org/a', '@statedbot yes https:example.org/a', '@statedbot yes https://x.com/u/status/1',
    '@statedbot no https://twitter.com/u/status/1', '@statedbot yes', '@statedbot yes https://example.org/a https://example.org/b']) {
    assert.equal(parseEvidenceCommand(text), null, text);
  }
});

test('evidence replies are ignored, not read as links to track, when jury rulings are off', async () => {
  const disabled = { ...s.config, nearai: { ...s.config.nearai, rulings: false } };
  const bot = await s.x.identity();
  for (const [text, target, expected] of [
    ['yes https://example.org/implicit', offer, 'ignored_evidence'],
    ['@statedbot yes https://example.org/explicit', offer, 'ignored_evidence'],
    ['@statedbot no https://example.org/source', post, 'ignored_evidence'],
  ]) {
    const mention = s.fakeX.post(creator.x_user_id, text, { replyTo: target.id });
    const result = await processMention(s.db, disabled, { mention,
      includes: { users: [s.fakeX.users.get(target.author_id), s.fakeX.users.get(creator.x_user_id)], tweets: [target] }, bot });
    assert.equal(result.outcome, expected);
    assert.equal(result.event.command, null);
    assert.equal(await s.db.one('select event_id from evidence_commands where event_id=$1', [mention.id]), null);
    assert.equal(await s.db.one('select event_id from bet_commands where event_id=$1', [mention.id]), null);
  }
  assert.equal(parseBetCommand('@statedbot yes https://example.org/disabled', { rulings: false }), null);
  assert.deepEqual(parseBetCommand('@statedbot bet 0.1 yes', { rulings: false }), { kind: 'bet', side: 'yes', stake: '0.1' });
});

test('disabled evidence workers leave queued replies and unprompted plans untouched', async (t) => {
  const disabled = { ...s.config, nearai: { ...s.config.nearai, rulings: false } };
  const eventId = `disabled-evidence-${randomUUID()}`;
  t.after(() => s.db.query('delete from evidence_commands where event_id=$1', [eventId]));
  await s.db.query(`insert into evidence_commands (event_id,x_user_id,side,url,target_ref)
    values ($1,$2,'yes','https://example.org/disabled',$3)`, [eventId, creator.x_user_id, offer.id]);
  const queued = await s.db.one('select * from evidence_commands where event_id=$1', [eventId]);
  const plan = await s.db.one('select * from enclave_plans where statement_id=$1', [statementId]);
  assert.equal(plan.prompted_at, null);
  assert.deepEqual(await runEvidenceCommands(s.db, disabled, { fetchPage: () => assert.fail('disabled evidence must not fetch') }),
    { done: 0, refused: 0, retry: 0, failed: 0 });
  assert.deepEqual(await evidencePrompts(s.db, disabled, { say: () => assert.fail('disabled evidence must not prompt') }), { prompted: 0 });
  assert.deepEqual(await s.db.one('select * from evidence_commands where event_id=$1', [eventId]), queued);
  assert.deepEqual(await s.db.one('select * from enclave_plans where statement_id=$1', [statementId]), plan);
  assert.equal(await s.db.one('select id from bet_evidence where event_id=$1', [eventId]), null);
});

test('disabled evidence submission refuses with 404 before reading a page or database', async () => {
  for (const nearai of [undefined, { rulings: false }]) {
    for (const via of ['page', 'reply']) {
      await assert.rejects(submitEvidence({}, { ...s.config, nearai }, { betId: bet.id, userId: creator.id,
        side: 'yes', url: 'https://example.org/disabled', via, fetchPage: () => assert.fail('disabled evidence must not fetch') }),
      (error) => error instanceof UserError && error.status === 404);
    }
    assert.deepEqual(await runEvidenceCommands({}, { ...s.config, nearai }), { done: 0, refused: 0, retry: 0, failed: 0 });
    assert.deepEqual(await evidencePrompts({}, { ...s.config, nearai }, { say: () => assert.fail('disabled evidence must not prompt') }), { prompted: 0 });
  }
});

test('a bettor reply queues evidence, extracts text and acknowledges it once', async () => {
  const mention = s.fakeX.post(creator.x_user_id, '@statedbot yes https://t.co/official', { replyTo: offer.id });
  mention.entities.urls[0].expanded_url = 'https://example.org/official';
  const bot = await s.x.identity();
  await processMention(s.db, s.config, { mention, includes: { users: [{ id: creator.x_user_id, username: creator.x_username }], tweets: [offer] }, bot });
  const queued = await s.db.one('select * from evidence_commands where event_id=$1', [mention.id]);
  assert.equal(queued?.status, 'queued');
  assert.equal(queued.target_ref, offer.id);
  assert.equal(queued.url, 'https://example.org/official');
  let calls = 0;
  const fetchPage = async (url) => { calls += 1; return page(url); };
  assert.deepEqual(await runEvidenceCommands(s.db, s.config, { fetchPage }), { done: 1, refused: 0, retry: 0, failed: 0 });
  const stored = await s.db.one('select * from bet_evidence where event_id=$1', [mention.id]);
  assert.equal(stored.side, 'yes');
  assert.equal(stored.via, 'reply');
  assert.match(stored.body, /official record confirms/i);
  assert.doesNotMatch(stored.body, /<article>/);
  assert.equal(stored.body_hash, digest(stored.body));
  assert.equal((await s.db.one('select status from evidence_commands where event_id=$1', [mention.id])).status, 'done');
  const rows = await s.db.tx((tx) => evidenceFor(tx, statementId));
  assert.equal(rows[0].x_username, creator.x_username);
  const duplicate = await submitEvidence(s.db, s.config, { betId: bet.id, userId: creator.id, side: 'yes',
    url: stored.url, via: 'reply', eventId: mention.id, fetchPage });
  assert.equal(String(duplicate.id), String(stored.id));
  assert.equal(calls, 1);
  assert.equal((await s.db.one('select count(*)::int as n from bot_outbox where dedupe_key=$1', [`evidence-ack:${bet.id}:${creator.id}`])).n, 1);
  assert.ok(betReplies.evidenceAck);
  await runEvidenceCommands(s.db, s.config, { fetchPage });
  assert.equal((await s.db.one('select count(*)::int as n from bot_outbox where dedupe_key=$1', [`evidence-ack:${bet.id}:${creator.id}`])).n, 1);
});

test('only bettors may submit, with two links per person and a closing time', async () => {
  const args = { betId: bet.id, side: 'no', via: 'page', fetchPage: page };
  await assert.rejects(submitEvidence(s.db, s.config, { ...args, userId: stranger.id, url: 'https://example.org/stranger' }), /Not a bettor on this Bet\./);
  await assert.rejects(submitEvidence(s.db, s.config, { ...args, userId: acceptor.id, url: 'https://example.org/empty',
    fetchPage: async (url) => ({ url, body: '<html><body></body></html>' }) }), /That link could not be read\./);
  assert.equal((await s.db.one('select count(*)::int as n from bet_evidence where user_id=$1', [acceptor.id])).n, 0);
  const longPage = async (url) => ({ url, body: `<article><p>${'Public evidence confirms the recorded outcome. '.repeat(200)}</p></article>` });
  const second = await submitEvidence(s.db, s.config, { ...args, userId: creator.id, url: 'https://example.org/second', fetchPage: longPage });
  assert.equal(second.body.length, 6000);
  assert.equal(second.body_hash, digest(second.body));
  await assert.rejects(submitEvidence(s.db, s.config, { ...args, userId: creator.id, url: 'https://example.org/third' }), /You can add at most two links per post\./);
  assert.equal((await s.db.one('select count(*)::int as n from bot_outbox where dedupe_key=$1', [`evidence-ack:${bet.id}:${creator.id}`])).n, 1);
  await s.db.query(`update enclave_plans set closes_at=clock_timestamp()-interval '1 second' where statement_id=$1`, [statementId]);
  await assert.rejects(submitEvidence(s.db, s.config, { ...args, userId: acceptor.id, url: 'https://example.org/late' }), /Evidence is closed\./);
  await s.db.query(`update enclave_plans set closes_at=clock_timestamp()+interval '1 day' where statement_id=$1`, [statementId]);
});

test('a stranger reply is dropped at intake without queueing or an outbox reply', async () => {
  const mention = s.fakeX.post(stranger.x_user_id, '@statedbot no https://example.org/stranger', { replyTo: offer.id });
  await processMention(s.db, s.config, { mention, includes: { users: [{ id: stranger.x_user_id, username: stranger.x_username }], tweets: [offer] }, bot: await s.x.identity() });
  assert.equal(await s.db.one('select * from evidence_commands where event_id=$1', [mention.id]), null);
  assert.deepEqual(await runEvidenceCommands(s.db, s.config, { fetchPage: page }), { done: 0, refused: 0, retry: 0, failed: 0 });
  assert.equal((await s.db.one('select count(*)::int as n from bot_outbox where in_reply_to=$1', [mention.id])).n, 0);
});

test('the evidence prompt is queued once and records when it was prompted', async () => {
  const send = (options) => say(s.db, s.config, options);
  await evidencePrompts(s.db, s.config, { say: send });
  const plan = await s.db.one('select prompted_at, closes_at from enclave_plans where statement_id=$1', [statementId]);
  assert.ok(plan.prompted_at);
  const prompt = await s.db.one('select * from bot_outbox where dedupe_key=$1', [`evidence-prompt:${bet.id}`]);
  assert.ok(prompt);
  assert.equal(prompt.in_reply_to, offerCommand.id);
  assert.equal(prompt.body, betReplies.evidencePrompt({ closesAt: plan.closes_at, url: `${s.config.baseUrl}/bets/${bet.id}` }));
  await evidencePrompts(s.db, s.config, { say: send });
  assert.equal((await s.db.one('select count(*)::int as n from bot_outbox where dedupe_key=$1', [`evidence-prompt:${bet.id}`])).n, 1);
  assert.equal(new Date((await s.db.one('select prompted_at from enclave_plans where statement_id=$1', [statementId])).prompted_at).getTime(), new Date(plan.prompted_at).getTime());
  await sendBetReplies(s.db, s.x);
  const sent = await s.db.one('select post_id from bot_outbox where dedupe_key=$1', [`evidence-prompt:${bet.id}`]);
  assert.ok(sent.post_id);
  const promptPost = s.fakeX.posts.get(sent.post_id);
  const mention = s.fakeX.post(acceptor.x_user_id, 'no https://example.org/bare', { replyTo: promptPost.id });
  await processMention(s.db, s.config, { mention, includes: { users: [{ id: acceptor.x_user_id, username: acceptor.x_username }], tweets: [promptPost] }, bot: await s.x.identity() });
  assert.equal((await s.db.one('select status from evidence_commands where event_id=$1', [mention.id])).status, 'queued');
  assert.deepEqual(await runEvidenceCommands(s.db, s.config, { fetchPage: page }), { done: 1, refused: 0, retry: 0, failed: 0 });
  const ack = await s.db.one('select * from bot_outbox where dedupe_key=$1', [`evidence-ack:${bet.id}:${acceptor.id}`]);
  const closesAt = (await s.db.one('select closes_at from enclave_plans where statement_id=$1', [statementId])).closes_at;
  assert.equal(ack.body, betReplies.evidenceAck({ closesAt, url: `${s.config.baseUrl}/bets/${bet.id}` }));
  assert.equal(ack.in_reply_to, mention.id);
});

test('an unreadable reply is refused without a public reply', async () => {
  const unreadable = s.fakeX.post(acceptor.x_user_id, '@statedbot no https://example.org/unreadable', { replyTo: offerCommand.id });
  await processMention(s.db, s.config, { mention: unreadable,
    includes: { users: [{ id: acceptor.x_user_id, username: acceptor.x_username }], tweets: [offerCommand] }, bot: await s.x.identity() });
  assert.equal((await runEvidenceCommands(s.db, s.config, { fetchPage: async () => { throw new Error('Unreadable'); } })).refused, 1);
  const command = await s.db.one('select * from evidence_commands where event_id=$1', [unreadable.id]);
  assert.equal(command.attempts, 1);
  assert.equal(command.status, 'refused');
  assert.equal(command.detail, 'That link could not be read.');
  assert.equal((await s.db.one('select count(*)::int as n from bot_outbox where in_reply_to=$1', [unreadable.id])).n, 0);
});

test('the private evidence form fetches a local article and preserves a failed link', async () => {
  const path = `/bets/${bet.id}/evidence`;
  assert.equal((await s.browser().get(path)).status, 404);
  assert.equal((await strangerBrowser.get(path)).status, 404);
  const acceptorBrowser = await s.signIn(s.fakeX.users.get(String(acceptor.x_user_id)));
  const form = await acceptorBrowser.get(path);
  assert.equal(form.status, 200);
  assert.match(form.text, /<span class="page-title">Links<\/span>/);
  assert.match(form.text, /Links close (?:in \d+ (?:minutes?|hours?|days?), )?\d{2}:\d{2} UTC \d{1,2} [A-Z][a-z]{2}\. The deadline (?:is|was) (?:in \d+ (?:minutes?|hours?|days?), )?\d{2}:\d{2} UTC \d{1,2} [A-Z][a-z]{2}\./);
  assert.match(form.text, /<form\b/i);
  assert.match(form.text, /name="(?:url|link)"/i);
  assert.match(form.text, /type="hidden" name="side" value="no"/);
  assert.doesNotMatch(form.text, /id="evidence-(?:yes|no)"|aria-label="Evidence for"/);
  assert.match(form.text, /<label for="evidence-url">Link to a web page \(not an X post\)<\/label>/);
  assert.match(form.text, /id="evidence-url"[^>]*placeholder="https:\/\/"/);
  assert.doesNotMatch(form.text, /aria-invalid="true"/);
  const xFailure = await acceptorBrowser.submit(path, { side: 'no', url: 'https://x.com/official/status/123' }, { from: path });
  assert.equal(xFailure.status, 400);
  assert.match(xFailure.text, /The jury can’t open X posts\. Paste a link to a public web page\./);
  const bad = `${fixtureBase}/missing`;
  const failure = await acceptorBrowser.submit(path, { side: 'no', url: bad }, { from: path });
  assert.match(failure.text, /That link could not be read\./);
  assert.ok(failure.text.includes(bad));
  assert.match(failure.text, /id="evidence-url"[^>]*aria-invalid="true"/);
  assert.equal((failure.text.match(/That link could not be read\./g) || []).length, 1);
  const failedForm = failure.text.slice(failure.text.indexOf(`<form method="post" action="${path}"`));
  assert.ok(failedForm.indexOf('That link could not be read.') >= 0);
  assert.ok(failedForm.indexOf('That link could not be read.') < failedForm.indexOf('<button'));
  const url = `${fixtureBase}/article`;
  await acceptorBrowser.submit(path, { side: 'no', url }, { from: path });
  const stored = await s.db.one('select * from bet_evidence where bet_id=$1 and user_id=$2 and url=$3', [bet.id, acceptor.id, url]);
  assert.ok(stored);
  assert.equal(stored.via, 'page');
  assert.match(stored.body, /official record confirms/i);
  assert.equal(stored.body_hash, digest(stored.body));
  const shown = await acceptorBrowser.get(path);
  assert.match(shown.text, /Official result/);
  assert.match(shown.text, /<b>You bet no<\/b>/);
  await s.db.query(`update enclave_plans set closes_at=clock_timestamp()-interval '1 second' where statement_id=$1`, [statementId]);
  const closed = await acceptorBrowser.get(path);
  assert.match(closed.text, /Links are closed\./);
  assert.doesNotMatch(closed.text, /Add a link<\/button>|name="url"/);
  await s.db.query(`update enclave_plans set closes_at=clock_timestamp()+interval '1 day' where statement_id=$1`, [statementId]);
});

test('infrastructure failures stop after three attempts', async () => {
  const eventId = `retry-${randomUUID()}`;
  await s.db.query(`insert into evidence_commands (event_id,x_user_id,side,url,target_ref)
    values ($1,$2,'no','https://example.org/retry',$3)`, [eventId, acceptor.x_user_id, offer.id]);
  const broken = { ...s.db, one(sql, params) {
    if (sql.startsWith('select b.id, u.id as user_id')) throw new Error('Database temporarily unavailable');
    return s.db.one(sql, params);
  } };
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    if (attempt > 1) await s.db.query(`update evidence_commands set updated_at=clock_timestamp()-interval '1 minute' where event_id=$1`, [eventId]);
    const result = await runEvidenceCommands(broken, s.config, { fetchPage: page });
    assert.equal(result[attempt === 3 ? 'failed' : 'retry'], 1);
  }
  const exhausted = await s.db.one('select * from evidence_commands where event_id=$1', [eventId]);
  assert.equal(exhausted.status, 'failed');
  assert.equal(exhausted.attempts, 3);
  assert.match(exhausted.detail, /Database temporarily unavailable/);
  assert.deepEqual(await runEvidenceCommands(broken, s.config), { done: 0, refused: 0, retry: 0, failed: 0 });
});

test('a slow page holds no statement lock and both bettors keep their arrival time', async (t) => {
  const fresh = await freshEvidenceBet();
  let now = Date.now();
  const closesAt = now + 1000;
  await s.db.query('update enclave_plans set closes_at=$2 where statement_id=$1', [fresh.statementId, new Date(closesAt)]);
  t.mock.method(Date, 'now', () => now);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const slow = submitEvidence(s.db, s.config, { betId: fresh.bet.id, userId: creator.id, side: 'yes',
    url: 'https://example.org/slow', via: 'page', fetchPage: async (url) => {
      started.resolve(); await release.promise; return page(url);
    } });
  try {
    await Promise.race([started.promise, slow.then(() => assert.fail('The slow fetch should still be waiting.'))]);
    await s.db.tx((tx) => tx.query('select id from statements where id=$1 for update nowait', [fresh.statementId]));
    const fast = await submitEvidence(s.db, s.config, { betId: fresh.bet.id, userId: acceptor.id, side: 'no',
      url: 'https://example.org/fast', via: 'page', fetchPage: page });
    assert.equal(String(fast.user_id), String(acceptor.id));
    now = closesAt + 1;
    release.resolve();
    assert.equal((await slow).url, 'https://example.org/slow');
    await assert.rejects(submitEvidence(s.db, s.config, { betId: fresh.bet.id, userId: acceptor.id, side: 'no',
      url: 'https://example.org/too-late', via: 'page', fetchPage: page }), /Evidence is closed\./);
  } finally {
    release.resolve();
    await slow.catch(() => {});
  }
});

test('a timely queued reply must finish reading by close plus 120 seconds', async (t) => {
  let now = Date.now();
  t.mock.method(Date, 'now', () => now);
  for (const offset of [120_001, 120_000]) {
    const fresh = await freshEvidenceBet();
    const closesAt = now + 1000;
    await s.db.query('update enclave_plans set closes_at=$2 where statement_id=$1', [fresh.statementId, new Date(closesAt)]);
    const eventId = `read-cutoff-${randomUUID()}`;
    await s.db.query(`insert into evidence_commands (event_id,x_user_id,side,url,target_ref,created_at)
      values ($1,$2,'yes','https://example.org/read-cutoff',$3,$4)`,
    [eventId, creator.x_user_id, fresh.thread.id, new Date(closesAt - 1)]);
    const result = await runEvidenceCommands(s.db, s.config, { fetchPage: async (url) => {
      now = closesAt + offset;
      return page(url);
    } });
    const command = await s.db.one('select status, detail from evidence_commands where event_id=$1', [eventId]);
    const stored = await s.db.one('select * from bet_evidence where event_id=$1', [eventId]);
    if (offset > 120_000) {
      assert.equal(result.refused, 1);
      assert.equal(command.status, 'refused');
      assert.equal(command.detail, 'Evidence is closed.');
      assert.equal(stored, null);
    } else {
      assert.equal(result.done, 1);
      assert.equal(command.status, 'done');
      assert.ok(stored);
      // A retry reuses the saved text even after the read cutoff.
      now = closesAt + 150_000;
      const duplicate = await submitEvidence(s.db, s.config, { betId: fresh.bet.id, userId: creator.id,
        side: 'yes', url: stored.url, via: 'reply', eventId,
        fetchPage: () => assert.fail('Stored evidence must not be fetched again.') });
      assert.equal(String(duplicate.id), String(stored.id));
    }
  }
});

test('an old arrival cannot start a page read after close plus 120 seconds', async (t) => {
  const fresh = await freshEvidenceBet();
  const closesAt = Date.now();
  await s.db.query('update enclave_plans set closes_at=$2 where statement_id=$1', [fresh.statementId, new Date(closesAt)]);
  t.mock.method(Date, 'now', () => closesAt + 120_001);
  await assert.rejects(submitEvidence(s.db, s.config, { betId: fresh.bet.id, userId: creator.id,
    side: 'yes', url: 'https://example.org/stale-arrival', via: 'page', receivedAt: closesAt - 1,
    fetchPage: () => assert.fail('The read cutoff has passed.') }), /Evidence is closed\./);
});

test('the evidence form keeps the request arrival time while its body is read', async (t) => {
  const fresh = await freshEvidenceBet();
  const closesAt = Date.now() + 1000;
  let now = closesAt - 1;
  await s.db.query('update enclave_plans set closes_at=$2 where statement_id=$1', [fresh.statementId, new Date(closesAt)]);
  t.mock.method(Date, 'now', () => now);
  let handler; let destination;
  registerBetEvidenceRoutes({ db: s.db, config: s.config, fetchPage: page,
    route(method, pattern, fn) { if (method === 'POST') handler = fn; },
    async needPost() { now = closesAt + 1; return new URLSearchParams({ side: 'yes', url: 'https://example.org/form-arrival' }); },
    csrfField: () => '', layout: async (ctx, title, body) => String(body),
    send: () => assert.fail('A timely request should be accepted.'),
    notFound: () => assert.fail('The bettor should have access.'),
    redirect(res, path) { destination = path; },
  });
  await handler({ params: [fresh.bet.id], user: creator, res: {} });
  assert.equal(destination, `/bets/${fresh.bet.id}/evidence`);
  assert.ok(await s.db.one('select id from bet_evidence where bet_id=$1', [fresh.bet.id]));
});

test('evidence settles after timely replies finish and ignores replies created after closing', async () => {
  const fresh = await freshEvidenceBet();
  const other = await freshEvidenceBet();
  const closesAt = Date.now();
  await s.db.query('update enclave_plans set closes_at=$2 where statement_id=$1', [fresh.statementId, new Date(closesAt)]);
  assert.equal(await evidenceSettled(s.db, fresh.statementId, closesAt + 149_999), false);
  assert.equal(await evidenceSettled(s.db, fresh.statementId, closesAt + 150_000), true);
  const offerId = `evidence-offer-${randomUUID()}`;
  await s.db.query(`insert into bet_commands (event_id,x_user_id,kind,side,bet_id,status)
    values ($1,$2,'bet','yes',$3,'done')`, [offerId, creator.x_user_id, fresh.bet.id]);
  const unrelatedId = `unrelated-${randomUUID()}`;
  await s.db.query(`insert into evidence_commands (event_id,x_user_id,side,url,target_ref)
    values ($1,$2,'yes','https://example.org/unrelated',$3)`, [unrelatedId, creator.x_user_id, other.thread.id]);
  try {
    assert.equal(await evidenceSettled(s.db, fresh.statementId, closesAt + 150_000), true);
    for (const target of [fresh.sourcePost.id, offerId, fresh.thread.id]) {
      const eventId = `pending-${randomUUID()}`;
      await s.db.query(`insert into evidence_commands (event_id,x_user_id,side,url,target_ref,attempts,created_at)
        values ($1,$2,'yes','https://example.org/pending',$3,1,$4)`, [eventId, acceptor.x_user_id, target, new Date(closesAt - 1)]);
      assert.equal(await evidenceSettled(s.db, fresh.statementId, closesAt + 150_000), false);
      for (const status of ['done', 'refused', 'failed']) {
        await s.db.query('update evidence_commands set status=$2 where event_id=$1', [eventId, status]);
        assert.equal(await evidenceSettled(s.db, fresh.statementId, closesAt + 150_000), true);
      }
      await s.db.query(`update evidence_commands set status='queued', created_at=$2 where event_id=$1`, [eventId, new Date(closesAt + 1)]);
      assert.equal(await evidenceSettled(s.db, fresh.statementId, closesAt + 150_000), true);
      await s.db.query(`update evidence_commands set status='refused' where event_id=$1`, [eventId]);
    }
    await s.db.query('delete from enclave_plans where statement_id=$1', [fresh.statementId]);
    assert.equal(await evidenceSettled(s.db, fresh.statementId, closesAt + 150_000), false);
  } finally {
    await s.db.query('delete from evidence_commands where event_id=$1', [unrelatedId]);
  }
});

test('bet evidence uses visible paragraphs instead of a longer JSON-LD article body', async () => {
  const fresh = await freshEvidenceBet();
  const visible = 'The public registry states that its decision has not yet been published.';
  const hidden = 'Hidden jury-only text claims that the event happened before the deadline. '.repeat(20);
  const source = `<html><head><title>Registry update</title><script type="application/ld+json">${JSON.stringify({ articleBody: hidden })}</script></head><body><p>${visible}</p></body></html>`;
  const url = 'https://example.org/hidden-body';
  assert.equal(extractArticle(source, url).paragraphsFrom, 'structured-data');
  assert.match(extractArticle(source, url).paragraphs.join('\n'), /Hidden jury-only text/);
  assert.deepEqual(extractArticle(source, url, { visibleOnly: true }).paragraphs, [visible]);
  const stored = await submitEvidence(s.db, s.config, { betId: fresh.bet.id, userId: creator.id,
    side: 'no', url, via: 'page', fetchPage: async () => ({ url, body: source }) });
  assert.equal(stored.body, visible);
  assert.equal(stored.body_hash, digest(visible));
  const noParagraphs = source.replace(`<p>${visible}</p>`, `<div>${hidden}</div>`);
  assert.deepEqual(extractArticle(noParagraphs, url, { visibleOnly: true }).paragraphs, []);
  await assert.rejects(submitEvidence(s.db, s.config, { betId: fresh.bet.id, userId: acceptor.id,
    side: 'yes', url, via: 'page', fetchPage: async () => ({ url, body: noParagraphs }) }), /That link could not be read\./);
});

test('visibleOnly ignores all JSON-LD fields and removes hidden elements including nested tails', () => {
  const visible = 'The registry published the complete decision before its deadline.';
  const source = `<html><head><title>Public title</title><script type="application/ld+json">${JSON.stringify({
    headline: 'Hidden headline', author: 'Hidden author', datePublished: '2026-01-01',
    articleBody: 'A hidden account contradicts the public registry decision. '.repeat(10),
  })}</script></head><body><article>
    <div hidden><div><p>Hidden nested paragraph about the event.</p></div><p>Hidden tail after a nested close.</p></div>
    <p hidden="false">The hidden attribute hides this paragraph despite its value.</p>
    <section aria-hidden="true"><p>An inaccessible paragraph contradicts the record.</p></section>
    <p aria-hidden=true>Another inaccessible paragraph contradicts the record.</p>
    <p data-hidden="true" title="hidden aria-hidden='true'">${visible}</p>
    <p aria-hidden="false">The public decision includes the published reasons.</p>
  </article></body></html>`;
  const extracted = extractArticle(source, 'https://example.org/visible', { visibleOnly: true });
  assert.equal(extracted.title, 'Public title');
  assert.equal(extracted.byline, null);
  assert.equal(extracted.publishedAt, null);
  assert.deepEqual(extracted.paragraphs, [visible, 'The public decision includes the published reasons.']);
  const normal = extractArticle(source, 'https://example.org/visible');
  assert.equal(normal.byline, 'Hidden author', 'ordinary article intake keeps its existing metadata rules');
});

test('the participant evidence page shows own Bets and public siblings while hiding unrelated private Bets', async () => {
  const fresh = await freshEvidenceBet();
  stranger = await completeSetup(s.db, stranger, { profileVisibility: 'private' });
  const siblings = [];
  for (const [owner, label] of [[creator, 'own-private'], [stranger, 'public-sibling'],
    [stranger, 'accepted-private'], [stranger, 'hidden-private']]) {
    const sibling = await createBet(s.db, owner, { requestId: randomUUID(), claim: fresh.bet.claim,
      criteria: fresh.bet.criteria, evidenceSourceUrl: 'https://example.org/result', creatorSide: 'yes', stakeNear: '0.1',
      acceptBy: future(86400000), resolveAt: future(172800000) });
    await s.db.query('update bilateral_bets set source_save_id=$2 where id=$1', [sibling.id, fresh.bet.source_save_id]);
    if (label === 'accepted-private') await s.db.query('update bilateral_bets set acceptor_user_id=$2 where id=$1', [sibling.id, creator.id]);
    if (label === 'public-sibling') await s.db.query(`insert into bilateral_bet_publications (bet_id,creator_user_id)
      values ($1,$2)`, [sibling.id, owner.id]);
    siblings.push({ sibling, owner, label });
  }
  for (const { sibling, owner, label } of [{ sibling: fresh.bet, owner: creator, label: 'this-bet' }, ...siblings]) {
    const body = `The public registry supplied ${label} evidence about this decision.`;
    await s.db.query(`insert into bet_evidence (statement_id,bet_id,user_id,side,url,final_url,title,body,body_hash,via)
      values ($1,$2,$3,'yes',$4,$5,$6,$7,$8,'page')`,
    [fresh.statementId, sibling.id, label === 'accepted-private' ? creator.id : owner.id, `https://posted.example.org/${label}`,
      `https://registry.example.net/${label}`, `${label} title`, body, digest(body)]);
  }
  const shown = await creatorBrowser.get(`/bets/${fresh.bet.id}/evidence`);
  assert.equal(shown.status, 200);
  for (const label of ['this-bet', 'own-private', 'public-sibling', 'accepted-private']) assert.ok(shown.text.includes(`${label} title`));
  assert.doesNotMatch(shown.text, /hidden-private/);
  assert.match(shown.text, /<span>registry\.example\.net<\/span>/);
  assert.match(shown.text, /<span class="quiet">posted as posted\.example\.org<\/span>/);
  assert.doesNotMatch(shown.text, /href="https:\/\/posted\.example\.org/);
  await s.db.query(`update bilateral_bet_publications set withdrawn_at=clock_timestamp() where bet_id=$1`, [siblings[1].sibling.id]);
  assert.doesNotMatch((await creatorBrowser.get(`/bets/${fresh.bet.id}/evidence`)).text, /public-sibling|hidden-private|ev_stranger/);
});

test('a stranger flood cannot delay a timely queued reply past its closing time', async () => {
  const fresh = await freshEvidenceBet();
  const bot = await s.x.identity();
  for (let i = 0; i < 8; i += 1) {
    const mention = s.fakeX.post(stranger.x_user_id, `@statedbot no https://example.org/flood-${i}`, { replyTo: fresh.thread.id });
    await processMention(s.db, s.config, { mention, includes: { tweets: [fresh.thread] }, bot });
    assert.equal(await s.db.one('select * from evidence_commands where event_id=$1', [mention.id]), null);
    assert.equal((await s.db.one('select reply_status from mention_events where event_id=$1', [mention.id])).reply_status, 'none');
    assert.equal((await s.db.one('select count(*)::int as n from bot_outbox where in_reply_to=$1', [mention.id])).n, 0);
  }
  const timely = s.fakeX.post(creator.x_user_id, '@statedbot yes https://example.org/timely', { replyTo: fresh.thread.id });
  const late = s.fakeX.post(acceptor.x_user_id, '@statedbot no https://example.org/late', { replyTo: fresh.thread.id });
  for (const mention of [timely, late]) await processMention(s.db, s.config, { mention, includes: { tweets: [fresh.thread] }, bot });
  await s.db.query(`update evidence_commands set created_at=clock_timestamp()-interval '2 minutes' where event_id=$1`, [timely.id]);
  await s.db.query(`update enclave_plans set closes_at=clock_timestamp()-interval '1 minute' where statement_id=$1`, [fresh.statementId]);
  assert.deepEqual(await runEvidenceCommands(s.db, s.config, { limit: 1, fetchPage: page }), { done: 1, refused: 0, retry: 0, failed: 0 });
  assert.equal((await s.db.one('select event_id from bet_evidence where bet_id=$1', [fresh.bet.id])).event_id, timely.id);
  assert.deepEqual(await runEvidenceCommands(s.db, s.config, { limit: 1, fetchPage: page }), { done: 0, refused: 1, retry: 0, failed: 0 });
  assert.equal((await s.db.one('select detail from evidence_commands where event_id=$1', [late.id])).detail, 'Evidence is closed.');
});

test('concurrent evidence replies share one sender cap across every target on a post', async (t) => {
  const fresh = await freshEvidenceBet();
  const otherPost = await freshEvidenceBet();
  const commandPost = s.fakeX.post(creator.x_user_id, '@statedbot bet yes', { replyTo: fresh.sourcePost.id });
  await s.db.query(`insert into bet_commands (event_id,x_user_id,kind,side,bet_id,status)
    values ($1,$2,'bet','yes',$3,'done')`, [commandPost.id, creator.x_user_id, fresh.bet.id]);
  const targets = [fresh.thread, fresh.sourcePost, commandPost];
  const bot = await s.x.identity();
  const events = [];
  t.after(() => s.db.query('delete from evidence_commands where event_id=any($1::text[])', [events.map((event) => event.id)]));
  async function intake(user, target, index) {
    const mention = s.fakeX.post(user.x_user_id, `@statedbot yes https://example.org/cap-${index}`, { replyTo: target.id });
    events.push(mention);
    await processMention(s.db, s.config, { mention, includes: { tweets: [target] }, bot });
    return mention;
  }
  await Promise.all(Array.from({ length: 6 }, (_, i) => intake(creator, targets[i % targets.length], i)));
  assert.equal((await s.db.one(`select count(*)::int as n from evidence_commands
    where x_user_id=$1 and target_ref=any($2::text[]) and status='queued'`, [creator.x_user_id, targets.map((target) => target.id)])).n, 4);
  const otherBettor = await intake(acceptor, fresh.thread, 'other-bettor');
  const otherStatement = await intake(creator, otherPost.thread, 'other-post');
  for (const mention of [otherBettor, otherStatement]) {
    assert.equal((await s.db.one('select status from evidence_commands where event_id=$1', [mention.id])).status, 'queued');
  }
  const dropped = await s.db.many(`select m.event_id, m.reply_status from mention_events m
    where m.event_id=any($1::text[]) and not exists (select 1 from evidence_commands e where e.event_id=m.event_id)`, [events.map((event) => event.id)]);
  assert.equal(dropped.length, 2);
  assert.ok(dropped.every((event) => event.reply_status === 'none'));
});

test('late evidence replies are ignored without queueing or replying, with or without a plan', async () => {
  const bot = await s.x.identity();
  for (const planned of [true, false]) {
    const fresh = await freshEvidenceBet();
    if (planned) {
      await s.db.query(`update enclave_plans set closes_at=clock_timestamp()-interval '1 second' where statement_id=$1`, [fresh.statementId]);
    } else {
      await s.db.query('delete from enclave_plans where statement_id=$1', [fresh.statementId]);
      await s.db.query(`update bilateral_bets set accept_by=clock_timestamp()-make_interval(secs=>$2)-interval '1 day',
        resolve_at=clock_timestamp()-make_interval(secs=>$2)-interval '1 second' where id=$1`,
        [fresh.bet.id, s.config.play.evidenceWindowSeconds]);
    }
    for (const target of [fresh.thread, fresh.sourcePost]) {
      const mention = s.fakeX.post(creator.x_user_id, '@statedbot yes https://example.org/late-intake',
        { replyTo: target.id, at: new Date(Date.now() - 86400000) });
      const result = await processMention(s.db, s.config, { mention, includes: { tweets: [target] }, bot });
      assert.equal(result.outcome, 'ignored_evidence');
      assert.equal(await s.db.one('select event_id from evidence_commands where event_id=$1', [mention.id]), null);
      assert.equal(result.event.reply_status, 'none');
      assert.equal(result.event.reply_text, null);
      assert.equal((await s.db.one('select count(*)::int as n from bot_outbox where in_reply_to=$1', [mention.id])).n, 0);
    }
  }
});

test('the queue selects one oldest command per sender before a sender gets a second turn', async (t) => {
  const fresh = await freshEvidenceBet();
  const ids = Array.from({ length: 3 }, () => `fair-${randomUUID()}`);
  t.after(() => s.db.query('delete from evidence_commands where event_id=any($1::text[])', [ids]));
  for (const [i, id] of ids.entries()) {
    await s.db.query(`insert into evidence_commands (event_id,x_user_id,side,url,target_ref,created_at)
      values ($1,$2,'yes',$3,$4,clock_timestamp()-make_interval(secs=>$5))`,
    [id, i < 2 ? creator.x_user_id : acceptor.x_user_id, `https://example.org/fair-${i}`, fresh.thread.id, 10 - i]);
  }
  const result = await runEvidenceCommands(s.db, s.config, { limit: 2, fetchPage: page });
  assert.deepEqual(result, { done: 2, refused: 0, retry: 0, failed: 0 });
  const stored = await s.db.many('select event_id from bet_evidence where bet_id=$1', [fresh.bet.id]);
  assert.deepEqual(stored.map((row) => row.event_id).sort(), [ids[0], ids[2]].sort());
  assert.equal((await s.db.one('select status from evidence_commands where event_id=$1', [ids[1]])).status, 'queued');
});

test('twenty simultaneous submissions reserve at most two fetches and stored links', async () => {
  const fresh = await freshEvidenceBet();
  const release = Promise.withResolvers();
  const twoStarted = Promise.withResolvers();
  const eighteenRefused = Promise.withResolvers();
  let started = 0; let refused = 0;
  const submissions = Array.from({ length: 20 }, (_, i) => submitEvidence(s.db, s.config, {
    betId: fresh.bet.id, userId: creator.id, side: 'yes', via: 'page', url: `https://example.org/race-${i}`,
    fetchPage: async (url) => {
      started += 1;
      if (started === 2) twoStarted.resolve();
      await release.promise;
      return page(url);
    },
  }).catch((error) => {
    if (error instanceof UserError && /at most two links/.test(error.message)) {
      refused += 1;
      if (refused === 18) eighteenRefused.resolve();
    }
    throw error;
  }));
  const results = Promise.allSettled(submissions);
  let timer;
  try {
    await Promise.race([Promise.all([twoStarted.promise, eighteenRefused.promise]), new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('Submissions did not enforce the pre-fetch cap.')), 5000);
    })]);
    assert.equal(started, 2);
    assert.equal((await s.db.one('select count(*)::int as n from bet_evidence_reservations where bet_id=$1', [fresh.bet.id])).n, 2);
    assert.equal((await s.db.one('select count(*)::int as n from bet_evidence where bet_id=$1', [fresh.bet.id])).n, 0);
  } finally {
    clearTimeout(timer);
    release.resolve();
    await results;
  }
  const settled = await results;
  assert.equal(settled.filter((item) => item.status === 'fulfilled').length, 2);
  assert.equal(settled.filter((item) => item.status === 'rejected').length, 18);
  assert.equal(started, 2);
  assert.equal((await s.db.one('select count(*)::int as n from bet_evidence where bet_id=$1', [fresh.bet.id])).n, 2);
  assert.equal((await s.db.one('select count(*)::int as n from bet_evidence_reservations where bet_id=$1', [fresh.bet.id])).n, 0);
});

test('a failed fetch releases its reservation and concurrent duplicates do not fetch again', async () => {
  const fresh = await freshEvidenceBet();
  const args = { betId: fresh.bet.id, userId: creator.id, side: 'yes', via: 'page', url: 'https://example.org/reserved' };
  await assert.rejects(submitEvidence(s.db, s.config, { ...args, fetchPage: async () => { throw new Error('offline'); } }), /could not be read/);
  assert.equal((await s.db.one('select count(*)::int as n from bet_evidence_reservations where bet_id=$1', [fresh.bet.id])).n, 0);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const first = submitEvidence(s.db, s.config, { ...args, fetchPage: async (url) => {
    started.resolve(); await release.promise; return page(url);
  } });
  try {
    await started.promise;
    await assert.rejects(submitEvidence(s.db, s.config, { ...args,
      fetchPage: () => assert.fail('A pending duplicate must not fetch.') }), /That link is being read/);
  } finally {
    release.resolve();
    await first;
  }
  const stored = await submitEvidence(s.db, s.config, { ...args,
    fetchPage: () => assert.fail('A stored duplicate must not fetch.') });
  assert.equal(stored.url, args.url);
});

test('expired crash reservations are reclaimed and a stale owner cannot complete', async () => {
  const fresh = await freshEvidenceBet();
  const args = { betId: fresh.bet.id, userId: creator.id, side: 'yes', via: 'page' };
  const oldId = randomUUID();
  await s.db.query(`insert into bet_evidence_reservations (id,statement_id,bet_id,user_id,url,expires_at)
    values ($1,$2,$3,$4,'https://example.org/crashed',clock_timestamp()-interval '1 second')`,
  [oldId, fresh.statementId, fresh.bet.id, creator.id]);
  const started = Promise.withResolvers();
  const release = Promise.withResolvers();
  const stale = submitEvidence(s.db, s.config, { ...args, url: 'https://example.org/stale', fetchPage: async (url) => {
    started.resolve(); await release.promise; return page(url);
  } });
  // Attach the rejection handler before releasing the paused reader.
  const rejected = assert.rejects(stale, /That evidence read expired/);
  try {
    await started.promise;
    assert.equal(await s.db.one('select id from bet_evidence_reservations where id=$1', [oldId]), null);
    await s.db.query(`update bet_evidence_reservations set expires_at=clock_timestamp()-interval '1 second' where bet_id=$1`, [fresh.bet.id]);
    for (const suffix of ['replacement-one', 'replacement-two']) {
      await submitEvidence(s.db, s.config, { ...args, url: `https://example.org/${suffix}`, fetchPage: page });
    }
  } finally {
    release.resolve();
    await rejected;
  }
  assert.equal((await s.db.one('select count(*)::int as n from bet_evidence where bet_id=$1', [fresh.bet.id])).n, 2);
  assert.equal((await s.db.one('select count(*)::int as n from bet_evidence_reservations where bet_id=$1', [fresh.bet.id])).n, 0);
});

test('six page reads can run together while a seventh waits for a slot', async (t) => {
  // Separate posts exercise the worker's global network bound without
  // bypassing the two-reservations-per-person-per-post bound.
  const posts = await Promise.all(Array.from({ length: 4 }, () => freshEvidenceBet()));
  const ids = Array.from({ length: 7 }, () => `parallel-${randomUUID()}`);
  t.after(() => s.db.query('delete from evidence_commands where event_id=any($1::text[])', [ids]));
  for (const [i, id] of ids.entries()) {
    await s.db.query(`insert into evidence_commands (event_id,x_user_id,side,url,target_ref)
      values ($1,$2,'yes',$3,$4)`, [id, i % 2 ? creator.x_user_id : acceptor.x_user_id,
      `https://example.org/parallel-${i}`, posts[Math.floor(i / 2)].thread.id]);
  }
  const sixStarted = Promise.withResolvers();
  const release = Promise.withResolvers();
  let active = 0; let peak = 0; let started = 0;
  const running = runEvidenceCommands(s.db, s.config, { limit: 7, fetchPage: async () => {
    started += 1;
    active += 1;
    peak = Math.max(peak, active);
    if (started === 6) sixStarted.resolve();
    await release.promise;
    active -= 1;
    throw new Error('Unreadable fixture');
  } });
  try {
    await Promise.race([sixStarted.promise, new Promise((_, reject) => {
      const timer = setTimeout(() => reject(new Error('Six reads did not start concurrently.')), 2000);
      sixStarted.promise.then(() => clearTimeout(timer));
    })]);
    assert.equal(started, 6);
    assert.equal(peak, 6);
  } finally {
    release.resolve();
    const result = await running;
    assert.equal(result.refused, 7);
  }
  assert.equal(started, 7);
  assert.equal(peak, 6);
});

test('two slow attacker links cannot use up the timely opponent read window', async (t) => {
  const fresh = await freshEvidenceBet();
  const closesAt = Date.now();
  let now = closesAt + 119_000;
  t.mock.method(Date, 'now', () => now);
  await s.db.query('update enclave_plans set closes_at=$2 where statement_id=$1', [fresh.statementId, new Date(closesAt)]);
  const ids = Array.from({ length: 3 }, () => `slow-queue-${randomUUID()}`);
  t.after(() => s.db.query('delete from evidence_commands where event_id=any($1::text[])', [ids]));
  for (const [i, id] of ids.entries()) {
    await s.db.query(`insert into evidence_commands (event_id,x_user_id,side,url,target_ref,created_at)
      values ($1,$2,'yes',$3,$4,$5)`, [id, i < 2 ? creator.x_user_id : acceptor.x_user_id,
      `https://example.org/slow-queue-${i}`, fresh.thread.id, new Date(closesAt - 10 + i)]);
  }
  const opponentRead = Promise.withResolvers();
  const result = await runEvidenceCommands(s.db, s.config, { fetchPage: async (url) => {
    if (url.endsWith('-2')) {
      opponentRead.resolve();
      return page(url);
    }
    // Wait until the opponent's read has started: a runner that reads links one at a time never
    // starts it, and fails here. A wall-clock fallback made this test flaky under load.
    let timer;
    await Promise.race([opponentRead.promise, new Promise((_, reject) => {
      timer = setTimeout(() => reject(new Error('The opponent read never started.')), 5000);
    })]).finally(() => clearTimeout(timer));
    // The opponent's read time is taken on a microtask after its fetch resolves; this runs after it.
    await new Promise((resolve) => setImmediate(resolve));
    now = closesAt + 120_001;
    return page(url);
  } });
  assert.deepEqual(result, { done: 1, refused: 2, retry: 0, failed: 0 });
  assert.equal((await s.db.one('select event_id from bet_evidence where bet_id=$1', [fresh.bet.id])).event_id, ids[2]);
});

test('one ten-second deadline covers the entire evidence redirect chain', async (t) => {
  const fresh = await freshEvidenceBet();
  const timeout = AbortSignal.timeout;
  const durations = [];
  let signal;
  t.mock.method(AbortSignal, 'timeout', (ms) => {
    durations.push(ms);
    signal = timeout(250);
    return signal;
  });
  await assert.rejects(submitEvidence(s.db, s.config, { betId: fresh.bet.id, userId: creator.id,
    side: 'yes', url: `${fixtureBase}/deadline-redirect-0`, via: 'page' }), /That link could not be read\./);
  assert.deepEqual(durations, [10_000]);
  assert.equal(signal.aborted, true);
  assert.equal((await s.db.one('select count(*)::int as n from bet_evidence where bet_id=$1', [fresh.bet.id])).n, 0);
});

test('evidence titles use title or og:title and never a JSON-LD headline', async () => {
  const fresh = await freshEvidenceBet();
  for (const [i, head, title] of [
    [0, '<title>Visible title</title>', 'Visible title'],
    [1, '<meta property="og:title" content="Public metadata title">', 'Public metadata title'],
    [2, '', null],
  ]) {
    const source = `<html><head>${head}<script type="application/ld+json">{"headline":"Hidden headline"}</script></head><body><p>The registry has published its official decision.</p></body></html>`;
    const url = `https://example.org/title-${i}`;
    assert.equal(extractArticle(source, url, { visibleOnly: true }).title, title);
    const stored = await submitEvidence(s.db, s.config, { betId: fresh.bet.id, userId: i < 2 ? creator.id : acceptor.id,
      side: 'yes', url, via: 'page', fetchPage: async () => ({ url, body: source }) });
    assert.equal(stored.title, title);
  }
  assert.equal(extractArticle('<script type="application/ld+json">{"headline":"Article headline"}</script>', 'https://example.org').title, 'Article headline');
});

test('redirects preserve the final URL and original title and refuse X or private destinations', async () => {
  const fresh = await freshEvidenceBet();
  const args = { betId: fresh.bet.id, userId: creator.id, side: 'yes', via: 'page' };
  const finalUrl = 'https://registry.example.net/decision?case=A&view=full';
  const visible = 'The official record contains &lt;img src=x onerror=alert(1)&gt; &amp; confirms the published decision.';
  const crossHost = await submitEvidence(s.db, s.config, { ...args, url: 'https://example.org/redirect',
    fetchPage: async () => ({ url: finalUrl, body: `<html><head><title>Official &lt;result&gt;</title></head><body><p>${visible}</p></body></html>` }) });
  assert.equal(crossHost.url, 'https://example.org/redirect');
  assert.equal(crossHost.final_url, finalUrl);
  assert.equal(crossHost.title, 'Official <result>');
  const redirected = await submitEvidence(s.db, s.config, { ...args, userId: acceptor.id, url: `${fixtureBase}/redirect-result` });
  assert.equal(redirected.url, `${fixtureBase}/redirect-result`);
  assert.equal(redirected.final_url, `${fixtureBase}/result`);
  assert.equal(redirected.title, 'Official result');
  for (const path of ['/redirect-x', '/redirect-twitter', '/redirect-private']) {
    await assert.rejects(submitEvidence(s.db, s.config, { ...args, url: `${fixtureBase}${path}` }), /That link could not be read\./);
  }
  assert.equal((await s.db.one('select count(*)::int as n from bet_evidence where statement_id=$1', [fresh.statementId])).n, 2);
  const acceptorBrowser = await s.signIn(s.fakeX.users.get(String(acceptor.x_user_id)));
  for (const browser of [creatorBrowser, acceptorBrowser]) {
    const shown = await browser.get(`/bets/${fresh.bet.id}/evidence`);
    assert.equal(shown.status, 200);
    assert.ok(shown.text.includes(`<a class="tl" href="${esc(finalUrl)}" rel="noopener noreferrer">Official &lt;result&gt;</a>`));
    assert.doesNotMatch(shown.text, /href="https:\/\/example\.org\/redirect"/);
    assert.match(shown.text, /<span>registry\.example\.net<\/span>/);
    assert.match(shown.text, /<span class="quiet">posted as example\.org<\/span>/);
    assert.doesNotMatch(shown.text, /posted as 127\.0\.0\.1/);
    assert.match(shown.text, browser === creatorBrowser ? /<b>You bet yes<\/b>/ : /<b>@ev_creator bet yes<\/b>/);
    assert.match(shown.text, /@ev_creator/);
    assert.match(shown.text, browser === acceptorBrowser ? /<b>You bet no<\/b>/ : /@ev_acceptor/);
    assert.equal((shown.text.match(/<summary>What the jury reads<\/summary>/g) || []).length, 1);
    assert.ok(shown.text.indexOf('id="evidence-url"') < shown.text.indexOf('<ul class="posts evidence-list">'));
    assert.doesNotMatch(shown.text.match(/<ul class="posts evidence-list">([\s\S]*?)<\/ul>/)?.[1] || '', /class="face/);
    for (const row of [crossHost, redirected]) {
      assert.ok(shown.text.includes(row.body.split('\n\n').map(text => `<p>${esc(text)}</p>`).join('')));
    }
    assert.doesNotMatch(shown.text, /<img src=x|<result>/);
    assert.equal((shown.text.match(/<button class="primary big"/g) || []).length, 1);
  }
});

test('only accepted, proposed or disputed Bets accept evidence from a reply or form', async () => {
  const fresh = await freshEvidenceBet();
  const terminal = await createBet(s.db, creator, { requestId: randomUUID(), claim: fresh.bet.claim,
    criteria: fresh.bet.criteria, evidenceSourceUrl: 'https://example.org/result', creatorSide: 'yes', stakeNear: '0.1',
    sourceSaveId: String(fresh.bet.source_save_id), acceptBy: future(86400000), resolveAt: future(172800000) });
  await s.db.query(`update bilateral_bets set acceptor_user_id=$2, accepted_at=clock_timestamp(),
    referee_wallet='referee.testnet', chain_state='{}' where id=$1`, [terminal.id, acceptor.id]);
  const terminalThread = s.fakeX.post('500', 'Closed evidence thread');
  await s.db.query(`insert into bot_outbox (dedupe_key,in_reply_to,body,bet_id,status,post_id)
    values ($1,$2,'Closed evidence thread',$3,'sent',$4)`, [`offer:${terminal.id}`, fresh.sourcePost.id, terminal.id, terminalThread.id]);
  const bot = await s.x.identity();
  for (const status of ['settled', 'cancelled', 'expired', 'refunded', 'offered']) {
    await s.db.query('update bilateral_bets set status=$2 where id=$1', [terminal.id, status]);
    const found = await targetEvidenceBet(s.db, { target_ref: fresh.sourcePost.id, x_user_id: creator.x_user_id });
    assert.equal(found.id, fresh.bet.id);
    assert.equal(await targetEvidenceBet(s.db, { target_ref: terminalThread.id, x_user_id: creator.x_user_id }), null);
    const mention = s.fakeX.post(creator.x_user_id, `@statedbot yes https://example.org/${status}`, { replyTo: terminalThread.id });
    await processMention(s.db, s.config, { mention, includes: { tweets: [terminalThread] }, bot });
    assert.equal(await s.db.one('select event_id from evidence_commands where event_id=$1', [mention.id]), null);
    await assert.rejects(submitEvidence(s.db, s.config, { betId: terminal.id, userId: creator.id,
      side: 'yes', url: `https://example.org/${status}`, via: 'page', fetchPage: page }), /Evidence is closed\./);
    const path = `/bets/${terminal.id}/evidence`;
    const shown = await creatorBrowser.get(path);
    assert.equal(shown.status, 200);
    assert.doesNotMatch(shown.text, /Add a link<\/button>|name="url"/);
    const refused = await creatorBrowser.submit(path, { side: 'yes', url: `https://example.org/${status}` }, { from: path });
    assert.match(refused.text, /Links are closed\./);
  }
  for (const [index, status] of ['accepted', 'proposed', 'disputed'].entries()) {
    const bettor = index === 1 ? acceptor : creator;
    await s.db.query('update bilateral_bets set status=$2 where id=$1', [fresh.bet.id, status]);
    assert.equal((await targetEvidenceBet(s.db, { target_ref: fresh.sourcePost.id, x_user_id: bettor.x_user_id })).id, fresh.bet.id);
    const stored = await submitEvidence(s.db, s.config, { betId: fresh.bet.id, userId: bettor.id,
      side: 'yes', url: `https://example.org/${status}`, via: 'page', fetchPage: page });
    assert.equal(stored.bet_id, fresh.bet.id);
  }
});
