// A public deployment: what the server refuses to start with, what stays off
// until it is asked for, how it stops, and where a new person lands.
// INTEGRATION for the process tests: the real entry point and a temporary Postgres.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import net from 'node:net';
import { resolve } from 'node:path';
import { assertHostedConfig, loadConfig } from '../src/config.mjs';
import { createBet } from '../src/bets.mjs';
import { tick } from '../src/worker.mjs';
import { startPostgres } from './support/pg.mjs';
import { startStack } from './support/app.mjs';

const MAIN = resolve(import.meta.dirname, '../src/main.mjs');
const KEY = 'k'.repeat(44);
const hosted = (extra = {}) => loadConfig({
  RAILWAY_ENVIRONMENT: 'production', PORT: '8080', STATED_BASE_URL: 'https://stated.example', DATABASE_URL: 'postgres://u:p@db.internal:5432/stated',
  STATED_TOKEN_KEY: KEY, X_CLIENT_ID: 'client', ...extra,
});

test('the X worker, replies and direct messages are all off unless each is asked for', () => {
  const quiet = loadConfig({});
  assert.equal(quiet.worker.enabled, false, 'an unset STATED_WORKER no longer polls');
  assert.equal(quiet.x.repliesEnabled, false);
  assert.equal(quiet.x.dmEnabled, false);
  assert.equal(loadConfig({ STATED_WORKER: '0' }).worker.enabled, false);
  assert.equal(loadConfig({ STATED_WORKER: 'true' }).worker.enabled, false, 'only the literal 1 turns it on');
  assert.equal(loadConfig({ STATED_WORKER: '1' }).worker.enabled, true);
  assert.equal(quiet.hosted, false);
  assert.equal(loadConfig({ STATED_HOSTED: '1' }).hosted, true);
  assert.equal(loadConfig({ RAILWAY_ENVIRONMENT: 'production' }).hosted, true);
});

test('a hosted server refuses a configuration that would break sign-in or cookies, and names each setting', () => {
  assert.doesNotThrow(() => assertHostedConfig(loadConfig({})), 'a local run is never checked');
  assert.doesNotThrow(() => assertHostedConfig(hosted()));
  assert.equal(hosted().secureCookies, true);
  assert.equal(hosted().x.redirectUri, 'https://stated.example/callback');
  const refused = (extra, pattern) => assert.throws(() => assertHostedConfig(hosted(extra)), pattern);
  refused({ STATED_BASE_URL: '' }, /STATED_BASE_URL must be the public https origin/);
  refused({ STATED_BASE_URL: 'http://stated.example' }, /STATED_BASE_URL/);
  refused({ STATED_BASE_URL: 'https://localhost:8080' }, /STATED_BASE_URL/);
  refused({ X_REDIRECT_URI: 'http://localhost:8080/callback' }, /X_REDIRECT_URI must be STATED_BASE_URL\/callback/);
  refused({ X_REDIRECT_URI: 'https://stated.example/oauth' }, /X_REDIRECT_URI/);
  refused({ STATED_TOKEN_KEY: 'short' }, /STATED_TOKEN_KEY must be at least 32 bytes/);
  refused({ DATABASE_URL: 'postgres://postgres@127.0.0.1:5432/stated' }, /DATABASE_URL points at this machine/);
  assert.throws(() => assertHostedConfig(hosted({ STATED_BASE_URL: 'http://x.example', STATED_TOKEN_KEY: 'short' })),
    (error) => /STATED_BASE_URL/.test(error.message) && /STATED_TOKEN_KEY/.test(error.message), 'every problem is listed at once');
});

const run = (env) => new Promise((done) => {
  const child = spawn(process.execPath, [MAIN], { env: { PATH: process.env.PATH, LC_ALL: 'en_US.UTF-8', ...env } });
  let out = '';
  child.stdout.on('data', (d) => { out += d; });
  child.stderr.on('data', (d) => { out += d; });
  child.on('exit', (code) => done({ code, out }));
  run.last = child;
});

test('the real entry point exits before it listens or touches a database when the hosted configuration is wrong', { timeout: 15000 }, async () => {
  const result = await run({ RAILWAY_ENVIRONMENT: 'production', PORT: '1', DATABASE_URL: 'postgres://u:p@db.invalid:5432/x',
    STATED_TOKEN_KEY: KEY, X_CLIENT_ID: 'client', STATED_BASE_URL: 'http://localhost:8080' });
  assert.notEqual(result.code, 0);
  assert.match(result.out, /Hosted configuration refused/);
  assert.match(result.out, /STATED_BASE_URL must be the public https origin/);
  assert.doesNotMatch(result.out, /Stated on /, 'never reached listen');
  assert.doesNotMatch(result.out, /ENOTFOUND|ECONNREFUSED/, 'never tried the database');
});

async function freePort() {
  const server = net.createServer();
  await new Promise((ok, fail) => server.once('error', fail).listen(0, '127.0.0.1', ok));
  const { port } = server.address();
  await new Promise((ok) => server.close(ok));
  return port;
}

