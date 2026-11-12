// The public face of Stated Court: one line on a Bet page whose referee is the
// DAO, and /court, which lists the DAO's members, its voting rule and its recent
// Stated proposals. Everything here is read from chain views, cached for 30 s.
// DESIGN.md: existing classes only; account names and votes are plain text.
import { html } from './html.mjs';
import { accountLink } from './near-network.mjs';
import { cachedView, courtDao, proposalTarget } from './court-dao.mjs';
import { publicBet } from './bet-public.mjs';
import { markedClaim } from './bet-view.mjs';

const STATUS = { InProgress: 'open for council votes', Approved: 'approved', Rejected: 'voted down', Removed: 'removed',
  Expired: 'expired', Failed: 'failed', Moved: 'moved' };
const statusWords = (status) => STATUS[status] || 'status unavailable';

/** Identify the DAO referee and its latest proposal. */
export async function courtLine(db, config, chain, bet) {
  const dao = courtDao(config);
  if (!dao || bet?.referee_wallet !== dao) return '';
  const filed = await db.one(`select detail from bilateral_bet_events where bet_id = $1 and kind = 'court_proposal'
    order by id desc limit 1`, [bet.id]);
  let status = null;
  if (filed) {
    try { status = (await cachedView(chain(), dao, 'get_proposal', { id: Number(filed.detail.proposalId) })).status; }
    catch { /* the line still names the referee */ }
  }
  return html`<p class="gut"><a class="tl" href="${accountLink(dao)}" rel="noopener noreferrer">Stated Court</a>, a Sputnik DAO on NEAR, is the referee.${filed
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
    const tally = (p) => Object.values(p.votes || {}).reduce((n, vote) => ({ ...n, [vote]: (n[vote] || 0) + 1 }), {});
    const body = html`
      <h1 class="court-title">Stated Court</h1>
      <p class="gut">Every ruling waits ${duration(config.play?.settleDelaySeconds)} on NEAR. The council can vote it down before anyone is paid.</p>
      <h2 class="lead">Rulings</h2>
      ${stated.length ? html`<ul class="posts evidence-list">${stated.map(({ p, target }) => {
        const votes = tally(p);
        const bet = bets.get(target.id);
        const mark = bet?.status === 'settled' && bet.settled_by === 'referee' ? bet.outcome : null;
        return html`<li class="prow court-ruling${p.status === 'Rejected' ? ' rejected' : ''}"><div>
          <p class="said">${bet?.claim ? html`<a class="tl" href="/bets/${target.id}">${markedClaim(bet.claim, mark)}</a>` : html`<span class="quiet">A bet with no public page here.</span>`}</p>
          <p class="pwho"><b>${p.status === 'Rejected' ? 'Voted down' : target.outcome === 'void' ? 'Undecided' : target.outcome === 'yes' ? 'Yes' : 'No'}</b></p>
          <p class="meta">Proposal ${p.id} is ${statusWords(p.status)}. ${votes.Approve || 0} for, ${votes.Reject || 0} against.</p>
        </div></li>`;
      })}</ul>` : html`<p class="gut quiet">No rulings yet.</p>`}
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
