// Docket rules for one forecasting league.
// A call stores the sentence, the deadline, and the resolution rule with
// the probability. Later edits to the question do not rewrite that snapshot.
// Ambiguous and Annulled record what happened and write no score.

import {
  baselineFromLog,
  brier,
  peerScores,
  timeWeightedLog,
} from './score.mjs';

export class RecordError extends Error {
  constructor(message, field) {
    super(message);
    this.name = 'RecordError';
    this.field = field || '';
  }
}

const HOUR = 60 * 60 * 1000;
export const CLOSING_WINDOW_MS = 48 * HOUR;

export function createEmpty(now = Date.now()) {
  return {
    seq: 1,
    youId: 'you',
    league: {
      id: 'december-desk',
      name: 'The December desk',
      topic: 'The path of the federal funds rate from the October 2026 hold through the last day of 2026.',
    },
    people: {
      you: { id: 'you', name: 'You', sample: false, joinedAt: now },
    },
    questions: {},
    forecasts: [],
    evidence: [],
    follows: [],
    acks: [],
  };
}

function takeId(state, prefix) {
  const seq = (state.seq || 1) + 1;
  return { seq, id: `${prefix}-${seq}` };
}

function num(value, field) {
  const n = typeof value === 'string' ? Date.parse(value) : value;
  if (!Number.isFinite(n)) throw new RecordError('Enter a real date and time.', field);
  return n;
}

function sentence(value, field, min, label) {
  const text = String(value || '').trim();
  if (text.length < min) {
    throw new RecordError(`Write ${label} in a full sentence.`, field);
  }
  return text;
}

export function probability(value) {
  const n = typeof value === 'string' ? Number(String(value).replace('%', '').trim()) : value;
  if (!Number.isFinite(n)) throw new RecordError('Enter a probability from 1% to 99%.', 'p');
  const asUnit = n > 1 ? n / 100 : n;
  if (asUnit < 0.01 || asUnit > 0.99) {
    throw new RecordError('Enter a probability from 1% to 99%.', 'p');
  }
  return Math.round(asUnit * 1000) / 1000;
}

export function addQuestion(state, input) {
  const claim = String(input.claim || '').trim();
  if (claim.length < 40) {
    throw new RecordError('Write the full sentence. It needs at least 40 characters.', 'claim');
  }
  if (!claim.endsWith('?')) {
    throw new RecordError('End the sentence with a question mark. The call has to be a question.', 'claim');
  }
  if (/[\r\n]/.test(claim)) {
    throw new RecordError('Keep the call to one sentence, on one line.', 'claim');
  }
  const yesRule = sentence(input.yesRule, 'yesRule', 20, 'what Yes means');
  const noRule = sentence(input.noRule, 'noRule', 20, 'what No means');
  const ambiguousRule = sentence(input.ambiguousRule, 'ambiguousRule', 20, 'when the call is ambiguous');
  const annulledRule = sentence(input.annulledRule, 'annulledRule', 20, 'when the call is annulled');
  const sourceName = String(input.sourceName || '').trim();
  if (sourceName.length < 2) throw new RecordError('Name the source that will decide this.', 'sourceName');
  const sourceUrl = String(input.sourceUrl || '').trim();
  if (sourceUrl && !/^https:\/\//.test(sourceUrl)) {
    throw new RecordError('The source link has to start with https://.', 'sourceUrl');
  }
  const openAt = num(input.openAt, 'openAt');
  const closeAt = num(input.closeAt, 'closeAt');
  const resolveBy = num(input.resolveBy, 'resolveBy');
  if (!(closeAt > openAt)) throw new RecordError('The close has to be after the open.', 'closeAt');
  if (!(resolveBy >= closeAt)) {
    throw new RecordError('The resolve-by time has to be at or after the close.', 'resolveBy');
  }
  const preset = input.id ? String(input.id) : null;
  const taken = preset ? null : takeId(state, 'q');
  const id = preset || taken.id;
  if (state.questions[id]) throw new RecordError('That call is already on the docket.', 'id');
  const question = {
    id,
    authorId: input.authorId || state.youId,
    claim,
    yesRule,
    noRule,
    ambiguousRule,
    annulledRule,
    sourceName,
    sourceUrl,
    openAt,
    closeAt,
    postRule: String(input.postRule || '').trim(),
    resolveBy,
    resolution: null,
  };
  return {
    ...state,
    seq: taken ? taken.seq : state.seq,
    questions: { ...state.questions, [id]: question },
  };
}

