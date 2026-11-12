// Reads the terms a statement actually states. A deadline or probability
// that the text does not state stays null. Hedges are listed, never turned
// into numbers. A proposed deadline is a reading of the stated words, and
// only the author or a reviewer can confirm it.
//
// Two detectors decide whether a sentence is worth proposing as a prediction.
// looksLikePrediction is permissive: it reads a person's own tagged post,
// where the user has already said "track this". articleClaimCue is strict: it
// reads sentences out of long pages, where most sentences are not forecasts.
// Both are measured in eval/ (see eval/REPORT.md) and fixed by
// server/test/extract.test.mjs.

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july',
  'august', 'september', 'october', 'november', 'december'];
const MONTH_RE = '(jan(?:uary)?|feb(?:ruary)?|mar(?:ch)?|apr(?:il)?|may|jun(?:e)?|jul(?:y)?|aug(?:ust)?|sep(?:t(?:ember)?)?|oct(?:ober)?|nov(?:ember)?|dec(?:ember)?)';

// Words that express uncertainty. They are reported to the reviewer and never
// read as a probability or a date.
const HEDGES = [
  'almost certainly', 'very likely', 'highly likely', 'most likely', 'more likely', 'unlikely', 'likely', 'probably',
  'possibly', 'perhaps', 'maybe', 'could', 'might', 'may well', 'may', 'soon', 'eventually', 'at some point',
  'near term', 'near-term', 'anytime soon', 'coin toss', 'non-zero', 'slim', 'roughly', 'i think', 'i believe',
  'i expect', 'i bet', 'my guess', 'odds are', 'expect', 'expects', 'feels like', 'it seems to me', 'hoping',
];

