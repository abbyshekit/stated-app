// The December desk, as of 5 November 2026.
// The closed call uses the FOMC statement of 28 October 2026.
// Ada, Luis, Mina, Priya, and Jonah are example records so the docket
// is readable before the first real call. They are not real forecasters.

import {
  addEvidence,
  addForecast,
  addQuestion,
  createEmpty,
  followNote,
  resolveQuestion,
} from './domain.mjs';

const FED_OCT = 'https://www.federalreserve.gov/newsevents/pressreleases/monetary20261028a.htm';
const FED_CAL = 'https://www.federalreserve.gov/monetarypolicy/fomccalendars.htm';
const BLS_CPI = 'https://www.bls.gov/schedule/news_release/cpi.htm';
const BLS_DEC = 'https://www.bls.gov/schedule/2026/12_sched.htm';

const T = {
  octOpen: Date.parse('2026-10-20T13:00:00Z'),
  octAda2: Date.parse('2026-10-27T13:00:00Z'),
  octClose: Date.parse('2026-10-28T17:30:00Z'),
  octResolve: Date.parse('2026-10-28T18:10:00Z'),
  decOpen: Date.parse('2026-10-28T19:00:00Z'),
  decClose: Date.parse('2026-12-09T18:30:00Z'),
  decBy: Date.parse('2026-12-09T23:00:00Z'),
  cpiOpen: Date.parse('2026-10-29T14:00:00Z'),
  cpiClose: Date.parse('2026-11-10T13:00:00Z'),
  cpiBy: Date.parse('2026-11-10T18:00:00Z'),
  jobsOpen: Date.parse('2026-11-05T14:00:00Z'),
  jobsClose: Date.parse('2026-12-04T13:00:00Z'),
  jobsBy: Date.parse('2026-12-04T18:00:00Z'),
  yearOpen: Date.parse('2026-10-28T19:00:00Z'),
  yearClose: Date.parse('2026-12-31T23:00:00Z'),
  yearBy: Date.parse('2027-01-02T18:00:00Z'),
  nov1: Date.parse('2026-11-01T15:00:00Z'),
  nov2: Date.parse('2026-11-02T15:00:00Z'),
  nov3: Date.parse('2026-11-03T15:00:00Z'),
  nov4: Date.parse('2026-11-04T16:00:00Z'),
  nov5: Date.parse('2026-11-05T15:00:00Z'),
};

function person(id, name) {
  return { id, name, sample: true, joinedAt: T.octOpen };
}

