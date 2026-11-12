// `npm test`. Runs the whole suite when a throwaway PostgreSQL cluster can start here. Where one
// cannot (initdb or pg_ctl missing, or a sandbox that blocks the cluster's shared memory or socket),
// it runs the test files that need no database and says which files it skipped and why, instead of
// failing every server test at setup. STATED_TEST_REQUIRE_PG=1 turns a missing database into an error.
import { spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startPostgres } from '../server/test/support/pg.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const ROOT_FILES = ['score.test.mjs', 'domain.test.mjs', 'xpost.test.mjs', 'sim.test.mjs'];
const serverFiles = readdirSync(join(root, 'server/test')).filter(name => name.endsWith('.test.mjs')).sort()
  .map(name => `server/test/${name}`);
const scriptFiles = readdirSync(join(root, 'scripts')).filter(name => name.endsWith('.test.mjs')).sort()
  .map(name => `scripts/${name}`);
const files = [...ROOT_FILES, ...serverFiles, ...scriptFiles];

// A file needs a database when it starts the app stack or a cluster of its own.
const needsDatabase = text => /support\/(?:app|pg)\.mjs['"]/.test(text);

async function postgresProblem() {
  try {
    const pg = await startPostgres();
    pg.stop();
    return null;
  } catch (error) {
    if (error.code === 'ENOENT') return `${error.path} is not on PATH`;
    return `a throwaway cluster did not start (${String(error.message).split('\n')[0]})`;
  }
}

const problem = await postgresProblem();
if (problem && process.env.STATED_TEST_REQUIRE_PG === '1') {
  console.error(`PostgreSQL is required (STATED_TEST_REQUIRE_PG=1), but ${problem}.`);
  process.exit(1);
}
const run = problem ? files.filter(file => !needsDatabase(readFileSync(join(root, file), 'utf8'))) : files;
const skipped = files.length - run.length;
const why = `PostgreSQL is unavailable here: ${problem}.`;
const need = 'need PostgreSQL 15+ with initdb and pg_ctl on PATH';
if (problem) console.log(`${why} Running the ${run.length} test files that need no database; skipping the ${skipped} that ${need}.\n`);
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...process.argv.slice(2), ...run],
  { cwd: root, stdio: 'inherit' });
if (problem) {
  const names = files.filter(file => !run.includes(file));
  console.log(`\n${why} Ran the ${run.length} test files that need no database; skipped the ${skipped} that ${need}:\n  ${names.join('\n  ')}`);
}
process.exit(result.status ?? 1);
