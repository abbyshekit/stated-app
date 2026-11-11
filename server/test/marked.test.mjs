// The Marked presentation helpers: how long until we find out, and the two-seat Bet block.
import test from 'node:test';
import assert from 'node:assert/strict';
import { betBlock, betLead, betState, dayMonth, timeLeft } from '../src/marked.mjs';

const NOW = Date.UTC(2026, 10, 10, 15, 0, 0);
const STAKE = '100000000000000000000000'; // 0.1 test NEAR
const soon = () => new Date(Date.now() + 5 * 86400000).toISOString();
const past = () => new Date(Date.now() - 86400000).toISOString();
const bet = (over = {}) => ({ id: 'b', status: 'offered', funded: true, accept_by: soon(), resolve_at: soon(),
  creator_side: 'no', creator_username: 'priya', stake_yocto: STAKE, ...over });
const text = (value) => String(value).replace(/\s+/g, ' ');

test('timeLeft counts whole UTC days and switches units at a year and at two', () => {
  assert.equal(timeLeft('2026-11-10T23:59:59Z', NOW), 'Due today');
  assert.equal(timeLeft('2026-11-11T00:00:01Z', NOW), '1 day to go');
  assert.equal(timeLeft('2026-11-12T12:00:00Z', NOW), '2 days to go');
  assert.equal(timeLeft('2027-03-01T23:59:59Z', NOW), '111 days to go');
  assert.equal(timeLeft('2027-11-09T00:00:00Z', NOW), '364 days to go');
  assert.equal(timeLeft('2027-12-31T23:59:59Z', NOW), '14 months to go');
  assert.equal(timeLeft('2030-01-01T00:00:00Z', NOW), '3 years to go');
  assert.equal(timeLeft('2026-11-09T12:00:00Z', NOW), 'Past due');
  assert.equal(timeLeft(null, NOW), '');
  assert.equal(timeLeft('garbage', NOW), '');
});

test('dayMonth is UTC and adds the year only when asked', () => {
  assert.equal(dayMonth('2026-09-28T23:30:00Z'), '28 Sep');
  assert.equal(dayMonth('2026-09-28T23:30:00Z', { year: true }), '28 Sep 2026');
  assert.equal(dayMonth('nope'), '');
});

test('betState: open needs funding and an unexpired offer; decided needs an agreed yes or no', () => {
  assert.deepEqual(betState(bet()), { funded: true, expired: false, open: true, decided: false });
  assert.equal(betState(bet({ funded: false })).open, false);
  assert.equal(betState(bet({ accept_by: past() })).open, false);
  assert.equal(betState(bet({ accept_by: past() })).expired, true);
  assert.equal(betState(bet({ status: 'settled', outcome: 'yes' })).decided, true);
  assert.equal(betState(bet({ status: 'settled', outcome: 'void' })).decided, false);
  // A private Bet has no `funded` flag; its chain snapshot stands in.
  assert.equal(betState(bet({ funded: undefined, chain_state: { status: 'offered' } })).open, true);
});

test('betLead speaks to the reader: a dare to a visitor, a status to the person who made it', () => {
  assert.equal(betLead(bet()).text, '@priya dares you');
  assert.match(betLead(bet()).aside, /^Open until \d{1,2} \w{3}$/);
  assert.equal(betLead(bet(), { viewer: { x_username: 'Priya' } }).text, 'Your bet is open');
  assert.equal(betLead(bet({ funded: false })).text, 'Not funded yet');
  assert.equal(betLead(bet({ accept_by: past() })).text, 'Nobody took this one');
  assert.equal(betLead(bet({ status: 'accepted', acceptor_username: 'oskar' })).text, 'Both sides are in');
  assert.equal(betLead(bet({ status: 'proposed', acceptor_username: 'oskar' })).aside, 'Both must agree');
  assert.equal(betLead(bet({ status: 'settled', outcome: 'no', acceptor_username: 'oskar' })).text, '@priya won');
  assert.equal(betLead(bet({ status: 'settled', outcome: 'yes', acceptor_username: 'oskar' })).text, '@oskar won');
  assert.equal(betLead(bet({ status: 'settled', outcome: 'yes', acceptor_username: 'oskar' }), { viewer: { x_username: 'oskar' } }).text, 'You won');
  assert.equal(betLead(bet({ status: 'settled', outcome: 'void', acceptor_username: 'oskar' })).text, 'Called off');
  assert.equal(betLead(bet({ status: 'unverified' })).text, 'Needs verification');
});

