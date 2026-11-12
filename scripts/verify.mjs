// INTEGRATION: runs the public verification commands without loading any env file.
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

export const verificationSteps = Object.freeze([
  { name: 'offline enclave ruling', script: 'scripts/verify-enclave-ruling.mjs', args: ['--offline', 'evidence/enclave-ruling-3668aa04.json'], offline: true },
  { name: 'live enclave ruling', script: 'scripts/verify-enclave-ruling.mjs', args: [] },
  { name: 'live hosted payout', script: 'scripts/verify-hosted-payout.mjs', args: ['evidence/hosted-court-payout-testnet-20261112.json'] },
]);

function resultFor(step, child) {
  if (child.error) return { step, state: 'FAIL', exitCode: 1, detail: `spawn error: ${child.error.message}` };
  if (child.signal) return { step, state: 'FAIL', exitCode: 1, detail: `terminated by ${child.signal}` };
  if (child.status === 0) return { step, state: 'PASS', exitCode: 0, detail: 'exit 0' };
  if (child.status === 2 && step.offline) return { step, state: 'EXPECTED INCOMPLETE', exitCode: 0, detail: 'exit 2 expected for offline evidence' };
  if (child.status === 2) return { step, state: 'INCOMPLETE', exitCode: 2, detail: 'exit 2; live verification incomplete' };
  return { step, state: 'FAIL', exitCode: 1, detail: `exit ${child.status ?? 'unknown'}` };
}

export function runVerifications({ argv = process.argv.slice(2), spawn = spawnSync, log = console.log, cwd = root } = {}) {
  if (argv.length > 1 || (argv.length === 1 && argv[0] !== '--offline')) {
    log('final: FAIL (usage: verify.mjs [--offline])');
    return { exitCode: 1, steps: [] };
  }
  const steps = argv[0] === '--offline' ? verificationSteps.slice(0, 1) : verificationSteps;
  const results = steps.map(step => {
    const child = spawn(process.execPath, [step.script, ...step.args], { cwd, stdio: 'inherit' });
    const result = resultFor(step, child);
    log(`${step.name}: ${result.state} (${result.detail})`);
    return result;
  });
  const exitCode = results.some(result => result.exitCode === 1) ? 1 : results.some(result => result.exitCode === 2) ? 2 : 0;
  const final = exitCode === 0 ? 'PASS' : exitCode === 2 ? 'INCOMPLETE' : 'FAIL';
  log(`final: ${final} (${results.length} verification step${results.length === 1 ? '' : 's'})`);
  return { exitCode, steps: results };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = runVerifications().exitCode;
}
