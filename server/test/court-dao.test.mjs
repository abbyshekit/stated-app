// Stated Court: new reply Bets name a Sputnik DAO as referee. The jury's ruling (or a
// reviewer's Result) is filed as a DAO proposal; after the correction window the jury
// member approves it and the DAO itself calls referee_resolve on the escrow. Real
// Postgres, the reply-bet flow, and a fake chain that emulates Sputnik v2 voting.
import test, { after, before } from 'node:test';
import assert from 'node:assert/strict';
import { startStack } from './support/app.mjs';
import { FakeNear } from './support/fake-near.mjs';
import { enclaveRulingFixture } from './support/enclave.mjs';
import { tick } from '../src/worker.mjs';
import { runBetCommands, settleReplyBets } from '../src/reply-bets.mjs';
import { playAccountFor, referee, refillTreasury } from '../src/play.mjs';
import { resolveStatement } from '../src/notify.mjs';
import { ensureJury } from '../src/enclave-ruling.mjs';
import { clearCourtCache } from '../src/court-dao.mjs';

const NEXT = new Date().getUTCFullYear() + 1;
const DAO = 'stated-court.sputnik-v2.testnet';
const COUNCIL = 'council-one.testnet';
const HOUR = 3600_000;
let s; let near; let X; let admin; let judge;
const one = (sql, params) => s.db.one(sql, params);
const run = () => runBetCommands(s.db, s.config, near.chain, { fetchImpl: near.fetchImpl, botUsername: 'statedbot' });
const botPosts = () => [...s.fakeX.posts.values()].filter((p) => p.author_id === '500');
const ns = (date) => (BigInt(date.getTime()) * 1000000n).toString();
const proposals = () => near.daos.get(DAO).proposals;
const events = async (betId, kind) => (await s.db.many('select detail from bilateral_bet_events where bet_id = $1 and kind = $2 order by id',
  [betId, kind])).map((row) => row.detail);
// settleReplyBets looks at a Bet at most once a minute; a test moves on at once.
async function settle() {
  await s.db.query('update bilateral_bets set settle_checked_at = null');
  return settleReplyBets(s.db, s.config, near.chain, { fetchImpl: near.fetchImpl });
}
const balance = async (user) => BigInt(await near.chain.balance((await playAccountFor(s.db, user.id)).account_id));

let people = 0;
async function acceptedBet(text) {
  const maker = s.fakeX.addUser(String(7200 + people), `maker${people}`);
  const taker = s.fakeX.addUser(String(7300 + people), `taker${people}`);
  people += 1;
  await s.db.query(`delete from kv where key = 'play_treasury_refill_at'`);
  await refillTreasury(s.db, s.config, near.chain);
  const post = s.fakeX.post(X.priya.id, text);
  const cmd = s.fakeX.post(maker.id, '@statedbot bet 0.1 no', { replyTo: post.id });
  await tick(s.db, s.config, s.x);
  assert.equal((await run()).done, 1);
  await tick(s.db, s.config, s.x);
  const offer = botPosts().find((p) => (p.referenced_tweets || []).some((r) => r.id === cmd.id));
  s.fakeX.post(taker.id, '@statedbot take', { replyTo: offer.id });
  await tick(s.db, s.config, s.x);
  assert.equal((await run()).done, 1);
  const { bet_id: betId } = await one('select bet_id from bet_commands where event_id = $1', [cmd.id]);
  const { id: statementId } = await one(`select st.id from statements st join sources src on src.id = st.source_id
    where src.platform_id = $1`, [post.id]);
  return { post, betId, statementId, maker, taker };
}

// Moves a Bet's own deadline (database and chain alike) into the past, so a jury Result may settle it.
async function due(bet) {
  const at = new Date(Math.floor(Date.now() / HOUR) * HOUR - 2 * HOUR);
  const acceptBy = new Date(at.getTime() - HOUR);
  await s.db.query(`update bilateral_bets set accept_by = $2, resolve_at = $3,
    chain_state = chain_state || jsonb_build_object('accept_by_ns', $4::text, 'resolve_at_ns', $5::text) where id = $1`,
  [bet.betId, acceptBy, at, ns(acceptBy), ns(at)]);
  Object.assign(near.bets.get(bet.betId), { accept_by_ns: ns(acceptBy), resolve_at_ns: ns(at) });
  return bet;
}

