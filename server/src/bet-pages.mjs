// INTEGRATION: registered by web.mjs with its existing auth, CSRF and layout.
// DESIGN.md and design/marked govern these pages; skin.css supplies the controls.
import { randomUUID } from 'node:crypto';
import { html, raw } from './html.mjs';
import { UserError } from './store.mjs';
import { betFor, betsFor, createBet, sourceForBet } from './bets.mjs';
import { betDraft } from './bet-draft.mjs';
import { betDateFields, readBetDate } from './bet-date-fields.mjs';
import { betSourceHeader, predictionSourceHeader } from './bet-source-view.mjs';
import { consentToPublicBet, followPublicBet, followsFor, nextOpenPublicBet, publicBet, publishBet, readPublicBet, withdrawBetPublication } from './bet-public.mjs';
import { publishPublicResultEvidence } from './bet-result-evidence.mjs';
import { readAttestedCheck, runAttestedCheck, verificationRecipe } from './attested-check.mjs';
import { createPublicRulingReader, etagMatches } from './public-ruling.mjs';
import { createReadLimiter } from './public-read-limits.mjs';
import { modelFace, modelName } from './jury-models.mjs';
import { courtLine } from './court-pages.mjs';
import { juryLogos, settlementSentence } from './settlement-view.mjs';
import { betBlock, betList, betShareLink, betTerms, betTime, displayBetStatus, markedClaim, nextBetTime } from './bet-view.mjs';
import { facesByUsername } from './certificate.mjs';
import { betLead, betState, dayMonth } from './marked.mjs';
import { formatTestNear, STORAGE_FEE_YOCTO } from './near-escrow.mjs';
import { cancelUnfundedBet, prepareNearAction, syncNearBet } from './near-bets.mjs';
import { syncPendingBetTransactions, verifyBetTransaction, withdrawalView } from './near-execution-state.mjs';
import { latestWalletRequests, walletRequestHistory, walletTransactionForm } from './near-request-view.mjs';
import { ensurePlayAccount, playAccountFor, playAction, shortfall, yocto } from './play.mjs';
import { queueWebMatchNotice } from './reply-bets.mjs';
import { MAX_DEPOSIT_NEAR, MIN_DEPOSIT_NEAR } from './funding.mjs';
import { tokenChoices } from './play-pages.mjs';
import { nearUp, shortAmount } from './intents.mjs';
import { accountLink, inPilot, network, networkName, transactionLink, unit } from './near-network.mjs';
import { X_MARK } from './bet-view.mjs';
import { aboveLimit, limitFor, limitHint, recordFor } from './reputation.mjs';

const ID = '([a-fA-F0-9]{8}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{4}-[a-fA-F0-9]{12})';
const STATUS = { offered: 'Awaiting acceptance', expired: 'Offer expired', accepted: 'Stakes escrowed', proposed: 'Result proposed', disputed: 'Result disputed', settled: 'Result agreed', cancelled: 'Offer cancelled', refunded: 'Stakes refunded' };
const OUTCOME = { yes: 'Came true', no: 'Did not come true', void: 'Void, no winner' };
const STAKES = ['0.1', '0.25', '0.5', '1'];
const time = betTime;
const utc = (value) => /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(value) ? `${value}${value.length === 16 ? ':00' : ''}Z` : value;
const otherSide = (bet) => (bet.creator_side === 'yes' ? 'no' : 'yes');
const enclaveRecipe = `Run node scripts/verify-enclave-ruling.mjs <baseUrl> <betId>. Use verifyEnclaveRecord to check signed request and response hashes, model signatures, material and evidence. Re-fetch Coinbase candles or inspect submitted links and text hashes; compare the public Result. Hardware verification is separate: ${verificationRecipe.verificationCenter}.`;

// A Bet settled by the referee was settled from the post's recorded Result, so its words carry the same
// mark as the post: highlighted if it came true, struck through if it did not. A Bet two people settled
// between themselves never does; their agreement is not a finding of fact.
const refereeRuling = (bet) => (bet.status === 'settled' && (bet.settled_by || bet.chain_state?.resolution?.method) === 'referee' ? bet.outcome : null);
const claimWords = (bet, ruling = refereeRuling(bet)) => markedClaim(bet.claim, ruling);
const claimClass = (claim) => `prop bet-claim${claim.length > 200 ? ' long' : claim.length > 120 ? ' mid' : ''}`;

