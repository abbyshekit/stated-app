// INTEGRATION: Render only an already-authorized public projection; authorize every request before calling.
import { Resvg } from '@resvg/resvg-js';
import { fileURLToPath } from 'node:url';
import { formatTestNear } from './near-escrow.mjs';
import { unit } from './near-network.mjs';
import { displayBetStatus } from './bet-view.mjs';
import { timeLeft } from './marked.mjs';

const FONTS = [400, 600, 800].map(weight => fileURLToPath(new URL(`../public/fonts/Archivo-${weight}.ttf`, import.meta.url)));

const DARK = { ground: '#000000', ink: '#E7E9EA', dim: '#8B98A5', border: '#2F3336' };
const YELLOW = { ground: '#FFE45C', ink: '#0F1419', dim: '#3B381C', border: null };

const W = 1200;
const H = 630;
const LEFT = 64;
const RIGHT = 1136;
const TOP = 44;
const BASE = 580; // baseline of the last bottom line; its descenders end near y=586
const ASC = 0.878;
const DESC = 0.21;
const CAP = 0.686;
const XHEIGHT = 0.526;

// Advance widths (em) of printable ASCII from 0x20, read from the self-hosted Archivo TTFs.
const ADV = {
  400: '0.209,0.273,0.374,0.582,0.51,0.95,0.692,0.209,0.355,0.355,0.407,0.625,0.277,0.333,0.277,0.294,0.573,0.521,0.567,0.573,0.555,0.571,0.573,0.553,0.574,0.573,0.296,0.296,0.625,0.625,0.625,0.578,1.005,0.682,0.698,0.728,0.734,0.677,0.612,0.796,0.736,0.267,0.559,0.662,0.536,0.847,0.736,0.788,0.665,0.788,0.727,0.673,0.606,0.731,0.648,0.924,0.68,0.655,0.635,0.296,0.294,0.296,0.625,0.485,0.187,0.545,0.567,0.519,0.567,0.548,0.28,0.556,0.563,0.225,0.223,0.514,0.225,0.86,0.563,0.57,0.567,0.567,0.332,0.51,0.297,0.562,0.504,0.723,0.513,0.504,0.498,0.353,0.245,0.353,0.625',
  800: '0.189,0.314,0.473,0.625,0.579,0.984,0.816,0.263,0.374,0.374,0.407,0.649,0.318,0.333,0.318,0.302,0.625,0.625,0.625,0.625,0.626,0.625,0.625,0.625,0.625,0.625,0.334,0.334,0.649,0.649,0.649,0.612,1.005,0.746,0.745,0.752,0.755,0.699,0.641,0.815,0.787,0.329,0.63,0.77,0.623,0.914,0.787,0.81,0.698,0.81,0.75,0.697,0.675,0.783,0.729,0.979,0.736,0.732,0.682,0.366,0.302,0.366,0.649,0.534,0.257,0.616,0.633,0.612,0.633,0.619,0.352,0.632,0.629,0.288,0.286,0.61,0.288,0.937,0.629,0.635,0.633,0.633,0.407,0.579,0.385,0.629,0.574,0.859,0.612,0.574,0.535,0.391,0.265,0.391,0.649',
};
const TABLE = { 400: ADV[400].split(',').map(Number), 800: ADV[800].split(',').map(Number) };

// Remove XML control characters and direction overrides before measuring or rendering.
function clean(value, limit = 1000) {
  return Array.from(String(value ?? '').replace(/[\u0000-\u001f\u007f-\u009f‪-‮⁦-⁩]/gu, ' ').replace(/\s+/gu, ' ').trim()).slice(0, limit).join('');
}

