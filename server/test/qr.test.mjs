// The QR code of a payment address: what is drawn, and when nothing is.
// Whether a phone reads it back is checked outside this suite, by decoding the
// rendered code in Chrome (design/mainnet-20261110/README.md records that run).
import test from 'node:test';
import assert from 'node:assert/strict';
import { qrModules, qrSvg } from '../src/qr.mjs';

const EVM = '0x76b4c56085ED136a8744D52bE956396624a730E8';

test('a code is square, carries the three corner finders, and is the same every time', () => {
  const rows = qrModules(EVM);
  assert.equal(rows.length, 29, 'a 42-character address fits a version 3 code');
  assert.ok(rows.every((row) => row.length === 29));
  // A finder is a dark 7 by 7 ring around a dark 3 by 3 centre, in three corners and not the fourth.
  const finder = (r, c) => [0, 6].every((i) => rows[r + i].slice(c, c + 7).every(Boolean)) && rows[r + 3][c + 3] && !rows[r + 1][c + 1];
  assert.ok(finder(0, 0) && finder(0, 22) && finder(22, 0));
  assert.equal(finder(22, 22), false);
  assert.deepEqual(qrModules(EVM), rows);
  assert.notDeepEqual(qrModules(EVM.replace('E8', 'E9')), rows, 'one character changed is a different code');
});

test('longer addresses get a larger code, up to what a phone reads off a screen', () => {
  assert.equal(qrModules('bc1p5d7rjq7g6rdk2yhzks9smlaqtedr4dekq08ge8ztwac72sfr9rusxg3297').length, 33);
  assert.equal(qrModules('a'.repeat(213)).length, 57, 'version 10 at the limit');
  assert.equal(qrModules('a'.repeat(214)), null);
});

test('nothing is drawn for text that is empty, has spaces or is not plain ASCII', () => {
  for (const text of ['', null, undefined, 'two words', 'tab\tbed', 'naïve', '0x12\n34']) {
    assert.equal(qrModules(text), null);
    assert.equal(String(qrSvg(text)), '');
  }
});

test('the drawing is dark modules on a light ground with a four-module quiet zone, coloured by class', () => {
  const svg = String(qrSvg(EVM, { label: 'QR code of the Base address to pay' }));
  assert.match(svg, /^<svg class="qr" viewBox="0 0 37 37" role="img" aria-label="QR code of the Base address to pay" shape-rendering="crispEdges">/);
  assert.match(svg, /<rect class="qr-paper" width="37" height="37"\/>/);
  assert.match(svg, /<path class="qr-ink" d="M4 4h7v1h-7z/, 'the top-left finder starts four modules in');
  assert.doesNotMatch(svg, /style=|fill=|#[0-9a-fA-F]{3,6}/, 'no inline style or colour: the page forbids inline styles');
  // Every dark module is inside the quiet zone's border.
  for (const [, x, y, w] of svg.matchAll(/M(\d+) (\d+)h(\d+)v1/g)) {
    assert.ok(Number(x) >= 4 && Number(y) >= 4 && Number(x) + Number(w) <= 33 && Number(y) <= 32);
  }
});
