// INTEGRATION: Explicit Bet publication is independent of profile/save visibility.
// near-bets.mjs must set near_verified_at after finalized synchronization. Reads
// expose stored snapshots only; handlers must sync again before any deposit.
import { baseDecode } from 'near-api-js';
import { isAccount } from './near-network.mjs';
import { idOf, UserError } from './store.mjs';
import { readPublicResultEvidence } from './bet-result-evidence.mjs';
import { readEnclaveRuling } from './enclave-ruling.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const STATUSES = new Set(['offered', 'accepted', 'proposed', 'disputed', 'settled', 'cancelled', 'expired', 'refunded']);
const OUTCOMES = new Set(['yes', 'no', 'void']);
const STALE_AFTER_MS = 5 * 60 * 1000;

// The base projection excludes source content, annotations and proposal notes.
const SELECT = `select b.id, b.creator_user_id, b.acceptor_user_id, b.invited_user_id,
  b.claim, b.criteria, b.evidence_source_url, b.creator_side, b.stake_yocto,
  b.accept_by, b.resolve_at, b.created_at, b.accepted_at, b.settled_at,
  b.creator_wallet, b.acceptor_wallet, b.invited_wallet, b.terms_hash, b.referee_wallet,
  b.chain_state, b.near_height, b.near_verified_at,
  p.published_at, creator.x_username as creator_username,
  acceptor.x_username as acceptor_username, clock_timestamp() as read_at,
  exists (select 1 from bilateral_near_requests r
    where r.bet_id=b.id and r.method='create_bet' and r.user_id=b.creator_user_id
      and r.wallet_account=b.chain_state->>'creator'
      and r.binding_hash=b.chain_state->>'creator_binding_hash') as creator_bound,
  exists (select 1 from bilateral_near_requests r
    where r.bet_id=b.id and r.method='accept_bet' and r.user_id=b.acceptor_user_id
      and r.wallet_account=b.chain_state->>'acceptor'
      and r.binding_hash=b.chain_state->>'acceptor_binding_hash') as acceptor_bound,
  exists (select 1 from bilateral_bet_public_consents c
    where c.bet_id=b.id and c.user_id=b.acceptor_user_id) as acceptor_consented,
  (select count(*)::text from bilateral_bet_follows f where f.bet_id=b.id) as follower_count
  from bilateral_bets b
  join bilateral_bet_publications p on p.bet_id=b.id and p.creator_user_id=b.creator_user_id
  join users creator on creator.id=b.creator_user_id
  left join users acceptor on acceptor.id=b.acceptor_user_id`;

function reference(id) {
  if (typeof id !== 'string' || !UUID.test(id)) throw new UserError('Use a valid bet reference.');
  return id.toLowerCase();
}

function actorId(user) {
  if (!user) throw new UserError('Sign in with X to continue.', 401);
  if (user.kind !== 'person' || !user.x_user_id) throw new UserError('Use a personal X account.', 403);
  return BigInt(idOf(user.id)).toString();
}

async function actor(tx, user, { setup = false } = {}) {
  const id = actorId(user);
  const row = await tx.one('select id, kind, x_user_id, setup_completed_at from users where id=$1 for share', [id]);
  if (!row || row.kind !== 'person' || row.x_user_id !== user.x_user_id) {
    throw new UserError('Sign in with X again to continue.', 401);
  }
  if (setup && !row.setup_completed_at) throw new UserError('Complete account setup before publishing or joining a bet.', 403);
  return id;
}

