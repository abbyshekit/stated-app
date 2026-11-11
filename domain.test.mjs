import assert from 'node:assert/strict';
import test from 'node:test';
import {
  acknowledge,
  addEvidence,
  addForecast,
  addQuestion,
  createEmpty,
  followNote,
  latestMedian,
  leagueSignals,
  personQuestionScore,
  profileOf,
  questionScores,
  remindersFor,
  resolveQuestion,
} from './domain.mjs';
import { seedState } from './seed.mjs';

const NOW = Date.parse('2026-11-06T03:20:00Z');

function openQuestion(state, id = 'q-test') {
  return addQuestion(state, {
    id,
    claim: 'Will the clerk record a Yes on this worked example before it closes?',
    yesRule: 'Yes if the clerk records the outcome as Yes under this exact sentence.',
    noRule: 'No if the clerk records the outcome as No under this exact sentence.',
    ambiguousRule: 'Ambiguous if the clerk cannot tell which sentence was meant.',
    annulledRule: 'Annulled if the example is withdrawn before a source exists.',
    sourceName: 'The clerk of this example',
    openAt: NOW - 5 * 86400000,
    closeAt: NOW + 5 * 86400000,
    resolveBy: NOW + 6 * 86400000,
  });
}

test('a forecast keeps the sentence even if the question text later changes', () => {
  let state = openQuestion(createEmpty(NOW));
  state = addForecast(state, {
    questionId: 'q-test',
    personId: 'you',
    p: 0.64,
    at: NOW,
    reasoning: 'The worked example is enough to pin the snapshot, and this note is long enough to follow.',
  });
  state.questions['q-test'].claim = 'A different question that should not rewrite history?';
  assert.equal(
    state.forecasts[0].snapshot.claim,
    'Will the clerk record a Yes on this worked example before it closes?',
  );
});

test('updates stop at the close, and a recorded call cannot take a new probability', () => {
  let state = openQuestion(createEmpty(NOW));
  assert.throws(() => addForecast(state, {
    questionId: 'q-test',
    personId: 'you',
    p: 0.4,
    at: state.questions['q-test'].closeAt,
    reasoning: 'This note is long enough, but the close has already passed for this call.',
  }), /Updates have stopped/);
  state = addForecast(state, {
    questionId: 'q-test',
    personId: 'you',
    p: 0.4,
    at: NOW,
    reasoning: 'A standing probability with a note that someone else could actually follow later.',
  });
  state = resolveQuestion(state, {
    questionId: 'q-test',
    outcome: 'no',
    at: NOW + 1000,
    note: 'The clerk recorded No against the sentence that was on the record.',
  });
  assert.throws(() => addForecast(state, {
    questionId: 'q-test',
    personId: 'you',
    p: 0.2,
    at: NOW + 500,
    reasoning: 'Trying to move the probability after the outcome is already on the record.',
  }), /already recorded/);
});

test('ambiguous and annulled record the outcome and write no score', () => {
  let state = openQuestion(createEmpty(NOW));
  state = addForecast(state, {
    questionId: 'q-test',
    personId: 'you',
    p: 0.7,
    at: NOW,
    reasoning: 'A note that will not be scored, because the call is going to be marked ambiguous.',
  });
  state = resolveQuestion(state, {
    questionId: 'q-test',
    outcome: 'ambiguous',
    at: NOW + 1000,
    note: 'The source never distinguished the two readings of the sentence.',
  });
  assert.equal(personQuestionScore(state, 'q-test', 'you'), null);
  assert.equal(questionScores(state, 'q-test'), null);
});

test('a source note after your call becomes a reminder, and a new probability clears it', () => {
  let state = openQuestion(createEmpty(NOW));
  state = addForecast(state, {
    questionId: 'q-test',
    personId: 'you',
    p: 0.5,
    at: NOW - 86400000,
    reasoning: 'Even odds until a source note arrives. This is the note I am willing to have followed.',
  });
  state = addEvidence(state, {
    questionId: 'q-test',
    at: NOW - 3600000,
    source: 'Example desk',
    note: 'A later source note arrived, and the standing probability is now stale.',
  });
  const reminders = remindersFor(state, 'you', NOW);
  assert.equal(reminders.some((item) => item.kind === 'evidence'), true);
  state = addForecast(state, {
    questionId: 'q-test',
    personId: 'you',
    p: 0.63,
    at: NOW - 1000,
    reasoning: 'The source note moved me off even odds. I am updating rather than leaving the old number up.',
  });
  assert.equal(remindersFor(state, 'you', NOW).some((item) => item.kind === 'evidence'), false);
});

