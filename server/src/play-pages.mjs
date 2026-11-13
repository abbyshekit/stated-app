// The NEAR account a person gets when they bet from a reply: what it is, what
// it holds, the step that hands it over to them, and, with real NEAR, how they
// pay into it from another chain.
import Decimal from 'decimal.js';
import { html, utcTime } from './html.mjs';
import { depositFor, fundingOn, lapsed, MAX_DEPOSIT_NEAR, MIN_DEPOSIT_NEAR, recentDeposits, refreshDeposit, startDeposit } from './funding.mjs';
import { shortAmount } from './intents.mjs';
import { accountLink, network, transactionLink, unit } from './near-network.mjs';
import { qrSvg } from './qr.mjs';
import { nearMark, tokenMark } from './token-logos.mjs';
import { accountNameFor, claimPlayAccount, ensurePlayAccount, inPilot, near, playAccountFor, yocto } from './play.mjs';
import { betFor } from './bets.mjs';
import { STORAGE_FEE_YOCTO } from './near-escrow.mjs';
import { fundingNeed, fundingPanel, fundingStatus } from './funding-view.mjs';
import { UserError } from './store.mjs';

/** The tokens a payment can be made in, grouped by chain, as the options of a select. */
export function tokenChoices(list, chosenId) {
  const groups = new Map();
  for (const t of list) groups.set(t.chainName, [...(groups.get(t.chainName) || []), t]);
  return [...groups].map(([name, items]) => html`<optgroup label="${name}">${items.map((t) => html`<option value="${t.assetId}"${t.assetId === chosenId ? ' selected' : ''}>${t.symbol} on ${t.chainName}</option>`)}</optgroup>`);
}

const clock = utcTime;
const amount = near;
const betReference = (value) => /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value || '') ? value.toLowerCase() : '';
const returnToBet = (id) => `/bets/${id}?join=1#accept`;
// An amount of a token without the zeros a formatter pads it with: 0.903500 reads 0.9035.
const trim = (value) => (String(value).includes('.') ? String(value).replace(/0+$/, '').replace(/\.$/, '') : String(value));
// Minutes an address has left, counted when the page is made. The page is made again every few seconds.
const minutesLeft = (deadline, now = Date.now()) => Math.max(1, Math.ceil((new Date(deadline).getTime() - now) / 60000));
// An address in blocks of four, so it can be checked by eye against what a wallet shows. The blocks are
// separate elements with no spaces between them, so selecting it still copies the address whole.
// An address named in a sentence: its two ends. The whole of it is under "About this payment".
const short = (address) => (String(address).length > 14 ? `${String(address).slice(0, 6)}…${String(address).slice(-4)}` : String(address));
// A leading 0x stands alone, so the blocks line up with the address's own digits.
function grouped(address) {
  const text = String(address);
  const head = text.startsWith('0x') ? ['0x'] : [];
  return [...head, ...(text.slice(head.length ? 2 : 0).match(/.{1,4}/g) || [])].map((part) => html`<i>${part}</i>`);
}

// Where a payment stands, in a few words, for the list on the wallet page.
function standing(d) {
  if (lapsed(d)) return 'Expired';
  switch (d.state) {
    case 'PENDING_DEPOSIT': return `Pay within ${minutesLeft(d.deadline)} min`;
    case 'KNOWN_DEPOSIT_TX': return 'Payment seen';
    case 'INCOMPLETE_DEPOSIT': return 'Underpaid';
    case 'PROCESSING': return 'On its way';
    case 'SUCCESS': return d.finished_at ? 'In your account' : 'Confirming';
    case 'REFUNDED': return 'Refunded';
    case 'FAILED': return 'Failed';
    default: return 'Expired';
  }
}

