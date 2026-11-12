// Stated Court: a Sputnik DAO holds the referee seat of new reply Bets. The
// enclave jury's ruling (or a reviewer's Result) is filed as a DAO proposal whose
// only action is the escrow's referee_resolve for that Bet and outcome. Council
// members can vote it down on chain during the correction window; otherwise the
// jury member approves it after the window and the DAO itself calls the escrow.
// This server never signs referee_resolve for such a Bet: it only proposes and votes.
//
// Sputnik v2 interface, as deployed by sputnik-v2.testnet (version 2.0.0):
//   add_proposal({ proposal: { description, kind } }) -> u64 id, with proposal_bond attached
//   act_proposal({ id, action, memo? })                  no deposit
//   get_proposal({ id }), get_last_proposal_id(), get_proposals({ from_index, limit }), get_policy()
// act_proposal also gets `proposal: <kind>`: later Sputnik versions require the
// kind there, and v2's JSON argument parser ignores a field it does not know.
import { COURT_CALL_GAS, NEAR_CALL_GAS } from './near-escrow.mjs';
import { referee } from './play.mjs';
import { UserError } from './store.mjs';
import { fingerprint } from './canonical.mjs';

const TIMEOUT_MS = 120_000;
// The gas the DAO gives referee_resolve when it executes the proposal.
const RESOLVE_GAS = NEAR_CALL_GAS;
// act_proposal carries the execution of referee_resolve inside it.
const APPROVE_GAS = 200_000_000_000_000n;
const RELAY_APPROVE_GAS = COURT_CALL_GAS;
const OUTCOMES = new Set(['yes', 'no', 'void']);
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/;
// How far back a lost filing is looked for before filing again.
const SCAN = 100;

export const courtDao = (config) => config.court?.dao || '';
export const isCourtBet = (config, bet) => Boolean(courtDao(config)) && bet?.referee_wallet === courtDao(config);

/** Read-only startup/offer gate. Supply court.operator from referee(db,...).id
 * when the treasury is auto-provisioned. A nonempty list must block new offers. */
