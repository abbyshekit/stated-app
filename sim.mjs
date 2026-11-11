// A simulation of the first signal, not a measurement of real people.
//
// One world of questions and probabilities is shared by every arm, so the
// only thing that changes is the social rule. Writing quality is drawn
// independently of skill: a wrong call can still be worth reading.
//
// board   — no card before the outcome, follows track skill, a miss only hurts
// card    — the sealed call is shared before the outcome; retention is unchanged
// remind  — after a miss, a prompt to make the next call cuts the quit hazard
// record  — the prompt, plus follows attach to the note, plus being read
//           adds status instead of taking it from everyone else
//
// Quit draws are keyed by person and question, not by arm. When status and
// the reminder are the same, stay-after-miss is the same.

import { baselineScore } from './score.mjs';

export const MODEL = {
  agents: 100,
  questions: 16,
  seeds: 30,
  readWeight: 0.5,
  reminderCatch: 0.4,
  noteSharpness: 4,
  quitScale: 0.85,
  conversion: 0.3,
  bragShare: 0.22,
  quietShare: 0.03,
  cardBase: 0.05,
  cardExtreme: 0.14,
  receiptShare: 0.09,
};

export const ARMS = {
  board: { shareMode: 'board', followMode: 'accuracy', readWeight: 0, reminderCatch: 0 },
  card: { shareMode: 'card', followMode: 'accuracy', readWeight: 0, reminderCatch: 0 },
  remind: { shareMode: 'card', followMode: 'accuracy', readWeight: 0, reminderCatch: MODEL.reminderCatch },
  record: {
    shareMode: 'card',
    followMode: 'writing',
    readWeight: MODEL.readWeight,
    reminderCatch: MODEL.reminderCatch,
  },
};

function mix(seed, parts) {
  let h = (2166136261 ^ (seed >>> 0)) >>> 0;
  const s = parts.join('\0');
  for (let i = 0; i < s.length; i += 1) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return mulberry32(h);
}

function unit(seed, ...parts) {
  return mix(seed, parts)();
}

