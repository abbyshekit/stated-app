// The published OutLayer jury build is served by its SHA-256 name, byte for byte, and nothing else is.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readdirSync } from 'node:fs';
import { after, before, test } from 'node:test';
import { startStack } from './support/app.mjs';

let s;
before(async () => { s = await startStack(); });
after(async () => { if (s) await s.close(); });

test('the jury build is served by its SHA-256 name with matching bytes', async () => {
  const names = readdirSync(new URL('../public/outlayer/', import.meta.url)).filter((f) => f.endsWith('.wasm'));
  assert.ok(names.length >= 1, 'at least one published jury build');
  for (const name of names) {
    const res = await fetch(new URL(`/static/outlayer/${name}`, s.browser().base));
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('content-type'), 'application/wasm');
    const bytes = Buffer.from(await res.arrayBuffer());
    assert.equal(createHash('sha256').update(bytes).digest('hex'), name.slice('stated-jury-'.length, -'.wasm'.length));
  }
});

test('unknown, malformed and traversal names are 404', async () => {
  for (const path of [`/static/outlayer/stated-jury-${'0'.repeat(64)}.wasm`, '/static/outlayer/stated-jury-abc.wasm',
    '/static/outlayer/../src/web.mjs', '/static/outlayer/%2e%2e%2fsrc%2fweb.mjs']) {
    assert.equal((await s.browser().get(path)).status, 404, path);
  }
});
