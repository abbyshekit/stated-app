// INTEGRATION: Real Postgres and HTTP against fake X; synthetic chain projection is labelled below.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, test } from 'node:test';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const root = process.env.STATED_MARKED_TEST_ROOT || resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const load = path => import(pathToFileURL(resolve(root, path)).href);
const [{ startStack }, { createBet }, { publishBet }, { completeSetup, signInFromX }, { tick }, { TESTNET_RPC }, { createApp }] = await Promise.all([
  load('server/test/support/app.mjs'), load('server/src/bets.mjs'), load('server/src/bet-public.mjs'),
  load('server/src/store.mjs'), load('server/src/worker.mjs'), load('server/src/near-escrow.mjs'), load('server/src/web.mjs'),
]);
let s, browser, owner, sourceSave;
const fetchImpl = async (url, options) => {
  if (url === TESTNET_RPC) {
    const { params } = JSON.parse(options.body);
    if (params?.method_name === 'get_bet') return new Response(JSON.stringify({ result: { block_height: 100, result: [...Buffer.from('null')] } }));
    throw new Error('Unexpected synthetic RPC');
  }
  if (s && String(url).startsWith(s.fakeX.base)) return fetch(url, options);
  throw new Error('Unexpected external fetch');
};
const iso = days => new Date(Date.now() + days * 86400000).toISOString();
const base = () => ({ requestId: randomUUID(), claim: 'Synthetic retained proposition', criteria: 'Official result',
  evidenceSourceUrl: 'https://example.org/result', creatorSide: 'yes', stakeNear: '0.1' });
function parts(prefix, date) {
  const d = new Date(date);
  return { [`${prefix}DateInput`]: '1', [`${prefix}Day`]: String(d.getUTCDate()), [`${prefix}Month`]: String(d.getUTCMonth() + 1),
    [`${prefix}Year`]: String(d.getUTCFullYear()), [`${prefix}Hour`]: String(d.getUTCHours()), [`${prefix}Minute`]: String(d.getUTCMinutes()) };
}
const ns = v => (BigInt(new Date(v).getTime()) * 1000000n).toString();

before(async () => {
  s = await startStack({ STATED_NEAR_CONTRACT: 'escrow.testnet' }, { fetchImpl });
  const bot = s.fakeX.addUser('500', 'statedbot');
  const person = s.fakeX.addUser('98601', 'bet_owner');
  const author = s.fakeX.addUser('98602', 'private_source_author');
  await s.connectBot(bot);
  owner = await completeSetup(s.db, await signInFromX(s.db, { id: person.id, username: person.username }), {});
  browser = await s.signIn(person);
  const post = s.fakeX.post(author.id, `A synthetic event occurs before March 1, ${new Date().getUTCFullYear() + 4}.`);
  s.fakeX.post(person.id, '@statedbot', { replyTo: post.id });
  await tick(s.db, s.config, s.x);
  sourceSave = await s.db.one(`select s.id from saves s join statements st on st.id=s.statement_id
    join sources src on src.id=st.source_id where s.owner_x_user_id=$1 and src.platform_id=$2`, [person.id, post.id]);
  assert.ok(sourceSave);
});
after(async () => { if (s) await s.close(); });

test('new Bet uses segmented dates and does not mark initial blank dates invalid', async () => {
  const page = await browser.get(`/me/bets/new?save=${sourceSave.id}`);
  assert.equal(page.status, 200);
  for (const prefix of ['acceptBy', 'resolveAt']) {
    for (const suffix of ['DateInput', 'Day', 'Month', 'Year', 'Hour', 'Minute']) assert.match(page.text, new RegExp(`name="${prefix}${suffix}"`));
  }
  assert.doesNotMatch(page.text, /type="datetime-local"/);
  assert.doesNotMatch(page.text, /aria-invalid="true"/);
});

