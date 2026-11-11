// INTEGRATION: Actor-scoped transaction references and finalized withdrawal views.
// Only verifyNearExecution establishes completion; wallet callbacks and credit
// balance changes never do. DESIGN.md controls the associated page presentation.
import { verifyNearExecution } from './near-execution.mjs';
import { viewCredit } from './near-escrow.mjs';
import { UserError } from './store.mjs';

const UUID = /^[a-f0-9]{8}-[a-f0-9]{4}-[1-8][a-f0-9]{3}-[89ab][a-f0-9]{3}-[a-f0-9]{12}$/i;

async function reconcile(db, request, transactionHash, options) {
  const result = await verifyNearExecution(request, transactionHash, options);
  return db.tx(async (tx) => {
    const current = await tx.one('select * from bilateral_near_requests where id=$1 for update', [request.id]);
    // RPC work uses a snapshot. A background check or another explicit
    // correction must not replace a reference changed while that work ran.
    if (current.transaction_hash !== request.transaction_hash) {
      return { status: current.execution_status, transactionHash: current.transaction_hash, explanation: current.execution_message };
    }
    if (current.execution_status === 'succeeded' || (current.execution_status === 'failed' && current.transaction_hash === transactionHash)) {
      if (current.transaction_hash !== transactionHash) throw new UserError('This request already has a finalized transaction. Review its recorded result.', 409);
      return { status: current.execution_status, transactionHash, explanation: current.execution_message };
    }
    try {
      await tx.query(`update bilateral_near_requests set transaction_hash=$2, execution_status=$3,
        execution_message=$4, execution_checked_at=clock_timestamp() where id=$1`,
      [request.id, transactionHash, result.status, result.explanation]);
    } catch (error) {
      if (error.code === '23505') throw new UserError('This transaction belongs to another recorded request. Check its transaction hash.', 409);
      throw error;
    }
    return result;
  });
}

export async function verifyBetTransaction(db, config, user, betId, input, options = {}) {
  if (!user || !UUID.test(input.requestId || '')) throw new UserError('Choose a wallet request from your account.', 404);
  const request = await db.one(`select * from bilateral_near_requests
    where id=$1 and bet_id=$2 and user_id=$3`, [input.requestId, betId, user.id]);
  if (!request || request.metadata.contract !== config.nearContract) throw new UserError('This wallet request is unavailable to your account.', 404);
  return reconcile(db, request, input.transactionHash, options);
}

export async function syncPendingBetTransactions(db, config, betId, options = {}) {
  const requests = await db.many(`select * from bilateral_near_requests where bet_id=$1
    and execution_status='pending' and transaction_hash is not null
    order by execution_checked_at asc nulls first, created_at, id limit 5`, [betId]);
  // At most five independent lookups. A slow RPC cannot serialize this batch;
  // wait for every lookup before returning so subsequent batches stay bounded.
  const results = await Promise.allSettled(requests.map(async (request) => {
    if (request.metadata.contract !== config.nearContract) return 0;
    try {
      const result = await reconcile(db, request, request.transaction_hash, options);
      return result.status !== 'pending' ? 1 : 0;
    } catch (error) {
      if (!(error instanceof UserError) || error.status !== 409) throw error;
      // An untrusted reference that later resolves to another transaction is
      // replaceable; it must not strand this request or starve the queue.
      await db.query(`update bilateral_near_requests set transaction_hash=null,
        execution_message='The reported transaction did not match this request. Enter its correct transaction hash.',
        execution_checked_at=clock_timestamp() where id=$1 and execution_status='pending' and transaction_hash=$2`,
      [request.id, request.transaction_hash]);
      return 0;
    }
  }));
  let changed = 0;
  for (const result of results) {
    if (result.status === 'rejected') throw result.reason;
    changed += result.value;
  }
  return changed;
}

export async function withdrawalView(db, config, user, bet, options = {}) {
  const accountId = String(bet.creator_user_id) === String(user.id) ? bet.creator_wallet : bet.acceptor_wallet;
  const request = await db.one(`select id, execution_status, transaction_hash, execution_message
    from bilateral_near_requests where bet_id=$1 and user_id=$2 and method='withdraw'
    order by created_at desc, id desc limit 1`, [bet.id, user.id]);
  if (!accountId || !config.nearContract) return { creditYocto: null, request };
  try {
    const credit = await viewCredit(config.nearContract, accountId, options);
    if (typeof credit !== 'string' || !/^(0|[1-9][0-9]{0,38})$/.test(credit)) throw new Error('Invalid credit');
    return { creditYocto: credit, request };
  } catch {
    return { creditYocto: null, request };
  }
}
