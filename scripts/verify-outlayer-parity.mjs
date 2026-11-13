// Evaluates pure functions from the actual server source in a context with no
// network, filesystem, process or module loader. The Rust path is an explicit mock.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { spawnSync } from 'node:child_process';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';
import { evidenceText } from '../server/src/evidence-text.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const source = readFileSync(new URL('../server/src/enclave-ruling.mjs', import.meta.url), 'utf8');
const canonicalJson = v => Array.isArray(v) ? `[${v.map(canonicalJson).join(',')}]`
  : v && typeof v === 'object' ? `{${Object.keys(v).sort().map(k => `${JSON.stringify(k)}:${canonicalJson(v[k])}`).join(',')}}` : JSON.stringify(v);
const context = vm.createContext({ Buffer, isDeepStrictEqual, canonicalJson,
  sha256: bytes => createHash('sha256').update(bytes).digest('hex') });
vm.runInContext(source.replace(/^import .*;\n/gm, '').replace(/^export /gm, '')
  + '\nglobalThis.rules = {PLAN_PROMPT,VERDICT_PROMPT,makeMaterial,materialHash,verdictInput,checkPlan,windowSegments,decide,submittedEvidence};', context, { timeout: 2000 });
const rules = context.rules;
const models = ['Qwen/Qwen3.8-27B', 'deepseek-ai/DeepSeek-V4.1-Flash-1017', 'z-ai/glm-5.3-flash'];
const material = { bet_id: '3668aa04-7009-4b85-b19d-debfabebbf96', claim: 'NEAR above US$3.30 on Coinbase',
  made_at: '2026-11-12T18:00:00.000Z', deadline: '2026-11-12T19:15:00.000Z',
  post_url: 'https://x.com/ChainAbstracted/status/2120000000000000000',
  evidence: { kind: 'coinbase', product: 'NEAR-USD', window: { kind: 'moment', at: '2026-11-12T19:15:00.000Z' } } };
const input = { material, terms_hash: 'b'.repeat(64), now: '2026-11-12T19:17:00.000Z', attempt: 1 };
const decisions = [];
for (const a of ['yes', 'no', 'unclear']) for (const b of ['yes', 'no', 'unclear']) for (const c of ['yes', 'no', 'unclear']) {
  for (const confidence of [0, 0.79, 0.799999999, 0.8, 0.81, 1]) {
    decisions.push([a,b,c].map((outcome,i) => ({ model: models[i], outcome, confidence })));
  }
}
const fixture = { input, candles: ['[[1794510900,3.40,3.45,3.4206,3.43,100]]'], decisions };
const rust = spawnSync('cargo', ['run', '--offline', '--locked', '--quiet', '--manifest-path', 'outlayer/stated-jury/Cargo.toml', '--example', 'parity'],
  { cwd: root, input: JSON.stringify(fixture), encoding: 'utf8', maxBuffer: 8_000_000 });
assert.equal(rust.status, 0, rust.stderr);
const output = JSON.parse(rust.stdout);
assert.equal(output.plan_prompt, rules.PLAN_PROMPT);
assert.equal(output.verdict_prompt, rules.VERDICT_PROMPT);
const original = rules.makeMaterial({ claim:material.claim, madeAt:material.made_at, deadline:material.deadline, postUrl:material.post_url,
  bets:[{id:material.bet_id,termsHash:input.terms_hash}] });
