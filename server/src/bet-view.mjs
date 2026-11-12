// INTEGRATION: the Marked look for Bets; callers supply an authorized Bet projection.
// The two-seat block itself lives in marked.mjs; these helpers wrap it.
import { html, raw } from './html.mjs';
import { betBlock as markedBetBlock, betLead, betState, dayMonth, nextBetTime } from './marked.mjs';

export { nextBetTime };
import { face } from './certificate.mjs';
import { formatTestNear } from './near-escrow.mjs';
import { network, unit } from './near-network.mjs';

export const BET_STATUS = {
  offered: 'Opposite side open', accepted: 'Both sides deposited', proposed: 'Result proposed',
  disputed: 'Result disputed', settled: 'Result agreed', cancelled: 'Offer cancelled',
  expired: 'Offer expired', refunded: 'Refund credited', unverified: 'Verification needed',
};
export const betTime = (value) => new Intl.DateTimeFormat('en-GB', {
  timeZone: 'UTC', dateStyle: 'medium', timeStyle: 'short',
}).format(new Date(value)) + ' UTC';


// DESIGN.md: the Result marks the words, on both the Bet and its ruling page.
export function markedClaim(claim, outcome) {
  if (outcome === 'yes') return html`<span class="hl">${claim}</span>`;
  if (outcome === 'no') return html`<span class="struck">${claim}</span>`;
  return claim;
}

export function displayBetStatus(bet) {
  if (bet.status === 'offered' && new Date(bet.accept_by).getTime() <= Date.now()) return 'Offer expired';
  if (bet.status === 'offered' && !(bet.chain_state || bet.funded)) return 'Not funded';
  return BET_STATUS[bet.status] || 'Verification needed';
}

// DESIGN.md: phase headings belong above the seats; settled stakes are the pot.
export function betBlock(bet, options = {}) {
  const refereeVoid = bet.status === 'settled' && bet.outcome === 'void'
    && (bet.settled_by || bet.chain_state?.resolution?.method) === 'referee';
  const head = options.lead === false ? null : options.heading
    || (refereeVoid ? { text: betLead(bet, options).text, aside: 'Stakes returned' } : betLead(bet, options));
  if (head && !options.heading) {
    if (betState(bet).open || (bet.status === 'offered' && !betState(bet).expired)) head.aside = `Offer closes ${nextBetTime(bet.accept_by)}`;
    else if (bet.status === 'accepted') head.aside = `Result ${nextBetTime(bet.resolve_at)}`;
  }
  // The shared Marked seats also serve Prediction pages. Keep this Bet-only label here.
  // DESIGN.md: Bet handles stay whole; only names over twelve characters step down.
  const seats = raw(String(markedBetBlock(bet, { ...options, lead: false }))
    .replace(/<b>(@[\w]*(?:<wbr>[\w]*)*)<\/b>/g, (_, name) => {
      const handle = name.replaceAll('<wbr>', '');
      return `<b${handle.length > 13 ? ' class="long-handle"' : ''}>${handle}</b>`;
    }));
  const ruling = ['accepted', 'proposed', 'disputed'].includes(bet.status) && ['yes', 'no'].includes(options.ruling) ? options.ruling : null;
  const pot = bet.status === 'settled' || ruling;
  const body = pot ? raw(String(seats).replace(/<div class="pot">[\s\S]*?<\/div>/,
    String(html`<div class="pot"><b>${formatTestNear((BigInt(bet.stake_yocto) * 2n).toString())}</b><small>${unit()} pot</small></div>`))) : seats;
  return html`${head ? html`<p class="lead">${head.text}${head.aside ? html`<span>${head.aside}</span>` : ''}</p>` : ''}<div class="bet-seats"${ruling ? html` data-ruling="${ruling}"` : ''}>${body}</div>`;
}

// Kept for callers that import it: the two seats, with no lead line.
export function betStubs(bet, { joinHref = null, viewer = null, faces = null } = {}) {
  return betBlock(bet, { viewer, faces, joinHref, lead: false });
}

// No longer the main presentation: the wording, then the lead and the seats.
export function betCertificate(bet, { joinHref = null, viewer = null, faces = null } = {}) {
  return html`<p class="prop">${bet.claim}</p>${betBlock(bet, { viewer, faces, joinHref })}`;
}