// The enclave jury's Result: a verified ruling record on the Bet, and the post's Result recorded by the jury user.
async function juryResult(bet, outcome) {
  const row = await one('select claim, resolve_at, evidence_source_url, terms_hash from bilateral_bets where id = $1', [bet.betId]);
  const jury = await ensureJury(s.db);
  const record = enclaveRulingFixture({ outcome, material: { claim: row.claim, madeAt: new Date(new Date(row.resolve_at).getTime() - 24 * HOUR),
    deadline: row.resolve_at, postUrl: row.evidence_source_url, bets: [{ id: bet.betId, termsHash: row.terms_hash }] } });
  await s.db.query(`insert into bilateral_bet_events (bet_id, actor_user_id, kind, detail) values ($1, $2, 'enclave_ruling', $3)`, [bet.betId, jury, record]);
  await resolveStatement(s.db, { statementId: bet.statementId, outcome, note: `NEAR AI enclave ruling: ${outcome}.`,
    url: 'https://api.exchange.coinbase.com/products/BTC-USD/candles', reviewer: { id: jury }, outcomeAt: new Date(row.resolve_at).toISOString() });
}
const human = async (bet, outcome) => {
  const { resolve_at: deadline } = await one('select resolve_at from bilateral_bets where id = $1', [bet.betId]);
  return resolveStatement(s.db, { statementId: bet.statementId, outcome, note: 'Recorded by a reviewer.',
    url: 'https://example.org/reviewed', reviewer: admin, outcomeAt: new Date(Math.min(Date.now(), new Date(deadline).getTime())).toISOString() });
};
// Advance both correction clocks: the Result and any on-chain Court filing.
const windowPassed = async (bet) => {
  await s.db.query(`update statements set resolved_at = now() - interval '11 minutes' where id = $1`, [bet.statementId]);
  for (const proposal of proposals().filter((p) => p.description.includes(bet.betId))) {
    proposal.submission_time = ns(new Date(Date.now() - 11 * 60_000));
  }
};

before(async () => {
  near = new FakeNear();
  s = await startStack({ STATED_NEAR_CONTRACT: 'escrow.testnet', STATED_PLAY: '1', STATED_PLAY_AUTOPROVISION: '1',
    STATED_PLAY_SETTLE_DELAY_SECONDS: '600', STATED_PLAY_NEW_ACCOUNTS_PER_HOUR: '100', STATED_COURT_DAO: DAO },
  { fetchImpl: near.fetchImpl, chain: near.chain });
  await s.connectBot(s.fakeX.addUser('500', 'statedbot'));
  X = { priya: s.fakeX.addUser('7101', 'priya') };
  const browser = await s.signIn(s.fakeX.addUser('900', 'reviewer'));
  await browser.submit('/setup', { profile: 'private', defaults: 'private' });
  admin = await one(`select * from users where x_user_id = '900'`);
  judge = await referee(s.db, s.config, near.chain);
  // Legacy direct-jury mode with the restricted council policy.
  near.addDao(DAO, {
    roles: [
      { name: 'jury', kind: { Group: [judge.id] }, permissions: ['call:AddProposal', 'call:VoteApprove'], vote_policy: {} },
      { name: 'council', kind: { Group: [COUNCIL] }, permissions: ['call:VoteReject', 'call:VoteRemove'], vote_policy: {} },
    ],
    default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 2] },
    proposal_bond: '0', proposal_period: '604800000000000', bounty_bond: '0', bounty_forgiveness_period: '86400000000000',
  });
  near.accounts.set(COUNCIL, { balance: 5n * 10n ** 24n, keys: new Set() });
});
after(async () => { await s?.close(); });

let first;

test('a new reply Bet names Stated Court as its referee, in the database and on the chain', async () => {
  first = await acceptedBet(`BTC trades above $100,000 before March 1, ${NEXT}.`);
  assert.equal((await one('select referee_wallet from bilateral_bets where id = $1', [first.betId])).referee_wallet, DAO);
  assert.equal(near.bets.get(first.betId).referee, DAO);
});

