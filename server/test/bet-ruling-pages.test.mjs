// INTEGRATION: production HTTP routes and real PostgreSQL; enclave records and keys are synthetic.
import assert from 'node:assert/strict';
import { randomUUID, sign } from 'node:crypto';
import { before, after, beforeEach, test } from 'node:test';
import { createBet } from '../src/bets.mjs';
import { publishBet, withdrawBetPublication } from '../src/bet-public.mjs';
import { sha256 } from '../src/attested-signature.mjs';
import { quoteSummary, submittedEvidence, verdictInput, verifyEnclaveRecord } from '../src/enclave-ruling.mjs';
import { startStack } from './support/app.mjs';
import { resetDb } from './support/pg.mjs';
import { enclaveEnv, enclaveRulingFixture, JURORS, keyFor } from './support/enclave.mjs';

let s, creatorBrowser, creator, acceptor, bet, statement;
const SOURCE = 'https://example.org/result';
const MODELS = [...JURORS, 'Qwen/Qwen3.8-27B'];
const ns = value => (BigInt(new Date(value).getTime()) * 1000000n).toString();
const path = () => `/bets/${bet.id}/ruling`;
const time = value => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short',
}).format(new Date(value)) + ' UTC';
const VERIFIED = [
  'Each model ran in an Intel TDX enclave whose quote chains to Intel’s root certificate',
  'Each enclave’s signing key and this request’s fresh nonce are inside its quote',
  'Each verdict is signed by its enclave’s key',
  'The signed request names this bet and its terms hash',
  'The evidence text the models read is inside the signed request',
];

before(async () => {
  s = await startStack(enclaveEnv, { fetchImpl: async (url, options) => {
    if (s && new URL(url).origin === new URL(s.fakeX.base).origin) return fetch(url, options);
    throw new Error('Unexpected external request');
  } });
});
after(async () => { await s?.close(); });
beforeEach(async () => {
  await resetDb(s.db);
  creatorBrowser = await s.signIn(s.fakeX.addUser('1901', 'public_bettor'));
  await creatorBrowser.submit('/setup', { profile: 'private', defaults: 'private' });
  const acceptorBrowser = await s.signIn(s.fakeX.addUser('1902', 'other_bettor'));
  await acceptorBrowser.submit('/setup', { profile: 'private', defaults: 'private' });
  creator = await s.db.one("select * from users where x_user_id='1901'");
  acceptor = await s.db.one("select * from users where x_user_id='1902'");
  bet = await createBet(s.db, creator, { requestId: randomUUID(), claim: 'The public event will occur.',
    criteria: 'The official result.', evidenceSourceUrl: SOURCE, creatorSide: 'yes', stakeNear: '0.1',
    refereeAccount: 'referee.testnet', acceptBy: new Date(Date.now() + 86400000).toISOString(),
    resolveAt: new Date(Math.ceil((Date.now() + 172800000) / 3600000) * 3600000).toISOString() });
  const source = await s.db.one(`insert into sources (platform,platform_id,url,text,acquisition)
    values ('x',$1,$2,'Private source words','mention') returning id`, [randomUUID(), SOURCE]);
  statement = await s.db.one(`insert into statements (source_id,span,speaker)
    values ($1,'Private source words','@private_author') returning id`, [source.id]);
  const save = await s.db.one(`insert into saves (owner_x_user_id,owner_user_id,statement_id,relation,intake)
    values ('1901',$1,$2,'following','mention') returning id`, [creator.id, statement.id]);
  await s.db.query('update bilateral_bets set source_save_id=$2 where id=$1', [bet.id, save.id]);
  for (const [user, wallet, method, binding] of [
    [creator, 'creator.testnet', 'create_bet', 'a'.repeat(64)],
    [acceptor, 'other.testnet', 'accept_bet', 'b'.repeat(64)],
  ]) {
    await s.db.query(`insert into bilateral_near_requests (id,bet_id,user_id,wallet_account,method,args,binding_hash)
      values ($1,$2,$3,$4,$5,'{}',$6)`, [randomUUID(), bet.id, user.id, wallet, method, binding]);
  }
  await s.db.query('insert into bilateral_bet_public_consents (bet_id,user_id) values ($1,$2)', [bet.id, acceptor.id]);
  await setChain('accepted');
  await publishBet(s.db, creator, bet.id);
});

