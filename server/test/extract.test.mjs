// Regression tests for reading terms and claims out of articles.
//
// Every snippet below is a FIXTURE DERIVED FROM A REAL SOURCE: a sentence or
// paragraph copied verbatim from a page stored in eval/corpus/<id>/, wrapped
// in a minimal HTML page so extractArticle and candidatesFrom run end to end.
// The wrapper, the byline and the date come from that item's meta.json. Where
// a sentence was changed, the test says so. These are tests of extraction on
// real wording, not a measure of quality on unseen pages: that is eval/REPORT.md.
//
// Each rule has a positive and a negative case. No database is needed.

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { candidatesFrom, extractArticle } from '../src/articles.mjs';
import { deadlineOf, hedgesOf, interpret, probabilityOf } from '../src/interpret.mjs';

function page({ id, title, byline, site, published, paragraphs, extra = '' }) {
  return `<!doctype html><html><head><title>${title}</title>
  <meta name="author" content="${byline}"><meta property="og:site_name" content="${site}">
  <meta property="article:published_time" content="${published}"></head>
  <body><!-- fixture derived from eval/corpus/${id} -->${paragraphs.map((p) => `<p>${p}</p>`).join('\n')}${extra}</body></html>`;
}

function read(spec, limit = 50) {
  const article = extractArticle(page(spec), `https://example.test/${spec.id}`);
  return candidatesFrom(article, limit);
}

const FORTUNE = {
  id: 'fortune-capex-slow', title: 'AI capex will slow in 2027', byline: 'Jim Edwards', site: 'Fortune', published: '2026-10-07T12:00:00Z',
};
const MANSOUR = {
  id: 'mansour-adoption', title: 'When AI Adoption Catches Up', byline: 'Ahmed Mansour', site: 'ahmedm4nsour.com', published: '2026-09-01T12:00:00Z',
};
const CNBC_OCT = {
  id: 'cnbc-fed-survey-oct', title: 'Federal Reserve rate hikes are coming, but not this week: CNBC survey', byline: 'Steve Liesman', site: 'CNBC', published: '2026-10-27T11:10:00Z',
};
const OILPRICE = {
  id: 'oilprice-goldman-brent', title: 'Goldman Sachs Raises Brent Oil Price Forecast to $105', byline: 'Irina Slav', site: 'OilPrice.com', published: '2026-11-02T12:00:00Z',
};

// --- Rule 1: quoted speech is attributed to the quoted speaker; the writer's own claim stays the writer's.

test('quoted speech: a quoted forecast belongs to the speaker named after it, not to the writer', () => {
  const [c] = read({ ...FORTUNE, paragraphs: [
    'Other analysts are already predicting that 2027 will be the year when AI capex starts to decelerate. “We expect the market will start thinking about a potential peak year in 2027 soon, likely after 3Q EPS and midterms,” Wells Fargo’s Ohsung Kwon told clients this week. “Most investors now agree that AI capex will likely slow meaningfully in 2028.”',
  ] }).filter((x) => /Most investors/.test(x.text));
  assert.ok(c, 'the second quoted sentence is a candidate');
  assert.equal(c.reportedSpeech, true);
  assert.match(c.speaker, /Kwon/, 'a quotation that continues a named speaker keeps that speaker');
  assert.notEqual(c.speaker, 'Jim Edwards');
});

test('quoted speech: a claim the writer makes in the first person is not given to a quoted source', () => {
  const [c] = read({ ...MANSOUR, paragraphs: [
    'I expect AI adoption to cause serious employment disruption in 2027. People, companies, and governments should start preparing before the effects become visible.',
  ] });
  assert.ok(c);
  assert.equal(c.reportedSpeech, false);
  assert.equal(c.speaker, 'Ahmed Mansour');
});

test('quoted speech: a survey is the speaker of its respondents’ forecasts, and the saver is never one', () => {
  const cands = read({ ...CNBC_OCT, paragraphs: [
    'The CNBC Fed Survey shows that 93% of respondent expect a pause at the Federal Reserve meeting taking place this week.',
    'But it\'s not going to do it in October. That\'s the key finding in CNBC\'s latest Fed Survey of 30 fund managers, strategists and economists.',
  ] });
  const survey = cands.find((c) => /93%/.test(c.text));
  assert.ok(survey);
  assert.equal(survey.reportedSpeech, true);
  assert.match(survey.speaker, /Survey/);
  assert.ok(cands.every((c) => !/^@/.test(c.speaker)), 'no candidate is attributed to a handle');
});

