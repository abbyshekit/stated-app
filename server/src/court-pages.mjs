// The public face of Stated Court: one line on a Bet page whose referee is the
// DAO, and /court, which lists the DAO's members, its voting rule and its recent
// Stated proposals. Everything here is read from chain views, cached for 30 s.
// DESIGN.md: existing classes only; account names and votes are plain text.
import { html } from './html.mjs';
import { accountLink, unit } from './near-network.mjs';
import { formatTestNear } from './near-escrow.mjs';
import { dayMonth } from './marked.mjs';
import { cachedView, courtDao, proposalTarget } from './court-dao.mjs';
import { publicBet } from './bet-public.mjs';
import { markedClaim } from './bet-view.mjs';
import { juryLogos } from './settlement-view.mjs';

const STATUS = { InProgress: 'open for council votes', Approved: 'approved', Rejected: 'voted down', Removed: 'removed',
  Expired: 'expired', Failed: 'failed', Moved: 'moved' };
const statusWords = (status) => STATUS[status] || 'status unavailable';

/** Identify the DAO referee and its latest proposal. */
export async function courtLine(db, config, chain, bet) {
  const dao = courtDao(config);
  if (!dao || bet?.referee_wallet !== dao) return '';
  if (bet.status === 'offered') {
    const models = [...new Set(config.nearai?.rulingModels || [])];
    const count = models.length === 3 ? 'Three' : String(models.length);
    return html`${juryLogos(models)}<p class="gut">${count} AI ${models.length === 1 ? 'model judges' : 'models judge'} it. <a class="tl" href="/court">Stated Court</a> can veto their ruling for ${duration(config.play?.settleDelaySeconds)}.</p>`;
  }
  const filed = await db.one(`select detail from bilateral_bet_events where bet_id = $1 and kind = 'court_proposal'
    order by id desc limit 1`, [bet.id]);
  let status = null;
  if (filed) {
    try { status = (await cachedView(chain(), dao, 'get_proposal', { id: Number(filed.detail.proposalId) })).status; }
    catch { /* the line still names the referee */ }
  }
  return html`<p class="gut"><a class="tl" href="/court">Stated Court</a>, a Sputnik DAO on NEAR, is the referee.${filed
    ? ` Proposal ${filed.detail.proposalId} is ${statusWords(status)}.` : ''}</p>`;
}

function duration(seconds) {
  if (seconds === 600) return 'ten minutes';
  if (!Number.isFinite(seconds) || seconds < 0) return 'an unavailable amount of time';
  if (seconds % 60 === 0) return `${seconds / 60} ${seconds === 60 ? 'minute' : 'minutes'}`;
  return `${seconds} ${seconds === 1 ? 'second' : 'seconds'}`;
}

function policySentence(policy) {
  const [num, den] = policy.default_vote_policy?.threshold || [1, 2];
  const days = Math.round(Number(BigInt(policy.proposal_period || '0') / 3_600_000_000_000n) / 24);
  return `Each role votes on its own: a proposal passes when more than ${num} in ${den} of the members of a role that may approve it vote yes, and fails when more than ${num} in ${den} of a role vote no; an open proposal expires after ${days} days.`;
}

// A proposal's approval alone proves neither settlement nor a transfer to the winner.
export function courtEffect(proposal, target, bet) {
  const ruling = bet?.enclave?.mode === 'ruling' ? bet.enclave.outcome : null;
  const modelLine = ['yes', 'no'].includes(ruling) ? `The models said ${ruling}.`
    : ruling === 'unclear' ? 'The models could not agree.'
      : '';
  const matches = bet?.status === 'settled' && bet.settled_by === 'referee' && bet.outcome === target.outcome;
  let effect = ({ Rejected: 'The council voted it down, so it did not pay.',
    InProgress: 'The council can still vote.', Approved: 'The council let the ruling stand.',
    Removed: 'The ruling was removed.', Expired: 'The vote expired.',
    Failed: 'The ruling failed to go through.', Moved: 'The ruling was moved.' })[proposal.status] || 'The vote could not be read.';
  if (proposal.status === 'Approved' && matches && !bet.payout_completed) {
    effect = bet.outcome === 'void' ? 'The bet was called off.' : 'The bet settled; payment has not been confirmed.';
  }
  if (proposal.status === 'Approved' && matches && bet.payout_completed && ['yes', 'no'].includes(bet.outcome)) {
    const creatorWon = bet.outcome === bet.creator_side;
    const username = creatorWon ? bet.creator_username : bet.acceptor_username;
    const wallet = creatorWon ? bet.creator_wallet : bet.acceptor_wallet;
    const winner = username ? `@${username}` : wallet || 'The winner';
    let amount = '';
    try { amount = ` ${formatTestNear((BigInt(bet.stake_yocto) * 2n).toString())} ${unit()}`; } catch { /* amount unavailable */ }
    effect = `${winner} was paid${amount}.`;
  }
  return [modelLine, effect].filter(Boolean).join(' ');
}