assert.equal(output.result.material_hash, rules.materialHash(original));
for (const call of output.calls) {
  const parsed = JSON.parse(call.input);
  assert.equal(call.input, rules.verdictInput(original,input.now,{models,minConfidence:0.8},canonicalJson(parsed.evidence),'ruling'));
  assert.equal(parsed.evidence.summary.priceAtMoment,3.4206);
}
assert.deepEqual(output.decisions,decisions.map(v=>rules.decide(v,0.8)));
assert.equal(output.result.outcome,'yes');
// Single visible blocks share exact extraction semantics with the server. The
// documented multi-block/scoping differences are tested explicitly in Rust.
const items = [
  { side: 'yes', url: 'https://www.bls.gov/news.release/ximpim.nr0.htm' },
  { side: 'no', url: 'https://example.org/official-record' },
];
const pages = [
  { content_type: 'text/html', body: '<head><title>Official page</title></head><body><nav><p>Navigation link text.</p></nav><p>The visible decision was published.</p><footer><p>Footer policy text.</p></footer></body>' },
  { content_type: 'application/xhtml+xml', body: '<body><p data-label="a > b <c>">The public record confirms the date.</p></body>' },
];
const rows = pages.map((page, i) => {
  const extracted = evidenceText(page.body, items[i].url);
  return { ...items[i], id: String(i), title: extracted.title || '', body: extracted.text, at: input.now };
});
const serverEvidence = rules.submittedEvidence(rows, input.now).text;
for (const kind of ['submitted', 'open']) {
  const nextInput = { ...input, material: { ...material, claim: 'US import prices fell in October 2026',
    evidence: kind === 'submitted' ? { kind, items } : { kind, window_seconds: 120, max_per_side: 1 } },
    ...(kind === 'open' ? { submitted_evidence: items } : {}) };
  const next = spawnSync('cargo', ['run', '--offline', '--locked', '--quiet', '--manifest-path', 'outlayer/stated-jury/Cargo.toml', '--example', 'parity'],
    { cwd: root, input: JSON.stringify({ input: nextInput, candles: [], decisions: [], pages }), encoding: 'utf8', maxBuffer: 8_000_000 });
  assert.equal(next.status, 0, next.stderr);
  const actual = JSON.parse(next.stdout);
  const nextMaterial = rules.makeMaterial({ claim: nextInput.material.claim, madeAt: material.made_at, deadline: material.deadline,
    postUrl: material.post_url, bets: [{ id: material.bet_id, termsHash: input.terms_hash }] });
  assert.equal(actual.result.material_hash, rules.materialHash(nextMaterial));
  assert.equal(actual.calls.length, 3, `${kind} skips the planner`);
  for (const call of actual.calls) {
    assert.equal(call.system, rules.VERDICT_PROMPT);
    assert.equal(call.input, rules.verdictInput(nextMaterial, input.now, { models, minConfidence: 0.8 }, serverEvidence, 'ruling'));
  }
}
// Redirected source and lossy decoding must match the server's Buffer decoder and
// submittedEvidence final_url projection. Unreadable is a jury protocol extension.
let extraInputs = 0;
for (const kind of ['submitted', 'open']) {
  const raw = [79,102,102,105,99,105,97,108,32,157,32,114,101,99,111,114,100];
  const posted = 'HTTPS://NEWS.COM/start';
  const final = 'https://www.news.com/final';
  const nextItems = [{ side: 'yes', url: posted }, { side: 'no', url: 'https://news.com/dead' }];
  const nextInput = { ...input, attempt: 3, material: { ...material, evidence: kind === 'submitted'
    ? { kind, items: nextItems } : { kind, window_seconds: 120, max_per_side: 1 } },
    ...(kind === 'open' ? { submitted_evidence: nextItems } : {}) };
  const next = spawnSync('cargo', ['run', '--offline', '--locked', '--quiet', '--manifest-path', 'outlayer/stated-jury/Cargo.toml', '--example', 'parity'],
    { cwd: root, input: JSON.stringify({ input: nextInput, candles: [], decisions: [], pages: [
      { bytes: raw, content_type: 'text/plain', final_url: final },
      { body: '', content_type: '', unreadable: 'status 404' },
    ] }), encoding: 'utf8', maxBuffer: 8_000_000 });
  assert.equal(next.status, 0, next.stderr);
  const actual = JSON.parse(next.stdout);
  const text = Buffer.from(raw).toString('utf8');
  const rows = [{ id: '0', side: 'yes', url: new URL(posted).href, final_url: final, body: text, at: input.now },
    { id: '1', side: 'no', url: nextItems[1].url, body: '', at: input.now }];
  const expectedEvidence = JSON.parse(rules.submittedEvidence(rows, input.now).text);
  expectedEvidence.items[1].unreadable = 'status 404';
  const baseline = rules.verdictInput(original, input.now, { models, minConfidence: 0.8 }, canonicalJson(expectedEvidence), 'ruling');
  const expected = baseline.slice(0, -1) + ',"evidenceNote":"An unreadable link is not evidence for either side."}';
  for (const call of actual.calls) { assert.equal(call.input, expected); extraInputs++; }
  assert.deepEqual(actual.result.evidence_summary.items, [
    { side: 'yes', url: final, postedUrl: new URL(posted).href, textHash: createHash('sha256').update(text).digest('hex') },
    { side: 'no', url: nextItems[1].url, textHash: createHash('sha256').update('').digest('hex'), unreadable: 'status 404' },
  ]);
}
// Nonempty scope selection agrees here: main, article, role=main, then body.
// Rust falls back past empty scopes; the server can select an empty scope.
// Large unrelated text before a
// selected scope must not consume Rust's text budget.
const evidenceUrl = 'https://example.org/decision';
const scopedPages = [
  `<div>${'unrelated lead '.repeat(520)}</div><main><p>Main scope confirms the official decision.</p></main>`,
  `<div>${'unrelated lead '.repeat(520)}</div><article><p>Article scope confirms the official decision.</p></article>`,
  `<div>${'unrelated lead '.repeat(520)}</div><div role="main"><p>Role main confirms the official decision.</p></div>`,
  '<p>Body fallback must lose.</p><div role="main"><p>Role main must lose.</p></div>' +
    '<article><p>Article must lose.</p></article><main><p>Main scope wins the priority order.</p></main>',
  '<body><p>Body fallback confirms the official decision.</p></body>',
  '<main hidden><p>Hidden main must lose.</p></main><article><p>Visible article confirms the official decision.</p></article>',
  '<div role="main"><p>Role main must lose.</p></div><article><p>Article scope wins over role main.</p></article>',
];
const scopeMarkers = [
  'Main scope confirms the official decision.',
  'Article scope confirms the official decision.',
  'Role main confirms the official decision.',
  'Main scope wins the priority order.',
  'Body fallback confirms the official decision.',
  'Visible article confirms the official decision.',
  'Article scope wins over role main.',
];
let extractionCases = 0;
function extractBoth(html, claim = 'official decision') {
  const server = evidenceText(html, evidenceUrl, { claim });
  const evidenceInput = { ...input, material: { ...material, claim,
    evidence: { kind: 'submitted', items: [{ side: 'yes', url: evidenceUrl }] } } };
  const run = spawnSync('cargo', ['run', '--offline', '--locked', '--quiet', '--manifest-path',
    'outlayer/stated-jury/Cargo.toml', '--example', 'parity'], {
    cwd: root, input: JSON.stringify({ input: evidenceInput, candles: [], decisions: [],
      pages: [{ body: html, content_type: 'text/html' }] }), encoding: 'utf8', maxBuffer: 8_000_000,
  });
  assert.equal(run.status, 0, run.stderr);
  const actual = JSON.parse(run.stdout);
  assert.equal(actual.calls.length, models.length);
  extractionCases++;
  const rustText = JSON.parse(actual.calls[0].input).evidence.items[0].text;
  return { serverText: server.text, rustText };
}
for (const [index, html] of scopedPages.entries()) {
  const { serverText, rustText } = extractBoth(html);
  assert.equal(serverText, scopeMarkers[index], `server scope case ${index}`);
  assert.equal(rustText, serverText, `Rust scope case ${index}`);
  assert.ok(!rustText.includes('unrelated lead'), `Rust scope case ${index} excludes leading body text`);
  if (index === 3) {
    assert.ok(!rustText.includes('Role main must lose'));
    assert.ok(!rustText.includes('Article must lose'));
    assert.ok(!rustText.includes('Body fallback must lose'));
  }
}

