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
import { NEAR_CALL_GAS } from './near-escrow.mjs';
import { referee } from './play.mjs';
import { UserError } from './store.mjs';

const TIMEOUT_MS = 120_000;
// The gas the DAO gives referee_resolve when it executes the proposal.
const RESOLVE_GAS = NEAR_CALL_GAS;
// act_proposal carries the execution of referee_resolve inside it.
const APPROVE_GAS = 200_000_000_000_000n;
const OUTCOMES = new Set(['yes', 'no', 'void']);
// How far back a lost filing is looked for before filing again.
const SCAN = 100;

export const courtDao = (config) => config.court?.dao || '';
export const isCourtBet = (config, bet) => Boolean(courtDao(config)) && bet?.referee_wallet === courtDao(config);

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
    return typeof id === 'string' && OUTCOMES.has(outcome) ? { id, outcome } : null;
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

async function filedFor(db, betId, outcome) {
  const row = await db.one(`select detail from bilateral_bet_events where bet_id = $1 and kind = 'court_proposal'
    and detail->>'outcome' = $2 order by id desc limit 1`, [betId, outcome]);
  return row?.detail || null;
}

/**
 * Files the outcome for a Bet as a DAO proposal, signed by the jury member (the
 * referee account), and records an append-only 'court_proposal' event
 * { dao, proposalId, outcome, txHash, filedAt }. Never files twice for one Bet
 * and outcome: the events are read first, then the DAO's recent proposals (a
 * filing whose result was lost is found there and recorded with txHash null).
 */
export async function fileRuling(db, config, chain, bet, outcome, { rulingUrl, actorId, reviewer = false } = {}) {
  const dao = courtDao(config);
  if (!isCourtBet(config, bet)) throw new UserError('This Bet does not name Stated Court as its referee.', 409);
  if (!OUTCOMES.has(outcome)) throw new Error('Unknown outcome');
  const prior = await filedFor(db, bet.id, outcome);
  if (prior) return prior;
  const judge = await referee(db, config, chain);
  const matches = (p) => p.proposer === judge.id && proposalTarget(config, p)?.id === bet.id && proposalTarget(config, p)?.outcome === outcome;
  let proposalId = (await recentProposals(chain, dao)).find(matches)?.id ?? null;
  let txHash = null;
  if (proposalId === null) {
    const policy = await chain.view({ contractId: dao, method: 'get_policy' });
    const description = `${reviewer ? 'Stated reviewer' : 'Stated enclave jury'}: ${outcome} on bet ${bet.id}. Ruling: ${rulingUrl}`;
    const sent = await bounded(chain.call({ signerId: judge.id, secret: judge.secret, contractId: dao, method: 'add_proposal',
      args: { proposal: { description, kind: proposalKind(config, bet.id, outcome) } }, depositYocto: String(policy?.proposal_bond || '0') }),
    'The DAO proposal');
    if (!sent.ok) throw new Error(`The DAO did not take the proposal: ${sent.failure || 'not accepted'}`);
    txHash = sent.hash;
    proposalId = Number.isSafeInteger(Number(sent.value)) && sent.value !== null && sent.value !== ''
      ? Number(sent.value) : (await recentProposals(chain, dao)).find(matches)?.id ?? null;
    if (proposalId === null) throw new Error('The DAO proposal landed but its id could not be read; the next pass looks again.');
  }
  const detail = { dao, proposalId: Number(proposalId), outcome, txHash, filedAt: new Date().toISOString() };
  await db.query(`insert into bilateral_bet_events (bet_id, actor_user_id, kind, detail) values ($1, $2, 'court_proposal', $3)`,
    [bet.id, actorId, detail]);
  return detail;
}

/** The jury member's VoteApprove on a filed proposal. With the jury's vote the DAO executes referee_resolve. */
export async function approveRuling(db, config, chain, filed) {
  const judge = await referee(db, config, chain);
  const proposal = await readProposal(chain, filed.dao, filed.proposalId);
  // Never vote twice: a vote already on chain (its answer lost) is not sent again.
  if (proposal.votes[judge.id]) return { hash: null, proposal };
  const sent = await bounded(chain.call({ signerId: judge.id, secret: judge.secret, contractId: filed.dao, method: 'act_proposal',
    args: { id: Number(filed.proposalId), action: 'VoteApprove', proposal: proposal.kind }, gas: APPROVE_GAS }), 'The DAO vote');
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
