// INTEGRATION: Real PNG rendering, bounded public card composition and XML escaping.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { renderShareImage, shareImageSvg, textWidth } from '../src/share-image.mjs';

const STAKE = '100000000000000000000000';
const DAY = 86400000;
const unescape = (s) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&apos;/g, "'").replace(/&amp;/g, '&');

// Every <text> with its position, size, weight and estimated right edge.
function texts(svg) {
  return [...svg.matchAll(/<text x="([\d.]+)" y="([\d.]+)"[^>]*font-size="([\d.]+)" font-weight="(\d+)"[^>]*?(?: letter-spacing="(-?[\d.]+)")?(?: text-anchor="(\w+)")?>([^<]*)<\/text>/gu)].map((m) => {
    const [, x, y, size, weight, spacing, anchor, body] = m;
    const content = unescape(body);
    const w = textWidth(content, Number(size), Number(weight), Number(spacing || 0));
    const left = anchor === 'end' ? Number(x) - w : anchor === 'middle' ? Number(x) - w / 2 : Number(x);
    return { x: Number(x), y: Number(y), size: Number(size), weight: Number(weight), content, left, right: left + w };
  });
}

const open = (extra = {}) => ({ kind: 'prediction', status: 'open', claim: 'A synthetic prediction', speaker: '@source', ...extra });

test('agreed void renders as settlement rather than a factual Prediction Result', () => {
  const svg = shareImageSvg({ kind: 'bet', status: 'settled', outcome: 'void', claim: 'Synthetic Bet',
    creatorName: '@creator', acceptorName: '@other', creatorSide: 'no', stakeYocto: STAKE });
  assert.match(svg, />Settled: Void</);
  assert.doesNotMatch(svg, /Verification needed|Result Yes|Result No|Settlement agreed/);
  assert.match(svg, /Agreed settlement; credit is not payment/);
  assert.match(svg, /Refund credited/);
  assert.doesNotMatch(svg, /Stakes returned/);
});

test('untrusted card text is escaped and long content remains bounded in a real PNG', () => {
  const input = { kind: 'prediction', status: 'yes', claim: '<script>alert("x")</script> ' + 'W'.repeat(3000),
    speaker: '<image href="https://private.example/image">', publicUrl: 'https://example.org/prediction' };
  const svg = shareImageSvg(input);
  assert.doesNotMatch(svg, /<script|<image|<[^>]+href=/);
  assert.match(svg, /&lt;script&gt;/);
  assert.match(svg, /…/);
  assert.match(svg, /font-size="72"[^>]*>Yes<\/text>/);
  const png = renderShareImage(input);
  assert.equal(png.subarray(1, 4).toString(), 'PNG');
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
});

test('hostile names, handles, claims and URLs are neutralised', () => {
  const svg = shareImageSvg({ kind: 'prediction', status: 'yes', claim: 'Safe <script>x</script>\u0000\u0007‮ reversed⁦',
    authorName: '<b onload="x()">Eve</b>&‮evil', handle: '@h"><svg onload=1>', speaker: 'ignored',
    evidenceUrl: 'https://exa\u0000mple.org/<script>', date: '2026-09-28T00:00:00Z',
    bet: { creatorName: '<script>', creatorSide: 'yes', acceptorName: '"><img>', stakeYocto: STAKE, status: 'accepted', funded: true } });
  assert.doesNotMatch(svg, /<script|<b |<img|<svg onload|[\u0000-\u0008‪-‮⁦-⁩]/);
  assert.match(svg, /&lt;script&gt;/);
  assert.equal((svg.match(/<svg/g) || []).length, 1);
  assert.equal(renderShareImage({ kind: 'bet', status: 'offered', claim: '‮<x>', creatorName: '<y>', creatorSide: 'no' }).subarray(1, 4).toString(), 'PNG');
});

test('a Bet names its creator as the bettor without attributing the source prediction to them', () => {
  const svg = shareImageSvg({ kind: 'bet', status: 'offered', claim: 'A source-linked proposition',
    creatorName: '@bettor', creatorSide: 'no', funded: true,
    acceptBy: new Date(Date.now() + 60000).toISOString(), stakeYocto: STAKE });
  const t = texts(svg);
  assert.ok(t.some((x) => x.content === '@bettor' && x.size === 30));
  assert.ok(t.some((x) => x.content === 'bet no' && x.size === 26));
  assert.ok(t.some((x) => /^@bettor bet no\. Take yes\?$/.test(x.content)));
  assert.doesNotMatch(svg, /Bet proposed by|by @bettor|said/);
});

test('a recorded Prediction Result shows its public evidence and date without settlement language', () => {
  const svg = shareImageSvg({ kind: 'prediction', status: 'no', claim: 'Synthetic resolved prediction',
    speaker: '@source', evidenceUrl: 'https://example.org/result?ignored=private-looking-text',
    date: '2026-11-09T00:00:00Z' });
  assert.match(svg, /font-size="72"[^>]*>No<\/text>/);
  assert.match(svg, />9 Nov 2026\. Evidence: example\.org</);
  assert.doesNotMatch(svg, /ignored=|Settle|credit is not payment/);
});

