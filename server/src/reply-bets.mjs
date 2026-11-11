// Bets made from a reply on X. "@bot bet 0.5 no" under a post offers a Bet on
// it; "@bot take" under the offer takes the other side. Both are funded from
// the person's play account (play.mjs) and settled by the referee from
// Stated's recorded Result. A reply is queued here by the mention intake and
// carried out by the play worker, because each step waits for NEAR finality.
//
// Every public reply is a fixed template. Nothing a person typed is echoed.
import { createHash } from 'node:crypto';
import { createBet } from './bets.mjs';
import { consentToPublicBet, publishBet } from './bet-public.mjs';
import { dayMonth } from './marked.mjs';
import { formatTestNear } from './near-escrow.mjs';
import { network, networkName, unit } from './near-network.mjs';
import { fundingOn, refreshOpenDeposits } from './funding.mjs';
import { intentsQuotes } from './intents.mjs';
import { syncNearBet } from './near-bets.mjs';
import { verifyBetTransaction } from './near-execution-state.mjs';
import { ensurePlayAccount, inPilot, nearChain, playAccountFor, playAction, referee, refereeSettle, refillTreasury, topUpReferee } from './play.mjs';
import { completeSetup, signInFromX, UserError, userByXId } from './store.mjs';

const DAY = 86400000;
const STAKE = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/;

/**
 * A command is the whole of what the person typed, apart from handles. A
 * sentence that merely contains "bet no" ("I bet no one saw this coming") is a
 * claim, never a command.
 */
