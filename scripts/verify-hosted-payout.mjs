// INTEGRATION: Read-only corroboration of the public hosted testnet payout.
// Each fixed RPC must independently provide finalized state and linked receipts.
import { readFileSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { baseDecode } from 'near-api-js';
import { canonicalJson, fingerprint } from '../server/src/canonical.mjs';
import { NEAR_CALL_GAS, rpc, viewEscrowSnapshot } from '../server/src/near-escrow.mjs';
import { deliveryFromReceipts } from '../server/src/near-delivery.mjs';
import { isAccount, isNamedAccount, network } from '../server/src/near-network.mjs';
import { normalizePolicy } from './create-court-dao.mjs';

// Archival endpoints: ordinary testnet nodes drop transactions after about five epochs, so the
// November payout stops answering there within days. Both endpoints below still return it.
const ENDPOINTS = ['https://archival-rpc.testnet.fastnear.com', 'https://archival-rpc.testnet.near.org'];
const NO_CODE = '11111111111111111111111111111111';
// The code the hosted escrow ran when it paid (view_account, 12 November 2026). Any other code fails.
const PINNED_CODE = { 'stated-escrow-52081551be.testnet': 'Bqr2TsgyFRNDw2GZ6q9aT7cMAnjZNERKdzaBstRgKaAg' };
const DEFAULT_EVIDENCE = Symbol('default evidence');
const HASH = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const UINT = /^(?:0|[1-9][0-9]{0,38})$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const HEX_HASH = /^[0-9a-f]{64}$/;
const sputnikDao = account => typeof account === 'string' && account.endsWith('.sputnik-v2.testnet');
const LIMITS = [
  'RPC corroboration only; this command does not verify a light-client proof.',
  'Social X links and the human outcome decision are not checked.',
  'Both recorded social identities are operator controlled; this demonstrates functionality, not independent adoption.',
  'Testnet tokens only. No transactions are submitted and no current withdrawal credit is asserted.',
];

class Mismatch extends Error {}
class Unavailable extends Error {}
function requireThat(condition, code) { if (!condition) throw new Mismatch(code); }
function object(value) { return value !== null && typeof value === 'object' && !Array.isArray(value); }
function keys(value, expected) {
  return object(value) && canonicalJson(Object.keys(value).sort()) === canonicalJson([...expected].sort());
}
function hash(value) {
  if (typeof value !== 'string' || !HASH.test(value)) return false;
  try { return baseDecode(value).length === 32; } catch { return false; }
}
function uint(value) { return typeof value === 'string' && UINT.test(value); }
function base64(value) {
  return typeof value === 'string' && value.length <= 32768
    && Buffer.from(value, 'base64').toString('base64') === value;
}
function success(status) {
  return keys(status, ['SuccessValue']) && base64(status.SuccessValue)
    || keys(status, ['SuccessReceiptId']) && hash(status.SuccessReceiptId);
}
function argumentsOf(encoded) {
  requireThat(base64(encoded), 'invalid_call_arguments');
  let text;
  let value;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.from(encoded, 'base64'));
    value = JSON.parse(text);
  } catch { throw new Mismatch('invalid_call_arguments'); }
  // The recorded calls use compact JSON. Re-encoding also rejects duplicate keys,
  // malformed UTF-8 and concealed contradictory fields in the public arguments.
  requireThat(object(value) && JSON.stringify(value) === text, 'invalid_call_arguments');
  return value;
}
function functionCall(actions, method, args, gas = NEAR_CALL_GAS) {
  requireThat(Array.isArray(actions) && actions.length === 1 && keys(actions[0], ['FunctionCall']), 'unexpected_actions');
  const call = actions[0].FunctionCall;
  requireThat(keys(call, ['method_name', 'args', 'deposit', 'gas']) && call.method_name === method
    && call.deposit === '0' && (call.gas === Number(gas) || call.gas === String(gas)), 'unexpected_function_call');
  const actual = argumentsOf(call.args);
  requireThat(canonicalJson(actual) === canonicalJson(args), 'call_arguments_mismatch');
  return call;
}
function evidenceRecord(proof) {
  requireThat(network().id === 'testnet', 'testnet_required');
  requireThat(object(proof) && proof.network === 'NEAR testnet' && isNamedAccount(proof.contract), 'invalid_evidence');
  let url;
  try { url = new URL(proof.betUrl); } catch { throw new Mismatch('invalid_bet_url'); }
  const id = url.pathname.slice('/bets/'.length);
  requireThat(url.origin === 'https://stated-production.up.railway.app' && !url.username && !url.password
    && !url.search && !url.hash && url.pathname === `/bets/${id}` && UUID.test(id), 'invalid_bet_url');
  requireThat(uint(proof.stakeYoctoEach) && BigInt(proof.stakeYoctoEach) > 0n
    && ['yes', 'no'].includes(proof.outcome) && object(proof.payout) && isAccount(proof.payout.recipient)
    && uint(proof.payout.amountYocto) && BigInt(proof.stakeYoctoEach) * 2n === BigInt(proof.payout.amountYocto)
    && hash(proof.payout.transferReceipt) && hash(proof.payout.callbackReceipt)
    && proof.payout.transferReceipt !== proof.payout.callbackReceipt
    && object(proof.transactions) && hash(proof.transactions.withdraw), 'invalid_evidence');
  let resolution;
  if (proof.court !== undefined) {
    const court = proof.court;
    requireThat(object(court) && isNamedAccount(court.dao) && sputnikDao(court.dao) && isNamedAccount(court.relay)
      && court.relay !== court.dao && isAccount(court.approveSigner)
      && Number.isSafeInteger(court.proposalId) && court.proposalId >= 0
      && hash(proof.transactions.approve) && court.approve === proof.transactions.approve, 'invalid_court_evidence');
    resolution = { court: { dao: court.dao, relay: court.relay, proposalId: court.proposalId, approveSigner: court.approveSigner },
      approve: proof.transactions.approve };
  } else {
    requireThat(hash(proof.transactions.refereeResolve), 'invalid_evidence');
    resolution = { refereeResolve: proof.transactions.refereeResolve };
  }
  return { id, contract: proof.contract, stakeYoctoEach: proof.stakeYoctoEach, outcome: proof.outcome,
    winner: proof.payout.recipient, amountYocto: proof.payout.amountYocto,
    ...resolution, withdraw: proof.transactions.withdraw,
    transferReceipt: proof.payout.transferReceipt, callbackReceipt: proof.payout.callbackReceipt };
}
function settledBet(snapshot, record) {
  const bet = snapshot?.value;
  requireThat(object(bet) && bet.id === record.id && bet.stake_yocto === record.stakeYoctoEach
    && bet.status === 'settled' && ['yes', 'no'].includes(bet.creator_side)
    && isAccount(bet.creator) && isAccount(bet.acceptor) && isAccount(bet.referee)
    && bet.creator !== bet.acceptor && bet.referee !== bet.creator && bet.referee !== bet.acceptor
    && bet.resolution?.method === 'referee' && bet.resolution.outcome === record.outcome
    && uint(bet.resolution.resolved_at_ns) && typeof bet.terms_hash === 'string' && HEX_HASH.test(bet.terms_hash)
    && typeof bet.creator_binding_hash === 'string' && HEX_HASH.test(bet.creator_binding_hash)
    && typeof bet.acceptor_binding_hash === 'string' && HEX_HASH.test(bet.acceptor_binding_hash), 'settled_bet_mismatch');
  requireThat((bet.creator_side === record.outcome ? bet.creator : bet.acceptor) === record.winner, 'winner_mismatch');
  requireThat(Boolean(record.court) === sputnikDao(bet.referee)
    && (!record.court || bet.referee === record.court.dao), 'court_referee_mismatch');
  return { id: bet.id, creator: bet.creator, acceptor: bet.acceptor, referee: bet.referee,
    creatorSide: bet.creator_side, stakeYoctoEach: bet.stake_yocto, status: bet.status,
    outcome: bet.resolution.outcome, resolutionMethod: bet.resolution.method,
    resolvedAtNs: bet.resolution.resolved_at_ns, termsHash: bet.terms_hash,
    creatorBindingHash: bet.creator_binding_hash, acceptorBindingHash: bet.acceptor_binding_hash };
}

