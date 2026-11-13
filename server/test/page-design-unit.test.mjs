import test from 'node:test';
import assert from 'node:assert/strict';
import { createApp } from '../src/web.mjs';
import { loadConfig } from '../src/config.mjs';
import { readFileSync } from 'node:fs';

// The claim is copied verbatim from the real public corpus. Only the surrounding
// projections are varied by these unit tests; they are not live runtime evidence.
const corpus = JSON.parse(readFileSync(new URL('../../evidence/enclave-ruling-3668aa04.json', import.meta.url))).record;
const payout = JSON.parse(readFileSync(new URL('../../evidence/hosted-court-payout-testnet-20261112.json', import.meta.url)));

const id = (n) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const now = new Date();
const ns = (date) => (BigInt(date.getTime()) * 1000000n).toString();
function offer(n, hours) {
  const accept = new Date(now.getTime() + hours * 3600000);
  const resolve = new Date(now.getTime() + 48 * 3600000);
  const binding = 'a'.repeat(64);
  const terms = 'b'.repeat(64);
  const bet = { id: id(n), claim: corpus.material.claim, creator_user_id: '1', creator_username: 'alice',
    creator_wallet: 'alice.testnet', creator_side: 'yes', stake_yocto: '1000000000000000000000000', terms_hash: terms,
    accept_by: accept, resolve_at: resolve, created_at: now, published_at: now, read_at: now,
    near_verified_at: now, near_height: '1', creator_bound: true, referee_wallet: 'referee.testnet' };
  bet.chain_state = { id: bet.id, creator: bet.creator_wallet, creator_binding_hash: binding, terms_hash: terms,
    stake_yocto: bet.stake_yocto, creator_side: 'yes', status: 'offered',
    accept_by_ns: ns(accept), resolve_at_ns: ns(resolve), invited_account: null, referee: bet.referee_wallet };
  return bet;
}

function fakeDb(rows, { profile = false, publishedAt = null } = {}) {
  const calls = [];
  const db = {
    calls,
    async one(sql, params = []) {
      calls.push(sql);
      if (sql.startsWith('select src.published_at')) return { published_at: publishedAt };
      if (sql.includes("from users where kind = 'person'")) return { id: '1', kind: 'person', x_user_id: '1', x_username: 'alice', x_name: 'Private Name', profile_visibility: 'private' };
      if (sql.includes('from bilateral_bets b\n  join bilateral_bet_publications')) return rows.find(r => r.id === params[0]) || null;
      if (sql.includes('bot_credentials')) return { x_username: 'statedforecast' };
      if (sql.includes('from bot_outbox')) return { post_id: payout.social.offer.split('/').at(-1) };
      if (sql.includes('select source_save_id from bilateral_bets')) return { source_save_id: '42' };
      if (sql.includes('from saves') && sql.includes('join users')) return null;
      if (sql.includes('enclave_ruling') || sql.includes('from bilateral_bets b join saves')) return null;
      if (sql.includes('from saves') || sql.includes('bot_outbox')) return null;
      throw new Error(`Unexpected one query: ${sql}`);
    },
    async many(sql) {
      calls.push(sql);
      if (sql.includes('lower(creator.x_username)')) return profile ? rows : [];
      if (sql.includes("where p.withdrawn_at is null and b.status='offered'")) return rows.filter(row => row.accept_by > new Date()).sort((a, b) => a.accept_by - b.accept_by);
      if (sql.includes('from bilateral_bets b\n  join bilateral_bet_publications')) return rows;
      if (sql.includes('select distinct b.id from bilateral_bets')) return [];
      if (sql.includes('from users') || sql.includes('from saves') || sql.includes('from public_withdrawals')) return [];
      throw new Error(`Unexpected many query: ${sql}`);
    },
    async tx(fn) { return fn(db); },
  };
  return db;
}

async function get(db, path) {
  const config = loadConfig({ STATED_BASE_URL: 'http://localhost' });
  config.play.enabled = true;
  const handle = createApp({ db, config });
  const res = { headersSent: false, writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }, end(body) { this.body = String(body || ''); } };
  await handle({ method: 'GET', url: path, headers: {} }, res);
  return res;
}

