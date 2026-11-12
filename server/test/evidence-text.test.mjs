import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceText } from '../src/evidence-text.mjs';

const url = 'https://example.org/official-record';
const read = (html, options) => evidenceText(html, url, options);

test('quoted angle brackets stay in attributes, never in evidence', () => {
  const result = read(`<body><main>
    <p data-mw='{"x":"a > b <c>"}'>Nvidia was founded in 1993.</p>
    <p data-label="a > b <c>" title='quoted "text"'>The public record confirms the date.</p>
    <p title=unquoted>Another public paragraph.</p>
  </main></body>`);
  assert.deepEqual(result.blocks, ['Nvidia was founded in 1993.', 'The public record confirms the date.', 'Another public paragraph.']);
  assert.doesNotMatch(result.text, /data-mw|<c>|a > b/);
});

test('comments and declarations are ignored, CDATA and literal comparisons are readable', () => {
  const result = read(`<!doctype html><body><main>
    <!-- <p>Secret comment words.</p> -->
    <p>The result is 3 < 5 and 7 > 4.</p>
    <p><![CDATA[Public <comparison> text &amp; data.]]></p>
    <p>Text<!-- hidden comment --> stays readable.</p>
    <!-- unclosed comment <p>Never visible.</p>`);
  assert.deepEqual(result.blocks, ['The result is 3 < 5 and 7 > 4.', 'Public <comparison> text & data.', 'Text stays readable.']);
});

test('unclosed paragraphs, headings, lists and table cells finish tolerantly', () => {
  const result = read(`<body><main><h1>Official release<h2>Release schedule</h2>
    <p>First public paragraph<p>Second public paragraph
    <ul><li>First listed item<li>Second listed item</ul>
    <dl><dt>Release timing<dd>Friday morning<dt>Release authority<dd>Public registry</dl>
    <table><tr><th>Report name<th>Release date<tr><td>Employment report<td>14 November 2026</table>
    <p>Final unclosed paragraph`);
  assert.deepEqual(result.blocks, ['Official release', 'Release schedule', 'First public paragraph', 'Second public paragraph',
    'First listed item', 'Second listed item', 'Release timing', 'Friday morning', 'Release authority', 'Public registry',
    'Report name | Release date', 'Employment report | 14 November 2026', 'Final unclosed paragraph']);
});

test('deep unclosed wrapper tags remain readable without recursive traversal', () => {
  assert.equal(read(`<body><main>${'<div>'.repeat(20_000)}<p>Visible deeply nested evidence.</p>`).text,
    'Visible deeply nested evidence.');
});

test('all excluded element contents stay out, including forged markup inside raw text', () => {
  const tags = 'script style noscript template svg math iframe object textarea select button nav footer aside form'.split(' ');
  const hidden = tags.map((tag) => `<${tag}><p>Hidden ${tag} instructions.</p></${tag}>`).join('');
  const result = read(`<html><head><title>Official page</title><p>Hidden head content.</p></head><body><main>
    ${hidden}<script>const fake = '</main><p>Forged script paragraph.</p>';</script>
    <p>The visible decision was published.</p>
  </main></body></html>`);
  assert.equal(result.title, 'Official page');
  assert.deepEqual(result.blocks, ['The visible decision was published.']);
});

test('hidden attributes and styles suppress nested contents and tails', () => {
  const result = read(`<body><main>
    <div hidden="false"><div><p>Nested hidden paragraph.</p></div><p>Hidden tail paragraph.</p></div>
    <div ARIA-HIDDEN=" TRUE "><p>ARIA hidden paragraph.</p></div>
    <div style="color: red; DISPLAY : none !important;"><p>Display hidden paragraph.</p></div>
    <div style="visibility: hidden"><p>Visibility hidden paragraph.</p></div>
    <div style="display:none ! important"><p>Spaced priority hidden paragraph.</p></div>
    <div style="display:/* comment */none"><p>Commented hidden paragraph.</p></div>
    <input hidden><p>Visible after hidden void element.</p>
    <p aria-hidden="false" style="display: block; visibility:visible">Another visible paragraph.</p>
    <div data-hidden="true" data-style="display:none"><p>Attribute names remain distinct.</p></div>
  </main></body>`);
  assert.deepEqual(result.blocks, ['Visible after hidden void element.', 'Another visible paragraph.', 'Attribute names remain distinct.']);
});

test('malformed nesting and non-void self-closing tags cannot expose hidden contents', () => {
  assert.deepEqual(read(`<body><main><h1>Public heading<div hidden><h2>Secret heading</h2>
    <p>Secret paragraph.</p></div></h1><p>Public paragraph.</p></main></body>`).blocks,
  ['Public heading', 'Public paragraph.']);
  assert.deepEqual(read(`<body><main><p>Public paragraph <button><p>Secret button paragraph.</p>
    Secret button tail.</button></p></main></body>`).blocks, ['Public paragraph']);
  assert.deepEqual(read(`<body><main><template></main><p>Secret template paragraph.</p></template>
    <p>Visible public paragraph.</p></main></body>`).blocks, ['Visible public paragraph.']);
  assert.equal(read('<body><div hidden/><p>Hidden until end of input.</p>').text, '');
  assert.equal(read('<body><svg/><math/><p>Visible after foreign roots.</p>').text, 'Visible after foreign roots.');
});

