// INTEGRATION: Authorized Marked presentation; escrow closure never implies withdrawal.
// Presentation helpers for the Marked look: how long until we find out, and
// the two-seat Bet block. Pure functions; callers pass authorized projections.
import { html } from './html.mjs';
import { face } from './certificate.mjs';
import { formatTestNear } from './near-escrow.mjs';
import { unit } from './near-network.mjs';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
const DAY = 86400000;

// "28 Sep", or "28 Sep 2026" with the year. UTC, like every date on the site.
export function dayMonth(value, { year = false } = {}) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]}${year ? ` ${d.getUTCFullYear()}` : ''}`;
}

// Counted in whole UTC days, so the phrase changes at midnight and not mid-afternoon.
export function timeLeft(deadline, now = Date.now()) {
  if (!deadline) return '';
  const end = new Date(deadline).getTime();
  if (Number.isNaN(end)) return '';
  const days = Math.floor(end / DAY) - Math.floor(now / DAY);
  if (days < 0) return 'Past due';
  if (days === 0) return 'Due today';
  if (days === 1) return '1 day to go';
  if (days < 365) return `${days} days to go`;
  if (days < 730) return `${Math.round(days / 30.44)} months to go`;
  return `${Math.round(days / 365.25)} years to go`;
}

const shortWallet = (wallet) => (wallet && wallet.length > 20 ? `${wallet.slice(0, 9)}…${wallet.slice(-7)}` : wallet || null);
const nameOf = (username, wallet) => (username ? `@${username}` : shortWallet(wallet));

export function betState(bet, now = Date.now()) {
  const funded = Boolean(bet.funded ?? bet.chain_state);
  const expired = bet.status === 'offered' && new Date(bet.accept_by).getTime() <= now;
  return {
    funded,
    expired,
    open: bet.status === 'offered' && funded && !expired,
    decided: bet.status === 'settled' && (bet.outcome === 'yes' || bet.outcome === 'no'),
  };
}

// One line that says where a Bet stands, in the reader's terms.
// DESIGN.md: the next event leads with time to go; the exact UTC time follows.
export function nextBetTime(value, now = Date.now()) {
  const date = new Date(value);
  const left = date.getTime() - now;
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', hour: '2-digit', minute: '2-digit',
  }).format(date);
  const day = dayMonth(date, { year: date.getUTCFullYear() !== new Date(now).getUTCFullYear() });
  if (left > 0 && left < 2 * 86400000) {
    const minutes = left < 3600000;
    const count = Math.ceil(left / (minutes ? 60000 : 3600000));
    const unit = minutes ? 'minute' : 'hour';
    return `in ${count} ${unit}${count === 1 ? '' : 's'}, ${clock} UTC ${day}`;
  }
  return `${day}, ${clock} UTC`;
}

export function betLead(bet, { viewer = null } = {}) {
  const { funded, expired, open, decided } = betState(bet);
  const mine = (username) => Boolean(viewer?.x_username && username && viewer.x_username.toLowerCase() === String(username).toLowerCase());
  const creator = mine(bet.creator_username) ? 'You' : nameOf(bet.creator_username, bet.creator_wallet) || 'The proposer';
  const taker = mine(bet.acceptor_username) ? 'You' : nameOf(bet.acceptor_username, bet.acceptor_wallet);
  if (open) return { text: creator === 'You' ? 'Your bet is open' : (mine(bet.acceptor_username) ? 'You are in' : `${creator} dares you`), aside: `Offer closes ${nextBetTime(bet.accept_by)}` };
  if (bet.status === 'offered' && expired) return { text: 'Nobody took this one', aside: `Closed ${dayMonth(bet.accept_by)}` };
  if (bet.status === 'offered' && !funded) return { text: 'Not funded yet', aside: `Offer closes ${nextBetTime(bet.accept_by)}` };
  if (bet.status === 'accepted') return { text: 'Both sides are in', aside: `Result after ${dayMonth(bet.resolve_at)}` };
  if (bet.status === 'proposed') return { text: 'A result is proposed', aside: 'Both must agree' };
  if (bet.status === 'disputed') return { text: 'The result is disputed', aside: 'Both must agree' };
  if (decided) {
    const winner = bet.outcome === bet.creator_side ? creator : (taker || 'The other side');
    // A referee's ruling and an unanswered result are not agreements, and are not described as one.
    const how = { referee: 'Settled', unanswered: 'Unanswered' }[bet.settled_by || bet.chain_state?.resolution?.method] || 'Agreed';
    return { text: `${winner} won`, aside: bet.settled_at ? `${how} ${dayMonth(bet.settled_at)}` : how };
  }
  if (bet.status === 'settled') return { text: 'Called off', aside: 'Agreed void' };
  if (bet.status === 'cancelled') return { text: 'Offer cancelled', aside: '' };
  if (bet.status === 'refunded') return { text: 'Refund recorded', aside: '' };
  if (bet.status === 'expired') return { text: 'Nobody took this one', aside: '' };
  return { text: 'Needs verification', aside: '' };
}

// Two seats and the stake between them. "bet yes" sits on the left, "bet no"
// on the right. An open seat shows the viewer's own face, greyed, as the
// invitation; a signed-out visitor sees an empty circle. `cameTrue` is set by a
// Prediction page whose own Result is Yes: only then is the winner's ring
// yellow, because a Bet is settled by agreement and not by the Result.
// A handle wraps in full and is never cut: it may break after an underscore, the one place a handle has a seam.
const handleWords = (label) => String(label).split('_').map((part, n) => (n ? html`_<wbr>${part}` : part));

export function betBlock(bet, { viewer = null, faces = null, joinHref = null, lead = true, cameTrue = false } = {}) {
  const { funded, expired, open, decided } = betState(bet);
  const offered = bet.status === 'offered' && !expired;
  const mine = (username) => Boolean(viewer?.x_username && username && viewer.x_username.toLowerCase() === String(username).toLowerCase());
  const stake = formatTestNear(bet.stake_yocto);
  const both = formatTestNear((BigInt(bet.stake_yocto) * 2n).toString());
  const other = bet.creator_side === 'yes' ? 'no' : 'yes';
  const person = (username, wallet) => {
    const label = nameOf(username, wallet);
    if (!label) return null;
    const me = mine(username);
    return { label: me ? 'You' : label, url: me ? viewer.x_avatar_url : faces?.get(String(username || '').toLowerCase()) || null, initial: username || wallet };
  };
  const seats = { [bet.creator_side]: person(bet.creator_username, bet.creator_wallet) || { label: 'The proposer', url: null, initial: '?' }, [other]: person(bet.acceptor_username, bet.acceptor_wallet) };
  const seat = (side) => {
    const who = seats[side];
    const stance = `bet ${side}`;
    if (!who) {
      if (!offered) return html`<div class="seat"><span class="open"></span><b>Nobody</b><span>${stance}</span></div>`;
      const asker = mine(bet.creator_username) || !open;
      const inner = asker ? html`<span class="open"></span><b>Anyone</b><span>${stance}</span>`
        : html`${viewer ? face({ url: viewer.x_avatar_url, name: viewer.x_username, size: 'ghost' }) : html`<span class="open"></span>`}<b>You?</b><span>${stance}</span>`;
      return joinHref && !asker ? html`<a class="seat" href="${joinHref}">${inner}</a>` : html`<div class="seat">${inner}</div>`;
    }
    const state = decided ? (bet.outcome === side ? ' won' : ' lost') : '';
    return html`<div class="seat${state}">${face({ url: who.url, name: who.initial })}<b>${handleWords(who.label)}</b><span>${stance}</span></div>`;
  };
  let pot;
  if (decided) pot = html`<b>${both}</b><small>${unit()}</small><small>${(bet.settled_by || bet.chain_state?.resolution?.method) === 'referee' ? 'won' : 'credited'}</small>`;
  else if (['settled', 'refunded', 'cancelled', 'expired'].includes(bet.status)) pot = html`<b>${stake}</b><small>${unit()} each</small><small>${funded ? 'escrow closed' : 'not deposited'}</small>`;
  else pot = html`<b>${stake}</b><small>${unit()} each</small>`;
  const head = lead ? betLead(bet, { viewer }) : null;
  return html`${head ? html`<p class="lead">${head.text}${head.aside ? html`<span>${head.aside}</span>` : ''}</p>` : ''}
    <div class="versus${decided && !cameTrue ? ' agreed' : ''}">${seat('yes')}<div class="pot">${pot}</div>${seat('no')}</div>`;
}