// --- Rule 2: a sentence that is not a prediction is not offered.

test('non-prediction: a lawsuit report, a market price and page chrome are rejected while a forecast beside them is kept', () => {
  const cands = read({ ...OILPRICE, paragraphs: [
    'ChatGPT allegedly helped a North Carolina woman, Cheryl Gates, craft a “personalized plan” to poison her husband, James, after fueling her delusions that he planned to divorce her and leave her with nothing.',
    'CME FedWatch put the odds of a December hike at 85.0%.',
    'Posts from this author will be added to your daily email digest and your homepage feed.',
    'Goldman Sachs commodity analysts have revised their price forecast for Brent crude upwards, now expecting the benchmark to average $105 in December and remain elevated next year as well.',
  ] });
  assert.equal(cands.length, 1, cands.map((c) => c.text).join(' | '));
  assert.match(cands[0].text, /Goldman Sachs commodity analysts/);
  assert.match(cands[0].speaker, /Goldman/);
  assert.equal(cands[0].reportedSpeech, true);
});

test('non-prediction: a law that takes effect on a date is a schedule, not a forecast', () => {
  const cands = read({ id: 'natlawreview-ai-reg-nov', title: 'Guide to AI regulation in November', byline: 'Sharon R. Klein', site: 'The National Law Review', published: '2026-11-05T12:00:00Z', paragraphs: [
    'The law takes effect on January 1, 2027, and operators may not use a user’s health or personal information acquired more than 12 hours earlier or in a prior session.',
    'Covered models could not be released until an independent audit confirms they meet those standards.',
  ] });
  assert.equal(cands.length, 0);
});

// --- Rule 3: a hedge is never turned into a number.

test('hedges: "likely" and "unlikely" are listed as hedges and the probability stays null', () => {
  const sentence = 'But “they are unlikely to derail the buildout while financing remains readily available and the largest tech firms continue to expect exceptionally high returns from AI.”';
  assert.equal(probabilityOf(sentence), null);
  assert.ok(hedgesOf(sentence).includes('unlikely'));
  const terms = interpret('Most investors now agree that AI capex will likely slow meaningfully in 2028.', '2026-10-07');
  assert.equal(terms.probability, null);
  assert.ok(terms.hedges.includes('likely'));
});

test('hedges: words for odds stay null, a stated number is read, and a share of people is not a probability', () => {
  assert.equal(probabilityOf('whether it arrives inside this particular twelve-month window or just beyond it is very nearly a coin toss'), null);
  assert.equal(probabilityOf('Even Altman admits there’s a “non-zero” chance that it’s our last.'), null);
  assert.equal(probabilityOf('The chances of that happening by the end of the year remain slim'), null);
  // Stated numbers do convert.
  assert.equal(probabilityOf('he put a number on it: roughly a 50% chance of AGI by the end of the decade.'), 0.5);
  assert.equal(probabilityOf('with a one-in-four chance by April 2028.'), 0.25);
  assert.equal(probabilityOf('Respondents in aggregate put the risk of the U.S. entering a recession in the next year at 26%, down from 29% in the last survey.'), 0.26);
  // A share of respondents is not a probability.
  assert.equal(probabilityOf('But 88% do expect the central bank at this week\'s meeting to remove the easing bias in the statement.'), null);
  assert.equal(probabilityOf('the share putting the odds of a recession in the next 12 months below 20% doubled to 26% since the previous survey'), null);
  // A price implied by a market is not a person's probability.
  assert.equal(probabilityOf('Futures now price an 85.0% chance of a quarter-point hike at the Fed\'s December meeting'), null);
});

test('hedges: "soon" and "eventually" are hedges, not dates', () => {
  const claim = 'He added that AGI could eventually help identify treatments for diseases that currently have none.';
  const terms = interpret(claim, '2026-10-22');
  assert.equal(terms.deadlineText, null);
  assert.equal(terms.proposedDeadlineAt, null);
  assert.ok(terms.hedges.includes('eventually') && terms.hedges.includes('could'));
  const soon = interpret('Voss isn\'t the only engineer who has said that scaling LLMs won\'t lead to AGI anytime soon.', '2026-10-02');
  assert.equal(soon.deadlineText, null);
  assert.ok(soon.hedges.includes('soon'));
  // The month "May" in a stated date is not the hedge "may".
  assert.equal(hedgesOf('By May of 2027 there will have been a genuine and named correction').includes('may'), false);
});