function timestamp(value) {
  if (value == null) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

function nanoseconds(value) {
  const iso = timestamp(value);
  return iso ? (BigInt(new Date(iso).getTime()) * 1000000n).toString() : null;
}

function snapshotVerified(row) {
  const chain = row.chain_state;
  if (!chain || typeof chain !== 'object' || Array.isArray(chain)
    || !STATUSES.has(chain.status) || !row.creator_bound
    || !/^\d+$/.test(String(row.near_height || '')) || BigInt(row.near_height) < 1n
    || !isAccount(chain.creator || '') || !HASH.test(chain.creator_binding_hash || '')
    || chain.creator !== row.creator_wallet || chain.id !== row.id
    || chain.terms_hash !== row.terms_hash || chain.stake_yocto !== row.stake_yocto
    || chain.creator_side !== row.creator_side || chain.accept_by_ns !== nanoseconds(row.accept_by)
    || chain.resolve_at_ns !== nanoseconds(row.resolve_at)
    || (chain.invited_account || null) !== (row.invited_wallet || null)
    || (chain.referee || null) !== (row.referee_wallet || null)) return false;
  const accepted = ['accepted', 'proposed', 'disputed', 'settled', 'refunded'].includes(chain.status);
  if (accepted && !chain.acceptor) return false;
  if (chain.acceptor && (!isAccount(chain.acceptor) || !HASH.test(chain.acceptor_binding_hash || '')
    || chain.acceptor !== row.acceptor_wallet || chain.acceptor === chain.creator
    || (row.invited_wallet && chain.acceptor !== row.invited_wallet))) return false;
  if (chain.status === 'proposed' && !chain.proposal) return false;
  if (chain.status === 'settled' && !chain.proposal && !chain.resolution) return false;
  if (chain.resolution && (!OUTCOMES.has(chain.resolution.outcome)
    || !['agreement', 'unanswered', 'referee'].includes(chain.resolution.method))) return false;
  if (chain.proposal && (!OUTCOMES.has(chain.proposal.outcome)
    || ![chain.creator, chain.acceptor].includes(chain.proposal.proposer)
    || !/^\d{1,20}$/.test(String(chain.proposal.revision || ''))
    || BigInt(chain.proposal.revision) < 1n || BigInt(chain.proposal.revision) > 18446744073709551615n)) return false;
  return true;
}

function view(row) {
  const verified = snapshotVerified(row);
  const chain = verified ? row.chain_state : null;
  const checked = verified ? timestamp(row.near_verified_at) : null;
  const now = new Date(row.read_at).getTime();
  const age = checked ? now - new Date(checked).getTime() : null;
  const identityBound = verified && row.acceptor_bound && row.acceptor_consented
    && String(row.acceptor_user_id) !== String(row.creator_user_id)
    && (!row.invited_user_id || String(row.invited_user_id) === String(row.acceptor_user_id));
  return {
    id: row.id,
    terms_hash: row.terms_hash,
    claim: row.claim,
    criteria: row.criteria,
    evidence_source_url: row.evidence_source_url,
    creator_side: row.creator_side,
    stake_yocto: row.stake_yocto,
    accept_by: timestamp(row.accept_by),
    resolve_at: timestamp(row.resolve_at),
    created_at: timestamp(row.created_at),
    published_at: timestamp(row.published_at),
    creator_username: verified ? row.creator_username : null,
    creator_wallet: chain?.creator || null,
    acceptor_username: identityBound ? row.acceptor_username : null,
    acceptor_wallet: chain?.acceptor || null,
    snapshot_status: chain?.status || null,
    status: chain?.status || 'unverified',
    funded: verified,
    chain_verification: verified ? 'finalized_snapshot' : 'unverified',
    chain_freshness: !verified ? 'unverified' : age == null || age < 0 ? 'unknown' : age > STALE_AFTER_MS ? 'stale' : 'recent',
    last_verified_at: checked,
    verified_height: verified ? String(row.near_height) : null,
    outcome: chain?.status === 'settled' ? (chain.resolution?.outcome || chain.proposal?.outcome || null) : null,
    settled_by: chain?.status === 'settled' ? (chain.resolution?.method || 'agreement') : null,
    referee_wallet: chain?.referee || null,
    proposed_outcome: ['proposed', 'disputed'].includes(chain?.status) ? chain.proposal?.outcome || null : null,
    accepted_at: verified && chain.acceptor ? timestamp(row.accepted_at) : null,
    settled_at: chain?.status === 'settled' ? timestamp(row.settled_at) : null,
    follower_count: String(row.follower_count || '0'),
  };
}

// DESIGN.md: publication never grants access to another Bet's private evidence.
export async function evidenceForBet(tx, statementId, betId, viewerId = null) {
  const rows = await tx.many(`select e.*, u.x_username,
    b.creator_user_id as evidence_creator_id, b.acceptor_user_id as evidence_acceptor_id from bet_evidence e
    join users u on u.id=e.user_id join bilateral_bets b on b.id=e.bet_id
    where e.statement_id=$1 and (e.bet_id=$2
      or b.creator_user_id=$3 or b.acceptor_user_id=$3
      or exists (select 1 from bilateral_bet_publications p
        where p.bet_id=b.id and p.creator_user_id=b.creator_user_id and p.withdrawn_at is null))
    order by e.at, e.id`, [statementId, betId, viewerId]);
  // Both public projections and participant evidence pages use this reader. A
  // link from another Bet must not reveal more identity than that Bet publishes.
  const ids = [...new Set(rows.map(item => String(item.bet_id)))];
  const identities = new Map();
  if (ids.length) {
    for (const row of await tx.many(`${SELECT} where b.id = any($1::uuid[]) and p.withdrawn_at is null`, [ids])) {
      identities.set(String(row.id), { row, bet: view(row) });
    }
  }
  return rows.map(item => {
    if (viewerId != null && [item.evidence_creator_id, item.evidence_acceptor_id]
      .some(id => id != null && String(id) === String(viewerId))) return item;
    const identity = identities.get(String(item.bet_id));
    const username = !identity ? null : String(item.user_id) === String(identity.row.creator_user_id)
      ? identity.bet.creator_username : String(item.user_id) === String(identity.row.acceptor_user_id)
        ? identity.bet.acceptor_username : null;
    return { ...item, x_username: username };
  });
}

export async function readPublicBet(tx, id, { evidenceWindowSeconds = 86400, readRuling = readEnclaveRuling } = {}) {
  const row = await tx.one(`${SELECT} where b.id=$1 and p.withdrawn_at is null for share of b,p`, [id]);
  if (!row) return null;
  const bet = view(row);
  // DESIGN.md: only published Bets disclose the verified call and submitted links.
  // Full source text belongs in the signed JSON, never in this page projection.
  const record = await readRuling(tx, id);
  bet.enclave = record ? {
    mode: record.mode, outcome: record.outcome, agrees: record.agrees,
    models: record.verdicts.map(verdict => verdict.model), reason: record.verdicts[0].parsed.reason,
    verdicts: record.verdicts.map(({ parsed }) => ({ outcome: parsed.outcome, confidence: parsed.confidence })),
    source: record.evidence.kind, product: record.plan.parsed.product || null,
    itemCount: record.evidence.kind === 'submitted' ? record.evidence.items.length : 0,
    decidedAt: record.decidedAt, minConfidence: record.minConfidence,
  } : null;
  const post = await tx.one(`select s.statement_id, st.resolved_at, p.source, p.closes_at
    from bilateral_bets b join saves s on s.id=b.source_save_id
    join statements st on st.id=s.statement_id
    left join enclave_plans p on p.statement_id=s.statement_id where b.id=$1`, [id]);
  bet.result_recorded_at = timestamp(post?.resolved_at);
  const rows = post ? await evidenceForBet(tx, post.statement_id, id) : [];
  const submitted = record?.evidence.kind === 'submitted' ? record.evidence : null;
  const visibleIds = new Set(rows.map(item => String(item.id)));
  const privateItemCount = (submitted?.items || []).filter(item => !visibleIds.has(String(item.id))).length;
  // A juror's reason can quote evidence from a private Bet on the same post: then the page shows no reason.
  if (bet.enclave && privateItemCount) bet.enclave.reason = null;
  if (post?.source === 'evidence' || rows.length || submitted) {
    const closesAt = timestamp(post?.closes_at || submitted?.closesAt
      || new Date(new Date(bet.resolve_at).getTime() + evidenceWindowSeconds * 1000));
    bet.evidence = {
      closesAt,
      privateItemCount,
      open: Boolean(!record && bet.accepted_at && row.acceptor_user_id && closesAt
        && ['accepted', 'proposed', 'disputed'].includes(bet.status)
        && new Date(bet.accepted_at).getTime() <= new Date(row.read_at).getTime()
        && new Date(row.read_at).getTime() < new Date(closesAt).getTime()),
      items: rows.map(item => ({ side: item.side, url: item.final_url || item.url, postedUrl: item.url,
        title: item.title || '', by: item.x_username || null, at: timestamp(item.at) })),
    };
  }
  if (bet.settled_by !== 'referee' || !['yes', 'no'].includes(bet.outcome)) return bet;

  // This call resolves one Bet. A wallet withdrawal may combine credit from several Bets.
  const proof = await tx.one(`select detail->>'transactionHash' as hash from bilateral_bet_events
    where bet_id=$1 and actor_user_id=$2 and kind='referee_resolved'
      and detail->>'outcome'=$3 and detail->>'referee'=$4
    order by id desc limit 1`, [id, row.creator_user_id, bet.outcome, bet.referee_wallet]);
  const hash = proof?.hash;
  if (hash && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(hash) && baseDecode(hash).length === 32) {
    bet.settlement_transaction_hash = hash;
    const evidence = await readPublicResultEvidence(tx, bet);
    if (evidence) bet.result_evidence = evidence;
    // Settlement creates credit. Only a verified winner withdrawal proves payment.
    if (record?.mode === 'ruling') bet.payout_completed = Boolean(await tx.one(`select 1 from bilateral_near_requests r
      where r.bet_id=$1 and r.method='withdraw' and r.execution_status='succeeded'
        and r.transaction_hash is not null and r.execution_checked_at is not null
        and r.args->>'stated_request_id'=r.id::text and r.created_at >= $2
        and r.wallet_account=$3 and r.user_id=$4
        and exists (select 1 from bilateral_bet_events e where e.bet_id=r.bet_id
          and e.actor_user_id=$5 and e.kind='play_paid_out') limit 1`,
    [id, row.settled_at, bet.outcome === bet.creator_side ? bet.creator_wallet : bet.acceptor_wallet,
      bet.outcome === bet.creator_side ? row.creator_user_id : row.acceptor_user_id, row.creator_user_id]));
  }
  return bet;
}

export async function publicBet(db, id, options) {
  const ref = reference(id);
  return db.tx((tx) => readPublicBet(tx, ref, options));
}

export async function recentPublicBets(db, limit = 20) {
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new UserError('Choose a result count from 1 to 100.');
  return db.tx(async (tx) => {
    const rows = await tx.many(`${SELECT} where p.withdrawn_at is null
      order by p.published_at desc, b.id desc limit $1 for share of b,p`, [limit]);
    return rows.map(view);
  });
}

// Bet publication is independent of profile/save publication. Only consented
// identities survive view(), including when a bettor's profile stays private.
export async function publicBetsForProfile(db, username) {
  return db.tx(async tx => {
    const rows = await tx.many(`${SELECT} where p.withdrawn_at is null
      and (lower(creator.x_username)=lower($1) or lower(acceptor.x_username)=lower($1))
      order by b.accept_by, p.published_at desc`, [username]);
    return rows.map(view).filter(bet => bet.funded && [bet.creator_username, bet.acceptor_username]
      .some(name => name?.toLowerCase() === username.toLowerCase()));
  });
}

// DESIGN.md: the hall uses the same allowlisted projection as public Bet pages.
// Totals cover all current publications, and every counted Bet is listed. Credit
// is not paid: require the collector marker AND the winner's verified withdrawal.
export async function publicBetHall(db) {
  return db.tx(async (tx) => {
    const rows = await tx.many(`${SELECT} where p.withdrawn_at is null
      order by p.published_at desc, b.id desc`);
    const paid = await tx.many(`select distinct b.id from bilateral_bets b
      join bilateral_bet_publications p on p.bet_id=b.id and p.withdrawn_at is null
      join bilateral_near_requests r on r.bet_id=b.id and r.method='withdraw'
        and r.execution_status='succeeded' and r.transaction_hash is not null
        and r.execution_checked_at is not null
        and r.args->>'stated_request_id'=r.id::text
        and r.created_at>=b.settled_at
        and r.user_id=case when b.chain_state->'resolution'->>'outcome'=b.creator_side
          then b.creator_user_id else b.acceptor_user_id end
        and r.wallet_account=case when b.chain_state->'resolution'->>'outcome'=b.creator_side
          then b.creator_wallet else b.acceptor_wallet end
      where exists (select 1 from bilateral_bet_events e where e.bet_id=b.id
        and e.actor_user_id=b.creator_user_id and e.kind='play_paid_out')`);
    const paidIds = new Set(paid.map((row) => row.id));
    const bets = rows.filter((row) => snapshotVerified(row) && timestamp(row.near_verified_at))
      .map((row) => ({ ...view(row), payout_completed: paidIds.has(row.id) }));
    const settled = bets.filter((bet) => bet.status === 'settled');
    const paidYocto = settled.filter((bet) => bet.payout_completed
      && bet.settled_by === 'referee' && ['yes', 'no'].includes(bet.outcome))
      .reduce((sum, bet) => sum + BigInt(bet.stake_yocto) * 2n, 0n);
    // "Won" is the pot of every Bet settled yes or no; "paid" stays the stricter figure above.
    const wonYocto = settled.filter((bet) => ['yes', 'no'].includes(bet.outcome))
      .reduce((sum, bet) => sum + BigInt(bet.stake_yocto) * 2n, 0n);
    const shown = bets;
    // Open offers lead in closing order. Finished bets follow by settlement date.
    shown.sort((a, b) => {
      const openA = a.status === 'offered' && new Date(a.accept_by) > new Date(rows[0]?.read_at);
      const openB = b.status === 'offered' && new Date(b.accept_by) > new Date(rows[0]?.read_at);
      if (openA !== openB) return openA ? -1 : 1;
      return openA ? new Date(a.accept_by) - new Date(b.accept_by)
        : new Date(b.settled_at || b.published_at) - new Date(a.settled_at || a.published_at);
    });
    return { rows: shown, total: shown.length, settled: settled.length,
      paidYocto: paidYocto.toString(), wonYocto: wonYocto.toString() };
  });
}

export async function nextOpenPublicBet(db, viewerId = null) {
  return db.tx(async (tx) => {
    const rows = await tx.many(`${SELECT}
      where p.withdrawn_at is null and b.status='offered' and b.accept_by>clock_timestamp()
        and b.invited_user_id is null and b.invited_wallet is null
        and ($1::bigint is null or b.creator_user_id<>$1)
        and b.near_verified_at between clock_timestamp() - ($2::double precision * interval '1 millisecond') and clock_timestamp()
      order by b.accept_by, p.published_at desc, b.id desc limit 20 for share of b,p`, [viewerId, STALE_AFTER_MS]);
    return rows.map(view).find((bet) => bet.status === 'offered' && bet.funded
      && bet.chain_freshness === 'recent' && bet.creator_username) || null;
  });
}

// The caller must already authorize the source save. The returned projection
// contains only deliberately published Bet data, never the private relation.
export async function publicBetsForSave(db, saveId) {
  const id = idOf(saveId);
  return db.tx(async (tx) => {
    const rows = await tx.many(`${SELECT} where (b.source_save_id=$1 or (b.referee_wallet is not null and b.source_save_id in (
          select other.id from saves mine join saves other on other.statement_id = mine.statement_id where mine.id=$1))) and p.withdrawn_at is null
      order by (b.status='offered' and b.accept_by>clock_timestamp()) desc, p.published_at desc
      limit 10 for share of b,p`, [id]);
    return rows.map(view);
  });
}

// List pages already authorize each source save. Batch their first published
// Bet in one read instead of opening a transaction per prediction row.
export async function firstPublicBetsForSaves(db, saveIds) {
  if (!Array.isArray(saveIds) || saveIds.length > 24) throw new UserError('Choose at most 24 predictions.');
  const ids = [...new Set(saveIds.map(idOf))];
  if (!ids.length) return new Map();
  return db.tx(async (tx) => {
    const rows = await tx.many(`select selected.save_id, picked.*
      from unnest($1::bigint[]) as selected(save_id)
      cross join lateral (${SELECT}
        where (b.source_save_id=selected.save_id or (b.referee_wallet is not null and b.source_save_id in (
          select other.id from saves mine join saves other on other.statement_id = mine.statement_id where mine.id=selected.save_id))) and p.withdrawn_at is null
        order by (b.status='offered' and b.accept_by>clock_timestamp()) desc, p.published_at desc, b.id desc
        limit 1 for share of b,p) picked`, [ids]);
    return new Map(rows.map(row => [String(row.save_id), view(row)]));
  });
}

// Calling this function represents explicit consent to the immutable Bet terms
// and creator identity. The POST handler must require that consent and CSRF.
export async function publishBet(db, user, id) {
  const ref = reference(id);
  return db.tx(async (tx) => {
    const owner = await actor(tx, user, { setup: true });
    const bet = await tx.one(`select b.*,
      exists (select 1 from bilateral_near_requests r where r.bet_id=b.id
        and r.method='create_bet' and r.user_id=b.creator_user_id
        and r.wallet_account=b.chain_state->>'creator'
        and r.binding_hash=b.chain_state->>'creator_binding_hash') as creator_bound
      from bilateral_bets b where b.id=$1 for update of b`, [ref]);
    if (!bet || String(bet.creator_user_id) !== owner) throw new UserError('Only the creator can publish this bet.', 404);
    if (!snapshotVerified(bet) || !timestamp(bet.near_verified_at)) {
      throw new UserError('Verify the finalized creator deposit before publishing this bet.', 409);
    }
    await tx.query(`insert into bilateral_bet_publications (bet_id,creator_user_id,published_at)
      values ($1,$2,clock_timestamp()) on conflict (bet_id) do update
      set withdrawn_at=null, published_at=case when bilateral_bet_publications.withdrawn_at is null
        then bilateral_bet_publications.published_at else excluded.published_at end`, [ref, owner]);
    return readPublicBet(tx, ref);
  });
}

// The note a post's shared Result carries while any Bet on it is private (schema.sql uses the same words).
const PRIVATE_RESULT_NOTE = 'Result recorded. Bet evidence stays on its Bet page.';

export async function withdrawBetPublication(db, user, id) {
  const ref = reference(id);
  return db.tx(async (tx) => {
    const owner = await actor(tx, user);
    // The post's shared Result changes below, so its statement is locked before the Bet, as finalizing does.
    const post = await tx.one('select s.statement_id from bilateral_bets b join saves s on s.id=b.source_save_id where b.id=$1', [ref]);
    if (post) await tx.query('select id from statements where id=$1 for update', [post.statement_id]);
    const bet = await tx.one('select creator_user_id from bilateral_bets where id=$1 for update', [ref]);
    if (!bet || String(bet.creator_user_id) !== owner) throw new UserError('Only the creator can withdraw this publication.', 404);
    await tx.query(`update bilateral_bet_publications set withdrawn_at=coalesce(withdrawn_at,clock_timestamp())
      where bet_id=$1 and creator_user_id=$2`, [ref, owner]);
    // Every public save of this post shows its Result fields; once this Bet is private they may not carry its evidence.
    if (post) await tx.query(`update statements set resolution_url=null, resolution_note=$2
      where id=$1 and (resolution_url is not null or resolution_note is not null)`, [post.statement_id, PRIVATE_RESULT_NOTE]);
    return { id: ref, published: false };
  });
}

export async function followPublicBet(db, user, id) {
  const ref = reference(id);
  return db.tx(async (tx) => {
    const follower = await actor(tx, user);
    const bet = await readPublicBet(tx, ref);
    if (!bet) throw new UserError('This public bet is unavailable.', 404);
    await tx.query(`insert into bilateral_bet_follows (bet_id,user_id) values ($1,$2)
      on conflict (bet_id,user_id) do nothing`, [ref, follower]);
    return { id: ref, following: true };
  });
}

// A pending join can consent before its wallet transaction completes. Public
// reads reveal a handle only if finalized acceptance binds this exact user.
export async function consentToPublicBet(db, user, id) {
  const ref = reference(id);
  return db.tx(async (tx) => {
    const joiner = await actor(tx, user, { setup: true });
    const row = await tx.one(`${SELECT} where b.id=$1 and p.withdrawn_at is null for share of b,p`, [ref]);
    if (!row) throw new UserError('This public bet is unavailable.', 404);
    const pending = snapshotVerified(row) && row.chain_state.status === 'offered'
      && new Date(row.accept_by).getTime() > new Date(row.read_at).getTime()
      && (!row.invited_user_id || String(row.invited_user_id) === joiner);
    const accepted = row.acceptor_bound && String(row.acceptor_user_id) === joiner && snapshotVerified(row);
    if (String(row.creator_user_id) === joiner || (!pending && !accepted)) {
      throw new UserError('Only an eligible joining participant can publish their X identity.', 403);
    }
    await tx.query(`insert into bilateral_bet_public_consents (bet_id,user_id) values ($1,$2)
      on conflict (bet_id,user_id) do nothing`, [ref, joiner]);
    return { id: ref, consented: true };
  });
}

export async function followsFor(db, user) {
  return db.tx(async (tx) => {
    const follower = await actor(tx, user);
    const rows = await tx.many(`${SELECT} join bilateral_bet_follows follow
      on follow.bet_id=b.id and follow.user_id=$1 where p.withdrawn_at is null
      order by follow.created_at desc, b.id desc limit 100 for share of b,p`, [follower]);
    return rows.map(view);
  });
}