export function setName(state, personId, name) {
  const cleaned = String(name || '').trim().replace(/\s+/g, ' ');
  if (cleaned.length < 2) throw new RecordError('Use at least two characters in the name.', 'name');
  if (cleaned.length > 40) throw new RecordError('Keep the name under 40 characters.', 'name');
  const person = state.people[personId];
  if (!person) throw new RecordError('That person is not on the docket.', 'name');
  if (person.sample) throw new RecordError('Example names stay as they are.', 'name');
  return {
    ...state,
    people: { ...state.people, [personId]: { ...person, name: cleaned } },
  };
}

function mustQuestion(state, questionId) {
  const question = state.questions[questionId];
  if (!question) throw new RecordError('That call is not on the docket.', 'questionId');
  return question;
}

export function addForecast(state, input) {
  const question = mustQuestion(state, input.questionId);
  if (question.resolution) {
    throw new RecordError('This call is already recorded. The probability cannot move.', 'questionId');
  }
  const person = state.people[input.personId];
  if (!person) throw new RecordError('Name the person making this call.', 'personId');
  const at = input.at != null ? num(input.at, 'at') : Date.now();
  if (at < question.openAt) throw new RecordError('This call is not open yet.', 'at');
  if (at >= question.closeAt) {
    throw new RecordError('Updates have stopped. The probability standing at the close is the one that scores.', 'at');
  }
  const p = probability(input.p);
  const reasoning = String(input.reasoning || '').trim();
  if (reasoning.length < 40) {
    throw new RecordError('Write the reason for this number. A probability with no note cannot be followed.', 'reasoning');
  }
  if (reasoning.length > 1200) throw new RecordError('Keep the note under 1,200 characters.', 'reasoning');
  const preset = input.id ? String(input.id) : null;
  const taken = preset ? null : takeId(state, 'f');
  const forecast = {
    id: preset || taken.id,
    questionId: question.id,
    personId: person.id,
    p,
    reasoning,
    at,
    snapshot: {
      claim: question.claim,
      yesRule: question.yesRule,
      noRule: question.noRule,
      ambiguousRule: question.ambiguousRule,
      annulledRule: question.annulledRule,
      sourceName: question.sourceName,
      sourceUrl: question.sourceUrl,
      postRule: question.postRule || '',
      closeAt: question.closeAt,
      resolveBy: question.resolveBy,
    },
  };
  return {
    ...state,
    seq: taken ? taken.seq : state.seq,
    forecasts: [...state.forecasts, forecast].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)),
  };
}

export function addEvidence(state, input) {
  const question = mustQuestion(state, input.questionId);
  const note = sentence(input.note, 'note', 20, 'what the source said');
  const source = String(input.source || '').trim();
  if (source.length < 2) throw new RecordError('Name the source.', 'source');
  const url = String(input.url || '').trim();
  if (url && !/^https:\/\//.test(url)) {
    throw new RecordError('The source link has to start with https://.', 'url');
  }
  const at = input.at != null ? num(input.at, 'at') : Date.now();
  const preset = input.id ? String(input.id) : null;
  const taken = preset ? null : takeId(state, 'e');
  const evidence = {
    id: preset || taken.id,
    questionId: question.id,
    at,
    source,
    note,
    url,
  };
  return {
    ...state,
    seq: taken ? taken.seq : state.seq,
    evidence: [...state.evidence, evidence].sort((a, b) => a.at - b.at || a.id.localeCompare(b.id)),
  };
}

export function resolveQuestion(state, input) {
  const question = mustQuestion(state, input.questionId);
  if (question.resolution) throw new RecordError('This call already has an outcome.', 'outcome');
  const outcome = input.outcome;
  if (!['yes', 'no', 'ambiguous', 'annulled'].includes(outcome)) {
    throw new RecordError('Record Yes, No, Ambiguous, or Annulled.', 'outcome');
  }
  const note = sentence(input.note, 'note', 20, 'what happened');
  const sourceUrl = String(input.sourceUrl || '').trim();
  if (sourceUrl && !/^https:\/\//.test(sourceUrl)) {
    throw new RecordError('The source link has to start with https://.', 'sourceUrl');
  }
  const at = input.at != null ? num(input.at, 'at') : Date.now();
  if (at < question.openAt) {
    throw new RecordError('The outcome cannot be dated before the call opened.', 'at');
  }
  return {
    ...state,
    questions: {
      ...state.questions,
      [question.id]: {
        ...question,
        resolution: { outcome, note, sourceUrl, at },
      },
    },
  };
}

