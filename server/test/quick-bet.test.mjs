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

test('returns null for unrecognized shapes and rejects invalid values', () => {
  assert.equal(parseQuickBet('Will Acme ship by Friday?'), null);
  assert.throws(() => parseQuickBet('Will Acme ship by midnight, 0 NEAR on yes', { now }), UserError);
  assert.throws(() => parseQuickBet('Will Acme ship by 13 Nov 2026, 0.25 NEAR on yes', { now, timeZone: 'UTC' }), UserError);
});