// Require a complete, successful receipt graph rooted in the requested transaction.
// An isolated success-shaped transfer or callback cannot satisfy this check.
function execution(result, { transactionHash, signer, contract, method, args, finalValue, gas = NEAR_CALL_GAS }) {
  const tx = result?.transaction;
  requireThat(result?.final_execution_status === 'FINAL' && keys(result.status, ['SuccessValue'])
    && base64(result.status.SuccessValue) && (finalValue === undefined || result.status.SuccessValue === finalValue), 'execution_not_final_success');
  requireThat(tx?.hash === transactionHash && tx.signer_id === signer && tx.receiver_id === contract, 'transaction_identity_mismatch');
  const call = functionCall(tx.actions, method, args, gas);
  requireThat(Array.isArray(result.receipts) && result.receipts.length > 0 && result.receipts.length <= 256
    && Array.isArray(result.receipts_outcome) && result.receipts_outcome.length === result.receipts.length, 'invalid_receipt_graph');
  const receipts = new Map();
  const outcomes = new Map();
  for (const receipt of result.receipts) {
    requireThat(hash(receipt?.receipt_id) && !receipts.has(receipt.receipt_id), 'invalid_receipt_graph');
    receipts.set(receipt.receipt_id, receipt);
  }
  for (const item of result.receipts_outcome) {
    const receipt = receipts.get(item?.id);
    requireThat(receipt && !outcomes.has(item.id) && item.outcome?.executor_id === receipt.receiver_id
      && success(item.outcome.status) && Array.isArray(item.outcome.receipt_ids), 'receipt_execution_mismatch');
    outcomes.set(item.id, item.outcome);
  }
  const txOutcome = result.transaction_outcome;
  requireThat(txOutcome?.id === transactionHash && txOutcome.outcome?.executor_id === signer
    && keys(txOutcome.outcome.status, ['SuccessReceiptId']) && Array.isArray(txOutcome.outcome.receipt_ids)
    && txOutcome.outcome.receipt_ids.length === 1
    && txOutcome.outcome.receipt_ids[0] === txOutcome.outcome.status.SuccessReceiptId, 'transaction_outcome_mismatch');
  const rootId = txOutcome.outcome.status.SuccessReceiptId;
  const root = receipts.get(rootId);
  requireThat(root?.receiver_id === contract && root.predecessor_id === signer, 'root_receipt_mismatch');
  functionCall(root.receipt?.Action?.actions, method, args, gas);
  requireThat(root.receipt.Action.signer_id === signer, 'root_receipt_mismatch');
  const visited = new Set();
  const visit = (id) => {
    requireThat(receipts.has(id) && !visited.has(id), 'invalid_receipt_graph');
    visited.add(id);
    const outcome = outcomes.get(id);
    if (Object.hasOwn(outcome.status, 'SuccessReceiptId')) {
      requireThat(outcome.receipt_ids.includes(outcome.status.SuccessReceiptId), 'invalid_receipt_graph');
    }
    for (const child of outcome.receipt_ids) visit(child);
  };
  visit(rootId);
  requireThat(visited.size === receipts.size, 'unlinked_receipt');
  return { receipts, outcomes, rootId, rootOutcome: outcomes.get(rootId), call };
}

