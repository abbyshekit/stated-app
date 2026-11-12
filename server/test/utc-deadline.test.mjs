// INTEGRATION: explicit UTC deadlines pass through the same parser used by private capture.
import test from 'node:test';
import assert from 'node:assert/strict';
import { deadlineOf, interpret } from '../src/interpret.mjs';
import { readTerms } from '../src/xtext.mjs';

const published = '2026-11-11T18:18:00Z';
const claim = 'NEAR/USD will be above US$4 at 18:40 UTC on 11 November 2026.';

test('explicit UTC time survives interpretation and private capture', () => {
  const terms = readTerms(claim, published, { keepWords: true });
  assert.equal(terms.proposedDeadlineAt?.toISOString(), '2026-11-11T18:40:00.000Z');
  assert.equal(terms.deadlineText, 'at 18:40 UTC on 11 November 2026');
  assert.equal(terms.probability, null);
  const privateTerms = readTerms(claim, published, { keepWords: false });
  assert.equal(privateTerms.deadlineText, null);
  assert.equal(privateTerms.proposedDeadlineAt?.toISOString(), '2026-11-11T18:40:00.000Z');
});

test('date-first UTC deadlines retain their clock and words', () => {
  for (const prep of ['on', 'by']) {
    const phrase = `${prep} 11 November 2026 at 18:40 UTC`;
    const result = deadlineOf(`The price will rise ${phrase}.`, published);
    assert.equal(result.text, phrase);
    assert.equal(result.at?.toISOString(), '2026-11-11T18:40:00.000Z');
  }
});

test('invalid explicit clocks and calendar dates do not become date-only deadlines', () => {
  for (const phrase of ['at 24:00 UTC on 11 November 2026', 'at 18:60 UTC on 11 November 2026',
    'at 18:40 UTC on 31 April 2027', 'by 29 February 2027 at 18:40 UTC',
    'on 11 November 2026 at 24:00 UTC', 'by 11 November 2026 at 18:60 UTC']) {
    assert.deepEqual(deadlineOf(`The price will rise ${phrase}.`, published), { text: null, at: null }, phrase);
  }
});

test('UTC offsets do not become UTC or date-only deadlines', () => {
  for (const offset of ['+2', '-05:00', '+0200', '-0500']) {
    for (const phrase of [`at 18:40 UTC${offset} on 11 November 2026`,
      `on 11 November 2026 at 18:40 UTC${offset}`, `by 11 November 2026 at 18:40 UTC${offset}`]) {
      assert.deepEqual(deadlineOf(`The price will rise ${phrase}.`, published), { text: null, at: null }, phrase);
    }
  }
});

test('speech dates stay separate from forecasts, and past rules remain unchanged', () => {
  assert.deepEqual(deadlineOf('In an interview at 18:40 UTC on 11 November 2026, she said sales will double.', published), { text: null, at: null });
  assert.deepEqual(deadlineOf('The price will rise on 11 November 2026 at 18:00 UTC.', published), { text: null, at: null });
  assert.equal(deadlineOf('She said the price would rise by 11 November 2026 at 18:00 UTC.', published).at?.toISOString(), '2026-11-11T18:00:00.000Z');
});

test('a clock written before its date is the deadline, so an offer cannot outlive the claim', () => {
  for (const [phrase, iso] of [
    ['before 18:40 UTC on 11 November 2026', '2026-11-11T18:40:00.000Z'],
    ['by 18:40 UTC on 11 November 2026', '2026-11-11T18:40:00.000Z'],
    ['before 11 November 2026 at 18:40 UTC', '2026-11-11T18:40:00.000Z'],
  ]) {
    const result = deadlineOf(`Nvidia will announce a stock split ${phrase}.`, published);
    assert.equal(result.text, phrase);
    assert.equal(result.at?.toISOString(), iso, phrase);
  }
  for (const phrase of ['before 24:00 UTC on 11 November 2026', 'by 18:60 UTC on 11 November 2026', 'before 18:40 UTC+2 on 11 November 2026']) {
    assert.deepEqual(deadlineOf(`The price will rise ${phrase}.`, published), { text: null, at: null }, phrase);
  }
});

test('date-only deadlines retain end of day', () => {
  assert.equal(interpret('The price will rise by 11 November 2026.', published).proposedDeadlineAt?.toISOString(), '2026-11-11T23:59:59.000Z');
});
