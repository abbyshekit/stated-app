import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { postLogo, postTime, xPostUrl } from '../src/x-post-view.mjs';
import { betPostTime, betSourceHeader } from '../src/bet-source-view.mjs';

// The post URL comes from the public signed corpus. Vary metadata only.
const record = JSON.parse(readFileSync(new URL('../../evidence/enclave-ruling-3668aa04.json', import.meta.url))).record;
const url = record.material.postUrl;
const id = record.material.bets[0].id;

test('X decoration links only to an original X post or the configured simulated X', () => {
  assert.equal(xPostUrl(url), url);
  for (const value of ['javascript:alert(1)', 'https://x.com.evil.test/a/status/1', 'https://x.com/intent/post', 'https://user:secret@x.com/a/status/1', 'http://x.com/a/status/1', null]) {
    assert.equal(xPostUrl(value), null);
  }
  assert.equal(xPostUrl('http://127.0.0.1:4311/post/1', 'http://127.0.0.1:4311'), 'http://127.0.0.1:4311/post/1');
  assert.equal(xPostUrl('http://127.0.0.1:4312/post/1', 'http://127.0.0.1:4311'), null);
  assert.match(String(postLogo(url)), /class="post-origin"[^>]*aria-label="See the post on X"/);
  assert.ok(String(postLogo(url)).includes(`href="${url}"`));
  assert.equal(postLogo(null), '');
});

test('only a stored post time renders, in UTC and linked to the same original post', () => {
  const time = String(postTime(url, '2026-11-12T14:15:00-05:00'));
  assert.ok(time.includes(`href="${url}"`));
  assert.match(time, /<time datetime="2026-11-12T19:15:00\.000Z">19:15 UTC 12 Nov 2026<\/time>/);
  for (const value of [null, '', 'invalid']) assert.equal(postTime(url, value), '');
  assert.equal(postTime(null, record.decidedAt), '');
});

test('a public Bet can show its already-published post time without disclosing a private source identity', async () => {
  const bet = { id, evidence_source_url: url, creator_username: 'statedforecast', created_at: record.decidedAt };
  const queries = [];
  const db = { async one(sql, params) {
    queries.push({ sql, params });
    if (sql.startsWith('select src.published_at')) return { published_at: '2026-11-12T19:00:00Z' };
    return null;
  }, async many() { return []; } };
  const header = String(await betSourceHeader(db, null, bet));
  assert.match(header, /Offered by statedforecast/);
  assert.ok(header.includes(`href="${url}"`));
  const time = String(await betPostTime(db, bet));
  assert.match(time, /19:00 UTC 12 Nov 2026/);
  const query = queries.find(item => item.sql.startsWith('select src.published_at'));
  assert.deepEqual(query.params, [id, url]);
  assert.match(query.sql, /src\.url=\$2/);
  assert.doesNotMatch(query.sql, /src\.text|author_name|author_username/);
  assert.equal(await betPostTime({ one: async () => null }, bet), '', 'never infer the post time from Bet creation');
  assert.equal(await betPostTime({ one: () => assert.fail('not an X URL') }, { ...bet, evidence_source_url: 'https://example.org/result' }), '');
});

test('a post on the simulated X is labelled in words, never with the real X mark', () => {
  const origin = 'http://127.0.0.1:4311';
  const simulated = String(postLogo(`${origin}/?c=12`, origin));
  assert.match(simulated, /On simulated X/);
  assert.doesNotMatch(simulated, /class="xmark"|See the post on X/);
  const real = String(postLogo('https://x.com/someone/status/1', origin));
  assert.match(real, /See the post on X/);
  assert.equal(String(postLogo(null, origin)), '');
});
