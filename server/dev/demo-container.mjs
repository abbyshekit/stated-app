#!/usr/bin/env node
// Entry point for `docker compose up`: starts the simulated-X demo, seeds it
// once with labelled test fixtures, and stays up. A restart with the same
// volumes finds the fixtures already there and does not seed again.
import { spawn } from 'node:child_process';
import { resolve } from 'node:path';

const here = import.meta.dirname;
const APP = `http://127.0.0.1:${process.env.PORT || 4310}`;
const demo = spawn(process.execPath, [resolve(here, 'simulated-x.mjs')], { stdio: 'inherit' });
for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => demo.kill(signal));
demo.on('exit', (code) => process.exit(code ?? 0));

const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
let up = false;
for (let i = 0; i < 120 && !up; i += 1) {
  try { up = (await fetch(`${APP}/healthz`)).ok; } catch { /* not listening yet */ }
  if (!up) await sleep(500);
}
if (!up) {
  console.error('The demo did not start. See the lines above.');
  demo.kill('SIGTERM');
} else if ((await fetch(`${APP}/u/sim_carol`)).status === 200) {
  console.log('Ready: Test fixtures already present. Check testnet escrow separately at http://127.0.0.1:4310/demo-readiness.');
} else {
  const seed = spawn(process.execPath, [resolve(here, 'seed-demo.mjs')], { stdio: 'inherit', env: { ...process.env, SEED_APP: APP } });
  seed.on('exit', (code) => console.log(code === 0
    ? 'Ready: http://127.0.0.1:4310 (Stated) and http://127.0.0.1:4311 (simulated X). Check testnet escrow separately at http://127.0.0.1:4310/demo-readiness.'
    : `Seeding stopped with code ${code}; the demo is still running without fixtures.`));
}
