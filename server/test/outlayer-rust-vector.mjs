// Explicit offline cross-language check; run with node --test on this file.
// The ordinary server suite does not require a Rust toolchain.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeOutlayerMaterial, outlayerTermsHash } from '../src/outlayer.mjs';

test('server-built Open vector passes Rust validate_material without replanning', () => {
  const vector = JSON.parse(readFileSync(new URL('./fixtures/outlayer-terms-vectors.json', import.meta.url), 'utf8'))
    .find(item => item.material.evidence.kind === 'open');
  assert.ok(vector, 'shared Open material is required');
  const m = vector.material;
  const material = makeOutlayerMaterial({ id: m.bet_id, claim: m.claim, madeAt: m.made_at, deadline: m.deadline,
    postUrl: m.post_url, plan: { source: 'evidence' } }, {}, { supports_open_evidence: true });
  assert.deepEqual(material, m);
  assert.equal(outlayerTermsHash(material, vector.salt), vector.hash);
  const input = { material, terms_hash: vector.hash,
    now: new Date(Date.parse(m.deadline) + material.evidence.window_seconds * 1000).toISOString() };
  const rust = spawnSync('cargo', ['run', '--offline', '--locked', '--quiet', '--manifest-path',
    'outlayer/stated-jury/Cargo.toml', '--example', 'parity'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    input: JSON.stringify({ input, candles: [], decisions: [], pages: [] }), encoding: 'utf8',
    timeout: 300000, maxBuffer: 1000000,
  });
  assert.equal(rust.status, 0, rust.error?.message || rust.stderr);
  const output = JSON.parse(rust.stdout);
  assert.equal(output.result.terms_hash, vector.hash);
  assert.equal(output.calls.length, 3, 'explicit Open evidence must skip the planner');
});