test('title uses title then og:title and never JSON-LD or descriptions', () => {
  const metadata = `<meta name="description" content="Hidden description text.">
    <script type="application/ld+json">{"headline":"Hidden headline","articleBody":"Hidden article body."}</script>`;
  assert.equal(read(`<head><meta content='Open &amp; Graph > title' property='og:title'>${metadata}
    <title>Visible &amp; document title</title></head><body><p>Public body text.</p></body>`).title, 'Visible & document title');
  const fallback = read(`<head><meta name='og:title' content='Open &amp; Graph > title'>${metadata}</head><body><p>Public body text.</p></body>`);
  assert.equal(fallback.title, 'Open & Graph > title');
  assert.equal(fallback.text, 'Public body text.');
  const absent = read(`<head>${metadata}</head><body><p>Public body text.</p></body>`);
  assert.equal(absent.title, null);
  assert.equal(absent.text, 'Public body text.');
  assert.equal(read(`<div hidden><title>Hidden title</title><meta property="og:title" content="Hidden fallback"></div>`).title, null);
  assert.equal(read(`<head><title>Rates < 5 &amp; > 2</title><body><p>The head was unclosed.</p>`).title, 'Rates < 5 & > 2');
  const misplacedTitle = read('<body><p>Public <title>Metadata title words</title> statement.</p></body>');
  assert.equal(misplacedTitle.title, 'Metadata title words');
  assert.equal(misplacedTitle.text, 'Public statement.');
});

test('content preference is main, article, role main, then body', () => {
  const surrounding = '<p>Outside selected content.</p><div role="main"><p>Role main content.</p></div>';
  assert.equal(read(`<body>${surrounding}<article><p>Article content wins.</p></article><main><p>Main content wins.</p></main></body>`).text, 'Main content wins.');
  assert.equal(read(`<body>${surrounding}<article><p>Article content wins.</p></article></body>`).text, 'Article content wins.');
  assert.equal(read(`<body>${surrounding}</body>`).text, 'Role main content.');
  assert.equal(read('<p>Outside body content.</p><body><p>Body content wins.</p></body>').text, 'Body content wins.');
  assert.equal(read('<body><main hidden><p>Hidden main text.</p></main><article><p>Visible article content.</p></article></body>').text, 'Visible article content.');
});

test('multiple content containers retain document order without double-reading nested scopes', () => {
  assert.deepEqual(read(`<body><article><p>First article text.</p><article><p>Nested article text.</p></article></article>
    <article><p>Second article text.</p></article></body>`).blocks,
  ['First article text.', 'Nested article text.', 'Second article text.']);
});

test('headings, lists, definitions, quotes, pre and captions form collapsed blocks', () => {
  const result = read(`<body><main><h1>Evidence heading</h1><h2>Second heading</h2><h3>Third heading</h3>
    <h4>Fourth heading</h4><h5>Fifth heading</h5><h6>Sixth heading</h6>
    <p>A <strong>public</strong> decision.<br>Published\n\t Friday.</p>
    <ul><li>First listed fact</li><li>Second listed fact</li></ul>
    <dl><dt>Effective date</dt><dd>14 November 2026</dd></dl>
    <blockquote>Quoted public statement.</blockquote><pre>First line\n  second line</pre>
    <figure><figcaption>Official result caption</figcaption></figure></main></body>`);
  assert.deepEqual(result.blocks, ['Evidence heading', 'Second heading', 'Third heading', 'Fourth heading', 'Fifth heading', 'Sixth heading',
    'A public decision. Published Friday.', 'First listed fact', 'Second listed fact', 'Effective date', '14 November 2026',
    'Quoted public statement.', 'First line second line', 'Official result caption']);
  assert.equal(result.text, result.blocks.join('\n'));
});

test('table rows include header cells and release dates, without duplicate cell paragraphs', () => {
  const result = read(`<body><main><table>
    <thead><tr><th>Report name</th><th>Release date</th></tr></thead>
    <tbody><tr><td><p>Employment report</p></td><td>14 November 2026</td></tr>
    <tr><td>Home score</td><td>3</td></tr><tr><td>3</td><td>2</td></tr></tbody>
  </table></main></body>`);
  assert.deepEqual(result.blocks, ['Report name | Release date', 'Employment report | 14 November 2026', 'Home score | 3', '3 | 2']);
});

