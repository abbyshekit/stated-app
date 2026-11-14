import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { runInNewContext } from 'node:vm';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { createBet } from '../src/bets.mjs';
import { publishBet } from '../src/bet-public.mjs';
import { prepareNearAction, syncNearBet } from '../src/near-bets.mjs';
import { TESTNET_RPC } from '../src/near-escrow.mjs';
import { completeSetup, signInFromX } from '../src/store.mjs';
import { startStack } from './support/app.mjs';

test('managed submit guards duplicate requests and restores on pageshow', async () => {
  const listeners = {};
  const attrs = new Map();
  const button = { textContent: 'Bet no', disabled: false };
  const status = { textContent: '' };
  const form = { action: 'https://example.test/bets/123/take', method: 'post',
    dataset: { managedTake: '123' }, querySelector: () => button,
    addEventListener: (name, fn) => { listeners[name] = fn; },
    getAttribute: name => attrs.get(name) ?? null,
    setAttribute: (name, value) => attrs.set(name, value), removeAttribute: name => attrs.delete(name) };
  const windowListeners = {};
  const document = { querySelectorAll: selector => selector === 'form[data-managed-take]' ? [form] : [],
    getElementById: id => id === 'managed-take-status' ? status : null };
  const window = { location: { origin: 'https://example.test', href: 'https://example.test/bets/123' }, addEventListener: (name, fn) => { windowListeners[name] = fn; } };
  const timers = [];
  runInNewContext(await readFile(new URL('../public/pay.js', import.meta.url), 'utf8'),
    { document, window, navigator: {}, URL, setTimeout: fn => timers.push(fn) });
  const submit = () => { const event = { defaultPrevented: false, preventDefault() { this.defaultPrevented = true; } }; listeners.submit(event); return event; };
  const cancelled = submit(); cancelled.preventDefault(); timers.shift()();
  assert.equal(button.disabled, false);
  const first = submit(); timers.shift()();
  assert.equal(first.defaultPrevented, false);
  assert.equal(button.disabled, true); assert.equal(button.textContent, 'Matching stake');
  assert.equal(attrs.get('aria-busy'), 'true'); assert.equal(status.textContent, 'Matching stake');
  assert.equal(submit().defaultPrevented, true);
  windowListeners.pageshow();
  assert.equal(button.disabled, false); assert.equal(button.textContent, 'Bet no');
  assert.equal(attrs.has('aria-busy'), false); assert.equal(status.textContent, '');
  assert.equal(submit().defaultPrevented, false);
});

test('unrelated, cross-origin and mismatched forms are untouched', async () => {
  const source = await readFile(new URL('../public/pay.js', import.meta.url), 'utf8');
  for (const [action, method, marker] of [
    ['https://elsewhere.test/bets/123/take', 'post', '123'],
    ['https://example.test/bets/123/accept', 'post', '123'],
    ['https://example.test/bets/456/take', 'post', '123'],
    ['https://example.test/bets/123/take?next=1', 'post', '123'],
    ['https://example.test/bets/123/take', 'get', '123'],
  ]) {
    let attached = false;
    const form = { action, method, dataset: { managedTake: marker }, addEventListener() { attached = true; } };
    const document = { querySelectorAll: selector => selector === 'form[data-managed-take]' ? [form] : [], getElementById: () => null };
    const window = { location: { href: 'https://example.test/', origin: 'https://example.test' } };
    runInNewContext(source, { document, window, navigator: {}, URL });
    assert.equal(attached, false, `${method} ${action}`);
  }
});

test('managed join serves one versioned script and keeps ordinary form fields over HTTP', async () => {
  let s, chain;
  const fetchImpl = async (url, options) => {
    if (s && String(url).startsWith(s.fakeX.base)) return fetch(url, options);
    assert.equal(url, TESTNET_RPC);
    const { method, params } = JSON.parse(options.body);
    assert.equal(method, 'query'); assert.equal(params.method_name, 'get_bet');
    const { id } = JSON.parse(Buffer.from(params.args_base64, 'base64'));
    return Response.json({ jsonrpc: '2.0', id: 'stated', result: { block_height: 1, result: [...Buffer.from(JSON.stringify(id === chain?.id ? chain : null))] } });
  };
  try {
    s = await startStack({ STATED_NEAR_CONTRACT: 'escrow.testnet' }, { fetchImpl });
    const creator = await completeSetup(s.db, await signInFromX(s.db, { id: '98411', username: 'submit_owner' }), {});
    const taker = await completeSetup(s.db, await signInFromX(s.db, { id: '98412', username: 'submit_taker' }), {});
    const browser = await s.signIn(s.fakeX.addUser('98412', 'submit_taker'));
    const bet = await createBet(s.db, creator, { requestId: randomUUID(), claim: 'Synthetic submit feedback', criteria: 'Synthetic result',
      evidenceSourceUrl: 'https://example.org/result', creatorSide: 'yes', stakeNear: '0.1',
      acceptBy: new Date(Date.now() + 86400000).toISOString(), resolveAt: new Date(Date.now() + 172800000).toISOString() });
    const funding = await prepareNearAction(s.db, s.config, creator, bet.id, { action: 'fund', accountId: 'owner.testnet' }, { fetchImpl });
    const ns = value => (BigInt(new Date(value).getTime()) * 1000000n).toString();
    chain = { id: bet.id, terms_hash: bet.terms_hash, stake_yocto: bet.stake_yocto, creator_side: bet.creator_side,
      accept_by_ns: ns(bet.accept_by), resolve_at_ns: ns(bet.resolve_at), invited_account: null, creator: 'owner.testnet',
      creator_binding_hash: funding.args.binding_hash, acceptor: null, proposal: null, status: 'offered' };
    await syncNearBet(s.db, s.config, creator, bet.id, { fetchImpl }); await publishBet(s.db, creator, bet.id);
    s.config.play.enabled = true;
    await s.db.query("insert into play_accounts(x_user_id,account_id,public_key,ready) values($1,'managed.testnet','synthetic',true)", [taker.x_user_id]);
    await s.db.query(`update bilateral_bets set referee_wallet='referee.testnet', chain_state=jsonb_set(chain_state,'{referee}','"referee.testnet"') where id=$1`, [bet.id]);
    const page = await browser.get(`/bets/${bet.id}?join=1`);
    assert.equal(page.status, 200);
    assert.match(page.text, new RegExp(`action="/bets/${bet.id}/take" id="accept" data-managed-take="${bet.id}"`));
    assert.match(page.text, /name="csrf"/); assert.match(page.text, /name="termsHash"/);
    assert.match(page.text, /name="publicConsent" value="1" required/);
    assert.equal((page.text.match(/<script src="\/static\/pay\.js\?v=[^"]+" defer><\/script>/g) || []).length, 1);
    assert.match(page.text, /id="managed-take-status"/);
  } finally { if (s) await s.close(); }
});
