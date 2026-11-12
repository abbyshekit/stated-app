import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { safeFetch, extractArticle } from '../src/articles.mjs';
import { extractInWorker } from '../src/extraction-pool.mjs';
import { PAGE_FETCH_LIMIT, PAGE_FETCH_QUEUE } from '../src/page-limits.mjs';

const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(check) {
  const end = Date.now() + 2000;
  while (!check()) {
    assert.ok(Date.now() < end, 'HTTP barrier timed out');
    await delay(5);
  }
}
async function serve(t, handler) {
  const site = http.createServer(handler);
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  t.after(async () => { site.closeAllConnections(); await new Promise((resolve) => site.close(resolve)); });
  return `http://127.0.0.1:${site.address().port}`;
}

test('a worker deadline terminates extraction and the next page is readable', { timeout: 10_000 }, async () => {
  const started = performance.now();
  await assert.rejects(extractInWorker('article', '<p>'.repeat(600_000), 'https://example.org', {}, { timeoutMs: 1 }),
    { name: 'UserError', message: 'The page took too long to read.' });
  assert.ok(performance.now() - started < 2000);
  const html = '<title>Public title</title><body><p>The public record remains available for inspection.</p></body>';
  assert.deepEqual(await extractInWorker('article', html, 'https://example.org'), extractArticle(html, 'https://example.org'));
  const evidence = await extractInWorker('evidence', html, 'https://example.org');
  assert.equal(evidence.text, 'The public record remains available for inspection.');
});

test('worker parsing leaves the main event loop responsive', { timeout: 10_000 }, async () => {
  let beats = 0;
  const timer = setInterval(() => { beats += 1; }, 1);
  try {
    await extractInWorker('article', `<p>${'Public record. '.repeat(100_000)}</p>`, 'https://example.org');
    assert.ok(beats > 0, 'main-thread timers advanced during extraction');
  } finally { clearInterval(timer); }
});

test('worker queue overflow and cancelled queued work do not leak slots', { timeout: 10_000 }, async () => {
  const controller = new AbortController();
  const html = `<p>${'Public record. '.repeat(100_000)}</p>`;
  const work = Array.from({ length: 10 }, () => extractInWorker('article', html, 'https://example.org', {}, { signal: controller.signal }));
  const observed = Promise.allSettled(work);
  await assert.rejects(extractInWorker('article', html, 'https://example.org'), /Too many pages/);
  controller.abort(new Error('Cancelled test extraction'));
  const results = await observed;
  assert.ok(results.every((result) => result.status === 'rejected' && /Cancelled/.test(result.reason.message)));
  assert.equal((await extractInWorker('evidence', '<p>Another public record.</p>', 'https://example.org')).text, 'Another public record.');
});

test('shared fetch path bounds active bodies, queue length, queue wait and cancellation', { timeout: 10_000 }, async (t) => {
  const responses = []; let active = 0; let peak = 0; let requests = 0;
  const base = await serve(t, (req, res) => {
    requests += 1; active += 1; peak = Math.max(peak, active);
    res.on('close', () => { active -= 1; });
    responses.push(res);
  });
  const options = { allowLoopback: true, timeoutMs: 1000 };
  const running = Array.from({ length: PAGE_FETCH_LIMIT }, () => safeFetch(base, options));
  const allRunning = Promise.allSettled(running);
  try {
    await until(() => requests === PAGE_FETCH_LIMIT);
    await assert.rejects(safeFetch(base, { ...options, queueTimeoutMs: 20 }), /waited too long/);
    assert.equal(requests, PAGE_FETCH_LIMIT, 'a queue timeout never opens a connection');
    const controllers = Array.from({ length: PAGE_FETCH_QUEUE }, () => new AbortController());
    const waiting = controllers.map((controller) => safeFetch(base, { ...options, signal: controller.signal }));
    const allWaiting = Promise.allSettled(waiting);
    await assert.rejects(safeFetch(base, options), /Too many pages/);
    controllers.forEach((controller) => controller.abort(new Error('Cancelled queued fetch')));
    assert.ok((await allWaiting).every((result) => result.status === 'rejected' && /Cancelled/.test(result.reason.message)));
    assert.equal(requests, PAGE_FETCH_LIMIT);
    responses.forEach((res) => { res.writeHead(200, { 'content-type': 'text/html' }); res.end('<p>Public page.</p>'); });
    assert.ok((await allRunning).every((result) => result.status === 'fulfilled'));
    assert.equal(peak, PAGE_FETCH_LIMIT);
  } finally {
    responses.forEach((res) => res.destroy());
    await allRunning;
  }
});

test('fetch slots survive size, HTTP, content type, redirect and active abort failures', { timeout: 10_000 }, async (t) => {
  const base = await serve(t, (req, res) => {
    if (req.url === '/abort') { res.writeHead(200, { 'content-type': 'text/html' }); return res.write('pending'); }
    if (req.url === '/private') { res.writeHead(302, { location: 'http://169.254.169.254/' }); return res.end(); }
    if (req.url === '/x') { res.writeHead(302, { location: 'https://x.com/person/status/123' }); return res.end(); }
    if (req.url === '/redirect') { res.writeHead(302, { location: '/ok' }); return res.end(); }
    if (req.url === '/status') { res.writeHead(503, { 'content-type': 'text/html' }); return res.end('Unavailable'); }
    res.writeHead(200, { 'content-type': req.url === '/image' ? 'image/png' : 'text/html' });
    return res.end('<p>Public page.</p>');
  });
  const options = { allowLoopback: true, timeoutMs: 100 };
  await assert.rejects(safeFetch(`${base}/private`, options), /private network/);
  await assert.rejects(safeFetch(`${base}/x`, options), /X pages/);
  await assert.rejects(safeFetch(`${base}/status`, options), /status 503/);
  await assert.rejects(safeFetch(`${base}/image`, options), /not a web page/);
  await assert.rejects(safeFetch(`${base}/ok`, { ...options, maxBytes: 3 }), /too large/);
  const signal = AbortSignal.timeout(20);
  await assert.rejects(safeFetch(`${base}/abort`, { ...options, signal }));
  assert.equal((await safeFetch(`${base}/redirect`, options)).url, `${base}/ok`);
  assert.equal((await safeFetch(`${base}/ok`, options)).body, '<p>Public page.</p>');
});
