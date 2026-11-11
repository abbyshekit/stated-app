// A QR code of a short piece of text (a payment address), drawn on the server
// as SVG. Dark modules on a light ground with the standard four-module quiet
// zone, whatever the page's theme: that is the form every scanner reads.
// The code holds the text exactly as given and nothing else.
// Uses qrcode-generator 1.5.2 (MIT) for the encoding.
import qrcode from 'qrcode-generator';
import { html } from './html.mjs';

// What a version 10 code holds in byte mode at error correction level M. Longer than this and the
// modules get too small to read comfortably off a phone screen, so no code is drawn.
const MAX_BYTES = 213;
const QUIET = 4;

/** The code's modules as rows of booleans, or null when the text is empty, not plain ASCII or too long. */
export function qrModules(text) {
  const value = String(text ?? '');
  if (!value || value.length > MAX_BYTES || !/^[\x21-\x7e]+$/.test(value)) return null;
  const code = qrcode(0, 'M');
  code.addData(value, 'Byte');
  code.make();
  const n = code.getModuleCount();
  return Array.from({ length: n }, (_, r) => Array.from({ length: n }, (_, c) => code.isDark(r, c)));
}

/** The code as an SVG element, or '' when there is none to draw. */
export function qrSvg(text, { label = 'QR code' } = {}) {
  const rows = qrModules(text);
  if (!rows) return '';
  const size = rows.length + QUIET * 2;
  let path = '';
  rows.forEach((row, r) => {
    // A run of dark modules in a row is one rectangle.
    for (let c = 0; c < row.length; c += 1) {
      if (!row[c]) continue;
      let end = c;
      while (end < row.length && row[end]) end += 1;
      path += `M${c + QUIET} ${r + QUIET}h${end - c}v1h-${end - c}z`;
      c = end;
    }
  });
  return html`<svg class="qr" viewBox="0 0 ${size} ${size}" role="img" aria-label="${label}" shape-rendering="crispEdges"><rect class="qr-paper" width="${size}" height="${size}"/><path class="qr-ink" d="${path}"/></svg>`;
}