const FUTURE = /\b(will|won't|wont|going to|gonna|shall|by (?:the )?(?:end of )?(?:\d{4}|\d{1,2}(?:st|nd|rd|th)?\s+(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)\w*|q[1-4]|jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)|before \d{4}|in \d{4}|next (?:year|month|week|quarter)|this (?:year|month|quarter)|within \d+|predict|forecast|expect|odds|chance|likely|probability|bet)\b/i;

const NUMBER_WORDS = {
  one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11,
  twelve: 12, fifteen: 15, twenty: 20, thirty: 30,
};
const NUM = '(\\d{1,3}|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|fifteen|twenty|thirty)';
const UNIT = '(day|week|month|year|decade)s?';

function numberOf(word) {
  const w = String(word).toLowerCase();
  return /^\d+$/.test(w) ? Number(w) : NUMBER_WORDS[w];
}

function monthIndex(word) {
  const w = word.toLowerCase().slice(0, 3);
  return MONTHS.findIndex((m) => m.startsWith(w));
}

function endOfDayUtc(y, m, d) {
  return new Date(Date.UTC(y, m, d, 23, 59, 59));
}

function endOfMonthUtc(y, m) {
  return new Date(Date.UTC(y, m + 1, 0, 23, 59, 59));
}

function addUnits(base, n, unit) {
  const at = new Date(base);
  if (unit === 'day') at.setUTCDate(at.getUTCDate() + n);
  if (unit === 'week') at.setUTCDate(at.getUTCDate() + 7 * n);
  if (unit === 'month') at.setUTCMonth(at.getUTCMonth() + n);
  if (unit === 'year') at.setUTCFullYear(at.getUTCFullYear() + n);
  if (unit === 'decade') at.setUTCFullYear(at.getUTCFullYear() + 10 * n);
  return at;
}

export function stripForClaim(text) {
  return String(text || '')
    .replace(/^(?:\s*@\w{1,15})+\s*/, '')
    .replace(/https?:\/\/t\.co\/\w+/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

const WORD_FRACTION = /\b(one|two|three|four|five|six|seven|eight|nine|ten)[\s-]+in[\s-]+(two|three|four|five|six|seven|eight|nine|ten|twenty|hundred)\s+(?:chance|odds|probability|likelihood)\b/i;

export function probabilityOf(text) {
  const t = String(text || '');
  // A price implied by a market is not a person's stated probability.
  if (/\b(futures|fedwatch|polymarket|kalshi|bettors?|prediction markets?|implied by)\b/i.test(t)) return null;
  const patterns = [
    /(\d{1,2}(?:\.\d+)?)\s?(?:%|percent|per cent)\s+(?:chance|odds|probability|likely|likelihood|confident|sure)\b/i,
    /\b(?:chance|odds|probability|likelihood)\s+(?:is\s+|of\s+|at\s+)?(?:about\s+|around\s+|roughly\s+)?(\d{1,2}(?:\.\d+)?)\s?(?:%|percent|per cent)/i,
    /\b(?:i'?d put it at|i put it at|i give it|i'?d give it)\s+(\d{1,2}(?:\.\d+)?)\s?(?:%|percent|per cent)/i,
    /\b(?:risk|probability|odds|chance|likelihood) of (?:[^.;!?]|\b[A-Z]\.(?=[A-Z\s])){3,90}? (?:at|to) (\d{1,2}(?:\.\d+)?)\s?(?:%|percent|per cent)/i,
    /\bp\s?=\s?0?\.(\d{1,3})\b/i,
  ];
  for (const re of patterns) {
    const m = t.match(re);
    if (!m) continue;
    // "the share putting the odds of a recession ... doubled to 26%" counts people, not odds
    if (/\b(share|proportion|percentage)\b/i.test(t.slice(Math.max(0, m.index - 50), m.index + m[0].length))) continue;
    const raw = re.source.startsWith('\\bp') ? Number(`0.${m[1]}`) * 100 : Number(m[1]);
    if (raw >= 1 && raw <= 99) return Math.round(raw * 10) / 1000;
  }
  const words = t.match(WORD_FRACTION);
  if (words) {
    const a = numberOf(words[1]);
    const b = { hundred: 100 }[words[2].toLowerCase()] ?? numberOf(words[2]);
    if (a && b && a < b) return Math.round((a / b) * 1000) / 1000;
  }
  return null;
}

// A date in "he said in 2025" or "in a July 2026 interview" is when something
// was said, not when the forecast resolves.
const SPEECH_BEFORE = /\b(said|says|wrote|writes|told|stated|argued|noted|posted|announced|declared|reported|published|launched|released|filed|spoke|speaking|testified|interview|essay|memo|letter|podcast|speech|post|note|op-ed|column|report|statement|earlier|since|ago|last|between|from|after)\b[^.;]{0,30}$/i;

const FORWARD_FRAME = /\b(will|would|could|might|may|going to|predict\w*|forecast\w*|expect\w*|promis\w*|plans?|target\w*|aim\w*|set to|bound to|confident|estimate\w*)\b/i;

// A year is a usable deadline if it is still ahead, or if the sentence frames
// it as a forecast (a recap of an earlier forecast keeps its stated year).
function usableYear(year, py, text = '') {
  if (year > py + 60) return false;
  if (year >= py) return true;
  return year >= py - 30 && FORWARD_FRAME.test(text);
}

function spoken(t, at, length) {
  return SPEECH_BEFORE.test(t.slice(0, at))
    || /^\s*[,—-]\s*(?:\w+\s+){0,6}(?:said|says|told|wrote|writes|stated|noted|argued|predicted|put|posted)\b/i.test(t.slice(at + length));
}

// Each rule returns a match [text, at | null] or null. Rules run in order of
// how much of the sentence they explain; the first usable match wins.
// Every deadline phrase in the sentence is found (each pass masks the one before),
// phrases that are already in the past are set aside unless the sentence is a
// recap that uses "by", and the earliest remaining phrase is the one proposed.
export function deadlineOf(text, publishedAt = new Date()) {
  const pub = new Date(publishedAt);
  let t = String(text || '');
  const future = [];
  const past = [];
  for (let pass = 0; pass < 5; pass += 1) {
    const d = firstDeadline(t, publishedAt);
    if (!d.text) break;
    const at = t.indexOf(d.text);
    const isPast = d.at ? d.at < pub : false;
    (isPast ? past : future).push({ ...d, pos: at < 0 ? 1e9 : at });
    if (at < 0) break;
    t = `${t.slice(0, at)}${' '.repeat(d.text.length)}${t.slice(at + d.text.length)}`;
  }
  if (future.length) {
    future.sort((a, b) => a.pos - b.pos);
    return { text: future[0].text, at: future[0].at };
  }
  const recap = past.filter((d) => /^(?:by|before|until|through)\b/i.test(d.text) && FORWARD_FRAME.test(String(text)));
  if (recap.length) return { text: recap[0].text, at: recap[0].at };
  return { text: null, at: null };
}

function firstDeadline(text, publishedAt) {
  let t = String(text || '');
  const pub = new Date(publishedAt);
  const py = pub.getUTCFullYear();
  const pm = pub.getUTCMonth();
  const found = (m, at) => ({ text: m[0].trim(), at });
  let m;

  // Explicit UTC clocks must be consumed with their date, including when invalid.
  const utcPatterns = [
    new RegExp(`\\bat\\s+(\\d{1,2}):(\\d{2})\\s+UTC(?:[+-][0-9:]+)?\\s+on\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\.?\\s+(\\d{4})\\b`, 'gi'),
    new RegExp(`\\b(on|by|before)\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\.?\\s+(\\d{4})\\s+at\\s+(\\d{1,2}):(\\d{2})\\s+UTC(?:[+-][0-9:]+)?(?![\\w+:-])`, 'gi'),
    // "before 18:00 UTC on 12 November 2026": the clock is the deadline, not the end of that day.
    new RegExp(`\\b(by|before)\\s+(\\d{1,2}):(\\d{2})\\s+UTC(?:[+-][0-9:]+)?\\s+on\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\.?\\s+(\\d{4})\\b`, 'gi'),
  ];
  const groups = [
    { hour: 1, minute: 2, day: 3, month: 4, year: 5 },
    { hour: 5, minute: 6, day: 2, month: 3, year: 4 },
    { hour: 2, minute: 3, day: 4, month: 5, year: 6 },
  ];
  const utcDates = utcPatterns.flatMap((re, order) => Array.from(t.matchAll(re), (match) => ({ match, order })))
    .sort((a, b) => a.match.index - b.match.index);
  for (const { match, order } of utcDates) {
    const g = groups[order];
    const hour = Number(match[g.hour]);
    const minute = Number(match[g.minute]);
    const day = Number(match[g.day]);
    const month = monthIndex(match[g.month]);
    const year = Number(match[g.year]);
    const at = new Date(Date.UTC(year, month, day, hour, minute));
    const valid = !/UTC[+-]/i.test(match[0]) && hour < 24 && minute < 60 && at.getUTCFullYear() === year
      && at.getUTCMonth() === month && at.getUTCDate() === day;
    const isOn = order === 0 || (order === 1 && match[1].toLowerCase() === 'on');
    if (valid && !(isOn && (spoken(t, match.index, match[0].length) || at < pub))) return found(match, at);
    t = `${t.slice(0, match.index)}${' '.repeat(match[0].length)}${t.slice(match.index + match[0].length)}`;
  }

  // Relative reply dates use the reply's UTC day, rather than the source post's day.
  if ((m = t.match(/\b(by|before)\s+(tomorrow|sunday|monday|tuesday|wednesday|thursday|friday|saturday)\b/i))) {
    const name = m[2].toLowerCase();
    const weekday = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'].indexOf(name);
    const days = name === 'tomorrow' ? 1 : (weekday - pub.getUTCDay() + 7) % 7;
    const at = endOfDayUtc(py, pm, pub.getUTCDate() + days - (m[1].toLowerCase() === 'before' ? 1 : 0));
    return found(m, at);
  }

  // Mask invalid explicit dates so a later, looser rule cannot reinterpret them.
  const datePatterns = [
    new RegExp(`\\b(?:by|before|on|until|through|no later than)\\s+${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?(?:,?\\s+(\\d{4}))?\\b`, 'gi'),
    new RegExp(`\\b(?:by|before|on|until|through|no later than)\\s+(\\d{1,2})(?:st|nd|rd|th)?\\s+${MONTH_RE}\\.?(?:,?\\s+(\\d{4}))?(?!\\w)`, 'gi'),
  ];
  const dates = datePatterns.flatMap((re, order) => Array.from(t.matchAll(re), (match) => ({ match, order })))
    .sort((a, b) => a.match.index - b.match.index);
  for (const { match, order } of dates) {
    const month = monthIndex(match[order === 0 ? 1 : 2]);
    const day = Number(match[order === 0 ? 2 : 1]);
    let year = match[3] ? Number(match[3]) : py;
    let at = endOfDayUtc(year, month, day);
    if (!match[3] && at < pub) {
      year += 1;
      at = endOfDayUtc(year, month, day);
    }
    if (at.getUTCFullYear() !== year || at.getUTCMonth() !== month || at.getUTCDate() !== day) {
      t = `${t.slice(0, match.index)}${' '.repeat(match[0].length)}${t.slice(match.index + match[0].length)}`;
    }
  }

  // "by the end of March 2027", "by end of March 2027"
  if ((m = t.match(new RegExp(`\\b(?:by|before|until|through|no later than)\\s+(?:the\\s+)?end\\s+of\\s+${MONTH_RE}\\s+(?:of\\s+)?(\\d{4})\\b`, 'i')))) {
    if (usableYear(Number(m[2]), py, t)) return found(m, endOfMonthUtc(Number(m[2]), monthIndex(m[1])));
  }
  // "by May of 2027", "by about May of 2027", "in March 2027", "before June 2027"
  for (const mm of t.matchAll(new RegExp(`\\b(by|before|in|until|through)\\s+(?:about\\s+|roughly\\s+)?${MONTH_RE}\\s+(?:of\\s+)?(\\d{4})\\b`, 'gi'))) {
    const year = Number(mm[3]);
    if (!usableYear(year, py, t)) continue;
    const month = monthIndex(mm[2]);
    if (mm[1].toLowerCase() === 'in' && (spoken(t, mm.index, mm[0].length) || (endOfMonthUtc(year, month) < pub && !FORWARD_FRAME.test(t)))) continue;
    if (mm[1].toLowerCase() === 'before') return found(mm, new Date(Date.UTC(year, month, 1) - 1000));
    return found(mm, endOfMonthUtc(year, month));
  }
  // "by April 15", "before March 3, 2027", "by 10 November 2026"
  const dateMatches = datePatterns.flatMap((re, order) => Array.from(t.matchAll(re), (match) => ({ match, order })))
    .sort((a, b) => a.match.index - b.match.index);
  for (const { match: dateMatch, order } of dateMatches) {
    m = dateMatch;
    const month = monthIndex(m[order === 0 ? 1 : 2]);
    const day = Number(m[order === 0 ? 2 : 1]);
    let year = m[3] ? Number(m[3]) : py;
    if (!m[3] && endOfDayUtc(year, month, day) < pub) year += 1;
    const at = endOfDayUtc(year, month, day);
    if (m[0].toLowerCase().startsWith('before')) at.setUTCDate(at.getUTCDate() - 1);
    if (/^on\b/i.test(m[0]) && (spoken(t, m.index, m[0].length) || at < pub)) continue;
    return found(m, at);
  }
  // "by next May"
  if ((m = t.match(new RegExp(`\\bby\\s+next\\s+${MONTH_RE}\\b`, 'i')))) {
    const month = monthIndex(m[1]);
    return found(m, endOfMonthUtc(month > pm ? py : py + 1, month));
  }
  // "in the fourth quarter of 2026", "by Q3 2027", "H1 2027"
  if ((m = t.match(/\b(?:by|before|in|during|through)\s+(?:the\s+)?(?:(first|second|third|fourth)\s+quarter\s+of\s+(\d{4})|(q[1-4]|h[12])\s*(\d{4}))\b/i))) {
    const ord = { first: 1, second: 2, third: 3, fourth: 4 }[(m[1] || '').toLowerCase()];
    const part = (m[3] || '').toLowerCase();
    const year = Number(m[2] || m[4]);
    if (usableYear(year, py, t)) {
      const endMonth = ord ? ord * 3 - 1 : (part.startsWith('q') ? Number(part[1]) * 3 - 1 : (part === 'h1' ? 5 : 11));
      return found(m, endOfMonthUtc(year, endMonth));
    }
  }
  // "late 2026 or early 2027", "early 2027", "mid-2028"
  if ((m = t.match(/\b(?:late|early|mid)[\s-]+(20\d{2})(?:\s+or\s+(?:late|early|mid)[\s-]+(20\d{2}))?/i)) && usableYear(Number(m[2] || m[1]), py, t)) {
    return found(m, endOfMonthUtc(Number(m[2] || m[1]), 11));
  }
  // "to end 2026 at $105", "at the end of the current year"
  if ((m = t.match(/\bend(?:ing)?\s+(20\d{2})\b/i)) && usableYear(Number(m[1]), py, t)) return found(m, endOfMonthUtc(Number(m[1]), 11));
  if ((m = t.match(/\b(?:at|by)\s+the\s+end\s+of\s+(?:the\s+)?(?:current|this|that)\s+year\b/i))) return found(m, endOfMonthUtc(py, 11));
  // "by year-end 2026", "before year-end"
  if ((m = t.match(/\b(?:by|before|at|through)\s+year[\s-]?end(?:\s+(20\d{2}))?\b/i))) {
    return found(m, endOfMonthUtc(m[1] ? Number(m[1]) : py, 11));
  }
  // "by the end of the year", "by the end of this year"
  if ((m = t.match(/\b(?:by|before|through)\s+(?:the\s+)?end\s+of\s+(?:the\s+|this\s+)year\b/i))) {
    return found(m, endOfMonthUtc(py, 11));
  }
  // "by the end of 2026, or 2027 at the latest", "by 2026 or 2027", "through 2027", "in 2027 and 2028"
  for (const ym of t.matchAll(/\b(by|before|until|through|in|during|within)\s+(?:the\s+)?(?:end\s+of\s+)?(?:(?:the\s+)?year\s+)?(20\d{2})(?:\s*(?:,\s*)?(?:or|and|to|-|–)\s*(20\d{2}))?(?:\s+at the latest)?\b/gi)) {
    const prep = ym[1].toLowerCase();
    const first = Number(ym[2]);
    const last = Number(ym[3] || ym[2]);
    if (!usableYear(Math.max(first, last), py, t)) continue;
    if (/\byear\s*$/i.test(t.slice(0, ym.index))) continue; // "a peak year in 2027" names a year, it is not a deadline
    if ((prep === 'in' || prep === 'during') && spoken(t, ym.index, ym[0].length)) continue;
    if (prep === 'before') return found(ym, new Date(Date.UTC(first, 0, 1) - 1000));
    return found(ym, endOfMonthUtc(Math.max(first, last), 11));
  }
  // "2026 will likely see", "2027 may see": a bare year as the subject of a forecast
  if ((m = t.match(/(?:^|[\s“"(])(20\d{2})\s+[“”"]?(?:will|may|might|could|should|is expected|is likely|looks set)\b/i)) && usableYear(Number(m[1]), py, t)) {
    return { text: m[1], at: endOfMonthUtc(Number(m[1]), 11) };
  }
  // "this week", "this week's meeting", "next week's election", "next month", "this quarter", "next year", "this year"
  if ((m = t.match(/\b(?:by\s+)?(this|next)\s+(week|month|quarter|year|decade)(?:['’]s)?\b/i)) && !SPEECH_BEFORE.test(t.slice(0, m.index))) {
    const which = m[1].toLowerCase();
    const unit = m[2].toLowerCase();
    let at = null;
    if (unit === 'year') at = endOfMonthUtc(py + (which === 'next' ? 1 : 0), 11);
    else if (unit === 'month') at = endOfMonthUtc(py, pm + (which === 'next' ? 1 : 0));
    else if (unit === 'week') at = addUnits(pub, which === 'next' ? 14 : 7, 'day');
    else if (unit === 'quarter') at = endOfMonthUtc(py, (Math.floor(pm / 3) + (which === 'next' ? 1 : 0)) * 3 + 2);
    return found(m, at);
  }
  // "within two to three years", "in the next few years", "over the next 10 years", "in roughly five years", "a decade from now", "six months from now"
  if ((m = t.match(new RegExp(`\\b(?:within|in|over|for|by)\\s+(?:the\\s+)?(?:next\\s+)?(?:roughly\\s+|about\\s+|around\\s+|at least\\s+)?(?:another\\s+)?${NUM}(?:\\s*(?:to|or|-|–)\\s*${NUM})?\\s+${UNIT}\\b(?!\\s+(?:ago|earlier|before|prior))`, 'i')))) {
    const n = numberOf(m[1]);
    const n2 = m[2] ? numberOf(m[2]) : null;
    const unit = m[3].toLowerCase();
    const lowerBound = /\bat least\b/i.test(m[0]);
    // A range or a lower bound is kept as stated words; only a single figure becomes a date.
    return found(m, !n2 && n && !lowerBound ? addUnits(pub, n, unit) : null);
  }
  if ((m = t.match(new RegExp(`\\b(?:in|over|within)\\s+the\\s+next\\s+(?:few|several|couple of|coming)\\s+${UNIT}\\b`, 'i')))) return found(m, null);
  if ((m = t.match(new RegExp(`\\b${NUM}(?:\\s*(?:to|or|-|–)\\s*${NUM})?\\s+${UNIT}\\s+(?:away|out|off)\\b`, 'i')))) {
    const n = numberOf(m[1]);
    return found(m, !m[2] && n ? addUnits(pub, n, m[3].toLowerCase()) : null);
  }
  if ((m = t.match(new RegExp(`[“"]((?:roughly\\s+|about\\s+)?${NUM}(?:\\s*(?:to|or|-|–)\\s*${NUM})?\\s+${UNIT})[,.”"]`, 'i')))) return { text: m[1], at: null };
  if ((m = t.match(new RegExp(`\\b(?:(a)|${NUM})\\s+${UNIT}\\s+from\\s+now\\b`, 'i')))) {
    const n = m[1] ? 1 : numberOf(m[2]);
    return found(m, n ? addUnits(pub, n, m[3].toLowerCase()) : null);
  }
  if ((m = t.match(/\bwithin\s+the\s+(next\s+)?(?:year|12 months)\b/i))) return found(m, m[1] ? addUnits(pub, 1, 'year') : null);
  if ((m = t.match(/\bin\s+a\s+few\s+thousand\s+days\b/i))) return found(m, null);
  if ((m = t.match(/\bat least another (?:year|month|decade)\b/i))) return found(m, null);
  if ((m = t.match(/\b(?:by|before|through)\s+the\s+end\s+of\s+the\s+decade\b/i))) return found(m, null);
  // "at the December FOMC meeting", "at its next meeting in December"
  if ((m = t.match(new RegExp(`\\b(?:at|in|by|before|for)\\s+(?:the\\s+)?${MONTH_RE}\\s+(?:FOMC\\s+|Fed\\s+|board\\s+)?(?:meeting|session|vote|report|release)\\b`, 'i')))) {
    const month = monthIndex(m[1]);
    return found(m, endOfMonthUtc(month >= pm ? py : py + 1, month));
  }
  if ((m = t.match(new RegExp(`\\b(?:meeting|session|vote|release|report|launch|event)\\s+in\\s+${MONTH_RE}\\b(?!\\s+\\d)`, 'i')))) {
    const month = monthIndex(m[1]);
    return found(m, endOfMonthUtc(month >= pm ? py : py + 1, month));
  }
  if ((m = t.match(new RegExp(`\\bin\\s+${MONTH_RE}\\b(?!\\s+(?:of\\s+)?\\d)(?!\\s*,?\\s+(?:he|she|they|the|[A-Z]\\w+)\\s+(?:said|wrote|told))`, 'i')))
    && /\b(will|expect(?:s|ed|ing)?|forecasts?|predict(?:s|ed)|anticipat\w+|hike|cut|to be|to average|set to|due)\b/i.test(t)
    && monthIndex(m[1]) >= pm) {
    return found(m, endOfMonthUtc(py, monthIndex(m[1])));
  }
  // "before 2029", "before year-end" are handled above; a lone "before 2027"
  if ((m = t.match(/\bbefore\s+(20\d{2})\b/i)) && usableYear(Number(m[1]), py, t)) {
    return found(m, new Date(Date.UTC(Number(m[1]), 0, 1) - 1000));
  }
  return { text: null, at: null };
}

export function conditionOf(text) {
  const m = String(text || '').match(/\b(?:if|unless|provided that|provided|as long as|assuming|while [a-z ]{0,30}(?:remains|continues|continue|remain))\b\s+([^.;!?”"]{3,160})/i);
  return m ? m[0].trim().replace(/[,\s]+$/, '') : null;
}

export function hedgesOf(text) {
  const original = ` ${String(text || '')} `;
  const t = original.toLowerCase();
  const found = [];
  for (const h of HEDGES) {
    // The month "May" is not the hedge "may": that one is read in lower case only.
    const source = h === 'may' ? original : t;
    const re = new RegExp(`[^A-Za-z-]${h.replace(/ /g, '\\s+')}[^A-Za-z-]`);
    if (re.test(source) && !found.some((f) => f.includes(h))) found.push(h);
  }
  return found;
}

export function looksLikePrediction(text) {
  return FUTURE.test(String(text || ''));
}

// ---------------------------------------------------------------------------
// Article-sentence detector.

const CHROME = /\b(sign up|sign in|subscribe|newsletter|cookies?|privacy polic|terms (?:of use|and conditions|&)|log ?in|password|your (?:account|email|inbox|feed|digest|browser)|email address|click here|follow (?:topics|us)|add [^.]{0,40} to your|advertis|sponsored|affiliate|all rights reserved|you(?:'|’)ll|you will|you can|if you (?:find|buy|are|want|would|need|like|use|have)|we (?:use|may earn|contacted)|may earn|not investment advice|forward-looking|not a broker|not advice|register an account|posts from this|will be added to)\b/i;

// A sentence whose future verb only reports what a law, order or schedule does.
const SCHEDULE = /\bI will (?:not )?(?:regard|defend|offer|say|argue|show|explain|note|return|come back|discuss|use|call|try|ask|give|mark)\b|\b(takes? effect|will take effect|goes? into effect|effective (?:on|from|january|february|march|april|may|june|july|august|september|october|november|december)|will be held|is scheduled|are scheduled|will focus only|will expand to|must (?:be|not|have|obtain|provide)|shall|may not|would (?:require|be required|bar|prohibit|allow|apply|cover)|could not (?:offer|be released)|would also (?:require|widen))\b/i;

const MARKET_PRICE = /\b(futures|fedwatch|polymarket|kalshi|bettors?|traders|prediction markets?)\b/i;

// Verb uses only: "predicts", "forecast to", "is forecast", "expects". The nouns
// ("a forecast", "predictions about", "public forecasts") are talk about
// forecasting, not a forecast.
const FORECAST_VERB = /\b(predict(?:s|ed|ing)\b|predicts?\s+(?:that|the|a|an|\d)|forecasts\s+(?:a|an|the|that|\d|\$|rates|growth|inflation|oil|brent)|forecasted|forecast\s+(?:to|that)|(?:is|are|was|were)\s+forecast\b|(?:(?:did|do|does|would|will|can|could)\s+not\s+)?expect(?:s|ed|ing)?(?!ations?)|anticipat(?:e|es|ed|ing)|projected|projects?\s+(?:that|a|an|the|\d|\$)|foresee\w*|(?:he|she|they|it|analysts?|respondents?|panelists?|forecasters|economists|strategists|we|i)\s+(?:also\s+|now\s+|still\s+)?(?:see|sees)\b|sees\s+(?:the|it|a|an|rates|oil|brent|growth|inflation|no|little|more|only|one|two|three|\d)|(?:is|are)\s+(?:seen|projected|tipped|predicted)\b|bound to|poised to|on course to|on track to|odds of|chance of|probability of|likelihood of|bets? that|reckon\w*|warn(?:s|ed)\s+(?:that|of)|believes? (?:that|ai|the|agi)|thinks? (?:that|ai|agi)|(?:\d+(?:\.\d+)?\s?%|one[\s-]in[\s-]\w+)\s+(?:chance|odds|probability))/i;

// A past expectation ("as expected", "was widely expected") is not a forecast.
const PAST_EXPECTATION = /\b(as expected|than[\s-]expected|was (?:widely )?expected|were (?:widely )?expected|had expected|unexpected|did what (?:markets|investors|traders) expected)\b|\bwidely expected they/i;

// "likely to", "most likely outcome", "a chance that": forecast shapes with no reporting verb.
const LIKELY_SHAPE = /\b(?:is|are|was|were)\s+(?:likely|unlikely|set|due|bound)\s+to\b|\bmost likely (?:outcome|scenario|result)\b|\b(?:a|the)\s+(?:["“]?[\w-]+["”]?\s+)?chance\s+(?:that|of)\b|\b(?:do|does|did)\s+not\s+see\b/i;

// A recap of what someone named as the date or horizon ("he named 2030 as his target").
const HORIZON_RECAP = /\b(?:named|cited|gave|put|placed|placing|moved|pushed|tightened|shortened|set)\b[^.]{0,50}\b(?:20[2-6]\d|(?:\w+) to (?:\w+) years)\b|\b(?:\w+) to (?:\w+) years (?:away|out)\b/i;

// Survey reports state forecasts as "outlook for ... next year" with no verb of forecasting.
const OUTLOOK = /\b(?:outlook|forecasts?|projections?)\s+(?:for|of)\b[^.]{0,80}\b(?:this year|next year|20[2-6]\d)\b/i;

const PAST_MARKER = /\b(was|were|had|did|said|told|wrote|announced|rose|fell|reported|filed|signed|released|launched|published|added)\b/i;

const FUTURE_AUX = /\b(will|won'?t|going to|gonna)\b/i;
const SOFT_MODAL = /\b(could|may|might|would)\b/i;
const INTENSIFIER = /\b(probably|likely|unlikely|perhaps|maybe|almost certainly|inevitabl\w+|surely)\b/i;

function hasFutureYear(text, py) {
  for (const m of text.matchAll(/\b(20\d{2})\b/g)) {
    const y = Number(m[1]);
    if (y >= py && y <= py + 60) return true;
  }
  return false;
}

// Does this sentence, lifted from an article, state a forecast (or a hedged
// forecast)? `attributed` says an attribution frame was found around it.
// Returns { predictive, strength, reasons }.
export function articleClaimCue(text, { attributed = false, publishedAt = new Date(), title = false, survey = false } = {}) {
  const t = String(text || '');
  const py = new Date(publishedAt).getUTCFullYear();
  const reasons = [];
  if (t.endsWith('?') || CHROME.test(t) || SCHEDULE.test(t)) return { predictive: false, strength: 0, reasons: ['excluded'] };
  if (MARKET_PRICE.test(t) && /\b(chance|odds|probability|priced?|pricing)\b/i.test(t)) return { predictive: false, strength: 0, reasons: ['market-implied'] };
  const probability = probabilityOf(t) != null;
  const forecastVerb = (FORECAST_VERB.test(t) || LIKELY_SHAPE.test(t) || probability || (attributed && HORIZON_RECAP.test(t)) || (survey && OUTLOOK.test(t))) && !PAST_EXPECTATION.test(t);
  const futureAux = FUTURE_AUX.test(t);
  const soft = SOFT_MODAL.test(t);
  const dl = deadlineOf(t, publishedAt);
  const deadline = dl.text !== null;
  // A date that has already passed is not a forecast horizon on its own.
  const futureDeadline = deadline && (dl.at ? dl.at > new Date(publishedAt) : /next|within|from now|away/i.test(dl.text));
  const futureYear = hasFutureYear(t, py);
  const intensifier = INTENSIFIER.test(t);
  const words = t.split(/\s+/).length;
  let strength = 0;
  if (forecastVerb) { strength += 3; reasons.push('forecast verb'); }
  if (futureAux) { strength += 2; reasons.push('will'); }
  if (soft && (deadline || futureYear || attributed || intensifier)) { strength += 1; reasons.push('hedged modal'); }
  if (deadline) { strength += 1; reasons.push('deadline'); }
  if (probabilityOf(t) != null) { strength += 1; reasons.push('probability'); }
  const second = /\byou(?:r|rs|rself)?\b/i.test(t) && !/[“"]/.test(t);
  const predictive = !second && (
    forecastVerb
    || (futureAux && words >= 7)
    || (soft && (deadline || futureYear || intensifier || (attributed && words >= 7)))
    || (attributed && intensifier && words >= 7)
    || (futureDeadline && words >= 8 && !PAST_MARKER.test(t))
  );
  // A headline must carry more than a topic word: a stated term, an auxiliary or a named source.
  const ok = title ? predictive && (deadline || futureAux || attributed) : predictive;
  return { predictive: ok, strength, reasons };
}

export function interpret(text, publishedAt) {
  const claim = stripForClaim(text);
  const deadline = deadlineOf(claim, publishedAt || new Date());
  return {
    claim,
    probability: probabilityOf(claim),
    deadlineText: deadline.text,
    proposedDeadlineAt: deadline.at,
    condition: conditionOf(claim),
    hedges: hedgesOf(claim),
    predictive: looksLikePrediction(claim),
  };
}

export function missingTerms(terms) {
  const missing = [];
  if (!terms.deadlineText) missing.push('deadline');
  if (terms.probability == null) missing.push('probability');
  return missing;
}
