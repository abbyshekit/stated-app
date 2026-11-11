import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { startStack } from './support/app.mjs';
import { randomUUID } from 'node:crypto';
import { betFor, betsFor, createBet } from '../src/bets.mjs';
import { completeSetup, ownerCollections, recordOf, signInFromX } from '../src/store.mjs';
import { formatTestNear, parseTestNear } from '../src/near-escrow.mjs';

let s;
let alice;
let bob;
let outsider;
before(async () => { s = await startStack(); });
after(async () => { if (s) await s.close(); });

test('a first-time X sign-in preserves a challenge invitation through setup', async () => {
  const user = s.fakeX.addUser('761', 'first_invitee');
  const browser = s.browser();
  const target = '/bets/ce22df63-8310-4d84-9dbb-d418844f468f';
  s.fakeX.consentAs = user.id;
  const setup = await browser.get(`/signin/x?return=${encodeURIComponent(target)}`);
  s.fakeX.consentAs = null;
  assert.equal(setup.status, 200);
  assert.match(setup.text, /Finish setup/);
  assert.match(setup.text, /name="return"/);
  const result = await browser.submit('/setup', { profile: 'private', defaults: 'private', return: target });
  assert.equal(new URL(result.url).pathname, target);
});

async function users() {
  if (alice) return;
  alice = await completeSetup(s.db, await signInFromX(s.db, { id: '771', username: 'bet_alice' }), {});
  bob = await completeSetup(s.db, await signInFromX(s.db, { id: '772', username: 'bet_bob' }), {});
  outsider = await completeSetup(s.db, await signInFromX(s.db, { id: '773', username: 'bet_other' }), {});
}

function terms(overrides = {}) {
  return { requestId: randomUUID(), claim: 'SYNTHETIC: an observable prediction',
    criteria: 'Resolve yes only when the agreed source explicitly confirms the event.',
    evidenceSourceUrl: 'https://docs.near.org/', creatorSide: 'yes', stakeNear: '0.1',
    opponentUsername: '', opponentAccount: '', acceptBy: new Date(Date.now() + 3600000).toISOString(),
    resolveAt: new Date(Date.now() + 7200000).toISOString(), ...overrides };
}

test('creation persists exact testnet amounts and immutable terms without claiming funds', async () => {
  await users();
  const input = terms({ stakeNear: '0.123456789012345678901234' });
  const bet = await createBet(s.db, alice, input);
  assert.equal(bet.stake_yocto, '123456789012345678901234');
  assert.equal(formatTestNear(bet.stake_yocto), input.stakeNear);
  assert.equal(bet.chain_state, null);
  assert.equal(bet.acceptor_user_id, null);
  assert.equal(bet.status, 'offered');
  assert.equal(bet.events.length, 1);
  assert.match(bet.terms_hash, /^[a-f0-9]{64}$/);
  assert.equal((await betFor(s.db, alice, bet.id)).claim, input.claim);
});

test('concurrent repeated submissions create one offer; conflicting terms reject reuse', async () => {
  await users();
  const input = terms();
  const [a, b] = await Promise.all([createBet(s.db, alice, input), createBet(s.db, alice, input)]);
  assert.equal(a.id, b.id);
  assert.equal((await betFor(s.db, alice, a.id)).events.length, 1);
  await assert.rejects(createBet(s.db, alice, { ...input, stakeNear: '0.2' }), { status: 409 });
});

test('named invitations bind a stable X identity and a testnet wallet', async () => {
  await users();
  const input = terms({ opponentUsername: 'bet_bob', opponentAccount: 'bob.testnet' });
  const bet = await createBet(s.db, alice, input);
  assert.equal(bet.invited_user_id, bob.id);
  assert.equal(bet.invited_wallet, 'bob.testnet');
  assert.equal((await betFor(s.db, bob, bet.id)).id, bet.id);
  await assert.rejects(betFor(s.db, outsider, bet.id), { status: 404 });
  assert.ok((await betsFor(s.db, bob)).some((row) => row.id === bet.id));
  await assert.rejects(createBet(s.db, alice, terms({ opponentUsername: 'bet_bob' })), /testnet account/);
  await assert.rejects(createBet(s.db, alice, terms({ opponentUsername: 'bet_alice', opponentAccount: 'alice.testnet' })), /another person/);
});

test('bad amounts and impossible dates fail at the boundary without storing an offer', async () => {
  await users();
  const count = await s.db.one('select count(*)::int as n from bilateral_bets');
  for (const stakeNear of ['0', '-1', '1.01', '1e-1', '0.0000000000000000000000001', 'NaN', '0.1junk']) {
    await assert.rejects(createBet(s.db, alice, terms({ stakeNear })), /stake/);
  }
  for (const acceptBy of ['2030-02-30T12:00:00Z', '2030-01-01', '2020-01-01T00:00:00Z']) {
    await assert.rejects(createBet(s.db, alice, terms({ acceptBy })), /date|deadline/);
  }
  assert.equal((await s.db.one('select count(*)::int as n from bilateral_bets')).n, count.n);
  assert.equal(parseTestNear('0.000000000000000000000001'), '1');
});

test('private challenges require auth, carry no public previews and escape user text', async () => {
  const xuser = s.fakeX.addUser('781', 'bet_browser');
  const browser = await s.signIn(xuser);
  await browser.submit('/setup', { profile: 'private', defaults: 'private' });
  const user = await s.db.one('select * from users where x_user_id=$1', [xuser.id]);
  const bet = await createBet(s.db, user, terms({ claim: '<script>alert(1)</script> SYNTHETIC' }));
  const anon = await s.browser().request('GET', `/bets/${bet.id}`);
  assert.equal(anon.status, 303);
  assert.match(anon.location, /signin\?return=/);
  const detail = await browser.get(`/bets/${bet.id}`);
  assert.equal(detail.status, 200);
  assert.equal(detail.headers.get('cache-control'), 'no-store');
  assert.match(detail.headers.get('x-robots-tag'), /noindex/);
  assert.match(detail.text, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
  assert.doesNotMatch(detail.text, /<script>alert|property="og:/);
  const list = await browser.get('/me/bets');
  assert.match(list.text, />Not funded</);
  assert.doesNotMatch(list.text, />Awaiting acceptance</);
  const publicExport = await s.browser().get('/api/u/bet_browser/export.json');
  assert.equal(publicExport.status, 404);
  const attack = await browser.request('POST', `/bets/${bet.id}/fund`, { form: { accountId: 'browser.testnet', csrf: 'wrong' } });
  assert.equal(attack.status, 403);
  const noEscrow = await browser.submit(`/bets/${bet.id}/fund`, { accountId: 'browser.testnet' });
  assert.equal(noEscrow.status, 503);
  assert.equal((await betFor(s.db, user, bet.id)).chain_state, null);
});

test('expired offers cannot appear open and challenges never enter forecast scores', async () => {
  await users();
  const before = recordOf((await ownerCollections(s.db, alice)).mine);
  const bet = await createBet(s.db, alice, terms());
  await s.db.query("update bilateral_bets set accept_by=now()-interval '1 second' where id=$1", [bet.id]);
  assert.equal((await betFor(s.db, alice, bet.id)).display_status, 'expired');
  const after = recordOf((await ownerCollections(s.db, alice)).mine);
  assert.deepEqual(after, before);
});