// Compare immutable execution facts, retaining the actual encoded call bytes.
// RPC receipt-array order and number/string gas serialization carry no meaning.
function executionFingerprint(result, graph) {
  const actions = items => items.map(action => action.FunctionCall ? {
    ...action, FunctionCall: { ...action.FunctionCall,
      gas: Number.isSafeInteger(action.FunctionCall.gas) && action.FunctionCall.gas >= 0
        ? String(action.FunctionCall.gas) : action.FunctionCall.gas },
  } : action);
  const outcome = value => ({ executor: value.executor_id, status: value.status,
    children: [...value.receipt_ids].sort() });
  const tx = result.transaction;
  return fingerprint({
    transaction: { hash: tx.hash, signer: tx.signer_id, receiver: tx.receiver_id, actions: actions(tx.actions) },
    status: result.status, root: graph.rootId, transactionOutcome: outcome(result.transaction_outcome.outcome),
    receipts: [...graph.receipts.keys()].sort().map(id => {
      const receipt = graph.receipts.get(id);
      const body = receipt.receipt;
      return { id, predecessor: receipt.predecessor_id, receiver: receipt.receiver_id,
        receipt: body?.Action ? { ...body, Action: { ...body.Action, actions: actions(body.Action.actions) } } : body,
        outcome: outcome(graph.outcomes.get(id)) };
    }),
  });
}

function courtProposal(proposal, record) {
  const court = record.court;
  requireThat(object(proposal) && proposal.id === court.proposalId && proposal.status === 'Approved'
    && proposal.proposer === court.relay && uint(proposal.submission_time), 'court_proposal_mismatch');
  const kind = proposal.kind;
  requireThat(keys(kind, ['FunctionCall']) && keys(kind.FunctionCall, ['receiver_id', 'actions'])
    && kind.FunctionCall.receiver_id === record.contract && Array.isArray(kind.FunctionCall.actions)
    && kind.FunctionCall.actions.length === 1, 'court_proposal_kind_mismatch');
  // RESOLVE_GAS in contracts/jury-relay: the DAO must execute this single, zero-deposit action.
  functionCall(kind.FunctionCall.actions.map(action => ({ FunctionCall: action })), 'referee_resolve',
    { id: record.id, outcome: record.outcome }, 100000000000000n);
  return proposal;
}

