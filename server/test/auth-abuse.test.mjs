import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { test } from 'node:test';
import { loadConfig } from '../src/config.mjs';
import { sessionDigest } from '../src/session-tokens.mjs';

const { createApp } = await import(process.env.AUTH_ABUSE_WEB || '../src/web.mjs');

async function request(app, path, { method = 'GET', body = '', headers = {}, address = '127.0.0.1' } = {}) {
  const req = Readable.from([Buffer.from(body)]);
  Object.assign(req, { url: path, method, headers, socket: { remoteAddress: address } });
  const result = { headers: {} };
  const res = {
    setHeader(name, value) { result.headers[name] = value; },
    writeHead(status, values) { result.status = status; Object.assign(result.headers, values); },
    end(value) { result.body = String(value || ''); },
  };
  await app(req, res);
  return result;
}

function config() {
  return loadConfig({ STATED_BASE_URL: 'http://stated.test', X_CLIENT_ID: 'test-client',
    STATED_TOKEN_KEY: 'synthetic-test-key', NEARAI_BASE_URL: 'https://nearai.test/v1' });
}

test('sign-in rate limiting stops database work even with rotating cookies and forwarding headers', async () => {
  const rows = [];
  let queries = 0;
  const db = {
    tx(fn) { return fn(db); },
    async one(sql) {
      queries += 1;
      assert.match(sql, /from oauth_states/);
      return { count: rows.length };
    },
    async query(sql, values) {
      queries += 1;
      if (/insert into oauth_states/.test(sql)) rows.push(values[0]);
      else assert.match(sql, /delete from oauth_states|pg_advisory_xact_lock/);
    },
  };
  const app = createApp({ db, config: config() });
  for (let index = 0; index < 24; index += 1) {
    const response = await request(app, '/signin/x', { headers: { cookie: `stated_oauth=rotating-${index}`, 'x-real-ip': `192.0.2.${index}`, 'x-forwarded-for': `192.0.2.${index}` } });
    assert.equal(response.status, 303);
  }
  const previous = queries;
  for (let index = 0; index < 4; index += 1) {
    const response = await request(app, '/signin/x', { headers: { cookie: 'stated_sid=untrusted', 'x-real-ip': `198.51.100.${index}` } });
    assert.equal(response.status, 429);
    assert.ok(Number(response.headers['retry-after']) > 0);
    assert.equal(response.headers['cache-control'], 'no-store');
    assert.equal(response.headers['set-cookie'], undefined);
    assert.equal(response.headers.location, undefined);
  }
  assert.equal(queries, previous);
  assert.equal(rows.length, 24);
  assert.equal((await request(app, '/signin/x', { address: '192.0.2.100' })).status, 303, 'another address has its own budget');
});

test('correction source budget spans accounts, while CSRF and sign-in attempts have separate budgets', async () => {
  const bearer = 'A'.repeat(43);
  const session = { id: sessionDigest(bearer), user_id: '1', csrf: 'csrf' };
  const user = { id: '1', x_user_id: '100', x_username: 'alice', kind: 'person', profile_visibility: 'private' };
  let statementsRead = 0;
  const db = {
    async one(sql) {
      if (/from sessions/.test(sql)) return session;
      if (/from users where id/.test(sql)) return user;
      if (/from saves s/.test(sql)) { statementsRead += 1; return null; }
      throw new Error(sql);
    },
  };
  const app = createApp({ db, config: config() });
  const submit = (csrf = 'csrf') => request(app, '/corrections', { method: 'POST',
    headers: { cookie: `stated_sid=${bearer}`, 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ csrf, statement: '1', body: 'Please review the deadline.' }).toString() });
  for (let index = 0; index < 22; index += 1) assert.equal((await submit('invalid')).status, 403);
  for (let index = 0; index < 20; index += 1) {
    user.id = String(index + 1);
    session.user_id = user.id;
    assert.equal((await submit()).status, 404);
  }
  assert.equal(statementsRead, 20);
  const refused = await submit();
  assert.equal(refused.status, 429);
  assert.ok(Number(refused.headers['retry-after']) > 0);
  assert.equal(statementsRead, 20);
  assert.equal((await request(app, '/signin')).status, 200);
});
