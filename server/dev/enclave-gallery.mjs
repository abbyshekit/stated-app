// INTEGRATION: Real HTTP/pages/Postgres through the test stack; every person,
// post, escrow snapshot, article and signed ruling below is a synthetic fixture.
// Run: node server/dev/enclave-gallery.mjs. Requires the tests' PostgreSQL tools.
// startStack binds 127.0.0.1 on an ephemeral port and has no port option, so use
// the printed base even when GALLERY_PORT is set. No worker or real X/NEAR runs.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, sign } from 'node:crypto';
import { sha256 } from '../src/attested-signature.mjs';
import { publishBet } from '../src/bet-public.mjs';
import { candleEvidence, submittedEvidence, verdictInput, verifyEnclaveRecord } from '../src/enclave-ruling.mjs';
import { evidenceFor } from '../src/bet-evidence.mjs';
import { parseTestNear } from '../src/near-escrow.mjs';
import { setSaveVisibility } from '../src/store.mjs';
import { startStack } from '../test/support/app.mjs';
import { enclaveEnv, enclaveRulingFixture, keyFor } from '../test/support/enclave.mjs';

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const iso = value => new Date(value).toISOString();
const ns = value => (BigInt(new Date(value).getTime()) * 1_000_000n).toString();
const hash = text => sha256(Buffer.from(text));
const dateLabel = value => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric',
}).format(new Date(value));
const LONG_CLAIM = 'The Toronto waterfront ferry terminal will open to paying passengers by the published deadline, with both public entrances and every boarding gate operating, rather than a preview tour, a partial opening or a promise of a later launch date.';
assert.equal(LONG_CLAIM.length, 240);
const FULL_CLAIM = `${LONG_CLAIM} An official schedule must confirm this.`;
assert.equal(FULL_CLAIM.length, 280);

function bindFixtureEvidence(record, rows) {
  // The shared fixture's fixed evidence ID does not name these gallery rows.
  // Re-sign the synthetic jury requests so Verify covers what the page displays.
  record.evidence = submittedEvidence(rows, record.evidence.closesAt);
  signFixtureEvidence(record);
}

function signFixtureEvidence(record) {
  for (const [index, verdict] of record.verdicts.entries()) {
    const request = JSON.parse(Buffer.from(verdict.requestBody, 'base64').toString('utf8'));
    const { now } = JSON.parse(request.messages[1].content);
    request.messages[1].content = verdictInput(record.material, now, record.jury, record.evidence.text, record.mode);
    const bytes = Buffer.from(JSON.stringify(request));
    verdict.requestBody = bytes.toString('base64');
    verdict.requestHash = sha256(bytes);
    verdict.parsed.confidence = record.evidence.kind === 'coinbase-candles' ? [0.99, 1, 0.99][index] : [0.97, 0.92, 0.99][index];
    verdict.verdict.confidence = verdict.parsed.confidence;
    const response = JSON.parse(Buffer.from(verdict.responseBody, 'base64').toString('utf8'));
    response.choices[0].message.content = JSON.stringify(verdict.parsed);
    const responseBytes = Buffer.from(JSON.stringify(response));
    verdict.responseBody = responseBytes.toString('base64');
    verdict.responseHash = sha256(responseBytes);
    const text = `${verdict.model}:${verdict.requestHash}:${verdict.responseHash}`;
    verdict.signature = { ...verdict.signature, text,
      signature: sign(null, Buffer.from(text), keyFor(verdict.model).privateKey).toString('hex') };
  }
}

async function person(stack, id, username) {
  const browser = await stack.signIn(stack.fakeX.addUser(id, username));
  const setup = await browser.submit('/setup', { profile: 'public', defaults: 'private' });
  assert.equal(setup.status, 200, `Setup failed for @${username}`);
  const user = await stack.db.one('select * from users where x_user_id=$1', [id]);
  assert.ok(user?.setup_completed_at, `Setup is incomplete for @${username}`);
  return { user, browser };
}

