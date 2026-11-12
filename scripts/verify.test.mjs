// INTEGRATION: verifies public verification orchestration with child-process fakes.
import assert from 'node:assert/strict';
import test from 'node:test';
import { runVerifications } from './verify.mjs';

test('runs every live verification with exact arguments after an offline incomplete result', () => {
  const calls = []; const lines = [];
  const result = runVerifications({ log: line => lines.push(line), spawn: (...args) => {
    calls.push(args); return [{ status: 2 }, { status: 0 }, { status: 0 }][calls.length - 1];
  } });
  assert.equal(result.exitCode, 0);
  assert.deepEqual(calls.map(([bin, args, options]) => [bin, args, options.cwd, options.stdio]), [
    [process.execPath, ['scripts/verify-enclave-ruling.mjs', '--offline', 'evidence/enclave-ruling-3668aa04.json'], calls[0][2].cwd, 'inherit'],
    [process.execPath, ['scripts/verify-enclave-ruling.mjs'], calls[1][2].cwd, 'inherit'],
    [process.execPath, ['scripts/verify-hosted-payout.mjs', 'evidence/hosted-court-payout-testnet-20261112.json'], calls[2][2].cwd, 'inherit'],
  ]);
  assert.equal(lines.length, 4);
  assert.match(lines[0], /EXPECTED INCOMPLETE/);
  assert.match(lines[3], /^final: PASS/);
});

test('offline mode runs only the offline verifier', () => {
  const calls = [];
  const result = runVerifications({ argv: ['--offline'], log: () => {}, spawn: (...args) => { calls.push(args); return { status: 2 }; } });
  assert.equal(result.exitCode, 0);
  assert.equal(calls.length, 1);
});

test('live incomplete, signals and spawn errors cannot pass', () => {
  for (const children of [[{ status: 1 }, { status: 0 }, { status: 0 }], [{ status: 0 }, { status: 2 }, { status: 0 }], [{ signal: 'SIGTERM' }, { status: 0 }, { status: 0 }], [{ error: Error('missing') }, { status: 0 }, { status: 0 }]]) {
    let i = 0;
    const result = runVerifications({ log: () => {}, spawn: () => children[i++] });
    assert.notEqual(result.exitCode, 0);
    assert.equal(i, 3, 'later checks still run after failures');
  }
});

test('invalid arguments fail before spawning', () => {
  let calls = 0;
  assert.equal(runVerifications({ argv: ['--bad'], log: () => {}, spawn: () => { calls++; } }).exitCode, 1);
  assert.equal(calls, 0);
});
