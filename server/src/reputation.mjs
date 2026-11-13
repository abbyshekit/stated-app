// Settled reply Bets belong to the stable X-linked user, even after a handle changes.
// DESIGN.md: supporting copy uses the existing dim text; no client script is needed.
import Decimal from 'decimal.js';
import { unit } from './near-network.mjs';
import { UserError } from './store.mjs';

const D = Decimal.clone({ precision: 100 });
const DEFAULT_TIERS = '0:0.25,1:0.5,3:1';

export function parseReputationTiers(value = DEFAULT_TIERS) {
  if (String(value).trim() === 'off') return null;
  const invalid = () => new Error('STATED_REPUTATION_TIERS must be off or rising settled:stake tiers starting at 0.');
  const tiers = String(value).split(',').map((part) => {
    const match = part.trim().match(/^(0|[1-9][0-9]*):((?:0|[1-9][0-9]*)(?:\.[0-9]{1,24})?)$/);
    if (!match || !Number.isSafeInteger(Number(match[1])) || match[2].length > 26) throw invalid();
    const amount = new D(match[2]);
    if (amount.lte(0)) throw invalid();
    return { settled: Number(match[1]), limit: D.min(amount, 1).toFixed() };
  }).sort((a, b) => a.settled - b.settled);
  if (tiers[0].settled !== 0 || tiers.some((tier, i) => i > 0
    && (tier.settled === tiers[i - 1].settled || new D(tier.limit).lte(tiers[i - 1].limit)))) throw invalid();
  return tiers;
}

const tiersFor = (config) => config.play?.reputationTiers === undefined
  ? parseReputationTiers() : config.play.reputationTiers;

/** Mainnet's operator cap also applies when reputation limits are disabled. */
export const stakeCap = (config) => config.near?.real ? D.min(config.play?.maxStakeNear ?? '1', 1).toFixed() : '1';
export const stakeCapReply = (config) => `The mainnet stake cap is ${stakeCap(config)} NEAR per bet. Choose a stake at or below that cap.`;

export function assertMainnetStakeCap(config, stakeNear) {
  if (config.near?.real && new D(stakeNear).lt('0.1')) {
    throw Object.assign(new UserError('The minimum mainnet stake is 0.1 NEAR. Choose at least 0.1 NEAR.', 409),
      { reason: 'minimum', limit: '0.1' });
  }
  if (config.near?.real && aboveLimit(stakeNear, stakeCap(config))) {
    throw Object.assign(new UserError(stakeCapReply(config), 409), { reason: 'cap', limit: stakeCap(config) });
  }
}

/** Internal user ID, bound to an X account. EXISTS avoids counting command retries twice. */
export async function recordFor(db, userId) {
  return db.one(`select count(*)::int as settled,
    count(*) filter (where b.outcome in ('yes','no') and
      ((b.creator_user_id = $1 and b.outcome = b.creator_side)
        or (b.acceptor_user_id = $1 and b.outcome <> b.creator_side)))::int as won
    from bilateral_bets b
    where b.status = 'settled' and (b.creator_user_id = $1 or b.acceptor_user_id = $1)
      and exists (select 1 from bet_commands c where c.bet_id = b.id and c.kind = 'bet')`, [userId]);
}

export function limitFor(config, record) {
  const tiers = tiersFor(config);
  if (!tiers) return stakeCap(config);
  const tier = tiers.findLast((item) => record.settled >= item.settled) || tiers[0];
  return D.min(tier.limit, stakeCap(config)).toFixed();
}

export const aboveLimit = (stakeNear, limit) => new D(stakeNear).gt(limit);
const countWords = (count) => count === 3 ? 'three' : String(count);

export function limitHint(config, record) {
  const limit = limitFor(config, record);
  if (config.near?.real && limit === stakeCap(config)) return stakeCapReply(config);
  const next = tiersFor(config)?.find((tier) => tier.settled > record.settled && aboveLimit(tier.limit, limit));
  if (!next) return null;
  const until = next.settled === 1 ? 'a bet' : `${countWords(next.settled)} bets`;
  return `Your limit is ${limit} ${unit()} until you have settled ${until}.`;
}

export function limitReply(config, limit) {
  const rises = (tiersFor(config) || []).slice(1).filter((tier) => !aboveLimit(tier.limit, stakeCap(config))).map((tier, i) => {
    const after = tier.settled === 1 ? 'a settled bet' : countWords(tier.settled);
    return `${i ? 'to ' : ''}${tier.limit} after ${after}`;
  });
  const last = rises.pop();
  const progression = last ? ` The limit rises to ${rises.length ? `${rises.join(', ')} and ${last}` : last}.` : '';
  return `New handles can stake up to ${limit} ${unit()}.${progression}${config.near?.real ? ` ${stakeCapReply(config)}` : ''}`;
}

/** Call before account provisioning in replies and before reserving any new stake request. */
export async function assertStakeLimit(db, config, userId, stakeNear) {
  assertMainnetStakeCap(config, stakeNear);
  if (!tiersFor(config)) return;
  const limit = limitFor(config, await recordFor(db, userId));
  if (aboveLimit(stakeNear, limit)) {
    throw Object.assign(new UserError(limitReply(config, limit), 409), { reason: 'limit', limit });
  }
}