export async function checkCourt(config, chain) {
  const problems = [];
  const dao = courtDao(config);
  if (!dao) return config.court?.relay ? ['Court relay has no DAO.'] : [];
  const relay = config.court?.relay;
  const operator = config.court?.operator || (config.play?.treasury ? `referee.${config.play.treasury}` : '');
  const net = config.near?.network || 'testnet';
  const account = /^(?=.{2,64}$)[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*$/;
  const onNetwork = (id) => typeof id === 'string' && account.test(id)
    && (net === 'testnet' ? id.endsWith('.testnet') : !id.endsWith('.testnet'));
  if (!onNetwork(dao)) problems.push('Court DAO is on the wrong network or has an invalid account id.');
  if (!onNetwork(operator)) problems.push('Court referee operator is unknown or on the wrong network.');
  if (relay && !onNetwork(relay)) problems.push('Court relay is on the wrong network or has an invalid account id.');
  if (problems.length) return problems;
  try {
    if (await chain.view({ contractId: dao, method: 'version' }) !== '2.0.0') problems.push('Court DAO is not Sputnik v2.0.0.');
    const policy = await chain.view({ contractId: dao, method: 'get_policy' });
    const roles = policy?.roles;
    const jury = Array.isArray(roles) ? roles.filter(r => r.name === 'jury') : [];
    const council = Array.isArray(roles) ? roles.filter(r => r.name === 'council') : [];
    const permissionsAre = (role, expected) => Array.isArray(role?.permissions)
      && role.permissions.length === expected.length && expected.every(p => role.permissions.includes(p));
    if (jury.length !== 1 || !Array.isArray(jury[0].kind?.Group) || jury[0].kind.Group.length !== 1
      || jury[0].kind.Group[0] !== (relay || operator)
      || !permissionsAre(jury[0], ['call:AddProposal', 'call:VoteApprove'])) {
      problems.push('Court jury must contain exactly the relay (or the legacy referee) with only call:AddProposal and call:VoteApprove.');
    }
    if (council.length !== 1 || !Array.isArray(council[0].kind?.Group) || !council[0].kind.Group.length
      || council[0].kind.Group.some(id => !onNetwork(id) || id === relay || id === operator)
      || new Set(council[0].kind.Group).size !== council[0].kind.Group.length
      || !permissionsAre(council[0], ['call:VoteReject', 'call:VoteRemove'])) {
      problems.push('Court council must hold only call:VoteReject and call:VoteRemove, with distinct council accounts.');
    }
    if (!Array.isArray(roles) || roles.length !== 2 || roles.some(r => !r.vote_policy
      || typeof r.vote_policy !== 'object' || Array.isArray(r.vote_policy) || Object.keys(r.vote_policy).length)) {
      problems.push('Court policy has extra roles or role-specific voting powers.');
    }
    const vote = policy?.default_vote_policy;
    if (vote?.weight_kind !== 'RoleWeight' || vote.quorum !== '0' || JSON.stringify(vote.threshold) !== '[1,2]') {
      problems.push('Court default vote policy differs from the frozen majority rule.');
    }
    if (!/^\d+$/.test(policy?.proposal_bond)) problems.push('Court proposal bond is invalid.');
    else {
      const balance = await chain.balance(operator);
      if (balance == null || !/^\d+$/.test(String(balance))) problems.push('Court referee balance could not be established.');
      else if (BigInt(policy.proposal_bond) > BigInt(balance)) problems.push('Court proposal bond exceeds the referee balance.');
      if (policy.proposal_bond !== '0') problems.push('Court proposal bond differs from the frozen zero bond.');
    }
    if (policy?.proposal_period !== '604800000000000' || policy.bounty_bond !== '0'
      || policy.bounty_forgiveness_period !== '86400000000000') problems.push('Court policy periods or bounty bond differ from the frozen policy.');
    if (relay) {
      const cfg = await chain.view({ contractId: relay, method: 'get_config' });
      const seconds = config.play?.settleDelaySeconds;
      if (!Number.isInteger(seconds) || seconds < 60 || seconds > 86400 || cfg?.dao !== dao
        || cfg.escrow !== config.nearContract || cfg.operator !== operator
        || String(cfg.window_ns) !== (BigInt(seconds) * 1_000_000_000n).toString()) {
        problems.push('Court relay config does not match the DAO, escrow, operator and correction window.');
      }
    }
  } catch (error) { problems.push(`Court chain checks failed: ${error.message}`); }
  return problems;
}

// The caller may hold a Bet's row lock through a chain call, so no call waits forever. A
// transaction that lands after the timeout is found by the next pass, which reads the chain first.
function bounded(promise, what) {
  let timer;
  return Promise.race([promise, new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} is unconfirmed after 120 s; the next pass reads the chain.`)), TIMEOUT_MS);
    timer.unref?.();
  })]).finally(() => clearTimeout(timer));
}

/** The proposal's only action: the escrow's referee_resolve for this Bet and outcome, with no deposit. */
export function proposalKind(config, betId, outcome) {
  return { FunctionCall: { receiver_id: config.nearContract, actions: [{ method_name: 'referee_resolve',
    args: Buffer.from(JSON.stringify({ id: betId, outcome })).toString('base64'), deposit: '0', gas: String(RESOLVE_GAS) }] } };
}

/** Which Bet and outcome a proposal resolves, read from its action (never its description), or null. */
export function proposalTarget(config, proposal) {
  const call = proposal?.kind?.FunctionCall;
  if (!call || call.receiver_id !== config.nearContract || !Array.isArray(call.actions) || call.actions.length !== 1) return null;
  const [action] = call.actions;
  if (action?.method_name !== 'referee_resolve' || String(action.deposit) !== '0') return null;
  try {
    const { id, outcome } = JSON.parse(Buffer.from(action.args, 'base64').toString('utf8'));
    return typeof id === 'string' && UUID.test(id) && OUTCOMES.has(outcome) ? { id, outcome } : null;
  } catch { return null; }
}

export async function readProposal(chain, dao, id) {
  const p = await chain.view({ contractId: dao, method: 'get_proposal', args: { id: Number(id) } });
  return { id: p.id, status: p.status, votes: p.votes || {}, voteCounts: p.vote_counts || {}, kind: p.kind,
    description: p.description, proposer: p.proposer, submissionTime: p.submission_time };
}

/** The DAO's most recent proposals, oldest first. */
export async function recentProposals(chain, dao, { limit = SCAN } = {}) {
  const last = Number(await chain.view({ contractId: dao, method: 'get_last_proposal_id' }));
  if (!Number.isSafeInteger(last) || last <= 0) return [];
  const from = Math.max(0, last - limit);
  return chain.view({ contractId: dao, method: 'get_proposals', args: { from_index: from, limit: last - from } });
}

async function filedFor(db, betId, outcome, revision) {
  const row = await db.one(`select detail from bilateral_bet_events where bet_id = $1 and kind = 'court_proposal'
    and detail->>'outcome' = $2 and (detail->>'resultRevision' = $3
      or (not (detail ? 'resultRevision') and at >= $4)) order by id desc limit 1`,
  [betId, outcome, revision.result_revision, revision.at]);
  return row?.detail || null;
}

// Scan backwards in bounded pages, including older filings after a lost reply.
// A fixed recent-proposal limit could duplicate a filing during a busy period.
async function findFiling(chain, dao, matches) {
  let end = Number(await chain.view({ contractId: dao, method: 'get_last_proposal_id' }));
  if (!Number.isSafeInteger(end) || end < 0) throw new Error('Invalid DAO proposal count');
  while (end > 0) {
    const from = Math.max(0, end - SCAN);
    const page = await chain.view({ contractId: dao, method: 'get_proposals', args: { from_index: from, limit: end - from } });
    const found = page.reverse().find(matches);
    if (found) return found.id;
    end = from;
  }
  return null;
}

/**
 * Files the outcome for a Bet as a DAO proposal, signed by the jury member (the
 * referee account), and records an append-only 'court_proposal' event
 * { dao, proposalId, outcome, resultRevision, txHash, filedAt }. Never files twice
 * for one Result revision: events are read first, then the DAO's proposals (a
 * filing whose result was lost is found there and recorded with txHash null).
 */
export async function fileRuling(db, config, chain, bet, outcome, { rulingUrl, actorId, reviewer = false } = {}) {
  const dao = courtDao(config);
  if (!isCourtBet(config, bet)) throw new UserError('This Bet does not name Stated Court as its referee.', 409);
  if (!OUTCOMES.has(outcome)) throw new Error('Unknown outcome');
  if (!UUID.test(bet.id)) throw new Error('Bet id must be a lowercase UUID');
  // reply-bets holds the Bet and statement locks while this revision is read.
  const revision = await db.one(`select r.id::text as result_revision, r.at from revisions r
    join saves s on s.statement_id = r.statement_id join bilateral_bets b on b.source_save_id = s.id
    where b.id = $1 and r.kind in ('resolved', 'resolution_changed', 'disputed') order by r.id desc limit 1`, [bet.id]);
  if (!revision?.result_revision) throw new Error('The Bet has no recorded Result revision.');
  const prior = await filedFor(db, bet.id, outcome, revision);
  if (prior) return prior;
  const judge = await referee(db, config, chain);
  const relay = config.court?.relay;
  const marker = `Result revision:${revision.result_revision}`;
  const matches = (p) => {
    const target = proposalTarget(config, p);
    if (p.proposer !== (relay || judge.id) || target?.id !== bet.id || target.outcome !== outcome) return false;
    // Pre-migration filings have no revision tag. Only recover them when their
    // on-chain submission belongs to the current Result, never a prior veto.
    const tags = String(p.description || '').match(/Result revision:\d+(?=\s|$)/g) || [];
    if (tags.length) return tags.length === 1 && tags[0] === marker;
    return /^\d+$/.test(String(p.submission_time))
      && BigInt(p.submission_time) >= BigInt(new Date(revision.at).getTime()) * 1_000_000n;
  };
  let proposalId = await findFiling(chain, dao, matches);
  let txHash = null;
  if (proposalId === null) {
    const policy = await chain.view({ contractId: dao, method: 'get_policy' });
    let digest = '';
    if (!reviewer) {
      const ruling = await db.one(`select detail from bilateral_bet_events where bet_id = $1 and kind = 'enclave_ruling' order by id limit 1`, [bet.id]);
      if (!ruling?.detail) throw new Error('The enclave Result has no ruling record.');
      // The first ruling event is the Bet's ruling (readEnclaveRuling and the public JSON read the same one).
      // SHA-256 of canonicalJson(event.detail), UTF-8: sorted object keys,
      // preserved array order, JSON primitives, no whitespace or trailing newline.
      // verify-enclave-ruling hashes the fetched document.record identically.
      digest = ` ruling sha256:${fingerprint(ruling.detail)}`;
    }
    const description = `${reviewer ? 'Stated reviewer' : 'Stated enclave jury'}: ${outcome} on bet ${bet.id}. Ruling: ${rulingUrl || ''} ${marker}${digest}`;
    if (Buffer.byteLength(description) > 1000) throw new Error('Court proposal description exceeds 1000 bytes.');
    const sent = await bounded(chain.call({ signerId: judge.id, secret: judge.secret, contractId: relay || dao, method: relay ? 'file' : 'add_proposal',
      args: relay ? { id: bet.id, outcome, description } : { proposal: { description, kind: proposalKind(config, bet.id, outcome) } },
      depositYocto: String(policy?.proposal_bond || '0'), ...(relay ? { gas: RELAY_APPROVE_GAS } : {}) }),
    'The DAO proposal');
    if (!sent.ok) throw new Error(`The DAO did not take the proposal: ${sent.failure || 'not accepted'}`);
    txHash = sent.hash;
    proposalId = Number.isSafeInteger(Number(sent.value)) && sent.value !== null && sent.value !== ''
      ? Number(sent.value) : await findFiling(chain, dao, matches);
    if (proposalId === null) throw new Error('The DAO proposal landed but its id could not be read; the next pass looks again.');
  }
  const detail = { dao, proposalId: Number(proposalId), outcome, resultRevision: revision.result_revision, txHash, filedAt: new Date().toISOString() };
  await db.query(`insert into bilateral_bet_events (bet_id, actor_user_id, kind, detail) values ($1, $2, 'court_proposal', $3)`,
    [bet.id, actorId, detail]);
  return detail;
}

/** The jury member's VoteApprove on a filed proposal. With the jury's vote the DAO executes referee_resolve. */
export async function approveRuling(db, config, chain, filed) {
  const judge = await referee(db, config, chain);
  const proposal = await readProposal(chain, filed.dao, filed.proposalId);
  const relay = config.court?.relay;
  // Never vote twice: a vote already on chain (its answer lost) is not sent again.
  if (proposal.votes[relay || judge.id]) return { hash: null, proposal };
  const sent = await bounded(chain.call({ signerId: judge.id, secret: judge.secret, contractId: relay || filed.dao, method: relay ? 'approve' : 'act_proposal',
    args: relay ? { id: Number(filed.proposalId) } : { id: Number(filed.proposalId), action: 'VoteApprove', proposal: proposal.kind },
    gas: relay ? RELAY_APPROVE_GAS : APPROVE_GAS }), 'The DAO vote');
  if (!sent.ok) throw new Error(`The DAO did not take the vote: ${sent.failure || 'not accepted'}`);
  return { hash: sent.hash, proposal: await readProposal(chain, filed.dao, filed.proposalId) };
}

/** Any Reject vote on a proposal, from any member. */
export const hasReject = (proposal) => Object.values(proposal?.votes || {}).includes('Reject');

// Chain views behind public pages, cached for 30 s.
const cache = new Map();
export async function cachedView(chain, dao, method, args = {}) {
  const key = JSON.stringify([dao, method, args]);
  const hit = cache.get(key);
  if (hit && hit.at > Date.now() - 30_000) return hit.value;
  const value = await chain.view({ contractId: dao, method, args });
  cache.set(key, { at: Date.now(), value });
  if (cache.size > 500) cache.delete(cache.keys().next().value);
  return value;
}
export function clearCourtCache() { cache.clear(); }