function escape(value) {
  return String(value).replace(/[&<>"']/gu, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&apos;' })[ch]);
}

function advance(ch, weight) {
  const code = ch.codePointAt(0);
  if (code >= 32 && code < 127) return TABLE[weight >= 600 ? 800 : 400][code - 32];
  if (/\p{M}/u.test(ch)) return 0;
  if (code >= 0xa0 && code <= 0x24f) return 0.64; // Latin-1 and Latin Extended letters
  if (code >= 0x370 && code <= 0x52f) return 0.7; // Greek and Cyrillic
  if (code >= 0x2000 && code <= 0x206f) return 0.45; // general punctuation
  return 1.08; // CJK, emoji and anything unmeasured take a full em
}

// Estimated rendered width in px, with a 3% safety margin. Archivo is not kerned here.
export function textWidth(value, size, weight = 400, spacing = 0) {
  const chars = Array.from(value);
  return chars.reduce((sum, ch) => sum + advance(ch, weight) * size, 0) * 1.03 + chars.length * spacing;
}

function ellipsize(value, size, weight, maxWidth, spacing = 0) {
  if (textWidth(value, size, weight, spacing) <= maxWidth) return value;
  let chars = Array.from(value);
  while (chars.length && textWidth(`${chars.join('').trimEnd()}…`, size, weight, spacing) > maxWidth) chars = chars.slice(0, -1);
  return `${chars.join('').trimEnd()}…`;
}

// Greedy word wrap; a word wider than a line is broken by character.
function wrap(value, size, weight, spacing, maxWidth) {
  const lines = [];
  let line = '';
  const push = () => { if (line) lines.push(line); line = ''; };
  for (const word of value.split(' ')) {
    let rest = Array.from(word);
    while (rest.length) {
      const joined = line ? `${line} ${rest.join('')}` : rest.join('');
      if (textWidth(joined, size, weight, spacing) <= maxWidth) { line = joined; rest = []; break; }
      if (line) { push(); continue; }
      let n = rest.length;
      while (n > 1 && textWidth(rest.slice(0, n).join(''), size, weight, spacing) > maxWidth) n -= 1;
      lines.push(rest.slice(0, n).join(''));
      rest = rest.slice(n);
    }
  }
  push();
  return lines;
}

function text(x, y, content, size, fill, weight = 400, extra = '') {
  return `<text x="${x}" y="${y}" font-family="Archivo" font-size="${size}" font-weight="${weight}" fill="${fill}"${extra ? ` ${extra}` : ''}>${escape(content)}</text>`;
}

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

function validDate(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function displayDate(value) {
  const date = validDate(value);
  return date ? `${date.getUTCDate()} ${MONTHS[date.getUTCMonth()]} ${date.getUTCFullYear()}` : '';
}

// Whole UTC days from today to the deadline; '' when there is no usable deadline or it has passed.
function togo(deadline) {
  const text = timeLeft(deadline);
  return text === 'Past due' ? '' : text;
}

function stakeText(yocto) {
  try { return `${formatTestNear(String(yocto))} ${unit()} each`; } catch { return ''; }
}

function doubledStake(yocto) {
  try { return formatTestNear((BigInt(String(yocto)) * 2n).toString()); } catch { return ''; }
}

function initial(name) {
  const match = /[\p{L}\p{N}]/u.exec(clean(name, 200).replace(/^@+/u, ''));
  return match ? match[0].toUpperCase() : '';
}

function monogram(cx, cy, r, name, pal, size) {
  // On the yellow card a grey disc turns olive; a faint ink wash stays clean.
  let svg = pal === YELLOW ? `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${pal.ink}" fill-opacity="0.1"/>`
    : `<circle cx="${cx}" cy="${cy}" r="${r}" fill="${pal.dim}" fill-opacity="0.35"/>`;
  const letter = initial(name);
  if (letter) svg += text(cx, cy + size * CAP / 2, letter, size, pal.ink, 600, 'text-anchor="middle"');
  return svg;
}

const CLAIM_TIERS = [[40, 92, 1.12, -0.035], [80, 76, 1.14, -0.03], [160, 50, 1.2, -0.02], [Infinity, 36, 1.25, -0.01]];

// Pick the tier by length; step down a tier when the wrapped text would run into the bottom block.
function layoutClaim(claim, available) {
  const length = Array.from(claim).length;
  let first = CLAIM_TIERS.findIndex(([limit]) => length <= limit);
  for (let i = first; i < CLAIM_TIERS.length; i += 1) {
    const [, size, lh, em] = CLAIM_TIERS[i];
    const spacing = size * em;
    const lines = wrap(claim, size, 400, spacing, RIGHT - LEFT);
    const fits = Math.floor(available / (size * lh));
    if (lines.length <= fits) return { size, lh, spacing, lines };
    if (i === CLAIM_TIERS.length - 1) {
      const kept = lines.slice(0, Math.max(1, fits));
      kept[kept.length - 1] = ellipsize(`${kept[kept.length - 1]} ${lines.slice(kept.length).join(' ')}`, size, 400, RIGHT - LEFT, spacing);
      return { size, lh, spacing, lines: kept };
    }
  }
  return { size: 36, lh: 1.25, spacing: -0.36, lines: [] };
}

const PREDICTION_WORD = { ambiguous: 'Ambiguous', annulled: 'Annulled', disputed: 'Disputed' };
const SETTLED_WORD = { yes: 'Yes', no: 'No', void: 'Void' };

// Normalise a Bet, or the Bet summary on a Prediction card, into what the card shows.
function betFacts(source) {
  const status = clean(source.status, 40).toLowerCase();
  const creatorSide = source.creatorSide === 'yes' || source.creatorSide === 'no' ? source.creatorSide : '';
  const creator = clean(source.creatorName, 120) || 'Creator';
  const acceptor = clean(source.acceptorName, 120);
  const accept = validDate(source.acceptBy);
  const open = status === 'offered' && Boolean(source.funded) && Boolean(accept) && accept.getTime() > Date.now();
  const taken = Boolean(acceptor) || ['accepted', 'proposed', 'disputed', 'settled'].includes(status);
  const outcome = status === 'settled' && SETTLED_WORD[source.outcome] ? source.outcome : '';
  const returned = outcome === 'void' || status === 'refunded';
  return { status, creatorSide, creator, acceptor, accept, open, taken, outcome, returned, stake: source.stakeYocto };
}

function betWord(facts, source) {
  // A referee settles from the recorded Result, so the card says the Result. An agreement stays a settlement.
  if (facts.outcome && (facts.settledBy || source.settledBy) === 'referee' && ['yes', 'no'].includes(facts.outcome)) return facts.outcome === 'yes' ? 'Yes' : 'No';
  if (facts.outcome) return `Settled: ${SETTLED_WORD[facts.outcome]}`;
  if (facts.status === 'settled') return 'Settled';
  if (['accepted'].includes(facts.status)) return 'Both sides in';
  if (facts.open) return `Open until ${displayDate(facts.accept)}`;
  return displayBetStatus({ status: facts.status, funded: source.funded, accept_by: source.acceptBy });
}

// Stack lines upward from the bottom baseline; returns the svg and the top of the stack.
function stackLeft(items) {
  let baseline = BASE;
  let svg = '';
  let top = BASE;
  items.forEach((item, i) => {
    if (i > 0) baseline = top - 18;
    svg += text(LEFT, baseline, item.text, item.size, item.fill, item.weight, item.extra);
    top = baseline - CAP * item.size;
  });
  return { svg, top };
}

export function shareImageSvg(input) {
  const kind = input.kind === 'bet' ? 'bet' : 'prediction';
  const rawStatus = clean(input.status, 40).toLowerCase();
  // A Bet's card is yellow only when the referee settled it from a post that came true.
  const yellow = (kind === 'prediction' && rawStatus === 'yes')
    || (kind !== 'prediction' && input.settledBy === 'referee' && input.status === 'settled' && input.outcome === 'yes');
  const pal = yellow ? YELLOW : DARK;
  const strike = kind === 'prediction' && rawStatus === 'no';

  // Head
  let name;
  let handle = '';
  if (kind === 'prediction') {
    name = clean(input.authorName, 120) || clean(input.speaker, 120) || 'Source';
    const given = clean(input.handle, 80);
    if (given && given.replace(/^@/u, '').toLowerCase() !== name.replace(/^@/u, '').toLowerCase()) handle = given;
  } else if (clean(input.authorName, 120)) {
    // A Bet made on someone's post is headed by the post's author, as its page is.
    name = clean(input.authorName, 120);
    handle = clean(input.handle, 80);
  } else {
    name = clean(input.creatorName, 120) || 'Creator';
    handle = input.creatorSide === 'yes' ? 'bet yes' : input.creatorSide === 'no' ? 'bet no' : '';
  }
  const stated = textWidth('Stated', 32, 800);
  const nameMax = RIGHT - stated - 32 - (LEFT + 76 + 20);
  let svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}" viewBox="0 0 ${W} ${H}"><rect width="${W}" height="${H}" fill="${pal.ground}"/>`;
  if (pal.border) svg += `<rect x="0.5" y="0.5" width="${W - 1}" height="${H - 1}" fill="none" stroke="${pal.border}" stroke-width="1"/>`;
  svg += monogram(LEFT + 38, TOP + 38, 38, name, pal, 34);
  const nameLine = ellipsize(name, 30, 800, nameMax);
  if (handle) {
    svg += text(LEFT + 96, TOP + 33, nameLine, 30, pal.ink, 800);
    svg += text(LEFT + 96, TOP + 66, ellipsize(handle, 26, 400, nameMax), 26, pal.dim);
  } else svg += text(LEFT + 96, TOP + 38 + CAP * 30 / 2, nameLine, 30, pal.ink, 800);
  svg += text(RIGHT, TOP + 34, 'Stated', 32, pal.ink, 800, 'text-anchor="end"');

  // Bettors and the bottom blocks
  const betSource = kind === 'bet' ? input : (input.bet && typeof input.bet === 'object' ? input.bet : null);
  const bet = betSource ? betFacts(betSource) : null;
  const left = [];
  const dim = (t, size = 26) => ({ text: t, size, weight: 400, fill: pal.dim });
  const big = (t, size) => ({ text: t, size, weight: 800, fill: pal.ink });
  if (kind === 'prediction') {
    if (rawStatus === 'yes' || rawStatus === 'no') {
      const date = displayDate(input.date);
      let evidence = '';
      try {
        const url = new URL(clean(input.evidenceUrl, 2000));
        if (url.protocol === 'https:' && url.hostname) evidence = `Evidence: ${clean(url.hostname, 80)}`;
      } catch { /* No valid evidence URL means no evidence line. */ }
      const sub = [date, evidence].filter(Boolean).join('. ');
      left.push(big(rawStatus === 'yes' ? 'Yes' : 'No', 72));
      if (sub) left.push(dim(ellipsize(sub, 26, 400, 560)));
    } else if (PREDICTION_WORD[rawStatus]) left.push(big(PREDICTION_WORD[rawStatus], 48));
    else {
      const when = togo(input.deadline);
      if (when) left.push(big(when, 48));
      const stake = bet ? stakeText(bet.stake) : '';
      if (stake) left.push(dim(stake));
    }
  } else {
    const word = betWord(bet, input);
    left.push(big(word, word === 'Yes' || word === 'No' ? 72 : 48));
    const stake = stakeText(input.stakeYocto);
    if (stake) left.push(dim(stake));
    // How it was settled, said for what it was. A referee's ruling is not an agreement.
    if (bet.status === 'settled') {
      const how = bet.settledBy || input.settledBy;
      if (input.settlementVerified) left.push(dim('Settled on NEAR', 22));
      else if (how !== 'referee') left.push(dim(how === 'unanswered' ? 'The proposed result stood unanswered' : 'Agreed settlement; credit is not payment', 22));
    }
  }
  // The big word sits on top of its sub lines.
  const stacked = stackLeft(left.reverse());
  let blockTop = left.length ? stacked.top : BASE;
  let bottom = stacked.svg;

  if (bet) {
    const cy = BASE - 26 * CAP - 16 - 60;
    const names = { yes: '', no: '' };
    const mine = bet.creatorSide;
    const other = mine === 'yes' ? 'no' : mine === 'no' ? 'yes' : '';
    const takerName = bet.acceptor || (bet.taken ? 'Another bettor' : '');
    if (mine) names[mine] = bet.creator;
    if (other) names[other] = takerName;
    const pair = mine ? ['yes', 'no'] : [];
    const winner = bet.outcome === 'yes' || bet.outcome === 'no' ? bet.outcome : '';
    const winnerName = winner ? (winner === mine ? bet.creator : takerName || 'The other bettor') : '';
    if (pair.length) {
      const centers = { yes: RIGHT - 60 - 142, no: RIGHT - 60 };
      let faces = '';
      for (const side of pair) {
        const cx = centers[side];
        const taken = side === mine || bet.taken;
        if (taken) faces += monogram(cx, cy, 60, names[side], pal, 54);
        else {
          faces += `<circle cx="${cx}" cy="${cy}" r="58.5" fill="none" stroke="${pal.dim}" stroke-width="3"/>`;
          if (bet.open) faces += text(cx, cy + 30 * CAP / 2, 'You?', 30, pal.ink, 800, 'text-anchor="middle"');
        }
        if (winner === side) faces += `<circle cx="${cx}" cy="${cy}" r="66.5" fill="none" stroke="${pal.ink}" stroke-width="5"/>`;
      }
      const cap = (t) => ellipsize(t, 26, 400, 620);
      const short = (t) => ellipsize(t, 26, 400, 250);
      let caption = '';
      const opposite = other === 'yes' ? 'yes' : 'no';
      if (bet.returned) caption = 'Refund credited';
      else if (winner) {
        const total = doubledStake(bet.stake);
        caption = total ? `${short(winnerName)} wins ${total} ${unit()}` : `${short(winnerName)} wins`;
      } else if (bet.taken) caption = `${short(names.yes)} bet yes, ${short(names.no)} bet no`;
      else if (bet.open) caption = `${short(bet.creator)} bet ${mine}. Take ${opposite}?`;
      else caption = `${short(bet.creator)} bet ${mine}`;
      faces += text(RIGHT, BASE, cap(caption), 26, pal.dim, 400, 'text-anchor="end"');
      bottom += faces;
      blockTop = Math.min(blockTop, cy - (winner ? 66.5 : 60));
    }
  }
  svg += bottom;

  // The claim
  const claim = clean(input.claim, 2000) || 'Prediction';
  const claimTop = TOP + 76 + 28;
  const layout = layoutClaim(claim, blockTop - 14 - claimTop);
  const { size, lh, spacing } = layout;
  const used = layout.lines.length * size * lh;
  const gap = blockTop - (claimTop + used);
  const shift = gap > 100 ? Math.min(40, Math.round(gap - 100)) : 0;
  layout.lines.forEach((line, i) => {
    const top = claimTop + shift + i * size * lh;
    const baseline = Math.round((top + (size * lh - (ASC + DESC) * size) / 2 + ASC * size) * 10) / 10;
    svg += text(LEFT, baseline, line, size, pal.ink, 400, `letter-spacing="${Math.round(spacing * 100) / 100}"`);
    if (strike) {
      const y = Math.round((baseline - XHEIGHT * size / 2 - 2) * 10) / 10;
      const w = Math.min(RIGHT - LEFT, Math.ceil(textWidth(line, size, 400, spacing) * 0.965));
      svg += `<rect class="strike" x="${LEFT}" y="${y}" width="${w}" height="4" fill="${pal.dim}"/>`;
    }
  });
  return `${svg}</svg>`;
}

export function renderShareImage(input) {
  return new Resvg(shareImageSvg(input), { font: { fontFiles: FONTS, loadSystemFonts: false, defaultFontFamily: 'Archivo' } }).render().asPng();
}