export function followNote(state, input) {
  const forecast = state.forecasts.find((f) => f.id === input.forecastId);
  if (!forecast) throw new RecordError('That note is not on the record.', 'forecastId');
  if (!state.people[input.followerId]) throw new RecordError('Name the person following.', 'followerId');
  if (forecast.personId === input.followerId) {
    throw new RecordError('Follow someone else’s note.', 'forecastId');
  }
  if (state.follows.some((f) => f.followerId === input.followerId && f.forecastId === forecast.id)) {
    return state;
  }
  const at = input.at != null ? num(input.at, 'at') : Date.now();
  const preset = input.id ? String(input.id) : null;
  const taken = preset ? null : takeId(state, 'w');
  const follow = {
    id: preset || taken.id,
    followerId: input.followerId,
    personId: forecast.personId,
    forecastId: forecast.id,
    questionId: forecast.questionId,
    at,
  };
  return {
    ...state,
    seq: taken ? taken.seq : state.seq,
    follows: [...state.follows, follow],
  };
}

export function acknowledge(state, personId, key) {
  if (!state.people[personId]) throw new RecordError('That person is not on the docket.', 'personId');
  if (state.acks.some((a) => a.personId === personId && a.key === key)) return state;
  return { ...state, acks: [...state.acks, { personId, key }] };
}

export function forecastsFor(state, questionId, personId = null) {
  return state.forecasts.filter((f) => f.questionId === questionId && (!personId || f.personId === personId));
}

export function participants(state, questionId) {
  return [...new Set(forecastsFor(state, questionId).map((f) => f.personId))];
}

export function scoredOutcome(question) {
  if (!question?.resolution) return null;
  const outcome = question.resolution.outcome;
  return outcome === 'yes' || outcome === 'no' ? outcome : null;
}

function standingAt(forecasts, at) {
  let standing = null;
  for (const f of forecasts) {
    if (f.at <= at && (!standing || f.at >= standing.at)) standing = f;
  }
  return standing;
}

export function personQuestionScore(state, questionId, personId) {
  const question = state.questions[questionId];
  const outcome = scoredOutcome(question);
  if (!outcome) return null;
  const forecasts = forecastsFor(state, questionId, personId);
  if (!forecasts.length) return null;
  const freeze = question.resolution.at;
  const log = timeWeightedLog(forecasts, question.openAt, question.closeAt, outcome, freeze);
  const standing = standingAt(forecasts, Math.min(question.closeAt, freeze));
  return {
    log,
    baseline: baselineFromLog(log),
    standingP: standing ? standing.p : null,
    brier: standing ? brier(standing.p, outcome) : null,
    outcome,
    peer: null,
  };
}

export function questionScores(state, questionId) {
  const question = state.questions[questionId];
  if (!scoredOutcome(question)) return null;
  const ids = participants(state, questionId);
  const rows = {};
  const logs = {};
  for (const id of ids) {
    rows[id] = personQuestionScore(state, questionId, id);
    logs[id] = rows[id].log;
  }
  const peer = peerScores(logs);
  for (const id of ids) rows[id].peer = peer[id];
  return rows;
}

export function latestMedian(state, questionId, now = Infinity) {
  const question = state.questions[questionId];
  if (!question) return null;
  const cutoff = Math.min(now, question.closeAt);
  const byPerson = new Map();
  for (const f of forecastsFor(state, questionId)) {
    if (f.at > cutoff) continue;
    const prev = byPerson.get(f.personId);
    if (!prev || f.at >= prev.at) byPerson.set(f.personId, f);
  }
  const ps = [...byPerson.values()].map((f) => f.p).sort((a, b) => a - b);
  if (!ps.length) return null;
  const mid = Math.floor(ps.length / 2);
  const median = ps.length % 2 ? ps[mid] : (ps[mid - 1] + ps[mid]) / 2;
  return { median, n: ps.length };
}

function isAck(state, personId, key) {
  return state.acks.some((a) => a.personId === personId && a.key === key);
}

