// Starts a throwaway Postgres cluster for one test file. Requires initdb and
// pg_ctl on PATH (Homebrew postgresql@17 provides both).

import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

function freePort() {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address();
      server.close(() => resolve(port));
    });
    server.on('error', reject);
  });
}

// Postgres refuses to start in a shell with no usable locale (macOS reports "postmaster became
// multithreaded during startup"). The tests never depend on collation, so they pin C.
const pgEnv = { ...process.env, LC_ALL: 'C' };

export async function startPostgres() {
  const dir = mkdtempSync(join(tmpdir(), 'stated-pg-'));
  const data = join(dir, 'data');
  execFileSync('initdb', ['-D', data, '-A', 'trust', '-U', 'postgres', '-E', 'UTF8', '--locale=C', '--no-sync'], { stdio: 'ignore', env: pgEnv });
  const port = await freePort();
  execFileSync('pg_ctl', [
    '-D', data,
    '-o', `-p ${port} -c listen_addresses=127.0.0.1 -k ${dir} -c fsync=off`,
    '-l', join(dir, 'log'),
    '-w', 'start',
  ], { stdio: 'ignore', env: pgEnv });
  return {
    url: `postgres://postgres@127.0.0.1:${port}/postgres`,
    stop() {
      try {
        execFileSync('pg_ctl', ['-D', data, '-m', 'immediate', '-w', 'stop'], { stdio: 'ignore', env: pgEnv });
      } finally {
        rmSync(dir, { recursive: true, force: true });
      }
    },
  };
}

export async function resetDb(db) {
  await db.query(`
    truncate users, account_events, sessions, oauth_states, bot_credentials, kv, sources, statements,
      saves, visibility_events, revisions, correction_requests, mention_events, url_intakes, dm_events,
      inbox, visits restart identity cascade`);
}
