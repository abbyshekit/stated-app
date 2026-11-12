// INTEGRATION: DB-free test coverage for complete-suite evidence recording.
import assert from 'node:assert/strict';
import test from 'node:test';
import { parseTap, recordTestRun as record, updateLatestRecord } from './record-test-run.mjs';

const recordTestRun = options => record({ updateLatest: () => {}, ...options });

const SHA = '0123456789abcdef0123456789abcdef01234567';
const tap = '# tests 4\n# pass 3\n# fail 1\n# cancelled 0\n# skipped 0\n# todo 0\n# duration_ms 12.5\n';
test('latest README link changes only its marker and a complete run updates it', () => {
  let saved;
  updateLatestRecord('/work', 'test-run-0123456789ab.json', 'passed', {
    readFileSync: () => 'before\n<!-- test-run-record -->none\nafter\n',
    writeFileSync: (_path, text) => { saved = text; },
  });
  assert.equal(saved, 'before\n<!-- test-run-record -->Latest full-suite record: [test-run-0123456789ab.json](evidence/test-run-0123456789ab.json) (passed).\nafter\n');
  assert.throws(() => updateLatestRecord('/work', 'run.json', 'passed', { readFileSync: () => 'no marker' }), /marker/);
  const links = [];
  const common = { cwd: '/work', log: () => {}, fs: { existsSync: () => true, writeFileSync: () => {} },
    exec: (command, args) => command === 'git' ? args[0] === 'rev-parse' ? SHA : '' : 'postgres (PostgreSQL) 17',
    updateLatest: (...args) => links.push(args) };
  recordTestRun({ ...common, spawn: () => ({ status: 1, stdout: tap }) });
  assert.deepEqual(links, [['/work', 'test-run-0123456789ab.json', 'failed']]);
  recordTestRun({ ...common, spawn: () => ({ status: 1, stdout: '' }) });
  assert.equal(links.length, 1, 'incomplete runs retain the latest complete link');
});
test('parses complete Node TAP counts and rejects incomplete summaries', () => {
  assert.deepEqual(parseTap(tap), { tests: 4, pass: 3, fail: 1, cancelled: 0, skip: 0, todo: 0, durationMs: 12.5 });
  assert.equal(parseTap('# tests 1\n# pass 1\n'), null);
  assert.equal(parseTap(tap.replace('# pass 3', '# pass 4')), null);
});

test('writes a parseable genuine suite failure without environment values', () => {
  const writes = []; const calls = [];
  const fs = { existsSync: () => true, mkdirSync: () => assert.fail('existing evidence'), writeFileSync: (...args) => writes.push(args) };
  const exec = (command, args) => command === 'git' && args[0] === 'rev-parse' ? `${SHA}\n` : command === 'git' ? '' : 'postgres (PostgreSQL) 17.2\n';
  const outcome = recordTestRun({ cwd: '/work', fs, exec, log: () => {}, spawn: (...args) => { calls.push(args); return { status: 1, stdout: tap, stderr: '' }; } });
  assert.equal(outcome.exitCode, 1); assert.equal(outcome.record.status, 'failed');
  assert.equal(outcome.path, '/work/evidence/test-run-0123456789ab.json');
  assert.deepEqual(calls[0][1], ['scripts/test.mjs', '--test-reporter=tap']);
  assert.deepEqual(calls[0][2].env.STATED_TEST_REQUIRE_PG, '1');
  assert.doesNotMatch(writes[0][1], /PATH|SECRET|STATED_TEST_REQUIRE_PG/);
  assert.equal(writes[0][2].flag, undefined);
});

test('records complete passes and marks cancellation or a nonzero child status as failure', () => {
  const fs = { existsSync: () => true, mkdirSync: () => {}, writeFileSync: () => {} };
  const exec = (command, args) => command === 'git' && args[0] === 'rev-parse' ? SHA : command === 'git' ? '' : 'postgres (PostgreSQL) 17';
  const order = [];
  const run = child => recordTestRun({ cwd: '/work', fs, log: () => {}, exec, now: () => { order.push('started'); return '2026-11-12T01:02:03.000Z'; }, spawn: (_bin, _args, options) => { order.push('suite'); assert.equal(options.maxBuffer, 16 * 1024 * 1024); return child; } });
  const passed = run({ status: 0, stdout: tap.replace('# pass 3', '# pass 4').replace('# fail 1', '# fail 0'), stderr: '' });
  assert.equal(passed.record.status, 'passed');
  assert.equal(passed.record.startedAt, '2026-11-12T01:02:03.000Z');
  assert.deepEqual(order.slice(0, 2), ['started', 'suite']);
  assert.equal(run({ status: 0, stdout: tap.replace('# pass 3', '# pass 2').replace('# cancelled 0', '# cancelled 1'), stderr: '' }).record.status, 'failed');
  assert.equal(run({ status: 1, stdout: tap.replace('# pass 3', '# pass 4').replace('# fail 1', '# fail 0'), stderr: '' }).record.status, 'failed');
});

test('fails closed for a missing PostgreSQL version, unavailable PostgreSQL, spawn errors, and incomplete TAP', () => {
  const fs = { existsSync: () => true, mkdirSync: () => {}, writeFileSync: () => {} };
  const run = ({ postgres = 'postgres (PostgreSQL) 17', child = { status: 0, stdout: tap, stderr: '' } } = {}) => recordTestRun({ cwd: '/work', fs, log: () => {}, exec: (command, args) => command === 'git' && args[0] === 'rev-parse' ? SHA : command === 'git' ? '' : postgres, spawn: () => child });
  assert.equal(run({ postgres: null }).record.status, 'incomplete');
  assert.equal(run({ child: { status: 1, stdout: '', stderr: 'PostgreSQL is required (STATED_TEST_REQUIRE_PG=1), but unavailable.' } }).record.status, 'incomplete');
  assert.equal(run({ child: { error: Error('spawn'), stdout: tap, stderr: '' } }).record.status, 'incomplete');
  assert.equal(run({ child: { status: 0, stdout: '# tests 1', stderr: '' } }).record.status, 'incomplete');
});

test('does not run the suite or write a record for a malformed commit', () => {
  let spawned = 0; let wrote = 0;
  const result = recordTestRun({ cwd: '/work', log: () => {}, fs: { existsSync: () => true, mkdirSync: () => {}, writeFileSync: () => wrote++ }, exec: () => 'bad', spawn: () => { spawned++; } });
  assert.equal(result.exitCode, 2); assert.equal(result.path, null); assert.equal(spawned, 0); assert.equal(wrote, 0);
});
