// Test the actual escrow source without modifying the escrow lane or calling NEAR.
import { spawnSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const scratch = mkdtempSync(join(tmpdir(), 'outlayer-escrow-window-'));
try {
  mkdirSync(join(scratch, 'src'));
  for (const name of ['Cargo.toml', 'Cargo.lock']) {
    writeFileSync(join(scratch, name), readFileSync(join(root, 'contracts/bilateral-escrow', name)));
  }
  const source = readFileSync(join(root, 'contracts/bilateral-escrow/src/lib.rs'), 'utf8');
  if (!source.includes('mod tests {') || !source.trimEnd().endsWith('}')) throw new Error('Escrow test module changed');
  const end = source.lastIndexOf('}');
  const test = `
    #[test]
    fn r3_escrow_accepts_yes_no_after_refund_floor_in_every_active_state() {
        for make in [refereed as fn() -> Contract, refereed_proposed, refereed_disputed] {
            for outcome in [Outcome::Yes, Outcome::No] {
                // Each case starts with empty chain storage; context changes
                // intentionally preserve storage within a single receipt flow.
                near_sdk::mock::with_mocked_blockchain(|chain| { chain.take_storage(); });
                let mut c = make();
                set(REFEREE_SIDE, RESOLVE + RESOLUTION_WINDOW_NS + 1, 0);
                c.referee_resolve(ID.into(), outcome);
                let b = c.get_bet(ID.into()).unwrap();
                assert_eq!(b.status, Status::Settled);
                let resolution = b.resolution.unwrap();
                assert_eq!(resolution.outcome, outcome);
                assert_eq!(resolution.method, ResolutionMethod::Referee);
                let yes = outcome == Outcome::Yes;
                assert_eq!(c.get_credit(account("alice")).0, if yes { STAKE * 2 } else { 0 });
                assert_eq!(c.get_credit(account("bob")).0, if yes { 0 } else { STAKE * 2 });
            }
        }
    }
`;
  writeFileSync(join(scratch, 'src/lib.rs'), source.slice(0, end) + test + source.slice(end));
  const run = spawnSync('cargo', ['test', '--offline', '--locked', '--manifest-path', join(scratch, 'Cargo.toml'),
    '--target-dir', join(root, 'contracts/outlayer-referee/target'), 'r3_escrow_accepts_', '--', '--test-threads=4'],
  { cwd: root, encoding: 'utf8', maxBuffer: 4_000_000 });
  process.stdout.write(run.stdout || '');
  if (run.status !== 0) {
    process.stderr.write(run.stderr || '');
    throw new Error(`Escrow window regression failed: ${run.status}`);
  }
  console.log('PASS: actual escrow source pays selected yes/no after seven days in accepted, proposed and disputed states (six cases). Local VM only.');
} finally {
  rmSync(scratch, { recursive: true, force: true });
}
