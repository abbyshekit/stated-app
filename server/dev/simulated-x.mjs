// Local demo: the real Stated server and worker against a simulated X.
// Use it to walk the website journeys in a browser. Nothing here touches
// x.com, and nothing it produces counts as live X verification.
//
//   node server/dev/simulated-x.mjs            # temporary database
//   DATABASE_URL=postgres://... node server/dev/simulated-x.mjs
//
// Then open http://127.0.0.1:4310 (Stated) and http://127.0.0.1:4311 (simulated X, as threads).
// http://127.0.0.1:4311/compose is the older plain form; the seed scripts read it.

import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { startBotAuth } from '../src/botauth.mjs';
import { loadConfig } from '../src/config.mjs';
import { createDb } from '../src/db.mjs';
import { ensureDesk } from '../src/store.mjs';
import { createApp } from '../src/web.mjs';
import { startWorker } from '../src/worker.mjs';
import { startNearWorker } from '../src/near-worker.mjs';
import { startPlayWorker } from '../src/reply-bets.mjs';
import { nearChain } from '../src/play.mjs';
import { botClient } from '../src/xapi.mjs';
import { FakeX } from '../test/support/fake-x.mjs';
import { startPostgres } from '../test/support/pg.mjs';
import { personFrom, threadPage } from './sim-thread.mjs';
import { escrowReadiness, readinessPage } from './demo-readiness.mjs';
import { recordedPayoutCheck, recordedPayoutPage } from './demo-proof.mjs';
import { demoChallenge } from './demo-challenge.mjs';

// 4190 is on the browsers' blocked-port list (sieve), so the defaults avoid it.
const APP_PORT = Number(process.env.PORT || 4310);
const X_PORT = Number(process.env.SIM_X_PORT || 4311);
// Loopback unless told otherwise. Inside a container the published ports need
// every interface; the compose file publishes them on the host's loopback only.
const BIND = process.env.SIM_BIND || '127.0.0.1';

const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// The simulated X keeps its accounts and posts in a file, so a restart does
// not look like every saved post was deleted.
const STATE = process.env.SIM_X_STATE || join(tmpdir(), 'stated-simulated-x.json');

class SimulatedX extends FakeX {
  post(...args) {
    const created = super.post(...args);
    this.persist();
    return created;
  }

  persist() {
    writeFileSync(STATE, JSON.stringify({
      nextId: String(this.nextId),
      users: [...this.users.values()],
      posts: [...this.posts.values()],
    }));
  }

  restore() {
    if (!existsSync(STATE)) return false;
    const saved = JSON.parse(readFileSync(STATE, 'utf8'));
    this.nextId = BigInt(saved.nextId);
    for (const u of saved.users) this.users.set(u.id, u);
    for (const p of saved.posts) this.posts.set(p.id, p);
    return true;
  }

