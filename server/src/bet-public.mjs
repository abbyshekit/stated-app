// INTEGRATION: Explicit Bet publication is independent of profile/save visibility.
// near-bets.mjs must set near_verified_at after finalized synchronization. Reads
// expose stored snapshots only; handlers must sync again before any deposit.
import { baseDecode } from 'near-api-js';
import { accountPattern, isAccount } from './near-network.mjs';
import { idOf, UserError } from './store.mjs';
import { readPublicResultEvidence } from './bet-result-evidence.mjs';
import { readEnclaveRuling } from './enclave-ruling.mjs';
import { readOutlayerRuling, outlayerEvidenceForBet } from './outlayer.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HASH = /^[a-f0-9]{64}$/;
const STATUSES = new Set(['offered', 'accepted', 'proposed', 'disputed', 'settled', 'cancelled', 'expired', 'refunded']);
const OUTCOMES = new Set(['yes', 'no', 'void']);
const STALE_AFTER_MS = 5 * 60 * 1000;
const HALL_PAGE_SIZE = 40;
const PROFILE_BET_PAGE_SIZE = 24;
const CREATOR_BOUND = `exists (select 1 from bilateral_near_requests r
    where r.bet_id=b.id and r.method='create_bet' and r.user_id=b.creator_user_id
      and r.wallet_account=b.chain_state->>'creator'
      and r.binding_hash=b.chain_state->>'creator_binding_hash')`;
const ACCEPTOR_BOUND = `exists (select 1 from bilateral_near_requests r
    where r.bet_id=b.id and r.method='accept_bet' and r.user_id=b.acceptor_user_id
      and r.wallet_account=b.chain_state->>'acceptor'
      and r.binding_hash=b.chain_state->>'acceptor_binding_hash')`;
const ACCEPTOR_CONSENTED = `exists (select 1 from bilateral_bet_public_consents c
    where c.bet_id=b.id and c.user_id=b.acceptor_user_id)`;
const PUBLICATION = `from bilateral_bets b
  join bilateral_bet_publications p on p.bet_id=b.id and p.creator_user_id=b.creator_user_id`;
const USERS = `join users creator on creator.id=b.creator_user_id
  left join users acceptor on acceptor.id=b.acceptor_user_id`;

// The base projection excludes source content, annotations and proposal notes.
const COLUMNS = `b.id, b.creator_user_id, b.acceptor_user_id, b.invited_user_id,
  b.claim, b.criteria, b.evidence_source_url, b.creator_side, b.stake_yocto,
  b.accept_by, b.resolve_at, b.created_at, b.accepted_at, b.settled_at,
  b.creator_wallet, b.acceptor_wallet, b.invited_wallet, b.terms_hash, b.referee_wallet,
  case when octet_length(b.chain_state::text)<=16384 then b.chain_state else null end as chain_state,
  b.near_height, b.near_verified_at, b.outlayer_material is not null as outlayer_bound,
  case when octet_length((b.outlayer_material->'evidence')::text)<=16384
    then b.outlayer_material->'evidence' else null end as outlayer_evidence,
  p.published_at, creator.x_username as creator_username,
  acceptor.x_username as acceptor_username, clock_timestamp() as read_at,
  ${CREATOR_BOUND} as creator_bound, ${ACCEPTOR_BOUND} as acceptor_bound,
  ${ACCEPTOR_CONSENTED} as acceptor_consented,
  (select count(*)::text from bilateral_bet_follows f where f.bet_id=b.id) as follower_count`;