export function remindersFor(state, personId, now = Date.now()) {
  if (!state.people[personId]) return [];
  const items = [];
  const questions = Object.values(state.questions);
  for (const q of questions) {
    const mine = forecastsFor(state, q.id, personId).filter((f) => f.at <= now);
    if (q.resolution) {
      if (!mine.length) continue;
      const receiptKey = `receipt:${q.id}`;
      if (!isAck(state, personId, receiptKey)) {
        items.push({ key: receiptKey, kind: 'receipt', questionId: q.id, at: q.resolution.at });
      }
      const score = personQuestionScore(state, q.id, personId);
      if (score && score.baseline < 0) {
        const later = questions
          .filter((other) => !other.resolution
            && other.openAt >= q.resolution.at
            && !forecastsFor(state, other.id, personId).some((f) => f.at <= now))
          .sort((a, b) => a.closeAt - b.closeAt);
        const stayKey = `stay:${q.id}`;
        if (later.length && !isAck(state, personId, stayKey)) {
          items.push({
            key: stayKey,
            kind: 'stay',
            questionId: later[0].id,
            aboutId: q.id,
            at: q.resolution.at,
          });
        }
      }
      continue;
    }
    if (!mine.length || now >= q.closeAt) continue;
    const last = Math.max(...mine.map((f) => f.at));
    for (const e of state.evidence) {
      if (e.questionId !== q.id || e.at <= last || e.at > now) continue;
      const key = `evidence:${e.id}`;
      if (!isAck(state, personId, key)) {
        items.push({ key, kind: 'evidence', questionId: q.id, evidenceId: e.id, at: e.at });
      }
    }
    const closingStart = q.closeAt - CLOSING_WINDOW_MS;
    if (now >= closingStart) {
      const key = `closing:${q.id}`;
      if (!isAck(state, personId, key)) {
        items.push({ key, kind: 'closing', questionId: q.id, at: closingStart });
      }
    }
  }
  return items.sort((a, b) => b.at - a.at || a.key.localeCompare(b.key));
}

export function leagueSignals(state) {
  const questions = Object.values(state.questions);
  const misses = [];
  for (const q of questions) {
    if (!scoredOutcome(q)) continue;
    for (const personId of participants(state, q.id)) {
      const score = personQuestionScore(state, q.id, personId);
      if (!score || !(score.baseline < 0)) continue;
      const stayed = questions.some((other) => other.id !== q.id
        && other.openAt >= q.resolution.at
        && forecastsFor(state, other.id, personId).length > 0);
      misses.push({ personId, questionId: q.id, baseline: score.baseline, stayed });
    }
  }
  return {
    misses,
    stayed: misses.filter((m) => m.stayed).length,
    missed: misses.length,
    followsOnNotes: state.follows.length,
  };
}

export function profileOf(state, personId) {
  const person = state.people[personId];
  if (!person) return null;
  const calls = [];
  for (const question of Object.values(state.questions)) {
    const forecasts = forecastsFor(state, question.id, personId);
    if (!forecasts.length) continue;
    const noteIds = new Set(forecasts.map((f) => f.id));
    calls.push({
      question,
      forecasts,
      score: personQuestionScore(state, question.id, personId),
      followed: state.follows.filter((f) => noteIds.has(f.forecastId)),
    });
  }
  calls.sort((a, b) => a.question.closeAt - b.question.closeAt);
  const scored = calls.filter((c) => c.score);
  const avg = scored.length
    ? scored.reduce((sum, c) => sum + c.score.baseline, 0) / scored.length
    : null;
  const buckets = [0, 1, 2, 3, 4].map((i) => ({
    from: i * 20,
    to: i === 4 ? 100 : (i + 1) * 20,
    n: 0,
    yes: 0,
  }));
  for (const c of scored) {
    if (c.score.standingP == null) continue;
    const i = Math.min(4, Math.floor((c.score.standingP * 100) / 20));
    buckets[i].n += 1;
    if (c.score.outcome === 'yes') buckets[i].yes += 1;
  }
  const signals = leagueSignals(state).misses.filter((m) => m.personId === personId);
  return {
    person,
    calls,
    avg,
    buckets,
    following: state.follows.filter((f) => f.followerId === personId),
    missed: signals.length,
    stayed: signals.filter((m) => m.stayed).length,
    scoredCount: scored.length,
  };
}

export function questionList(state) {
  return Object.values(state.questions).sort((a, b) => {
    const ar = a.resolution ? 1 : 0;
    const br = b.resolution ? 1 : 0;
    if (ar !== br) return ar - br;
    return a.closeAt - b.closeAt;
  });
}