async function setChain(status, outcome = null) {
  const chain = { id: bet.id, terms_hash: bet.terms_hash, stake_yocto: bet.stake_yocto, creator_side: 'yes',
    accept_by_ns: ns(bet.accept_by), resolve_at_ns: ns(bet.resolve_at), invited_account: null,
    referee: 'referee.testnet', creator: 'creator.testnet', creator_binding_hash: 'a'.repeat(64),
    status, acceptor: 'other.testnet', acceptor_binding_hash: 'b'.repeat(64),
    resolution: outcome ? { outcome, method: 'referee' } : null };
  await s.db.query(`update bilateral_bets set chain_state=$2,creator_wallet='creator.testnet',acceptor_wallet='other.testnet',
    acceptor_user_id=$3,accepted_at=clock_timestamp(),status=$4,outcome=$5,
    settled_at=case when $4='settled' then clock_timestamp() else null end,
    near_height=321,near_verified_at=clock_timestamp() where id=$1`, [bet.id, chain, acceptor.id, status, outcome]);
}

async function addEvidence({ side, title, url, finalUrl, text }) {
  return s.db.one(`insert into bet_evidence (statement_id,bet_id,user_id,side,url,final_url,title,body,body_hash,via)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,'page') returning *`,
  [statement.id, bet.id, side === 'yes' ? creator.id : acceptor.id, side, url, finalUrl, title, text, sha256(Buffer.from(text))]);
}

async function insertRuling(options = {}, items = null) {
  const record = enclaveRulingFixture({ models: MODELS, reason: 'The source confirms the outcome.', ...options, material: {
    claim: bet.claim, madeAt: bet.created_at, deadline: bet.resolve_at, postUrl: SOURCE,
    bets: [{ id: bet.id, termsHash: bet.terms_hash }],
  } });
  if (items) {
    // Re-sign the fixture's requests so the hostile page text is genuinely inside the signed record.
    record.evidence = submittedEvidence(items, record.evidence.closesAt);
    for (const verdict of record.verdicts) {
      const request = JSON.parse(Buffer.from(verdict.requestBody, 'base64').toString('utf8'));
      const now = JSON.parse(request.messages[1].content).now;
      request.messages[1].content = verdictInput(record.material, now, record.jury, record.evidence.text, record.mode);
      const bytes = Buffer.from(JSON.stringify(request));
      verdict.requestBody = bytes.toString('base64');
      verdict.requestHash = sha256(bytes);
      verdict.signature.text = `${verdict.model}:${verdict.requestHash}:${verdict.responseHash}`;
      verdict.signature.signature = sign(null, Buffer.from(verdict.signature.text), keyFor(verdict.model).privateKey).toString('hex');
    }
  }
  verifyEnclaveRecord(record);
  await s.db.query(`insert into bilateral_bet_events (bet_id,actor_user_id,kind,detail)
    values ($1,$2,'enclave_ruling',$3)`, [bet.id, creator.id, record]);
  return record;
}

test('price ruling shows the post, three models, confidence, window, price and verified checks', async () => {
  const record = await insertRuling();
  const response = await s.browser().get(path());
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /text\/html/);
  assert.match(response.headers.get('content-security-policy'), /style-src 'self'/);
  assert.doesNotMatch(response.text, /\sstyle=|<style\b|<script(?![^>]*\bsrc=)/i);
  assert.ok(response.text.includes('<p class="pwho"><b>public_bettor</b><span>@public_bettor</span></p>'));
  assert.ok(response.text.includes(`<p class="said">${bet.claim}</p>`));
  assert.doesNotMatch(response.text, /Private source words|private_author/);
  assert.ok(response.text.includes(`<p class="lead">Ruled yes<span>${time(record.decidedAt)}</span></p>`));
  const rows = response.text.match(/<li class="prow">[\s\S]*?<\/li>/g);
  for (const model of MODELS) {
    const row = rows.find(row => row.includes(`<b>${model}</b>`));
    assert.ok(row, `Missing model: ${model}`);
    assert.ok(row.includes('<b>yes</b><span>95%</span>'));
    assert.ok(row.includes('<p class="meta">The source confirms the outcome.</p>'));
  }
  assert.ok(response.text.includes('Every model has to agree at 80% or more, or both stakes go back.'));
  assert.ok(response.text.includes(`Coinbase BTC-USD price, ${time(record.plan.parsed.start)} to ${time(record.plan.parsed.end)}`));
  assert.ok(response.text.includes('opened at US$100000'));
  assert.ok(response.text.includes(`href="${record.evidence.urls[0].replaceAll('&', '&amp;')}"`));
  assert.match(response.text, />Coinbase data<\/a>/);
  assert.match(response.text, /<h2>Verified<\/h2>/);
  for (const line of VERIFIED) assert.ok(response.text.includes(`✓ ${line}`), `Missing verified check: ${line}`);
  assert.equal((response.text.match(/✓ /g) || []).length, VERIFIED.length);
  assert.ok(response.text.includes('<p class="gut quiet">Not checked: enclave measurements against a published list, TCB level and revocation, the GPU’s own attestation.</p>'));
  assert.match(response.text, /<summary>Check it yourself<\/summary>/);
  assert.ok(response.text.includes(`<code>node scripts/verify-enclave-ruling.mjs ${s.config.baseUrl} ${bet.id}</code>`));
  assert.ok(response.text.includes(`href="/bets/${bet.id}/enclave-ruling.json"`));
  for (const quote of quoteSummary(record)) {
    assert.ok(response.text.includes(`${quote.role} ${quote.model} <code>${quote.mrtd.slice(0, 16)}</code>`));
    assert.ok(!response.text.includes(quote.mrtd));
  }
});

