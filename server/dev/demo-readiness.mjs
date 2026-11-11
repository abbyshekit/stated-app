// Read-only demo diagnostics. Never provision an account or expose stored keys.
import { kvGet } from '../src/db.mjs';
import { open } from '../src/crypto.mjs';

export async function escrowReadiness({ db, config, chain }) {
  if (config.near.real || !config.play.enabled || !config.nearContract?.endsWith('.testnet')) return 'disabled';
  try {
    const bank = config.play.treasury || JSON.parse(open(await kvGet(db, 'play_treasury'), config.tokenKey)).id;
    const judge = JSON.parse(open(await kvGet(db, 'play_referee'), config.tokenKey)).id;
    if (!bank?.endsWith('.testnet') || !judge?.endsWith('.testnet')) return 'waiting';
    const balances = await Promise.all([chain.balance(bank), chain.balance(judge)]);
    if (balances.some((balance) => balance == null || BigInt(balance) <= 0n)) return 'degraded';
    return 'checked';
  } catch {
    return 'degraded';
  }
}

export function readinessPage(state, app, workerReportedError = false, practice = false) {
  const descriptions = {
    disabled: 'Reply betting is not configured for this testnet demo.',
    waiting: 'Testnet escrow accounts are still initializing.',
    degraded: 'Testnet escrow is unavailable or still initializing. The worker retries automatically; refresh this page later.',
    checked: 'The testnet treasury and referee accounts responded with a balance. This check does not guarantee a transaction will succeed.',
  };
  const url = String(app).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  return `<!doctype html><html lang="en"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Demo readiness</title><body style="font-family:system-ui;max-width:40rem;margin:2rem auto;padding:0 1rem;line-height:1.5"><h1>Demo readiness</h1><p><strong>Simulated X and labelled test fixtures.</strong> X posts here are local, not real X posts. Escrow, when available, uses real NEAR testnet transactions and test NEAR.</p><h2>Testnet escrow</h2><p>${descriptions[state] || descriptions.degraded}</p>${workerReportedError ? '<p>The reply-bet worker reported an error since startup. It retries automatically; account checks do not confirm the worker has recovered.</p>' : ''}${practice ? '<p><a href="/demo-challenge">Practice a bet on testnet</a></p>' : ''}<p><a href="/demo-proof">Verify the recorded payout</a></p><p><a href="${url}">Browse seeded predictions in Stated</a> or return to simulated X to post and tag the bot. Prediction browsing and capture do not require escrow.</p></body></html>`;
}
