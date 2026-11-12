const DROP = new Set('script style noscript template svg math iframe object head title textarea select button nav footer aside form'.split(' '));
const RAW = new Set('script style noscript iframe textarea title'.split(' '));
const VOID = new Set('area base br col embed hr img input link meta param source track wbr'.split(' '));
const BLOCK = new Set('p li dt dd blockquote pre figcaption h1 h2 h3 h4 h5 h6'.split(' '));
const BREAK = new Set([...BLOCK, ...'br hr div section main article ul ol dl table tr td th'.split(' ')]);
const P_END = new Set([...BREAK].filter((tag) => tag !== 'br').concat('address aside footer form header nav'.split(' ')));
const ENTITIES = {
  amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ',
  rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', mdash: '—', ndash: '–', hellip: '…',
  copy: '©', reg: '®', trade: '™', bull: '•', middot: '·', ensp: ' ', emsp: ' ', thinsp: ' ',
};
const GOV = /(?:An official website of the United States Government|Official websites use \.gov|Secure \.gov websites use HTTPS)\b[.!]?/gi;
const TAG_START = /<(\/?)([a-z][\w:-]*)/iy;
const MAX_HTML_CHARS = 4_000_000;
const MAX_TAGS = 25_000; // Existing 20,000-deep wrapper fixture remains supported.
const MAX_ATTRIBUTE_CHARS = 65_536;
const MAX_TITLE_CHARS = 8_192;
const MAX_BLOCK_TEXT_CHARS = 8_000_000;
const collapse = (text) => text.replace(/\s+/gu, ' ').trim();

function decode(text) {
  return text.replace(/&(?:#(x[0-9a-f]+|\d+);?|([a-z]+);)/gi, (entity, numeric, name) => {
    if (!numeric) return ENTITIES[name.toLowerCase()] ?? entity;
    const code = numeric[0].toLowerCase() === 'x' ? Number.parseInt(numeric.slice(1), 16) : Number(numeric);
    return code > 0 && code <= 0x10ffff && !(code >= 0xd800 && code <= 0xdfff) ? String.fromCodePoint(code) : '�';
  });
}

function attributes(source) {
  const attrs = Object.create(null);
  const pattern = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of source.matchAll(pattern)) {
    const name = match[1].toLowerCase();
    if (!(name in attrs)) attrs[name] = decode(match[2] ?? match[3] ?? match[4] ?? '');
  }
  return attrs;
}

// Only tag boundaries are scanned here. A quoted attribute can contain either angle bracket.
function* tokenize(source) {
  let at = 0; let raw = null;
  while (at < source.length) {
    if (raw) {
      let end = source.indexOf('</', at);
      while (end !== -1) {
        const after = end + raw.length + 2;
        if (source.slice(end + 2, after).toLowerCase() === raw &&
            (after === source.length || /[\s/>]/.test(source[after]))) break;
        end = source.indexOf('</', end + 2);
      }
      if (end === -1) end = source.length;
      yield { text: source.slice(at, end) };
      at = end; raw = null;
      if (at === source.length) break;
    }
    if (source[at] !== '<') {
      const end = source.indexOf('<', at);
      const next = end < 0 ? source.length : end;
      yield { text: source.slice(at, next) };
      at = next;
      continue;
    }
    if (source.startsWith('<!--', at)) {
      const end = source.indexOf('-->', at + 4);
      at = end < 0 ? source.length : end + 3;
      continue;
    }
    if (source.startsWith('<![CDATA[', at)) {
      const end = source.indexOf(']]>', at + 9);
      yield { text: source.slice(at + 9, end < 0 ? source.length : end) };
      at = end < 0 ? source.length : end + 3;
      continue;
    }
    TAG_START.lastIndex = at;
    const name = TAG_START.exec(source);
    if (!name && !'/!?'.includes(source[at + 1])) {
      let next = at + 1;
      while (source[next] === '<' && !source.startsWith('<!--', next) &&
          !source.startsWith('<![CDATA[', next)) {
        TAG_START.lastIndex = next;
        if (TAG_START.test(source) || '/!?'.includes(source[next + 1])) break;
        next += 1;
      }
      yield { text: source.slice(at, next) }; at = next; continue;
    }
    let end = at + (name?.[0].length || 2); let quote = null;
    for (; end < source.length; end += 1) {
      const char = source[end];
      if (quote) { if (char === quote) quote = null; }
      else if (char === '"' || char === "'") quote = char;
      else if (char === '>') break;
    }
    // A truncated tag/attribute is markup, never evidence text.
    if (end === source.length) break;
    if (name) {
      const tag = name[2].toLowerCase();
      const close = Boolean(name[1]);
      if (end - at - name[0].length > MAX_ATTRIBUTE_CHARS) throw new RangeError('HTML attribute budget exceeded');
      yield { tag, close, attrs: close ? null : attributes(source.slice(at + name[0].length, end)),
        selfClosing: /\/\s*$/.test(source.slice(at, end)) };
      if (!close && RAW.has(tag)) raw = tag;
    }
    at = end + 1;
  }
}