async function postAndSave(stack, owner, { claim, deadline, madeAt, publicPost = false }) {
  const post = stack.fakeX.post(owner.x_user_id, claim, { at: madeAt });
  const url = `https://x.com/${owner.x_username}/status/${post.id}`;
  const source = await stack.db.one(`insert into sources
    (platform,platform_id,url,text,author_x_user_id,author_username,author_name,published_at,acquisition)
    values ('x',$1,$2,$3,$4,$5,$5,$6,'mention') returning id`,
  [post.id, url, claim, owner.x_user_id, owner.x_username, madeAt]);
  const statement = await stack.db.one(`insert into statements
    (source_id,span,speaker,speaker_x_user_id,deadline_at,deadline_text,created_at)
    values ($1,$2,$3,$4,$5,$6,$7) returning id`,
  [source.id, claim, `@${owner.x_username}`, owner.x_user_id, deadline, dateLabel(deadline), madeAt]);
  const save = await stack.db.one(`insert into saves
    (owner_x_user_id,owner_user_id,statement_id,relation,intake,created_at)
    values ($1,$2,$3,'mine','mention',$4) returning id`,
  [owner.x_user_id, owner.id, statement.id, madeAt]);
  if (publicPost) await setSaveVisibility(stack.db, owner, String(save.id), 'public');
  return { url, statementId: statement.id, saveId: save.id };
}