test('submitted evidence shows each side, final link, host and escaped stored page text', async () => {
  const yes = await addEvidence({ side: 'yes', title: 'Official report', url: 'https://posted.example.org/report',
    finalUrl: 'https://news.example.org/report', text: '<script>alert("owned")</script>\n\nThe event happened.' });
  const no = await addEvidence({ side: 'no', title: 'Public record', url: 'https://records.example.org/result',
    finalUrl: 'https://records.example.org/result', text: 'The recorded result.' });
  await insertRuling({ source: 'evidence' }, [yes, no]);
  const response = await s.browser().get(path());
  assert.equal(response.status, 200);
  assert.match(response.text, /<b>Bet yes<\/b>/);
  assert.match(response.text, /<b>Bet no<\/b>/);
  assert.match(response.text, /href="https:\/\/news\.example\.org\/report"[^>]*>Official report<\/a>/);
  assert.match(response.text, /href="https:\/\/records\.example\.org\/result"[^>]*>Public record<\/a>/);
  assert.doesNotMatch(response.text, /href="https:\/\/posted\.example\.org\/report"/);
  assert.match(response.text, /<p class="meta">news\.example\.org<\/p>/);
  assert.equal((response.text.match(/<summary>Page text<\/summary>/g) || []).length, 2);
  assert.ok(response.text.includes('&lt;script&gt;alert(&quot;owned&quot;)&lt;/script&gt;'));
  assert.doesNotMatch(response.text, /<script>alert/);
  assert.ok(response.text.includes('The event happened.'));
  assert.ok(response.text.includes('The recorded result.'));
});

test('review mode computes agreement from the settled Bet rather than the stored flag', async () => {
  await setChain('settled', 'yes');
  await insertRuling({ mode: 'review', outcome: 'yes', agrees: false });
  const response = await s.browser().get(path());
  assert.equal(response.status, 200);
  assert.match(response.text, /<p class="lead">Second opinion: agrees<span>/);
  assert.doesNotMatch(response.text, /Ruled yes/);
  assert.ok(response.text.includes('A second opinion does not change the payout.'));
  assert.doesNotMatch(response.text, /both stakes go back/, 'a second opinion never moves money');
});

test('private Bets return 404 even to a bettor', async () => {
  await insertRuling();
  await withdrawBetPublication(s.db, creator, bet.id);
  for (const browser of [s.browser(), creatorBrowser]) {
    const response = await browser.get(path());
    assert.equal(response.status, 404);
    assert.doesNotMatch(response.text, /Each model ran|Qwen\/Qwen3\.8-27B/);
  }
});

test('a Bet with no verified record returns 404', async () => {
  const response = await s.browser().get(path());
  assert.equal(response.status, 404);
  assert.doesNotMatch(response.text, /✓|<h2>Verified<\/h2>/);
});

test('tampering with a stored verdict changes a readable ruling into a 404', async () => {
  await insertRuling();
  assert.equal((await s.browser().get(path())).status, 200);
  await s.db.query(`update bilateral_bet_events
    set detail=jsonb_set(detail,'{verdicts,0,verdict,outcome}',to_jsonb('no'::text))
    where bet_id=$1 and kind='enclave_ruling'`, [bet.id]);
  const response = await s.browser().get(path());
  assert.equal(response.status, 404);
  assert.doesNotMatch(response.text, /✓|<h2>Verified<\/h2>/);
});

test('the ruling has exactly one filled button, to make a new Bet from this one', async () => {
  await insertRuling();
  for (const browser of [s.browser(), creatorBrowser]) {
    const response = await browser.get(path());
    assert.equal(response.status, 200);
    const filled = [...response.text.matchAll(/<(?:a|button)\b[^>]*class="([^"]*)"[^>]*>/g)]
      .filter(([, classes]) => /\bprimary\b|\bbtn\b/.test(classes) || (/\bpill\b/.test(classes) && /\bsolid\b/.test(classes)));
    assert.equal(filled.length, 1);
    assert.ok(response.text.includes(`<a class="pill solid big" href="/bets/new?from=${bet.id}">Make your own bet</a>`));
  }
});