function proposalDate(submissionTime, filedAt) {
  let date;
  try {
    if (/^\d+$/.test(String(submissionTime)) && BigInt(submissionTime) > 0n) date = new Date(Number(BigInt(submissionTime) / 1_000_000n));
  } catch { /* use the filing date */ }
  if (!date || Number.isNaN(date.getTime())) date = filedAt ? new Date(filedAt) : null;
  return date && !Number.isNaN(date.getTime()) ? dayMonth(date) : '';
}

const councilAction = (status) => ({ Approved: 'Let it stand', Rejected: 'Voted it down', InProgress: 'Waiting',
  Removed: 'Removed', Expired: 'Expired', Failed: 'Failed', Moved: 'Moved' })[status] || 'Unavailable';

export function registerCourtRoutes({ route, db, config, layout, send, notFound, chain }) {
  route('GET', /^\/court$/, async (ctx) => {
    const dao = courtDao(config);
    if (!dao) return notFound(ctx);
    let policy; let proposals;
    try {
      policy = await cachedView(chain(), dao, 'get_policy');
      const last = Number(await cachedView(chain(), dao, 'get_last_proposal_id'));
      const from = Math.max(0, last - 50);
      proposals = last > 0 ? await cachedView(chain(), dao, 'get_proposals', { from_index: from, limit: last - from }) : [];
    } catch {
      return send(ctx.res, 503, await layout(ctx, 'Stated Court', html`<p class="gut">The DAO could not be read from NEAR just now. Try again in a minute.</p>`));
    }
    const stated = proposals.map((p) => ({ p, target: proposalTarget(config, p) })).filter(({ target }) => target).reverse()
      .sort((a, b) => Number(b.p.status === 'Rejected') - Number(a.p.status === 'Rejected'));
    // The public projection accepts RFC UUIDs only; other valid on-chain targets still get links.
    const publicUuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    const bets = new Map();
    for (const { target } of stated) {
      if (publicUuid.test(target.id) && !bets.has(target.id)) bets.set(target.id, await publicBet(db, target.id));
    }
    for (const entry of stated) {
      let submissionTime;
      try { submissionTime = (await cachedView(chain(), dao, 'get_proposal', { id: Number(entry.p.id) }))?.submission_time; } catch { /* try saved filing */ }
      let filedAt;
      if (!proposalDate(submissionTime) && publicUuid.test(entry.target.id)) {
        const filed = await db.one(`select detail from bilateral_bet_events where bet_id = $1 and kind = 'court_proposal'
          and detail->>'proposalId' = $2 order by id desc limit 1`, [entry.target.id, String(entry.p.id)]);
        filedAt = filed?.detail?.filedAt;
      }
      entry.date = proposalDate(submissionTime, filedAt);
    }
    const tally = (p) => Object.values(p.votes || {}).reduce((n, vote) => ({ ...n, [vote]: (n[vote] || 0) + 1 }), {});
    const body = html`
      <h1 class="court-title">Stated Court</h1>
      ${stated.length ? html`<p class="gut">Every ruling waits ${duration(config.play?.settleDelaySeconds)} on NEAR. The council can vote it down before anyone is paid.</p>` : ''}
      ${stated.length ? html`<ul class="posts evidence-list">${stated.map(({ p, target, date }) => {
        const votes = tally(p);
        const bet = bets.get(target.id);
        const mark = bet?.status === 'settled' && bet.settled_by === 'referee' ? bet.outcome
          : bet?.enclave?.mode === 'ruling' ? bet.enclave.outcome : null;
        return html`<li class="prow court-ruling${p.status === 'Rejected' ? ' rejected' : ''}"><div>
          <p class="said">${bet?.claim ? html`<a class="tl" href="/bets/${target.id}">${markedClaim(bet.claim, mark)}</a>` : html`<span class="quiet">A bet with no public page</span>`}</p>
          <p class="court-action"><b>${councilAction(p.status)}</b>${date ? ` ${date}` : ''}</p>
          <p class="meta">${courtEffect(p, target, bet)} <a class="tl" href="${accountLink(dao)}" rel="noopener noreferrer">${votes.Approve || 0} for, ${votes.Reject || 0} against, on NEAR</a></p>
        </div></li>`;
      })}</ul>` : html`<p class="empty quiet">No rulings yet. Every ruling waits ${duration(config.play?.settleDelaySeconds)} here before anyone is paid.</p>`}
      <div class="folds"><details class="fold"><summary>How the court is set up</summary>
        <p><a class="tl" href="${accountLink(dao)}" rel="noopener noreferrer">${dao}</a> is a Sputnik DAO on NEAR that holds the referee seat of new reply bets.</p>
        ${config.court?.relay ? html`<p>The jury files rulings through <a class="tl" href="${accountLink(config.court.relay)}" rel="noopener noreferrer">${config.court.relay}</a>.</p>` : ''}
        <h2>Members</h2>
        ${(policy.roles || []).map((role) => html`<p><b>${role.name}</b><br>${role.kind?.Group ? role.kind.Group.join(', ') : role.kind === 'Everyone' ? 'everyone' : 'token holders'}</p>`)}
        <p>${policySentence(policy)}</p>
      </details></div>`;
    send(ctx.res, 200, await layout(ctx, 'Stated Court', body, { flush: true }));
  });
}