test('betBlock: the open seat invites the viewer with their own face, greyed, and links to the join page', () => {
  const viewer = { x_username: 'oskar', x_avatar_url: 'https://pbs.twimg.com/profile_images/1/o.jpg' };
  const out = text(betBlock(bet(), { viewer, joinHref: '/bets/b?join=1#accept' }));
  assert.match(out, /<a class="seat" href="\/bets\/b\?join=1#accept"><img class="face ghost" src="https:\/\/pbs\.twimg\.com\/profile_images\/1\/o\.jpg"[^>]*><b>You\?<\/b><span>bet yes<\/span><\/a>/);
  assert.match(out, /<b>@priya<\/b><span>bet no<\/span>/);
  assert.match(out, /<b>0\.1<\/b><small>test NEAR each<\/small><\/div>/);
  // "bet yes" is always the left seat, whoever made the offer.
  assert.ok(out.indexOf('bet yes') < out.indexOf('bet no'));
  const flipped = text(betBlock(bet({ creator_side: 'yes' }), { viewer }));
  assert.ok(flipped.indexOf('@priya') < flipped.indexOf('You?'));
});

test('betBlock: a signed-out visitor sees an empty seat; the person who made the offer sees "Anyone"; nobody is invited once it closes', () => {
  const out = text(betBlock(bet(), { joinHref: '/j' }));
  assert.match(out, /<a class="seat" href="\/j"><span class="open"><\/span><b>You\?<\/b>/);
  assert.doesNotMatch(out, /class="face ghost"/);
  const mine = text(betBlock(bet(), { viewer: { x_username: 'priya', x_avatar_url: null }, joinHref: '/j' }));
  assert.match(mine, /<div class="seat"><span class="open"><\/span><b>Anyone<\/b><span>bet yes<\/span><\/div>/);
  assert.match(mine, /<b>You<\/b><span>bet no<\/span>/);
  assert.doesNotMatch(mine, /href="\/j"/);
  const unfunded = text(betBlock(bet({ funded: false }), { viewer: { x_username: 'oskar', x_avatar_url: null }, joinHref: '/j' }));
  assert.match(unfunded, /<b>Anyone<\/b>/);
  assert.doesNotMatch(unfunded, /You\?|href="\/j"/, 'an unfunded offer cannot be taken yet');
  const closed = text(betBlock(bet({ accept_by: past() }), { joinHref: '/j' }));
  assert.match(closed, /<b>Nobody<\/b><span>bet yes<\/span>/);
  assert.doesNotMatch(closed, /href="\/j"/);
});

test('betBlock: an agreed result rings the winner in ink; only a Prediction that came true makes the ring yellow', () => {
  const settled = bet({ status: 'settled', outcome: 'yes', creator_side: 'yes', acceptor_username: 'oskar' });
  const agreed = text(betBlock(settled));
  assert.match(agreed, /<div class="versus agreed">/);
  assert.match(agreed, /<div class="seat won">[^]*?<b>@priya<\/b><span>bet yes<\/span><\/div>/);
  assert.match(agreed, /<div class="seat lost">[^]*?<b>@oskar<\/b><span>bet no<\/span><\/div>/);
  assert.match(agreed, /<b>0\.2<\/b><small>test NEAR<\/small><small>credited<\/small>/);
  assert.match(text(betBlock(settled, { cameTrue: true })), /<div class="versus">/);
  const called = text(betBlock(bet({ status: 'settled', outcome: 'void', acceptor_username: 'oskar' })));
  assert.doesNotMatch(called, /seat won|seat lost/);
  assert.match(called, /<small>escrow closed<\/small>/);
  assert.doesNotMatch(called, /Stakes returned|<small>returned<\/small>/);
});

test('betBlock escapes names and never prints a long wallet whole', () => {
  const out = text(betBlock(bet({ creator_username: null, creator_wallet: 'a'.repeat(64) })));
  assert.match(out, /<b>aaaaaaaaa…aaaaaaa<\/b>/);
  const hostile = text(betBlock(bet({ creator_username: '<img src=x>' })));
  assert.doesNotMatch(hostile, /<img src=x>/);
  assert.match(hostile, /@&lt;img src=x&gt;/);
});