test('invalid structured date preserves inputs; valid structured and legacy ISO dates persist', async () => {
  const bad = { ...base(), ...parts('acceptBy', iso(2)), ...parts('resolveAt', iso(3)) };
  Object.assign(bad, { acceptByDay: '31', acceptByMonth: '2' });
  const failed = await browser.submit('/me/bets', bad, { from: '/me/bets/new' });
  assert.equal(failed.status, 400);
  assert.match(failed.text, /Synthetic retained proposition/);
  const daySelect = failed.text.match(/<select\b[^>]*name="acceptByDay"[^>]*>[\s\S]*?<\/select>/)?.[0];
  assert.ok(daySelect, 'acceptance day control is retained');
  assert.match(daySelect, /<option\b(?=[^>]*\bvalue="31")(?=[^>]*\bselected\b)[^>]*>/);
  assert.match(failed.text, /aria-invalid="true"/);
  assert.match(failed.text, /<fieldset class="date-field"><legend>Open for takers until<\/legend><p class="err" role="alert">Enter a valid acceptance date and time\./);
  assert.equal((await s.db.one('select count(*)::int as n from bilateral_bets where request_id=$1', [bad.requestId])).n, 0);
  const acceptedAt = iso(2), resolvedAt = iso(3);
  const good = { ...base(), ...parts('acceptBy', acceptedAt), ...parts('resolveAt', resolvedAt) };
  const valid = await browser.submit('/me/bets', good, { from: '/me/bets/new' });
  assert.equal(valid.status, 200);
  const stored = await s.db.one('select accept_by,resolve_at from bilateral_bets where request_id=$1', [good.requestId]);
  assert.ok(stored);
  assert.equal(new Date(stored.accept_by).toISOString().slice(0, 16), acceptedAt.slice(0, 16));
  assert.equal(new Date(stored.resolve_at).toISOString().slice(0, 16), resolvedAt.slice(0, 16));
  const legacy = { ...base(), acceptBy: iso(4), resolveAt: iso(5) };
  assert.equal((await browser.submit('/me/bets', legacy, { from: '/me/bets/new' })).status, 200);
  assert.ok(await s.db.one('select id from bilateral_bets where request_id=$1', [legacy.requestId]));
});

test('older outcome precedes collapsed saved acknowledgements and all remain in the database', async () => {
  await s.db.query('delete from inbox where owner_x_user_id=$1', [owner.x_user_id]);
  await s.db.query(`insert into inbox(owner_x_user_id,kind,body,dedupe_key,created_at)
    values($1,'outcome','Outcome recorded for a prediction by @someone: It came true. Evidence confirmed.',$2,now()-interval '1 day')`, [owner.x_user_id, randomUUID()]);
  await s.db.query(`insert into inbox(owner_x_user_id,kind,body,dedupe_key,created_at)
    select $1,case when n%2=0 then 'saved' else 'pending_terms' end,'Saved prediction ' || n,$2 || n,now() from generate_series(1,101) n`, [owner.x_user_id, randomUUID()]);
  const page = await browser.get('/me/inbox');
  assert.equal(page.status, 200);
  const outcome = page.text.indexOf('@someone: Yes');
  const fold = page.text.search(/<summary[^>]*>\s*Saved predictions/i);
  assert.ok(outcome >= 0, 'older outcome remains visible');
  assert.ok(fold > outcome, 'saved acknowledgements are grouped after the outcome');
  assert.doesNotMatch(page.text.slice(page.text.indexOf('<main'), fold), /Saved prediction \d/);
  const rows = await s.db.one(`select count(*)::int as n, count(*) filter(where done_at is not null)::int as done
    from inbox where owner_x_user_id=$1`, [owner.x_user_id]);
  assert.deepEqual(rows, { n: 102, done: 0 });
});

test('malformed and out-of-range segmented dates preserve fields without creating a Bet', async () => {
  for (const [field, value] of [['acceptByDay', 'abc'], ['acceptByHour', '24'], ['resolveAtMinute', '60']]) {
    const input = { ...base(), ...parts('acceptBy', iso(2)), ...parts('resolveAt', iso(3)), [field]: value };
    const page = await browser.submit('/me/bets', input, { from: '/me/bets/new' });
    assert.equal(page.status, 400, field);
    const select = page.text.match(new RegExp(`<select\\b[^>]*name="${field}"[^>]*>[\\s\\S]*?<\\/select>`))?.[0];
    assert.ok(select, field);
    assert.match(select, new RegExp(`<option\\b(?=[^>]*\\bvalue="${value}")(?=[^>]*\\bselected\\b)[^>]*>`));
    assert.match(page.text, /Synthetic retained proposition/);
    assert.equal((await s.db.one('select count(*)::int as n from bilateral_bets where request_id=$1', [input.requestId])).n, 0);
  }
});