function juryPolicy(policy, relay) {
  requireThat(object(policy) && Array.isArray(policy.roles) && policy.roles.every(object), 'court_policy_mismatch');
  const normalized = normalizePolicy(policy);
  const jury = normalized.roles.filter(role => role?.name === 'jury');
  requireThat(jury.length === 1 && keys(jury[0].kind, ['Group'])
    && canonicalJson(jury[0].kind.Group) === canonicalJson([relay])
    && Array.isArray(jury[0].permissions) && jury[0].permissions.includes('call:VoteApprove'), 'court_policy_mismatch');
  // A second role with wildcard voting would defeat the exclusive jury seat.
  requireThat(normalized.roles.every(role => object(role) && Array.isArray(role.permissions)
    && (role.name === 'jury' || !role.permissions.some(permission =>
      ['call:VoteApprove', '*:VoteApprove', 'call:*', '*:*'].includes(permission)))), 'court_policy_mismatch');
  return normalized;
}

function courtApproval(result, record, proposal) {
  const court = record.court;
  const graph = execution(result, { transactionHash: record.approve, signer: court.approveSigner,
    contract: court.relay, method: 'approve', args: { id: court.proposalId }, gas: 300000000000000n });
  const calls = (receiver, method) => [...graph.receipts.values()].filter(receipt => receipt.receiver_id === receiver
    && receipt.receipt?.Action?.actions?.some(action => action.FunctionCall?.method_name === method));
  const votes = calls(court.dao, 'act_proposal');
  const resolutions = calls(record.contract, 'referee_resolve');
  requireThat(votes.length === 1 && votes[0].predecessor_id === court.relay, 'court_vote_receipt_mismatch');
  const vote = votes[0];
  // ACT_GAS in contracts/jury-relay includes the 100-Tgas escrow action.
  functionCall(vote.receipt.Action.actions, 'act_proposal',
    { id: court.proposalId, action: 'VoteApprove', proposal: proposal.kind }, 200000000000000n);
  requireThat(resolutions.length === 1 && resolutions[0].predecessor_id === court.dao, 'court_resolution_receipt_mismatch');
  const resolution = resolutions[0];
  functionCall(resolution.receipt.Action.actions, 'referee_resolve',
    { id: record.id, outcome: record.outcome }, 100000000000000n);
  requireThat(graph.outcomes.get(vote.receipt_id).receipt_ids.includes(resolution.receipt_id), 'court_resolution_unlinked');
  return graph;
}

async function viewJson(accountId, method, args, options) {
  const result = await rpc('query', { request_type: 'call_function', finality: 'final', account_id: accountId,
    method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') }, options);
  requireThat(Array.isArray(result?.result) && result.result.every(byte => Number.isInteger(byte) && byte >= 0 && byte <= 255),
    'invalid_view_result');
  return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Uint8Array.from(result.result)));
}

async function courtSettlement(record, options) {
  const court = record.court;
  const proposal = courtProposal(await viewJson(court.dao, 'get_proposal', { id: court.proposalId }, options), record);
  const policy = juryPolicy(await viewJson(court.dao, 'get_policy', {}, options), court.relay);
  const access = await rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: court.relay }, options);
  requireThat(object(access) && Array.isArray(access.keys), 'invalid_access_key_list');
  requireThat(access.keys.length === 0, 'relay_has_access_keys');
  const approved = await rpc('tx_status', { tx_hash: record.approve, sender_account_id: court.approveSigner, wait_until: 'FINAL' }, options);
  const graph = courtApproval(approved, record, proposal);
  return { facts: { courtProposal: proposal, courtPolicy: policy, relayAccessKeys: 0 },
    fingerprints: { approve: executionFingerprint(approved, graph) } };
}