test('no evidence line without a valid https evidence URL', () => {
  for (const evidenceUrl of [undefined, '', 'http://example.org/x', 'javascript:alert(1)', 'not a url']) {
    const svg = shareImageSvg({ kind: 'prediction', status: 'yes', claim: 'c', speaker: 's', evidenceUrl, date: '2026-11-09T00:00:00Z' });
    assert.doesNotMatch(svg, /Evidence/, String(evidenceUrl));
  }
});

test('only a Prediction whose Result is Yes has the yellow ground', () => {
  const yellow = /#FFE45C/i;
  const cards = [
    shareImageSvg(open()), shareImageSvg(open({ status: 'no' })), shareImageSvg(open({ status: 'ambiguous' })),
    shareImageSvg(open({ status: 'annulled' })), shareImageSvg(open({ status: 'disputed' })),
    shareImageSvg({ kind: 'bet', status: 'settled', outcome: 'yes', claim: 'c', creatorName: '@a', acceptorName: '@b', creatorSide: 'yes', stakeYocto: STAKE }),
    shareImageSvg({ kind: 'bet', status: 'offered', claim: 'c', creatorName: '@a', creatorSide: 'no', funded: true, acceptBy: new Date(Date.now() + DAY).toISOString(), stakeYocto: STAKE }),
  ];
  cards.forEach((svg) => assert.doesNotMatch(svg, yellow));
  const yes = shareImageSvg(open({ status: 'yes' }));
  assert.match(yes, /<rect width="1200" height="630" fill="#FFE45C"\/>/i);
  assert.doesNotMatch(yes, /#2F3336/i, 'the yellow card has no border');
  assert.match(cards[0], /<rect width="1200" height="630" fill="#000000"\/>/);
  assert.match(cards[0], /stroke="#2F3336"/);
  assert.doesNotMatch(cards.join(''), /#E3001B|#ff0000/i, 'no red, disputed included');
});

test('no card carries the old certificate furniture', () => {
  const inputs = [open(), open({ status: 'yes' }), open({ status: 'no' }), open({ status: 'disputed' }),
    { kind: 'bet', status: 'accepted', claim: 'c', creatorName: '@a', acceptorName: '@b', creatorSide: 'yes', stakeYocto: STAKE, funded: true },
    { kind: 'bet', status: 'settled', outcome: 'no', claim: 'c', creatorName: '@a', acceptorName: '@b', creatorSide: 'yes', stakeYocto: STAKE }];
  for (const input of inputs) {
    const svg = shareImageSvg({ ...input, id: '123456789', publicUrl: 'https://example.org/x' });
    assert.doesNotMatch(svg, /stroke-dasharray/);
    assert.doesNotMatch(svg, /STATED {2}\//);
    assert.doesNotMatch(svg, />(FOR|AGAINST|PREDICTION|BET|RESULT|PUBLIC RECORD)</);
    assert.doesNotMatch(svg, /123456789|example\.org/, 'no serial number or URL');
    assert.ok(texts(svg).some((t) => t.content === 'Stated' && t.size === 32 && t.weight === 800 && t.x === 1136));
  }
});

test('a full 280-character claim fits whole inside the margins', () => {
  const claim = 'Calling it now, and I will not be moved on this: by the last trading day of December 2027 the ten-year Treasury yield closes below 3.25%, the dollar index is under 95, and at least two G7 central banks have restarted asset purchases. Bookmark this and come back.'.padEnd(280, '!');
  assert.equal(claim.length, 280);
  const svg = shareImageSvg(open({ claim, authorName: 'Aleksandra Wiśniewska-Kowalczykowski', handle: '@aleksandra_wk',
    deadline: new Date(Date.now() + 400 * DAY).toISOString(),
    bet: { creatorName: 'Dana', creatorSide: 'no', stakeYocto: STAKE, status: 'offered', funded: true, acceptBy: new Date(Date.now() + DAY).toISOString() } }));
  const t = texts(svg);
  assert.ok(t.length > 8);
  for (const item of t) {
    assert.ok(item.left >= 64 - 0.5, `${item.content} starts at ${item.left}`);
    assert.ok(item.right <= 1136 + 0.5, `${item.content} ends at ${item.right}`);
    assert.ok(item.y <= 586 && item.y >= 44);
  }
  const lines = t.filter((x) => x.size === 36 && x.weight === 400);
  assert.equal(unescape(lines.map((x) => x.content).join(' ')), claim, 'nothing truncated');
  assert.doesNotMatch(svg, /…/);
});

test('claim size follows length and a 34-character claim at 92px wraps to two lines', () => {
  const claim = 'Nightjar 1.8 ships before October.';
  assert.equal(claim.length, 34);
  const lines = texts(shareImageSvg(open({ claim }))).filter((x) => x.size === 92);
  assert.equal(lines.length, 2);
  lines.forEach((l) => assert.ok(l.right <= 1136));
  const size = (n) => texts(shareImageSvg(open({ claim: 'word '.repeat(n).trim().slice(0, n) }))).find((x) => x.weight === 400 && x.size > 30).size;
  assert.equal(size(40), 92);
  assert.equal(size(80) <= 76, true);
  assert.equal(size(160) <= 50, true);
  assert.equal(size(300), 36);
});

test('a No card strikes through every line of the words, and no other card does', () => {
  const claim = 'The Fed cuts twice before November, and then again before the new year begins.';
  const no = shareImageSvg(open({ status: 'no', claim }));
  const lines = texts(no).filter((x) => x.weight === 400 && x.size > 40);
  assert.ok(lines.length >= 2);
  const strikes = [...no.matchAll(/<rect class="strike" x="64" y="([\d.]+)" width="([\d.]+)" height="4" fill="#8B98A5"\/>/g)];
  assert.equal(strikes.length, lines.length);
  strikes.forEach((s, i) => {
    assert.ok(Number(s[1]) < lines[i].y && Number(s[1]) > lines[i].y - lines[i].size * 0.5, 'drawn through the x-height');
    assert.ok(64 + Number(s[2]) <= 1136);
  });
  assert.match(no, /fill="#E7E9EA"/);
  for (const status of ['yes', 'open', 'ambiguous']) assert.doesNotMatch(shareImageSvg(open({ status })), /class="strike"/);
});

test('an open Prediction with a deadline counts down, and the slot is empty without one', () => {
  // Counted from the start of the UTC day, so the hour the test runs at cannot push a deadline into the next day.
  const days = (n) => shareImageSvg(open({ deadline: new Date(Math.floor(Date.now() / DAY) * DAY + n * DAY + 3600000).toISOString() }));
  assert.match(days(12), />12 days to go</);
  assert.match(days(1), />1 day to go</);
  assert.match(days(0), />Due today</);
  assert.match(days(400), />13 months to go</);
  assert.match(days(12), /font-size="48" font-weight="800"/);
  assert.doesNotMatch(shareImageSvg(open()), /to go|Due today/);
  assert.doesNotMatch(shareImageSvg(open({ deadline: 'garbage' })), /to go|Due today/);
  const withBet = shareImageSvg(open({ deadline: new Date(Date.now() + 5 * DAY).toISOString(),
    bet: { creatorName: '@priya', creatorSide: 'no', stakeYocto: STAKE, status: 'offered', funded: true, acceptBy: new Date(Date.now() + DAY).toISOString() } }));
  assert.match(withBet, />0\.1 test NEAR each</);
  assert.match(withBet, />You\?</);
  assert.match(withBet, />@priya bet no\. Take yes\?</);
});

test('a settled Bet says Settled, names the winner, rings one circle and is never yellow', () => {
  for (const outcome of ['yes', 'no']) {
    const svg = shareImageSvg({ kind: 'bet', status: 'settled', outcome, claim: 'c', creatorName: '@a', acceptorName: '@b',
      creatorSide: 'yes', stakeYocto: STAKE, funded: true });
    assert.match(svg, new RegExp(`>Settled: ${outcome === 'yes' ? 'Yes' : 'No'}<`));
    assert.doesNotMatch(svg, />(Yes|No)<\/text>|Result|#FFE45C/i);
    assert.match(svg, new RegExp(`>${outcome === 'yes' ? '@a' : '@b'} wins 0\\.2 test NEAR<`));
    assert.equal((svg.match(/r="66.5"/g) || []).length, 1);
    assert.match(svg, /Agreed settlement; credit is not payment/);
    texts(svg).forEach((t) => assert.ok(t.right <= 1136 + 0.5));
  }
});

test('Bet status words and unknown participants', () => {
  const soon = new Date(Date.now() + 3 * DAY).toISOString();
  const base = { kind: 'bet', claim: 'c', creatorName: '@a', creatorSide: 'yes', stakeYocto: STAKE };
  assert.match(shareImageSvg({ ...base, status: 'offered', funded: true, acceptBy: soon }), />Open until \d{1,2} \w{3} \d{4}</);
  assert.match(shareImageSvg({ ...base, status: 'offered', funded: false, acceptBy: soon }), />Not funded</);
  assert.match(shareImageSvg({ ...base, status: 'accepted', funded: true, acceptorName: '@b' }), />Both sides in</);
  assert.match(shareImageSvg({ ...base, status: 'accepted', funded: true, acceptorName: '@b' }), />@a bet yes, @b bet no</);
  assert.match(shareImageSvg({ ...base, status: 'offered', funded: true, acceptBy: new Date(Date.now() - DAY).toISOString() }), />Offer expired</);
  assert.match(shareImageSvg({ ...base, status: 'refunded', funded: true }), />Refund credited</);
  const unknown = shareImageSvg({ ...base, status: 'accepted', funded: true });
  assert.match(unknown, />@a bet yes, Another bettor bet no</);
  assert.doesNotMatch(unknown, />You\?</);
});
