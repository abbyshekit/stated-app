// The public face of Stated Court: one line on a Bet page whose referee is the
// DAO, and /court, which lists the DAO's members, its voting rule and its recent
// Stated proposals. Everything here is read from chain views, cached for 30 s.
// DESIGN.md: existing classes only; account names and votes are plain text.
import { html } from './html.mjs';
import { accountLink } from './near-network.mjs';
import { cachedView, courtDao, proposalTarget } from './court-dao.mjs';

const STATUS = { InProgress: 'open for council votes', Approved: 'approved', Rejected: 'voted down', Removed: 'removed',
  Expired: 'expired', Failed: 'failed', Moved: 'moved' };
const statusWords = (status) => STATUS[status] || 'status unavailable';

/** "Referee: Stated Court, a Sputnik DAO on NEAR. Proposal <n>: <status>." for a Bet the DAO referees. */
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
  return html`<p class="gut">Referee: <a class="tl" href="${accountLink(dao)}" rel="noopener noreferrer">Stated Court</a>, a Sputnik DAO on NEAR.${filed
    ? ` Proposal ${filed.detail.proposalId}: ${statusWords(status)}.` : ''}</p>`;
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
    const stated = proposals.map((p) => ({ p, target: proposalTarget(config, p) })).filter(({ target }) => target).reverse();
    const known = stated.length ? new Set((await db.many('select id from bilateral_bets where id = any($1::uuid[])',
      [stated.map(({ target }) => target.id)])).map((row) => row.id)) : new Set();
    const tally = (p) => Object.values(p.votes || {}).reduce((n, vote) => ({ ...n, [vote]: (n[vote] || 0) + 1 }), {});
    const body = html`
      <h1>Stated Court</h1>
      <p class="lead"><a class="tl" href="${accountLink(dao)}" rel="noopener noreferrer">${dao}</a> is a Sputnik DAO on NEAR that holds the referee seat of new reply bets.</p>
      ${config.court?.relay ? html`<p class="gut">The jury files each ruling through a contract that cannot approve it until ${config.play?.settleDelaySeconds === 600 ? 'ten minutes' : `${config.play?.settleDelaySeconds} seconds`} have passed. The council can only vote a ruling down or remove it. Nobody can change these rules.</p>
        <p class="meta">Relay: <a class="tl" href="${accountLink(config.court.relay)}" rel="noopener noreferrer">${config.court.relay}</a></p>`
        : html`<p class="gut">The enclave jury files each ruling here as a proposal to settle the bet. The council can vote one down before it pays; otherwise the jury approves it after the correction window and the DAO settles the bet.</p>`}
      <h2>Members</h2>
      <ul class="posts evidence-list">${(policy.roles || []).map((role) => html`<li class="prow"><div>
        <p class="pwho"><b>${role.name}</b></p>
        <p class="meta">${role.kind?.Group ? role.kind.Group.join(', ') : role.kind === 'Everyone' ? 'everyone' : 'token holders'}</p>
      </div></li>`)}</ul>
      <p class="gut">${policySentence(policy)}</p>
      <h2>Recent proposals</h2>
      ${stated.length ? html`<ul class="posts evidence-list">${stated.map(({ p, target }) => {
        const votes = tally(p);
        return html`<li class="prow"><div>
          <p class="pwho"><b>Proposal ${p.id}</b><span>${statusWords(p.status)}</span></p>
          <p class="meta">${known.has(target.id) ? html`<a class="tl" href="/bets/${target.id}">Bet</a>` : 'Bet'} ${target.outcome}<span>${votes.Approve || 0} for, ${votes.Reject || 0} against</span></p>
        </div></li>`;
      })}</ul>` : html`<p class="gut quiet">No proposals yet.</p>`}`;
    send(ctx.res, 200, await layout(ctx, 'Stated Court', body));
  });
}