function stripStyleComments(style) {
  const parts = []; let at = 0;
  while (at < style.length) {
    const start = style.indexOf('/*', at);
    if (start < 0) { parts.push(style.slice(at)); break; }
    const end = style.indexOf('*/', start + 2);
    if (end < 0) { parts.push(style.slice(at)); break; }
    parts.push(style.slice(at, start));
    at = end + 2;
  }
  return parts.join('');
}

function hidden(attrs) {
  return 'hidden' in attrs || attrs['aria-hidden']?.trim().toLowerCase() === 'true'
    || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!\s*important\s*)?(?:;|$)/i
      .test(stripStyleComments(attrs.style || ''));
}

function parse(source) {
  const root = { tag: '', children: [], discard: false, metadataDiscard: false };
  const stack = [root]; const scopes = [[], [], [], []]; const titles = []; let ogTitle = null;
  const opened = new Map(); let tagCount = 0; let titleChars = 0;
  function lastOpen(tags) {
    let index = -1;
    for (const tag of tags) index = Math.max(index, opened.get(tag)?.at(-1) ?? -1);
    return index;
  }
  function closeOpen(tags, barriers = new Set(), implicit = false) {
    const index = lastOpen(tags);
    if (index < 1 || lastOpen(barriers) > index) return;
    const boundary = stack.at(-1).discardFrom;
    // Omitted or mismatched end tags must never escape a hidden wrapper.
    if (boundary != null && (index < boundary || (implicit && index === boundary))) return;
    while (stack.length > index) {
      const positions = opened.get(stack.pop().tag);
      positions.pop();
    }
  }
  for (const token of tokenize(source)) {
    if ('text' in token) {
      const top = stack.at(-1);
      if (!top.discard || top.title) {
        const value = decode(token.text);
        if (!top.discard) top.children.push(value);
        if (top.title) {
          titleChars += value.length;
          if (titleChars > MAX_TITLE_CHARS) throw new RangeError('HTML title budget exceeded');
          top.title.push(value);
        }
      }
      continue;
    }
    if (++tagCount > MAX_TAGS) throw new RangeError('HTML tag budget exceeded');
    const { tag, attrs } = token;
    if (token.close) { closeOpen(new Set([tag])); continue; }
    if (tag === 'body') closeOpen(new Set(['head']));
    if (P_END.has(tag)) closeOpen(new Set(['p']), new Set(['body', 'main', 'article', 'td', 'th', 'table']), true);
    if (tag === 'li') closeOpen(new Set(['li']), new Set(['ul', 'ol']), true);
    if (tag === 'dt' || tag === 'dd') closeOpen(new Set(['dt', 'dd']), new Set(['dl']), true);
    if (tag === 'tr') closeOpen(new Set(['tr']), new Set(['table', 'thead', 'tbody', 'tfoot']), true);
    if (tag === 'td' || tag === 'th') closeOpen(new Set(['td', 'th']), new Set(['tr', 'table']), true);
    if (/^h[1-6]$/.test(tag)) closeOpen(new Set(['h1', 'h2', 'h3', 'h4', 'h5', 'h6']), new Set(), true);
    const parent = stack.at(-1);
    const invisible = hidden(attrs);
    const node = { tag, children: [], discard: parent.discard || invisible || DROP.has(tag),
      metadataDiscard: parent.metadataDiscard || invisible || (DROP.has(tag) && tag !== 'head' && tag !== 'title') };
    node.discardFrom = parent.discardFrom ?? (node.discard ? stack.length : null);
    if (!node.discard) {
      parent.children.push(node);
      const rank = tag === 'main' ? 0 : tag === 'article' ? 1 : attrs.role?.trim().toLowerCase() === 'main' ? 2 : tag === 'body' ? 3 : -1;
      if (rank >= 0) scopes[rank].push(node);
    }
    if (!node.metadataDiscard) {
      if (tag === 'title') { node.title = []; titles.push(node.title); }
      if (tag === 'meta' && (attrs.property || attrs.name)?.toLowerCase() === 'og:title') {
        if ((attrs.content || '').length > MAX_TITLE_CHARS) throw new RangeError('HTML title budget exceeded');
        ogTitle ||= collapse(attrs.content || '') || null;
      }
    }
    // In HTML, '/>' only closes void elements or foreign SVG/MathML roots.
    if (!VOID.has(tag) && !(token.selfClosing && (tag === 'svg' || tag === 'math'))) {
      if (!opened.has(tag)) opened.set(tag, []);
      opened.get(tag).push(stack.length);
      stack.push(node);
    }
  }
  const title = titles.map((parts) => collapse(parts.join(''))).find(Boolean) || ogTitle;
  return { root, title, scope: new Set(scopes.find((nodes) => nodes.length) || [root]) };
}

