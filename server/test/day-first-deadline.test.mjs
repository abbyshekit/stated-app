import test from 'node:test';
import assert from 'node:assert/strict';
import { deadlineOf, interpret } from '../src/interpret.mjs';
import { readTerms } from '../src/xtext.mjs';

const published = '2026-11-09T12:00:00Z';
const original = 'Stated integration test: this post will have fewer than 100 likes by 10 November 2026.';

test('a day-first deadline in the live prediction is read without changing the claim', () => {
  const terms = interpret(original, published);
  assert.equal(terms.claim, original);
  assert.equal(terms.deadlineText, 'by 10 November 2026');
  assert.equal(terms.proposedDeadlineAt?.toISOString(), '2026-11-10T23:59:59.000Z');
  assert.equal(terms.probability, null, 'the like count is not a probability');
});

test('private capture retains the parsed date while omitting the original words', () => {
  const terms = readTerms(original, published, { keepWords: false });
  assert.equal(terms.deadlineText, null);
  assert.equal(terms.proposedDeadlineAt?.toISOString(), '2026-11-10T23:59:59.000Z');
  assert.equal(terms.probability, null);
});

test('named day-first deadlines preserve their original form', () => {
  for (const phrase of ['by 10 Nov 2026', 'by 10 Nov. 2026', 'by 10th November 2026', 'until 10 November 2026', 'through 10 November 2026', 'no later than 10 November 2026', 'on 10 November 2026']) {
    const result = deadlineOf(`The launch will happen ${phrase}.`, published);
    assert.equal(result.text, phrase, phrase);
    assert.equal(result.at?.toISOString(), '2026-11-10T23:59:59.000Z', phrase);
  }
});

test('before a named day excludes that day, including across a year boundary', () => {
  assert.equal(deadlineOf('The launch will happen before 10 November 2026.', published).at?.toISOString(), '2026-11-09T23:59:59.000Z');
  assert.equal(deadlineOf('The launch will happen before 1 January 2027.', published).at?.toISOString(), '2026-12-31T23:59:59.000Z');
});

test('calendar dates are validated in both named-month orders', () => {
  for (const phrase of ['by 31 April 2027', 'by 29 February 2027', 'by 0 November 2026', 'by 32 November 2026', 'by April 31, 2027', 'by February 29, 2027']) {
    assert.deepEqual(deadlineOf(`The launch will happen ${phrase}.`, published), { text: null, at: null }, phrase);
  }
  for (const phrase of ['by 29 February 2028', 'by February 29, 2028']) {
    assert.equal(deadlineOf(`The launch will happen ${phrase}.`, published).at?.toISOString(), '2028-02-29T23:59:59.000Z');
  }
});

test('a yearless day-first date follows the existing month-first rollover', () => {
  assert.equal(deadlineOf('The launch will happen by 10 November.', published).at?.toISOString(), '2026-11-10T23:59:59.000Z');
  assert.equal(deadlineOf('The launch will happen by 10 November.', '2026-11-11T12:00:00Z').at?.toISOString(), '2027-11-10T23:59:59.000Z');
});

test('a named speech date does not become the forecast deadline', () => {
  const text = 'In an interview on 10 November 2026, she said sales will double.';
  assert.deepEqual(deadlineOf(text, published), { text: null, at: null });
  for (const phrase of ['by 10 November 2026', 'by November 10, 2026']) {
    assert.equal(deadlineOf(`She said sales will double ${phrase}.`, published).at?.toISOString(), '2026-11-10T23:59:59.000Z', phrase);
  }
});

test('existing month-first and month-wide deadlines retain their meaning', () => {
  assert.equal(deadlineOf('The launch will happen by November 10, 2026.', published).at?.toISOString(), '2026-11-10T23:59:59.000Z');
  assert.equal(deadlineOf('The launch will happen by November 2026.', published).at?.toISOString(), '2026-11-30T23:59:59.000Z');
});