// --- Rule 4: a missing deadline stays null.

test('missing deadline: a forecast with no date has no date, and a proposed date is never invented', () => {
  const terms = interpret('AI will take a bunch of stuff that used to be expensive and make it very cheap or free', '2026-05-24');
  assert.equal(terms.deadlineText, null);
  assert.equal(terms.proposedDeadlineAt, null);
  assert.equal(terms.probability, null);
  const [c] = read({ id: 'evans-ai-job-exposure', title: 'Predicting AI job exposure', byline: 'Benedict Evans', site: 'ben-evans.com', published: '2026-05-24T12:00:00Z', paragraphs: [
    'We know, in principle, that like every other big wave of technology, AI is bound to destroy some jobs and create others.',
  ] });
  assert.ok(c);
  assert.equal(c.deadlineText, null);
  assert.equal(c.probability, null);
});

test('missing deadline: the time something was said is not the time it resolves', () => {
  const said = interpret('he told Joe Rogan in January 2025 that Meta would probably have, within the year, an AI that could do the work of a “mid-level engineer,”', '2026-11-03');
  assert.equal(said.deadlineText, 'within the year');
  const recap = deadlineOf('In January 2025, Altman wrote that OpenAI is “now confident we know how to build AGI.”', new Date('2026-11-03'));
  assert.equal(recap.text, null, 'a statement date alone is not a deadline');
  const stat = deadlineOf('In 2025, 20% of EU enterprises with at least 10 employees used AI, up from 13.5% in 2024.', new Date('2026-09-01'));
  assert.equal(stat.text, null, 'a past statistic is not a deadline');
});

// --- Rule 5: a stated deadline is read correctly.

test('stated deadline: years, months, quarters and relative phrases are read as stated', () => {
  const at = (text, published) => deadlineOf(text, new Date(published));
  let d = at('OpenAI “will be a public company in 2027,”', '2026-11-03');
  assert.equal(d.text, 'in 2027');
  assert.equal(d.at.toISOString(), '2027-12-31T23:59:59.000Z');
  d = at('By May of 2027 there will have been a genuine and named correction', '2026-05-25');
  assert.equal(d.text, 'By May of 2027');
  assert.equal(d.at.toISOString(), '2027-05-31T23:59:59.000Z');
  d = at('Core personal consumption expenditures inflation is expected to reach 3.3% by the fourth quarter of 2026', '2026-10-01');
  assert.equal(d.text, 'by the fourth quarter of 2026');
  assert.equal(d.at.toISOString(), '2026-12-31T23:59:59.000Z');
  d = at('he said AI could outsmart any individual by the end of 2026, or 2027 at the latest.', '2026-11-06');
  assert.equal(d.text, 'by the end of 2026, or 2027 at the latest');
  assert.equal(d.at.toISOString(), '2027-12-31T23:59:59.000Z', 'the later year is the outer bound');
  d = at('76% anticipate a rate hike at its next meeting in December.', '2026-10-27');
  assert.match(d.text, /December/);
  d = at('a decade from now we could see just an unbelievably different landscape', '2026-10-05');
  assert.equal(d.text, 'a decade from now');
  assert.equal(d.at.getUTCFullYear(), 2036);
  d = at('now expects artificial general intelligence to arrive within two to three years', '2026-10-22');
  assert.equal(d.text, 'within two to three years');
  assert.equal(d.at, null, 'a range is kept as stated words and not turned into a single date');
});

test('stated deadline: the sentence that states it is the one that carries it, end to end', () => {
  const cands = read({ ...OILPRICE, paragraphs: [
    'UBS sees the benchmark at $110 per barrel at the end of the current year.',
    'Next year, Goldman’s analysts expect Brent crude to average $88 per barrel, up from $80 per barrel in an earlier forecast.',
  ] });
  assert.equal(cands.length, 2);
  assert.equal(cands[0].deadlineText, 'at the end of the current year');
  assert.equal(cands[0].speaker, 'UBS');
  assert.equal(cands[1].deadlineText, 'Next year');
  assert.equal(cands[1].reportedSpeech, true);
});

// --- Page structure: the story, not the page.