async function seedBet(stack, creator, acceptor, now, spec) {
  const deadline = iso(Math.floor(now / HOUR) * HOUR - spec.hoursAgo * HOUR);
  const madeAt = iso(Date.parse(deadline) - 3 * DAY);
  const acceptBy = iso(Date.parse(deadline) - DAY);
  const acceptedAt = iso(Date.parse(deadline) - 2 * DAY);
  const source = await postAndSave(stack, creator, { claim: spec.claim, deadline, madeAt });
  const id = randomUUID();
  const salt = randomBytes(32).toString('hex');
  const terms = {
    claim: spec.claim, criteria: spec.criteria, evidenceSourceUrl: source.url,
    creatorSide: 'yes', stakeYocto: parseTestNear(spec.stake), invitedWallet: null,
    acceptBy, resolveAt: deadline, refereeWallet: 'referee.testnet',
  };
  // Historical fixtures need direct inserts: createBet correctly rejects past
  // acceptance dates. Keep its version-2 terms hash and exact decimal parser.
  const termsHash = hash(JSON.stringify({ version: 2, salt,
    creatorUserId: String(creator.id), invitedUserId: null, ...terms }));
  const settled = spec.settledOutcome != null;
  const status = spec.refunded ? 'refunded' : settled ? 'settled' : 'accepted';
  const creatorBinding = randomBytes(32).toString('hex');
  const acceptorBinding = randomBytes(32).toString('hex');
  const chain = {
    id, terms_hash: termsHash, stake_yocto: terms.stakeYocto, creator_side: 'yes',
    accept_by_ns: ns(acceptBy), resolve_at_ns: ns(deadline), invited_account: null,
    referee: terms.refereeWallet, creator: 'priya.testnet', creator_binding_hash: creatorBinding,
    acceptor: 'daniel.testnet', acceptor_binding_hash: acceptorBinding, status,
    resolution: settled ? { outcome: spec.settledOutcome, method: 'referee' } : null,
  };
  const record = spec.rulingOutcome ? enclaveRulingFixture({
    source: spec.source, outcome: spec.rulingOutcome, mode: spec.mode || 'ruling',
    reason: spec.reason, outcomes: spec.outcomes, models: ['Qwen/Qwen3.8-27B', 'deepseek-ai/DeepSeek-V4.1-Flash-1017', 'z-ai/glm-5.3-flash'],
    material: { claim: spec.claim, madeAt, deadline, postUrl: source.url,
      bets: [{ id, termsHash }] },
  }) : null;
  const recordedAt = !record ? null : !settled ? iso(now - 2 * MINUTE)
    : spec.mode === 'review' ? iso(Date.parse(deadline) + 30 * MINUTE) : record.decidedAt;
  const settledAt = !settled ? null : spec.mode === 'review'
    ? iso(Date.parse(deadline) + 2 * HOUR) : iso(Date.parse(record.decidedAt) + 2 * HOUR);
  await stack.db.query(`insert into bilateral_bets
    (id,creator_user_id,acceptor_user_id,request_id,claim,criteria,evidence_source_url,
     creator_side,stake_yocto,accept_by,resolve_at,terms_hash,terms_salt,source_save_id,
     referee_wallet,creator_wallet,acceptor_wallet,chain_state,status,outcome,
     created_at,accepted_at,settled_at,near_height,near_verified_at)
    values ($1,$2,$3,$4,$5,$6,$7,'yes',$8,$9,$10,$11,$12,$13,
      'referee.testnet','priya.testnet','daniel.testnet',$14,$15,$16,$17,$18,$19,321,clock_timestamp())`,
  [id, creator.id, acceptor.id, randomUUID(), spec.claim, spec.criteria, source.url,
    terms.stakeYocto, acceptBy, deadline, termsHash, salt, source.saveId, chain,
    status, spec.settledOutcome || null, madeAt, acceptedAt, settledAt]);
  for (const [user, wallet, method, binding] of [
    [creator, 'priya.testnet', 'create_bet', creatorBinding],
    [acceptor, 'daniel.testnet', 'accept_bet', acceptorBinding],
  ]) {
    await stack.db.query(`insert into bilateral_near_requests
      (id,bet_id,user_id,wallet_account,method,args,binding_hash)
      values ($1,$2,$3,$4,$5,'{}',$6)`, [randomUUID(), id, user.id, wallet, method, binding]);
  }
  await stack.db.query('insert into bilateral_bet_public_consents (bet_id,user_id) values ($1,$2)', [id, acceptor.id]);
  if (spec.source === 'evidence') {
    await stack.db.query(`insert into enclave_plans (statement_id,source,closes_at,record)
      values ($1,'evidence',$2,$3)`, [source.statementId, iso(Date.parse(deadline) + DAY), record?.plan || {}]);
  }
  for (const [index, item] of (spec.evidence || []).entries()) {
    const user = item.side === 'yes' ? creator : acceptor;
    const at = iso(record || spec.evidenceOpen === false ? Date.parse(deadline) + HOUR + index * MINUTE : now - (20 - index * 5) * MINUTE);
    await stack.db.query(`insert into bet_evidence
      (statement_id,bet_id,user_id,side,url,title,body,body_hash,via,at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,'page',$9)`,
    [source.statementId, id, user.id, item.side, item.url, item.title, item.body, hash(item.body), at]);
  }
  if (record) {
    if (record.evidence.kind === 'submitted') bindFixtureEvidence(record, await evidenceFor(stack.db, source.statementId));
    else {
      // The Bitcoin opening price must differ from the claim's threshold.
      const evidence = JSON.parse(record.evidence.text);
      const bodies = evidence.segments.map(segment => JSON.stringify(segment.candles.map(row =>
        [Date.parse(row[0]) / 1000, row[1], row[2], 101240.55, 101240.55, row[5]])));
      record.evidence.text = candleEvidence(record.plan.parsed, bodies).text;
      record.evidence.textHash = hash(record.evidence.text);
      signFixtureEvidence(record);
    }
    verifyEnclaveRecord(record);
    await stack.db.query(`insert into bilateral_bet_events (bet_id,actor_user_id,kind,detail)
      values ($1,$2,'enclave_ruling',$3)`, [id, creator.id, record]);
    const outcome = spec.settledOutcome || spec.rulingOutcome;
    await stack.db.query(`update statements set status=$2,resolved_at=$3,resolution_note=$4 where id=$1`,
      [source.statementId, outcome === 'void' || outcome === 'unclear' ? 'ambiguous' : outcome, recordedAt, spec.reason]);
  }
  const published = await publishBet(stack.db, creator, id);
  assert.equal(published.status, status, `${spec.name}: escrow snapshot was not recognized`);
  assert.equal(published.creator_username, creator.x_username);
  assert.equal(published.acceptor_username, acceptor.x_username);
  if (record) {
    assert.ok(published.enclave, `${spec.name}: signed ruling did not survive the public read`);
    assert.equal(published.enclave.outcome, spec.rulingOutcome);
    assert.equal(published.enclave.mode, spec.mode || 'ruling');
    assert.equal(published.enclave.source, spec.source === 'evidence' ? 'submitted' : 'coinbase-candles');
    assert.equal(published.evidence?.privateItemCount || 0, 0);
    if (settled) assert.equal(published.outcome, spec.settledOutcome);
    if (spec.mode === 'review') assert.equal(published.enclave.agrees, spec.rulingOutcome === spec.settledOutcome);
  } else {
    assert.equal(published.enclave, null);
    assert.equal(published.evidence?.open, spec.evidenceOpen !== false);
  }
  if (spec.evidence?.length) assert.equal(published.evidence.items.length, spec.evidence.length);
  return { name: spec.name, path: `/bets/${id}` };
}

