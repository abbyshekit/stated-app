// Boots the real server (real Postgres, real HTTP, real handlers) against the
// fake X API, and drives it like a browser: cookies, redirects, CSRF fields.

import http from 'node:http';
import { startBotAuth } from '../../src/botauth.mjs';
import { loadConfig } from '../../src/config.mjs';
import { createDb } from '../../src/db.mjs';
import { ensureDesk } from '../../src/store.mjs';
import { createApp } from '../../src/web.mjs';
import { botClient } from '../../src/xapi.mjs';
import { FakeX } from './fake-x.mjs';
import { startPostgres } from './pg.mjs';

export const ADMIN_X_ID = '900';

function listen(server) {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server.address().port)));
}

export async function startStack(env = {}, { fetchImpl = fetch, chain = null, intents = null } = {}) {
  const pg = await startPostgres();
  const fakeX = await new FakeX().start();
  const db = createDb(pg.url);
  await db.migrate();
  await ensureDesk(db);
  let handler = null;
  const server = http.createServer((req, res) => handler(req, res));
  const port = await listen(server);
  const base = `http://127.0.0.1:${port}`;
  const config = loadConfig({
    PORT: String(port),
    STATED_BASE_URL: base,
    DATABASE_URL: pg.url,
    STATED_TOKEN_KEY: 'test-only-token-key',
    X_API_BASE: fakeX.base,
    X_OEMBED_BASE: fakeX.base,
    X_AUTHORIZE_URL: `${fakeX.base}/i/oauth2/authorize`,
    X_CLIENT_ID: 'test-client',
    STATED_ADMIN_X_IDS: ADMIN_X_ID,
    STATED_FETCH_ALLOW_LOOPBACK: '1',
    STATED_REPLIES: '1',
    STATED_MENTIONS_START: 'all',
    // The fake NEAR AI returns no NVIDIA evidence; production requires it (config.mjs).
    STATED_REQUIRE_GPU_EVIDENCE: '0',
    ...env,
  });
  handler = createApp({ db, config, fetchImpl, chain, intents });
  const stack = {
    pg, fakeX, db, config, base, server,
    x: botClient(db, config),
    browser: () => new Browser(base),
    async connectBot(botUser) {
      const url = await startBotAuth(db, config);
      fakeX.consentAs = botUser.id;
      const b = new Browser(base);
      const page = await b.follow(url);
      fakeX.consentAs = null;
      stack.x = botClient(db, config);
      return page;
    },
    async signIn(user) {
      const b = new Browser(base);
      fakeX.consentAs = user.id;
      const page = await b.follow('/signin/x');
      fakeX.consentAs = null;
      b.lastPage = page;
      return b;
    },
    async close() {
      await new Promise((resolve) => server.close(resolve));
      await db.close();
      await fakeX.stop();
      pg.stop();
    },
  };
  return stack;
}

export class Browser {
  constructor(base) {
    this.base = base;
    this.jar = new Map();
    this.lastPage = null;
  }

  cookieHeader() {
    return [...this.jar].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  store(res) {
    for (const line of res.headers.getSetCookie()) {
      const [pair, ...attrs] = line.split(';');
      const i = pair.indexOf('=');
      const name = pair.slice(0, i).trim();
      const value = pair.slice(i + 1).trim();
      if (value === '' || attrs.some((a) => /max-age=0\b/i.test(a.trim()))) this.jar.delete(name);
      else this.jar.set(name, value);
    }
  }

  async request(method, path, { form, headers = {} } = {}) {
    const url = new URL(path, this.base);
    const own = url.origin === new URL(this.base).origin;
    const res = await fetch(url, {
      method,
      redirect: 'manual',
      headers: {
        ...(own && this.jar.size ? { cookie: this.cookieHeader() } : {}),
        ...(form ? { 'content-type': 'application/x-www-form-urlencoded' } : {}),
        ...headers,
      },
      body: form ? new URLSearchParams(form).toString() : undefined,
    });
    if (own) this.store(res);
    const text = await res.text();
    return { status: res.status, headers: res.headers, text, location: res.headers.get('location'), url: url.toString() };
  }

  async follow(path, options = {}) {
    let res = await this.request(options.method || 'GET', path, options);
    for (let i = 0; i < 10 && res.status >= 300 && res.status < 400 && res.location; i += 1) {
      res = await this.request('GET', new URL(res.location, res.url).toString());
    }
    this.lastPage = res;
    return res;
  }

  get(path) {
    return this.follow(path);
  }

  csrf(page = this.lastPage) {
    return page?.text.match(/name="csrf" value="([^"]+)"/)?.[1] || '';
  }

  // Posts a form the way a browser would: with the CSRF field from a page
  // this browser loaded. `fields` may be an object or an array of pairs.
  async submit(path, fields = {}, { from = '/me/settings' } = {}) {
    let token = this.csrf();
    if (!token) token = this.csrf(await this.request('GET', from));
    const pairs = Array.isArray(fields) ? [...fields] : Object.entries(fields);
    pairs.push(['csrf', token]);
    return this.follow(path, { method: 'POST', form: pairs });
  }
}