test('short blocks, exact duplicates and the standard US government banner are dropped', () => {
  const result = read(`<body><p>An official website of the United States Government.</p>
    <p>Official websites use .gov</p><h2>Secure .gov websites use HTTPS</h2>
    <p>Alone</p><p>!!!</p><p>Public  record text.</p><p>Public record text.</p>
    <p>Public record text!</p><li><p>Nested public fact.</p></li>
    <p>Official websites use .gov. The release remains available.</p>
    <nav><p>Navigation link text.</p></nav><footer><p>Footer policy text.</p></footer></body>`);
  assert.deepEqual(result.blocks, ['Public record text.', 'Public record text!', 'Nested public fact.', 'The release remains available.']);
});

test('named basics, decimal and hexadecimal entities decode safely exactly once', () => {
  const result = read(`<title>Public &amp; official &#x1f4c4;</title><body>
    <p>&lt;public&gt; &amp; &quot;quoted&quot; &apos;record&apos;&nbsp;&#65;&#x42;&#128512; &copy; &mdash; &ndash; &hellip;</p>
    <p>&amp;lt;p&amp;gt; is literal evidence &unknown; &#0; &#xD800; &#1114112; &#999999999999999999999999;</p></body>`);
  assert.equal(result.title, 'Public & official 📄');
  assert.deepEqual(result.blocks, ['<public> & "quoted" \'record\' AB😀 © — – …',
    '&lt;p&gt; is literal evidence &unknown; � � � �']);
});

test('all fitting content stays complete and in original order', () => {
  const html = '<body><p>First public paragraph.</p><h1>Later public heading.</h1><p>Final public paragraph.</p></body>';
  const result = read(html);
  assert.deepEqual(result.blocks, ['First public paragraph.', 'Later public heading.', 'Final public paragraph.']);
  assert.deepEqual(read(html, { maxChars: result.text.length }), result);
});

test('a relevant paragraph near the end of a 50,000-character page survives selection', () => {
  const background = Array.from({ length: 500 }, (_, i) => `<p>Background section ${i} contains unrelated administrative context for visitors and routine operations.</p>`).join('');
  const html = `<body><main><h1>Official public announcement</h1>${background}<p>NEAR HACKATHON submissions close on 14 November 2026.</p></main></body>`;
  assert.ok(html.length > 50_000);
  const result = read(html, { claim: 'NEAR HACKATHON submissions close on 14 November 2026' });
  assert.ok(result.text.length <= 6000);
  assert.equal(result.blocks[0], 'Official public announcement');
  assert.match(result.text, /NEAR HACKATHON submissions close on 14 November 2026\./);
  assert.ok(result.blocks.includes('…'));
  assert.deepEqual(read(html, { claim: 'NEAR HACKATHON submissions close on 14 November 2026' }), result);
});

test('selection keeps the first two blocks without a heading and ranks exact words and numbers', () => {
  const html = `<body><p>First anchor.</p><p>Second anchor.</p>
    <p>Unrelated record.</p><p>Foundedness 11993 record.</p><p>Founded 1993 record.</p>
    <p>Final irrelevant record.</p></body>`;
  const result = read(html, { claim: 'founded 1993', maxChars: 70 });
  assert.deepEqual(result.blocks, ['First anchor.', 'Second anchor.', '…', 'Founded 1993 record.', '…']);
  assert.ok(result.text.length <= 70);
});

test('date matching and tied relevance use exact tokens and original order', () => {
  const html = '<body><h1>Release schedule</h1><p>Record 2026-11-140 filed.</p><p>Record 2026-11-14 filed.</p><p>Record 2026-11-14 posted.</p><p>Other public record.</p></body>';
  const result = read(html, { claim: '2026-11-14', maxChars: 46 });
  assert.deepEqual(result.blocks, ['Release schedule', '…', 'Record 2026-11-14 filed.', '…']);
  assert.deepEqual(read(html, { claim: '2026-11-14', maxChars: 46 }), result);
});

test('a later first heading is retained and omission markers expose skipped blocks', () => {
  const html = '<body><p>Long introductory text which must be skipped within the limited evidence budget.</p><h2>Official heading</h2><p>Relevant result published.</p><p>Unrelated final paragraph.</p></body>';
  assert.deepEqual(read(html, { claim: 'relevant result', maxChars: 47 }).blocks,
    ['…', 'Official heading', 'Relevant result published.', '…']);
});

test('empty and oversized blocks respect every storage budget', () => {
  assert.deepEqual(read('<body><script>Hidden words.</script><p>Alone</p></body>'), { title: null, text: '', blocks: [] });
  const html = `<body><p>${'Long visible evidence. '.repeat(1000)}</p><p>Final public words.</p></body>`;
  for (const maxChars of [0, 1, 2, 3, 10, 50, 6000]) {
    const result = read(html, { claim: 'evidence', maxChars });
    assert.ok(result.text.length <= maxChars, `${maxChars}: ${result.text.length}`);
    if (maxChars) assert.ok(result.text.length);
  }
  assert.equal(read('<p>Truncated attribute stays private.</p><p data-value="hidden > <words>').text, 'Truncated attribute stays private.');
});
