// C1: one request must not stop the process. No database: the bad targets are answered before
// the app reads a session, and a stub database fails the test if anything touches it.
import assert from 'node:assert/strict';
import net from 'node:net';
import test from 'node:test';
import { loadConfig } from '../src/config.mjs';
import { createServer } from '../src/http-server.mjs';
import { createApp } from '../src/web.mjs';

const untouchable = new Proxy({}, { get: (_, name) => { throw new Error(`the database was used: ${String(name)}`); } });

async function listen(server, t) {
  await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
  t.after(() => new Promise(resolve => { server.closeAllConnections(); server.close(resolve); }));
  return server.address().port;
}

// Writes bytes straight to the socket, as a client that ignores the URL standard would.
function raw(port, request) {
  return new Promise((resolve, reject) => {
    const socket = net.connect(port, '127.0.0.1', () => socket.end(request));
    let text = '';
    socket.setEncoding('utf8');
    socket.on('data', chunk => { text += chunk; });
    socket.on('end', () => resolve(text));
    socket.on('error', reject);
    socket.setTimeout(5000, () => { socket.destroy(); reject(new Error('no answer within 5 s')); });
  });
}

test('a request target that URL cannot parse gets a 400 and the app keeps serving', async (t) => {
  const config = loadConfig({ STATED_BASE_URL: 'https://stated.example' });
  const errors = [];
  const port = await listen(createServer(createApp({ db: untouchable, config }), { log: (...args) => errors.push(args) }), t);
  for (const target of ['http://[', 'http://[::1', 'http://%zz']) {
    const answer = await raw(port, `GET ${target} HTTP/1.1\r\nHost: stated.example\r\nConnection: close\r\n\r\n`);
    assert.match(answer, /^HTTP\/1\.1 400 /, `${target}: ${answer.split('\r\n')[0]}`);
  }
  assert.deepEqual(errors, []);
  const after = await raw(port, 'GET http://[ HTTP/1.1\r\nHost: stated.example\r\nConnection: close\r\n\r\n');
  assert.match(after, /^HTTP\/1\.1 400 /, 'still answering after the bad requests');
});

test('every response carries HSTS on an https deployment and a Permissions-Policy', async (t) => {
  const config = loadConfig({ STATED_BASE_URL: 'https://stated.example' });
  const port = await listen(createServer(createApp({ db: untouchable, config })), t);
  const answer = await raw(port, 'GET http://[ HTTP/1.1\r\nHost: stated.example\r\nConnection: close\r\n\r\n');
  assert.match(answer, /\r\nstrict-transport-security: max-age=31536000; includeSubDomains\r\n/i);
  assert.match(answer, /\r\npermissions-policy: camera=\(\), microphone=\(\), geolocation=\(\)/i);
  const local = loadConfig({ STATED_BASE_URL: 'http://localhost:8080' });
  const localPort = await listen(createServer(createApp({ db: untouchable, config: local })), t);
  const plain = await raw(localPort, 'GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n');
  assert.doesNotMatch(plain, /strict-transport-security/i, 'HSTS only where the site is served over https');
});

test('a handler that throws or rejects answers 500 and the process keeps serving', async (t) => {
  const errors = [];
  let calls = 0;
  const port = await listen(createServer(async (req, res) => {
    calls += 1;
    if (calls === 1) throw new Error('synthetic failure');
    if (calls === 2) return Promise.reject(new Error('synthetic rejection'));
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('ok');
  }, { log: (...args) => errors.push(args) }), t);
  for (const expected of [/^HTTP\/1\.1 500 /, /^HTTP\/1\.1 500 /, /^HTTP\/1\.1 200 /]) {
    assert.match(await raw(port, 'GET / HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n'), expected);
  }
  assert.equal(errors.length, 2);
});

test('bytes the HTTP parser refuses get a 400 without reaching the handler', async (t) => {
  let reached = false;
  const port = await listen(createServer(() => { reached = true; }), t);
  const answer = await raw(port, 'GET / HTTP/1.1\r\nHost: x\r\nBad Header Line\r\n\r\n');
  assert.match(answer, /^HTTP\/1\.1 400 /);
  assert.equal(reached, false);
});