  async handle(req, res) {
    const url = new URL(req.url, this.base);
    if (url.pathname === '/compose' && req.method === 'POST') {
      const form = new URLSearchParams(await this.body(req));
      this.post(form.get('as'), form.get('text') || '', {
        replyTo: form.get('reply_to') || null,
        quote: form.get('quote') || null,
      });
      res.writeHead(303, { location: '/compose' });
      return res.end();
    }
    if (url.pathname === '/compose') {
      const people = [...this.users.values()].filter((u) => !this.botIds.has(u.id));
      const posts = [...this.posts.values()].sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1)).slice(0, 30);
      const name = (id) => `@${this.users.get(id)?.username || id}`;
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Simulated X</title>
        <body style="font-family: system-ui; max-width: 40rem; margin: 1.5rem auto; padding: 0 1rem; line-height: 1.45">
        <h1>Simulated X</h1>
        <p><strong>Local test double, not x.com.</strong> Posts here reach the Stated worker the way mentions would.</p>
        <form method="post" action="/compose" style="display: grid; gap: .5rem">
          <label>Post as <select name="as">${people.map((u) => `<option value="${u.id}">@${esc(u.username)}</option>`).join('')}</select></label>
          <label>Reply to <select name="reply_to"><option value="">Nothing (a new post)</option>${posts.map((p) => `<option value="${p.id}">${esc(name(p.author_id))}: ${esc(p.text.slice(0, 70))}</option>`).join('')}</select></label>
          <label>Text <textarea name="text" rows="3" style="width: 100%">@${esc([...this.users.values()].find((u) => this.botIds.has(u.id))?.username || 'bot')} </textarea></label>
          <button type="submit">Post</button>
        </form>
        <h2>Recent posts</h2>
        <ol>${posts.map((p) => `<li><strong>${esc(name(p.author_id))}</strong> ${esc(p.text)}<br><small>id ${p.id}${p.referenced_tweets ? ` · replying to ${p.referenced_tweets[0].id}` : ''}</small></li>`).join('')}</ol>
        <p><a href="${esc(process.env.STATED_PUBLIC_URL || `http://127.0.0.1:${APP_PORT}`)}">Open Stated</a></p></body>`);
    }
    if (url.pathname === '/as') {
      const id = url.searchParams.get('id') || '';
      const back = /^\d+$/.test(url.searchParams.get('c') || '')
        ? `/?c=${url.searchParams.get('c')}${url.searchParams.get('take') === '1' ? '&take=1' : ''}${url.searchParams.get('say') ? `&say=${encodeURIComponent(url.searchParams.get('say'))}` : ''}` : '/';
      res.writeHead(303, { location: back, 'set-cookie': `simas=${this.users.has(id) ? id : ''}; Path=/; SameSite=Lax` });
      return res.end();
    }
    if (url.pathname === '/count') {
      res.writeHead(200, { 'content-type': 'text/plain', 'cache-control': 'no-store' });
      return res.end(String(this.posts.size));
    }
    if (url.pathname === '/post' && req.method === 'POST') {
      const form = new URLSearchParams(await this.body(req));
      const as = this.personFrom(req);
      const text = (form.get('text') || '').trim();
      const created = as && text ? this.post(as, text, { replyTo: form.get('reply_to') || null }) : null;
      const only = /^\d+$/.test(form.get('c') || '') ? `?c=${form.get('c')}` : '';
      res.writeHead(303, { location: created ? `/${only}#p${created.id}` : `/${only}` });
      return res.end();
    }
    if (url.pathname === '/') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
      return res.end(threadPage(this, req, { app: process.env.STATED_PUBLIC_URL || `http://127.0.0.1:${APP_PORT}`,
        only: url.searchParams.get('c'), take: url.searchParams.get('take') === '1', say: url.searchParams.get('say') || '' }));
    }
    return super.handle(req, res);
  }

  personFrom(req) { return personFrom(this, req); }
}

let pg = null;
const databaseUrl = process.env.DATABASE_URL || (pg = await startPostgres()).url;
const x = new SimulatedX();
x.interactive = true;
// Post IDs keep rising across restarts, like X's, so the stored cursor stays valid.
x.nextId = BigInt(Date.now()) * 1_000_000n;
x.botIds = new Set(['5000']);
await new Promise((resolve) => {
  x.server = http.createServer((req, res) => x.handle(req, res).catch((err) => {
    res.writeHead(500);
    res.end(String(err.stack || err));
  }));
  x.server.listen(X_PORT, BIND, resolve);
});
x.base = `http://127.0.0.1:${X_PORT}`;

const restored = x.restore();
const bot = x.addUser('5000', 'sim_statedbot', { name: 'Stated (simulated)' });
const alice = x.addUser('1001', 'sim_alice', { name: 'Alice (test account)' });
const bob = x.addUser('1002', 'sim_bob', { name: 'Bob (test account)' });
const carol = x.addUser('1003', 'sim_carol', { name: 'Carol (test account)' });
x.addUser('1900', 'sim_reviewer', { name: 'Reviewer (test account)' });
// Never signed in and never seeded, so the first encounter can be walked:
// post as @sim_dana, tag the bot under it, then sign in as @sim_dana.
const dana = x.addUser('1004', 'sim_dana', { name: 'Dana (test account)' });
// Test avatars: abstract shapes, never a face, so the demo shows how a page
// reads with profile photos without inventing a person.
const testAvatar = (ground, ink, shape) => `data:image/svg+xml;base64,${Buffer.from(
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 96 96"><rect width="96" height="96" fill="${ground}"/>${shape.replaceAll('INK', ink)}</svg>`,
).toString('base64')}`;
alice.profile_image_url = testAvatar('#F2B544', '#1B1B3A', '<circle cx="48" cy="54" r="26" fill="INK"/><rect x="0" y="0" width="96" height="18" fill="INK"/>');
bob.profile_image_url = testAvatar('#2F6F5E', '#F4EDE0', '<path d="M12 84 48 16l36 68z" fill="INK"/>');
dana.profile_image_url = testAvatar('#9AD3F0', '#0E2A3A', '<circle cx="34" cy="48" r="18" fill="INK"/><circle cx="62" cy="48" r="18" fill="INK"/>');
carol.profile_image_url = testAvatar('#D9482B', '#FDF6E3', '<rect x="20" y="20" width="56" height="56" fill="INK"/><rect x="36" y="36" width="24" height="24" fill="#D9482B"/>');
if (!restored) {
  const next = new Date().getUTCFullYear() + 1;
  x.post(alice.id, `TEST FIXTURE: Bitcoin will close above $150k by the end of ${next}, 70% chance.`);
  x.post(bob.id, `TEST FIXTURE: The Fed will cut rates twice by June 30, ${next}.`);
}

const config = loadConfig({
  ...process.env,
  PORT: String(APP_PORT),
  STATED_BASE_URL: process.env.STATED_PUBLIC_URL || `http://127.0.0.1:${APP_PORT}`,
  DATABASE_URL: databaseUrl,
  STATED_TOKEN_KEY: process.env.STATED_TOKEN_KEY || 'simulated-x-local-key',
  X_API_BASE: x.base,
  X_OEMBED_BASE: x.base,
  X_AUTHORIZE_URL: `${x.base}/i/oauth2/authorize`,
  X_CLIENT_ID: 'simulated',
  STATED_ADMIN_X_IDS: '1900',
  STATED_REPLIES: '1',
  STATED_MENTIONS_START: 'all',
  STATED_FETCH_ALLOW_LOOPBACK: '1',
  STATED_POLL_MS: process.env.STATED_POLL_MS || '3000',
});
config.x.simulatedOrigin = x.base;
const db = createDb(databaseUrl);
await db.migrate();
await ensureDesk(db);