// Flatten once. Block spans preserve nested-block semantics without revisiting descendants.
// The sum of candidate span lengths limits the repeated slicing needed by nested blocks.
function flattenAndCheck(root, scope) {
  const parts = []; const pending = [{ node: root, inside: scope.has(root), row: false, end: false }];
  let offset = 0; let total = 0;
  function append(part) { parts.push(part); offset += part.length; }
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string') { append(item); continue; }
    const { node } = item;
    if (!item.end) {
      node.flatStart = offset;
      if (BREAK.has(node.tag)) append(' ');
      pending.push({ ...item, end: true });
      const active = item.inside || scope.has(node);
      for (let i = node.children.length - 1; i >= 0; i -= 1) {
        const child = node.children[i];
        pending.push(typeof child === 'string' ? child : { node: child, inside: active,
          row: item.row || node.tag === 'tr', end: false });
      }
      continue;
    }
    if (BREAK.has(node.tag)) append(' ');
    node.flatEnd = offset;
    let length = node.flatEnd - node.flatStart;
    if (node.tag === 'tr') {
      const cells = node.children.filter((child) => child.tag === 'td' || child.tag === 'th').length;
      length += Math.max(0, cells - 1) * 3;
    }
    const active = item.inside || scope.has(node);
    if (active && (node.tag === 'tr' || (!item.row && BLOCK.has(node.tag)))) {
      total += length;
      if (total > MAX_BLOCK_TEXT_CHARS) throw new RangeError('HTML block text budget exceeded');
    }
  }
  return parts.join('');
}