// The terms as a fold. `extra` is more definition-list rows from the caller.
export function betTerms(bet, { extra = '', open = false, title = 'Terms', juryReview = false } = {}) {
  return html`<details class="fold"${open ? ' open' : ''}><summary>${title}</summary><dl class="bet-terms">
    <dt>Counts as yes</dt><dd>${bet.criteria}</dd>
    <dt>Link source</dt><dd><a href="${bet.evidence_source_url}" rel="noopener noreferrer">${bet.evidence_source_url}</a></dd>
    <dt>Stake each</dt><dd>${formatTestNear(bet.stake_yocto)} ${unit()}</dd>
    <dt>${network().real ? 'Real NEAR' : 'Test tokens'}</dt><dd>${network().real ? 'Stakes use real NEAR.' : 'Test NEAR has no monetary value.'} Any settlement or refund creates withdrawal credit; transfer needs a separate withdrawal.</dd>
    <dt>Accept before</dt><dd>${nextBetTime(bet.accept_by)}</dd>
    <dt>Result after</dt><dd>${nextBetTime(bet.resolve_at)}</dd>
    <dt>Stake back from</dt><dd>${nextBetTime(new Date(new Date(bet.resolve_at).getTime() + 7 * 86400000))}</dd>
    <dt>Settlement</dt><dd>${bet.referee_wallet
      ? html`Stated’s recorded Result for the post decides, and the referee account <span class="mono">${bet.referee_wallet}</span> carries it to the contract. The referee can only choose yes, no or void between the two sides; it cannot take the stakes. With no Result, each side takes its stake back after that date.`
      : 'Both must agree on the result. A result the other side leaves unanswered for two days stands. Without agreement, each can take their stake back after that date.'}${juryReview ? ' A reviewer can correct a ruling before it pays out.' : ''}</dd>
    ${extra}
  </dl></details>`;
}

// The X post that goes with a Bet. `mine` is true when the person posting is
// the proposer, so "I bet no" is theirs to say.
export const X_MARK = raw('<svg class="xmark" viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M18.9 2H22l-7.5 8.6L23 22h-6.9l-5.4-7-6.2 7H1.4l8-9.2L1 2h7l4.9 6.4L18.9 2Zm-1.2 18h1.9L7.4 3.9H5.4L17.7 20Z"/></svg>');

export function betShareLink(baseUrl, bet, { label = null, ghost = false, mine = true } = {}) {
  const url = `${baseUrl}/bets/${bet.id}`;
  const { open } = betState(bet);
  const side = bet.creator_side === 'yes' ? 'yes' : 'no';
  const other = side === 'yes' ? 'no' : 'yes';
  const outcome = bet.outcome === 'yes' ? 'Yes' : bet.outcome === 'no' ? 'No' : null;
  const who = mine ? 'I bet' : `${bet.creator_username ? `@${bet.creator_username}` : 'Someone'} bet`;
  let text = ['accepted', 'proposed', 'disputed'].includes(bet.status) ? 'Both sides are in on this one.'
    : open ? `${who} ${side} on this. Take ${other}?`
    : `${displayBetStatus(bet)}.`;
  if (bet.status === 'settled') {
    text = outcome ? `Settled: ${outcome}.` : 'Settled: called off.';
    if (outcome && bet.settled_by === 'referee') {
      const winner = bet.outcome === bet.creator_side ? bet.creator_username : bet.acceptor_username;
      const pot = formatTestNear((BigInt(bet.stake_yocto) * 2n).toString());
      text = `Result: ${outcome}. ${winner ? `@${winner}` : `The ${bet.outcome} side`} won ${pot} ${unit()}.`;
    }
  }
  const intent = new URL('https://x.com/intent/post');
  intent.searchParams.set('text', text);
  intent.searchParams.set('url', url);
  const words = label || (bet.status === 'settled' ? 'Post the result' : (ghost ? 'Share on X' : 'Post on X'));
  return html`<a class="${ghost ? 'tl' : 'pill solid big'}" href="${intent.toString()}" rel="noopener noreferrer">${!ghost || words === 'Post on X' ? X_MARK : ''}${words}</a>`;
}

// One row per Bet: the wording, then a line of plain facts.
export function betList(rows, { viewer = null, faces = null, hall = false } = {}) {
  const pic = (username) => face({ url: faces?.get(String(username || '').toLowerCase()) || null, name: username || '?' });
  return html`<ul class="posts">${rows.map((bet) => {
    const status = displayBetStatus(bet);
    const lead = betLead(bet, { viewer }).text;
    const people = [bet.creator_username, bet.acceptor_username].filter(Boolean);
    if (hall) {
      const winner = bet.outcome === bet.creator_side ? bet.creator_username : bet.acceptor_username;
      const phrase = bet.status === 'settled' && ['yes', 'no'].includes(bet.outcome)
        ? `${winner ? `@${winner}` : `The ${bet.outcome} side`} won ${formatTestNear((BigInt(bet.stake_yocto) * 2n).toString())} ${unit()}`
        : status === 'Offer expired' ? status : bet.status === 'offered' ? `Offer closes ${nextBetTime(bet.accept_by)}`
          : ['accepted', 'proposed', 'disputed'].includes(bet.status) ? 'Both sides are in'
            : bet.status === 'settled' && bet.outcome === 'void' ? 'Called off'
            : BET_STATUS[bet.status];
      return html`<li class="prow note"><p class="said"><a href="/bets/${bet.id}">${bet.claim}</a></p><p class="meta">${phrase}</p></li>`;
    }
    return html`<li class="prow note"><p class="said"><a href="/bets/${bet.id}">${bet.claim}</a></p>
      <p class="meta">${people.length ? html`<span class="stack">${people.map(pic)}</span>` : ''}<b>${status === 'Not funded' ? status : lead}</b><span>${formatTestNear(bet.stake_yocto)} ${unit()} each</span></p>
    </li>`;
  })}</ul>`;
}