test('the real entry point starts with the worker off, answers /healthz, and stops cleanly on SIGTERM', { timeout: 30000 }, async () => {
  const pg = await startPostgres();
  try {
    const port = await freePort();
    const exited = run({ PORT: String(port), STATED_BASE_URL: `http://127.0.0.1:${port}`, DATABASE_URL: pg.url,
      STATED_TOKEN_KEY: KEY, X_CLIENT_ID: 'client' });
    const child = run.last;
    let health = null;
    for (let i = 0; i < 80 && !health; i += 1) {
      try { health = await fetch(`http://127.0.0.1:${port}/healthz`); } catch { await new Promise((ok) => setTimeout(ok, 150)); }
    }
    assert.equal(health?.status, 200);
    assert.deepEqual(await health.json(), { ok: true });
    const home = await fetch(`http://127.0.0.1:${port}/`);
    assert.match(home.headers.get('content-security-policy') || '', /default-src 'none'|default-src 'self'/);
    assert.equal((await fetch(`http://127.0.0.1:${port}/privacy`)).status, 200);
    child.kill('SIGTERM');
    const result = await exited;
    assert.equal(result.code, 0, result.out);
    assert.match(result.out, /X worker off: no mention polling/);
    assert.doesNotMatch(result.out, /Worker polling mentions/);
    await assert.rejects(fetch(`http://127.0.0.1:${port}/healthz`), 'the port is closed');
  } finally {
    pg.stop();
  }
});

// ---- The first encounter and the invitation loop, against the test stack ----

let s; let admin; let adminB;
const NEXT = new Date().getUTCFullYear() + 1;

before(async () => {
  s = await startStack();
  const bot = s.fakeX.addUser('500', 'statedbot');
  await s.connectBot(bot);
  admin = s.fakeX.addUser('900', 'reviewer');
  adminB = await s.signIn(admin);
  await adminB.submit('/setup', { profile: 'private', defaults: 'private' });
});
after(async () => { await s?.close(); });

test('someone who tagged the bot once and then signs in lands on that Prediction, after one button', async () => {
  const nina = s.fakeX.addUser('8101', 'nina');
  const post = s.fakeX.post(nina.id, `Copper will top $6 by June 30, ${NEXT}.`);
  s.fakeX.post(nina.id, '@statedbot', { replyTo: post.id });
  await tick(s.db, s.config, s.x);
  const b = await s.signIn(nina);
  assert.match(b.lastPage.url, /\/setup$/);
  const page = b.lastPage.text;
  assert.match(page, /<h1>You’re in, @nina<\/h1>/);
  assert.match(page, /The post you saved by tagging @statedbot is waiting\. Your profile starts private\./);
  assert.equal((page.match(/<button class="primary big" type="submit">Finish setup and show my post<\/button>/g) || []).length, 1);
  assert.equal((page.match(/<button/g) || []).length - (page.match(/<button class="primary big"/g) || []).length <= 1, true, 'one filled button besides sign-out');
  assert.match(page, /<input type="hidden" name="show" value="1">/);
  assert.ok(page.indexOf('show my post</button>') < page.indexOf('<summary>Choose what is public</summary>'), 'the choices sit below the button, folded');
  assert.match(page, /id="pv-private" name="profile" value="private" checked/);
  assert.match(page, /id="dv-private" name="defaults" value="private" checked/);
  assert.doesNotMatch(page, /name="publish" value="\d+" checked/, 'nothing is pre-ticked for publication');
  assert.doesNotMatch(page, /name="dm"/, 'no switch for direct messages while they are off');
  // The one button posts the private defaults that are already chosen.
  const oembed = () => s.fakeX.calls.filter((c) => c.path === '/oembed').length;
  const before = oembed();
  const landed = await b.submit('/setup', { profile: 'private', defaults: 'private', return: '/me', show: '1' });
  const save = await s.db.one('select id, visibility from saves where owner_x_user_id = $1', [nina.id]);
  assert.equal(new URL(landed.url).pathname, `/me/s/${save.id}`);
  assert.match(landed.text, /<p class="stakes left" role="status">Saved from your reply on X\.<\/p>/, 'said plainly, without a box');
  // The button said it would show the post, so its words are read once, for this one post, and not stored.
  assert.match(landed.text, /Copper will top \$6 by June 30/);
  assert.equal(oembed(), before + 1);
  const stored = await s.db.one(`select st.span, src.title, src.text as source_text from statements st join saves sv on sv.statement_id = st.id
    join sources src on src.id = st.source_id where sv.id = $1`, [save.id]);
  assert.doesNotMatch(JSON.stringify(stored), /Copper will top/, 'the private post’s words are still not in the database');
  await b.get(`/me/s/${save.id}`);
  assert.equal(oembed(), before + 1, 'opening the page again asks X for nothing');
  assert.equal(save.visibility, 'private');
  const user = await s.db.one('select profile_visibility, setup_completed_at from users where x_user_id = $1', [nina.id]);
  assert.equal(user.profile_visibility, 'private');
  assert.ok(user.setup_completed_at);
  assert.equal((await s.browser().get(`/u/nina/${save.id}`)).status, 404, 'still private to everyone else');
});

