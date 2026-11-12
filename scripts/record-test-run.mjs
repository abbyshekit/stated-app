// INTEGRATION: records a fail-closed, secret-free result from the complete PostgreSQL test suite.
import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const number = (text, label) => {
  const match = new RegExp(`^# ${label} (\\d+(?:\\.\\d+)?)$`, 'm').exec(text);
  return match ? Number(match[1]) : null;
};

export function parseTap(text) {
  const tests = number(text, 'tests');
  const pass = number(text, 'pass');
  const fail = number(text, 'fail');
  const cancelled = number(text, 'cancelled');
  const skip = number(text, 'skipped');
  const todo = number(text, 'todo');
  const durationMs = number(text, 'duration_ms');
  if (![tests, pass, fail, cancelled, skip, todo, durationMs].every(Number.isFinite) || !Number.isInteger(tests) || !Number.isInteger(pass) || !Number.isInteger(fail) || !Number.isInteger(cancelled) || !Number.isInteger(skip) || !Number.isInteger(todo) || pass + fail + cancelled + skip + todo !== tests) return null;
  return { tests, pass, fail, cancelled, skip, todo, durationMs };
}

function version(command, args, exec, cwd) {
  try {
    const output = exec(command, args, { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } });
    return typeof output === 'string' && output.trim() ? output.trim() : null;
  } catch { return null; }
}

function worktreeDirty(exec, cwd) {
  try { return Boolean(String(exec('git', ['status', '--porcelain'], { cwd, encoding: 'utf8', env: { PATH: process.env.PATH ?? '' } })).trim()); } catch { return true; }
}

export function updateLatestRecord(cwd, filename, status, fs = { readFileSync, writeFileSync }) {
  const readme = resolve(cwd, 'README.md');
  const text = fs.readFileSync(readme, 'utf8');
  const marker = /^<!-- test-run-record -->.*$/m;
  if (!marker.test(text)) throw new Error('README test-run record marker is missing');
  fs.writeFileSync(readme, text.replace(marker, `<!-- test-run-record -->Latest full-suite record: [${filename}](evidence/${filename}) (${status}).`));
}

export function recordTestRun({ spawn = spawnSync, exec = execFileSync, fs = { existsSync, mkdirSync, writeFileSync }, cwd = root, now = () => new Date().toISOString(), log = console.log, updateLatest = updateLatestRecord } = {}) {
  const commit = version('git', ['rev-parse', 'HEAD'], exec, cwd);
  if (!/^[0-9a-f]{40}$/i.test(commit ?? '')) {
    log('test run: incomplete (cannot determine a 40-character commit)');
    return { exitCode: 2, path: null, record: { commit: null, status: 'incomplete' } };
  }
  const shortCommit = commit.slice(0, 12);
  const node = process.version;
  const postgres = version('postgres', ['--version'], exec, cwd);
  const startedAt = now();
  const dirty = worktreeDirty(exec, cwd);
  const child = spawn(process.execPath, ['scripts/test.mjs', '--test-reporter=tap'], {
    cwd, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024, env: { PATH: process.env.PATH ?? '', STATED_TEST_REQUIRE_PG: '1' },
  });
  if (child.stdout) process.stdout.write(child.stdout);
  if (child.stderr) process.stderr.write(child.stderr);
  const combined = `${child.stdout ?? ''}\n${child.stderr ?? ''}`;
  const counts = parseTap(combined);
  const pgUnavailable = /PostgreSQL is required \(STATED_TEST_REQUIRE_PG=1\)/.test(combined);
  const complete = !child.error && !child.signal && postgres && !pgUnavailable && counts;
  const status = !complete ? 'incomplete' : child.status === 0 && counts.tests > 0 && counts.fail === 0 && counts.cancelled === 0 ? 'passed' : 'failed';
  const record = { commit, worktreeDirty: dirty, node, postgres, startedAt, status, counts, durationMs: counts?.durationMs ?? null };
  const evidenceDir = resolve(cwd, 'evidence');
  const path = resolve(evidenceDir, `test-run-${shortCommit}.json`);
  if (!fs.existsSync(evidenceDir)) fs.mkdirSync(evidenceDir, { recursive: true });
  fs.writeFileSync(path, `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8' });
  if (complete) updateLatest(cwd, `test-run-${shortCommit}.json`, status);
  log(`test run: ${status} (${path})`);
  return { exitCode: status === 'passed' ? 0 : status === 'incomplete' ? 2 : 1, path, record };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = recordTestRun().exitCode;
}
