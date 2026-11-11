// INTEGRATION: NEAR Intents, through its 1Click API.
//
// tokens() and quote() are dry runs: what an amount of NEAR would cost if it
// were paid from another chain or in another token. No deposit address is made
// and nothing moves. NEAR Intents has no testnet, so on a testnet server a quote
// is what the same stake would cost on mainnet, and it is never charged.
//
// deposit() and status() are the real thing, used only on mainnet (funding.mjs):
// deposit() asks for an address to pay into, and NEAR Intents delivers the NEAR
// to the named account once the payment arrives there. This server never holds
// or sends the payer's tokens; the payer sends them from their own wallet.
// API reference: https://docs.near-intents.org (read 10 November 2026).
import Decimal from 'decimal.js';

export const INTENTS_API = 'https://1click.chaindefuser.com';
// Stakes are NEAR, which NEAR Intents delivers as wrapped NEAR.
const NEAR_ASSET = 'nep141:wrap.near';
// A dry quote names a recipient but sends it nothing; it only has to be a well-formed account.
const QUOTE_ACCOUNT = 'example.near';
// The states the 1Click API reports for a deposit address.
export const DEPOSIT_STATES = ['PENDING_DEPOSIT', 'KNOWN_DEPOSIT_TX', 'INCOMPLETE_DEPOSIT', 'PROCESSING', 'SUCCESS', 'REFUNDED', 'FAILED'];
const digits = (value) => typeof value === 'string' && /^\d{1,60}$/.test(value);
const decimal = (value) => typeof value === 'string' && /^\d{1,40}(\.\d{1,40})?$/.test(value);
const TOKENS_FOR_MS = 10 * 60 * 1000;
const QUOTE_FOR_MS = 45 * 1000;
const FAILURE_FOR_MS = 15 * 1000;

// Names for the chain codes the API uses. A code that is not here is shown as it comes.
const CHAINS = {
  arb: 'Arbitrum', aptos: 'Aptos', avax: 'Avalanche', base: 'Base', bch: 'Bitcoin Cash', bsc: 'BNB Chain', btc: 'Bitcoin',
  cardano: 'Cardano', dash: 'Dash', doge: 'Dogecoin', eth: 'Ethereum', gnosis: 'Gnosis', ltc: 'Litecoin', near: 'NEAR',
  op: 'Optimism', pol: 'Polygon', scroll: 'Scroll', sol: 'Solana', starknet: 'Starknet', stellar: 'Stellar', sui: 'Sui',
  ton: 'TON', tron: 'Tron', xrp: 'XRP Ledger', zec: 'Zcash',
};
export const chainName = (code) => CHAINS[code] || String(code || '');
/** A chain's code from its code or its name: base from Base. Anything unknown comes back in lowercase. */
export const chainCode = (value) => (Object.hasOwn(CHAINS, value) ? value : Object.keys(CHAINS).find((code) => CHAINS[code] === value) || String(value || '').toLowerCase());

// An amount for a sentence: two places from 1 up, three significant figures below.
export function shortAmount(value) {
  const d = new Decimal(value);
  if (d.gte(1000)) return d.toFixed(0);
  if (d.gte(1)) return d.toFixed(2);
  return d.toSignificantDigits(3).toFixed();
}
// Yocto to NEAR, rounded up to two places: a minimum is never understated.
export const nearUp = (yocto) => new Decimal(yocto).div('1e24').toDecimalPlaces(2, Decimal.ROUND_UP).toFixed();

