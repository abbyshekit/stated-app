import test from 'node:test';
import assert from 'node:assert/strict';
import { parseQuickBet } from '../src/quick-bet.mjs';
import { UserError } from '../src/store.mjs';

const now = new Date('2026-11-14T01:00:00.000Z'); // 20:00 in Toronto

test('parses an explicit proposal while preserving commas in its claim', () => {
  const result = parseQuickBet('Will the bill pass, with at least 20 votes, by midnight, 0.25 NEAR on yes', {
    now, timeZone: 'America/Toronto',
  });
  assert.equal(result.claim, 'Will the bill pass, with at least 20 votes, by midnight');
  assert.equal(result.creatorSide, 'yes');
  assert.equal(result.stakeNear, '0.25');
  assert.equal(result.resolveAt, '2026-11-14T05:00:00.000Z');
  assert.equal(result.acceptBy, '2026-11-14T04:50:00.000Z');
  assert.match(result.criteria, /reliable public evidence/);
});

test('accepts no side, explicit dates, and a trailing HTTPS context URL', () => {
  const result = parseQuickBet('Will Acme ship version 4 by 20 Nov 2026, 0.5 NEAR on no https://example.com/launch', { now });
  assert.equal(result.creatorSide, 'no');
  assert.equal(result.stakeNear, '0.5');
  assert.equal(result.evidenceSourceUrl, 'https://example.com/launch');
  assert.equal(result.resolveAt, '2026-11-20T23:59:59.000Z');
});

test('uses explicit US timezone abbreviations and validates supplied IANA zones', () => {
  const result = parseQuickBet('Will it happen by midnight EST, 0.25 NEAR on yes', { now, timeZone: 'America/Toronto' });
  assert.equal(result.resolveAt, '2026-11-14T05:00:00.000Z');
  assert.throws(() => parseQuickBet('Will it happen by midnight, 0.25 NEAR on yes', { now, timeZone: 'Mars/Olympus' }), UserError);
});

test('parses a labeled evidence source and midnight Eastern tonight in the original wager', () => {
  const claim = 'FAA lifts the nationwide ground stop by midnight Eastern tonight';
  const result = parseQuickBet(`${claim}, 0.25 NEAR on yes. Source: https://www.fly.faa.gov/adv/advADB.jsp`, { now });
  assert.equal(result.claim, claim);
  assert.equal(result.evidenceSourceUrl, 'https://www.fly.faa.gov/adv/advADB.jsp');
  assert.equal(result.creatorSide, 'yes');
  assert.equal(result.stakeNear, '0.25');
  assert.equal(result.resolveAt, '2026-11-14T05:00:00.000Z');
  assert.equal(parseQuickBet(`${claim}, 0.25 NEAR on yes.`, { now }).resolveAt, result.resolveAt);
});

test('Eastern midnight follows daylight saving time and keeps unrelated suffix prose unrecognized', () => {
  const result = parseQuickBet('FAA lifts restrictions by midnight Eastern Time tonight, 0.25 NEAR on yes', {
    now: new Date('2027-07-01T22:00:00Z'),
  });
  assert.equal(result.resolveAt, '2027-07-02T04:00:00.000Z');
  assert.equal(parseQuickBet('FAA lifts restrictions by midnight, 0.25 NEAR on yes. Maybe later. Source: https://example.com', { now }), null);
  assert.equal(parseQuickBet('FAA lifts restrictions by midnight, 0.25 NEAR on yes. Source: http://example.com', { now }), null);
});

test('explicit Eastern Time overrides the default zone with flexible whitespace', () => {
  for (const zone of ['Eastern  Time', 'Eastern\tTime', 'Eastern\nTime']) {
    const result = parseQuickBet(`FAA lifts restrictions by midnight ${zone} tonight, 0.25 NEAR on yes`, {
      now, timeZone: 'Asia/Tokyo',
    });
    assert.equal(result.resolveAt, '2026-11-14T05:00:00.000Z', zone);
  }
});

test('keeps a terminal question mark and refuses clock qualifiers it cannot parse', () => {
  const result = parseQuickBet('Will it happen by midnight?, 0.25 NEAR on yes', { now });
  assert.equal(result.claim, 'Will it happen by midnight?');
  assert.equal(result.resolveAt, '2026-11-15T00:00:00.000Z');
  for (const deadline of ['by 20 Nov 2026 at 12:00 EST', 'by tomorrow at noon', 'at 12:00 EST on 20 Nov 2026']) {
    assert.throws(() => parseQuickBet(`Will it happen ${deadline}, 0.25 NEAR on yes`, { now }), UserError);
  }
  const utc = parseQuickBet('Will it happen by 20 Nov 2026 at 12:00 UTC, 0.25 NEAR on yes', { now });
  assert.equal(utc.resolveAt, '2026-11-20T12:00:00.000Z');
});

test('returns null for unrecognized shapes and rejects invalid values', () => {
  assert.equal(parseQuickBet('Will Acme ship by Friday?'), null);
  assert.throws(() => parseQuickBet('Will Acme ship by midnight, 0 NEAR on yes', { now }), UserError);
  assert.throws(() => parseQuickBet('Will Acme ship by 13 Nov 2026, 0.25 NEAR on yes', { now, timeZone: 'UTC' }), UserError);
});