test('home names Stated and lists each counted offer once in closing order', async () => {
  const rows = [offer(1, 10), offer(2, 5), offer(3, 8)];
  const db = fakeDb(rows);
  const res = await get(db, '/');
  assert.equal(res.status, 200);
  assert.match(res.body, /<title>Bets on what is said on X · Stated<\/title>/);
  assert.doesNotMatch(res.body, /Give your/);
  assert.match(res.body, /<meta name="description" content="Bet on what is said on X/);
  assert.match(res.body, /3 bets/);
  const listed = res.body.split('<section id="public-bets">')[1];
  assert.doesNotMatch(listed, new RegExp(`/bets/${id(2)}`), 'the featured offer is omitted from the rows');
  for (const n of [1, 3]) assert.equal((listed.match(new RegExp(`href="/bets/${id(n)}"`, 'g')) || []).length, 1);
  assert.ok(listed.indexOf(id(3)) < listed.indexOf(id(1)));
  assert.match(res.body, /Reply to any post on X with <span class="mention">@statedforecast bet 0\.1 no<\/span>\./);
  assert.match(res.body, /home-intro[\s\S]*?<\/p>\s*<div class="acts"><a class="pill solid big" href="\/signin">Make a bet<\/a>/);
  assert.doesNotMatch(res.body.match(/<header>[\s\S]*?<\/header>/)[0], /Sign in/);
  assert.match(listed, /<h2 class="lead">Open offers<\/h2>/);
  assert.ok(db.calls.some(sql => sql.includes('from bilateral_bets b\n  join bilateral_bet_publications')));
});

test('private profiles disclose only published Bets', async () => {
  const db = fakeDb([offer(1, 5)], { profile: true });
  const res = await get(db, '/u/alice');
  assert.equal(res.status, 200);
  assert.match(res.body, /Public bets/);
  assert.ok(res.body.includes(corpus.material.claim));
  assert.doesNotMatch(res.body, /Private Name|Predictions on this page|Following on this page/);
  assert.ok(db.calls.some(sql => sql.includes('lower(creator.x_username)')));
  const hidden = await get(fakeDb([], { profile: true }), '/u/alice');
  assert.equal(hidden.status, 404);
});

test('home separates finished bets from open offers without duplicating rows or primary actions', async () => {
  const rows = [offer(1, 10), offer(2, 5), offer(3, -5)];
  const res = await get(fakeDb(rows), '/');
  assert.equal(res.status, 200);
  assert.equal((res.body.match(/class="pill solid big"/g) || []).length, 1);
  const listed = res.body.split('<section id="public-bets">')[1];
  assert.match(listed, /<h2 class="lead">Open offers<\/h2>[\s\S]*<h2 class="lead">Finished bets<\/h2>/);
  for (const n of [1, 3]) assert.equal((listed.match(new RegExp(`href="/bets/${id(n)}"`, 'g')) || []).length, 1);
  assert.ok(listed.indexOf(id(1)) < listed.indexOf('Finished bets'));
  assert.ok(listed.indexOf(id(3)) > listed.indexOf('Finished bets'));
});

test('home with no offers gives the configured reply action, including when only finished bets remain', async () => {
  for (const rows of [[], [offer(1, -1)]]) {
    const res = await get(fakeDb(rows), '/');
    assert.equal(res.status, 200);
    assert.match(res.body, /No open offers right now\. Reply to any post on X with <span class="mention">@statedforecast bet 0\.1 no<\/span>\./);
    assert.doesNotMatch(res.body, /<h2 class="lead">Open offers<\/h2>/);
  }
});

test('an expired offered bet leaves the open list and remains in finished bets', async () => {
  const rows = [offer(1, 10), offer(2, 5), offer(3, 8)];
  const before = await get(fakeDb(rows), '/');
  assert.match(before.body.split('Open offers</h2>')[1], new RegExp(`/bets/${id(3)}`));
  rows[2].accept_by = new Date(Date.now() - 1000);
  rows[2].chain_state.accept_by_ns = ns(rows[2].accept_by);
  const after = await get(fakeDb(rows), '/');
  const open = after.body.split('Open offers</h2>')[1].split('Finished bets</h2>')[0];
  assert.doesNotMatch(open, new RegExp(`/bets/${id(3)}`));
  assert.match(after.body.split('Finished bets</h2>')[1], new RegExp(`/bets/${id(3)}`));
});

test('signed-out open Bet exposes its take action and share fold without private source identity', async () => {
  const db = fakeDb([offer(1, 5)]);
  const res = await get(db, `/bets/${id(1)}`);
  assert.equal(res.status, 200);
  assert.match(res.body, />Bet no<\/a>/);
  assert.match(res.body, /<div class="two">\s*<a[^>]*>Reply on X<\/a>\s*<\/div>/);
  assert.ok(res.body.includes(`data-bet-claim="${corpus.material.claim}"`));
  assert.doesNotMatch(res.body, /class="wrap two"|Sign in to bet|>Follow<\/|View test bet/);
  assert.match(res.body, /href="\/signin\?return=[^"]+">Bet no<\/a>/);
  assert.match(res.body, /<summary>Share<\/summary>[\s\S]*?Copy link[\s\S]*?Save image/);
  assert.doesNotMatch(res.body, /Private Name/);
  assert.ok(db.calls.some(sql => sql.includes('from bilateral_bets b\n  join bilateral_bet_publications')));
});

test('home and offer put the original post time immediately after its unchanged words', async () => {
  const bet = offer(1, 5);
  bet.evidence_source_url = corpus.material.postUrl;
  const db = fakeDb([bet], { publishedAt: '2026-11-12T19:10:00Z' });
  for (const path of ['/', `/bets/${bet.id}`]) {
    const res = await get(db, path);
    assert.equal(res.status, 200);
    assert.ok(res.body.includes(corpus.material.claim));
    assert.match(res.body, /<p class="prop(?: bet-claim long)?">[^]*?<\/p>\s*<p class="post-time"><a[^>]+><time datetime="2026-11-12T19:10:00\.000Z">19:10 UTC 12 Nov 2026<\/time>/);
    assert.doesNotMatch(res.body, /19:10 UTC 12 Nov<\/time>|2:10 AM/);
  }
});
