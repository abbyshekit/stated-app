import assert from 'node:assert/strict';
import { test } from 'node:test';
import { xClaimSourceUrl, xClaimText } from '../src/xtext.mjs';

test('claim text preserves exact URL entities before stripping unknown t.co attachments', () => {
  const text = 'The page will list https://t.co/domain by 30 Nov 2026. Source: https://t.co/source';
  const post = { text, entities: { urls: [
    { url: 'https://t.co/domain', expanded_url: 'http://example.com', unwound_url: 'https://www.iana.org/help/example-domains' },
    { url: 'https://t.co/source', expanded_url: 'https://www.iana.org/domains/reserved' },
  ] } };
  assert.equal(xClaimText(text, 'statedforecast', { post }), 'The page will list http://example.com by 30 Nov 2026. Source: https://www.iana.org/domains/reserved');
});

test('note tweet entities take precedence and expansion never replaces partial URL tokens', () => {
  const text = '@statedforecast The page will list https://t.co/domain. https://t.co/domainExtra https://t.co/domain/path #public';
  const post = { entities: { urls: [{ url: 'https://t.co/domain', expanded_url: 'https://wrong.example.org' }] },
    note_tweet: { text, entities: { urls: [{ url: 'https://t.co/domain', expanded_url: 'https://example.com' }] } } };
  assert.equal(xClaimText(text, 'statedforecast', { post }), 'The page will list https://example.com. /path');
});

test('unsafe, credential-bearing and absent URL metadata retain the existing attachment policy', () => {
  for (const expanded_url of ['javascript:alert(1)', 'data:text/html,claim', 'https://user:password@example.com', 'https://example.com/\nchanged', 'https://example.com\\changed', 'https://' + 'a'.repeat(2100)]) {
    const text = 'The outcome will happen by 30 Nov 2026 https://t.co/link';
    assert.equal(xClaimText(text, 'statedforecast', { post: { entities: { urls: [{ url: 'https://t.co/link', expanded_url }] } } }), 'The outcome will happen by 30 Nov 2026');
  }
  assert.equal(xClaimText('The outcome will happen https://t.co/unknown'), 'The outcome will happen');
  assert.equal(xClaimText('The outcome will happen https://t.co/unknown', null, { post: { entities: { urls: {} } } }), 'The outcome will happen');
  assert.equal(xClaimText('The outcome will happen https://t.co/unknown', null, { post: { entities: { urls: [null] } } }), 'The outcome will happen');
});

test('only an explicit trailing safe HTTPS source becomes bet evidence context', () => {
  const url = 'https://www.iana.org/domains/reserved';
  assert.equal(xClaimSourceUrl('The page will list example.com. Source: ' + url), url);
  for (const claim of ['The page will list example.com. ' + url, 'Source: javascript:alert(1)',
    'Source: https://user:password@example.com', 'Source: https://t.co/unknown', 'Source: ' + url + ' says this']) assert.equal(xClaimSourceUrl(claim), null);
});

test('entity URL literals survive bot and attachment cleanup without interpreting their contents', () => {
  const url = 'https://example.org/@statedforecast?next=https://t.co/inside#public';
  const text = '@statedforecast The page will list https://t.co/source \uE0000\uE001 #public';
  const post = { entities: { urls: [{ url: 'https://t.co/source', expanded_url: url }] } };
  assert.equal(xClaimText(text, 'statedforecast', { post }), 'The page will list ' + url + ' \uE0000\uE001');
});
