// Binary scoring for Stated.
// Baseline matches the Metaculus rescale of the log score:
// 50% scores 0, a perfect binary call scores +100, and 80% on a Yes
// outcome scores about +68 (about −132 if it resolves No).
// Peer score is 100 times the gap between your log score and the mean
// of the other forecasters on that question. The sum of peer scores is 0.
// Time before the first probability scores as a coin flip (baseline 0).
// If the outcome is recorded before the scheduled close, the remaining
// time also scores as a coin flip, so an early resolution cannot be farmed.

export const P_MIN = 0.001;
export const P_MAX = 0.999;

const CHANCE_LOG = Math.log(0.5);

export function clampP(p) {
  if (!Number.isFinite(p)) throw new Error('Probability has to be a number.');
  return Math.min(P_MAX, Math.max(P_MIN, p));
}

export function logScore(pYes, outcome) {
  if (outcome !== 'yes' && outcome !== 'no') {
    throw new Error('A scored outcome is Yes or No.');
  }
  const p = clampP(pYes);
  return Math.log(outcome === 'yes' ? p : 1 - p);
}

export function baselineFromLog(log) {
  return 100 * (log - CHANCE_LOG) / (0 - CHANCE_LOG);
}

export function baselineScore(pYes, outcome) {
  return baselineFromLog(logScore(pYes, outcome));
}

export function brier(pYes, outcome) {
  const p = clampP(pYes);
  const y = outcome === 'yes' ? 1 : 0;
  return (p - y) ** 2;
}

// point(p) -> number. `before` covers time with no standing probability.
// Forecasts at or before open set the standing value at open.
// Forecasts at or after close do not count.
export function timeWeighted(forecasts, openMs, closeMs, point, before = 0) {
  if (!(closeMs > openMs)) throw new Error('Close has to be after open.');
  const span = closeMs - openMs;
  const sorted = [...forecasts]
    .filter((f) => f.at < closeMs)
    .sort((a, b) => a.at - b.at || String(a.id).localeCompare(String(b.id)));
  let acc = 0;
  let cursor = openMs;
  let active = null;
  for (const f of sorted) {
    if (f.at <= openMs) {
      active = point(f.p);
      continue;
    }
    const end = Math.min(f.at, closeMs);
    if (end > cursor) {
      acc += (active == null ? before : active) * (end - cursor);
      cursor = end;
    }
    active = point(f.p);
  }
  if (cursor < closeMs) {
    acc += (active == null ? before : active) * (closeMs - cursor);
  }
  return acc / span;
}

// freezeMs: outcome recorded early. From that instant to the scheduled
// close, the score is the coin-flip log, matching Metaculus.
export function timeWeightedLog(forecasts, openMs, closeMs, outcome, freezeMs = null) {
  if (!(closeMs > openMs)) throw new Error('Close has to be after open.');
  const activeEnd = freezeMs == null ? closeMs : Math.min(closeMs, Math.max(openMs, freezeMs));
  let acc = 0;
  if (activeEnd > openMs) {
    acc += timeWeighted(
      forecasts,
      openMs,
      activeEnd,
      (p) => logScore(p, outcome),
      CHANCE_LOG,
    ) * (activeEnd - openMs);
  }
  if (closeMs > activeEnd) acc += CHANCE_LOG * (closeMs - activeEnd);
  return acc / (closeMs - openMs);
}

export function timeWeightedBaseline(forecasts, openMs, closeMs, outcome, freezeMs = null) {
  return baselineFromLog(timeWeightedLog(forecasts, openMs, closeMs, outcome, freezeMs));
}

export function peerScores(logById) {
  const ids = Object.keys(logById);
  const result = {};
  if (ids.length < 2) {
    for (const id of ids) result[id] = 0;
    return result;
  }
  for (const id of ids) {
    let sum = 0;
    let n = 0;
    for (const other of ids) {
      if (other === id) continue;
      sum += logById[other];
      n += 1;
    }
    result[id] = 100 * (logById[id] - sum / n);
  }
  return result;
}

export function expectedBaseline(trueP, reportedP) {
  const p = clampP(trueP);
  const q = clampP(reportedP);
  return p * baselineScore(q, 'yes') + (1 - p) * baselineScore(q, 'no');
}