export function mulberry32(seed) {
  let a = seed >>> 0;
  return function rand() {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function clamp01(n) {
  return Math.min(1, Math.max(0, n));
}

function pearson(xs, ys) {
  const n = xs.length;
  if (n < 3) return 0;
  let sx = 0;
  let sy = 0;
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
    const a = xs[i] - mx;
    const b = ys[i] - my;
    num += a * b;
    dx += a * a;
    dy += b * b;
  }
  if (dx === 0 || dy === 0) return 0;
  return num / Math.sqrt(dx * dy);
}

function normalDraw(seed, ...parts) {
  const u = Math.max(unit(seed, ...parts, 'u'), 1e-12);
  const v = unit(seed, ...parts, 'v');
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

export function buildWorld(seed, options = {}) {
  const agentsN = options.agents ?? MODEL.agents;
  const questionsN = options.questions ?? MODEL.questions;
  const agents = [];
  for (let i = 0; i < agentsN; i += 1) {
    agents.push({
      id: `a${i}`,
      original: true,
      skill: unit(seed, 'skill', i),
      writing: unit(seed, 'writing', i),
      ego: unit(seed, 'ego', i),
    });
  }
  const rounds = [];
  for (let q = 0; q < questionsN; q += 1) {
    const trueP = 0.15 + 0.7 * unit(seed, 'trueP', q);
    const outcome = unit(seed, 'outcome', q) < trueP ? 'yes' : 'no';
    const forecasts = {};
    for (const agent of agents) {
      const z = normalDraw(seed, 'noise', agent.id, q);
      const sd = 0.12 + 0.38 * (1 - agent.skill);
      const p = Math.min(0.98, Math.max(0.02, trueP + z * sd));
      const note = clamp01(0.85 * agent.writing + 0.15 * unit(seed, 'note', agent.id, q));
      forecasts[agent.id] = {
        p,
        note,
        baseline: baselineScore(p, outcome),
      };
    }
    rounds.push({ trueP, outcome, forecasts });
  }
  return { seed, agents, rounds };
}

function shareProbability(config, forecast) {
  const extremity = Math.abs(forecast.p - 0.5) * 2;
  if (config.shareMode === 'board') {
    return {
      before: 0,
      after: forecast.baseline > 20 ? MODEL.bragShare : MODEL.quietShare,
    };
  }
  return {
    before: MODEL.cardBase + MODEL.cardExtreme * extremity,
    after: MODEL.receiptShare + (Math.abs(forecast.baseline) > 40 ? 0.08 : 0),
  };
}

function pickWeighted(rng, items, weightOf) {
  let total = 0;
  const weights = items.map((item) => {
    const w = Math.max(1e-6, weightOf(item));
    total += w;
    return w;
  });
  let r = rng() * total;
  for (let i = 0; i < items.length; i += 1) {
    r -= weights[i];
    if (r <= 0) return items[i];
  }
  return items[items.length - 1];
}

export function runArm(world, config, seed = world.seed) {
  const agents = new Map(world.agents.map((agent) => [agent.id, {
    ...agent,
    active: true,
    accuracy: 0.5,
    followsIn: 0,
    forecastsMade: 0,
    baselineSum: 0,
  }]));
  let shares = 0;
  let arrivals = 0;
  let agentRounds = 0;
  let stayOpportunities = 0;
  let stays = 0;
  let misses = 0;

  world.rounds.forEach((round, q) => {
    const active = [...agents.values()].filter((agent) => agent.active && round.forecasts[agent.id]);
    agentRounds += active.length;
    const scored = active.map((agent) => ({ agent, forecast: round.forecasts[agent.id] }));

    for (const { agent, forecast } of scored) {
      const shareP = shareProbability(config, forecast);
      if (unit(seed, 'share', config.shareMode, agent.id, q, 'before') < shareP.before) shares += 1;
      if (unit(seed, 'share', config.shareMode, agent.id, q, 'after') < shareP.after) shares += 1;
    }

    const followsThisRound = new Map();
    for (const { agent, forecast } of scored) {
      const others = scored.filter((row) => row.agent.id !== agent.id);
      if (!others.length) continue;
      const draws = config.followMode === 'writing' && forecast.baseline < 0 ? 2 : 1;
      const rng = mix(seed, ['follow', config.followMode, agent.id, String(q)]);
      const field = others.map((row) => (
        config.followMode === 'writing'
          ? row.forecast.note
          : (row.agent.forecastsMade ? row.agent.baselineSum / row.agent.forecastsMade : 0)
      ));
      const sortedField = [...field].sort((a, b) => a - b);
      const pctOf = (value) => {
        if (sortedField.length <= 1) return 0.5;
        let lo = 0;
        let hi = sortedField.length;
        while (lo < hi) {
          const mid = (lo + hi) >> 1;
          if (sortedField[mid] < value) lo = mid + 1;
          else hi = mid;
        }
        return lo / (sortedField.length - 1);
      };
      const chosen = new Set();
      for (let d = 0; d < draws && chosen.size < others.length; d += 1) {
        const pool = others.filter((row) => !chosen.has(row.agent.id));
        const picked = pickWeighted(rng, pool, (row) => {
          if (config.followMode === 'accuracy' && row.agent.forecastsMade === 0) return 1;
          const value = config.followMode === 'writing'
            ? row.forecast.note
            : row.agent.baselineSum / row.agent.forecastsMade;
          return Math.exp(MODEL.noteSharpness * pctOf(value));
        });
        chosen.add(picked.agent.id);
        followsThisRound.set(picked.agent.id, (followsThisRound.get(picked.agent.id) || 0) + 1);
      }
    }
    let maxFollows = 0;
    for (const n of followsThisRound.values()) maxFollows = Math.max(maxFollows, n);

    for (const { agent, forecast } of scored) {
      agent.forecastsMade += 1;
      agent.baselineSum += forecast.baseline;
      const signal = clamp01(0.5 + forecast.baseline / 200);
      agent.accuracy = 0.7 * agent.accuracy + 0.3 * signal;
      const got = followsThisRound.get(agent.id) || 0;
      agent.followsIn += got;
      const followShare = maxFollows > 0 ? got / maxFollows : 0;
      const status = clamp01(agent.accuracy + config.readWeight * followShare);
      let pQuit;
      if (forecast.baseline < 0) {
        misses += 1;
        const severity = clamp01(-forecast.baseline / 100);
        pQuit = agent.ego * severity * (0.2 + 0.8 * (1 - status)) * MODEL.quitScale;
        pQuit *= 1 - config.reminderCatch;
      } else {
        pQuit = 0.01 * agent.ego;
      }
      const draw = unit(seed, 'quit', agent.id, q);
      const quitting = draw < pQuit;
      const hasNext = q < world.rounds.length - 1 && round.forecasts[agent.id];
      if (forecast.baseline < 0 && hasNext && agent.original) {
        stayOpportunities += 1;
        if (!quitting) stays += 1;
      }
      if (quitting) agent.active = false;
    }
  });

  // One conversion draw per share event. Arrivals are reported and do not
  // re-enter the world, so stay-after-miss stays a property of the original
  // cohort and the social rule alone.
  let converted = 0;
  for (let i = 0; i < shares; i += 1) {
    if (unit(seed, 'convert', config.shareMode, i) < MODEL.conversion) converted += 1;
  }
  arrivals = converted;

  const finished = [...agents.values()].filter((agent) => agent.forecastsMade > 0);
  const followRate = (agent) => agent.followsIn / agent.forecastsMade;
  return {
    stayAfterMiss: stayOpportunities ? stays / stayOpportunities : 0,
    stayOpportunities,
    stays,
    misses,
    writingCorr: pearson(finished.map((a) => a.writing), finished.map(followRate)),
    skillCorr: pearson(finished.map((a) => a.skill), finished.map(followRate)),
    scoreCorr: pearson(
      finished.map((a) => a.baselineSum / a.forecastsMade),
      finished.map(followRate),
    ),
    shares,
    arrivals,
    agentRounds,
    sharesPerAgentRound: agentRounds ? shares / agentRounds : 0,
    arrivalsPerAgentRound: agentRounds ? arrivals / agentRounds : 0,
    activeOriginals: [...agents.values()].filter((a) => a.original && a.active).length,
  };
}

function skillBaselineCorr(world) {
  const xs = [];
  const ys = [];
  for (const agent of world.agents) {
    let sum = 0;
    for (const round of world.rounds) sum += round.forecasts[agent.id].baseline;
    xs.push(agent.skill);
    ys.push(sum / world.rounds.length);
  }
  return pearson(xs, ys);
}

function meanOf(rows, key) {
  const xs = rows.map((row) => row[key]);
  const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
  let variance = 0;
  for (const x of xs) variance += (x - mean) ** 2;
  variance /= xs.length;
  return {
    mean,
    min: Math.min(...xs),
    max: Math.max(...xs),
    sd: Math.sqrt(variance),
  };
}

const METRIC_KEYS = [
  'stayAfterMiss',
  'writingCorr',
  'skillCorr',
  'scoreCorr',
  'sharesPerAgentRound',
  'arrivalsPerAgentRound',
  'activeOriginals',
];

export function study(options = {}) {
  const seeds = options.seedList ?? Array.from({ length: options.seeds ?? MODEL.seeds }, (_, i) => (options.seed0 ?? 1000) + i);
  const armNames = options.arms ?? ARMS;
  const buckets = Object.fromEntries(Object.keys(armNames).map((name) => [name, []]));
  const skillCorrs = [];
  for (const seed of seeds) {
    const world = buildWorld(seed, options);
    skillCorrs.push(skillBaselineCorr(world));
    for (const [name, config] of Object.entries(armNames)) {
      buckets[name].push(runArm(world, config, seed));
    }
  }
  const arms = {};
  for (const [name, rows] of Object.entries(buckets)) {
    arms[name] = {};
    for (const key of METRIC_KEYS) arms[name][key] = meanOf(rows, key);
    arms[name].stayOpportunities = rows.reduce((sum, row) => sum + row.stayOpportunities, 0);
  }
  return {
    seeds: seeds.length,
    agents: options.agents ?? MODEL.agents,
    questions: options.questions ?? MODEL.questions,
    skillBaselineCorr: meanOf(skillCorrs.map((mean) => ({ mean })), 'mean'),
    arms,
  };
}

export function sweepReminder(options = {}) {
  const values = options.values ?? [0, 0.2, 0.4, 0.6];
  return values.map((reminderCatch) => {
    const result = study({
      ...options,
      arms: {
        board: ARMS.board,
        remind: { ...ARMS.card, reminderCatch },
      },
    });
    return {
      reminderCatch,
      board: result.arms.board.stayAfterMiss.mean,
      remind: result.arms.remind.stayAfterMiss.mean,
    };
  });
}

export function sweepReadWeight(options = {}) {
  const values = options.values ?? [0, 0.25, 0.5, 0.75];
  return values.map((readWeight) => {
    const result = study({
      ...options,
      arms: {
        writing: {
          shareMode: 'card',
          followMode: 'writing',
          readWeight,
          reminderCatch: 0,
        },
      },
    });
    return {
      readWeight,
      stayAfterMiss: result.arms.writing.stayAfterMiss.mean,
      writingCorr: result.arms.writing.writingCorr.mean,
    };
  });
}

function round4(n) {
  return Math.round(n * 10000) / 10000;
}

function packArm(arm) {
  const out = {};
  for (const key of METRIC_KEYS) {
    out[key] = {
      mean: round4(arm[key].mean),
      min: round4(arm[key].min),
      max: round4(arm[key].max),
      sd: round4(arm[key].sd),
    };
  }
  out.stayOpportunities = arm.stayOpportunities;
  return out;
}

export function report(options = {}) {
  const result = study(options);
  const reminder = sweepReminder(options);
  const readWeight = sweepReadWeight(options);
  const arms = {};
  for (const [name, arm] of Object.entries(result.arms)) arms[name] = packArm(arm);
  return {
    generatedAt: new Date().toISOString(),
    model: MODEL,
    assumptions: [
      'Writing quality is drawn independently of forecasting skill.',
      'Quit chance after a miss rises with ego and with how far the call was on the wrong side, and falls as status rises.',
      'Being read adds status. It does not lower the status of people who were not read.',
      'The reminder multiplies the quit hazard by (1 − reminderCatch). reminderCatch is an assumption, not a measured rate.',
      'The sealed card is shared before the outcome. The leaderboard arm shares almost only after a clear hit.',
      'Each share converts to a new participant with probability 0.3. That rate is an assumption.',
      'Follows attach to a rank. The record arm ranks the note. The other arms rank the public average baseline. Both use the same sharpness, 4, on that percentile.',
      'Stay-after-miss counts original participants who had a negative baseline and still forecast the next question.',
    ],
    seeds: result.seeds,
    agents: result.agents,
    questions: result.questions,
    skillBaselineCorr: round4(result.skillBaselineCorr.mean),
    arms,
    sweepReminder: reminder.map((row) => ({
      reminderCatch: row.reminderCatch,
      board: round4(row.board),
      remind: round4(row.remind),
    })),
    sweepReadWeight: readWeight.map((row) => ({
      readWeight: row.readWeight,
      stayAfterMiss: round4(row.stayAfterMiss),
      writingCorr: round4(row.writingCorr),
    })),
  };
}

import { argv } from 'node:process';
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

if (argv[1] && argv[1].endsWith('sim.mjs')) {
  const out = report();
  const file = join(dirname(fileURLToPath(import.meta.url)), 'sim-results.json');
  writeFileSync(file, `${JSON.stringify(out, null, 2)}\n`);
  process.stdout.write(`${file}\n`);
  process.stdout.write(`${JSON.stringify({
    skillBaselineCorr: out.skillBaselineCorr,
    stay: Object.fromEntries(Object.entries(out.arms).map(([name, arm]) => [name, arm.stayAfterMiss.mean])),
    writing: Object.fromEntries(Object.entries(out.arms).map(([name, arm]) => [name, arm.writingCorr.mean])),
    skill: Object.fromEntries(Object.entries(out.arms).map(([name, arm]) => [name, arm.skillCorr.mean])),
    score: Object.fromEntries(Object.entries(out.arms).map(([name, arm]) => [name, arm.scoreCorr.mean])),
    shares: Object.fromEntries(Object.entries(out.arms).map(([name, arm]) => [name, arm.sharesPerAgentRound.mean])),
    sweepReminder: out.sweepReminder,
    sweepReadWeight: out.sweepReadWeight,
  }, null, 2)}\n`);
}