test('an explicit destination survives setup, and several saves land on the list', async () => {
  const omar = s.fakeX.addUser('8102', 'omar');
  const post = s.fakeX.post(omar.id, `Tin will top $40k by June 30, ${NEXT}.`);
  s.fakeX.post(omar.id, '@statedbot', { replyTo: post.id });
  await tick(s.db, s.config, s.x);
  const b = s.browser();
  s.fakeX.consentAs = omar.id;
  await b.get(`/signin/x?return=${encodeURIComponent('/desk')}`);
  s.fakeX.consentAs = null;
  assert.match(b.lastPage.text, /name="return" value="\/desk"/);
  const landed = await b.submit('/setup', { profile: 'private', defaults: 'private', return: '/desk' });
  assert.equal(new URL(landed.url).pathname, '/desk');

  const pia = s.fakeX.addUser('8103', 'pia');
  for (const text of [`Lead will top $3k by June 30, ${NEXT}.`, `Zinc will top $4k by June 30, ${NEXT}.`]) {
    const p = s.fakeX.post(pia.id, text);
    s.fakeX.post(pia.id, '@statedbot', { replyTo: p.id });
  }
  await tick(s.db, s.config, s.x);
  const pb = await s.signIn(pia);
  assert.match(pb.lastPage.text, /2 posts you saved by tagging @statedbot are waiting\./);
  const list = await pb.submit('/setup', { profile: 'private', defaults: 'private', return: '/me' });
  assert.equal(new URL(list.url).pathname, '/me');
});

test('the metrics count the invitation loop from stored Bets, follows and public Bet page visits', async () => {
  const metric = async () => JSON.parse((await adminB.get('/admin/metrics.json')).text).bets;
  const zero = await metric();
  assert.deepEqual(Object.keys(zero), ['offered', 'funded', 'published', 'pageViews', 'follows', 'followsByNewAccount', 'accepted', 'acceptedByNewAccount', 'settled']);
  const maker = await s.db.one('select * from users where x_user_id = $1', ['8101']);
  const bet = await createBet(s.db, maker, { requestId: randomUUID(), claim: 'Copper tops $6 by 30 June.', criteria: 'The named source says so.',
    evidenceSourceUrl: 'https://example.org/result', creatorSide: 'yes', stakeNear: '0.1',
    acceptBy: new Date(Date.now() + 86400000).toISOString(), resolveAt: new Date(Date.now() + 30 * 86400000).toISOString() });
  let now = await metric();
  assert.equal(now.offered, zero.offered + 1);
  assert.equal(now.funded, zero.funded, 'an unfunded offer is not counted as funded');
  assert.equal(now.published, zero.published);

  // Published and funded, as a finalized chain read would leave it (synthetic fixture).
  await s.db.query(`update bilateral_bets set chain_state = '{"fixture":"synthetic"}'::jsonb where id = $1`, [bet.id]);
  await s.db.query('insert into bilateral_bet_publications (bet_id, creator_user_id) values ($1, $2)', [bet.id, maker.id]);
  const late = s.fakeX.addUser('8104', 'late_follower');
  const lateB = await s.signIn(late);
  await lateB.submit('/setup', { profile: 'private', defaults: 'private' });
  const lateUser = await s.db.one('select id from users where x_user_id = $1', ['8104']);
  await s.db.query('insert into bilateral_bet_follows (bet_id, user_id) values ($1, $2)', [bet.id, lateUser.id]);
  const admins = await s.db.one('select id from users where x_user_id = $1', ['900']);
  await s.db.query('insert into bilateral_bet_follows (bet_id, user_id) values ($1, $2)', [bet.id, admins.id]);
  now = await metric();
  assert.equal(now.funded, zero.funded + 1);
  assert.equal(now.published, zero.published + 1);
  assert.equal(now.follows, zero.follows + 2);
  assert.equal(now.followsByNewAccount, zero.followsByNewAccount + 1, 'only the account made after the Bet counts as new');

  // A visit counts when a browser holding this server's signed cookie loads the page's stylesheet.
  const visit = async (browser, path) => {
    await browser.get(path);
    await browser.request('GET', '/static/stated.css', { headers: { referer: `${s.base}${path}`, 'user-agent': 'Mozilla/5.0' } });
  };
  const stranger = s.browser();
  await visit(stranger, '/');
  await visit(stranger, `/bets/${bet.id}`);
  await visit(stranger, `/bets/${bet.id}`);
  now = await metric();
  assert.equal(now.pageViews, zero.pageViews + 1, 'one browser, one page, one day');
  // The Bet's own maker opening it is not an arrival.
  const makerB = await s.signIn(s.fakeX.users.get('8101'));
  await visit(makerB, `/bets/${bet.id}`);
  assert.equal((await metric()).pageViews, zero.pageViews + 1);
});