test('an inbox badge query failure still returns a complete private error response', async () => {
  let badgeQueries = 0;
  const db = { ...s.db, one(query, params) {
    if (query.includes('count(*)::int as n from inbox')) {
      badgeQueries += 1;
      throw new Error('Synthetic badge read failure');
    }
    return s.db.one(query, params);
  } };
  const handle = createApp({ db, config: s.config, fetchImpl });
  const res = { headersSent: false, writeHead(status, headers) { this.status = status; this.headers = headers; this.headersSent = true; }, end(body) { this.body = body; } };
  await handle({ method: 'GET', url: '/missing-synthetic-page', headers: { cookie: browser.cookieHeader() } }, res);
  assert.equal(res.status, 500);
  assert.equal(res.headers['cache-control'], 'no-store');
  assert.match(res.body, /That didn’t work/);
  assert.match(res.body, /Go back/);
  assert.equal(badgeQueries, 1, 'error rendering must not repeat the failed badge query');
});

test('private linked Bet identifies its source separately and public Bet withholds private source identity', async () => {
  const bet = await createBet(s.db, owner, { ...base(), sourceSaveId: String(sourceSave.id), acceptBy: iso(2), resolveAt: iso(3) });
  const privatePage = await browser.get(`/bets/${bet.id}`);
  assert.equal(privatePage.status, 200);
  // Explicit synthetic finalized snapshot and matching binding, solely for projection testing.
  const binding = 'a'.repeat(64), wallet = 'betowner.testnet';
  const chain = { id: bet.id, terms_hash: bet.terms_hash, stake_yocto: bet.stake_yocto, creator_side: bet.creator_side,
    accept_by_ns: ns(bet.accept_by), resolve_at_ns: ns(bet.resolve_at), invited_account: null, creator: wallet,
    creator_binding_hash: binding, status: 'offered', acceptor: null, proposal: null };
  await s.db.query(`insert into bilateral_near_requests(id,bet_id,user_id,wallet_account,method,args,binding_hash,metadata)
    values($1,$2,$3,$4,'create_bet','{}',$5,'{"fixture":"synthetic"}')`, [randomUUID(), bet.id, owner.id, wallet, binding]);
  await s.db.query(`update bilateral_bets set chain_state=$2,creator_wallet=$3,near_height=321,near_verified_at=clock_timestamp() where id=$1`, [bet.id, chain, wallet]);
  await publishBet(s.db, owner, bet.id);
  const publicPage = await s.browser().get(`/bets/${bet.id}`);
  assert.equal(publicPage.status, 200);
  assert.doesNotMatch(publicPage.text, /private_source_author/);
  assert.match(publicPage.text, /Offered by <b>bet_owner<\/b>/, "only the name is bold");
  assert.match(privatePage.text, /data-source-author|Source prediction by/i);
  assert.match(privatePage.text, /private_source_author/);
  assert.match(privatePage.text, /class="face/);
  const publishedSource = await browser.submit('/me/settings/publish', [
    ['confirm', '1'], ['defaults', 'private'], ['publish', String(sourceSave.id)],
  ], { from: '/me/settings' });
  assert.equal(publishedSource.status, 200);
  const publicWithSource = await s.browser().get(`/bets/${bet.id}`);
  assert.match(publicWithSource.text, /data-source-author="prediction"/);
  assert.match(publicWithSource.text, /private_source_author/);
  assert.match(publicWithSource.text, /href="https:\/\/x\.com\/private_source_author\/status\/\d+"/);
  s.config.x.simulatedOrigin = s.fakeX.base;
  try {
    const simulated = await s.browser().get(`/bets/${bet.id}`);
    assert.ok(simulated.text.includes(`href="${s.fakeX.base}/?c=`));
    assert.match(simulated.text, /On simulated X/);
    assert.doesNotMatch(simulated.text, /href="https:\/\/x\.com\/private_source_author\/status\//);
  } finally {
    delete s.config.x.simulatedOrigin;
  }
});

test('published Bet list lookup batches authorized saves and respects withdrawal', async () => {
  const { firstPublicBetsForSaves, publicBetsForSave, withdrawBetPublication } = await load('server/src/bet-public.mjs');
  const [expected] = await publicBetsForSave(s.db, sourceSave.id);
  assert.ok(expected);
  let transactions = 0;
  const db = { ...s.db, tx(fn) { transactions += 1; return s.db.tx(fn); } };
  const batch = await firstPublicBetsForSaves(db, [sourceSave.id, '999999999', sourceSave.id]);
  assert.equal(transactions, 1);
  assert.equal(batch.size, 1);
  assert.deepEqual(batch.get(String(sourceSave.id)), expected);
  assert.equal(Object.hasOwn(batch.get(String(sourceSave.id)), 'source_save_id'), false);
  await withdrawBetPublication(s.db, owner, expected.id);
  assert.equal((await firstPublicBetsForSaves(s.db, [sourceSave.id])).size, 0);
});