const SELECT = `select ${COLUMNS} ${PUBLICATION} ${USERS}`;

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
    outlayer_bound: Boolean(row.outlayer_bound),
    outlayer_evidence: row.outlayer_evidence || null,
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
export async function evidenceForBet(tx, statementId, betId, viewerId = null, { after = null, page = false } = {}) {
  if (after !== null) idOf(after, { message: 'That evidence reference is invalid.' });
  const rows = await tx.many(`select ${page ? 'e.id,e.bet_id,e.user_id,e.side,e.url,e.final_url,e.title,e.at' : 'e.*'}, u.x_username,
    b.creator_user_id as evidence_creator_id, b.acceptor_user_id as evidence_acceptor_id from bet_evidence e
    join users u on u.id=e.user_id join bilateral_bets b on b.id=e.bet_id
    where e.statement_id=$1 and (e.bet_id=$2
      or b.creator_user_id=$3 or b.acceptor_user_id=$3
      or exists (select 1 from bilateral_bet_publications p
        where p.bet_id=b.id and p.creator_user_id=b.creator_user_id and p.withdrawn_at is null))
    ${page ? 'and ($4::bigint is null or e.id > $4::bigint) order by e.id limit 51' : 'order by e.at, e.id'}`,
  page ? [statementId, betId, viewerId, after] : [statementId, betId, viewerId]);
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

export async function readPublicBet(tx, id, { evidenceWindowSeconds = 86400, readRuling = readEnclaveRuling, evidenceAfter = null } = {}) {
  const row = await tx.one(`${SELECT} where b.id=$1 and p.withdrawn_at is null for share of b,p`, [id]);
  if (!row) return null;
  const bet = view(row);
  if (bet.outlayer_bound) bet.outlayer = await readOutlayerRuling(tx, id);
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
  if (bet.outlayer?.material.evidence.kind === 'open') {
    const spec = bet.outlayer.material.evidence;
    const closesAt = new Date(Date.parse(bet.resolve_at) + spec.window_seconds * 1000).toISOString();
    const submittedLinks = await outlayerEvidenceForBet(tx, id);
    bet.evidence = { closesAt, privateItemCount: 0,
      items: submittedLinks.map(item => ({ side: item.side, url: item.url, title: '', by: null, at: timestamp(item.at) })),
      open: Boolean(!bet.outlayer.result && bet.accepted_at && row.acceptor_user_id
        && ['accepted','proposed','disputed'].includes(bet.status)
        && Date.parse(bet.resolve_at) <= new Date(row.read_at).getTime() && new Date(row.read_at).getTime() < Date.parse(closesAt)) };
  }
  const allRows = post ? await evidenceForBet(tx, post.statement_id, id, null, { after: evidenceAfter, page: true }) : [];
  const rows = allRows.slice(0, 50);
  const submitted = record?.evidence.kind === 'submitted' ? record.evidence : null;
  let visibleIds = new Set(rows.map(item => String(item.id)));
  // Page boundaries never turn another public link into a private one.
  if (submitted?.items.length && (evidenceAfter || allRows.length > 50)) {
    const ids = submitted.items.slice(0, 1000).map(item => idOf(item.id));
    const visible = await tx.many(`select e.id from bet_evidence e join bilateral_bets b on b.id=e.bet_id
      where e.statement_id=$1 and e.id=any($3::bigint[]) and (e.bet_id=$2
        or exists (select 1 from bilateral_bet_publications p where p.bet_id=b.id
          and p.creator_user_id=b.creator_user_id and p.withdrawn_at is null)) limit 1000`, [post.statement_id, id, ids]);
    visibleIds = new Set(visible.map(item => String(item.id)));
  }
  const privateItemCount = (submitted?.items || []).filter(item => !visibleIds.has(String(item.id))).length;
  // A juror's reason can quote evidence from a private Bet on the same post: then the page shows no reason.
  if (bet.enclave && privateItemCount) bet.enclave.reason = null;
  if (!bet.outlayer && (post?.source === 'evidence' || rows.length || submitted)) {
    const closesAt = timestamp(post?.closes_at || submitted?.closesAt
      || new Date(new Date(bet.resolve_at).getTime() + evidenceWindowSeconds * 1000));
    bet.evidence = {
      closesAt,
      privateItemCount,
      next: allRows.length > 50 ? rows.at(-1).id : null,
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
  const proof = await settlementProof(tx, row, bet);
  if (proof) {
    bet.settlement_transaction_hash = proof.hash;
    bet.settlement_transaction_attribution = proof.attribution || null;
    const evidence = await readPublicResultEvidence(tx, bet);
    if (evidence) bet.result_evidence = evidence;
  }
  // Settlement creates credit. A verified winner withdrawal proves payment
  // independently of whether this server sent the permissionless ruling request.
  if (record?.mode === 'ruling' || bet.outlayer?.result) bet.payout_completed = Boolean(await tx.one(`select 1 from bilateral_near_requests r
      where r.bet_id=$1 and r.method='withdraw' and r.execution_status='succeeded'
        and r.transaction_hash is not null and r.execution_checked_at is not null
        and r.args->>'stated_request_id'=r.id::text and r.created_at >= $2
        and r.wallet_account=$3 and r.user_id=$4
        and exists (select 1 from bilateral_bet_events e where e.bet_id=r.bet_id
          and e.actor_user_id=$5 and e.kind='play_paid_out') limit 1`,
    [id, row.settled_at, bet.outcome === bet.creator_side ? bet.creator_wallet : bet.acceptor_wallet,
      bet.outcome === bet.creator_side ? row.creator_user_id : row.acceptor_user_id, row.creator_user_id]));
  return bet;
}

async function settlementProof(tx, row, bet) {
  const proof = await tx.one(`select detail->>'transactionHash' as hash, detail->>'transactionAttribution' as attribution from bilateral_bet_events
    where bet_id=$1 and actor_user_id=$2 and kind='referee_resolved'
      and detail->>'outcome'=$3 and detail->>'referee'=$4
    order by id desc limit 1`, [bet.id, row.creator_user_id, bet.outcome, bet.referee_wallet]);
  return proof?.hash && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(proof.hash) && baseDecode(proof.hash).length === 32 ? proof : null;
}

export async function publicBetForShare(db, id) {
  const ref = reference(id);
  return db.tx(async tx => {
    const row = await tx.one(`select ${COLUMNS}, b.source_save_id ${PUBLICATION} ${USERS}
      where b.id=$1 and p.withdrawn_at is null for share of b,p`, [ref]);
    if (!row) return null;
    const bet = view(row);
    const settled = bet.settled_by === 'referee' && ['yes', 'no'].includes(bet.outcome);
    return { ...bet, sourceSaveId: row.source_save_id,
      settlementVerified: settled && Boolean(await settlementProof(tx, row, bet)) };
  });
}

export async function publicBet(db, id, options) {
  const ref = reference(id);
  return db.tx((tx) => readPublicBet(tx, ref, options));
}

// Keep the SQL screen used by public lists and totals in step with snapshotVerified.
// Bound rows before evaluating projection-only joins and follower counts.
const STATE = `b.chain_state->>'status'`;
const SETTLED_OUTCOME = `coalesce(b.chain_state->'resolution'->>'outcome', b.chain_state->'proposal'->>'outcome')`;
const OPEN = `(${STATE}='offered' and b.accept_by > statement_timestamp())`;
const HALL_TIME = `(case when ${OPEN} then -extract(epoch from b.accept_by) else extract(epoch from coalesce(b.settled_at,p.published_at)) end)`;
const VERIFIED = `b.near_verified_at is not null and b.near_height > 0
  and octet_length(b.chain_state::text)<=16384
  and jsonb_typeof(b.chain_state->'creator')='string' and jsonb_typeof(b.chain_state->'stake_yocto')='string'
  and jsonb_typeof(b.chain_state->'id')='string' and jsonb_typeof(b.chain_state->'creator_side')='string'
  and jsonb_typeof(b.chain_state->'creator_binding_hash')='string'
  and jsonb_typeof(b.chain_state->'terms_hash')='string' and jsonb_typeof(b.chain_state->'accept_by_ns')='string'
  and jsonb_typeof(b.chain_state->'resolve_at_ns')='string'
  and jsonb_typeof(b.chain_state)='object' and ${STATE} in ('offered','accepted','proposed','disputed','settled','cancelled','expired','refunded')
  and b.chain_state->>'creator' ~ $1 and length(b.chain_state->>'creator')<=64
  and b.chain_state->>'creator_binding_hash' ~ '^[a-f0-9]{64}$' and ${CREATOR_BOUND}
  and b.chain_state->>'creator'=b.creator_wallet and b.chain_state->>'id'=b.id::text
  and b.chain_state->>'terms_hash'=b.terms_hash and b.chain_state->>'stake_yocto'=b.stake_yocto
  and b.chain_state->>'creator_side'=b.creator_side
  and b.chain_state->>'accept_by_ns'=(floor(extract(epoch from b.accept_by)*1000)*1000000)::text
  and b.chain_state->>'resolve_at_ns'=(floor(extract(epoch from b.resolve_at)*1000)*1000000)::text
  and nullif(b.chain_state->>'invited_account','') is not distinct from nullif(b.invited_wallet,'')
  and nullif(b.chain_state->>'referee','') is not distinct from nullif(b.referee_wallet,'')
  and (case when coalesce(b.chain_state->>'acceptor','')='' then ${STATE} in ('offered','cancelled','expired')
    else jsonb_typeof(b.chain_state->'acceptor')='string' and b.chain_state->>'acceptor' ~ $1 and length(b.chain_state->>'acceptor')<=64
      and jsonb_typeof(b.chain_state->'acceptor_binding_hash')='string'
      and b.chain_state->>'acceptor_binding_hash' ~ '^[a-f0-9]{64}$'
      and b.chain_state->>'acceptor'=b.acceptor_wallet and b.chain_state->>'acceptor'<>b.creator_wallet
      and (coalesce(b.invited_wallet,'')='' or b.chain_state->>'acceptor'=b.invited_wallet) end)
  and (${STATE}<>'proposed' or jsonb_typeof(b.chain_state->'proposal')='object')
  and (${STATE}<>'settled' or jsonb_typeof(b.chain_state->'proposal')='object' or jsonb_typeof(b.chain_state->'resolution')='object')
  and (b.chain_state->>'resolution' is null or (b.chain_state->'resolution'->>'outcome' in ('yes','no','void')
    and b.chain_state->'resolution'->>'method' in ('agreement','unanswered','referee')))
  and (b.chain_state->>'proposal' is null or (b.chain_state->'proposal'->>'outcome' in ('yes','no','void')
    and jsonb_typeof(b.chain_state->'proposal'->'proposer')='string'
    and b.chain_state->'proposal'->>'proposer' in (b.chain_state->>'creator',b.chain_state->>'acceptor')
    and case when jsonb_typeof(b.chain_state->'proposal'->'revision')='number'
      then (b.chain_state->'proposal'->>'revision')::numeric between 1 and 9007199254740991
        and (b.chain_state->'proposal'->>'revision')::numeric=trunc((b.chain_state->'proposal'->>'revision')::numeric)
      when b.chain_state->'proposal'->>'revision' ~ '^[0-9]{1,20}$'
      then (b.chain_state->'proposal'->>'revision')::numeric between 1 and 18446744073709551615
      else false end))`;

const PAID = `exists (select 1 from bilateral_near_requests r where r.bet_id=b.id and r.method='withdraw'
  and r.execution_status='succeeded' and r.transaction_hash is not null and r.execution_checked_at is not null
  and r.args->>'stated_request_id'=r.id::text and r.created_at>=b.settled_at
  and r.user_id=case when ${SETTLED_OUTCOME}=b.creator_side then b.creator_user_id else b.acceptor_user_id end
  and r.wallet_account=case when ${SETTLED_OUTCOME}=b.creator_side then b.creator_wallet else b.acceptor_wallet end
  and exists (select 1 from bilateral_bet_events e where e.bet_id=b.id
    and e.actor_user_id=b.creator_user_id and e.kind='play_paid_out'))`;

function readCursor(value, pattern) {
  if (value == null) return [];
  const parsed = typeof value === 'string' && pattern.exec(value);
  if (!parsed || !UUID.test(parsed.at(-1))) throw new UserError('That page reference is invalid.');
  return parsed.slice(1);
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
export async function publicBetsForProfile(db, username, { before } = {}) {
  const [deadline = null, publication = null, id = null] = readCursor(before,
    /^(-?\d{1,15}(?:\.\d{1,6})?):(-?\d{1,15}(?:\.\d{1,6})?):([a-f0-9-]{36})$/i);
  const sort = `(extract(epoch from b.accept_by), -extract(epoch from p.published_at), b.id)`;
  return db.tx(async tx => {
    const rows = await tx.many(`select ${COLUMNS}, extract(epoch from b.accept_by)::text as profile_deadline,
      (-extract(epoch from p.published_at))::text as profile_publication ${PUBLICATION} ${USERS} where p.withdrawn_at is null
      and (lower(creator.x_username)=lower($2) or (lower(acceptor.x_username)=lower($2)
        and b.creator_user_id<>b.acceptor_user_id and (b.invited_user_id is null or b.invited_user_id=b.acceptor_user_id)
        and ${ACCEPTOR_BOUND} and ${ACCEPTOR_CONSENTED}))
      and ${VERIFIED} and ($3::numeric is null or ${sort} > ($3::numeric,$4::numeric,$5::uuid))
      order by extract(epoch from b.accept_by), -extract(epoch from p.published_at), b.id limit $6`,
    [accountPattern(), username, deadline, publication, id, PROFILE_BET_PAGE_SIZE + 1]);
    const page = rows.slice(0, PROFILE_BET_PAGE_SIZE);
    const last = page.at(-1);
    return { rows: page.map(view).filter(bet => bet.funded && [bet.creator_username, bet.acceptor_username]
      .some(name => name?.toLowerCase() === username.toLowerCase())),
    next: rows.length > PROFILE_BET_PAGE_SIZE
      ? `${last.profile_deadline}:${last.profile_publication}:${last.id}` : null };
  });
}

// A feature or Court entry only needs a recent Bet that has a stored ruling.
// Select candidate IDs before loading any ruling, and reauthorize each load.
export async function publicRulingCandidates(db, { referee = null, limit = 8, before } = {}) {
  const [time = null, id = null] = readCursor(before, /^(-?\d{1,15}(?:\.\d{1,6})?):([a-f0-9-]{36})$/i);
  const sort = `extract(epoch from coalesce(b.settled_at,p.published_at))`;
  const rows = await db.many(`select b.id, ${sort}::text as ruling_time ${PUBLICATION}
    where p.withdrawn_at is null and ${VERIFIED}
      and ($2::text is null or b.referee_wallet=$2) and ($2::text is not null or (${STATE}='settled' and ${SETTLED_OUTCOME} in ('yes','no')))
      and exists (select 1 from bilateral_bet_events e where e.bet_id=b.id
        and (e.kind='outlayer_ruling' or ($2::text is null and e.kind='enclave_ruling')))
      and ($3::numeric is null or (${sort},b.id) < ($3::numeric,$4::uuid))
    order by ${sort} desc,b.id desc limit $5`, [accountPattern(), referee, time, id, limit + 1]);
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return { rows: page, next: rows.length > limit ? `${last.ruling_time}:${last.id}` : null };
}

// DESIGN.md: the hall uses the same allowlisted projection as public Bet pages.
// Only the page projection leaves PostgreSQL; the totals include every current
// verified publication. Keyset pagination keeps deep pages the same size.
export async function publicBetHall(db, { before } = {}) {
  const [open = null, time = null, id = null] = readCursor(before, /^(0|1):(-?\d{1,15}(?:\.\d{1,6})?):([a-f0-9-]{36})$/i);
  return db.tx(async (tx) => {
    const stats = await tx.one(`select count(*)::text as total,
      (count(*) filter (where ${STATE}='settled'))::text as settled,
      coalesce(sum(b.stake_yocto::numeric*2) filter (where ${STATE}='settled' and ${SETTLED_OUTCOME} in ('yes','no')), 0)::text as won,
      coalesce(sum(b.stake_yocto::numeric*2) filter (where ${STATE}='settled' and ${SETTLED_OUTCOME} in ('yes','no')
        and b.chain_state->'resolution'->>'method'='referee' and ${PAID}), 0)::text as paid,
      coalesce(bool_or(${OPEN}), false) as has_open ${PUBLICATION} where p.withdrawn_at is null and ${VERIFIED}`, [accountPattern()]);
    const rows = await tx.many(`select ${COLUMNS}, ${PAID} as payout_completed, ${OPEN}::int as hall_open, ${HALL_TIME}::text as hall_rank
      ${PUBLICATION} ${USERS} where p.withdrawn_at is null and ${VERIFIED}
      and ($2::int is null or (${OPEN}::int,${HALL_TIME},b.id) < ($2::int,$3::numeric,$4::uuid))
      order by ${OPEN} desc, ${HALL_TIME} desc, b.id desc limit $5`,
    [accountPattern(), open, time, id, HALL_PAGE_SIZE + 1]);
    const page = rows.slice(0, HALL_PAGE_SIZE);
    const last = page.at(-1);
    return { rows: page.map(row => ({ ...view(row), payout_completed: row.payout_completed })), total: Number(stats.total),
      settled: Number(stats.settled), paidYocto: stats.paid, wonYocto: stats.won, hasOpen: stats.has_open,
      next: rows.length > HALL_PAGE_SIZE ? `${last.hall_open}:${last.hall_rank}:${last.id}` : null };
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
