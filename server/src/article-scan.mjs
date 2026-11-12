// Bounded, single-pass HTML scanning. This is a text reader, not a browser DOM.
export const MAX_TAGS = 10_000;
export const MAX_METADATA = 64_000;
export const MAX_ATTRIBUTE = 4_000;
const RAW = new Set(['script', 'style', 'noscript', 'textarea', 'title']);
const VOID = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const isName = (char) => char != null && /[a-z0-9:_-]/i.test(char);
const isSpace = (char) => char != null && /\s/.test(char);

function attributes(source, at, end) {
  const attrs = Object.create(null);
  while (at < end) {
    while (at < end && (isSpace(source[at]) || source[at] === '/')) at += 1;
    const start = at;
    while (at < end && !isSpace(source[at]) && !'/=>'.includes(source[at])) at += 1;
    if (start === at) { at += 1; continue; }
    const name = source.slice(start, Math.min(at, start + MAX_ATTRIBUTE)).toLowerCase();
    while (at < end && isSpace(source[at])) at += 1;
    let value = '';
    if (source[at] === '=') {
      at += 1;
      while (at < end && isSpace(source[at])) at += 1;
      const quote = source[at] === '"' || source[at] === "'" ? source[at++] : null;
      const from = at;
      while (at < end && (quote ? source[at] !== quote : !isSpace(source[at]))) at += 1;
      value = source.slice(from, Math.min(at, from + MAX_ATTRIBUTE));
      if (quote && at < end) at += 1;
    }
    if (!(name in attrs)) attrs[name] = value;
  }
  return attrs;
}

export function scanHtml(source) {
  if (source.length > 4_000_000) throw new Error('That page is too large to read.');
  const tokens = []; const opened = new Map();
  let at = 0; let raw = null; let count = 0;
  while (at < source.length) {
    if (raw) {
      let end = source.indexOf('</', at);
      while (end >= 0) {
        const after = end + raw.length + 2;
        if (source.slice(end + 2, after).toLowerCase() === raw && /[\s/>]/.test(source[after] || '')) break;
        end = source.indexOf('</', end + 2);
      }
      at = end < 0 ? source.length : end;
      raw = null;
      if (at === source.length) break;
    }
    const start = source.indexOf('<', at);
    if (start < 0) break;
    if (source.startsWith('<!--', start)) {
      const end = source.indexOf('-->', start + 4);
      tokens.push({ start, end: end < 0 ? source.length : end + 3, tag: '', close: false, comment: true });
      at = tokens.at(-1).end;
      if (++count > MAX_TAGS) throw new Error('That page has too many HTML tags to read.');
      continue;
    }
    if (source.startsWith('<!', start) || source.startsWith('<?', start)) {
      const end = source.indexOf('>', start + 2);
      tokens.push({ start, end: end < 0 ? source.length : end + 1, tag: '', close: false, comment: true });
      at = tokens.at(-1).end;
      if (++count > MAX_TAGS) throw new Error('That page has too many HTML tags to read.');
      continue;
    }
    let nameAt = start + 1;
    const close = source[nameAt] === '/';
    if (close) nameAt += 1;
    if (!/[a-z]/i.test(source[nameAt] || '')) {
      at = start + 1;
      // A run of literal '<' characters has no tag boundaries until its last one.
      while (source[at] === '<' && source[at + 1] === '<') at += 1;
      continue;
    }
    let nameEnd = nameAt + 1;
    while (isName(source[nameEnd])) nameEnd += 1;
    let end = nameEnd; let quote = null;
    for (; end < source.length; end += 1) {
      const char = source[end];
      if (quote) { if (char === quote) quote = null; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    if (end === source.length) {
      tokens.push({ start, end, tag: '', close: false, comment: true });
      break;
    }
    if (++count > MAX_TAGS) throw new Error('That page has too many HTML tags to read.');
    if (end - nameEnd > MAX_METADATA) throw new Error('That page has too much HTML metadata to read.');
    const tag = source.slice(nameAt, nameEnd).toLowerCase();
    const token = { start, end: end + 1, tag, close, attrs: close ? null : attributes(source, nameEnd, end), pair: -1 };
    const index = tokens.push(token) - 1;
    if (close) {
      const positions = opened.get(tag);
      if (positions?.length) {
        const opening = positions.pop();
        tokens[opening].pair = index;
      }
    } else if (!VOID.has(tag)) {
      if (!opened.has(tag)) opened.set(tag, []);
      opened.get(tag).push(index);
      if (RAW.has(tag)) raw = tag;
    }
    at = end + 1;
  }
  return tokens;
}

export function stripElements(source, tags, { hidden = false, decodeAttribute = (value) => value } = {}) {
  const tokens = scanHtml(source); const chunks = []; let cursor = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.start < cursor || token.close) continue;
    const attrs = token.attrs;
    const invisible = hidden && attrs && ('hidden' in attrs || decodeAttribute(attrs['aria-hidden'] || '').trim().toLowerCase() === 'true');
    if (!token.comment && !tags.has(token.tag) && !invisible) continue;
    chunks.push(source.slice(cursor, token.start));
    cursor = token.comment || VOID.has(token.tag) ? token.end : token.pair >= 0 ? tokens[token.pair].end : source.length;
  }
  chunks.push(source.slice(cursor));
  return chunks.join(' ');
}

export function elementRanges(source, tags) {
  const tokens = scanHtml(source); const ranges = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const token = tokens[i];
    if (token.close || !tags.has(token.tag) || token.pair < 0) continue;
    const close = tokens[token.pair];
    ranges.push({ ...token, contentEnd: close.start, outerEnd: close.end });
    // Selected elements are disjoint. No subtree is rescanned for every ancestor.
    i = token.pair;
  }
  return ranges;
}

export function plainMarkup(source, breaks = new Set()) {
  const chunks = []; let cursor = 0;
  for (const token of scanHtml(source)) {
    chunks.push(source.slice(cursor, token.start));
    chunks.push(breaks.has(token.tag) && (token.close || token.tag === 'br') ? '\n' : ' ');
    cursor = token.end;
  }
  chunks.push(source.slice(cursor));
  return chunks.join('');
}
