import assert from 'node:assert/strict';
import test from 'node:test';
import { ARMS, buildWorld, runArm, study } from './sim.mjs';

const SMALL = { agents: 60, questions: 10, seedList: [11, 22, 33, 44, 55, 66, 77, 88] };

test('skill shows up in the baseline, otherwise the world is noise', () => {
  const world = buildWorld(11, SMALL);
  let sx = 0;
  let sy = 0;
  const xs = [];
  const ys = [];
  for (const agent of world.agents) {
    let sum = 0;
    for (const round of world.rounds) sum += round.forecasts[agent.id].baseline;
    xs.push(agent.skill);
    ys.push(sum / world.rounds.length);
  }
  const n = xs.length;
  for (let i = 0; i < n; i += 1) {
    sx += xs[i];
    sy += ys[i];
  }
  const mx = sx / n;
  const my = sy / n;
  let num = 0;
  let dx = 0;
  let dy = 0;
  for (let i = 0; i < n; i += 1) {
    num += (xs[i] - mx) * (ys[i] - my);
    dx += (xs[i] - mx) ** 2;
    dy += (ys[i] - my) ** 2;
  }
  const corr = num / Math.sqrt(dx * dy);
  assert.ok(corr > 0.45, `skill/baseline correlation was ${corr}`);
});

test('the card spreads, and it does not by itself change who stays after a miss', () => {
  for (const seed of SMALL.seedList) {
    const world = buildWorld(seed, SMALL);
    const board = runArm(world, ARMS.board, seed);
    const card = runArm(world, ARMS.card, seed);
    assert.equal(card.stayAfterMiss, board.stayAfterMiss, `seed ${seed}`);
    assert.ok(card.shares > board.shares, `seed ${seed} shares ${card.shares} vs ${board.shares}`);
  }
});

test('the reminder after a miss raises stay-after-miss on every seed', () => {
  let gap = 0;
  for (const seed of SMALL.seedList) {
    const world = buildWorld(seed, SMALL);
    const board = runArm(world, ARMS.board, seed);
    const remind = runArm(world, ARMS.remind, seed);
    assert.ok(remind.stayAfterMiss >= board.stayAfterMiss, `seed ${seed}`);
    gap += remind.stayAfterMiss - board.stayAfterMiss;
  }
  assert.ok(gap / SMALL.seedList.length > 0.03, `mean stay gap was ${gap / SMALL.seedList.length}`);
});

test('following the note tracks the writing, and the leaderboard tracks the visible score', () => {
  const result = study({ ...SMALL, arms: { board: ARMS.board, record: ARMS.record } });
  const writingGap = result.arms.record.writingCorr.mean - result.arms.board.writingCorr.mean;
  const scoreGap = result.arms.board.scoreCorr.mean - result.arms.record.scoreCorr.mean;
  assert.ok(writingGap > 0.4, `writing gap ${writingGap}`);
  assert.ok(scoreGap > 0.12, `visible-score gap ${scoreGap}`);
  assert.ok(result.arms.record.stayAfterMiss.mean > result.arms.board.stayAfterMiss.mean);
  assert.ok(result.arms.board.skillCorr.mean < 0.2, 'a short leaderboard is not latent skill');
});