function visibleBlocks(root, scope, flatText) {
  const blocks = []; const seen = new Set(); const pending = [{ node: root, inside: scope.has(root), row: false }];
  while (pending.length) {
    const { node, inside, row } = pending.pop();
    const active = inside || scope.has(node);
    if (active && (node.tag === 'tr' || (!row && BLOCK.has(node.tag)))) {
      const content = node.tag === 'tr'
        ? node.children.filter((child) => child.tag === 'td' || child.tag === 'th')
          .map((cell) => collapse(flatText.slice(cell.flatStart, cell.flatEnd))).join(' | ')
        : collapse(flatText.slice(node.flatStart, node.flatEnd));
      const text = collapse(content.replace(GOV, ' '));
      if ((text.match(/[\p{L}\p{N}]+/gu)?.length || 0) >= 2 && !seen.has(text)) {
        seen.add(text); blocks.push({ text, heading: /^h[1-6]$/.test(node.tag) });
      }
    }
    for (let i = node.children.length - 1; i >= 0; i -= 1) {
      const child = node.children[i];
      if (typeof child !== 'string') pending.push({ node: child, inside: active, row: row || node.tag === 'tr' });
    }
  }
  return blocks;
}

function terms(text) {
  return new Set((String(text || '').toLowerCase().match(/\p{L}+|\p{N}+(?:[./:-]\p{N}+)*/gu) || [])
    .filter((word) => /^\p{N}/u.test(word) || word.length >= 4));
}

function select(blocks, claim, budget) {
  const all = blocks.map(({ text }) => text);
  if (all.join('\n').length <= budget) return all;
  const selected = new Map();
  let runs = 0; let chars = 0;
  function insert(index, text) {
    runs += 1 - Number(selected.has(index - 1)) - Number(selected.has(index + 1));
    chars += text.length;
    selected.set(index, text);
  }
  function render() {
    const out = []; let previous = -1;
    for (const index of [...selected.keys()].sort((a, b) => a - b)) {
      if (index > previous + 1) out.push('…');
      out.push(selected.get(index)); previous = index;
    }
    if (selected.size && previous < blocks.length - 1) out.push('…');
    return out;
  }
  function keep(index) {
    const nextRuns = runs + 1 - Number(selected.has(index - 1)) - Number(selected.has(index + 1));
    const omissions = nextRuns - 1 + Number(index !== 0 && !selected.has(0))
      + Number(index !== blocks.length - 1 && !selected.has(blocks.length - 1));
    const length = chars + all[index].length + selected.size + 2 * omissions;
    if (length > budget) return false;
    insert(index, all[index]); return true;
  }
  const heading = blocks.findIndex((block) => block.heading);
  const anchors = heading >= 0 ? [heading] : [0, 1].filter((index) => index < blocks.length);
  for (const index of anchors) {
    if (!keep(index) && !selected.size) {
      // Even a single oversized block remains readable within the hard storage limit.
      const room = budget - (index > 0 ? 2 : 0) - (index < blocks.length - 1 ? 2 : 0);
      if (room > 0) insert(index, all[index].slice(0, room).trimEnd());
    }
  }
  const wanted = terms(claim);
  const ranked = blocks.map((block, index) => ({ index, score: [...terms(block.text)].filter((term) => wanted.has(term)).length }))
    .sort((a, b) => b.score - a.score || a.index - b.index);
  for (const { index } of ranked) if (!selected.has(index)) keep(index);
  return selected.size ? render() : all.slice(0, 1).map((text) => text.slice(0, budget));
}

/** Read visible evidence only. blocks contains the selected text lines, including omission markers. */
export function evidenceText(html, finalUrl, { claim, maxChars = 6000 } = {}) {
  const source = String(html || '');
  if (source.length > MAX_HTML_CHARS) throw new RangeError('HTML input budget exceeded');
  const { root, title, scope } = parse(source);
  const budget = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 6000;
  const flatText = budget ? flattenAndCheck(root, scope) : '';
  const blocks = budget ? select(visibleBlocks(root, scope, flatText), claim, budget) : [];
  return { title, text: blocks.join('\n'), blocks };
}