export function parseBetCommand(text, { defaultStake = '0.1' } = {}) {
  const typed = String(text || '').replace(/@\w{1,15}/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase().replace(/[.!]+$/, '');
  if (/^(?:take|take it|i take|i'll take it|i’ll take it|take the other side)$/.test(typed)) return { kind: 'take' };
  const m = typed.match(/^bet(?: ([0-9.]+))?(?: (?:test )?near)? (yes|no)$/) || typed.match(/^bet (yes|no)(?: ([0-9.]+))?(?: (?:test )?near)?$/);
  if (!m) return null;
  const [amount, side] = /^(yes|no)$/.test(m[1] || '') ? [m[2], m[1]] : [m[1], m[2]];
  const stake = amount || defaultStake;
  if (!STAKE.test(stake) || Number(stake) <= 0 || Number(stake) > 1) return { kind: 'bet', side, error: 'stake' };
  return { kind: 'bet', side, stake };
}

export async function queueBetCommand(tx, { eventId, xUserId, username, command, saveId = null, targetRef = null, words = null, exclude = [] }) {
  await tx.query(`insert into bet_commands (event_id, x_user_id, x_username, kind, side, stake_near, save_id, target_ref, words, exclude)
    values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) on conflict (event_id) do nothing`,
  [eventId, String(xUserId), username || null, command.kind, command.side || null, command.stake || null, saveId, targetRef,
    words ? String(words).slice(0, 1000) : null, exclude]);
}

// A stable request id per reply, so a retried command can never create a second Bet.
function requestIdFor(eventId) {
  const h = createHash('sha256').update(`stated-reply-bet:${eventId}`).digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-5${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
}

// Built when asked for, so the unit is the one for the network this server is on.
const refusals = ({ walletUrl = null } = {}) => ({
  stake: `A bet here is between 0.01 and 1 ${unit()}. Try again with an amount in that range.`,
  no_date: 'That post gives no date to settle on, so there is nothing to bet on yet.',
  too_soon: 'That post is due too soon to take a bet on.',
  too_far: 'That post is dated more than a year out. Bets here settle within a year.',
  resolved: 'That one already has a result.',
  no_offer: 'There is no open bet here to take.',
  own: 'That is your own bet. Someone else has to take the other side.',
  taken: 'Someone took that bet first, or it has closed.',
  // With real NEAR the stake is the person's own money, so the answer says where to add it.
  funds: network().real
    ? `Your account does not hold enough NEAR for that stake yet.${walletUrl ? ` Add some from any chain: ${walletUrl}` : ''}`
    : `That is more ${unit()} than this account has left.`,
  claimed: 'You claimed your account, so place this one from the site with your own wallet.',
  pilot: 'Bets with real NEAR are invite-only for now.',
});

export const betReplies = {
  offer: ({ stake, side, date, bot, url }) => `${stake} ${unit()} says this ${side === 'yes' ? 'happens' : 'does not happen'} by ${date}. `
    + `To take the other side, reply here with "@${bot} take".${url ? ` ${url}` : ''}`,
  match: ({ pot, date, creator, creatorSide, taker, url }) => `It’s on. ${pot} ${unit()} is held on ${networkName()} until ${date}. `
    + `@${creator} says ${creatorSide}; @${taker} says ${creatorSide === 'yes' ? 'no' : 'yes'}.${url ? ` ${url}` : ''}`,
  result: ({ outcome, winner, loser, pot, url }) => (outcome === 'void'
    ? 'No clear result on this one. Both stakes are returned.'
    : `${outcome === 'yes' ? 'It happened.' : 'It did not happen.'} @${winner} wins the ${pot} ${unit()} pot.`) + (url ? ` ${url}` : ''),
  refused: (reason, options) => refusals(options)[reason] || null,
};

// A reply goes under the post of someone who summoned the bot. Anyone else in
// the thread, above all the author of the post being bet on, is left out of
// the automatic mentions: they did not ask to hear from the bot.
async function say(db, config, { key, inReplyTo, body, betId = null }) {
  if (!body) return;
  const origin = await db.one('select exclude, x_user_id from bet_commands where event_id = $1', [inReplyTo]);
  // Each reply is a paid post. One person's commands get at most the hourly number of replies that
  // ordinary tags do; past that the reply is kept as held, and the Bet itself is unaffected.
  let status = config.x.repliesEnabled ? 'pending' : 'held';
  if (status === 'pending' && origin) {
    const recent = await db.one(`select count(*)::int as n from bot_outbox o join bet_commands c on c.event_id = o.in_reply_to
      where c.x_user_id = $1 and o.status in ('pending', 'sending', 'sent') and o.created_at > clock_timestamp() - interval '1 hour'`, [origin.x_user_id]);
    if (recent.n >= config.x.repliesPerTaggerPerHour) status = 'held';
  }
  // And a ceiling across everyone, so a flood of commands cannot run up the X bill.
  if (status === 'pending') {
    const today = await db.one(`select count(*)::int as n from bot_outbox where status in ('pending', 'sending', 'sent')
      and created_at > clock_timestamp() - interval '24 hours'`);
    if (today.n >= config.play.repliesPerDay) status = 'held';
  }
  await db.query(`insert into bot_outbox (dedupe_key, in_reply_to, body, bet_id, status, exclude) values ($1,$2,$3,$4,$5,$6)
    on conflict (dedupe_key) do nothing`, [key, inReplyTo, body, betId, status, origin?.exclude || []]);
}

class Refused extends Error {
  constructor(reason) { super(reason); this.reason = reason; }
}

async function ensureUser(db, { xUserId, username }) {
  let user = await userByXId(db, xUserId);
  if (!user) user = await signInFromX(db, { id: String(xUserId), username: username || `user${xUserId}`, name: username || '' });
  // Betting from a reply is a public act, but it publishes the Bet only. The profile and saves stay private.
  if (!user.setup_completed_at) user = await completeSetup(db, user, { profileVisibility: 'private', defaultSaveVisibility: 'private', publishIds: [] });
  // The handle on the mention is the person's handle now. A stored one may since belong to someone else,
  // and the bot's replies name people by it.
  if (username && /^\w{1,15}$/.test(username) && user.x_username !== username) {
    user = await db.one('update users set x_username = $2 where id = $1 returning *', [user.id, username]);
  }
  return user;
}

const linkFor = (config, betId) => (config.x.replyLinks ? `${config.baseUrl}/bets/${betId}` : '');

async function offer(db, config, chain, cmd, deps) {
  if (!inPilot(config, cmd.x_user_id)) throw new Refused('pilot');
  if (cmd.detail === 'stake') throw new Refused('stake');
  const user = await ensureUser(db, { xUserId: cmd.x_user_id, username: cmd.x_username });
  const judge = await referee(db, config, chain);
  let betId = cmd.bet_id;
  if (!betId) {
    const row = await db.one(`select st.status, coalesce(st.deadline_at, st.proposed_deadline_at) as deadline, src.url
      from saves s join statements st on st.id = s.statement_id join sources src on src.id = st.source_id
      where s.id = $1 and s.owner_x_user_id = $2`, [cmd.save_id, cmd.x_user_id]);
    if (!row || !cmd.words) throw new Refused('no_offer');
    if (row.status !== 'open') throw new Refused('resolved');
    if (!row.deadline) throw new Refused('no_date');
    const due = new Date(row.deadline).getTime();
    if (due < Date.now() + 10 * 60000) throw new Refused('too_soon');
    if (due > Date.now() + 365 * DAY) throw new Refused('too_far');
    const bet = await createBet(db, user, {
      requestId: requestIdFor(cmd.event_id),
      claim: cmd.words,
      criteria: `Yes if what the post says has happened by ${dayMonth(row.deadline, { year: true })}. Stated’s recorded Result for this post, with its evidence link, decides.`,
      evidenceSourceUrl: row.url,
      creatorSide: cmd.side,
      stakeNear: cmd.stake_near,
      acceptBy: new Date(Math.min(due - 60000, Date.now() + 7 * DAY)).toISOString(),
      resolveAt: new Date(due).toISOString(),
      sourceSaveId: String(cmd.save_id),
      refereeAccount: judge.id,
    });
    betId = bet.id;
    // The post's words now live in the Bet's own terms; the queue keeps no copy.
    await db.query('update bet_commands set bet_id = $2, words = null, updated_at = clock_timestamp() where event_id = $1', [cmd.event_id, betId]);
  }
  await ensurePlayAccount(db, config, chain, { xUserId: cmd.x_user_id, username: cmd.x_username });
  // An earlier attempt may have sent the deposit and stopped before recording it. The chain says whether it is funded.
  let bet = await syncNearBet(db, config, user, betId, deps);
  if (!bet.chain_state) {
    try {
      ({ bet } = await playAction(db, config, chain, user, betId, { action: 'fund' }, deps));
    } catch (error) {
      // Not enough in the account for it: the offer is withdrawn so it does not sit unfunded on the person's list.
      if (error instanceof UserError && error.funds) {
        await db.query(`update bilateral_bets set status = 'cancelled' where id = $1 and chain_state is null and status = 'offered'`, [betId]);
      }
      throw error;
    }
  }
  await publishBet(db, user, betId);
  await say(db, config, { key: `offer:${betId}`, inReplyTo: cmd.event_id, betId,
    body: betReplies.offer({ stake: formatTestNear(bet.stake_yocto), side: bet.creator_side, date: dayMonth(bet.resolve_at, { year: true }),
      bot: deps.botUsername, url: linkFor(config, betId) }) });
  return betId;
}

async function take(db, config, chain, cmd, deps) {
  if (!inPilot(config, cmd.x_user_id)) throw new Refused('pilot');
  const ref = cmd.target_ref;
  const found = ref && (await db.one(`select bet_id from bot_outbox where post_id = $1 and bet_id is not null
      union all select bet_id from bet_commands where event_id = $1 and kind = 'bet' and bet_id is not null
      union all (select b.id from bilateral_bets b join saves s on s.id = b.source_save_id
        join statements st on st.id = s.statement_id join sources src on src.id = st.source_id
        where src.platform = 'x' and src.platform_id = $1 and b.referee_wallet is not null and b.chain_state is not null
          and b.status = 'offered' and b.accept_by > clock_timestamp() order by b.created_at desc limit 1)
      limit 1`, [ref]));
  if (!found) throw new Refused('no_offer');
  const betId = found.bet_id;
  const read = () => db.one(`select b.*, c.x_user_id as creator_x_user_id, c.x_username as creator_username
    from bilateral_bets b join users c on c.id = b.creator_user_id where b.id = $1`, [betId]);
  let row = await read();
  if (row.creator_x_user_id === cmd.x_user_id) throw new Refused('own');
  const user = await ensureUser(db, { xUserId: cmd.x_user_id, username: cmd.x_username });
  // An earlier attempt of this same command may already have taken the Bet on chain. Read the chain
  // (as the proposer, who can always see the Bet) before deciding it was taken by someone else.
  const proposer = await db.one('select * from users where id = $1', [row.creator_user_id]);
  await syncNearBet(db, config, proposer, betId, deps);
  row = await read();
  const mine = String(row.acceptor_user_id || '') === String(user.id);
  if (!mine && (row.status !== 'offered' || new Date(row.accept_by).getTime() <= Date.now())) throw new Refused('taken');
  await ensurePlayAccount(db, config, chain, { xUserId: cmd.x_user_id, username: cmd.x_username });
  let bet = row;
  if (!mine) {
    try {
      // The public reply is this person's consent to be named on the public Bet.
      await consentToPublicBet(db, user, betId);
      ({ bet } = await playAction(db, config, chain, user, betId, { action: 'accept', termsHash: row.terms_hash }, deps));
    } catch (error) {
      if (error instanceof UserError && [403, 409].includes(error.status) && !error.funds) throw new Refused('taken');
      throw error;
    }
  }
  if (String(bet.acceptor_user_id || '') !== String(user.id)) throw new Refused('taken');
  await say(db, config, { key: `match:${betId}`, inReplyTo: cmd.event_id, betId,
    body: betReplies.match({ pot: formatTestNear((BigInt(row.stake_yocto) * 2n).toString()), date: dayMonth(row.resolve_at, { year: true }),
      creator: row.creator_username, creatorSide: row.creator_side, taker: user.x_username, url: linkFor(config, betId) }) });
  return betId;
}

/** Carries out queued reply commands. Each command is retried up to five times; a refusal is final and says why. */
export async function runBetCommands(db, config, chain, { limit = 5, fetchImpl = fetch, botUsername = 'stated' } = {}) {
  const claimed = await db.tx(async (tx) => {
    const rows = await tx.many(`select * from bet_commands where status = 'queued'
      and (attempts = 0 or updated_at < clock_timestamp() - interval '45 seconds')
      order by created_at limit $1 for update skip locked`, [limit]);
    if (rows.length) await tx.query(`update bet_commands set attempts = attempts + 1, updated_at = clock_timestamp() where event_id = any($1)`, [rows.map((r) => r.event_id)]);
    return rows;
  });
  const result = { done: 0, refused: 0, retry: 0, failed: 0 };
  for (const claimedRow of claimed) {
    // The lease starts when this command starts, not when the batch was claimed, and only a command
    // that is still queued runs: another worker may have finished it while earlier ones ran here.
    const cmd = await db.one(`update bet_commands set updated_at = clock_timestamp() where event_id = $1 and status = 'queued' returning *`, [claimedRow.event_id]);
    if (!cmd) continue;
    try {
      const betId = await (cmd.kind === 'bet' ? offer : take)(db, config, chain, cmd, { fetchImpl, botUsername });
      await db.query(`update bet_commands set status = 'done', bet_id = $2, words = null, detail = null, updated_at = clock_timestamp() where event_id = $1 and status = 'queued'`, [cmd.event_id, betId]);
      result.done += 1;
    } catch (error) {
      // Past the hourly number of new accounts the command is dropped without a reply: answering
      // each new handle would spend on exactly the flood the limit is there to stop.
      if (error instanceof UserError && error.status === 429 && /New play accounts/.test(error.message)) {
        await db.query(`update bet_commands set status = 'refused', words = null, detail = 'paused', updated_at = clock_timestamp() where event_id = $1 and status = 'queued'`, [cmd.event_id]);
        result.refused += 1;
        continue;
      }
      const reason = error instanceof Refused ? error.reason
        : (error instanceof UserError && error.funds) ? 'funds'
          : (error instanceof UserError && /claimed/i.test(error.message)) ? 'claimed' : null;
      if (reason) {
        await db.query(`update bet_commands set status = 'refused', words = null, detail = $2, updated_at = clock_timestamp() where event_id = $1 and status = 'queued'`, [cmd.event_id, reason]);
        await say(db, config, { key: `refused:${cmd.event_id}`, inReplyTo: cmd.event_id, body: betReplies.refused(reason, { walletUrl: `${config.baseUrl}/me/wallet` }) });
        result.refused += 1;
      } else if (cmd.attempts >= 5) {
        await db.query(`update bet_commands set status = 'failed', words = null, detail = $2, updated_at = clock_timestamp() where event_id = $1 and status = 'queued'`,
          [cmd.event_id, String(error.message || error).slice(0, 300)]);
        result.failed += 1;
      } else {
        await db.query(`update bet_commands set detail = $2, updated_at = clock_timestamp() where event_id = $1 and status = 'queued'`, [cmd.event_id, String(error.message || error).slice(0, 300)]);
        result.retry += 1;
      }
    }
  }
  return result;
}

const RESULT_TO_OUTCOME = { yes: 'yes', no: 'no', ambiguous: 'void', annulled: 'void' };

/**
 * Settles Bets whose post now has a recorded Result, and returns stakes from
 * offers nobody took. The Result is the reviewer's, with its evidence link;
 * the referee transaction only carries it to the contract.
 */
export async function settleReplyBets(db, config, chain, { limit = 5, fetchImpl = fetch } = {}) {
  const judge = await referee(db, config, chain);
  const due = await db.many(`select b.id, st.status as result
    from bilateral_bets b join saves s on s.id = b.source_save_id join statements st on st.id = s.statement_id
    where b.referee_wallet = $1 and b.chain_state is not null and b.status in ('accepted', 'proposed', 'disputed')
      and st.status in ('yes', 'no', 'ambiguous', 'annulled')
      and st.resolved_at <= clock_timestamp() - make_interval(secs => $3)
      and (b.settle_checked_at is null or b.settle_checked_at < clock_timestamp() - interval '60 seconds')
    order by b.settle_checked_at asc nulls first, b.created_at limit $2`, [judge.id, limit, config.play.settleDelaySeconds]);
  const result = { settled: 0, reclaimed: 0, errors: 0 };
  const people = async (bet) => ({
    creator: await db.one('select * from users where id = $1', [bet.creator_user_id]),
    acceptor: bet.acceptor_user_id ? await db.one('select * from users where id = $1', [bet.acceptor_user_id]) : null,
  });
  const collect = async (user, betId) => {
    const account = user && await playAccountFor(db, user.x_user_id);
    if (!account?.ready || account.claimed_at) return;
    const pending = await db.one(`select id, transaction_hash from bilateral_near_requests
      where bet_id=$1 and user_id=$2 and method='withdraw' and execution_status='pending'
        and transaction_hash is not null and metadata->>'contract'=$3
      order by created_at desc limit 1`, [betId, user.id, config.nearContract]);
    if (pending) {
      const checked = await verifyBetTransaction(db, config, user, betId,
        { requestId: pending.id, transactionHash: pending.transaction_hash }, { fetchImpl });
      if (checked.status === 'pending') throw new Error('The previous withdrawal is still unverified.');
    }
    try {
      const paid = await playAction(db, config, chain, user, betId, { action: 'withdraw' }, { fetchImpl });
      if (paid.status !== 'succeeded') throw new Error('The withdrawal is still unverified.');
    } catch (error) {
      // Only confirmed zero credit means there is nothing to move. Failures stay eligible for retry.
      if (!error.noWithdrawalCredit) throw error;
    }
  };
  // Paying out is separate from settling: a payout that fails is retried by the sweep below, and
  // never turns a settled Bet into an error.
  const payOut = async (bet, creator, acceptor) => {
    try {
      await collect(creator, bet.id);
      await collect(acceptor, bet.id);
      await db.query(`insert into bilateral_bet_events (bet_id, actor_user_id, kind, detail) values ($1, $2, 'play_paid_out', '{}')`, [bet.id, creator.id]);
    } catch { result.errors += 1; }
  };
  for (const row of due) {
    await db.query('update bilateral_bets set settle_checked_at = clock_timestamp() where id = $1', [row.id]);
    try {
      const first = await db.one('select creator_user_id from bilateral_bets where id = $1', [row.id]);
      const owner = await db.one('select * from users where id = $1', [first.creator_user_id]);
      // The chain may have moved on (refunded, or settled by the two sides). Only a Bet it still holds open is ruled on.
      await syncNearBet(db, config, owner, row.id, { fetchImpl });
      const bet = await db.one('select * from bilateral_bets where id = $1', [row.id]);
      if (!['accepted', 'proposed', 'disputed'].includes(bet.status)) continue;
      // The Result as it stands at this moment, not as it stood when the list was read.
      const now = await db.one(`select st.status from saves s join statements st on st.id = s.statement_id where s.id = $1`, [bet.source_save_id]);
      const outcome = RESULT_TO_OUTCOME[now?.status];
      if (!outcome) continue;
      const { creator, acceptor } = await people(bet);
      const { bet: settled } = await refereeSettle(db, config, chain, bet, creator, outcome, { fetchImpl });
      if (settled.status !== 'settled') continue;
      await payOut(bet, creator, acceptor);
      const origin = await db.one(`select event_id from bet_commands where bet_id = $1 and kind = 'bet' limit 1`, [bet.id]);
      const creatorWins = outcome === bet.creator_side;
      if (origin && acceptor) {
        await say(db, config, { key: `result:${bet.id}`, inReplyTo: origin.event_id, betId: bet.id,
          body: betReplies.result({ outcome, winner: (creatorWins ? creator : acceptor).x_username, loser: (creatorWins ? acceptor : creator).x_username,
            pot: formatTestNear((BigInt(bet.stake_yocto) * 2n).toString()), url: linkFor(config, bet.id) }) });
      }
      result.settled += 1;
    } catch { result.errors += 1; }
  }
  // An offer nobody took, on a post that now has a result or whose window has closed: the stake goes back.
  const idle = await db.many(`select b.id, (b.accept_by <= clock_timestamp()) as expired
    from bilateral_bets b left join saves s on s.id = b.source_save_id left join statements st on st.id = s.statement_id
    where b.referee_wallet = $1 and b.chain_state is not null and b.status = 'offered'
      and (b.accept_by <= clock_timestamp() or st.status in ('yes', 'no', 'ambiguous', 'annulled'))
      and (b.settle_checked_at is null or b.settle_checked_at < clock_timestamp() - interval '5 minutes')
    order by b.settle_checked_at asc nulls first limit $2`, [judge.id, limit]);
  for (const row of idle) {
    await db.query('update bilateral_bets set settle_checked_at = clock_timestamp() where id = $1', [row.id]);
    try {
      const bet = await db.one('select * from bilateral_bets where id = $1', [row.id]);
      const { creator } = await people(bet);
      const account = await playAccountFor(db, creator.x_user_id);
      if (!account?.ready || account.claimed_at) continue;
      await playAction(db, config, chain, creator, bet.id, { action: row.expired ? 'expire' : 'cancel' }, { fetchImpl });
      await payOut(bet, creator, null);
      result.reclaimed += 1;
    } catch { result.errors += 1; }
  }
  // Finished reply Bets whose winnings or returned stake have not reached the play account yet.
  const unpaid = await db.many(`select b.id from bilateral_bets b
    where b.referee_wallet = $1 and b.status in ('settled', 'cancelled', 'expired', 'refunded') and b.chain_state is not null
      and not exists (select 1 from bilateral_bet_events e where e.bet_id = b.id and e.kind = 'play_paid_out')
      and (b.settle_checked_at is null or b.settle_checked_at < clock_timestamp() - interval '5 minutes')
    order by b.settle_checked_at asc nulls first limit $2`, [judge.id, limit]);
  for (const row of unpaid) {
    await db.query('update bilateral_bets set settle_checked_at = clock_timestamp() where id = $1', [row.id]);
    const bet = await db.one('select * from bilateral_bets where id = $1', [row.id]);
    const { creator, acceptor } = await people(bet);
    await payOut(bet, creator, acceptor);
  }
  return result;
}

/** Posts queued Bet replies. One post per row, claimed before sending so a restart cannot post twice. */
export async function sendBetReplies(db, x, { limit = 20 } = {}) {
  await db.query(`update bot_outbox set status = 'failed', error = 'Interrupted while sending. Check the bot''s replies on X before sending again.'
    where status = 'sending' and coalesce(sent_at, created_at) < clock_timestamp() - interval '10 minutes'`);
  const pending = await db.many(`select id from bot_outbox where status = 'pending' order by created_at, id limit $1`, [limit]);
  const sent = [];
  for (const { id } of pending) {
    const row = await db.one(`update bot_outbox set status = 'sending', sent_at = clock_timestamp() where id = $1 and status = 'pending' returning *`, [id]);
    if (!row) continue;
    try {
      const post = await x.reply({ text: row.body, inReplyTo: row.in_reply_to, exclude: row.exclude });
      await db.query(`update bot_outbox set status = 'sent', post_id = $2, sent_at = clock_timestamp() where id = $1`, [id, post?.id || null]);
      sent.push(id);
    } catch (error) {
      await db.query(`update bot_outbox set status = 'failed', error = $2 where id = $1`, [id, String(error.message || error).slice(0, 500)]);
      if (error.status === 429 || error.status === 402) break;
    }
  }
  return sent;
}

/** Runs commands and settlements on a timer, apart from the X worker. Stops when the returned function is called. */
export function startPlayWorker(db, config, { chain = nearChain(), intervalMs = 5000, fetchImpl = fetch, botUsername, onError,
  intents = fundingOn(config) ? intentsQuotes() : null } = {}) {
  let stopped = false;
  let timer;
  let passes = 0;
  // After a failure the worker waits longer each time, up to five minutes. The usual cause is the
  // faucet or an RPC endpoint saying "too many requests", and asking again at once makes it worse.
  let delay = intervalMs;
  async function run() {
    if (stopped) return;
    try {
      // The treasury and the referee are made once, at startup, so the first bet does not wait for them.
      if (passes === 0) await referee(db, config, chain);
      const name = typeof botUsername === 'function' ? await botUsername() : botUsername;
      const ran = await runBetCommands(db, config, chain, { fetchImpl, botUsername: name || 'stated' });
      passes += 1;
      // Looking for a recorded Result is one query, so it runs every pass; the treasury is checked each minute.
      const settled = await settleReplyBets(db, config, chain, { fetchImpl });
      if (settled.errors) onError?.(new Error(`${settled.errors} reply-bet settlements failed; they will retry.`));
      // Payments from another chain complete here too, so one finishes with its page closed.
      if (intents) await refreshOpenDeposits(db, config, chain, intents);
      if (passes % 12 === 1) {
        await refillTreasury(db, config, chain);
        await topUpReferee(db, config, chain);
      }
      if (ran.failed) onError?.(new Error(`${ran.failed} reply-bet commands failed after five attempts.`));
      delay = intervalMs;
    } catch (error) {
      delay = Math.min(Math.max(delay, 15000) * 2, 5 * 60 * 1000);
      try { onError?.(new Error(`${error.message} Trying again in ${Math.round(delay / 1000)}s.`)); } catch { /* reporting must not stop the worker */ }
    } finally {
      if (!stopped) { timer = setTimeout(run, delay); timer.unref?.(); }
    }
  }
  timer = setTimeout(run, 0);
  timer.unref?.();
  return () => { stopped = true; clearTimeout(timer); };
}
