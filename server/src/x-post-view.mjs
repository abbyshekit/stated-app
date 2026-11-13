// DESIGN.md: the original post owns its logo link and stored publication time.
import { html, utcTime } from './html.mjs';
import { X_MARK } from './bet-view.mjs';

export function xPostUrl(value, simulatedOrigin = null) {
  try {
    const url = new URL(value);
    if (url.username || url.password) return null;
    if (simulatedOrigin && url.origin === new URL(simulatedOrigin).origin) return url.href;
    if (url.protocol === 'https:' && /^(?:www\.)?(?:x\.com|twitter\.com)$/.test(url.hostname)
      && /^\/(?:\w+|i\/web)\/status\/\d+\/?$/.test(url.pathname)) return url.href;
  } catch { /* A missing or non-X source has no X decoration. */ }
  return null;
}

// The demo stack's posts live on a simulated X: say so in words instead of showing the real X mark.
export function postLogo(url, simulatedOrigin = null) {
  if (!url) return '';
  let simulated = false;
  try { simulated = Boolean(simulatedOrigin) && new URL(url).origin === new URL(simulatedOrigin).origin; } catch { simulated = false; }
  if (simulated) return html`<a class="src" href="${url}" rel="noopener noreferrer">On simulated X</a>`;
  return html`<a class="post-origin" href="${url}" aria-label="See the post on X" rel="noopener noreferrer">${X_MARK}</a>`;
}

export function postTime(url, value) {
  if (!url || !value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  return html`<p class="post-time"><a href="${url}" rel="noopener noreferrer"><time datetime="${date.toISOString()}">${utcTime(date)}</time></a></p>`;
}