const handler = createApp({ db, config });
const readinessChain = nearChain();
const readiness = () => escrowReadiness({ db, config, chain: readinessChain });
const practice = demoChallenge({ x, db, config, alice, bob, carol, readiness });
const checkPayout = recordedPayoutCheck();
let playReportedError = false;
const server = http.createServer(async (req, res) => {
  if (await practice(req, res)) return;
  if (!config.near.real && req.method === 'GET' && ['/demo-proof', '/demo-proof?verify=1'].includes(req.url)) {
    const state = req.url.endsWith('?verify=1') ? await checkPayout() : null;
    res.writeHead(200, {
      'content-type': 'text/html; charset=utf-8',
      'cache-control': 'no-store',
      'content-security-policy': "default-src 'none'; style-src 'self'; img-src 'self'; font-src 'self'; base-uri 'none'; frame-ancestors 'none'",
      'x-content-type-options': 'nosniff',
    });
    return res.end(String(recordedPayoutPage(state)));
  }
  if (req.method === 'GET' && req.url === '/demo-readiness') {
    const state = await readiness();
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' });
    return res.end(readinessPage(state, config.baseUrl, playReportedError, config.play.enabled && !config.near.real && new URL(config.baseUrl).hostname === '127.0.0.1'));
  }
  return handler(req, res);
});
await new Promise((resolve) => server.listen(APP_PORT, BIND, resolve));

const connected = await db.one('select 1 as ok from bot_credentials');
if (!connected) {
  const link = await startBotAuth(db, config);
  x.consentAs = bot.id;
  let next = link;
  for (let i = 0; i < 5 && next; i += 1) {
    const res = await fetch(next, { redirect: 'manual' });
    next = res.headers.get('location') ? new URL(res.headers.get('location'), next).toString() : null;
  }
  x.consentAs = null;
}
const stop = startWorker(db, config, botClient(db, config));
const stopNear = config.nearContract ? startNearWorker(db, config, {
  onError: (error) => console.error('[near]', error.message),
}) : null;

const stopPlay = config.play.enabled ? startPlayWorker(db, config, {
  botUsername: 'sim_statedbot', onError: (error) => { playReportedError = true; console.error('[play]', error.message); },
}) : null;
if (stopPlay) console.log('Bets from replies are on: reply "@sim_statedbot bet 0.2 no" under a post, then "@sim_statedbot take" as someone else.');

console.log(`Simulated X state: ${STATE}${restored ? ' (restored)' : ' (new)'}`);
console.log(`Stated (simulated X): ${config.baseUrl}`);
console.log(`Simulated X threads:  ${x.base}/`);
console.log(`Testnet escrow checks: ${config.baseUrl}/demo-readiness`);
console.log('Test accounts: sim_alice, sim_bob, sim_carol, sim_dana (never signed in), sim_reviewer (admin). Bot: sim_statedbot.');

async function shutdown() {
  stop();
  if (stopNear) stopNear();
  if (stopPlay) stopPlay();
  server.close();
  x.server.close();
  await db.close();
  if (pg) pg.stop();
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
