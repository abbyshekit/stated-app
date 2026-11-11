// INTEGRATION: Loopback-only demo. Uses the simulated X queue, the same NEAR
// worker as reply Bets, and the same Result recorder as the reviewer screen.
import { html } from '../src/html.mjs';
import { resolveStatement } from '../src/notify.mjs';
import { userByXId } from '../src/store.mjs';

const path = '/demo-challenge';
const prefix = 'TEST FIXTURE: Stated Practice 1.0 ships before ';
const offerWords = '@sim_statedbot bet 0.1 no';
const takeWords = '@sim_statedbot take';
const reviewerId = '1900';
const openRound = (state) => !state.offer;
const canTake = (state) => state.status === 'offered' && state.offer_status === 'done' && !state.take;
const canResolve = (state) => state.status === 'accepted' && state.statement_status === 'open'
  && state.take_status === 'done';
const txHash = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;

function cleanText(post) {
  return [...post.text].slice(post.display_text_range?.[0] || 0).join('');
}

export function demoChallenge({ x, db, config, alice, bob, carol, readiness }) {
  const app = new URL(config.baseUrl);
  const enabled = config.play.enabled && !config.near.real && app.hostname === '127.0.0.1';
  if (!enabled) return () => false;
  let changing = false;

  const findPost = (id, predicate) => [...x.posts.values()].find((post) => post.author_id === id && predicate(post));
  const replyingTo = (post, target) => post.referenced_tweets?.some((ref) => ref.type === 'replied_to' && ref.id === target.id);
  async function read() {
    const root = findPost(alice.id, (post) => post.text.startsWith(prefix));
    const offer = root && findPost(bob.id, (post) => replyingTo(post, root) && cleanText(post) === offerWords);
    const take = offer && findPost(carol.id, (post) => replyingTo(post, offer) && cleanText(post) === takeWords);
    if (!offer) return { root };
    const state = await db.one(`select c.status as offer_status, c.bet_id, b.status, st.id as statement_id,
      st.status as statement_status, t.status as take_status,
      (select r.transaction_hash from bilateral_near_requests r where r.bet_id=b.id and r.user_id=b.acceptor_user_id
         and r.method='accept_bet' and r.execution_status='succeeded' order by r.created_at desc limit 1) as acceptance,
      (select r.transaction_hash from bilateral_near_requests r where r.bet_id=b.id and r.user_id=b.acceptor_user_id
         and r.method='withdraw' and r.execution_status='succeeded' order by r.created_at desc limit 1) as payout
      from bet_commands c left join bilateral_bets b on b.id=c.bet_id
      left join saves s on s.id=b.source_save_id left join statements st on st.id=s.statement_id
      left join bet_commands t on t.event_id=$2 and t.bet_id=b.id
      where c.event_id=$1`, [offer.id, take?.id || null]);
    return { ...state, root, offer, take };
  }

  const form = (action, label) => html`<form method="post" action="${path}/${action}"><button class="primary big" type="submit">${label}</button></form>`;
  const transaction = (hash, label) => txHash.test(hash || '')
    ? html`<a class="tl" href="https://testnet.nearblocks.io/txns/${hash}">${label}</a>` : '';
  async function render(state) {
    const ready = state.offer || await readiness() === 'checked';
    const failed = ['failed', 'refused'].includes(state.offer_status) || ['failed', 'refused'].includes(state.take_status)
      || ['cancelled', 'expired', 'refunded'].includes(state.status);
    const payout = state.status === 'settled' && txHash.test(state.payout || '') ? state.payout : null;
    let action;
    if (payout) action = html`<p><strong>0.2 test NEAR paid to Carol.</strong> ${transaction(payout, 'Open payout')}</p>`;
    else if (failed) action = html`<p>This practice Bet could not complete. <a href="/demo-proof">Check a recorded payout</a>.</p>`;
    else if (!ready) action = html`<p>Waiting for testnet funds. <a href="/demo-readiness">Check escrow</a> or <a href="/demo-proof">verify a recorded payout</a>.</p>`;
    else if (openRound(state)) action = form('start', 'Fund Bob’s offer');
    else if (canTake(state)) action = form('take', 'Stake 0.1 test NEAR on Yes');
    else if (canResolve(state)) action = form('result', 'Record test result');
    else action = html`<p>Waiting for NEAR testnet. <a href="${path}">Refresh status</a>.</p>`;
    return html`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
      <title>Practice a Stated bet</title><link rel="stylesheet" href="/static/stated.css"><link rel="stylesheet" href="/static/skin.css">
      </head><body><div class="wrap"><header><a class="wordmark" href="/">Stated</a></header><main class="pad">
      <h1>Practice a bet</h1><p>Simulated X. Stakes and payout use real NEAR testnet.</p>
      ${state.root ? html`<p>${state.root.text.slice('TEST FIXTURE: '.length)}</p>` : ''}
      ${state.status === 'offered' ? html`<p>Bob offered 0.1 test NEAR on No. You play as Carol.</p>` : ''}
      ${canResolve(state) ? html`<p>Both 0.1 test NEAR stakes are in. Record Yes early to finish the practice round.</p>` : ''}
      ${action}
      ${state.acceptance ? html`<p>${transaction(state.acceptance, 'Open matched stake')}</p>` : ''}
      ${state.root ? html`<a class="tl" href="${x.base}/?c=${state.root.id}">Open simulated thread</a>` : ''}
      ${state.bet_id && state.offer_status === 'done' ? html`<p><a class="tl" href="/bets/${state.bet_id}">Open Bet</a></p>` : ''}
      </main></div></body></html>`;
  }

  async function change(action, state) {
    if (action === 'start' && openRound(state) && await readiness() === 'checked') {
      const due = new Date(Date.now() + 30 * 86400000).toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric', timeZone: 'UTC' });
      const root = state.root || x.post(alice.id, prefix + due + '.');
      x.post(bob.id, offerWords, { replyTo: root.id });
    } else if (action === 'take' && canTake(state)) {
      x.post(carol.id, takeWords, { replyTo: state.offer.id });
    } else if (action === 'result' && canResolve(state)) {
      const reviewer = await userByXId(db, reviewerId);
      if (!reviewer) throw new Error('Simulated reviewer is unavailable');
      await resolveStatement(db, { statementId: state.statement_id, outcome: 'yes',
        note: 'Test fixture. The result was recorded early for the practice round.',
        url: 'https://example.com/stated-practice-result', reviewer, outcomeAt: new Date() });
    }
  }

  return async (req, res) => {
    const get = req.method === 'GET' && req.url === path;
    const post = req.method === 'POST' && /^\/demo-challenge\/(start|take|result)$/.exec(req.url);
    if (!get && !post) return false;
    if (req.headers.host !== app.host || (post && req.headers.origin !== app.origin)) {
      res.writeHead(403).end();
      return true;
    }
    try {
      if (get) {
        const page = await render(await read());
        res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store',
          'content-security-policy': "default-src 'none'; style-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'" });
        res.end(String(page));
      } else {
        if (!changing) {
          changing = true;
          try { await change(post[1], await read()); } finally { changing = false; }
        }
        res.writeHead(303, { location: path }).end();
      }
    } catch (error) {
      console.error('[practice]', error.message);
      res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store' })
        .end('Practice Bet unavailable. Open /demo-proof to check a recorded payout.');
    }
    return true;
  };
}
