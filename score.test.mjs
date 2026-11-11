import assert from 'node:assert/strict';
import test from 'node:test';
import {
  baselineScore,
  expectedBaseline,
  peerScores,
  timeWeightedBaseline,
} from './score.mjs';

test('80% scores about +68 if Yes and about −132 if No', () => {
  assert.equal(Math.round(baselineScore(0.8, 'yes')), 68);
  assert.equal(Math.round(baselineScore(0.8, 'no')), -132);
  assert.equal(Math.round(baselineScore(0.9, 'yes')), 85);
  assert.equal(Math.round(baselineScore(0.9, 'no')), -232);
});

test('a coin flip scores zero and a perfect call scores +100', () => {
  assert.equal(baselineScore(0.5, 'yes'), 0);
  assert.equal(baselineScore(0.5, 'no'), 0);
  assert.ok(baselineScore(0.999, 'yes') > 99);
  assert.ok(baselineScore(0.999, 'no') < -800);
});

test('time before the first call scores as zero, then the standing call carries', () => {
  const day = 1000;
  const forecasts = [
    { at: 1 * day, p: 0.4 },
    { at: 2 * day, p: 0.7 },
    { at: 4 * day, p: 0.8 },
  ];
  const score = timeWeightedBaseline(forecasts, 0, 5 * day, 'yes');
  const expected = (
    baselineScore(0.5, 'yes')
    + baselineScore(0.4, 'yes')
    + baselineScore(0.7, 'yes')
    + baselineScore(0.7, 'yes')
    + baselineScore(0.8, 'yes')
  ) / 5;
  assert.ok(Math.abs(score - expected) < 1e-9);
  assert.equal(Math.round(score), 27);
});

test('an outcome recorded early scores the tail as a coin flip', () => {
  const day = 1000;
  const forecasts = [{ at: 0, p: 0.8 }];
  const score = timeWeightedBaseline(forecasts, 0, 5 * day, 'yes', 3 * day);
  const expected = (3 * baselineScore(0.8, 'yes') + 2 * 0) / 5;
  assert.ok(Math.abs(score - expected) < 1e-9);
});

test('peer scores on a question sum to zero', () => {
  const peer = peerScores({ a: -0.2, b: -0.5, c: -1.2 });
  const sum = peer.a + peer.b + peer.c;
  assert.ok(Math.abs(sum) < 1e-9);
  assert.ok(peer.a > peer.b && peer.b > peer.c);
});

test('the log score is proper: expected baseline peaks at the true probability', () => {
  const truth = 0.37;
  const honest = expectedBaseline(truth, truth);
  for (let reported = 0.02; reported <= 0.98; reported += 0.01) {
    const other = expectedBaseline(truth, reported);
    assert.ok(other <= honest + 1e-9, `reporting ${reported} beat the truth`);
  }
});