export function seedState(now = Date.now()) {
  let state = createEmpty(now);
  state = {
    ...state,
    seq: 100,
    people: {
      ...state.people,
      ada: person('ada', 'Ada Okonkwo'),
      luis: person('luis', 'Luis Ferrer'),
      mina: person('mina', 'Mina Cho'),
      priya: person('priya', 'Priya Raman'),
      jonah: person('jonah', 'Jonah Ellis'),
    },
  };

  state = addQuestion(state, {
    id: 'october-hold',
    authorId: 'desk',
    claim: 'Did the FOMC raise the target range for the federal funds rate at the meeting that concluded on 28 October 2026?',
    yesRule: 'Yes if the implementation note released with that day’s statement set a lower bound above the lower bound in force at 12:01 a.m. Eastern on 27 October 2026.',
    noRule: 'No if that implementation note set a lower bound equal to or below the lower bound in force at 12:01 a.m. Eastern on 27 October 2026.',
    ambiguousRule: 'Ambiguous if the note states no single lower bound, or if two official notes released that day disagree.',
    annulledRule: 'Annulled if the meeting ended with no implementation note and none was published by 30 October 2026, 6:00 p.m. Eastern.',
    sourceName: 'FOMC implementation note, 28 October 2026',
    postRule: 'Yes if that day’s note set a higher lower bound than at 12:01 a.m. ET on 27 Oct. No if the bound was equal or lower.',
    sourceUrl: FED_OCT,
    openAt: T.octOpen,
    closeAt: T.octClose,
    resolveBy: T.octResolve,
  });

  state = addQuestion(state, {
    id: 'october-cpi',
    authorId: 'desk',
    claim: 'Will the first BLS release of the October 2026 CPI-U all-items 12-month percent change be higher than the September 2026 figure in the September release?',
    yesRule: 'Yes if the October all-items 12-month percent change in the first news release is strictly greater than the September all-items 12-month percent change in the September news release, before later revisions.',
    noRule: 'No if that October figure is equal to or lower than that September figure.',
    ambiguousRule: 'Ambiguous if either figure is missing, is published only as a range, or is revised inside the October release itself.',
    annulledRule: 'Annulled if the October CPI news release is cancelled and has not been published by 12 November 2026, 6:00 p.m. Eastern.',
    sourceName: 'BLS Consumer Price Index news release',
    postRule: 'Yes if the first October 12-month CPI-U print is strictly above the September print. No if it is equal or lower.',
    sourceUrl: BLS_CPI,
    openAt: T.cpiOpen,
    closeAt: T.cpiClose,
    resolveBy: T.cpiBy,
  });

  state = addQuestion(state, {
    id: 'november-jobs',
    authorId: 'desk',
    claim: 'Will the November 2026 unemployment rate, U-3, in the first Employment Situation release be higher than the October 2026 U-3 rate in the prior release?',
    yesRule: 'Yes if the November U-3 rate in the first Employment Situation is strictly greater than the October U-3 rate published in the prior Employment Situation, before later revisions.',
    noRule: 'No if that November rate is equal to or lower than that October rate.',
    ambiguousRule: 'Ambiguous if either rate is missing, is published only as a range, or is revised inside the November release itself.',
    annulledRule: 'Annulled if the November Employment Situation is cancelled and has not been published by 6 December 2026, 6:00 p.m. Eastern.',
    sourceName: 'BLS Employment Situation',
    postRule: 'Yes if the first November U-3 print is strictly above the October rate. No if it is equal or lower.',
    sourceUrl: BLS_DEC,
    openAt: T.jobsOpen,
    closeAt: T.jobsClose,
    resolveBy: T.jobsBy,
  });

  state = addQuestion(state, {
    id: 'december-hike',
    authorId: 'desk',
    claim: 'Will the FOMC raise the target range for the federal funds rate at the meeting that concludes on 9 December 2026?',
    yesRule: 'Yes if the implementation note released with that meeting’s statement sets a lower bound above the lower bound in force at 12:01 a.m. Eastern on 8 December 2026.',
    noRule: 'No if that implementation note sets a lower bound equal to or below the lower bound in force at 12:01 a.m. Eastern on 8 December 2026.',
    ambiguousRule: 'Ambiguous if the note states no single lower bound, or if two official notes released that day disagree.',
    annulledRule: 'Annulled if the meeting is cancelled, or if it ends with no implementation note and none is published by 11 December 2026, 6:00 p.m. Eastern.',
    sourceName: 'FOMC implementation note for the 8–9 December 2026 meeting',
    postRule: 'Yes if the 9 Dec note sets a higher lower bound than at 12:01 a.m. ET on 8 Dec. No if that bound is equal or lower.',
    sourceUrl: FED_CAL,
    openAt: T.decOpen,
    closeAt: T.decClose,
    resolveBy: T.decBy,
  });

  state = addQuestion(state, {
    id: 'year-end-range',
    authorId: 'desk',
    claim: 'Will the lower bound of the federal funds target range be higher on 31 December 2026 than the 3.75 percent lower bound set on 28 October 2026?',
    yesRule: 'Yes if an FOMC implementation note dated on or before 31 December 2026 sets a lower bound above 3.75 percent, and no later note dated on or before that day sets it back to 3.75 percent or below.',
    noRule: 'No if the lower bound in force at 11:59 p.m. Eastern on 31 December 2026 is 3.75 percent or lower.',
    ambiguousRule: 'Ambiguous if the notes in force that day disagree, or if the bound is not a single number.',
    annulledRule: 'Annulled if, before 31 December 2026, the FOMC replaces the target range with a different instrument, so there is no lower bound of a target range to read.',
    sourceName: 'FOMC implementation notes',
    postRule: 'Yes if the lower bound in force at 11:59 p.m. ET on 31 Dec is above 3.75%. No if it is 3.75% or lower.',
    sourceUrl: FED_CAL,
    openAt: T.yearOpen,
    closeAt: T.yearClose,
    resolveBy: T.yearBy,
  });

  const say = (id, questionId, personId, p, at, reasoning) => {
    state = addForecast(state, { id, questionId, personId, p, at, reasoning });
  };

  say('f-ada-oct-1', 'october-hold', 'ada', 0.70, T.octOpen,
    'The committee raised the range in September, and inflation is still the constraint they name. I think they raise again at this meeting.');
  say('f-ada-oct-2', 'october-hold', 'ada', 0.64, T.octAda2,
    'No soft print has shown up that would justify a pause. I am shading down from 70 percent, not changing the call.');
  say('f-luis-oct', 'october-hold', 'luis', 0.22, T.octOpen,
    'September was already a quarter-point increase. I expect a hold at this meeting and the argument to move to December.');
  say('f-mina-oct', 'october-hold', 'mina', 0.28, T.octOpen,
    'Back-to-back hikes would be fast for the way this committee has been moving. I have the hold as the main case.');
  say('f-priya-oct', 'october-hold', 'priya', 0.55, T.octOpen,
    'I am close to even. The September hike could be the start of a series or a single move, and I do not have a print that settles it.');
  say('f-jonah-oct', 'october-hold', 'jonah', 0.82, T.octOpen,
    'The last move was up and inflation is still above their goal. I do not see a reason to pause this soon.');

  say('f-ada-dec-1', 'december-hike', 'ada', 0.58, T.nov1,
    'I was wrong about October. The statement kept the range at 3.75 to 4 percent, with Cook and Hammack dissenting for a raise. A hold did not retire the hike. It moved the argument to the December meeting, which publishes projections.');
  say('f-ada-dec-2', 'december-hike', 'ada', 0.54, T.nov4,
    'Shading down ahead of the October CPI release. The dissent still keeps a hike inside the range of what I consider plausible.');
  say('f-luis-dec', 'december-hike', 'luis', 0.48, T.nov1,
    'The hold was my October call. December publishes projections, and the statement said inflation remains elevated. I am near even until the October CPI release on 10 November.');
  say('f-mina-dec', 'december-hike', 'mina', 0.36, T.nov2,
    'Ten officials voted to hold and two wanted a quarter-point raise. I stay on a hold until the October CPI and the November labor report are in.');
  say('f-priya-dec', 'december-hike', 'priya', 0.41, T.nov3,
    'October showed I was overweighting the last hike. The majority wanted to wait. December is still live because they have to publish a path, so I moved down rather than out.');

  say('f-ada-cpi', 'october-cpi', 'ada', 0.57, T.nov2,
    'I want the first October 12-month print against the September print, not a story about the trend. I lean toward a higher pace.');
  say('f-luis-cpi', 'october-cpi', 'luis', 0.46, T.nov2,
    'Shelter and goods have been pulling in different directions. I am slightly under even on a higher 12-month pace than September.');
  say('f-mina-cpi', 'october-cpi', 'mina', 0.38, T.nov2,
    'A hotter 12-month pace than September is not my base case. I want the release, not an extrapolation from the dissent.');
  say('f-priya-cpi', 'october-cpi', 'priya', 0.52, T.nov2,
    'I am near even on whether the October 12-month pace prints above September. The sentence about elevated inflation is not a number.');

  say('f-ada-jobs', 'november-jobs', 'ada', 0.44, T.nov5,
    'The October statement said job gains have kept pace with the workforce and the unemployment rate has changed little. I need a higher U-3 print before I treat labor as the reason to hike.');
  say('f-luis-jobs', 'november-jobs', 'luis', 0.40, T.nov5,
    'A higher unemployment rate would complicate a December hike. I think the first November print comes in level or lower, not higher.');

  say('f-ada-year', 'year-end-range', 'ada', 0.60, T.nov3,
    'If December raises the lower bound, it is still higher on 31 December. I am carrying the December call into year-end, minus a small chance they reverse it.');
  say('f-luis-year', 'year-end-range', 'luis', 0.33, T.nov3,
    'I think the range is unchanged at year-end. December is the only scheduled meeting left, and I am not pricing an intermeeting move.');
  say('f-priya-year', 'year-end-range', 'priya', 0.45, T.nov4,
    'This is mostly the December decision, plus a second move I do not really believe. I am leaving the year-end call near even.');

  state = resolveQuestion(state, {
    questionId: 'october-hold',
    outcome: 'no',
    at: T.octResolve,
    sourceUrl: FED_OCT,
    note: 'The statement released at 2:00 p.m. Eastern on 28 October 2026 maintained the target range at 3-3/4 to 4 percent. The vote was 10–2. Cook and Hammack preferred a quarter-point increase.',
  });

  state = addEvidence(state, {
    id: 'e-dec-statement',
    questionId: 'december-hike',
    at: T.octResolve,
    source: 'FOMC statement, 28 October 2026',
    url: FED_OCT,
    note: 'The committee maintained the target range at 3-3/4 to 4 percent. Cook and Hammack dissented in favor of raising the range by a quarter point.',
  });

  state = addEvidence(state, {
    id: 'e-cpi-date',
    questionId: 'october-cpi',
    at: T.nov5,
    source: 'BLS CPI release schedule',
    url: BLS_CPI,
    note: 'The BLS schedule lists the October 2026 Consumer Price Index for 10 November 2026 at 8:30 a.m. Eastern. Updates on this call stop at 8:00 a.m. that morning.',
  });

  state = followNote(state, { id: 'w-luis-ada', followerId: 'luis', forecastId: 'f-ada-dec-2', at: T.nov4 + 3600000 });
  state = followNote(state, { id: 'w-priya-ada', followerId: 'priya', forecastId: 'f-ada-dec-2', at: T.nov4 + 7200000 });
  state = followNote(state, { id: 'w-mina-luis', followerId: 'mina', forecastId: 'f-luis-oct', at: T.octResolve });
  state = followNote(state, { id: 'w-ada-luis', followerId: 'ada', forecastId: 'f-luis-dec', at: T.nov2 });

  return state;
}
