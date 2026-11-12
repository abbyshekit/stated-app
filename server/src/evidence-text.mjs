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
      const closing = new RegExp(`</${raw}(?=[\\s/>])`, 'gi');
      closing.lastIndex = at;
      const end = closing.exec(source)?.index ?? source.length;
      yield { text: decode(source.slice(at, end)) };
      at = end; raw = null;
      if (at === source.length) break;
    }
    if (source[at] !== '<') {
      const end = source.indexOf('<', at);
      const next = end < 0 ? source.length : end;
      yield { text: decode(source.slice(at, next)) };
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
      yield { text: decode(source.slice(at + 9, end < 0 ? source.length : end)) };
      at = end < 0 ? source.length : end + 3;
      continue;
    }
    const name = /^<(\/?)([a-z][\w:-]*)/i.exec(source.slice(at));
    if (!name && !/^<[/!?]/.test(source.slice(at, at + 2))) {
      yield { text: '<' }; at += 1; continue;
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
      yield { tag, close, attrs: close ? null : attributes(source.slice(at + name[0].length, end)),
        selfClosing: /\/\s*$/.test(source.slice(at, end)) };
      if (!close && RAW.has(tag)) raw = tag;
    }
    at = end + 1;
  }
}

function hidden(attrs) {
  return 'hidden' in attrs || attrs['aria-hidden']?.trim().toLowerCase() === 'true'
    || /(?:^|;)\s*(?:display\s*:\s*none|visibility\s*:\s*hidden)\s*(?:!\s*important\s*)?(?:;|$)/i
      .test((attrs.style || '').replace(/\/\*[\s\S]*?\*\//g, ''));
}

function parse(source) {
  const root = { tag: '', children: [], discard: false, metadataDiscard: false };
  const stack = [root]; const scopes = [[], [], [], []]; const titles = []; let ogTitle = null;
  const opened = new Map();
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
      if (!top.discard) top.children.push(token.text);
      if (top.title) top.title.push(token.text);
      continue;
    }
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
      if (tag === 'meta' && (attrs.property || attrs.name)?.toLowerCase() === 'og:title') ogTitle ||= collapse(attrs.content || '') || null;
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

function textIn(node) {
  const parts = []; const pending = [node];
  while (pending.length) {
    const item = pending.pop();
    if (typeof item === 'string') { parts.push(item); continue; }
    if (BREAK.has(item.tag)) parts.push(' ');
    if (BREAK.has(item.tag)) pending.push(' ');
    for (let i = item.children.length - 1; i >= 0; i -= 1) pending.push(item.children[i]);
  }
  return collapse(parts.join(''));
}

function visibleBlocks(root, scope) {
  const blocks = []; const seen = new Set(); const pending = [{ node: root, inside: scope.has(root), row: false }];
  while (pending.length) {
    const { node, inside, row } = pending.pop();
    const active = inside || scope.has(node);
    if (active && (node.tag === 'tr' || (!row && BLOCK.has(node.tag)))) {
      const content = node.tag === 'tr'
        ? node.children.filter((child) => child.tag === 'td' || child.tag === 'th').map(textIn).join(' | ')
        : textIn(node);
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
    selected.set(index, all[index]);
    if (render().join('\n').length <= budget) return true;
    selected.delete(index); return false;
  }
  const heading = blocks.findIndex((block) => block.heading);
  const anchors = heading >= 0 ? [heading] : [0, 1].filter((index) => index < blocks.length);
  for (const index of anchors) {
    if (!keep(index) && !selected.size) {
      // Even a single oversized block remains readable within the hard storage limit.
      const room = budget - (index > 0 ? 2 : 0) - (index < blocks.length - 1 ? 2 : 0);
      if (room > 0) selected.set(index, all[index].slice(0, room).trimEnd());
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
  const { root, title, scope } = parse(String(html || ''));
  const budget = Number.isFinite(maxChars) ? Math.max(0, Math.floor(maxChars)) : 6000;
  const blocks = budget ? select(visibleBlocks(root, scope), claim, budget) : [];
  return { title, text: blocks.join('\n'), blocks };
}