export function intentsQuotes({ fetchImpl = fetch, base = INTENTS_API, now = () => Date.now() } = {}) {
  let list = null;
  let listAt = 0;
  const quotes = new Map();

  // Every token a stake could be paid in, sorted by chain and symbol. Empty when the API cannot be reached.
  async function tokens() {
    if (list && now() - listAt < (list.length ? TOKENS_FOR_MS : FAILURE_FOR_MS)) return list;
    let found = [];
    try {
      const res = await fetchImpl(`${base}/v0/tokens`, { signal: AbortSignal.timeout(3000) });
      if (res.ok) {
        const seen = new Set();
        for (const t of await res.json()) {
          if (!t || typeof t.assetId !== 'string' || typeof t.symbol !== 'string' || t.assetId === NEAR_ASSET || seen.has(t.assetId)) continue;
          if (t.assetId.length > 200 || t.symbol.length > 24) continue;
          seen.add(t.assetId);
          found.push({ assetId: t.assetId, symbol: t.symbol, chain: String(t.blockchain || ''), chainName: chainName(t.blockchain) });
        }
        found.sort((a, b) => a.chainName.localeCompare(b.chainName) || a.symbol.localeCompare(b.symbol));
      }
    } catch { found = []; }
    list = found;
    listAt = now();
    return list;
  }

  // What `yocto` of NEAR costs in the given token, as a dry run.
  //   { ok: true, amount, usd, seconds, at }
  //   { ok: false, reason: 'minimum', minimumYocto }   the route has a floor above this stake
  //   { ok: false, reason: 'unknown' | 'unavailable' }
  async function quote(assetId, yocto) {
    if (!(await tokens()).some((t) => t.assetId === assetId)) return { ok: false, reason: 'unknown' };
    if (!/^[1-9]\d{0,40}$/.test(String(yocto))) return { ok: false, reason: 'unavailable' };
    const key = `${assetId}|${yocto}`;
    const kept = quotes.get(key);
    if (kept && now() - kept.at.getTime() < (kept.ok ? QUOTE_FOR_MS : FAILURE_FOR_MS)) return kept;
    let result = { ok: false, reason: 'unavailable', at: new Date(now()) };
    try {
      const res = await fetchImpl(`${base}/v0/quote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(4000),
        body: JSON.stringify({
          dry: true,
          swapType: 'EXACT_OUTPUT',
          slippageTolerance: 100,
          originAsset: assetId,
          depositType: 'ORIGIN_CHAIN',
          destinationAsset: NEAR_ASSET,
          amount: String(yocto),
          recipient: QUOTE_ACCOUNT,
          recipientType: 'DESTINATION_CHAIN',
          refundTo: QUOTE_ACCOUNT,
          refundType: 'INTENTS',
          deadline: new Date(now() + 15 * 60 * 1000).toISOString(),
        }),
      });
      const body = await res.json().catch(() => null);
      const amount = body?.quote?.amountInFormatted;
      if (res.ok && typeof amount === 'string' && /^\d+(\.\d+)?$/.test(amount) && new Decimal(amount).gt(0)) {
        const usd = body.quote.amountInUsd;
        const seconds = Number(body.quote.timeEstimate);
        result = { ok: true, amount, usd: typeof usd === 'string' && /^\d+(\.\d+)?$/.test(usd) ? usd : null,
          seconds: Number.isFinite(seconds) && seconds > 0 && seconds < 3600 ? Math.round(seconds) : null, at: new Date(now()) };
      } else {
        const floor = /try at least (\d{1,40})\b/.exec(String(body?.message || ''))?.[1];
        if (floor) result = { ok: false, reason: 'minimum', minimumYocto: floor, at: new Date(now()) };
      }
    } catch { /* unreachable or slow: the page says there is no quote */ }
    quotes.set(key, result);
    if (quotes.size > 500) quotes.delete(quotes.keys().next().value);
    return result;
  }

  // A real quote. NEAR Intents answers with an address on the token's own chain; once
  // the payer sends `amountIn` of the token there, `yocto` of NEAR is delivered to
  // `recipient`. A payment that cannot be completed goes back to `refundTo`, an address
  // on the token's chain that the payer controls.
  //   { ok: true, depositAddress, depositMemo, amountIn, amountInFormatted, minAmountInFormatted, deadline, seconds, signed }
  //   { ok: false, reason: 'minimum', minimumYocto } | { ok: false, reason: 'refused', message } | { ok: false, reason: 'unknown' | 'unavailable' }
  async function deposit({ assetId, yocto, recipient, refundTo, minutes = 60 }) {
    if (!(await tokens()).some((t) => t.assetId === assetId)) return { ok: false, reason: 'unknown' };
    if (!/^[1-9]\d{0,40}$/.test(String(yocto))) return { ok: false, reason: 'unavailable' };
    try {
      const res = await fetchImpl(`${base}/v0/quote`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        signal: AbortSignal.timeout(20000),
        body: JSON.stringify({
          dry: false,
          swapType: 'EXACT_OUTPUT',
          slippageTolerance: 100,
          originAsset: assetId,
          depositType: 'ORIGIN_CHAIN',
          destinationAsset: NEAR_ASSET,
          amount: String(yocto),
          recipient,
          recipientType: 'DESTINATION_CHAIN',
          refundTo,
          refundType: 'ORIGIN_CHAIN',
          deadline: new Date(now() + minutes * 60 * 1000).toISOString(),
        }),
      });
      const body = await res.json().catch(() => null);
      const q = body?.quote;
      const deadline = new Date(q?.deadline || '');
      if (res.ok && q && typeof q.depositAddress === 'string' && q.depositAddress.length >= 4 && q.depositAddress.length <= 200
        && !/\s/.test(q.depositAddress) && digits(q.amountIn) && decimal(q.amountInFormatted) && new Decimal(q.amountInFormatted).gt(0)
        && Number.isFinite(deadline.getTime()) && deadline.getTime() > now()) {
        const seconds = Number(q.timeEstimate);
        // The smallest payment that still completes, in the token's own units, when the API gives one.
        let least = null;
        if (digits(q.minAmountIn) && new Decimal(q.amountIn).gt(0)) {
          least = new Decimal(q.amountInFormatted).mul(q.minAmountIn).div(q.amountIn).toSignificantDigits(8, Decimal.ROUND_UP).toFixed();
        }
        return { ok: true, depositAddress: q.depositAddress,
          depositMemo: typeof q.depositMemo === 'string' && q.depositMemo.length <= 200 ? q.depositMemo : null,
          amountIn: q.amountIn, amountInFormatted: q.amountInFormatted, minAmountInFormatted: least, deadline,
          seconds: Number.isFinite(seconds) && seconds > 0 && seconds < 3600 ? Math.round(seconds) : null,
          // Retain the provider's signature and its request context for later verification.
          signed: { correlationId: typeof body.correlationId === 'string' ? body.correlationId.slice(0, 200) : null,
            timestamp: typeof body.timestamp === 'string' && body.timestamp.length <= 64 ? body.timestamp : null,
            signature: typeof body.signature === 'string' && body.signature.length <= 160 ? body.signature : null,
            quoteRequest: body.quoteRequest && typeof body.quoteRequest === 'object' && !Array.isArray(body.quoteRequest)
              && JSON.stringify(body.quoteRequest).length <= 4096 ? body.quoteRequest : null, quote: q } };
      }
      const message = String(body?.message || '').slice(0, 300);
      const floor = /try at least (\d{1,40})\b/.exec(message)?.[1];
      if (floor) return { ok: false, reason: 'minimum', minimumYocto: floor };
      if (res.status >= 400 && res.status < 500) return { ok: false, reason: 'refused', message };
    } catch { /* unreachable or slow */ }
    return { ok: false, reason: 'unavailable' };
  }

  // Where a payment stands.
  //   { ok: true, state, deliveredYocto, destinationTx, refunded, refundReason }
  //   { ok: false, reason: 'unknown' | 'unavailable' }
  async function status({ depositAddress, depositMemo = null }) {
    try {
      const url = new URL(`${base}/v0/status`);
      url.searchParams.set('depositAddress', depositAddress);
      if (depositMemo) url.searchParams.set('depositMemo', depositMemo);
      const res = await fetchImpl(url, { signal: AbortSignal.timeout(8000) });
      if (res.status === 404) return { ok: false, reason: 'unknown' };
      const body = res.ok ? await res.json().catch(() => null) : null;
      if (!body || !DEPOSIT_STATES.includes(body.status)) return { ok: false, reason: 'unavailable' };
      const d = body.swapDetails || {};
      const hash = d.destinationChainTxHashes?.[0]?.hash;
      return { ok: true, state: body.status,
        deliveredYocto: digits(d.amountOut) ? d.amountOut : null,
        destinationTx: typeof hash === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,64}$/.test(hash) ? hash : null,
        refunded: decimal(d.refundedAmountFormatted) ? d.refundedAmountFormatted : null,
        refundReason: typeof d.refundReason === 'string' ? d.refundReason.slice(0, 200) : null };
    } catch { return { ok: false, reason: 'unavailable' }; }
  }

  return { tokens, quote, deposit, status };
}