function withdrawal(result, record, args) {
  const graph = execution(result, { transactionHash: record.withdraw, signer: record.winner,
    contract: record.contract, method: 'withdraw', args, finalValue: 'dHJ1ZQ==' });
  const transfer = graph.receipts.get(record.transferReceipt);
  const callback = graph.receipts.get(record.callbackReceipt);
  const transferAction = transfer?.receipt?.Action;
  const callbackAction = callback?.receipt?.Action;
  requireThat(transfer?.predecessor_id === record.contract && transfer.receiver_id === record.winner
    && transferAction?.signer_id === record.winner && Array.isArray(transferAction.actions)
    && transferAction.actions.length === 1 && keys(transferAction.actions[0], ['Transfer'])
    && keys(transferAction.actions[0].Transfer, ['deposit'])
    && transferAction.actions[0].Transfer.deposit === record.amountYocto, 'transfer_receipt_mismatch');
  requireThat(callback?.predecessor_id === record.contract && callback.receiver_id === record.contract
    && callbackAction?.signer_id === record.winner
    && graph.outcomes.get(record.callbackReceipt)?.status?.SuccessValue === 'dHJ1ZQ==', 'callback_receipt_mismatch');
  functionCall(callbackAction.actions, 'on_withdraw', { account_id: record.winner, amount: record.amountYocto }, 10000000000000n);
  requireThat(graph.rootOutcome.receipt_ids.includes(record.transferReceipt)
    && graph.rootOutcome.receipt_ids.includes(record.callbackReceipt)
    && graph.rootOutcome.status.SuccessReceiptId === record.callbackReceipt, 'withdrawal_graph_mismatch');
  const outputs = transferAction.output_data_receivers;
  const inputs = callbackAction.input_data_ids;
  requireThat(Array.isArray(outputs) && outputs.length === 1 && outputs[0].receiver_id === record.contract
    && hash(outputs[0].data_id) && Array.isArray(inputs) && inputs.length === 1
    && inputs[0] === outputs[0].data_id, 'callback_dependency_mismatch');
  const delivery = deliveryFromReceipts(result, { transactionHash: record.withdraw, accountId: record.winner,
    amountYocto: record.amountYocto, wrapContractId: 'wrap.testnet' });
  requireThat(delivery?.kind === 'native' && delivery.final === true
    && delivery.deliveredYocto === record.amountYocto, 'payout_delivery_mismatch');
  return graph;
}

// rpc still owns size limits and parsing. Only failures at the transport stream
// boundary become Unavailable; malformed response or argument JSON remains FAIL.
function transportResponse(response) {
  if (!response.body) return response;
  const reader = response.body.getReader();
  const body = new ReadableStream({
    async pull(controller) {
      let chunk;
      try { chunk = await reader.read(); }
      catch {
        reader.releaseLock();
        controller.error(new Unavailable('rpc_unavailable'));
        return;
      }
      if (chunk.done) { reader.releaseLock(); controller.close(); }
      else controller.enqueue(chunk.value);
    },
    async cancel(reason) {
      try { await reader.cancel(reason); }
      catch { throw new Unavailable('rpc_unavailable'); }
      finally { reader.releaseLock(); }
    },
  }, { highWaterMark: 0 });
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
}

