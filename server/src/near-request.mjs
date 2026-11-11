// INTEGRATION: Reserve a stable, actor-scoped intent after action validation.
// Build the wallet payload from this persisted request; signing failures leave
// its binding reusable. Only matched finalized execution establishes completion.
import { randomUUID } from 'node:crypto';
import { canonicalJson as canonical, fingerprint } from './canonical.mjs';
import { UserError } from './store.mjs';

const METHODS = new Set(['create_bet', 'accept_bet', 'cancel_bet', 'expire_bet',
  'propose_outcome', 'confirm_outcome', 'dispute_outcome', 'finalize_unanswered', 'refund_unresolved', 'withdraw']);
const BINDING_METHODS = new Set(['create_bet', 'accept_bet']);
const RESERVED_METADATA = new Set(['contract', 'depositYocto', 'requestState']);
const sameId = (a, b) => String(a) === String(b);

function stateOf(bet) {
  return fingerprint({ status: bet.status, chain: bet.chain_state || null });
}

function semanticArgs(method, args) {
  const result = { ...args };
  if (BINDING_METHODS.has(method)) delete result.binding_hash;
  if (method === 'propose_outcome') delete result.proposal_id;
  if (method === 'withdraw') delete result.stated_request_id;
  return result;
}

function semanticMetadata(metadata) {
  return Object.fromEntries(Object.entries(metadata || {}).filter(([key]) => !RESERVED_METADATA.has(key)));
}

function matches(request, input) {
  return sameId(request.user_id, input.user.id)
    && request.wallet_account === input.account
    && request.metadata?.contract === input.contract
    && request.metadata?.depositYocto === input.depositYocto
    && canonical(semanticArgs(input.method, request.args)) === canonical(semanticArgs(input.method, input.args))
    && canonical(semanticMetadata(request.metadata)) === canonical(semanticMetadata(input.metadata));
}

function changed() {
  return new UserError('The challenge changed. Review its current state before opening your wallet.', 409);
}

function validateAction(bet, input) {
  const chain = bet.chain_state;
  const creator = sameId(bet.creator_user_id, input.user.id);
  if (input.method === 'create_bet') {
    if (!creator || bet.status !== 'offered' || chain) throw changed();
  } else if (input.method === 'accept_bet') {
    if (creator || bet.status !== 'offered' || !chain || chain.status !== 'offered'
      || (bet.invited_user_id && !sameId(bet.invited_user_id, input.user.id))
      || chain.creator === input.account || (bet.invited_wallet && bet.invited_wallet !== input.account)) throw changed();
  } else {
    const member = creator || sameId(bet.acceptor_user_id, input.user.id);
    if (!member || !chain || input.account !== (creator ? chain.creator : chain.acceptor)) throw changed();
    if (input.method === 'propose_outcome') {
      if (!['accepted', 'proposed', 'disputed'].includes(chain.status)
        || String(input.metadata.proposalRevision) !== (BigInt(chain.proposal?.revision || '0') + 1n).toString()) throw changed();
    }
    if (['confirm_outcome', 'dispute_outcome'].includes(input.method)
      && (chain.status !== 'proposed' || !chain.proposal || chain.proposal.id !== input.args.proposal_id
        || String(chain.proposal.revision) !== String(input.args.expected_revision)
        || chain.proposal.proposer === input.account)) throw changed();
    // Only the proposer may let an unanswered result stand.
    if (input.method === 'finalize_unanswered'
      && (chain.status !== 'proposed' || !chain.proposal || chain.proposal.id !== input.args.proposal_id
        || String(chain.proposal.revision) !== String(input.args.expected_revision)
        || chain.proposal.proposer !== input.account)) throw changed();
    if (input.method === 'cancel_bet' && (!creator || chain.status !== 'offered')) throw changed();
  }
}

/** Persist transaction intent before any wallet/RPC operation. This stabilizes
 * request arguments, not signed transaction nonces or NEAR execution. */