test('structure: body text in list items is read, and a digest page is cut to the story the title names', () => {
  const list = read({ id: 'agitracker-four-years', title: 'AGI Is Always About Four Years Away', byline: 'The agitracker.io team', site: 'agitracker.io', published: '2026-10-29T10:00:00Z', paragraphs: [],
    extra: '<ul><li><strong>Fixed dates.</strong> Ray Kurzweil predicted human-level intelligence by 2029 in 2005 and reaffirmed 2029 in 2024. Shane Legg gave 2028 in 2011 and again in 2023.</li></ul>' });
  assert.ok(list.some((c) => /Kurzweil predicted/.test(c.text) && c.speaker === 'Ray Kurzweil' && c.deadlineText === 'by 2029'), 'a list item with sentences is body text');

  const headline = 'AI is heading toward a cash flow negative inflection point, and spending will slow in 2027, Wall Street thinks';
  const others = ['Arsenal’s Mikel Arteta on why he’s going public about having his DNA mapped', 'The McStruggle is real: McDonald’s CEO is fighting to revamp the burger chain', 'Dan Ives is back and bullish on tech stocks, according to his first note', 'Traders hit pause after the S&P 500’s all-time high as bonds slide'];
  const digest = `<!doctype html><html><head><title>${headline}</title><meta property="og:title" content="${headline}"></head><body><article>
    <h2>${others[0]}</h2><p>Arteta, who had a serious heart condition when he was young, said the test revealed an increased likelihood of celiac disease and lactose intolerance.</p>
    <h2>${headline}</h2><p>Other analysts are already predicting that 2027 will be the year when AI capex starts to decelerate.</p>
    <h2>${others[1]}</h2><p>McDonald’s will cut prices again in 2027, according to its chief executive, in the hope of regaining customer visits.</p>
    <h2>${others[2]}</h2><p>Ives expects the sector to rise further next year as supply constraints ease across the sector.</p>
    <h2>${others[3]}</h2><p>Futures are down before the open in New York after a record high yesterday.</p>
  </article></body></html>`;
  const article = extractArticle(digest, 'https://example.test/digest');
  const texts = candidatesFrom(article).map((c) => c.text);
  assert.ok(texts.some((t) => /Other analysts are already predicting/.test(t)));
  assert.ok(texts.every((t) => !/McDonald|Ives expects/.test(t)), 'sentences from the other stories on the page are not offered');
});

test('structure: a long single-story page is not cut by its section headings', () => {
  const headings = ['Mid 2025: Stumbling Agents', 'Late 2025: The World’s Most Expensive AI', 'Early 2026: Coding Automation', 'Mid 2026: China Wakes Up'];
  const body = `<!doctype html><html><head><title>AI 2027</title></head><body><article><h1>AI 2027</h1>${headings.map((h, i) => `<h2>${h}</h2><p>Agents will improve in stage ${i} of this scenario, and the labs expect that more capable models will arrive by ${2026 + i}.</p>`).join('')}</article></body></html>`;
  const article = extractArticle(body, 'https://example.test/long');
  assert.equal(article.paragraphs.length, 4, 'every section is kept');
});

// --- Exported shapes the server relies on.

test('shapes: interpret, extractArticle and candidatesFrom keep their fields', () => {
  const terms = interpret('The index will top 6,000 by the end of 2027.', '2026-11-06');
  for (const key of ['claim', 'probability', 'deadlineText', 'proposedDeadlineAt', 'condition', 'hedges', 'predictive']) assert.ok(key in terms, key);
  const article = extractArticle(page({ ...MANSOUR, paragraphs: ['The index will top 6,000 by the end of 2027, in this writer’s view.'] }), 'https://example.test/x');
  for (const key of ['title', 'byline', 'site', 'publishedAt', 'canonicalUrl', 'paragraphs']) assert.ok(key in article, key);
  const [c] = candidatesFrom(article);
  for (const key of ['index', 'text', 'speaker', 'reportedSpeech', 'deadlineText', 'probability', 'hedges']) assert.ok(key in c, key);
  assert.equal(c.index, 0);
});

test('shapes: the cap keeps the strongest candidates in page order and reports how many it left out', () => {
  const sentences = [];
  for (let i = 0; i < 20; i += 1) sentences.push(`Analyst ${String.fromCharCode(65 + i)}${String.fromCharCode(97 + i)} expects Brent crude to average $${100 + i} per barrel by the end of 2027.`);
  const cands = read({ ...OILPRICE, paragraphs: [sentences.join(' ')] }, 5);
  assert.equal(cands.length, 5);
  assert.equal(cands.total, 20);
  assert.deepEqual(cands.map((c) => c.index), [0, 1, 2, 3, 4]);
});