export function registerPlayRoutes({ botUsername, route, db, config, layout, needUser, needPost, csrfField, send, redirect, notFound, chain, quotes = null, payVersion = '', allowHeavyRead = null }) {
  if (!config.play?.enabled) return;
  const real = () => network().real;
  const funding = () => Boolean(quotes && fundingOn(config));

  async function neededFor(ctx, bet) {
    if (!bet) return fundingNeed(ctx.url.searchParams.get('need'));
    try {
      const row = await betFor(db, ctx.user, bet);
      if (row.status !== 'offered') return '0';
      return (BigInt(row.stake_yocto) + (String(row.creator_user_id) === String(ctx.user.id) && !row.chain_state
        ? BigInt(STORAGE_FEE_YOCTO) : 0n)).toString();
    } catch (error) {
      if (error.status === 404) return '0';
      throw error;
    }
  }

  const payRow = (d) => html`<li><a href="/me/wallet/pay/${d.id}">${tokenMark({ symbol: d.origin_symbol, chain: d.origin_chain }, { keep: true })}<b>${amount(d.near_yocto)} NEAR with ${d.origin_symbol} on ${d.origin_chain}</b><span>${standing(d)}</span></a></li>`;
  // Payments still open, shown under the balance: a person coming back looks there for what is left to pay.
  async function openPayments(ctx, account) {
    if (!funding() || account.claimed_at) return '';
    const rows = (await recentDeposits(db, ctx.user.x_user_id)).filter((d) => !d.finished_at);
    return rows.length ? html`<ul class="pays">${rows.map(payRow)}</ul>` : '';
  }
  // Payments that are over, kept behind one row.
  async function pastPayments(ctx, account) {
    if (!funding() || account.claimed_at) return '';
    const rows = (await recentDeposits(db, ctx.user.x_user_id)).filter((d) => d.finished_at);
    return rows.length ? html`<details class="fold"><summary>Past payments</summary><ul class="pays past">${rows.map(payRow)}</ul></details>` : '';
  }

  // The form is on the page while it is being used: asked for (?add), answering an error, or when the
  // person has never paid in. Otherwise one button under the balance leads to it.
  async function adding(ctx, { error = null } = {}) {
    return Boolean(error || ctx.url.searchParams.has('add') || !(await recentDeposits(db, ctx.user.x_user_id)).length);
  }
  async function addButton(ctx, account, options) {
    if (!funding() || account.claimed_at || await adding(ctx, options)) return '';
    return html`<p class="acts"><a class="pill solid big" href="/me/wallet?add#add">Add NEAR from another chain</a></p>`;
  }

  // Paying in from another chain: the form.
  async function payIn(ctx, account, { error = null, typed = {}, bet = '' } = {}) {
    if (!funding() || account.claimed_at || !(await adding(ctx, { error }))) return '';
    const list = await quotes.tokens();
    if (!list.length) return html`<details class="fold" id="add"><summary>Add NEAR from another chain</summary><p class="quiet">NEAR Intents cannot be reached right now. Try again shortly.</p></details>`;
    const asked = typed.assetId || ctx.url.searchParams.get('pay');
    const chosen = list.find((t) => t.assetId === asked) || list.find((t) => t.symbol === 'USDC' && t.chain === 'base') || list[0];
    // What the amount and token the form opens with would cost. A dry quote; absent when there is none.
    const opening = typed.near || ctx.url.searchParams.get('add') || '0.5';
    let cost = null;
    if (/^\d{1,2}(\.\d{1,4})?$/.test(opening) && new Decimal(opening).gte(MIN_DEPOSIT_NEAR) && new Decimal(opening).lte(MAX_DEPOSIT_NEAR)) {
      try { const q = await quotes.quote(chosen.assetId, yocto(opening)); if (q.ok) cost = q.amount; } catch { cost = null; }
    }
    // A message about one field sits under that field. Anything else (too many open payments, NEAR Intents
    // out of reach) is about the request as a whole and sits above the button, marking no field.
    const wrong = (field) => (error?.field === field ? html` class="bad" aria-invalid="true" aria-describedby="add-error"` : '');
    const said = (field) => (error && (error.field || 'form') === field ? html`<p class="err${field === 'form' ? ' whole' : ''}" id="add-error" role="alert">${error.message}</p>` : '');
    return html`<details class="fold" id="add" open><summary>Add NEAR from another chain<small>NEAR Intents</small></summary>
      <form class="takekey" method="post" action="/me/wallet/pay">
        ${csrfField(ctx)}
        ${bet ? html`<input type="hidden" name="bet" value="${bet}">` : ''}
        <label for="add-near">NEAR to add, ${MIN_DEPOSIT_NEAR} to ${MAX_DEPOSIT_NEAR}</label>
        <input type="text" id="add-near" name="near" inputmode="decimal" required maxlength="6" autocomplete="off" value="${opening}"${wrong('near')}>
        ${said('near')}
        <label for="add-with">Pay with</label>
        <select id="add-with" name="pay">${tokenChoices(list, chosen.assetId)}</select>
        ${cost ? html`<p class="cost" id="add-cost">${tokenMark({ symbol: chosen.symbol, chain: chosen.chain }, { size: 'sm' })}<span>${opening} NEAR costs about ${shortAmount(cost)} ${chosen.symbol} on ${chosen.chainName}.</span></p>` : ''}
        <label for="add-refund">Refund address</label>
        <input type="text" id="add-refund" name="refundTo" required maxlength="128" autocomplete="off" spellcheck="false" placeholder="Your own wallet, not an exchange" value="${typed.refundTo || ''}"${wrong('refundTo')}>
        ${said('refundTo')}
        ${said('form')}
        <button class="primary big" type="submit">Get an address to pay</button>
      </form>
      <script src="/static/pay.js?v=${payVersion}" defer></script>
    </details>`;
  }

  async function page(ctx, { error = null, status = 200, typed = '', payError = null, payTyped = {}, bet = betReference(ctx.url.searchParams.get('bet')) } = {}) {
    const account = await playAccountFor(db, ctx.user.x_user_id);
    let balance = null;
    if (account?.ready) {
      try { balance = await chain().balance(account.account_id); } catch { balance = null; }
    }
    const claimed = ctx.url.searchParams.get('done') === 'claimed';
    const needed = real() ? await neededFor(ctx, bet) : '0';
    let funds = null;
    if (real() && account?.ready) {
      try { funds = await fundingStatus(config, chain(), account, needed); }
      catch { funds = { accountId: account.account_id, balanceNear: balance == null ? null : near(balance),
        neededYocto: needed, neededNear: near(needed), missingNear: null }; }
    }
    const sponsor = real() && account?.ready && BigInt(account.granted_yocto || '0') > BigInt(yocto('0.05'))
      ? html`<p class="gut">Stated put ${near(account.granted_yocto)} NEAR in this account. It is yours to bet or withdraw.</p>` : '';
    const invited = inPilot(config, ctx.user.x_user_id);
    let intro = '';
    if (!account?.ready) {
      if (!real()) intro = html`<p>Bet once from a reply on X and an account is made for you, named after your handle.</p>`;
      else if (!invited) intro = html`<p>Bets with real NEAR are invite-only for now.</p>`;
    }
    const about = !account?.ready ? '' : real()
      ? html`<p class="quiet">A real account on NEAR, named after your handle: <span class="acct">${account.account_id}</span>. <a href="${accountLink(account.account_id)}" rel="noopener noreferrer">See it on NEAR</a>.</p>
          <p class="quiet">It holds real NEAR. ${account.claimed_at ? '' : 'Stated holds the key until you take the account, so a reply on X can place your bets. Taking it puts your key on and removes Stated’s in one transaction. '}Stated paid to open it.</p>`
      : html`<p class="quiet">A real account on NEAR testnet, named after your handle: <span class="acct">${account.account_id}</span>. <a href="${accountLink(account.account_id)}" rel="noopener noreferrer">See it on NEAR</a>.</p>
          <p class="quiet">Test NEAR has no monetary value. ${account.claimed_at ? '' : 'Stated holds the key until you take the account, so a reply on X can place your bets. Taking it puts your key on and removes Stated’s in one transaction.'} It is topped up from Stated’s testnet treasury, up to a limit per account.</p>`;
    // With real NEAR a person opens the account themselves, having seen the name it will have and that it holds real money.
    const opening = real() && invited && !account?.ready
      ? html`<p class="say">${accountNameFor(ctx.user.x_username, ctx.user.x_user_id, config.play.treasury)}</p>
          <p class="stakes left">It holds real NEAR: your stakes and what you win.</p>
          <form class="acts" method="post" action="/me/wallet/open">${csrfField(ctx)}${bet ? html`<input type="hidden" name="bet" value="${bet}">` : ''}${needed !== '0' ? html`<input type="hidden" name="need" value="${needed}">` : ''}<button class="primary big" type="submit">Open my account</button></form>
          ${error ? html`<p class="err" role="alert"><b>That didn’t go through.</b> ${error.message}</p>` : ''}`
      : '';
    send(ctx.res, status, await layout(ctx, 'Wallet', html`
      <div class="hero"><h1>Wallet</h1>${intro}</div>
      ${opening}
      ${account?.ready || real() ? '' : html`<p class="say">@${await botUsername()} bet ${config.play.defaultStakeNear} no</p>`}
      ${account?.ready ? html`
        <p class="prop">@${ctx.user.x_username}</p>
        ${funds ? fundingPanel(funds, { payVersion, unavailable: funds.missingNear == null }) : html`<p class="lead bal">${nearMark({ size: 'md' })}${balance == null ? 'Balance unavailable' : `${new Decimal(near(balance)).toFixed(2)} ${unit()}`}<span>${account.claimed_at ? 'yours' : 'on testnet'}</span></p>`}
        ${sponsor}
        ${funds && bet ? html`<p class="gut"><a class="tl" href="${returnToBet(bet)}">Return to bet</a></p>` : ''}
        ${await openPayments(ctx, account)}
        ${await addButton(ctx, account, { error: payError })}
        ${claimed ? html`<p class="stakes left" role="status">This account is yours now. Only your wallet can move it.</p>` : ''}
        ${account.claimed_at ? html`
          <p class="stakes left">You hold the only key. Bets from this account are signed in your own wallet, on the site.</p>`
        : ''}
        ${payError && account.claimed_at ? html`<p class="err gut" role="alert">${payError.message}</p>` : ''}
        <div class="folds">${await payIn(ctx, account, { error: payError, typed: payTyped, bet })}${await pastPayments(ctx, account)}${real() ? html`<details class="fold"><summary>Add NEAR from a NEAR wallet</summary>
          <p class="quiet">It is an ordinary NEAR account. NEAR sent to <span class="acct">${account.account_id}</span> from any wallet or exchange can be staked as soon as it arrives.</p></details>` : ''}${account.claimed_at ? '' : html`<details class="fold"${error ? ' open' : ''}><summary>Use your own NEAR wallet</summary>
          <form class="takekey" method="post" action="/me/wallet/claim">
            ${csrfField(ctx)}
            <label for="public-key">A public key from your NEAR wallet</label>
            <input type="text" id="public-key" name="publicKey" required maxlength="60" placeholder="ed25519:…" autocomplete="off" value="${typed}"${error ? html` class="bad" aria-invalid="true" aria-describedby="key-error"` : ''}>
            ${error ? html`<p class="err" id="key-error" role="alert"><b>That didn’t go through.</b> ${error.message}</p>` : ''}
            <button class="primary big" type="submit">Make this account mine</button>
          </form></details>`}<details class="fold"><summary>About this account</summary>
          ${about}
        </details></div>` : ''}
    `, { kind: 'private', flush: true, back: bet ? returnToBet(bet) : '/me' }), { kind: 'private' });
  }

  route('GET', /^\/me\/wallet$/, async (ctx) => {
    if (!(await needUser(ctx))) return;
    await page(ctx);
  });

  // Authenticated read only: a transfer refreshes the account balance without navigating away.
  route('GET', /^\/me\/wallet\/balance$/, async (ctx) => {
    if (!(await needUser(ctx))) return;
    if (allowHeavyRead && !allowHeavyRead(ctx)) return;
    const value = ctx.url.searchParams.get('need') || '0';
    if (fundingNeed(value) !== value) throw new UserError('The requested stake amount is invalid. Reopen the bet.');
    const account = await playAccountFor(db, ctx.user.x_user_id);
    if (!account?.ready) return notFound(ctx);
    let status;
    try { status = await fundingStatus(config, chain(), account, value); }
    catch { throw new UserError('NEAR balance could not be read. Retry the balance check.', 503); }
    send(ctx.res, 200, JSON.stringify(status), { kind: 'private', headers: {
      'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store',
    } });
  });

  route('POST', /^\/me\/wallet\/claim$/, async (ctx) => {
    const form = await needPost(ctx);
    if (!form) return;
    try {
      await claimPlayAccount(db, config, chain(), ctx.user.x_user_id, String(form.get('publicKey') || '').trim());
    } catch (error) {
      if (error.status && error.status < 500) return page(ctx, { error, status: error.status, typed: String(form.get('publicKey') || '').slice(0, 60) });
      throw error;
    }
    redirect(ctx.res, '/me/wallet?done=claimed');
  });

  // With real NEAR a person opens their account here, so they can pay into it before their first bet.
  route('POST', /^\/me\/wallet\/open$/, async (ctx) => {
    const form = await needPost(ctx);
    if (!form) return;
    if (!real()) return redirect(ctx.res, '/me/wallet');
    const bet = betReference(form.get('bet'));
    try {
      await ensurePlayAccount(db, config, chain(), { xUserId: ctx.user.x_user_id, username: ctx.user.x_username });
    } catch (error) {
      if (error.status && error.status < 500) return page(ctx, { error, status: error.status, bet });
      throw error;
    }
    const need = fundingNeed(form.get('need'));
    redirect(ctx.res, bet ? returnToBet(bet) : `/me/wallet?add${need !== '0' ? `&need=${need}` : ''}`);
  });

  route('POST', /^\/me\/wallet\/pay$/, async (ctx) => {
    const form = await needPost(ctx);
    if (!form) return;
    if (!funding()) return notFound(ctx);
    const bet = betReference(form.get('bet'));
    const typed = { near: String(form.get('near') || '').slice(0, 6), assetId: String(form.get('pay') || '').slice(0, 200), refundTo: String(form.get('refundTo') || '').slice(0, 128) };
    let deposit;
    try {
      deposit = await startDeposit(db, config, chain(), quotes, ctx.user, typed);
    } catch (error) {
      // Anything this step can say about itself, NEAR Intents being unreachable included, is said on the form.
      if (error.status) return page(ctx, { payError: error, status: error.status, payTyped: typed, bet });
      throw error;
    }
    redirect(ctx.res, `/me/wallet/pay/${deposit.id}${bet ? `?bet=${bet}` : ''}`);
  });

  // One payment: what to send, where, by when, and where it stands. Three things can go wrong for the
  // person paying (the wrong amount, the wrong chain, an address past its deadline), so the amount and
  // chain are the headline, the deadline has a line of its own, and an address is not shown once it has
  // passed. The page asks again by itself until the payment is finished: every 30 seconds while an address
  // is on screen, so a reload does not land in the middle of copying it, and every 8 once it is paid.
  route('GET', /^\/me\/wallet\/pay\/([0-9a-f-]{36})$/, async (ctx) => {
    if (!(await needUser(ctx))) return;
    if (!funding()) return notFound(ctx);
    let d = await depositFor(db, ctx.user.x_user_id, ctx.params[0]);
    if (!d) return notFound(ctx);
    const bet = betReference(ctx.url.searchParams.get('bet'));
    try { d = await refreshDeposit(db, config, chain(), quotes, d); } catch { /* shown as it last stood */ }
    const open = !d.finished_at;
    const gone = lapsed(d) || d.state === 'EXPIRED';
    const payable = ['PENDING_DEPOSIT', 'INCOMPLETE_DEPOSIT'].includes(d.state) && !gone;
    const got = amount(d.delivered_yocto || d.near_yocto);
    const how = html`paid with ${d.origin_symbol} on ${d.origin_chain}`;
    const again = html`<p class="acts"><a class="pill solid big" href="/me/wallet?add=${amount(d.near_yocto)}${bet ? `&bet=${bet}` : ''}#add">Get a new address</a></p>`;
    const wallet = html`<p class="acts"><a class="pill solid big" href="/me/wallet">Back to your wallet</a></p>`;
    const funded = bet ? html`<p class="acts"><a class="pill solid big" href="${returnToBet(bet)}">Back to bet</a></p>` : wallet;
    let body;
    if (payable) {
      body = html`
        <div class="hero"><h1 class="send">Send <b class="sel" id="pay-amount">${trim(d.amount_in)}</b> ${d.origin_symbol}<span>on ${d.origin_chain}, for ${amount(d.near_yocto)} NEAR</span></h1></div>
        ${qrSvg(d.deposit_address, { label: `QR code of the ${d.origin_chain} address to pay` })}
        <p class="payto" id="pay-address">${grouped(d.deposit_address)}</p>
        <p class="copies"><button class="pill solid" type="button" data-copy="pay-address" hidden>Copy address</button><button class="pill" type="button" data-copy="pay-amount" hidden>Copy amount</button>${d.deposit_memo ? html`<button class="pill" type="button" data-copy="pay-memo" hidden>Copy memo</button>` : ''}</p>
        ${d.deposit_memo ? html`<p class="lead">Memo<span class="acct" id="pay-memo">${d.deposit_memo}</span></p><p class="stakes left">The memo is required. Without it the payment cannot be matched.</p>` : ''}
        <p class="lead timeleft">Expires in ${minutesLeft(d.deadline)} min<span>at <time datetime="${new Date(d.deadline).toISOString()}">${clock(d.deadline)}</time></span></p>
        <p class="stakes left">Only ${d.origin_symbol}, only on ${d.origin_chain}. Send exactly this amount, once.</p>
        ${d.state === 'INCOMPLETE_DEPOSIT' ? html`<p class="stakes left" role="status">That was less than the amount. Send the rest to the same address before it expires.</p>` : ''}
        <script src="/static/pay.js?v=${payVersion}" defer></script>`;
    } else if (gone) {
      body = html`
        <div class="hero"><h1>This address has expired</h1><p>It was for ${amount(d.near_yocto)} NEAR with ${d.origin_symbol} on ${d.origin_chain}.</p></div>
        <p class="lead">Do not send to it.</p>
        ${again}
        <p class="quiet gut" role="status">${open ? 'Sent before it expired? This page catches up when the payment is seen.' : 'Sent it anyway? Give NEAR Intents this ID.'}</p>
        ${!open && d.signed?.correlationId ? html`<p class="copies apart"><button class="pill" type="button" data-copy="pay-ref" hidden>Copy ID</button></p><script src="/static/pay.js?v=${payVersion}" defer></script>` : ''}`;
    } else if (d.state === 'SUCCESS') {
      body = html`
        <div class="hero"><h1 role="status">${d.finished_at ? html`${got} NEAR is in your account` : 'Confirming your payment'}</h1><p>${d.finished_at ? how : 'Waiting for delivery to be verified on NEAR.'}</p></div>
        ${d.destination_tx ? html`<p class="gut"><a href="${transactionLink(d.destination_tx)}" rel="noopener noreferrer">See it on NearBlocks</a></p>` : ''}
        ${d.finished_at ? funded : ''}`;
    } else if (d.state === 'REFUNDED') {
      body = html`
        <div class="hero"><h1 role="status">Refunded</h1><p>It was for ${amount(d.near_yocto)} NEAR with ${d.origin_symbol} on ${d.origin_chain}. ${d.refunded ? html`${trim(d.refunded)} ${d.origin_symbol} went back to ${short(d.refund_to)}. It needed ${trim(d.amount_in)} ${d.origin_symbol}.` : html`It went back to ${short(d.refund_to)}.`}</p></div>
        ${again}`;
    } else if (d.state === 'FAILED') {
      body = html`
        <div class="hero"><h1 role="status">This payment failed</h1><p>Anything you sent goes back to <span class="acct">${d.refund_to}</span>.</p></div>
        ${wallet}`;
    } else {
      body = html`
        <div class="hero"><h1 role="status">${d.state === 'KNOWN_DEPOSIT_TX' ? html`Payment seen` : html`${amount(d.near_yocto)} NEAR on its way`}</h1><p>${d.state === 'KNOWN_DEPOSIT_TX' ? html`Waiting for ${d.origin_chain} to confirm it.` : how}</p></div>
        ${wallet}`;
    }
    // The token being paid with heads the page in every state.
    const mark = tokenMark({ symbol: d.origin_symbol, chain: d.origin_chain }, { size: 'lg' });
    const reference = d.signed?.correlationId;
    // On chains where one symbol names several tokens, the contract says which one this is.
    const tokenContract = /^nep141:[a-z0-9]+-(0x[0-9a-f]{40})\.omft\.near$/.exec(d.origin_asset)?.[1];
    const estimate = Number(d.signed?.quote?.timeEstimate);
    send(ctx.res, 200, await layout(ctx, 'Add NEAR', html`
      ${mark ? html`<p class="payhead">${mark}</p>` : ''}
      ${body}
      <div class="folds"><details class="fold"><summary>About this payment</summary>
        <p class="quiet">${amount(d.near_yocto)} NEAR arrives in <span class="acct">${d.account_id}</span>${Number.isFinite(estimate) && estimate > 0 && estimate < 3600 ? `, usually within ${estimate < 90 ? `${Math.round(estimate)} seconds` : `${Math.ceil(estimate / 60)} minutes`} of the payment confirming` : ''}. NEAR Intents sets the price and delivers to your Stated account.</p>
        ${tokenContract ? html`<p class="quiet">${d.origin_symbol} on ${d.origin_chain} here is the token at <span class="acct">${tokenContract}</span>.</p>` : ''}
        <p class="quiet">A payment that cannot complete goes back to <span class="acct">${d.refund_to}</span>.${d.min_amount_in ? ` Less than ${d.min_amount_in} ${d.origin_symbol} is refunded after the deadline, and anything over the amount is refunded.` : ''}</p>
        ${d.refund_reason ? html`<p class="quiet">NEAR Intents gave this reason for the refund: ${d.refund_reason}</p>` : ''}
        ${reference ? html`<p class="quiet">This payment’s ID, if you need to ask NEAR Intents about it: <span class="acct" id="pay-ref">${reference}</span></p>` : ''}
      </details></div>
    `, { kind: 'private', flush: true, back: '/me/wallet' }), { kind: 'private', headers: open ? { Refresh: payable ? '30' : '8' } : {} });
  });
}