export async function reserveNearRequest(db, input) {
  const { bet, user, account, method, args, metadata = {}, depositYocto, contract } = input;
  if (!bet?.id || !user?.id || !METHODS.has(method) || !args || Array.isArray(args)
    || typeof account !== 'string' || !account || typeof contract !== 'string' || !contract
    || typeof depositYocto !== 'string' || !/^(0|[1-9][0-9]*)$/.test(depositYocto)
    || (method !== 'withdraw' && args.id !== bet.id)
    || (BINDING_METHODS.has(method) && !/^[a-f0-9]{64}$/.test(args.binding_hash || ''))) {
    throw new UserError('The wallet request is incomplete. Review the challenge and retry.');
  }
  const intent = { ...input, metadata };
  const expectedState = stateOf(bet);
  return db.tx(async (tx) => {
    // User before bet matches createBet's lock order. All reservations, including
    // those for different bets, serialize the count through this user row.
    const owner = await tx.one('select id, kind, setup_completed_at from users where id=$1 for update', [user.id]);
    if (!owner || owner.kind !== 'person' || !owner.setup_completed_at) {
      throw new UserError('Complete account setup before using bets.', 403);
    }
    const current = await tx.one('select * from bilateral_bets where id=$1 for update', [bet.id]);
    if (!current || stateOf(current) !== expectedState) throw changed();
    validateAction(current, intent);
    // Obtain time after both locks, since a caller may have waited at either.
    const { at, expired } = await tx.one(
      'select clock_timestamp() as at, accept_by <= clock_timestamp() as expired from bilateral_bets where id=$1', [bet.id],
    );
    if (BINDING_METHODS.has(method) && expired) {
      throw new UserError('The acceptance deadline passed. Review the challenge before making another transaction.', 409);
    }

    let pending;
    if (BINDING_METHODS.has(method)) {
      // Keep one wallet binding per X user's pending deposit. An open offer may
      // have requests from several eligible people; only a deposited binding
      // establishes its accepting identity when finalized state is verified.
      pending = await tx.many(`select * from bilateral_near_requests where bet_id=$1 and method=$2
        and ($3::bigint is null or user_id=$3)
        order by created_at, id`, [bet.id, method, method === 'accept_bet' ? user.id : null]);
    } else if (method === 'propose_outcome') {
      pending = await tx.many(`select * from bilateral_near_requests where bet_id=$1 and method=$2
        and user_id=$3 and wallet_account=$4 and metadata->>'proposalRevision'=$5
        order by created_at, id`, [bet.id, method, user.id, account, metadata.proposalRevision]);
    } else {
      pending = await tx.many(`select * from bilateral_near_requests where bet_id=$1 and method=$2
        and user_id=$3 and (metadata->>'requestState'=$4 or metadata->>'requestState' is null)
        and ($2 <> 'withdraw' or (execution_status='pending' and args->>'stated_request_id'=id::text))
        order by created_at, id`, [bet.id, method, user.id, expectedState]);
    }

    if (method === 'propose_outcome' || method === 'withdraw') {
      // A new explicit outcome, note or evidence is a separate intent. An
      // unsigned proposal must not prevent either participant proposing one.
      const matching = pending.find((request) => matches(request, intent));
      if (matching) return { request: matching, reused: true };
      if (pending.some((request) => !request.metadata?.contract)) {
        throw new UserError('An earlier proposal has no recorded contract. Verify the escrow before preparing another proposal.', 409);
      }
    } else if (pending.length) {
      // Legacy rows lack the contract/deposit context needed to prove an exact
      // retry. Never retrofit that context or replace their generated binding.
      if (pending.some((request) => !matches(request, intent))) {
        throw new UserError('An earlier wallet request is still unresolved for this action. Verify the escrow before changing its wallet or transaction details.', 409);
      }
      return { request: pending[0], reused: true };
    }

    const count = await tx.one(`select count(*)::int as n from bilateral_near_requests
      where user_id=$1 and created_at > $2::timestamptz - interval '1 hour'`, [user.id, at]);
    if (count.n >= 60) {
      throw new UserError('Too many wallet requests. Try again after an older request leaves the hourly window.', 429);
    }
    const requestId = randomUUID();
    // withdraw takes no contract arguments. The ignored JSON field binds the
    // signed transaction to this exact intent without changing contract behavior.
    const requestArgs = method === 'withdraw' ? { ...args, stated_request_id: requestId } : args;
    const request = await tx.one(`insert into bilateral_near_requests
      (id,bet_id,user_id,wallet_account,method,args,binding_hash,metadata,created_at)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9) returning *`,
    [requestId, bet.id, user.id, account, method, requestArgs,
      BINDING_METHODS.has(method) ? args.binding_hash : null,
      { ...semanticMetadata(metadata), contract, depositYocto, requestState: expectedState }, at]);
    return { request, reused: false };
  });
}