// HTML permits omitted p/li end tags. Both extractors retain the same words;
// whitespace differs because the server preserves selected block boundaries.
for (const html of [
  '<main><p>First paragraph remains visible<p>Second paragraph remains visible</main>',
  '<main><ul><li>First list item remains visible<li>Second list item remains visible</ul></main>',
]) {
  const { serverText, rustText } = extractBoth(html, 'visible list paragraph');
  assert.equal(serverText.replace(/\s+/g, ' ').trim(), rustText.replace(/\s+/g, ' ').trim());
}

// Dropped roots close even with unclosed discarded descendants. Foreign
// self-closing siblings consume tag budget, not nesting depth.
const visibleRecord = '<p>The official decision remains visible.</p>';
const discardedSubtreeCases = [
  ['header SVG icon', '<header><svg><path aria-hidden="true" d="M0 0"/><rect style="display:none" width="8"/></svg></header>' +
    `<article>${visibleRecord}</article>`],
  ['nav unclosed aside', `<nav><aside><a>secret</a></nav><main>${visibleRecord}</main>`],
  ['nav unclosed hidden span', `<nav><span hidden>secret</nav><main>${visibleRecord}</main>`],
  ['hidden unclosed aside', `<div hidden><aside>secret</div><main>${visibleRecord}</main>`],
  ['MathML self-closing children', `<math><mspace hidden/><mi aria-hidden="true"/></math><article>${visibleRecord}</article>`],
  ...['<path d="M0 0"/>', '<path aria-hidden="true" d="M0 0"/>'].map(path =>
    [`SVG chart with 2000 ${path}`, `<main><svg>${path.repeat(2000)}</svg>${visibleRecord}</main>`]),
];
for (const [name, html] of discardedSubtreeCases) {
  const { serverText, rustText } = extractBoth(html);
  assert.equal(serverText, 'The official decision remains visible.', `server ${name}`);
  assert.equal(rustText, serverText, `Rust ${name}`);
}
const excludedWrappers = ['nav', 'script', 'style', 'template', 'div hidden', 'div aria-hidden=true',
  'div style="display:none"', 'div style="visibility:hidden"'];
