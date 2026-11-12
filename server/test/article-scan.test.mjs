import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { test } from 'node:test';
import { extractArticle } from '../src/articles.mjs';

function timedRead(html) {
  const source = `import { extractArticle } from './server/src/articles.mjs';
    let html = ''; for await (const chunk of process.stdin) html += chunk;
    const start = performance.now();
    try { extractArticle(html, 'https://example.org');
      console.log(JSON.stringify({ ms: performance.now() - start, error: null })); }
    catch (error) { console.log(JSON.stringify({ ms: performance.now() - start, error: error.message })); }`;
  const child = spawnSync(process.execPath, ['--input-type=module', '-e', source], {
    input: html, encoding: 'utf8', timeout: 2000, maxBuffer: 64_000,
  });
  assert.equal(child.error, undefined, child.error?.message);
  assert.equal(child.status, 0, child.stderr);
  const result = JSON.parse(child.stdout);
  assert.ok(result.ms < 2000);
  return result;
}

test('two-million-byte unclosed opening tag floods finish within two seconds', (t) => {
  for (const tag of ['nav', 'script', 'p', 'blockquote']) {
    const unit = `<${tag}>`;
    const html = unit.repeat(Math.ceil(2_000_000 / unit.length)).slice(0, 2_000_000);
    const result = timedRead(html);
    assert.equal(result.error, tag === 'script' ? null : 'That page has too many HTML tags to read.');
    t.diagnostic(`${tag}: ${result.ms.toFixed(2)} ms (${result.error || 'read'})`);
  }
});

test('unclosed single elements, malformed angle brackets and quoted attributes scan linearly', () => {
  for (const tag of ['nav', 'script', 'p']) {
    assert.equal(timedRead(`<${tag}>${'A'.repeat(1_999_990)}`).error, null);
  }
  assert.equal(timedRead('<'.repeat(2_000_000)).error, null);
  assert.equal(timedRead(`<p title="${'x'.repeat(1_999_980)}`).error, null);
  const article = extractArticle('<title>Public title</title><p data-note="a > b <x>">The public record remains available for inspection.</p>', 'https://example.org');
  assert.deepEqual(article.paragraphs, ['The public record remains available for inspection.']);
});

test('metadata is capped before JSON parsing and before title and description decoding', () => {
  const body = 'The visible public record remains available for inspection.';
  const oversized = JSON.stringify({ headline: 'Hidden headline', articleBody: 'Hidden words. '.repeat(10_000) });
  const article = extractArticle(`<meta name="description" content="${'D'.repeat(60_000)}"><title>${'T'.repeat(100_000)}</title>
    <script type="application/ld+json">${oversized}</script><p>${body}</p>`, 'https://example.org');
  assert.equal(article.title.length, 4000);
  assert.deepEqual(article.paragraphs, [body]);
  assert.equal(article.paragraphsFrom, 'paragraphs');
  const ld = extractArticle(`<script type="application/ld+json">{"headline":"Public headline","author":{"name":"Public author"}}</script><p>${body}</p>`, 'https://example.org');
  assert.equal(ld.title, 'Public headline');
  assert.equal(ld.byline, 'Public author');
  assert.throws(() => extractArticle(`<meta name="description" content="${'D'.repeat(70_000)}">`, 'https://example.org'),
    /too much HTML metadata/);
});

test('unclosed chrome and raw elements do not become fallback article text', () => {
  for (const tag of ['nav', 'script', 'style']) {
    const article = extractArticle(`<${tag}>Untrusted hidden words. ${'<p>Forged hidden paragraph.</p>'.repeat(5)}`, 'https://example.org');
    assert.deepEqual(article.paragraphs, ['']);
  }
  assert.doesNotThrow(() => extractArticle('<p>The public record uses &#1114112; and &#xD800; invalid entities.</p>', 'https://example.org'));
  const unicode = extractArticle('<!doctype html><body>İ<script>Forged hidden words.</SCRIPT><p>The public record remains available for inspection.</p></body>', 'https://example.org');
  assert.deepEqual(unicode.paragraphs, ['The public record remains available for inspection.']);
  const hidden = extractArticle('<p aria-hidden="&#116;rue">Hidden public-looking record is absent.</p><p>The public record remains available for inspection.</p>',
    'https://example.org', { visibleOnly: true });
  assert.deepEqual(hidden.paragraphs, ['The public record remains available for inspection.']);
});