function oneTimeSignIn(stack, browser, target) {
  const sid = browser.jar.get('stated_sid');
  assert.ok(sid, 'The bettor sign-in did not produce a session cookie');
  const token = randomBytes(32).toString('hex');
  let unused = true;
  // Wrap this stack's own listener; no application file or second stack changes.
  const handlers = stack.server.listeners('request');
  assert.equal(handlers.length, 1);
  const [app] = handlers;
  stack.server.removeListener('request', app);
  stack.server.on('request', (req, res) => {
    let url;
    try { url = new URL(req.url, stack.base); }
    catch {
      res.writeHead(400, { 'cache-control': 'no-store' });
      res.end('Invalid request URL.');
      return;
    }
    if (url.pathname !== '/__gallery/signin') return app(req, res);
    if (req.method !== 'GET' || !unused || url.searchParams.get('token') !== token) {
      res.writeHead(404, { 'cache-control': 'no-store' });
      res.end('Sign-in link unavailable. Restart the gallery for a new link.');
      return;
    }
    unused = false;
    res.writeHead(303, {
      location: target, 'set-cookie': `stated_sid=${sid}; Path=/; HttpOnly; SameSite=Lax`,
      'cache-control': 'no-store', 'referrer-policy': 'no-referrer',
    });
    res.end();
  });
  return `${stack.base}/__gallery/signin?token=${token}`;
}

// Keep the real rejected POST's HTML available for visual inspection. Only the
// same synthetic bettor session may read this private gallery snapshot.
function rejectedEvidencePage(stack, browser, path, response) {
  const sid = browser.jar.get('stated_sid');
  assert.ok(sid);
  const handlers = stack.server.listeners('request');
  assert.equal(handlers.length, 1);
  const [app] = handlers;
  stack.server.removeListener('request', app);
  stack.server.on('request', (req, res) => {
    const url = new URL(req.url, stack.base);
    const signedIn = String(req.headers.cookie || '').split(';').some(cookie => cookie.trim() === `stated_sid=${sid}`);
    if (req.method !== 'GET' || url.pathname !== path || url.searchParams.get('gallery') !== 'rejected' || !signedIn) return app(req, res);
    res.writeHead(response.status, {
      'content-type': 'text/html; charset=utf-8', 'cache-control': 'private, no-store',
      'content-security-policy': response.headers.get('content-security-policy'),
      'x-content-type-options': 'nosniff',
    });
    res.end(response.text);
  });
  return `${path}?gallery=rejected`;
}