for (const wrapper of excludedWrappers) {
  const tag = wrapper.split(/\s/)[0];
  const { serverText, rustText } = extractBoth(`<main><p>Visible before.</p><${wrapper}>` +
    `<aside>secret</main>still secret</${tag}><p>Visible after.</p></main>`);
  assert.equal(serverText.replace(/\s+/g, ' ').trim(), 'Visible before. Visible after.', `server excludes ${wrapper}`);
  assert.equal(rustText, 'Visible before. Visible after.', `Rust excludes ${wrapper}`);
}

// This branch's server evidenceText is a custom parser, not parse5. Two
// deliberate differences: it enters raw title mode for SVG <title/>, and it
// retains header, so an unclosed nav blocks </header>. Rust skips foreign empty
// bodies and drops header, whose end tag closes its discarded descendants.
const discardedDifferences = [
  ['SVG self-closing title', `<header><svg><title/></svg></header><article>${visibleRecord}</article>`],
  ['header unclosed nav', `<header><nav><a>secret</a></header><article>${visibleRecord}</article>`],
];
for (const [name, html] of discardedDifferences) {
  const { serverText, rustText } = extractBoth(html);
  assert.equal(serverText, '', `server ${name}`);
  assert.equal(rustText, 'The official decision remains visible.', `Rust ${name}`);
}

// Deliberate differences: server drops form descendants, while Rust keeps
// them. Server ranks blocks against the claim and joins them with newlines;
// Rust takes document-order text in scopes of the chosen rank, capped at
// 6000 UTF-16 units. It falls back when higher-ranked scopes have no text.
const formCase = extractBoth('<main><p>Before the form is evidence.</p><form><p>Form text stays in Rust evidence.</p></form>' +
  '<p>After the form is evidence.</p></main>');
assert.ok(!formCase.serverText.includes('Form text stays'));
assert.ok(formCase.rustText.includes('Form text stays'));
const rankingCase = extractBoth('<main><p>Opening paragraph describes unrelated context.</p>' +
  `<p>${'Unrelated filler context. '.repeat(300)}</p>` +
  '<p>The official decision confirms the specific claim.</p></main>', 'specific claim official decision');
assert.ok(rankingCase.serverText.includes('\n'));
assert.ok(rankingCase.serverText.includes('specific claim'));
assert.ok(rankingCase.serverText.includes('unrelated context'));
assert.ok(!rankingCase.rustText.includes('\n'));
assert.ok(!rankingCase.rustText.includes('specific claim'));
assert.ok(rankingCase.rustText.startsWith('Opening paragraph'));
const capCase = extractBoth(`<div>${'leading body content '.repeat(350)}</div><main><p>${'selected scope text '.repeat(400)}</p></main>`);
assert.equal(capCase.rustText.length, 6000);
assert.ok(capCase.rustText.startsWith('selected scope text'));
assert.ok(capCase.serverText.length <= 6000);
const emptyScopeCase = extractBoth('<body><p>Visible body fallback evidence.</p><main> </main></body>');
assert.equal(emptyScopeCase.serverText, '');
assert.equal(emptyScopeCase.rustText, 'Visible body fallback evidence.');
console.log(`PASS: exact prompts, material hashes, ${9 + extraInputs} complete verdict-input comparisons, ${extractionCases} extraction cases (${9 + discardedSubtreeCases.length + excludedWrappers.length} shared, ${4 + discardedDifferences.length} deliberate differences), ${decisions.length} decision cases. Mock transport only; no live inference or OutLayer execution.`);
