// INTEGRATION: production HTTP routes and real PostgreSQL; all enclave records are synthetic.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { before, after, beforeEach, test } from 'node:test';
import { createBet } from '../src/bets.mjs';
import { publishBet, readPublicBet, withdrawBetPublication } from '../src/bet-public.mjs';
import { publishPublicResultEvidence } from '../src/bet-result-evidence.mjs';
import { runAttestedCheck } from '../src/attested-check.mjs';
import { sha256 } from '../src/attested-signature.mjs';
import { dayMonth } from '../src/marked.mjs';
import { nextBetTime } from '../src/bet-view.mjs';
import { startStack } from './support/app.mjs';
import { resetDb } from './support/pg.mjs';
import { enclaveEnv, enclaveRulingFixture, fakeNearAi } from './support/enclave.mjs';

let s, creatorBrowser, acceptorBrowser, creator, acceptor, bet, statement;
const HIDDEN_TEXT = 'private evidence body that must stay hidden';
const SOURCE = 'https://example.org/result';
const ns = value => (BigInt(new Date(value).getTime()) * 1000000n).toString();
const clock = value => new Intl.DateTimeFormat('en-GB', { timeZone: 'UTC', hour: '2-digit', minute: '2-digit' }).format(new Date(value));
const path = () => `/bets/${bet.id}`;
const rulingPath = () => `/bets/${bet.id}/ruling`;
const jsonPath = () => `${path()}/enclave-ruling.json`;