test('a jury Result files one proposal at once; after the window the jury approves and the DAO settles and pays', async () => {
  await due(first);
  await juryResult(first, 'yes');
  assert.deepEqual(await settle(), { settled: 0, reclaimed: 0, errors: 0 });
  assert.equal(proposals().length, 1, 'filed at once, inside the correction window');
  const [proposal] = proposals();
  assert.equal(proposal.proposer, judge.id);
  assert.equal(proposal.status, 'InProgress');
  assert.match(proposal.description, new RegExp(`^Stated enclave jury: yes on bet ${first.betId}\\. Ruling: https?://`));
  const action = proposal.kind.FunctionCall.actions[0];
  assert.deepEqual([proposal.kind.FunctionCall.receiver_id, action.method_name, action.deposit],
    ['escrow.testnet', 'referee_resolve', '0']);
  assert.deepEqual(JSON.parse(Buffer.from(action.args, 'base64').toString()), { id: first.betId, outcome: 'yes' });
  const [filed] = await events(first.betId, 'court_proposal');
  assert.deepEqual([filed.dao, filed.proposalId, filed.outcome], [DAO, 0, 'yes']);
  assert.match(filed.txHash, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

  assert.deepEqual(await settle(), { settled: 0, reclaimed: 0, errors: 0 });
  assert.equal(proposals().length, 1, 'a second pass files nothing');
  assert.equal((await events(first.betId, 'court_proposal')).length, 1);
  assert.equal(near.bets.get(first.betId).status, 'accepted', 'nothing pays inside the window');

  const winner = first.taker;
  const before = await balance(winner);
  await windowPassed(first);
  assert.deepEqual(await settle(), { settled: 1, reclaimed: 0, errors: 0 });
  assert.equal(proposals()[0].status, 'Approved');
  assert.deepEqual(proposals()[0].votes, { [judge.id]: 'Approve' });
  const resolve = near.sent.find((t) => t.method === 'referee_resolve' && t.args.id === first.betId);
  assert.equal(resolve.signerId, DAO, 'the DAO, not this server, called the escrow');
  assert.deepEqual({ status: near.bets.get(first.betId).status, method: near.bets.get(first.betId).resolution.method }, { status: 'settled', method: 'referee' });
  assert.deepEqual(await one('select status, outcome from bilateral_bets where id = $1', [first.betId]), { status: 'settled', outcome: 'yes' });
  assert.equal(await balance(winner), before + 2n * 10n ** 23n, 'both stakes reached the winner');
  assert.equal((await events(first.betId, 'play_paid_out')).length, 1);
  const [proof] = await events(first.betId, 'referee_resolved');
  assert.equal(proof.referee, DAO);
  assert.match(proof.transactionHash, /^[1-9A-HJ-NP-Za-km-z]{32,44}$/);

  clearCourtCache();
  const page = await s.browser().get(`/bets/${first.betId}`);
  assert.equal(page.status, 200);
  assert.match(page.text, /<dt>Settlement<\/dt><dd>The recorded Result becomes a proposal in Stated Court, the Sputnik DAO <span class="mono">stated-court\.sputnik-v2\.testnet<\/span> that referees this bet\./);
  assert.match(page.text, /<p class="gut settlement-line">All 2 models said yes\. The winner was paid\.<\/p>/);
  assert.match(page.text, /<p class="gut link-row"><a class="tl" href="\/bets\/[0-9a-f-]+\/ruling">See the ruling<\/a>/);
  assert.doesNotMatch(page.text, /Proposal 0 is approved|is the referee/, 'the page states the record, not the old Court line');
  // With the window on record (filed ten minutes before settling), the sentence names Court.
  await s.db.query(`update bilateral_bet_events set detail = jsonb_set(detail, '{filedAt}', to_jsonb(
      (select to_char((settled_at - interval '11 minutes') at time zone 'utc', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') from bilateral_bets where id = $1)))
    where bet_id = $1 and kind = 'court_proposal'`, [first.betId]);
  const stood = await s.browser().get(`/bets/${first.betId}`);
  assert.match(stood.text, />All 2 models said yes\. Stated Court let it stand for ten minutes, then it paid\.</);
});

test('a council Reject before the window leaves the Bet open, records it, and is no error', async () => {
  const bet = await due(await acceptedBet(`ETH trades above $10,000 before March 1, ${NEXT}.`));
  await juryResult(bet, 'no');
  await settle();
  const filed = (await events(bet.betId, 'court_proposal'))[0];
  const vote = await near.chain.call({ signerId: COUNCIL, contractId: DAO, method: 'act_proposal', args: { id: filed.proposalId, action: 'VoteReject' } });
  assert.equal(vote.ok, true);
  assert.equal(proposals()[filed.proposalId].status, 'Rejected');
  await windowPassed(bet);
  assert.deepEqual(await settle(), { settled: 0, reclaimed: 0, errors: 0 });
  assert.deepEqual(await settle(), { settled: 0, reclaimed: 0, errors: 0 });
  assert.equal(near.bets.get(bet.betId).status, 'accepted');
  assert.deepEqual((await events(bet.betId, 'court_rejected')).map((e) => [e.proposalId, e.status, e.outcome]), [[filed.proposalId, 'Rejected', 'no']],
    'recorded once');
  assert.equal(near.sent.filter((t) => t.signerId === judge.id && t.method === 'act_proposal' && t.args.id === filed.proposalId).length, 0,
    'the jury member never votes on a proposal the council rejected');
  await resolveStatement(s.db, { statementId: bet.statementId, outcome: 'no', note: 'New evidence confirms the same outcome after the council veto.',
    url: 'https://example.org/new-evidence', reviewer: admin, outcomeAt: new Date().toISOString() });
  await settle();
  const revised = await events(bet.betId, 'court_proposal');
  assert.equal(revised.length, 2, 'a new Result revision may re-file the same outcome');
  assert.notEqual(revised[0].resultRevision, revised[1].resultRevision);
  assert.notEqual(revised[0].proposalId, revised[1].proposalId);
  await settle();
  assert.equal((await events(bet.betId, 'court_proposal')).length, 2, 'the same revised Result never files twice');
});

test('an early reviewer Yes waits for the deadline before Court files and approves', async () => {
  const bet = await acceptedBet(`SOL trades above $500 before March 1, ${NEXT}.`);
  await human(bet, 'yes');
  const count = proposals().length;
  const votesBefore = near.sent.filter((t) => t.method === 'act_proposal' && t.signerId === judge.id).length;
  await windowPassed(bet);
  assert.deepEqual(await settle(), { settled: 0, reclaimed: 0, errors: 0 });
  assert.equal(proposals().length, count);
  assert.equal((await events(bet.betId, 'court_proposal')).length, 0);
  assert.equal(near.sent.filter((t) => t.method === 'act_proposal' && t.signerId === judge.id).length, votesBefore);
  await due(bet);
  await s.db.query(`update statements set outcome_at = (select resolve_at from bilateral_bets where id = $2) where id = $1`,
    [bet.statementId, bet.betId]);
  assert.deepEqual(await settle(), { settled: 0, reclaimed: 0, errors: 0 });
  const filed = await events(bet.betId, 'court_proposal');
  assert.equal(filed.length, 1);
  assert.match(proposals()[filed[0].proposalId].description, new RegExp(`^Stated reviewer: yes on bet ${bet.betId}\\.`));
  assert.equal(near.sent.filter((t) => t.method === 'act_proposal' && t.args.id === filed[0].proposalId).length, 0,
    'the old Result does not shorten the new proposal window');
  assert.equal((await settle()).settled, 0);
  await windowPassed(bet);
  assert.equal((await settle()).settled, 1);
  assert.equal(near.sent.find((t) => t.method === 'referee_resolve' && t.args.id === bet.betId).signerId, DAO);
});

test('an existing Court filing is not approved before the Bet deadline', async () => {
  const bet = await due(await acceptedBet(`AVAX trades above $500 before March 1, ${NEXT}.`));
  await human(bet, 'yes');
  await settle();
  const [filed] = await events(bet.betId, 'court_proposal');
  const future = new Date(Date.now() + HOUR);
  await s.db.query('update bilateral_bets set resolve_at = $2 where id = $1', [bet.betId, future]);
  await windowPassed(bet);
  assert.deepEqual(await settle(), { settled: 0, reclaimed: 0, errors: 0 });
  assert.equal(proposals()[filed.proposalId].status, 'InProgress');
  assert.equal(near.sent.filter((t) => t.method === 'act_proposal' && t.args.id === filed.proposalId).length, 0);
  await due(bet);
  assert.equal((await settle()).settled, 1);
});

test('an old Bet with the referee account as referee still settles directly', async () => {
  s.config.court.dao = '';
  let bet;
  try { bet = await acceptedBet(`DOGE trades above $1 before March 1, ${NEXT}.`); } finally { s.config.court.dao = DAO; }
  assert.equal(near.bets.get(bet.betId).referee, judge.id);
  const filedBefore = proposals().length;
  await human(bet, 'yes');
  await windowPassed(bet);
  assert.equal((await settle()).settled, 1);
  assert.equal(near.sent.find((t) => t.method === 'referee_resolve' && t.args.id === bet.betId).signerId, judge.id);
  assert.equal(proposals().length, filedBefore, 'no proposal for a Bet the DAO does not referee');
});

test('a failed filing retries, and a filing whose answer was lost is found on chain, never filed twice', async () => {
  // A reviewer's No waits for the Bet's own deadline, so the deadline is moved into the past first.
  const bet = await due(await acceptedBet(`XRP trades above $5 before March 1, ${NEXT}.`));
  await human(bet, 'no');
  const count = proposals().length;
  near.daoFaults.push('reject');
  assert.equal((await settle()).errors, 1);
  assert.equal(proposals().length, count, 'nothing landed');
  assert.equal((await events(bet.betId, 'court_proposal')).length, 0);
  assert.equal((await settle()).errors, 0);
  assert.equal(proposals().length, count + 1);

  const lost = await due(await acceptedBet(`ADA trades above $3 before March 1, ${NEXT}.`));
  await human(lost, 'no');
  near.daoFaults.push('lost');
  assert.equal((await settle()).errors, 1, 'the proposal landed but the answer never came');
  assert.equal(proposals().length, count + 2);
  assert.equal((await events(lost.betId, 'court_proposal')).length, 0);
  assert.equal((await settle()).errors, 0);
  assert.equal(proposals().length, count + 2, 'found on chain, not filed again');
  const [found] = await events(lost.betId, 'court_proposal');
  assert.deepEqual([found.proposalId, found.txHash], [count + 1, null]);
});

test('the jury member never votes twice on a proposal', async () => {
  const bet = await due(await acceptedBet(`LINK trades above $40 before March 1, ${NEXT}.`));
  await human(bet, 'yes');
  await settle();
  const [filed] = await events(bet.betId, 'court_proposal');
  // An earlier pass voted, and its answer is all this server has: the chain is read again, never voted on again.
  await s.db.query(`insert into bilateral_bet_events (bet_id, actor_user_id, kind, detail) values ($1, $2, 'court_approved', $3)`,
    [bet.betId, admin.id, { dao: DAO, proposalId: filed.proposalId, outcome: 'yes', txHash: null }]);
  await windowPassed(bet);
  const votes = () => near.sent.filter((t) => t.method === 'act_proposal' && t.args.id === filed.proposalId).length;
  assert.deepEqual(await settle(), { settled: 0, reclaimed: 0, errors: 0 });
  assert.equal(votes(), 0);
  // A vote already on chain (its answer lost) is not sent again either.
  await s.db.query(`delete from bilateral_bet_events where bet_id = $1 and kind = 'court_approved'`, [bet.betId]);
  proposals()[filed.proposalId].votes[judge.id] = 'Approve';
  assert.deepEqual(await settle(), { settled: 0, reclaimed: 0, errors: 0 });
  assert.equal(votes(), 0);
  assert.equal(proposals().filter((p) => p.description.includes(bet.betId)).length, 1, 'and nothing is filed again');
  assert.equal((await events(bet.betId, 'court_proposal')).length, 1);
});

test('/court lists the DAO’s members, its rule and its Stated proposals', async () => {
  clearCourtCache();
  const page = await s.browser().get('/court');
  assert.equal(page.status, 200);
  assert.equal((page.text.match(/<h1[\s>]/g) || []).length, 1, 'exactly one h1');
  assert.match(page.text, /<h1 class="court-title">Stated Court<\/h1>\s*<p class="gut">Every ruling waits ten minutes on NEAR\. The council can vote it down before anyone is paid\.<\/p>/);
  const [open, fold = ''] = page.text.split('<details class="fold"><summary>How the court is set up</summary>');
  const visibleOpen = open.replace(/href="[^"]*"/g, '');
  assert.ok(fold, 'the set-up details sit in a fold');
  for (const detail of [/stated-court\.sputnik-v2\.testnet/, /<b>jury<\/b><br>referee\.stated-play-[0-9a-f]+\.testnet/,
    /<b>council<\/b><br>council-one\.testnet/, /more than 1 in 2 of the members of a role/, /expires after 7 days/]) {
    assert.match(fold, detail);
    assert.doesNotMatch(visibleOpen, detail, 'members, thresholds and visible account ids stay inside the fold');
  }
  assert.match(page.text, new RegExp(`<a class="tl" href="/bets/${first.betId}">(?:<span class="hl">)?[^<]+(?:</span>)?</a></p>\\s*<p class="court-action"><b>Let it stand</b></p>\\s*<p class="meta">The models said yes\\. The winner was paid\\. 1 for, 0 against</p>`));
  assert.match(page.text, /<b>Voted it down<\/b><\/p>\s*<p class="meta">[^<]*The ruling did not pay\.[^<]*0 for, 1 against<\/p>/);
  assert.match(page.text, /See the vote on NEAR<\/a>/);
  assert.doesNotMatch(page.text, /Proposal \d+ is/);
  const off = { ...s.config, court: { dao: '' } };
  assert.equal(off.court.dao, '');
});