async function provider(endpoint, record, fetchImpl, timeoutMs) {
  const controller = new AbortController();
  let timer;
  const work = async () => {
    const boundedFetch = async (url, init) => {
      requireThat(url === endpoint, 'unexpected_rpc_endpoint');
      try {
        const response = await fetchImpl(url, { ...init, signal: AbortSignal.any([init.signal, controller.signal]) });
        if (!response.ok) throw new Unavailable('rpc_unavailable');
        return transportResponse(response);
      } catch (error) {
        if (error instanceof Mismatch) throw error;
        throw new Unavailable('rpc_unavailable');
      }
    };
    const options = { fetchImpl: boundedFetch, urls: [endpoint] };
    const snapshot = await viewEscrowSnapshot(record.contract, record.id, options);
    const bet = settledBet(snapshot, record);
    // The contract that paid must have code and no access key, so nobody can change it or move its funds.
    const account = await rpc('query', { request_type: 'view_account', finality: 'final', account_id: record.contract }, options);
    requireThat(object(account) && typeof account.code_hash === 'string' && HASH.test(account.code_hash)
      && account.code_hash !== NO_CODE, 'contract_code_missing');
    requireThat(!PINNED_CODE[record.contract] || account.code_hash === PINNED_CODE[record.contract], 'contract_code_mismatch');
    const access = await rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: record.contract }, options);
    requireThat(object(access) && Array.isArray(access.keys), 'invalid_access_key_list');
    requireThat(access.keys.length === 0, 'contract_has_access_keys');
    let settlement;
    if (record.court) settlement = await courtSettlement(record, options);
    else {
      const referee = await rpc('tx_status', { tx_hash: record.refereeResolve, sender_account_id: bet.referee, wait_until: 'FINAL' }, options);
      const refereeGraph = execution(referee, { transactionHash: record.refereeResolve, signer: bet.referee,
        contract: record.contract, method: 'referee_resolve', args: { id: record.id, outcome: record.outcome } });
      settlement = { facts: {}, fingerprints: { refereeResolve: executionFingerprint(referee, refereeGraph) } };
    }
    const withdrawn = await rpc('tx_status', { tx_hash: record.withdraw, sender_account_id: record.winner, wait_until: 'FINAL' }, options);
    const args = argumentsOf(withdrawn?.transaction?.actions?.[0]?.FunctionCall?.args);
    // The optional public tag is reported by the transaction, not evidence of a
    // private stored request, database entry, or authorization decision.
    requireThat(keys(args, []) || keys(args, ['stated_request_id']) && typeof args.stated_request_id === 'string'
      && UUID.test(args.stated_request_id), 'withdraw_arguments_mismatch');
    const withdrawalGraph = withdrawal(withdrawn, record, args);
    return { endpoint, status: 'PASS', blockHeight: snapshot.blockHeight,
      evidence: { ...record, bet, contractCodeHash: account.code_hash, contractAccessKeys: 0, withdrawalReturnedTrue: true, deliveryKind: 'native',
        ...settlement.facts, executionFingerprints: { ...settlement.fingerprints,
          withdraw: executionFingerprint(withdrawn, withdrawalGraph) } } };
  };
  try {
    return await Promise.race([work(), new Promise((_, reject) => {
      timer = setTimeout(() => { controller.abort(); reject(new Unavailable('provider_deadline')); }, timeoutMs);
    })]);
  } catch (error) {
    const unavailable = error instanceof Unavailable || controller.signal.aborted
      || typeof error?.message === 'string' && error.message.startsWith('NEAR RPC error:');
    return { endpoint, status: unavailable ? 'UNAVAILABLE' : 'FAIL',
      reason: unavailable ? 'rpc_unavailable' : error instanceof Mismatch ? error.message : 'invalid_rpc_response' };
  } finally { clearTimeout(timer); controller.abort(); }
}

export async function verifyHostedPayout({ fetchImpl = fetch, evidence = DEFAULT_EVIDENCE, timeoutMs = 30000 } = {}) {
  const report = { overall: 'FAIL', network: 'NEAR testnet', providers: [], limitations: [...LIMITS] };
  let record;
  try {
    requireThat(typeof fetchImpl === 'function' && Number.isSafeInteger(timeoutMs) && timeoutMs > 0 && timeoutMs <= 30000, 'invalid_options');
    if (evidence === DEFAULT_EVIDENCE) evidence = JSON.parse(readFileSync(new URL('../evidence/hosted-real-x-testnet-20261111.json', import.meta.url), 'utf8'));
    record = evidenceRecord(evidence);
  } catch (error) {
    report.reason = error instanceof Mismatch ? error.message : 'invalid_evidence';
    return report;
  }
  report.providers = await Promise.all(ENDPOINTS.map(endpoint => provider(endpoint, record, fetchImpl, timeoutMs)));
  if (report.providers.some(result => result.status === 'FAIL')) return report;
  if (report.providers.some(result => result.status === 'UNAVAILABLE')) { report.overall = 'UNAVAILABLE'; return report; }
  if (canonicalJson(report.providers[0].evidence) !== canonicalJson(report.providers[1].evidence)) {
    report.reason = 'provider_disagreement';
    for (const result of report.providers) { result.status = 'FAIL'; result.reason = 'provider_disagreement'; }
    return report;
  }
  report.overall = 'PASS';
  return report;
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  let report;
  const args = process.argv.slice(2);
  if (args.length === 0) report = await verifyHostedPayout();
  else if (args.length === 1 && args[0] && !args[0].startsWith('-')) {
    let evidence;
    try { evidence = JSON.parse(readFileSync(args[0], 'utf8')); } catch { evidence = null; }
    report = await verifyHostedPayout({ evidence });
  } else report = { overall: 'FAIL', reason: 'unsupported_arguments', providers: [], limitations: [...LIMITS] };
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  process.exitCode = report.overall === 'PASS' ? 0 : report.overall === 'UNAVAILABLE' ? 2 : 1;
}