before(async () => {
  s = await startStack(enclaveEnv, { fetchImpl: async (url, options) => {
    if (s && new URL(url).origin === new URL(s.fakeX.base).origin) return fetch(url, options);
    throw new Error('Unexpected external request');
  } });
});
after(async () => { await s?.close(); });
beforeEach(async () => {
  await resetDb(s.db);
  s.config.play.settleDelaySeconds = 600;
  s.config.nearai.apiKey = 'synthetic-test-key';
  creatorBrowser = await s.signIn(s.fakeX.addUser('1901', 'public_bettor'));
  await creatorBrowser.submit('/setup', { profile: 'private', defaults: 'private' });
  acceptorBrowser = await s.signIn(s.fakeX.addUser('1902', 'other_bettor'));
  await acceptorBrowser.submit('/setup', { profile: 'private', defaults: 'private' });
  creator = await s.db.one("select * from users where x_user_id='1901'");
  acceptor = await s.db.one("select * from users where x_user_id='1902'");
  bet = await createBet(s.db, creator, { requestId: randomUUID(), claim: 'The public event will occur.',
    criteria: 'The official result.', evidenceSourceUrl: SOURCE, creatorSide: 'yes', stakeNear: '0.1',
    refereeAccount: 'referee.testnet', acceptBy: new Date(Date.now() + 86400000).toISOString(),
    // The shared price fixture uses hourly candles; keep their closing edge exact.
    resolveAt: new Date(Math.ceil((Date.now() + 172800000) / 3600000) * 3600000).toISOString() });
  const source = await s.db.one(`insert into sources (platform,platform_id,url,text,acquisition)
    values ('x',$1,$2,'Private source words','mention') returning id`, [randomUUID(), SOURCE]);
  statement = await s.db.one(`insert into statements (source_id,span,speaker) values ($1,'Private source words','@author') returning id`, [source.id]);
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

async function insertRuling(options = {}) {
  if (options.source === 'evidence' && !await s.db.one('select id from bet_evidence where statement_id=$1', [statement.id])) {
    await addEvidence();
  }
  const record = enclaveRulingFixture({ ...options, material: {
    claim: bet.claim, madeAt: bet.created_at, deadline: bet.resolve_at, postUrl: SOURCE,
    bets: [{ id: bet.id, termsHash: bet.terms_hash }],
  } });
  await s.db.query(`insert into bilateral_bet_events (bet_id,actor_user_id,kind,detail) values ($1,$2,'enclave_ruling',$3)`,
    [bet.id, creator.id, record]);
  return record;
}

async function clearRuling() {
  await s.db.query("delete from bilateral_bet_events where bet_id=$1 and kind='enclave_ruling'", [bet.id]);
}

async function addEvidence({ title = 'Official report', url = 'https://news.example.org/report' } = {}) {
  return s.db.one(`insert into bet_evidence (statement_id,bet_id,user_id,side,url,title,body,body_hash,via)
    values ($1,$2,$3,'yes',$4,$5,$6,$7,'page') returning *`,
  [statement.id, bet.id, creator.id, url, title, HIDDEN_TEXT, sha256(Buffer.from(HIDDEN_TEXT))]);
}

async function pages() {
  const publicPage = await s.browser().get(path());
  const bettorPage = await creatorBrowser.get(path());
  assert.equal(publicPage.status, 200);
  assert.equal(bettorPage.status, 200);
  return [publicPage.text, bettorPage.text];
}

async function bothContain(expected) {
  for (const page of await pages()) {
    assert.ok(page.includes(expected), `Missing: ${expected}`);
    assert.ok(page.includes(`href="${rulingPath()}"`));
  }
}

test('open evidence leads both pages, with one filled add action only for bettors and no result proposal', async () => {
  bet.accept_by = new Date(Date.now() - 7200000).toISOString();
  bet.resolve_at = new Date(Date.now() - 3600000).toISOString();
  await s.db.query('update bilateral_bets set accept_by=$2,resolve_at=$3 where id=$1', [bet.id, bet.accept_by, bet.resolve_at]);
  await setChain('accepted');
  // Off the current minute, so the closing time cannot coincide with the evidence row's own timestamp.
  const closes = new Date(Date.now() + 4 * 86400000 + 37 * 60000).toISOString();
  await s.db.query("insert into enclave_plans (statement_id,source,closes_at,record) values ($1,'evidence',$2,'{}')", [statement.id, closes]);
  await addEvidence();
  const [publicPage, bettorPage] = await pages();
  const line = 'Then a NEAR AI enclave jury reads both sides’ links and decides.';
  for (const [page, lead] of [[publicPage, 'Both sides are in'], [bettorPage, 'Links are open']]) {
    assert.ok(page.includes(`<p class="lead">${lead}<span>Links close ${nextBetTime(closes)}</span></p>`));
    assert.ok(page.includes(line));
    assert.equal((page.match(new RegExp(`${clock(closes)} UTC`, 'g')) || []).length, 1);
    assert.doesNotMatch(page, new RegExp(HIDDEN_TEXT));
    assert.doesNotMatch(page, new RegExp(sha256(Buffer.from(HIDDEN_TEXT))));
    assert.doesNotMatch(page, /enclave-ruling\.json/);
  }
  assert.match(publicPage, /<details class="fold"><summary>Links, 1<\/summary>/);
  assert.match(publicPage, /Bet yes: <a class="tl" href="https:\/\/news\.example\.org\/report"[^>]*>Official report<\/a>, @public_bettor/);
  assert.match(bettorPage, /<details class="fold"><summary>Links, 1<\/summary>/);
  assert.doesNotMatch(bettorPage, /class="evidence-row"/);
  assert.doesNotMatch(publicPage, /Add a link/);
  assert.ok(bettorPage.includes(`<a class="pill solid big" href="${path()}/evidence">Add a link</a>`));
  assert.match(bettorPage, /<a class="tl"[^>]*><svg class="xmark"[^>]*>[\s\S]*?<\/svg>Post on X<\/a>/);
  assert.doesNotMatch(bettorPage, /<summary>Propose a result<\/summary>|action="[^"\n]*\/propose"/);
  assert.match((await acceptorBrowser.get(path())).text, /Add a link/);
  const stranger = await s.signIn(s.fakeX.addUser('1903', 'evidence_viewer'));
  assert.doesNotMatch((await stranger.get(path())).text, /Add a link/);
  assert.equal((bettorPage.match(/class="primary big"/g) || []).length, 0);
  assert.equal((bettorPage.match(/class="pill solid big"/g) || []).length, 1);
});

test('evidence plans appear with no links, and close without an add link', async () => {
  const closes = new Date(Date.now() + 86400000).toISOString();
  await s.db.query("insert into enclave_plans (statement_id,source,closes_at,record) values ($1,'evidence',$2,'{}')", [statement.id, closes]);
  assert.match((await creatorBrowser.get(path())).text, /Then a NEAR AI enclave jury reads both sides’ links and decides\./);
  await s.db.query("update enclave_plans set closes_at=clock_timestamp()-interval '1 minute' where statement_id=$1", [statement.id]);
  for (const page of await pages()) assert.doesNotMatch(page, /Then a NEAR AI enclave jury reads both sides’ links and decides\.|Add a link|Links, 0/);
  // Once links close, the page shows the jurors who are deciding, before any ruling exists.
  await setChain('accepted');
  for (const page of await pages()) {
    assert.match(page, /<ul class="jury-rail deciding" aria-label="The NEAR AI enclave jury">/);
    assert.ok((page.match(/<span>Deciding<\/span><\/li>/g) || []).length >= 1, 'each juror reads Deciding');
  }
});

test('evidence before a plan uses the configured window and only public metadata', async () => {
  const item = await addEvidence();
  const window = 12345;
  const projection = await s.db.tx(tx => readPublicBet(tx, bet.id, { evidenceWindowSeconds: window }));
  assert.equal(projection.enclave, null);
  assert.equal(projection.evidence.closesAt, new Date(new Date(bet.resolve_at).getTime() + window * 1000).toISOString());
  assert.equal(projection.evidence.open, true);
  assert.deepEqual(projection.evidence.items, [{ side: 'yes', url: item.url, postedUrl: item.url, title: item.title,
    by: 'public_bettor', at: item.at.toISOString() }]);
  assert.doesNotMatch(JSON.stringify(projection.evidence), new RegExp(HIDDEN_TEXT));
});

test('pending outcomes use the recorded Result time rather than the jury decision time', async () => {
  const resolvedAt = new Date(Date.parse(bet.resolve_at) + 2 * 3600000 + 17 * 60000).toISOString();
  s.config.play.settleDelaySeconds = 3600;
  await s.db.query('update statements set resolved_at=$2 where id=$1', [statement.id, resolvedAt]);
  const paysAt = nextBetTime(new Date(Date.parse(resolvedAt) + 3600000));
  for (const source of ['coinbase-candles', 'evidence']) {
    for (const outcome of ['yes', 'no']) {
      const record = await insertRuling({ source, outcome });
      assert.notEqual(clock(new Date(Date.parse(record.decidedAt) + 3600000)), paysAt);
      const from = source === 'coinbase-candles' ? 'Coinbase’s BTC-USD price' : 'the links both sides posted';
      await bothContain(`A NEAR AI enclave jury ruled from ${from}.`);
      const favoured = outcome === 'yes' ? '@public_bettor' : '@other_bettor';
      const pendingPages = [...await pages(), (await acceptorBrowser.get(path())).text];
      for (const [index, page] of pendingPages.entries()) {
        const who = (index === 1 && outcome === 'yes') || (index === 2 && outcome === 'no') ? 'You' : favoured;
        assert.ok(page.includes(`<p class="lead">${who} won<span>Pays out ${paysAt}</span></p>`));
        assert.ok(page.includes(`<div class="bet-seats" data-ruling="${outcome}">`));
        assert.match(page, /class="pill solid big"[^>]*>[\s\S]*?Post the result<\/a>/);
        assert.doesNotMatch(page, />Post on X<\/a>/);
        assert.ok(page.includes(`<span class="${outcome === 'yes' ? 'hl' : 'struck'}">${bet.claim}</span>`));
        assert.ok(page.includes(` <a class="tl" href="${rulingPath()}">See the ruling</a></p>`), 'the ruling link sits at the end of the jury sentence');
        assert.match(page, /<summary>Rules<\/summary>[\s\S]*A reviewer can correct a ruling before it pays out\.<\/dd>/);
        assert.doesNotMatch(page, /unless a reviewer corrects it|<summary>Propose a result<\/summary>/);
      }
      await clearRuling();
    }
  }
});

test('settled rulings, corrections and ambiguous refunds render on both pages', async () => {
  for (const source of ['coinbase-candles', 'evidence']) {
    for (const outcome of ['yes', 'no']) {
      await setChain('settled', outcome);
      const record = await insertRuling({ source, outcome });
      const count = record.verdicts.length;
      await bothContain(`All ${count === 3 ? 'three' : count} models, each in a NEAR AI enclave, said ${outcome}.`);
      await clearRuling();
      await insertRuling({ source, outcome: outcome === 'yes' ? 'no' : 'yes' });
      await bothContain('A reviewer corrected the enclave’s ruling.');
      await clearRuling();
    }
  }
  await setChain('settled', 'void');
  await insertRuling({ source: 'evidence', outcome: 'unclear' });
  await bothContain('The NEAR AI enclave jury could not agree.');
  for (const page of await pages()) {
    assert.match(page, /<span>Stakes returned<\/span>/);
    assert.doesNotMatch(page, /Agreed void/);
  }
  await setChain('settled', 'yes');
  await bothContain('A reviewer corrected the enclave’s ruling.');
});

test('a settled loser starts another Bet while the winner keeps the result action', async () => {
  for (const outcome of ['yes', 'no']) {
    await setChain('settled', outcome);
    await insertRuling({ outcome });
    const winner = outcome === 'yes' ? creatorBrowser : acceptorBrowser;
    const loser = outcome === 'yes' ? acceptorBrowser : creatorBrowser;
    const loserPage = (await loser.get(path())).text;
    assert.ok(loserPage.includes(`<a class="pill solid big" href="/bets/new?from=${bet.id}">Make another bet</a>`));
    assert.match(loserPage, /<a class="tl"[^>]*>Post the result<\/a>/);
    assert.equal((loserPage.match(/class="(?:pill solid big|primary big)"/g) || []).length, 1);
    assert.doesNotMatch((await winner.get(path())).text, /class="pill solid big"[^>]*>Make another bet/);
    for (const page of await pages()) {
      assert.match(page, /<b>0\.2<\/b><small>test NEAR pot<\/small>/);
      assert.doesNotMatch(page, /<small>won<\/small>|<small>credited<\/small>/);
    }
    await clearRuling();
  }
});

test('review mode says whether the enclave agrees for either evidence source', async () => {
  await setChain('settled', 'yes');
  for (const source of ['coinbase-candles', 'evidence']) {
    for (const agrees of [true, false]) {
      const record = await insertRuling({ mode: 'review', source, outcome: agrees ? 'yes' : 'no', agrees: !agrees });
      const settled = await s.db.one('select settled_at from bilateral_bets where id=$1', [bet.id]);
      await bothContain(`A Stated reviewer recorded Yes on ${dayMonth(settled.settled_at)}. The jury ${agrees ? 'agreed' : 'disagreed'} on ${dayMonth(record.decidedAt)}.`);
      await clearRuling();
    }
  }
});

test('JSON returns the verified record and recipe with the signed-check headers', async () => {
  assert.equal((await s.browser().get(jsonPath())).status, 404);
  const record = await insertRuling({ source: 'evidence' });
  const projection = await s.db.tx(tx => readPublicBet(tx, bet.id));
  assert.deepEqual(projection.enclave, {
    mode: 'ruling', outcome: record.outcome, agrees: null, models: record.verdicts.map(verdict => verdict.model),
    verdicts: record.verdicts.map(({ parsed }) => ({ outcome: parsed.outcome, confidence: parsed.confidence })),
    reason: record.verdicts[0].parsed.reason, source: 'submitted', product: null,
    itemCount: record.evidence.items.length, decidedAt: record.decidedAt, minConfidence: record.minConfidence,
  });
  const response = await s.browser().get(jsonPath());
  assert.equal(response.status, 200);
  assert.match(response.headers.get('content-type'), /application\/json; charset=utf-8/);
  assert.equal(response.headers.get('cache-control'), 'no-cache');
  assert.equal(response.headers.get('x-content-type-options'), 'nosniff');
  const body = JSON.parse(response.text);
  assert.deepEqual(body.record, record);
  assert.match(body.recipe, /verify-enclave-ruling\.mjs/);
  assert.match(body.recipe, /verifyEnclaveRecord/);
  s.config.nearai.apiKey = '';
  assert.equal((await s.browser().get(jsonPath())).status, 200);
  await bothContain('A NEAR AI enclave jury ruled from the links both sides posted.');
  await s.db.query("update bilateral_bet_events set detail=jsonb_set(detail,'{materialHash}',to_jsonb('tampered'::text)) where bet_id=$1 and kind='enclave_ruling'", [bet.id]);
  assert.equal((await s.browser().get(jsonPath())).status, 404);
  for (const page of await pages()) assert.doesNotMatch(page, /enclave-ruling\.json/);
});

test('private Bets expose neither the ruling nor submitted evidence, even to a bettor', async () => {
  await addEvidence();
  await insertRuling({ source: 'evidence' });
  await withdrawBetPublication(s.db, creator, bet.id);
  assert.equal(await s.db.tx(tx => readPublicBet(tx, bet.id)), null);
  assert.equal((await s.browser().get(jsonPath())).status, 404);
  const privatePage = await creatorBrowser.get(path());
  assert.equal(privatePage.status, 200);
  // Every page carries the same generic site description; it names enclaves but holds no Bet content.
  const siteDescription = '<meta name="description" content="Bet on what is said on X. Three AI models in NEAR AI enclaves decide the result.">';
  assert.equal(privatePage.text.split(siteDescription).length - 1, 1, 'the head carries only the generic site description');
  const privateBody = privatePage.text.replace(siteDescription, '');
  assert.doesNotMatch(privateBody, /NEAR AI enclave|enclave_ruling|enclave-ruling\.json|Add a link|Links, 1|Official report|news\.example\.org/);
  assert.doesNotMatch(privateBody, new RegExp(HIDDEN_TEXT));
});

test('private evidence read by the jury is counted without exposing its metadata or signed text', async () => {
  const hidden = await createBet(s.db, acceptor, { requestId: randomUUID(), claim: bet.claim,
    criteria: bet.criteria, evidenceSourceUrl: SOURCE, creatorSide: 'yes', stakeNear: '0.1',
    acceptBy: new Date(bet.accept_by).toISOString(), resolveAt: new Date(bet.resolve_at).toISOString() });
  const { source_save_id } = await s.db.one('select source_save_id from bilateral_bets where id=$1', [bet.id]);
  await s.db.query('update bilateral_bets set source_save_id=$2 where id=$1', [hidden.id, source_save_id]);
  const body = 'PRIVATE_JURY_TEXT';
  const privateItem = await s.db.one(`insert into bet_evidence
    (statement_id,bet_id,user_id,side,url,title,body,body_hash,via)
    values ($1,$2,$3,'yes','https://private.example.net/proof','Private jury title',$4,$5,'page') returning id`,
  [statement.id, hidden.id, acceptor.id, body, sha256(Buffer.from(body))]);
  assert.equal(String(privateItem.id), '1', 'the signed fixture names the first evidence row');
  await addEvidence();
  await insertRuling({ source: 'evidence' });
  for (const page of await pages()) {
    assert.match(page, /and 1 link from a private bet/);
    assert.match(page, /Official report/);
    assert.doesNotMatch(page, /Private jury title|private\.example\.net|PRIVATE_JURY_TEXT|fixture_bettor|enclave-ruling\.json/);
  }
  const projection = await s.db.tx(tx => readPublicBet(tx, bet.id));
  assert.equal(projection.evidence.privateItemCount, 1);
  assert.equal(projection.evidence.items.length, 1);
  assert.equal((await s.browser().get(jsonPath())).status, 404);
});

test('evidence titles are escaped and unsafe stored links cannot become active', async () => {
  await addEvidence({ title: '<img src=x onerror=alert(1)>', url: 'javascript:alert(1)' });
  const [publicPage, bettorPage] = await pages();
  // Both viewers get the same escaped links fold.
  assert.match(publicPage, /&lt;img src=x onerror=alert\(1\)&gt;/);
  assert.match(bettorPage, /Links, 1/);
  for (const page of [publicPage, bettorPage]) assert.doesNotMatch(page, /<img src=x|href="javascript:/);
});

test('a ruling takes precedence over a verified legacy signed check', async () => {
  await setChain('settled', 'yes');
  await s.db.query(`insert into bilateral_bet_events (bet_id,actor_user_id,kind,detail)
    values ($1,$2,'referee_resolved',$3)`, [bet.id, creator.id,
    { outcome: 'yes', referee: 'referee.testnet', transactionHash: '11111111111111111111111111111111' }]);
  await s.db.tx(async tx => {
    await tx.one('select id from bilateral_bets where id=$1 for update', [bet.id]);
    await publishPublicResultEvidence(tx, creator.id, await readPublicBet(tx, bet.id), {
      note: 'The official result confirms the event.', url: SOURCE,
      knownAt: new Date(Date.now() - 60000).toISOString(),
    });
  });
  const fake = fakeNearAi({ respond: () => ({ agrees: false, reason: 'The evidence does not show the event.' }) });
  await runAttestedCheck(s.db, s.config, bet.id, creator.id, {
    fetchImpl: fake.fetchImpl,
    fetchEvidence: async url => ({ url, body: '<article><p>The official result describes the event.</p></article>' }),
  });
  for (const page of await pages()) assert.match(page, /attested-check\.json/);
  await insertRuling();
  for (const page of await pages()) {
    assert.ok(page.includes(`href="${rulingPath()}"`), 'the enclave ruling links its own page');
    assert.doesNotMatch(page, /attested-check\.json|near\/planner-test read the links/);
  }
});
