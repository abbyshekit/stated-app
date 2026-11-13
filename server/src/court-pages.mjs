// The public face of Stated Court: one line on a Bet page whose referee is the
// DAO, and /court, which lists the DAO's members, its voting rule and its recent
// Stated proposals. Everything here is read from chain views, cached for 30 s.
// DESIGN.md: existing classes only; account names and votes are plain text.
import { html } from './html.mjs';
import { accountLink, transactionLink, unit } from './near-network.mjs';
import { formatTestNear } from './near-escrow.mjs';
import { dayMonth } from './marked.mjs';
import { cachedView, courtDao, proposalTarget } from './court-dao.mjs';
import { publicBet, publicBetHall } from './bet-public.mjs';
import { markedClaim } from './bet-view.mjs';
import { juryLogos } from './settlement-view.mjs';
import { outlayerModels } from './outlayer.mjs';
import { baseDecode } from 'near-api-js';

// DESIGN.md: the mainnet referee uses ordinary public rows and a collapsed configuration fold.
async function outlayerCourt({ ctx, db, config, layout, send, chain }) {
  const referee = config.outlayer?.referee;
  if (!referee) return send(ctx.res, 503, await layout(ctx, 'OutLayer referee', html`<h1 class="court-title">OutLayer referee</h1><p class="gut">The referee is not configured. New bets are paused.</p>`, { flush: true }));
  let view; let keys;
  try {
    [view, keys] = await Promise.all([
      chain().view({ contractId: referee, method: 'get_config' }), chain().readAccessKeys(referee),
    ]);
    if (view?.escrow !== config.nearContract || !Array.isArray(keys)) throw new Error('Invalid referee');
  } catch {
    return send(ctx.res, 503, await layout(ctx, 'OutLayer referee', html`<h1 class="court-title">OutLayer referee</h1><p class="gut">The referee could not be checked on NEAR. Retry in a minute.</p><p class="gut"><a class="tl" href="${accountLink(referee)}" rel="noopener noreferrer">${referee}</a></p>`, { flush: true }));
  }
  const hall = await publicBetHall(db);
  const rulings = [];
  for (const row of hall.rows.filter(bet => bet.referee_wallet === referee)) {
    const bet = await publicBet(db, row.id, config.play);
    if (bet?.outcome === 'void' && bet.settled_by === 'referee' && !bet.settlement_transaction_hash) {
      const proof = await db.one(`select detail->>'transactionHash' as hash, detail->>'transactionAttribution' as attribution from bilateral_bet_events
        where bet_id=$1 and actor_user_id=(select creator_user_id from bilateral_bets where id=$1) and kind='referee_resolved'
          and detail->>'outcome'='void' and detail->>'referee'=$2 order by id desc limit 1`, [bet.id, referee]);
      try {
        if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(proof?.hash || '') && baseDecode(proof.hash).length === 32) {
          bet.settlement_transaction_hash = proof.hash;
          bet.settlement_transaction_attribution = proof.attribution || null;
        }
      } catch { /* An invalid stored hash is not a transaction link. */ }
    }
    if (bet?.outlayer?.result || bet?.outlayer?.ruling?.outcome) rulings.push(bet);
  }
  const outcome = (value) => ({ yes: 'Yes', no: 'No', void: 'Void', unclear: 'Undecided' })[value] || 'Pending';
  send(ctx.res, 200, await layout(ctx, 'OutLayer referee', html`
    <h1 class="court-title">OutLayer referee</h1>
    <p class="gut"><a class="tl" href="${accountLink(referee)}" rel="noopener noreferrer">${referee}</a></p>
    <p class="gut">${keys.length} access keys${keys.length === 0 ? '. No account key can change this referee’s code.' : '. This account has access keys; its code can be changed.'}</p>
    <p class="gut"><a class="tl" href="${accountLink(referee)}#contract" rel="noopener noreferrer">View referee code</a></p>
    <p class="gut">The pinned jury rules through OutLayer. The escrow credits the winner, then Stated sends the payout to an account it manages. A claimed account withdraws through its wallet.</p>
    <h2 class="lead">Jury roster</h2>${juryLogos(outlayerModels())}
    <ul class="posts">${outlayerModels().map(model => html`<li class="prow">${model}</li>`)}</ul>
    <h2 class="lead">Rulings</h2>
    ${rulings.length ? html`<ul class="posts evidence-list">${rulings.map(bet => html`<li class="prow"><div>
      <p><a class="tl" href="/bets/${bet.id}/ruling">${bet.claim}</a></p>
      <p>${outcome(bet.outlayer.ruling.outcome || bet.outlayer.result?.outcome)}${bet.settled_at ? `, ${dayMonth(bet.settled_at, { year: true })}` : ''}.</p>
      <p>${bet.settlement_transaction_hash ? html`<a class="tl" href="${transactionLink(bet.settlement_transaction_hash)}" rel="noopener noreferrer">${bet.settlement_transaction_attribution === 'latest_verified_request' ? 'Ruling request' : 'Settlement transaction'}</a>` : 'Settlement transaction not confirmed.'}</p>
    </div></li>`)}</ul>` : html`<p class="empty quiet">No public rulings yet.</p>`}
    <div class="folds"><details class="fold"><summary>Referee configuration</summary>
      <p>Escrow: <a class="tl" href="${accountLink(view.escrow)}">${view.escrow}</a></p>
      <p class="acct">Jury WASM SHA256: ${view.wasm_hash}</p>
      <p>The claim and evidence policy are committed before funding. OutLayer supplies the jury result; Stated has no manual ruling step for these bets.</p>
    </details></div>`, { flush: true }));
}

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
    if (config.near?.real) return outlayerCourt({ ctx, db, config, layout, send, chain });
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
