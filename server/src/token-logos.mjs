// Logos for the tokens and chains a payment can be made in, shown beside their
// names. The files are in server/public/tokens and come from the
// trustwallet/assets collection (see ATTRIBUTION.md there); the marks belong to
// their owners. A token or chain with no file gets no mark. Nothing is drawn in
// its place, and one token's mark never stands in for another's.
import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { html } from './html.mjs';
import { chainCode } from './intents.mjs';

const DIR = new URL('../public/tokens/', import.meta.url);
const FILES = new Map(existsSync(DIR)
  ? readdirSync(DIR).filter((name) => /^(?:chain|token)-[a-z0-9]+\.png$/.test(name)).sort().map((name) => [name, readFileSync(new URL(name, DIR))])
  : []);
/** Changes whenever any logo file does, so a browser never shows an old one. */
export const LOGO_VERSION = createHash('sha256').update(Buffer.concat([...FILES.values()])).digest('hex').slice(0, 10);
/** A logo file's bytes by name (chain-base.png), or null. */
export const logoFile = (name) => FILES.get(name) || null;

// A token's own mark. A chain's native coin shares the chain's mark. Only exact symbols:
// a wrapped or re-issued token (WETH, cbBTC, USDT0) is a different thing and is not given another's mark.
const TOKENS = {
  USDC: 'token-usdc', USDT: 'token-usdt', DAI: 'token-dai', WBTC: 'token-wbtc', WETH: 'token-weth',
  BTC: 'chain-btc', ETH: 'chain-eth', SOL: 'chain-sol', NEAR: 'chain-near', wNEAR: 'chain-near', ZEC: 'chain-zec', XRP: 'chain-xrp',
  DOGE: 'chain-doge', LTC: 'chain-ltc', BCH: 'chain-bch', DASH: 'chain-dash', TRX: 'chain-tron', TON: 'chain-ton', ADA: 'chain-cardano',
  XLM: 'chain-stellar', SUI: 'chain-sui', APT: 'chain-aptos', AVAX: 'chain-avax', BNB: 'chain-bsc', POL: 'chain-pol',
};
const have = (key) => (key && FILES.has(`${key}.png`) ? key : null);
const src = (key) => `/static/tokens/${key}.png?v=${LOGO_VERSION}`;

/**
 * The mark for a token on a chain: the token's logo, with the chain's logo set into its corner when the
 * token is not that chain's own coin. `chain` is the chain's code (base) or its name (Base).
 * Returns '' when the token has no logo, or an empty holder of the same size with { keep: true }, so
 * rows in a list stay aligned.
 */
export function tokenMark({ symbol, chain }, { size = '', keep = false } = {}) {
  const token = have(TOKENS[symbol]);
  const cls = `tok${size ? ` ${size}` : ''}`;
  if (!token) return keep ? html`<span class="${cls}"></span>` : '';
  const on = have(`chain-${chainCode(chain)}`);
  return html`<span class="${cls}"><img src="${src(token)}" alt="" width="32" height="32">${on && on !== token ? html`<img class="on" src="${src(on)}" alt="" width="16" height="16">` : ''}</span>`;
}

/** NEAR's own mark, for a balance. '' when the file is absent. */
export const nearMark = (options) => tokenMark({ symbol: 'NEAR', chain: 'near' }, options);
