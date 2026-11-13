import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';

const source = readFileSync(new URL('../public/pay.js', import.meta.url), 'utf8');
function browser() {
  const listeners = new Map();
  const timers = [];
  const calls = [];
  const button = { hidden: true, disabled: false, addEventListener: (name, fn) => listeners.set(name, fn) };
  const balance = { textContent: '0.05 NEAR' };
  const missing = { textContent: '0.2 NEAR' };
  const status = { textContent: '' };
  const account = { textContent: 'alice.play.statedforecast.near' };
  const elements = { '[data-refresh-balance]': button, '[data-funding-balance]': balance,
    '[data-funding-missing]': missing, '[data-funding-status]': status, '#funding-account': account };
  const panel = { dataset: { neededYocto: '200000000000000000000000' }, querySelector: key => elements[key] };
  let reply = { accountId: account.textContent, neededYocto: panel.dataset.neededYocto, balanceNear: '0.9', missingNear: '0' };
  let fail = false;
  const context = vm.createContext({ document: { hidden: false, getElementById: () => null,
    querySelectorAll: selector => selector === '[data-funding]' ? [panel] : [] },
  setInterval: (fn, ms) => timers.push({ fn, ms }), setTimeout: () => {}, clearTimeout() {},
  AbortSignal, encodeURIComponent, fetch: async (...args) => { calls.push(args); if (fail) throw new Error('offline'); return { ok: true, json: async () => reply }; } });
  vm.runInContext(source, context);
  return { context, button, balance, missing, status, timers, calls, refresh: () => listeners.get('click')(),
    reply: value => { reply = value; }, fail: () => { fail = true; } };
}

test('refresh balance sends the current bet requirement and updates text without navigation', async () => {
  const b = browser();
  assert.equal(b.button.hidden, false);
  await b.refresh();
  assert.equal(b.calls[0][0], '/me/wallet/balance?need=200000000000000000000000');
  assert.equal(b.calls[0][1].credentials, 'same-origin');
  assert.equal(b.calls[0][1].cache, 'no-store');
  assert.equal(b.balance.textContent, '0.9 NEAR');
  assert.equal(b.missing.textContent, '0 NEAR');
  assert.match(b.status.textContent, /return to the bet/);
  assert.equal(b.button.disabled, false);
  assert.equal(b.timers[0].ms, 10000);
});

test('failed or wrong-account refresh preserves prior balance and gives a retry action', async () => {
  const b = browser();
  b.reply({ accountId: 'other.near', neededYocto: '0', balanceNear: '100', missingNear: '0' });
  await b.refresh();
  assert.equal(b.balance.textContent, '0.05 NEAR');
  assert.match(b.status.textContent, /Retry the balance check/);
  b.fail(); await b.refresh();
  assert.equal(b.balance.textContent, '0.05 NEAR');
  assert.equal(b.button.disabled, false);
});

test('including the payment script twice schedules one refresher', () => {
  const b = browser();
  vm.runInContext(source, b.context);
  assert.equal(b.timers.length, 1);
});
