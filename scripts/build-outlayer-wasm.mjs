// Reproducible, offline release builds. No credential files or network calls.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, realpathSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(fileURLToPath(new URL('../', import.meta.url)));
const options = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!['--cargo-home', '--target-dir', '--wasm-opt'].includes(key) || !process.argv[i + 1] || options[key]) {
    throw new Error('Usage: node scripts/build-outlayer-wasm.mjs --cargo-home PATH --target-dir PATH [--wasm-opt PATH]');
  }
  options[key] = resolve(process.argv[i + 1]);
}
if (!options['--cargo-home'] || !options['--target-dir']) throw new Error('Both --cargo-home and --target-dir are required');
const cargoHome = options['--cargo-home'];
const targetDir = options['--target-dir'];
const localWasmOpt = join(root, 'outlayer/stated-jury/target/build-tools/binaryen/bin/wasm-opt');
const wasmOpt = options['--wasm-opt'] || (existsSync(localWasmOpt) ? localWasmOpt : 'wasm-opt');
const rustc = spawnSync('rustc', ['--version'], { encoding: 'utf8' });
if (rustc.status !== 0 || !/^rustc 1\.93\.1(?:\s|$)/.test(rustc.stdout)) throw new Error('rustc 1.93.1 is required');
const version = spawnSync(wasmOpt, ['--version'], { encoding: 'utf8' });
if (version.status !== 0 || version.stdout.trim() !== 'wasm-opt version 123 (version_123)') throw new Error('Binaryen wasm-opt version 123 is required');
console.log(`Optimizer: ${version.stdout.trim()}`);
mkdirSync(targetDir, { recursive: true });
// Cargo hashes the absolute package identity of local path dependencies into
// -C metadata before rustc can remap source filenames. That changes symbol and
// function ordering even when no builder paths remain in the final module.
// Normalize only these first-party crate identities; registry metadata must keep
// distinguishing different versions of a dependency with the same crate name.
const rustcWrapper = join(targetDir, 'outlayer-rustc-wrapper.cjs');
const localPackages = Object.fromEntries([
  ['stated-jury', 'outlayer/stated-jury'],
  ['stated-outlayer-referee', 'contracts/outlayer-referee'],
].map(([name, path]) => [name, realpathSync(join(root, path))]));
writeFileSync(rustcWrapper, `#!/usr/bin/env node
const { spawnSync } = require('node:child_process');
const { createHash } = require('node:crypto');
const { realpathSync } = require('node:fs');
const [compiler, ...args] = process.argv.slice(2);
const localPackages = ${JSON.stringify(localPackages)};
const packageName = process.env.CARGO_PKG_NAME;
if (localPackages[packageName] && realpathSync(process.env.CARGO_MANIFEST_DIR) === localPackages[packageName]) {
  const values = option => args.flatMap((arg, index) => arg === option ? [args[index + 1]] : arg.startsWith(option + '=') ? [arg.slice(option.length + 1)] : []);
  const identity = JSON.stringify({ packageName, version: process.env.CARGO_PKG_VERSION, crate: values('--crate-name'), kinds: values('--crate-type').sort(), target: values('--target'), cfg: values('--cfg').sort() });
  const metadata = createHash('sha256').update(identity).digest('hex').slice(0, 16);
  for (let index = 0; index < args.length; index++) {
    if (args[index] === '-C' && args[index + 1]?.startsWith('metadata=')) args[index + 1] = 'metadata=' + metadata;
  }
}
// Rustc inherits Cargo's jobserver descriptors. Preserve them through this
// wrapper so parallel compilation keeps Cargo's original concurrency bound.
const stdio = ['inherit', 'inherit', 'inherit'];
for (const match of (process.env.CARGO_MAKEFLAGS || '').matchAll(/--jobserver-(?:auth|fds)=(\\d+),(\\d+)/g)) {
  for (const descriptor of match.slice(1).map(Number)) {
    while (stdio.length <= descriptor) stdio.push('ignore');
    stdio[descriptor] = descriptor;
  }
}
const result = spawnSync(compiler, args, { stdio });
if (result.error) console.error(result.error.message);
process.exit(result.status ?? 1);
`);
chmodSync(rustcWrapper, 0o755);
const rustupHome = resolve(process.env.RUSTUP_HOME || join(homedir(), '.rustup'));
const mappings = new Map();
for (const [path, replacement] of [[root, '/source'], [cargoHome, '/cargo'], [rustupHome, '/rustup'], [targetDir, '/target']]) {
  mappings.set(resolve(path), replacement);
  try { mappings.set(realpathSync(path), replacement); } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
}
const flags = [...mappings].sort((a, b) => b[0].length - a[0].length)
  .map(([path, replacement]) => `--remap-path-prefix=${path}=${replacement}`);