async function gallery(stack) {
  const now = Date.now();
  await stack.connectBot(stack.fakeX.addUser('500', 'statedbot'));
  const priya = await person(stack, '1901', 'priya_m');
  const daniel = await person(stack, '1902', 'danielokafor');
  const terminalEvidence = [
    { side: 'yes', url: 'https://civic.example.org/ferry-terminal/opening-notice', title: 'Ferry terminal opening notice',
      body: 'The city announced that the waterfront terminal would welcome passengers on the published opening date. Both entrances were scheduled to open with the first sailing.' },
    { side: 'no', url: 'https://transit.example.org/ferry-terminal/service-update', title: 'Passenger service update: boarding gates remain closed',
      body: 'The operator says the opening event was a preview for invited guests. Passenger sailings continue from the temporary terminal while boarding-gate inspections finish.' },
  ];
  const delayedEvidence = [
    { side: 'no', url: 'https://civic.example.org/ferry-terminal/construction-update', title: 'Waterfront terminal opening postponed',
      body: 'The city postponed passenger service at the waterfront terminal. Safety inspections were incomplete at the deadline, and no passengers boarded there.' },
    { side: 'yes', url: 'https://waterfront.example.org/terminal/preview', title: 'Inside the new terminal: public preview day',
      body: 'Visitors toured the building during a public preview. The tour did not include ferry departures or access to the boarding gates.' },
    { side: 'no', url: 'https://transit.example.org/ferries/service-notice', title: 'Ferries continue to use the temporary terminal',
      body: 'The ferry operator confirms that every scheduled passenger sailing used the temporary terminal through the deadline. The new terminal was not in passenger service.' },
  ];
  const specs = [
    { name: '01 Links open, two links', claim: LONG_CLAIM, stake: '0.5', hoursAgo: 3,
      criteria: 'The city and ferry operator confirm scheduled passenger service from the completed terminal before the deadline.',
      source: 'evidence', evidence: terminalEvidence },
    { name: '03 Ruled Yes, Coinbase price, awaiting payout', stake: '0.1', hoursAgo: 1,
      claim: 'Bitcoin will trade above $100,000 before the deadline.',
      criteria: 'A completed BTC-USD candle on Coinbase closes above $100,000 in the price window before the deadline.',
      source: 'coinbase-candles', rulingOutcome: 'yes', reason: 'Coinbase recorded a BTC-USD close of $101,240.55 in the completed price window before the deadline.' },
    { name: '04 Ruled No, posted links, awaiting payout', stake: '0.5', hoursAgo: 26,
      claim: 'The waterfront ferry terminal will begin scheduled passenger service before the deadline.',
      criteria: 'Scheduled passenger sailings must depart from the new terminal, rather than a preview or opening ceremony.',
      source: 'evidence', rulingOutcome: 'no', evidence: delayedEvidence.slice(0, 2),
      reason: 'The city postponed passenger service. The preview event did not include scheduled ferry departures before the deadline.' },
    { name: '05 Settled Yes, Coinbase price', stake: '0.1', hoursAgo: 72,
      claim: 'Bitcoin will hold above $100,000 in the price window before the deadline.',
      criteria: 'Completed Coinbase BTC-USD candles in the price window close above $100,000.',
      source: 'coinbase-candles', rulingOutcome: 'yes', settledOutcome: 'yes',
      reason: 'Every completed Coinbase BTC-USD candle in the recorded window closed at $101,240.55, above the stated threshold.' },
    { name: '06 Settled No, posted links, three links', stake: '0.5', hoursAgo: 96,
      claim: 'The new waterfront ferry terminal will be carrying paying passengers before the deadline.',
      criteria: 'The ferry operator confirms that scheduled passenger sailings used the new terminal before the deadline.',
      source: 'evidence', rulingOutcome: 'no', settledOutcome: 'no', evidence: delayedEvidence,
      reason: 'The operator kept passenger sailings at the temporary terminal. A public building tour did not meet the claim.' },
    { name: '07 Settled No, reviewer corrected a Yes ruling', stake: '0.1', hoursAgo: 120,
      claim: 'Aster will open its developer API to everyone before the deadline.',
      criteria: 'Any developer can create an account and use the production API without an invitation or approval.',
      source: 'evidence', rulingOutcome: 'yes', settledOutcome: 'no',
      reason: 'The release announcement described the developer API as publicly available before the deadline.',
      evidence: [{ side: 'no', url: 'https://developer.example.org/aster/access', title: 'Aster API access remains invitation-only',
        body: 'The production API still requires an approved invitation. The announcement opened applications for access, rather than access itself.' }] },
    { name: '08 Jury could not decide, stakes returned', stake: '0.5', hoursAgo: 144,
      claim: 'The new waterfront ferry terminal will feel less crowded on its opening day.',
      criteria: 'Compare the passenger experience at the new terminal with the temporary terminal on opening day.',
      source: 'evidence', rulingOutcome: 'unclear', settledOutcome: 'void', evidence: terminalEvidence,
      reason: 'The claim gives no agreed measure of crowding. The reports describe conflicting experiences, so neither outcome can be established.' },
    { name: '09 Older settled Yes, signed review agrees', stake: '0.1', hoursAgo: 45 * 24,
      claim: 'Toronto council will approve the waterfront ferry terminal budget before the deadline.',
      criteria: 'The published council minutes record approval of the terminal budget before the deadline.',
      source: 'evidence', mode: 'review', rulingOutcome: 'yes', settledOutcome: 'yes',
      reason: 'The published council minutes record the vote approving the waterfront ferry terminal budget before the deadline.',
      evidence: [{ side: 'yes', url: 'https://council.example.org/minutes/ferry-terminal-budget', title: 'Council minutes: ferry terminal budget approved',
        body: 'The council minutes record the motion approving the waterfront ferry terminal budget. The vote took place before the deadline.' }] },
  ];
  specs.push(
    { name: '16 Links closed, jury still deciding', claim: LONG_CLAIM, stake: '0.5', hoursAgo: 26,
      criteria: 'The ferry operator confirms scheduled passenger sailings before the deadline.',
      source: 'evidence', evidence: terminalEvidence, evidenceOpen: false },
    { name: '17 Split jury, awaiting refund', claim: 'The ferry terminal will be fully operational before the deadline.',
      stake: '0.5', hoursAgo: 26, criteria: 'All entrances and boarding gates operate for scheduled passenger service.',
      source: 'evidence', rulingOutcome: 'unclear', outcomes: ['yes', 'yes', 'no'], evidence: terminalEvidence,
      reason: 'The reports disagree about whether the boarding gates were operating.' },
    { name: '18 Undecided jury, refunded', claim: 'The terminal will feel less crowded than the temporary terminal.',
      stake: '0.5', hoursAgo: 96, criteria: 'Compare passenger experience on opening day.',
      source: 'evidence', rulingOutcome: 'unclear', refunded: true, evidence: terminalEvidence,
      reason: 'The claim does not specify a measure of crowding.' },
  );
  const seeded = [];
  for (const spec of specs) seeded.push(await seedBet(stack, priya.user, daniel.user, now, spec));
  const paidBet = seeded.find(page => page.name.startsWith('05 '));
  const paidId = paidBet.path.split('/').pop();
  await stack.db.query(`insert into play_accounts (x_user_id,account_id,public_key,ready)
    values ($1,'priya.testnet','ed25519:synthetic',true)`, [priya.user.x_user_id]);
  await stack.db.query(`insert into bilateral_near_requests
    (id,bet_id,user_id,wallet_account,method,args,execution_status,transaction_hash)
    values ($1,$2,$3,'priya.testnet','withdraw','{}','succeeded',$4)`,
  [randomUUID(), paidId, priya.user.id, '1'.repeat(44)]);

  // These public, dated posts fill the first step of /bets/new and the home feed.
  for (const [index, [owner, text]] of [
    [priya.user, 'Bitcoin will close above $110,000'],
    [daniel.user, 'Aster will release an offline desktop app'],
    [priya.user, 'Toronto council will approve the waterfront cycle lane extension'],
  ].entries()) {
    const deadline = iso(now + (14 + index * 7) * DAY);
    await postAndSave(stack, owner, { claim: `${text} by ${dateLabel(deadline)}.`,
      deadline, madeAt: iso(now - (index + 1) * HOUR), publicPost: true });
  }

  const evidencePath = `${seeded[0].path}/evidence`;
  assert.equal((await stack.browser().get(evidencePath)).status, 404, 'Evidence must remain private');
  assert.equal((await priya.browser.get(evidencePath)).status, 200, 'The bettor must see the evidence form');
  const pages = seeded.map(({ name, path }) => ({ name, url: `${stack.base}${path}`, signedInAs: null }));
  pages.splice(1, 0, { name: '02 Private links form, signed in as @priya_m',
    url: `${stack.base}${evidencePath}`, signedInAs: '@priya_m' });
  pages.push(
    { name: '10 New Bet, unknown pasted post, Decide by',
      url: `${stack.base}/bets/new?${new URLSearchParams({ link: 'https://x.com/danielokafor/status/1234567890123456789' })}`, signedInAs: null },
    { name: '11 New Bet, choose a post', url: `${stack.base}/bets/new`, signedInAs: null },
    { name: '12 Home', url: `${stack.base}/`, signedInAs: null },
  );
  const empty = await seedBet(stack, priya.user, daniel.user, now, {
    name: '13 Private links form, no links yet', claim: LONG_CLAIM, stake: '0.5', hoursAgo: 3,
    criteria: 'The ferry operator confirms scheduled passenger sailings before the deadline.', source: 'evidence',
  });
  const emptyPath = `${empty.path}/evidence`;
  const emptyPage = await priya.browser.get(emptyPath);
  assert.equal(emptyPage.status, 200);
  assert.match(emptyPage.text, /Links from both sides appear here\./);
  const rejected = await priya.browser.submit(emptyPath, { side: 'yes', url: 'https://x.com/priya_m/status/123' }, { from: emptyPath });
  assert.equal(rejected.status, 400);
  assert.match(rejected.text, /role="alert"/);
  const errorPath = rejectedEvidencePage(stack, priya.browser, emptyPath, rejected);
  const longCreator = await person(stack, '1903', 'alexandermorgan');
  const longAcceptor = await person(stack, '1904', 'christinawright');
  const longBet = await seedBet(stack, longCreator.user, longAcceptor.user, now, {
    name: '15 Bet, full handles and full post', claim: FULL_CLAIM, stake: '0.5', hoursAgo: 3,
    criteria: 'The ferry operator confirms scheduled passenger sailings before the deadline.', source: 'evidence',
  });
  pages.push(
    { name: empty.name, url: `${stack.base}${emptyPath}`, signedInAs: '@priya_m' },
    { name: '14 Private links form, rejected link', url: `${stack.base}${errorPath}`, signedInAs: '@priya_m', status: 400 },
    { name: longBet.name, url: `${stack.base}${longBet.path}`, signedInAs: null },
    { name: '19 Paid winner, signed in as @priya_m', url: `${stack.base}${paidBet.path}`, signedInAs: '@priya_m' },
    { name: '20 New Bet, invalid deadline', url: `${stack.base}/bets/new?${new URLSearchParams({
      link: 'https://x.com/danielokafor/status/1234567890123456789', side: 'no', stake: '0.25',
      datePreset: 'custom', date: '2026-02-31', go: '1',
    })}`, signedInAs: null, status: 400 },
  );
  // Exercise the real handlers before advertising the gallery. This is run only
  // by the designer starting the script, never by node --check.
  for (const page of pages) {
    const browser = page.signedInAs ? priya.browser : stack.browser();
    const response = await browser.get(page.url);
    assert.equal(response.status, page.status || 200, `${page.name} did not load`);
    if (page.name.startsWith('10 ')) assert.match(response.text, /name="date"/);
    if (page.name.startsWith('19 ')) assert.match(response.text, /Paid to your account\./);
    if (page.name.startsWith('20 ')) assert.match(response.text, /role="alert"/);
  }
  // Open this once to set the real test-stack session and land on page 2.
  // It is separate from page 2's URL so every listed url names its actual page.
  pages[1].signInUrl = oneTimeSignIn(stack, priya.browser, evidencePath);
  return { base: stack.base, pages };
}

async function main() {
  let stack;
  let stopping = false;
  let stop;
  const stopped = new Promise(resolve => { stop = resolve; });
  const onSignal = () => { stopping = true; stop(); };
  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);
  try {
    stack = await startStack({ ...enclaveEnv, NEARAI_RULING_MODELS: 'Qwen/Qwen3.8-27B,deepseek-ai/DeepSeek-V4.1-Flash-1017,z-ai/glm-5.3-flash',
      STATED_PLAY: '1', STATED_NEAR_CONTRACT: 'escrow.testnet',
      STATED_PLAY_SETTLE_DELAY_SECONDS: '600' }, {
      fetchImpl: async (url, options) => {
        if (stack && new URL(url).origin === new URL(stack.fakeX.base).origin) return fetch(url, options);
        throw new Error('The gallery refuses external API requests');
      },
    });
    if (stopping) return;
    const result = await gallery(stack);
    if (stopping) return;
    console.log(`GALLERY ${JSON.stringify(result)}`);
    await stopped;
  } finally {
    try { await stack?.close(); }
    finally {
      process.removeListener('SIGINT', onSignal);
      process.removeListener('SIGTERM', onSignal);
    }
  }
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});