export function registerBetRoutes({ route, db, config, layout, needUser, needAdmin, isAdmin, needPost, csrfField, send, redirect, notFound, fetchImpl, walletVersion, payVersion, botUsername, chain, quotes = null, allowHeavyRead = null }) {
  const publicRuling = createPublicRulingReader({ recipe: enclaveRecipe });
  // Standalone route registrars retain a budget; createApp supplies its shared export/ruling budget.
  const fallbackBudget = createReadLimiter({ railway: config.hosted && Boolean(process.env.RAILWAY_ENVIRONMENT) });
  // DESIGN.md: only the proposer name is bold in the source attribution.
  const sourceHeader = async (viewer, bet) => {
    const header = String(await betSourceHeader(db, viewer, bet, config.x.simulatedOrigin));
    return raw(header.includes('data-source-author="proposer"')
      ? header.replace(/<b>Offered by ([\s\S]*?)<\/b>/, '<div class="offered-by">Offered by <b>$1</b></div>') : header);
  };
  const juryDecides = (bet) => Boolean(config.nearai?.rulings && bet?.referee_wallet);
  const pendingRuling = (bet) => juryDecides(bet) && ['accepted', 'proposed', 'disputed'].includes(bet.status)
    && bet.enclave?.mode === 'ruling' && ['yes', 'no'].includes(bet.enclave.outcome) ? bet.enclave.outcome : null;
  const recordedRuling = (bet) => refereeRuling(bet) || pendingRuling(bet);
  const evidencePhase = (bet) => juryDecides(bet) && !bet.enclave && bet.evidence?.open;
  const phaseHeading = (bet, viewer) => {
    if (juryDecides(bet) && bet.enclave?.mode === 'ruling' && bet.enclave.outcome === 'unclear'
      && (['accepted', 'proposed', 'disputed', 'refunded'].includes(bet.status) || bet.outcome === 'void')) {
      return { text: 'Undecided', aside: ['settled', 'refunded'].includes(bet.status) ? 'Stakes returned' : 'Both stakes go back' };
    }
    const ruling = pendingRuling(bet);
    if (ruling) {
      const paysAt = new Date(new Date(bet.result_recorded_at || bet.enclave.decidedAt).getTime() + config.play.settleDelaySeconds * 1000);
      const creatorFavoured = ruling === bet.creator_side;
      const username = creatorFavoured ? bet.creator_username : bet.acceptor_username;
      const userId = creatorFavoured ? bet.creator_user_id : bet.acceptor_user_id;
      const mine = viewer && (String(viewer.id) === String(userId)
        || (viewer.x_username && username && viewer.x_username.toLowerCase() === username.toLowerCase()));
      const winner = mine ? 'You' : username ? `@${username}` : `The ${ruling} side`;
      return { text: `${winner} won`, aside: `Pays out ${nextBetTime(paysAt)}` };
    }
    const participant = viewer && [bet.creator_user_id, bet.acceptor_user_id].some(id => id != null && String(id) === String(viewer.id));
    if (evidencePhase(bet)) return { text: participant ? 'Links are open' : 'Both sides are in', aside: `Links close ${nextBetTime(bet.evidence.closesAt)}` };
    return juryDecides(bet) && !bet.enclave && bet.evidence && !bet.evidence.open
      && ['accepted', 'proposed', 'disputed'].includes(bet.status)
      ? { text: 'The NEAR AI enclave jury is deciding', aside: `Links closed ${betTime(bet.evidence.closesAt)}` } : null;
  };
  const copyBetLink = (bet) => html`
    <a class="tl" id="bet-link" href="${config.baseUrl}${pathFor(bet.id)}">Copy link</a>
    <button class="tl" type="button" data-copy="bet-link" hidden>Copy link</button>
    <span class="visually-hidden" role="status" data-copy-status></span>
    <script src="/static/pay.js?v=${payVersion}" defer></script>`;
  async function replyToOffer(bet) {
    // Only the bot's already published offer may be exposed here. A user's
    // command or the source prediction may have a different visibility.
    const offer = await db.one(`select post_id from bot_outbox
      where bet_id=$1 and dedupe_key=$2 and status='sent'`, [bet.id, `offer:${bet.id}`]);
    if (!/^\d{1,25}$/.test(offer?.post_id || '')) return '';
    if (config.x.simulatedOrigin) {
      return html`<a class="tl" href="${config.x.simulatedOrigin}/?c=${offer.post_id}&amp;take=1">Reply in simulated X</a>`;
    }
    const bot = await botUsername();
    if (!/^\w{1,15}$/.test(bot)) return '';
    const intent = new URL('https://x.com/intent/tweet');
    intent.searchParams.set('in_reply_to', offer.post_id);
    intent.searchParams.set('text', `@${bot} take`);
    return html`<a class="tl" href="${intent}" rel="noopener noreferrer">Reply on X</a>`;
  }
  async function ready(ctx) {
    if (!(await needUser(ctx))) return false;
    if (!ctx.user.setup_completed_at) {
      redirect(ctx.res, `/setup?return=${encodeURIComponent(ctx.url.pathname + ctx.url.search)}`);
      return false;
    }
    return true;
  }

  const show = async (ctx, title, body, { status = 200, back = '/me/bets' } = {}) => send(ctx.res, status,
    await layout(ctx, title, body, { kind: 'private', flush: true, back }), { kind: 'private' });
  const pathFor = (id) => `/bets/${id}`;
  // The testnet account this person last used, so they do not retype it for every Bet.
  const lastWallet = async (user) => (await db.one(
    `select w from (select creator_wallet as w, created_at from bilateral_bets where creator_user_id=$1 and creator_wallet is not null
       union all select acceptor_wallet, coalesce(accepted_at, created_at) from bilateral_bets where acceptor_user_id=$1 and acceptor_wallet is not null) t
     order by created_at desc limit 1`, [String(user.id)]))?.w || '';
  const walletField = (value = '') => html`<label>${networkName()} account<input type="text" name="accountId" value="${value}" required maxlength="64" autocomplete="off"></label>`;
  const mutationForm = (ctx, bet, action, label, { primary = false } = {}) => html`
    <form method="post" action="${pathFor(bet.id)}/${action}">
      ${csrfField(ctx)}${action === 'cancel' && !bet.chain_state ? '' : walletField(String(bet.creator_user_id) === String(ctx.user.id) ? bet.creator_wallet || '' : bet.acceptor_wallet || '')}<button${primary ? html` class="primary big"` : ''} type="submit">${label}</button>
    </form>`;
  const faces = (ctx, bet) => facesByUsername(db, [bet.creator_username, bet.acceptor_username], ctx.user);
  const fold = (title, body, { open = false, id = null } = {}) => html`<details class="fold"${id ? html` id="${id}"` : ''}${open ? ' open' : ''}><summary>${title}</summary>${body}</details>`;

  // DESIGN.md: supporting text stays separate from each 44px link row.
  async function enclaveDetail(bet) {
    if (!bet) return '';
    const ruling = bet.enclave;
    const settledJury = ruling && ['settled', 'refunded'].includes(bet.status);
    const settlement = settledJury ? await settlementSentence(db, config, bet) : '';
    let line = '';
    if (ruling) {
      const price = ruling.source === 'coinbase-candles';
      const source = price ? `Coinbase’s ${ruling.product} price` : 'the links both sides posted';
      if (ruling.mode === 'review' && ruling.agrees !== null) {
        line = `A Stated reviewer recorded ${bet.outcome === 'yes' ? 'Yes' : 'No'} on ${dayMonth(bet.result_recorded_at || bet.settled_at)}. The jury ${ruling.agrees ? 'agreed' : 'disagreed'} on ${dayMonth(ruling.decidedAt)}.`;
      } else if (ruling.mode === 'review') {
        line = `The NEAR AI enclave jury could not decide from ${source}.`;
      } else if (bet.status === 'settled' && bet.outcome !== (ruling.outcome === 'unclear' ? 'void' : ruling.outcome)) {
        line = 'A reviewer corrected the enclave’s ruling.';
      } else if (ruling.outcome === 'unclear') {
        line = ['settled', 'refunded'].includes(bet.status) && (bet.outcome === 'void' || bet.status === 'refunded')
          ? 'The NEAR AI enclave jury could not agree.' : 'The enclave jury could not decide.';
      } else {
        line = `A NEAR AI enclave jury ruled from ${source}.`;
      }
    } else if (bet.evidence?.open) {
      line = 'Then a NEAR AI enclave jury reads both sides’ links and decides.';
    }
    const check = !ruling && config.nearai?.apiKey ? await db.tx(tx => readAttestedCheck(tx, bet)) : null;
    // While the jury works, its three models are on the page, as they are on the ruling.
    const deciding = juryDecides(bet) && !ruling && bet.evidence && !bet.evidence.open
      && ['accepted', 'proposed', 'disputed'].includes(bet.status);
    const jury = deciding ? html`<ul class="jury-rail deciding" aria-label="The NEAR AI enclave jury">${[...new Set(config.nearai?.rulingModels || [])]
      .map(model => html`<li class="seat">${modelFace(model)}<b>${modelName(model)}</b><span>Deciding</span></li>`)}</ul>` : '';
    const items = bet.evidence?.items || [];
    const privateCount = bet.evidence?.privateItemCount || 0;
    const evidenceLabel = `Links, ${items.length}`;
    const evidence = (items.length || privateCount) ? fold(evidenceLabel, html`<ul>${items.map(item => {
      let url = null; let host = null; let postedHost = null;
      try {
        const parsed = new URL(item.url);
        if (parsed.protocol === 'https:' && !parsed.username && !parsed.password) { url = parsed.href; host = parsed.host; }
        const posted = new URL(item.postedUrl || item.url);
        if (host && posted.host !== host) postedHost = posted.host;
      } catch { /* Old stored links still render as text. */ }
      return html`<li><p>Bet ${item.side}: ${url ? html`<a class="tl" href="${url}" rel="noopener noreferrer">${item.title || host}</a>` : item.title || item.url}${item.by ? `, @${item.by}` : ''}${host ? html` <span class="quiet">${host}</span>` : ''}${postedHost ? html` <span class="quiet">posted as ${postedHost}</span>` : ''}</p></li>`;
    })}</ul>${privateCount ? html`<p class="quiet">and ${privateCount} ${privateCount === 1 ? 'link from a private bet' : 'links from private bets'}</p>` : ''}`) : bet.evidence ? html`<p class="gut quiet">No links yet.</p>` : '';
    return html`${settledJury ? juryLogos(ruling.models) : await courtLine(db, config, chain, bet)}${line || settlement ? settledJury
      ? html`<p class="gut settlement-line">${settlement || line}</p>${!privateCount ? html`<p class="gut link-row"><a class="tl" href="/bets/${bet.id}/ruling">See the ruling</a></p>` : ''}`
      : html`<p class="gut">${line}${ruling && !privateCount ? html` <a class="tl" href="/bets/${bet.id}/ruling">See the ruling</a>` : ''}</p>`
      : check ? html`<p class="gut">NEAR AI signed second opinion: ${check.model} read the links and ${check.verdict.agrees ? 'agrees' : 'disagrees'}. <a class="tl" href="/bets/${bet.id}/attested-check.json">Verify</a></p>` : ''}${jury}${evidence}`;
  }

  // Dry-run comparison. An actual top-up starts from the signed-in Bet
  // review, which can price the account's shortfall instead of the stake.
  async function payFold(ctx, bet) {
    if (!quotes || (network().real && config.intents?.deposits)) return '';
    const list = await quotes.tokens();
    if (!list.length) return '';
    const asked = ctx.url.searchParams.get('pay');
    const chosen = list.find((t) => t.assetId === asked) || list.find((t) => t.symbol === 'USDC' && t.chain === 'base') || list[0];
    const quote = asked ? await quotes.quote(chosen.assetId, bet.stake_yocto) : null;
    const stake = formatTestNear(bet.stake_yocto);
    const where = html`${chosen.symbol} on ${chosen.chainName}`;
    let line = '';
    if (quote?.ok) {
      line = html`<p class="payline">For ${stake} NEAR, NEAR Intents quotes <b>${shortAmount(quote.amount)} ${chosen.symbol}</b> on ${chosen.chainName}${quote.seconds ? `, with an estimated transfer time of ${quote.seconds} seconds` : ''}.</p>`;
    } else if (quote?.reason === 'minimum') {
      line = html`<p class="payline">${where} moves at least ${nearUp(quote.minimumYocto)} NEAR at a time. This stake is ${stake}.</p>`;
    } else if (quote) line = html`<p class="payline">No quote for ${where} right now.</p>`;
    const note = html`NEAR Intents dry-run quote${quote?.ok ? html` from ${time(quote.at)}` : ''}. Requesting a quote moves no funds.`;
    return html`<details class="fold" id="pay"${asked ? ' open' : ''}><summary>Cross-chain quote${quote?.ok ? html`<small>${shortAmount(quote.amount)} ${chosen.symbol}</small>` : ''}</summary>
      ${line}
      <form class="payfrom" method="get" action="${pathFor(bet.id)}#pay">
        <label for="pay-with">Quote in</label>
        <select id="pay-with" name="pay">${tokenChoices(list, chosen.assetId)}</select>
        <button type="submit">Get a quote</button>
      </form>
      <p class="quiet">${note}</p>
    </details>`;
  }

  function managedOffer(bet, user, account) {
    return config.play?.enabled && betState(bet).open && Boolean(bet.referee_wallet)
      && bet.chain_state?.referee === bet.referee_wallet
      && String(bet.creator_user_id) !== String(user.id)
      && (!bet.invited_user_id || String(bet.invited_user_id) === String(user.id))
      && (!bet.invited_wallet || account?.account_id === bet.invited_wallet)
      && !account?.claimed_at && account?.account_id !== bet.chain_state.creator
      && account?.account_id !== bet.referee_wallet;
  }

  async function managedTake(ctx, bet, account, published) {
    if (!published || !managedOffer(bet, ctx.user, account)) return null;
    const real = config.near?.real;
    const wallet = `/me/wallet?bet=${bet.id}`;
    if (real && !account?.ready) {
      return html`<div class="acts" id="accept"><a class="pill solid big" href="${wallet}">Open my account</a></div>`;
    }
    if (real) {
      let missing;
      try { missing = await shortfall(config, chain(), account, bet.stake_yocto); }
      catch { return null; }
      if (missing !== '0') {
        // Registration and unwrap may also draw fees from this wallet during
        // checkout. The signing route rechecks the exact reserve at acceptance.
        const withFees = BigInt(missing) + BigInt(yocto('0.01'));
        const minimum = BigInt(yocto(MIN_DEPOSIT_NEAR));
        const add = nearUp((withFees < minimum ? minimum : withFees).toString());
        const canQuote = quotes && config.intents?.deposits && BigInt(yocto(add)) <= BigInt(yocto(MAX_DEPOSIT_NEAR));
        return html`<p class="stakes">Add NEAR to your Stated account for the ${formatTestNear(bet.stake_yocto)} NEAR stake and network fees.</p>
          <div class="acts" id="accept"><a class="pill solid big" href="${canQuote ? `${wallet}&add=${add}#add` : wallet}">Add ${add} NEAR</a></div>`;
      }
    }
    const stake = formatTestNear(bet.stake_yocto);
    return html`<p class="stakes">${account?.ready ? `Stake ${stake} ${unit()} from your Stated account.` : `Stated opens an account for you and stakes ${stake} ${unit()}.`}</p>
      <div class="acts"><form method="post" action="${pathFor(bet.id)}/take" id="accept" data-managed-take="${bet.id}">
        ${csrfField(ctx)}<input type="hidden" name="termsHash" value="${bet.terms_hash}">
        <label class="check"><input type="checkbox" name="publicConsent" value="1" required><span>Show my X name and wallet on this public bet.</span></label>
        <button class="primary big" type="submit">Bet ${otherSide(bet)}</button>
      </form><span class="visually-hidden" role="status" id="managed-take-status"></span></div>
      <script src="/static/pay.js?v=${payVersion}" defer></script>`;
  }

  async function takeLimit(ctx, bet) {
    if (!ctx.user || config.play?.reputationTiers === null) return null;
    const record = await recordFor(db, ctx.user.id);
    const limit = limitFor(config, record);
    return aboveLimit(formatTestNear(bet.stake_yocto), limit)
      ? limitHint(config, record) || `Your limit is ${limit} ${unit()}.` : null;
  }

  async function publicPage(ctx, bet) {
    const join = `${pathFor(bet.id)}?join=1#accept`;
    const { open, expired } = betState(bet);
    const take = otherSide(bet);
    const eligible = !ctx.user || inPilot(config, ctx.user.x_user_id);
    const mine = Boolean(ctx.user?.x_username && bet.creator_username && ctx.user.x_username.toLowerCase() === bet.creator_username.toLowerCase());
    const limited = open && eligible && !mine ? await takeLimit(ctx, bet) : null;
    const reply = open && eligible && !mine && !limited && bet.referee_wallet ? await replyToOffer(bet) : '';
    const followPrimary = !pendingRuling(bet) && (['accepted', 'proposed', 'disputed'].includes(bet.status)
      || (open && ctx.user && ctx.url.searchParams.get('follow') === '1'));
    const following = ctx.user && (followPrimary || ctx.url.searchParams.get('done') === 'following')
      && await db.one('select 1 from bilateral_bet_follows where bet_id=$1 and user_id=$2', [bet.id, ctx.user.id]);
    const followLabel = 'Follow result';
    const follow = ctx.user ? html`<form method="post" action="${pathFor(bet.id)}/follow" id="follow">
      ${csrfField(ctx)}<button class="${followPrimary ? 'primary big' : 'tl'}" type="submit">${followLabel}</button></form>`
      : html`<a class="${followPrimary ? 'pill solid big' : 'tl'}" href="/signin?return=${encodeURIComponent(`${pathFor(bet.id)}?follow=1#follow`)}">${followLabel}</a>`;
    const closed = expired || ['settled', 'cancelled', 'refunded', 'expired'].includes(bet.status);
    // With bets from replies on, a finished Bet's one filled action starts the next one.
    // That page lists the open offers too, so this one does not also point at one.
    const start = closed && eligible && config.play?.enabled ? `/bets/new?from=${bet.id}` : null;
    const next = eligible && closed && !start ? await nextOpenPublicBet(db, ctx.user?.id) : null;
    const juryRefunded = bet.enclave?.mode === 'ruling' && bet.enclave.outcome === 'unclear'
      && (bet.status === 'refunded' || (bet.status === 'settled' && bet.outcome === 'void'));
    const share = betShareLink(config.baseUrl, bet, { mine: false, ghost: Boolean(next || start), label: juryRefunded ? 'Post on X' : pendingRuling(bet) ? 'Post the result' : null });
    let primary = share;
    if (next) primary = html`<a class="pill solid big" href="${pathFor(next.id)}">Take another bet</a>`;
    if (start) primary = html`<a class="pill solid big" href="${start}">${bet.enclave?.mode === 'ruling' && bet.enclave.outcome === 'unclear' && (bet.status === 'refunded' || bet.outcome === 'void') ? 'Make another bet' : 'Make your own bet'}</a>`;
    if (followPrimary) primary = following ? '' : follow;
    else if (open) {
      if (!eligible) primary = html`<p class="stakes">Bets with real NEAR are invite-only for now.</p>`;
      else if (limited) primary = html`<p class="quiet" id="accept">${limited}</p>`;
      else primary = ctx.user ? html`<a class="pill solid big" href="${join}">Bet ${take}</a>`
        : html`<a class="pill solid big" href="/signin?return=${encodeURIComponent(join)}">Bet ${take}</a>`;
    }
    const evidence = bet.result_evidence;
    const proof = bet.settlement_transaction_hash
      ? html`<p class="proof"><a class="tl" href="${transactionLink(bet.settlement_transaction_hash)}" rel="noopener noreferrer">Verify settlement</a></p>`
      : '';
    send(ctx.res, 200, await layout(ctx, bet.claim.slice(0, 80), html`
      <h1 class="visually-hidden" data-bet-outcome="${bet.outcome || (bet.status === 'refunded' ? 'void' : 'pending')}" data-bet-claim="${bet.claim}" data-bet-deadline="${bet.resolve_at}" data-bet-terms-hash="${bet.terms_hash}">Bet: ${bet.claim}</h1>
      <div class="pri">${await sourceHeader(null, bet)}
      <p class="${claimClass(bet.claim)}">${claimWords(bet, recordedRuling(bet))}</p>${await betSourceHeader(db, null, bet, config.x.simulatedOrigin, { timestamp: true })}</div>
      ${betBlock(bet, { heading: phaseHeading(bet, ctx.user), ruling: pendingRuling(bet), cameTrue: recordedRuling(bet) === 'yes', viewer: ctx.user, faces: await faces(ctx, bet), joinHref: open && eligible && !limited ? join : null })}
      ${proof}
      ${evidence ? html`<p class="gut">${evidence.note}</p><p class="proof"><a class="tl" href="${evidence.url}" rel="noopener noreferrer">Result source</a></p>` : ''}
      ${await enclaveDetail(bet)}
      ${bet.settlement_transaction_hash && isAdmin(ctx.user) ? html`<p class="gut"><a class="tl" href="/admin/bets/${bet.id}/evidence">${evidence ? 'View evidence record' : 'Publish evidence'}</a></p>` : ''}
      ${following ? html`<p class="notice" role="status">Following. Updates will appear in your Inbox.</p>` : ''}
      <div class="acts">${primary}<div class="two">${open ? reply : next || start ? share : ''}</div></div>
      <div class="folds">${fold('Share options', html`${open ? copyBetLink(bet) : ''}<p>${open ? betShareLink(config.baseUrl, bet, { mine: false, ghost: true }) : ''}<a class="tl" href="/share/bets/${bet.id}.png" download="stated-bet-${bet.id}.png">Save image</a></p>${open && !followPrimary ? follow : ''}`)}${betTerms(bet, { juryReview: juryDecides(bet), extra: html`${evidence ? html`<dt>Outcome known</dt><dd>${time(evidence.knownAt)}</dd><dt>Settlement recorded</dt><dd>${time(bet.settled_at)}</dd><dt>Explanation published</dt><dd>${time(evidence.publishedAt)}. Published after settlement.</dd>` : ''}<dt>Checked on NEAR</dt><dd>${bet.last_verified_at ? `Last verified ${time(bet.last_verified_at)}.` : 'Chain verification is unavailable.'}${bet.chain_freshness === 'stale' ? ' This snapshot may have changed. Acceptance checks the chain again.' : ''}</dd>` })}${open ? await payFold(ctx, bet) : ''}</div>`, {
      kind: 'public', flush: true, back: ctx.user ? '/me/bets' : null, signin: Boolean(ctx.user),
      og: { title: `${betLead(bet).text} on Stated`, description: bet.claim.slice(0, 200), image: `/share/bets/${bet.id}.png` },
    }), { kind: 'public' });
  }

  async function evidencePage(ctx, bet, { error = null, typed = {}, status = 200 } = {}) {
    const evidence = bet.result_evidence;
    const hasCheck = config.nearai?.apiKey && evidence && await db.one(`select 1 from bilateral_bet_events
      where bet_id=$1 and kind='attested_check' limit 1`, [bet.id]);
    await show(ctx, 'Public Result evidence', html`
      <div class="hero"><h1>Public Result evidence</h1></div>
      <p class="prop">${bet.claim}</p>
      <p class="gut">Stated settled this Bet ${bet.outcome === 'yes' ? 'Yes' : 'No'}; recorded ${time(bet.settled_at)}.</p>
      ${error ? html`<p class="err" role="alert">${error.message}</p>` : ''}
      ${evidence ? html`<p class="gut">Evidence already published. This record cannot be replaced.</p><p class="gut">${evidence.note}</p><p class="proof"><a class="tl" href="${evidence.url}" rel="noopener noreferrer">Evidence</a></p><p class="gut">Outcome known ${time(evidence.knownAt)}. Explanation published ${time(evidence.publishedAt)}.</p>` : html`
        <p class="gut">This explanation, link and outcome date become public on this Bet. Publish only material intended for everyone.</p>
        <form method="post" action="/admin/bets/${bet.id}/evidence">${csrfField(ctx)}<div class="gut">
          <label for="result-note">Public explanation</label><textarea id="result-note" name="note" required maxlength="600">${typed.note || ''}</textarea>
          <label for="result-url">Public evidence link</label><input id="result-url" type="url" name="url" required maxlength="2048" value="${typed.url || ''}">
          <label for="result-known">Outcome known (UTC)</label><input id="result-known" type="datetime-local" name="knownAt" required step="1" value="${String(typed.knownAt || '').replace(/(?:\.\d{3})?Z$/, '')}">
          </div><div class="acts"><button class="primary big" type="submit">Publish evidence</button></div>
        </form>`}
      ${config.nearai?.apiKey && evidence && !hasCheck ? html`<form method="post" action="/admin/bets/${bet.id}/attested-check">${csrfField(ctx)}<div class="acts"><button class="primary big" type="submit">Run enclave check</button></div></form>` : ''}
      <p class="gut"><a class="tl" href="${pathFor(bet.id)}">View bet</a></p>`, { status, back: pathFor(bet.id) });
  }

  route('GET', new RegExp(`^/admin/bets/${ID}/evidence$`), async (ctx) => {
    if (!(await needAdmin(ctx))) return;
    const bet = await publicBet(db, ctx.params[0]);
    if (!bet?.settlement_transaction_hash) return notFound(ctx);
    await evidencePage(ctx, bet);
  });

  route('GET', new RegExp(`^/bets/${ID}/attested-check\\.json$`), async (ctx) => {
    if (!config.nearai?.apiKey) return notFound(ctx);
    const bet = await publicBet(db, ctx.params[0]);
    const check = bet && await db.tx((tx) => readAttestedCheck(tx, bet));
    if (!check) return notFound(ctx);
    send(ctx.res, 200, JSON.stringify({ ...check, verificationRecipe }), {
      headers: { 'content-type': 'application/json; charset=utf-8' },
    });
  });

  route('GET', new RegExp(`^/bets/${ID}/enclave-ruling\\.json$`), async (ctx) => {
    if (allowHeavyRead) {
      if (!allowHeavyRead(ctx)) return;
    } else {
      const budget = fallbackBudget(ctx.req);
      if (!budget.allowed) return send(ctx.res, 429, JSON.stringify({ error: 'Too many downloads. Retry after the indicated delay.' }), {
        kind: 'private', headers: { 'content-type': 'application/json; charset=utf-8', 'retry-after': String(budget.retryAfter) },
      });
    }
    const result = await db.tx(tx => publicRuling(tx, ctx.params[0]));
    if (!result) return notFound(ctx);
    send(ctx.res, etagMatches(ctx.req.headers['if-none-match'], result.etag) ? 304 : 200,
      etagMatches(ctx.req.headers['if-none-match'], result.etag) ? '' : result.body, {
      headers: { 'content-type': 'application/json; charset=utf-8', etag: result.etag },
    });
  });

  route('POST', new RegExp(`^/admin/bets/${ID}/attested-check$`), async (ctx) => {
    if (!(await needAdmin(ctx))) return;
    if (!(await needPost(ctx))) return;
    if (!config.nearai?.apiKey) return notFound(ctx);
    try {
      await runAttestedCheck(db, config, ctx.params[0], ctx.user.id, { fetchImpl });
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      const bet = await publicBet(db, ctx.params[0]);
      if (!bet?.settlement_transaction_hash) return notFound(ctx);
      return evidencePage(ctx, bet, { error, status: error.status });
    }
    redirect(ctx.res, `/admin/bets/${ctx.params[0]}/evidence`);
  });

  route('POST', new RegExp(`^/admin/bets/${ID}/evidence$`), async (ctx) => {
    if (!(await needAdmin(ctx))) return;
    const form = await needPost(ctx);
    if (!form) return;
    const typed = Object.fromEntries(['note', 'url', 'knownAt'].map((key) => [key, String(form.get(key) || '')]));
    let knownAt = typed.knownAt;
    if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?$/.test(knownAt)) {
      const date = new Date(`${knownAt}${knownAt.length === 16 ? ':00' : ''}Z`);
      if (Number.isFinite(date.getTime()) && date.toISOString().slice(0, knownAt.length) === knownAt) knownAt = date.toISOString();
    }
    try {
      await db.tx(async (tx) => {
        // Lock before the public read: concurrent approvals share one immutable event.
        await tx.one('select id from bilateral_bets where id=$1 for update', [ctx.params[0]]);
        const bet = await readPublicBet(tx, ctx.params[0]);
        if (!bet?.settlement_transaction_hash) throw new UserError('This public referee settlement is unavailable.', 404);
        await publishPublicResultEvidence(tx, ctx.user.id, bet, { ...typed, knownAt });
      });
    } catch (error) {
      if (!(error instanceof UserError)) throw error;
      const bet = await publicBet(db, ctx.params[0]);
      if (!bet?.settlement_transaction_hash) return notFound(ctx);
      return evidencePage(ctx, bet, { error, typed, status: error.status });
    }
    redirect(ctx.res, `/admin/bets/${ctx.params[0]}/evidence`);
  });

  route('GET', /^\/me\/bets$/, async (ctx) => {
    if (!(await ready(ctx))) return;
    const bets = await betsFor(db, ctx.user);
    const following = await followsFor(db, ctx.user);
    const listFaces = await facesByUsername(db, [...bets, ...following].flatMap((bet) => [bet.creator_username, bet.acceptor_username]), ctx.user);
    await show(ctx, 'Bets', html`
      <div class="hero"><h1>Bets</h1></div>
      <div class="acts"><a class="pill solid big" href="/me/bets/new">Make a bet</a></div>
      ${bets.length ? betList(bets, { viewer: ctx.user, faces: listFaces }) : html`<p class="blank">No bets yet. Open a prediction and bet on it, or make one from scratch.</p>`}
      ${following.length ? html`<h2 class="lead">Following</h2>${betList(following, { viewer: ctx.user, faces: listFaces })}` : ''}
    `, { back: '/me' });
  });

  async function newBetPage(ctx, values = {}, error = null) {
    if (!(await ready(ctx))) return;
    const saveId = values.sourceSaveId || ctx.url.searchParams.get('save');
    const save = saveId && /^\d{1,18}$/.test(saveId) ? await sourceForBet(db, ctx.user, saveId) : null;
    const draft = { ...betDraft(save, { side: ctx.url.searchParams.get('side') }), ...values };
    const text = (value) => (value == null ? '' : String(value));
    const termsOpen = Boolean(error) || (!save && !draft.claim) || !draft.criteria || !draft.evidenceSourceUrl;
    const stakes = STAKES.includes(text(draft.stakeNear)) || !text(draft.stakeNear) ? STAKES : [...STAKES, text(draft.stakeNear)];
    const stakeNow = text(draft.stakeNear) || '0.1';
    const needDates = !draft.acceptBy || !draft.resolveAt;
    await show(ctx, 'Make a bet', html`
      ${error && !draft.acceptByError && !draft.resolveAtError ? html`<p class="notice" role="alert">${error.message}</p>` : ''}
      <form method="post" action="/me/bets">
        ${csrfField(ctx)}<input type="hidden" name="requestId" value="${draft.requestId || randomUUID()}">
        ${save ? html`<input type="hidden" name="sourceSaveId" value="${save.save_id}">` : ''}
        ${save ? await predictionSourceHeader(db, ctx.user, save, config.x.simulatedOrigin) : ''}
        ${save && draft.claim ? html`<p class="prop">${draft.claim}</p>` : ''}
        <p class="lead">Your bet</p>
        <div class="seg" role="radiogroup" aria-label="Your side">
          <input type="radio" id="side-yes" name="creatorSide" value="yes"${draft.creatorSide === 'no' ? '' : ' checked'}><label for="side-yes">Bet yes</label>
          <input type="radio" id="side-no" name="creatorSide" value="no"${draft.creatorSide === 'no' ? ' checked' : ''}><label for="side-no">Bet no</label>
        </div>
        <p class="lead">Stake</p>
        <div class="seg" role="radiogroup" aria-label="Stake each, in ${unit()}">
          ${stakes.map((value, i) => html`<input type="radio" id="stake-${i}" name="stakeNear" value="${value}"${value === stakeNow ? ' checked' : ''}><label for="stake-${i}">${value}</label>`)}
        </div>
        <p class="stakes">${unit()} each</p>
        ${needDates ? html`<div class="dates">
          <p class="lead">When</p>
          <p>${text(draft.dateOrigin)}. A bet has to finish within a year.</p>
          ${betDateFields({ name: 'acceptBy', label: 'Open for takers until', value: draft.acceptBy, parts: draft.acceptByParts, error: Boolean(draft.acceptByInvalid), errorText: draft.acceptByError })}
          ${betDateFields({ name: 'resolveAt', label: 'Result after', value: draft.resolveAt, parts: draft.resolveAtParts, error: Boolean(draft.resolveAtInvalid), errorText: draft.resolveAtError })}
        </div>` : ''}
        <div class="acts"><button class="primary big" type="submit">Offer the bet</button></div>
        <div class="folds">
          ${fold('Rules', html`
            <p class="quiet">${text(draft.wordingOrigin)}.</p>
            <label for="claim">Bet proposition</label>
            <textarea id="claim" name="claim" required maxlength="1000" rows="3">${text(draft.claim)}</textarea>
            <label for="criteria">What counts as coming true?</label>
            <textarea id="criteria" name="criteria" required maxlength="2000" rows="6">${text(draft.criteria)}</textarea>
            <label for="source">Agreed link source</label>
            <input type="url" id="source" name="evidenceSourceUrl" required maxlength="2048" value="${text(draft.evidenceSourceUrl)}">
            <p class="quiet">A link both sides can check when the deadline passes.</p>
            ${needDates ? '' : html`<h3>Dates</h3>
            <p class="quiet">${text(draft.dateOrigin)}.</p>
            ${betDateFields({ name: 'acceptBy', label: 'Accept before', value: draft.acceptBy, parts: draft.acceptByParts, error: Boolean(draft.acceptByInvalid), errorText: draft.acceptByError })}
            ${betDateFields({ name: 'resolveAt', label: 'Resolve after', value: draft.resolveAt, parts: draft.resolveAtParts, error: Boolean(draft.resolveAtInvalid), errorText: draft.resolveAtError })}`}
            <h3>Name someone</h3>
            <label for="opponent">Opponent’s X handle (optional)</label>
            <input type="text" id="opponent" name="opponentUsername" value="${text(draft.opponentUsername)}" maxlength="40" autocomplete="off">
            <label for="opponent-account">Opponent’s ${network().id} account</label>
            <input type="text" id="opponent-account" name="opponentAccount" value="${text(draft.opponentAccount)}" maxlength="64" autocomplete="off">
            <p class="quiet">Required when naming an X opponent. Leave both fields blank for an open invitation.</p>`, { open: termsOpen })}
          ${fold('How it works', html`
            <p class="quiet">More than zero, up to 1 ${unit()} each. The proposer also pays ${formatTestNear(STORAGE_FEE_YOCTO)} ${unit()} for contract storage.</p>
            <p class="quiet">${network().real ? 'This bet uses real NEAR.' : 'Test NEAR has no monetary value.'} Wallets deposit directly into the escrow contract. Wallet addresses, stake amounts, deadlines and results are public on NEAR; profile privacy cannot remove them. Prediction text and notes stay off-chain. Both participants must agree within seven days after resolution opens, or each can reclaim their stake.</p>`)}
        </div>
      </form>
    `, { status: error?.status || 200, back: save ? `/me/s/${save.save_id}` : '/me' });
  }
  route('GET', /^\/me\/bets\/new$/, (ctx) => newBetPage(ctx));

  route('POST', /^\/me\/bets$/, async (ctx) => {
    const form = await needPost(ctx);
    if (!form) return;
    const input = Object.fromEntries(['requestId', 'claim', 'criteria', 'evidenceSourceUrl', 'creatorSide', 'stakeNear', 'opponentUsername', 'opponentAccount', 'sourceSaveId'].map((key) => [key, form.get(key)]));
    const acceptDate = readBetDate(form, 'acceptBy');
    const resolveDate = readBetDate(form, 'resolveAt');
    input.acceptBy = utc(acceptDate.value);
    input.resolveAt = utc(resolveDate.value);
    input.acceptByParts = acceptDate.parts;
    input.resolveAtParts = resolveDate.parts;
    input.acceptByError = acceptDate.error || '';
    input.resolveAtError = resolveDate.error || '';
    input.acceptByInvalid = Boolean(acceptDate.error || !acceptDate.value);
    input.resolveAtInvalid = Boolean(resolveDate.error || !resolveDate.value);
    let bet;
    try {
      if (acceptDate.error || resolveDate.error) throw new UserError(acceptDate.error || resolveDate.error);
      bet = await createBet(db, ctx.user, input);
    }
    catch (error) {
      if (error instanceof UserError && [400, 409].includes(error.status)) return newBetPage(ctx, input, error);
      throw error;
    }
    redirect(ctx.res, pathFor(bet.id));
  });

  // A failed deposit or reply comes back here, on the Bet, with the reason above
  // the action it belongs to. Missing pages and sign-in errors keep their own page.
  const recoverable = (error) => error instanceof UserError && ![401, 403, 404].includes(error.status);

  async function betPage(ctx, { failed = null, typed = null } = {}) {
    const published = await publicBet(db, ctx.params[0], config.play);
    if (published) {
      const parties = ctx.user ? await db.one('select creator_user_id,acceptor_user_id from bilateral_bets where id=$1', [published.id]) : null;
      const participant = ctx.user && [parties?.creator_user_id, parties?.acceptor_user_id].filter(Boolean).some(id => String(id) === String(ctx.user.id));
      if (!participant && !failed && ctx.url.searchParams.get('join') !== '1') return publicPage(ctx, published);
    }
    if (!(await ready(ctx))) return;
    const bet = await betFor(db, ctx.user, ctx.params[0]);
    if (!bet) return notFound(ctx);
    const creator = String(bet.creator_user_id) === String(ctx.user.id);
    const acceptor = String(bet.acceptor_user_id) === String(ctx.user.id);
    const participant = creator || acceptor;
    const terminal = ['settled', 'cancelled', 'expired', 'refunded'].includes(bet.status);
    const withdrawal = participant && bet.chain_state && terminal ? await withdrawalView(db, config, ctx.user, bet, { fetchImpl }) : null;
    const requests = await latestWalletRequests(db, config, ctx.user, bet.id);
    // A testnet account is signed for by the server until its owner claims it, so the wallet
    // forms and the lost-return recovery do not apply to it.
    const play = config.play?.enabled ? await playAccountFor(db, ctx.user.x_user_id) : null;
    const played = Boolean(play?.ready && !play.claimed_at && play.account_id === (String(bet.creator_user_id) === String(ctx.user.id) ? bet.creator_wallet : bet.acceptor_wallet));
    const depositRequest = requests.find((request) => request.method === (creator ? 'create_bet' : 'accept_bet'));
    // Recover only this actor's native stake for the phase still awaiting it.
    // An unclaimed Stated account is server-signed, even before its wallet has
    // been copied to the Bet by chain synchronization.
    const managedDeposit = play && !play.claimed_at && play.account_id === depositRequest?.wallet_account;
    const stakeRequest = !played && !managedDeposit && bet.status === 'offered'
      && (creator ? !bet.chain_state : bet.chain_state?.status === 'offered' && !bet.chain_state.acceptor)
      ? depositRequest : null;
    const pendingDeposit = stakeRequest?.execution_status === 'pending' && stakeRequest.transaction_hash ? stakeRequest : null;
    const awaitingWallet = stakeRequest?.execution_status === 'pending' && !stakeRequest.transaction_hash;
    const stakeFailure = stakeRequest?.execution_status === 'failed' ? stakeRequest : null;
    const walletReturnInstruction = html`<p class="stakes left" role="status">Approval not verified. If you already approved this request, check its transaction before continuing.</p>`;
    const walletAccount = creator ? bet.creator_wallet || '' : bet.acceptor_wallet || '';
    const knownWallet = typed ?? (walletAccount || depositRequest?.wallet_account || await lastWallet(ctx.user));
    const expired = bet.expired;
    const eligible = inPilot(config, ctx.user.x_user_id);
    const proposal = bet.current_proposal || bet.proposals?.find((p) => p.id === bet.current_proposal_id);
    const canPropose = participant && !bet.acceptor_unbound && ['accepted', 'proposed', 'disputed'].includes(bet.status) && new Date(bet.resolve_at).getTime() <= Date.now();
    // When the enclave jury is this Bet's referee, the two sides bring evidence; they do not propose the Result.
    const juryRefereed = juryDecides(bet);
    const evidencePrimary = participant && published && evidencePhase(published);
    const lost = juryRefereed && participant && bet.status === 'settled' && ['yes', 'no'].includes(bet.outcome)
      && bet.outcome !== (creator ? bet.creator_side : otherSide(bet));
    const juryRefunded = juryRefereed && participant && published?.enclave?.mode === 'ruling'
      && published.enclave.outcome === 'unclear' && (bet.status === 'refunded' || (bet.status === 'settled' && bet.outcome === 'void'));
    const presentation = published ? { ...bet, enclave: published.enclave, evidence: published.evidence,
      result_recorded_at: published.result_recorded_at } : bet;
    const invite = `${config.baseUrl}${pathFor(bet.id)}`;
    const waiting = Boolean(proposal && bet.status === 'proposed' && participant && !bet.acceptor_unbound && String(proposal.proposer_user_id) !== String(ctx.user.id));
    const credit = withdrawal?.creditYocto && BigInt(withdrawal.creditYocto) > 0n;
    const pendingWithdrawal = withdrawal?.request?.execution_status === 'pending';
    // Version 2 of the contract: a result the other side leaves unanswered for two days stands, and
    // while a result is waiting for an answer neither side can take a refund instead.
    const v2 = Boolean(bet.chain_state && Object.hasOwn(bet.chain_state, 'resolution'));
    const proposedAtNs = bet.chain_state?.proposal?.proposed_at_ns;
    const refereed = Boolean(bet.chain_state?.referee);
    const mineUnanswered = Boolean(v2 && !refereed && participant && bet.status === 'proposed' && proposal && proposedAtNs
      && String(proposal.proposer_user_id) === String(ctx.user.id));
    const standsAt = mineUnanswered ? new Date(Number(BigInt(proposedAtNs) / 1000000n) + 2 * 86400000) : null;
    const canStand = Boolean(standsAt && Date.now() >= standsAt.getTime());
    const refundable = participant && bet.chain_state && ['accepted', 'disputed', ...(v2 && !refereed ? [] : ['proposed'])].includes(bet.status) && Date.now() >= new Date(bet.resolve_at).getTime() + 7 * 86400000;
    const proposalFields = html`<input type="hidden" name="proposalId" value="${proposal?.id}"><input type="hidden" name="proposalRevision" value="${proposal?.revision}"><input type="hidden" name="proposalOutcome" value="${proposal?.outcome}"><input type="hidden" name="accountId" value="${walletAccount}">`;

    // Exactly one primary action for this viewer in this state.
    let primary = '';
    let walletAlternative = '';
    let refundPrimary = false;
    const needsStake = creator ? !bet.chain_state : Boolean(bet.chain_state);
    const limited = !creator && bet.status === 'offered' && !expired && bet.chain_state
      ? await takeLimit(ctx, bet) : null;
    if (!eligible && bet.status === 'offered' && !expired && needsStake) {
      primary = html`<p class="stakes">Bets with real NEAR are invite-only for now.</p>`;
    } else if (limited) {
      primary = html`<p class="gut quiet" id="accept">${limited}</p>`;
    } else if (creator && bet.status === 'offered' && !expired && !bet.chain_state) {
      primary = html`${awaitingWallet ? walletReturnInstruction : html`<p class="stakes">Deposit ${formatTestNear((BigInt(bet.stake_yocto) + BigInt(STORAGE_FEE_YOCTO)).toString())} ${unit()}: your ${formatTestNear(bet.stake_yocto)} stake and a ${formatTestNear(STORAGE_FEE_YOCTO)} storage fee.</p>`}
        <div class="acts"><form method="post" action="${pathFor(bet.id)}/fund">${csrfField(ctx)}${walletField(knownWallet)}<button class="${pendingDeposit ? 'big' : 'primary big'}" type="submit">${awaitingWallet ? 'Continue in wallet' : 'Deposit stake'}</button></form></div>`;
    } else if (bet.status === 'offered' && !expired && !creator && bet.chain_state) {
      const managed = pendingDeposit || awaitingWallet || stakeFailure ? null : await managedTake(ctx, bet, play, published);
      const external = html`${awaitingWallet ? walletReturnInstruction : html`<p class="stakes">Deposit ${formatTestNear(bet.stake_yocto)} ${unit()} for the opposite side.</p>`}
        <div class="acts"><form method="post" action="${pathFor(bet.id)}/accept" id="${managed ? 'accept-wallet' : 'accept'}">
          ${csrfField(ctx)}<input type="hidden" name="termsHash" value="${bet.terms_hash}">
          ${walletField(typed ?? (bet.invited_wallet || knownWallet))}
          ${published ? html`<label class="check"><input type="checkbox" name="publicConsent" value="1" required><span>Show my X name and wallet on this public bet.</span></label>` : ''}
          <button class="${managed || pendingDeposit ? 'big' : 'primary big'}" type="submit">${awaitingWallet ? 'Continue in wallet' : `Bet ${otherSide(bet)}`}</button>
        </form></div>`;
      primary = managed || external;
      if (managed) walletAlternative = fold('Use a NEAR wallet', external, { open: Boolean(failed && typed !== null) });
    } else if (creator && bet.status === 'offered' && !expired && bet.chain_state) {
      primary = published
        ? html`<div class="acts">${betShareLink(config.baseUrl, bet, { label: 'Post the dare' })}<div class="two">${copyBetLink(bet)}</div></div>`
        : html`<div class="acts"><a class="pill solid big" href="${pathFor(bet.id)}/publication">Review before posting</a></div>`;
    } else if (waiting) {
      primary = html`<div class="acts"><form method="post" action="${pathFor(bet.id)}/confirm">${csrfField(ctx)}${proposalFields}<button class="primary big" type="submit">Agree</button></form>
        <div class="two"><a class="tl" href="#dispute">Disagree</a></div></div>`;
    } else if (canStand) {
      primary = html`<p class="stakes">The other side did not answer in two days.</p>
        <div class="acts">${mutationForm(ctx, bet, 'finalize', 'Let the result stand', { primary: true })}</div>`;
    } else if (mineUnanswered) {
      primary = html`<p class="stakes left">You can let this result stand ${nextBetTime(standsAt)} if the other side has not answered.</p>`;
    } else if (withdrawal && credit && !played && !pendingWithdrawal) {
      primary = html`<div class="acts">${mutationForm(ctx, bet, 'withdraw', 'Withdraw tokens', { primary: true })}</div>`;
    } else if (withdrawal && credit && !played && pendingWithdrawal && !withdrawal.request?.transaction_hash) {
      primary = html`<div class="acts">${mutationForm(ctx, bet, 'withdraw', 'Resume withdrawal', { primary: true })}</div>`;
    } else if (refundable && !canPropose) {
      refundPrimary = true;
      primary = html`<div class="acts">${mutationForm(ctx, bet, 'refund', 'Reclaim stake', { primary: true })}</div>`;
    }
    if (pendingDeposit) {
      walletAlternative = primary ? fold('Use a NEAR wallet', primary) : '';
      primary = html`<p class="stakes left" role="status">Pending verification. ${pendingDeposit.execution_message || 'Check this transaction before signing again.'}</p>
        <div class="acts">${walletTransactionForm(pendingDeposit, bet.id, csrfField(ctx), { primary: true })}
          <a class="tl" href="${transactionLink(pendingDeposit.transaction_hash)}" rel="noopener noreferrer">View transaction</a></div>`;
    }
    if (evidencePrimary) {
      primary = html`<div class="acts"><a class="pill solid big" href="${pathFor(bet.id)}/evidence">Add a link</a>
        <div class="two">${betShareLink(config.baseUrl, published, { mine: creator, ghost: true, label: 'Post on X' })}</div></div>`;
    } else if ((lost || juryRefunded) && published && !primary) {
      primary = html`<div class="acts"><a class="pill solid big" href="/bets/new?from=${bet.id}">Make another bet</a>
        <div class="two">${betShareLink(config.baseUrl, published, { mine: creator, ghost: true, label: juryRefunded ? 'Post on X' : 'Post the result' })}</div></div>`;
    }
    const refundInFold = refundable && !refundPrimary;
    const quietShare = published && !primary
      ? html`<div class="acts">${betShareLink(config.baseUrl, published, { mine: creator, label: bet.status === 'settled' || pendingRuling(presentation) ? 'Post the result' : 'Post on X' })}
        ${bet.status === 'settled' && eligible && config.play?.enabled ? html`<div class="two"><a class="tl" href="/bets/new?from=${bet.id}">Make another bet</a></div>` : ''}</div>` : '';

    const notices = html`
      ${bet.acceptor_unbound ? html`<p class="notice">Accepted directly by wallet ${bet.acceptor_wallet}. No X identity is linked to that wallet. The proposer can reclaim or withdraw tokens when the contract allows it.</p>` : ''}
      ${ctx.url.searchParams.get('wallet') === 'returned' ? html`<p class="notice">The wallet returned. Verify the escrow to check whether the transaction completed.</p>` : ''}
      ${proposal ? html`<div class="notice"><p><b>${bet.status === 'settled' ? 'Agreed result' : 'Proposed result'}: ${OUTCOME[proposal.outcome]}</b></p>
        ${proposal.note ? html`<p>${proposal.note}</p>` : ''}
        ${proposal.evidence_url ? html`<p><a href="${proposal.evidence_url}" rel="noopener noreferrer">Result link</a></p>` : ''}</div>` : ''}
      ${bet.status === 'disputed' ? html`<p class="notice">The result is disputed. Look at the history, then propose a result both sides can accept, including calling it off.</p>` : ''}
      ${withdrawal ? html`
        ${credit ? html`<p class="stakes">Available wallet credit: ${formatTestNear(withdrawal.creditYocto)} ${unit()} in this contract.</p>` : ''}
        ${played && credit && withdrawal.request?.execution_status !== 'succeeded'
          ? html`<p class="stakes left" role="status">Your payout is being sent to your Stated account.</p>` : ''}
        ${played && withdrawal.request?.execution_status === 'succeeded'
          ? html`<p class="stakes left">Paid to your account. <a class="tl" href="${transactionLink(withdrawal.request.transaction_hash)}" rel="noopener noreferrer">See it on NEAR</a></p>`
          : html`${withdrawal.request?.execution_message ? html`<p class="notice" role="status">${withdrawal.request.execution_message}</p>` : ''}
        ${withdrawal.request?.transaction_hash ? html`<p class="notice"><a href="${transactionLink(withdrawal.request.transaction_hash)}" rel="noopener noreferrer">View transaction</a></p>` : ''}`}
        ${withdrawal.creditYocto === null ? html`<p class="notice">Withdrawal credit could not be checked. Verify the escrow to retry.</p>`
          : ''}
        ${pendingWithdrawal ? html`<p class="notice">${played
          ? 'The payout is not yet verified. It will be checked again automatically.'
          : 'The earlier withdrawal is unverified. Check its transaction before signing again.'}</p>` : ''}` : ''}`;

    const extraTerms = html`
      <dt>Proposer</dt><dd>@${bet.creator_username}</dd>
      <dt>Proposer bets</dt><dd>${bet.creator_side}</dd>
      <dt>Opponent</dt><dd>${bet.acceptor_username ? `@${bet.acceptor_username}` : bet.invited_username ? `@${bet.invited_username}` : 'First signed-in person with this invitation'}</dd>
      <dt>Opponent wallet</dt><dd>${bet.invited_wallet || `First accepting ${network().id} wallet`}</dd>
      <dt>Storage fee</dt><dd>${formatTestNear(STORAGE_FEE_YOCTO)} ${unit()} from the proposer, not refunded</dd>
      <dt>Tokens</dt><dd>${network().real ? 'Stakes use real NEAR.' : 'Test NEAR has no monetary value.'} Stakes go straight to the contract. Forecasting scores stay separate.</dd>`;

    await show(ctx, bet.claim.slice(0, 80), html`
      <h1 class="visually-hidden">Bet: ${bet.claim}</h1>
      ${await sourceHeader(ctx.user, bet)}
      <p class="${claimClass(bet.claim)}">${claimWords(presentation, recordedRuling(presentation))}</p>
      ${await betSourceHeader(db, ctx.user, bet, config.x.simulatedOrigin, { timestamp: true })}
      ${betBlock(bet, { heading: phaseHeading(presentation, ctx.user), ruling: pendingRuling(presentation), cameTrue: recordedRuling(presentation) === 'yes', viewer: ctx.user, faces: await faces(ctx, bet), joinHref: eligible && bet.status === 'offered' && bet.chain_state && !creator && !limited ? '#accept' : null })}
      ${await enclaveDetail(published)}
      ${notices}
      ${failed || stakeFailure ? html`<p class="notice" role="alert">${failed?.message || stakeFailure.execution_message || 'The stake transaction failed. Retry in your wallet.'}</p>` : ''}
      ${primary}${quietShare}
      <div class="folds">
        ${walletAlternative}
        ${canPropose && !juryRefereed ? fold('Propose a result', html`
          <form method="post" action="${pathFor(bet.id)}/propose">
            ${csrfField(ctx)}<input type="hidden" name="accountId" value="${walletAccount}"><label for="outcome">Result</label>
            <select id="outcome" name="outcome"><option value="yes">Came true</option><option value="no">Did not come true</option><option value="void">Void, no winner</option></select>
            <label for="evidence">Result link</label><input type="url" id="evidence" name="evidenceUrl" maxlength="2048">
            <p class="quiet">A link is required unless you propose to void the bet.</p>
            <label for="reason">Reason</label><textarea id="reason" name="note" required maxlength="2000"></textarea>
            <button class="primary big" type="submit">Propose result</button>
          </form>`, { open: !waiting }) : ''}
        ${waiting ? fold('Disagree', html`
          <form method="post" action="${pathFor(bet.id)}/dispute">
            ${csrfField(ctx)}${proposalFields}
            <label for="dispute-note">Why do you disagree?</label><textarea id="dispute-note" name="note" required maxlength="2000"></textarea>
            <button type="submit">Dispute result</button>
          </form>`, { id: 'dispute' }) : ''}
        ${played ? '' : walletRequestHistory(requests.filter(request => request !== pendingDeposit)
          .map(request => request === stakeFailure ? { ...request, execution_message: null } : request), bet.id, csrfField(ctx))}
        ${pendingWithdrawal ? fold('Check transaction', html`
          <form method="post" action="${pathFor(bet.id)}/transactions">${csrfField(ctx)}
            <input type="hidden" name="requestId" value="${withdrawal.request.id}">
            <label>Transaction hash<input type="text" name="transactionHash" value="${withdrawal.request.transaction_hash || ''}" required maxlength="44" autocomplete="off"></label>
            <button type="submit">Check transaction</button>
          </form>`, { open: true }) : ''}
        ${betTerms(bet, { extra: extraTerms, juryReview: juryDecides(published) })}
        ${fold('History', html`
          ${withdrawal && withdrawal.creditYocto !== null ? html`<p class="quiet">Available wallet credit: ${formatTestNear(withdrawal.creditYocto)} ${unit()}.</p>` : ''}
          <ol class="history">${(bet.events || []).filter(event => event.kind !== 'enclave_ruling').map((event) => html`<li>
          <p>${event.kind === 'chain_verified' ? `NEAR verified: ${STATUS[event.detail.status] || event.detail.status}` : ({ created: 'Offer created', cancelled: 'Offer cancelled' })[event.kind] || event.kind}</p>
          <p class="quiet">${time(event.at)}</p>
          ${event.detail?.note ? html`<p>${event.detail.note}</p>` : ''}
        </li>`)}</ol>
          <h3>On NEAR</h3>
          ${config.nearContract ? html`<p><a href="${accountLink(config.nearContract)}" rel="noopener noreferrer">View ${network().id} contract</a></p>` : ''}
          <p class="quiet">${bet.last_verified_at ? `Last verified ${time(bet.last_verified_at)}.` : 'Not verified yet.'}</p>
          <form method="post" action="${pathFor(bet.id)}/verify">${csrfField(ctx)}<button type="submit">Verify escrow</button></form>
          <h3>Terms fingerprint</h3><p class="mono">${bet.terms_hash}</p><p class="quiet">The funded contract commits to this salted fingerprint. Source text and private notes stay off-chain.</p>`)}
        ${refundInFold ? fold('Reclaim stake', mutationForm(ctx, bet, 'refund', 'Reclaim stake')) : ''}
        ${creator && (published || bet.status === 'offered') ? fold(published ? (bet.status === 'offered' ? 'Publication and cancellation' : 'Who can see this bet') : 'Cancel offer', html`
          ${published && bet.status === 'offered' && !expired && bet.chain_state ? html`<label for="invite-link">Invitation link</label><input id="invite-link" type="text" readonly value="${invite}">` : ''}
          ${published ? html`<form method="post" action="${pathFor(bet.id)}/unpublish">${csrfField(ctx)}<p class="quiet">Withdrawing takes the public page down. Chain data stays public.</p><button type="submit">Make this bet private</button></form>` : ''}
          ${bet.status === 'offered' ? mutationForm(ctx, bet, 'cancel', 'Cancel offer') : ''}`, { id: 'invite' }) : ''}
      </div>
    `, { status: failed?.status || 200 });
  }
  route('GET', new RegExp(`^/bets/${ID}$`), (ctx) => betPage(ctx));

  route('GET', new RegExp(`^/bets/${ID}/publication$`), async (ctx) => {
    if (!(await ready(ctx))) return;
    const bet = await betFor(db, ctx.user, ctx.params[0]);
    if (String(bet.creator_user_id) !== String(ctx.user.id)) return notFound(ctx);
    await show(ctx, 'Publish bet', html`
      ${await sourceHeader(null, bet)}
      <p class="prop">${claimWords(bet)}</p>
      ${betBlock(bet, { cameTrue: refereeRuling(bet) === 'yes', viewer: ctx.user, faces: await faces(ctx, bet) })}
      <p class="stakes left">This publishes these Bet terms and your X identity and wallet association. Private saves and notes stay private. Public chain data remains public even if this page is withdrawn.</p>
      <div class="acts"><form method="post" action="${pathFor(bet.id)}/publish">${csrfField(ctx)}
        <label><input type="checkbox" name="confirm" value="1" required> Publish this Bet and my participation.</label>
        <button class="primary big" type="submit">Publish</button>
      </form></div>
      <div class="folds">${betTerms(bet)}</div>`, { back: pathFor(bet.id) });
  });

  route('POST', new RegExp(`^/bets/${ID}/publish$`), async (ctx) => {
    const form = await needPost(ctx);
    if (!form) return;
    if (form.get('confirm') !== '1') throw new UserError('Review and approve the public invitation before publishing.');
    const bet = await betFor(db, ctx.user, ctx.params[0]);
    if (String(bet.creator_user_id) !== String(ctx.user.id)) throw new UserError('Only the creator can publish this Bet.', 404);
    await syncNearBet(db, config, ctx.user, bet.id, { fetchImpl });
    await publishBet(db, ctx.user, bet.id);
    redirect(ctx.res, pathFor(bet.id));
  });

  route('POST', new RegExp(`^/bets/${ID}/unpublish$`), async (ctx) => {
    const form = await needPost(ctx);
    if (!form) return;
    await withdrawBetPublication(db, ctx.user, ctx.params[0]);
    redirect(ctx.res, pathFor(ctx.params[0]));
  });

  route('POST', new RegExp(`^/bets/${ID}/follow$`), async (ctx) => {
    const form = await needPost(ctx);
    if (!form) return;
    await followPublicBet(db, ctx.user, ctx.params[0]);
    redirect(ctx.res, `${pathFor(ctx.params[0])}?done=following`);
  });

  route('POST', new RegExp(`^/bets/${ID}/verify$`), async (ctx) => {
    const form = await needPost(ctx);
    if (!form) return;
    await syncNearBet(db, config, ctx.user, ctx.params[0], { fetchImpl });
    await syncPendingBetTransactions(db, config, ctx.params[0], { fetchImpl });
    redirect(ctx.res, pathFor(ctx.params[0]));
  });

  route('POST', new RegExp(`^/bets/${ID}/transactions$`), async (ctx) => {
    const form = await needPost(ctx);
    if (!form) return;
    let returnTo = pathFor(ctx.params[0]);
    try {
      await verifyBetTransaction(db, config, ctx.user, ctx.params[0], {
        requestId: form.get('requestId'), transactionHash: form.get('transactionHash'),
      }, { fetchImpl });
      await syncNearBet(db, config, ctx.user, ctx.params[0], { fetchImpl });
      const checked = await db.one(`select method,execution_status from bilateral_near_requests
        where id=$1 and bet_id=$2 and user_id=$3 and metadata->>'contract'=$4`,
      [form.get('requestId'), ctx.params[0], ctx.user.id, config.nearContract]);
      // A submitted acceptance has not necessarily bound its X participant yet.
      // Keep its owner in recovery instead of returning to the public offer.
      if (checked?.method === 'accept_bet' && ['pending', 'failed'].includes(checked.execution_status)) returnTo += '?join=1';
    } catch (error) {
      if (recoverable(error)) return betPage(ctx, { failed: error });
      throw error;
    }
    redirect(ctx.res, returnTo);
  });

  route('POST', new RegExp(`^/bets/${ID}/take$`), async (ctx) => {
    const form = await needPost(ctx);
    if (!form) return;
    const [id] = ctx.params;
    if (!ctx.user.setup_completed_at) return redirect(ctx.res, `/setup?return=${encodeURIComponent(`${pathFor(id)}?join=1#accept`)}`);
    if (!inPilot(config, ctx.user.x_user_id)) throw new UserError('Bets with real NEAR are invite-only for now.', 403);
    try {
      if (form.get('publicConsent') !== '1') throw new UserError('Tick the box to show your X name and wallet on this public bet.');
      if (!await publicBet(db, id)) return notFound(ctx);
      const termsHash = form.get('termsHash');
      const bet = await syncNearBet(db, config, ctx.user, id, { fetchImpl });
      const account = await playAccountFor(db, ctx.user.x_user_id);
      if (bet.terms_hash !== termsHash) throw new UserError('Review the current terms before taking this bet.', 409);
      if (account?.ready && String(bet.acceptor_user_id) === String(ctx.user.id) && bet.chain_state?.acceptor === account.account_id) {
        await queueWebMatchNotice(db, config, ctx.user, id);
        return redirect(ctx.res, pathFor(id));
      }
      if (!managedOffer(bet, ctx.user, account) || (config.near?.real && !account?.ready)) {
        throw new UserError('This offer is unavailable to your Stated account.', 409);
      }
      await consentToPublicBet(db, ctx.user, id);
      if (!account?.ready) await ensurePlayAccount(db, config, chain(), { xUserId: ctx.user.x_user_id, username: ctx.user.x_username });
      await playAction(db, config, chain(), ctx.user, id, { action: 'accept', termsHash }, { fetchImpl });
      await queueWebMatchNotice(db, config, ctx.user, id);
    } catch (error) {
      if (recoverable(error)) return betPage(ctx, { failed: error });
      throw error;
    }
    redirect(ctx.res, pathFor(id));
  });

  route('POST', new RegExp(`^/bets/${ID}/(fund|accept|cancel|expire|refund|withdraw|propose|confirm|dispute|finalize)$`), async (ctx) => {
    const form = await needPost(ctx);
    if (!form) return;
    const [id, action] = ctx.params;
    const before = await betFor(db, ctx.user, id);
    let prepared;
    try {
      if (action === 'accept' && await publicBet(db, id)) {
        if (form.get('publicConsent') !== '1') throw new UserError('Tick the box to show your X name and wallet on this public bet.');
        await consentToPublicBet(db, ctx.user, id);
      }
      if (action === 'cancel' && !before.chain_state && String(before.creator_user_id) === String(ctx.user.id)) {
        await cancelUnfundedBet(db, config, ctx.user, id, { fetchImpl });
        return redirect(ctx.res, pathFor(id));
      }
      const input = Object.fromEntries(['accountId', 'termsHash', 'proposalId', 'proposalRevision', 'proposalOutcome', 'outcome', 'evidenceUrl', 'note'].map((key) => [key, form.get(key)]));
      prepared = await prepareNearAction(db, config, ctx.user, id, { ...input, action }, { fetchImpl });
    } catch (error) {
      if (before && recoverable(error)) return betPage(ctx, { failed: error, typed: ['fund', 'accept'].includes(action) ? String(form.get('accountId') || '') : null });
      throw error;
    }
    const sending = BigInt(prepared.depositYocto || '0') > 1n;
    await show(ctx, 'Approve in your wallet', html`
      <h1 class="visually-hidden">Approve in your wallet</h1>
      ${await sourceHeader(ctx.user, before)}
      <p class="prop">${before.claim}</p>
      ${betBlock(before, { viewer: ctx.user, faces: await faces(ctx, before), lead: false })}
      <p class="wallet-debit">${sending ? `Deposit ${formatTestNear(prepared.depositYocto)} ${unit()} from ${prepared.accountId}` : `Approve from ${prepared.accountId}`}</p>
      ${prepared.withdrawalCreditYocto ? html`<p class="notice">Available wallet credit: ${formatTestNear(prepared.withdrawalCreditYocto)} ${unit()}. This is the wallet's total credit in this contract. Transfer completion still needs verification on NEAR.</p>` : ''}
      ${prepared.reused ? html`<p class="notice">Reusing your earlier transaction intent.</p>` : ''}
      <div class="acts"><form method="post" action="${pathFor(id)}/transactions" data-stated-wallet data-near-network="${network().id}">
        ${csrfField(ctx)}<input type="hidden" name="requestId" value="${prepared.requestId}">
        <input type="hidden" name="walletPayload" value="${JSON.stringify(prepared.payload)}">
        <input type="hidden" name="transactionHash" value="">
        <button class="primary big" type="button" data-connect-wallet>Connect wallet</button>
        <button class="primary big" type="button" data-sign-wallet hidden>Approve request</button>
        <p role="status" data-wallet-status></p>
      </form>
      <a class="tl center" href="${pathFor(id)}">Back to the bet</a></div>
      <noscript><p class="notice">Enable JavaScript to connect Meteor Wallet. Your request remains saved.</p></noscript>
      <div class="folds">
        ${fold('This request', html`<dl class="bet-terms"><dt>Network</dt><dd>${networkName()}</dd><dt>Wallet</dt><dd>${prepared.accountId}</dd>
          <dt>Wallet approval</dt><dd>Connect Meteor Wallet and approve this exact request on ${networkName()}.</dd>
          <dt>Contract</dt><dd>${config.nearContract}</dd><dt>Action</dt><dd>${prepared.method}</dd>
          <dt>Attached tokens</dt><dd>${formatTestNear(prepared.depositYocto)} ${unit()}</dd></dl>`)}
        ${betTerms(before, { extra: html`<dt>Storage fee</dt><dd>The proposer’s storage fee is separate and is not refunded.</dd>` })}
      </div>
      <script src="/static/wallet.js?v=${walletVersion}" defer></script>
    `, { back: pathFor(id) });
  });
}