const builds = [
  ['outlayer/stated-jury/Cargo.toml', 'wasm32-wasip2', 'stated-jury.wasm'],
  ['contracts/outlayer-referee/Cargo.toml', 'wasm32-unknown-unknown', 'stated_outlayer_referee.wasm'],
];
const artifacts = [];
for (const [manifest, target, name] of builds) {
  const cargoTarget = join(targetDir, 'cargo');
  const args = ['build', '--offline', '--locked', '--release', '--target', target, '--target-dir', cargoTarget, '--manifest-path', manifest];
  const buildFlags = target === 'wasm32-unknown-unknown' ? [...flags, '--cfg=near'] : flags;
  const env = { ...process.env, CARGO_HOME: cargoHome, RUSTC_WRAPPER: rustcWrapper, CARGO_ENCODED_RUSTFLAGS: buildFlags.join('\x1f') };
  const result = spawnSync('cargo', args, { cwd: root, env, stdio: 'inherit' });
  if (result.status !== 0) process.exit(result.status || 1);
  const path = join(targetDir, target, 'release', name);
  const pending = `${path}.pending`;
  const raw = join(cargoTarget, target, 'release', name);
  mkdirSync(join(targetDir, target, 'release'), { recursive: true });
  const rawContent = readFileSync(raw);
  const rawBytes = rawContent.length;
  try {
  if (target === 'wasm32-unknown-unknown') {
    const optimized = spawnSync(wasmOpt, ['--enable-bulk-memory', '--enable-bulk-memory-opt', '-Oz', '--gufa', '-Oz', '--converge', '--merge-similar-functions', raw, '-o', pending], { cwd: root, stdio: 'inherit' });
    if (optimized.status !== 0) throw new Error('wasm-opt failed');
  } else copyFileSync(raw, pending);
  const bytes = readFileSync(pending);
  console.log(`${name}: raw ${rawBytes} bytes; final ${bytes.length} bytes`);
  for (const forbidden of ['/Users/', '/home/', '/private/', '.cargo/registry', root]) {
    if (bytes.includes(Buffer.from(forbidden))) throw new Error(`Embedded local path ${forbidden} in ${name}`);
  }
  const validation = spawnSync('wasm-tools', ['validate', pending], { cwd: root, stdio: 'inherit' });
  if (validation.status !== 0) throw new Error(`Invalid WASM: ${name}`);
  if (target === 'wasm32-unknown-unknown') {
    const imports = WebAssembly.Module.imports(new WebAssembly.Module(bytes));
    for (const importName of ['sha256', 'panic_utf8']) {
      if (!imports.some(item => item.module === 'env' && item.name === importName)) throw new Error(`Missing env.${importName}`);
    }
    if (bytes.length > 300000) throw new Error(`Referee WASM exceeds 300000 bytes: ${bytes.length}`);
  }
  renameSync(pending, path);
  artifacts.push({ path, raw_bytes: rawBytes, raw_sha256: createHash('sha256').update(rawContent).digest('hex'), bytes: bytes.length, sha256: createHash('sha256').update(bytes).digest('hex') });
  } finally {
    rmSync(pending, { force: true });
  }
}
console.log(JSON.stringify(artifacts, null, 2));