test('keeping the current probability acknowledges the source note without a new line', () => {
  let state = openQuestion(createEmpty(NOW));
  state = addForecast(state, {
    questionId: 'q-test',
    personId: 'you',
    p: 0.5,
    at: NOW - 86400000,
    reasoning: 'Even odds until a source note arrives. This is the note I am willing to have followed.',
  });
  state = addEvidence(state, {
    id: 'e1',
    questionId: 'q-test',
    at: NOW - 3600000,
    source: 'Example desk',
    note: 'A later source note arrived, and the standing probability is now stale.',
  });
  const before = state.forecasts.length;
  state = acknowledge(state, 'you', 'evidence:e1');
  assert.equal(state.forecasts.length, before);
  assert.equal(remindersFor(state, 'you', NOW).some((item) => item.kind === 'evidence'), false);
});

test('a negative score reminds you that a later call is still open', () => {
  let state = openQuestion(createEmpty(NOW), 'first');
  state = addQuestion(state, {
    id: 'second',
    claim: 'Will the second worked example resolve Yes after the first one is recorded?',
    yesRule: 'Yes if the clerk records Yes on the second sentence.',
    noRule: 'No if the clerk records No on the second sentence.',
    ambiguousRule: 'Ambiguous if the second sentence cannot be read cleanly.',
    annulledRule: 'Annulled if the second example is withdrawn before a source exists.',
    sourceName: 'The clerk of this example',
    openAt: NOW + 2000,
    closeAt: NOW + 10 * 86400000,
    resolveBy: NOW + 11 * 86400000,
  });
  state = addForecast(state, {
    questionId: 'first',
    personId: 'you',
    p: 0.8,
    at: NOW - 86400000,
    reasoning: 'I am taking the high side on the first example so a miss has something to teach.',
  });
  state = resolveQuestion(state, {
    questionId: 'first',
    outcome: 'no',
    at: NOW + 1500,
    note: 'The first example resolved No, against an 80 percent call.',
  });
  const reminders = remindersFor(state, 'you', NOW + 3000);
  assert.equal(reminders.some((item) => item.kind === 'stay' && item.questionId === 'second'), true);
  assert.equal(reminders.some((item) => item.kind === 'receipt'), true);
  const signals = leagueSignals(state);
  assert.equal(signals.missed, 1);
  assert.equal(signals.stayed, 0);
  state = addForecast(state, {
    questionId: 'second',
    personId: 'you',
    p: 0.42,
    at: NOW + 4000,
    reasoning: 'The first call missed. I am still on the docket, at a lower probability, with a reason.',
  });
  assert.equal(leagueSignals(state).stayed, 1);
  assert.equal(remindersFor(state, 'you', NOW + 5000).some((item) => item.kind === 'stay'), false);
});

test('the December desk seed matches the October hold and the stay count', () => {
  const state = seedState(NOW);
  const scores = questionScores(state, 'october-hold');
  assert.ok(scores.ada.baseline < 0);
  assert.ok(scores.priya.baseline < 0);
  assert.ok(scores.jonah.baseline < -100);
  assert.ok(scores.luis.baseline > 0);
  assert.ok(scores.mina.baseline > 0);
  const peerSum = Object.values(scores).reduce((sum, row) => sum + row.peer, 0);
  assert.ok(Math.abs(peerSum) < 1e-6);
  const signals = leagueSignals(state);
  assert.equal(signals.missed, 3);
  assert.equal(signals.stayed, 2);
  assert.equal(signals.followsOnNotes, 4);
  assert.equal(signals.misses.find((m) => m.personId === 'jonah').stayed, false);
  assert.equal(signals.misses.find((m) => m.personId === 'ada').stayed, true);
  const median = latestMedian(state, 'december-hike', NOW);
  assert.equal(median.n, 4);
  const ada = profileOf(state, 'ada');
  assert.equal(ada.stayed, 1);
  assert.equal(ada.missed, 1);
  assert.ok(ada.calls.find((c) => c.question.id === 'december-hike').followed.length >= 1);
  assert.equal(remindersFor(state, 'you', NOW).length, 0);
  assert.equal(state.forecasts.find((f) => f.id === 'f-ada-oct-1').snapshot.claim.includes('28 October 2026'), true);
});

test('a probability has to be between 1% and 99%, and the note has to be followable', () => {
  let state = openQuestion(createEmpty(NOW));
  assert.throws(() => addForecast(state, {
    questionId: 'q-test',
    personId: 'you',
    p: 0,
    at: NOW,
    reasoning: 'A zero is not a probability this league will store, even with a long note attached.',
  }), /1% to 99%/);
  assert.throws(() => addForecast(state, {
    questionId: 'q-test',
    personId: 'you',
    p: 0.4,
    at: NOW,
    reasoning: 'Too short.',
  }), /reason for this number/);
});

test('you cannot follow your own note', () => {
  let state = openQuestion(createEmpty(NOW));
  state = addForecast(state, {
    id: 'mine',
    questionId: 'q-test',
    personId: 'you',
    p: 0.4,
    at: NOW,
    reasoning: 'A note that is long enough to be followed, which I then try to follow myself.',
  });
  assert.throws(() => followNote(state, { followerId: 'you', forecastId: 'mine' }), /someone else’s/);
});
