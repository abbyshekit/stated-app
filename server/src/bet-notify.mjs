// INTEGRATION: Call in the locked bet's transaction after persisting a verified
// chain snapshot. Pass bet-shaped before/after rows and the chain fingerprint.
const MESSAGES = Object.freeze({
  offered: 'The creator deposited the stake for this bet.',
  accepted: 'Both participants deposited their stakes for this bet.',
  proposed: 'A result was proposed for this bet. It has not been agreed.',
  disputed: 'The proposed result for this bet was disputed.',
  settled: 'Both participants agreed on a result. The resulting funds are credited for withdrawal.',
  cancelled: 'This bet was cancelled. The creator’s stake is credited for withdrawal; the storage fee is separate and is not refunded.',
  expired: 'This bet expired. The creator’s stake is credited for withdrawal; the storage fee is separate and is not refunded.',
  refunded: 'This bet was refunded. The stakes are credited for withdrawal; the creator’s storage fee is separate and is not refunded.',
});

// Version 2 records how a Bet was settled. A referee's ruling and an unanswered result are not agreements.
const SETTLED_BY = Object.freeze({
  referee: 'The result is in and this bet is settled. The stakes went to the winner.',
  unanswered: 'The proposed result went unanswered for two days and now stands. The stakes went to the winner.',
});

export async function notifyBetChange(tx, { before, after, eventKey }) {
  if (!after?.id || !after.creator_user_id || !/^[a-f0-9]{64}$/.test(eventKey || '')
    || (before && String(before.id) !== String(after.id))) {
    throw new TypeError('A bet and its verified chain fingerprint are required.');
  }
  const state = after.chain_state;
  const status = state?.status;
  if (!Object.hasOwn(MESSAGES, status)) throw new TypeError('Unsupported verified bet status.');
  const prior = before?.chain_state;
  const changed = prior?.status !== status || (status === 'proposed'
    && String(prior?.proposal?.revision ?? '') !== String(state.proposal?.revision ?? ''));
  if (!changed) return;

  // Publication changes lock the same bet row, so this observes the publication
  // state at the serialized transition. Followers need no wallet or setup.
  await tx.query(`insert into inbox (owner_x_user_id, kind, bet_id, body, dedupe_key)
    select u.x_user_id, 'bet_update', $1::uuid, $5::text, 'bet:' || $1::text || ':' || $4::text || ':' || u.id::text
    from users u
    where u.kind='person' and u.x_user_id <> ''
      and not exists (select 1 from bot_credentials bot where bot.x_user_id=u.x_user_id)
      and (u.id=$2::bigint or u.id=$3::bigint or exists (
        select 1 from bilateral_bet_follows f
        join bilateral_bet_publications p on p.bet_id=f.bet_id and p.withdrawn_at is null
        where f.bet_id=$1::uuid and f.user_id=u.id
      ))
    on conflict (dedupe_key) do nothing`,
  [after.id, after.creator_user_id, after.acceptor_user_id || null, eventKey,
    status === 'settled' ? (SETTLED_BY[state.resolution?.method] || MESSAGES.settled) : MESSAGES[status]]);
}
