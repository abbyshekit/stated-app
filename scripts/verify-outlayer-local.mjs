// Local-only release checks. Does not load credential files or call any service.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
if (process.argv.length !== 2 && (process.argv.length !== 4 || process.argv[2] !== '--wasm-opt')) throw new Error('Usage: node scripts/verify-outlayer-local.mjs [--wasm-opt PATH]');
const wasmOptArgs = process.argv.length === 4 ? ['--wasm-opt', resolve(process.argv[3])] : [];
const jury = 'outlayer/stated-jury/Cargo.toml';
const referee = 'contracts/outlayer-referee/Cargo.toml';
const steps = [];
for (const manifest of [jury,referee]) {
  steps.push(['cargo',['test','--offline','--locked','--manifest-path',manifest]]);
  steps.push(['cargo',['clippy','--offline','--locked','--all-targets','--manifest-path',manifest,'--','-D','warnings']]);
  steps.push(['cargo',['fmt','--manifest-path',manifest,'--','--check']]);
}
steps.push(['cargo',['test','--offline','--locked','--no-default-features','--lib','--manifest-path',jury]]);
steps.push(['cargo',['clippy','--offline','--locked','--no-default-features','--lib','--manifest-path',jury,'--','-D','warnings']]);
steps.push(['cargo',['clippy','--offline','--locked','--release','--target','wasm32-wasip2','--bin','stated-jury','--manifest-path',jury,'--','-D','warnings']]);
steps.push(['node',['scripts/verify-outlayer-parity.mjs']]);
steps.push(['node',['scripts/verify-outlayer-escrow-window.mjs']]);
const temp = mkdtempSync(join(tmpdir(), 'outlayer-verify-'));
const cargoHome = resolve(process.env.CARGO_HOME || join(homedir(), '.cargo'));
const secondCargoHome = join(temp, 'cargo-home');
const targets = [join(temp, 'target-one'), join(temp, 'target-two')];
const sourceRoots = [join(temp, 'source-a'), join(temp, 'source-with-a-longer-checkout-name')];
const localWasmOpt = join(root, 'outlayer/stated-jury/target/build-tools/binaryen/bin/wasm-opt');
const buildWasmOptArgs = wasmOptArgs.length ? wasmOptArgs : existsSync(localWasmOpt) ? ['--wasm-opt', realpathSync(localWasmOpt)] : [];
try {
  // Copy source inputs only: build artifacts and credential files never enter either checkout.
  for (const sourceRoot of sourceRoots) {
    for (const crate of ['outlayer/stated-jury', 'contracts/outlayer-referee']) {
      for (const input of ['Cargo.toml', 'Cargo.lock', 'src', 'examples']) {
        const source = join(root, crate, input);
        if (existsSync(source)) cpSync(source, join(sourceRoot, crate, input), { recursive: true, dereference: true });
      }
    }
    mkdirSync(join(sourceRoot, 'scripts'), { recursive: true });
    copyFileSync(join(root, 'scripts/build-outlayer-wasm.mjs'), join(sourceRoot, 'scripts/build-outlayer-wasm.mjs'));
  }
  // The index is only metadata. Dependency sources must be independent copies.
  const registry = join(cargoHome, 'registry');
  const secondRegistry = join(secondCargoHome, 'registry');
  mkdirSync(secondRegistry, { recursive: true });
  symlinkSync(join(registry, 'index'), join(secondRegistry, 'index'), 'dir');
  for (const name of ['src', 'cache']) {
    const source = join(registry, name);
    if (existsSync(source)) cpSync(source, join(secondRegistry, name), { recursive: true, dereference: true });
  }
  for (const [index, home] of [cargoHome, secondCargoHome].entries()) {
    steps.push(['node',[join(sourceRoots[index], 'scripts/build-outlayer-wasm.mjs'),'--cargo-home',home,'--target-dir',targets[index],...buildWasmOptArgs], undefined, sourceRoots[index]]);
  }
  steps.push(['cargo',['build','--offline','--locked','--no-default-features','--example','core-hash-probe','--target','wasm32-unknown-unknown','--target-dir',join(temp,'probe'),'--manifest-path',jury], { ...process.env, CARGO_ENCODED_RUSTFLAGS:'--cfg=near' }]);
const artifactNames = ['wasm32-wasip2/release/stated-jury.wasm', 'wasm32-unknown-unknown/release/stated_outlayer_referee.wasm'];
for (const target of targets) for (const file of artifactNames) steps.push(['wasm-tools',['validate',join(target,file)]]);
const commands=[];
for (const [command,args,env,cwd = root] of steps) {
  console.log(`Running: ${command} ${args.join(' ')}`);
  const result=spawnSync(command,args,{cwd,env,encoding:'utf8',maxBuffer:16_000_000});
  const output=`${result.stdout||''}${result.stderr||''}`;
  commands.push({command,args,cwd,exit_code:result.status,output});
  if (result.status!==0) { process.stderr.write(output); throw new Error(`${command} failed with status ${result.status}`); }
  const checks=output.split('\n').filter(l=>l.includes('test result:')||l.startsWith('PASS:'));
  if(checks.length) console.log(checks.join('\n'));
}
const probeBytes = readFileSync(join(temp,'probe','wasm32-unknown-unknown','debug','examples','core-hash-probe.wasm'));
const probeModule = new WebAssembly.Module(probeBytes);
if (!WebAssembly.Module.imports(probeModule).some(item => item.module === 'env' && item.name === 'sha256')) throw new Error('core_hash_probe: missing env.sha256');
let probeInstance;
let digest;
const checkRegister = register => {
  if (BigInt.asUintN(64, register) !== (1n << 64n) - 3n) throw new Error('core_hash_probe: incorrect scratch register');
};
const probe = new WebAssembly.Instance(probeModule, { env: {
  sha256(length, pointer, register) {
    checkRegister(register);
    const bytes = new Uint8Array(probeInstance.exports.memory.buffer, Number(pointer), Number(length));
    digest = createHash('sha256').update(bytes).digest();
  },
  read_register(register, pointer) {
    checkRegister(register);
    if (!digest) throw new Error('core_hash_probe: empty register');
    new Uint8Array(probeInstance.exports.memory.buffer, Number(pointer), digest.length).set(digest);
  },
} });
probeInstance = probe;
const pointer = probe.exports.core_hash_probe();
const result = Buffer.from(probe.exports.memory.buffer, pointer, 64).toString('ascii');
if (result !== '018f2d26dc2fda19fd81ffcc199c81b98d1744d70db1a414862e539f93328a32') throw new Error(`core_hash_probe: incorrect hash ${result}`);
console.log('PASS: core_hash_probe');
const artifacts = artifactNames.map((path, index) => {
  const rawFirst = readFileSync(join(targets[0], 'cargo', path));
  const rawSecond = readFileSync(join(targets[1], 'cargo', path));
  if (!rawFirst.equals(rawSecond)) throw new Error(`Non-reproducible raw WASM before optimization: ${path}`);
  const first = readFileSync(join(targets[0], path));
  const second = readFileSync(join(targets[1], path));
  if (!first.equals(second)) throw new Error(`Non-reproducible WASM: ${path}`);
  for (const bytes of [first, second]) {
    for (const forbidden of ['/Users/', '/home/', '/private/', '.cargo/registry', root]) {
      if (bytes.includes(Buffer.from(forbidden))) throw new Error(`Embedded local path ${forbidden} in ${path}`);
    }
    if (path.includes('stated_outlayer_referee')) {
      const imports = WebAssembly.Module.imports(new WebAssembly.Module(bytes));
      for (const name of ['sha256', 'panic_utf8']) {
        if (!imports.some(item => item.module === 'env' && item.name === name)) throw new Error(`near_host_imports: missing env.${name}`);
      }
    }
  }
  if (path.includes('stated_outlayer_referee') && first.length > 300000) throw new Error(`Referee WASM exceeds 300000 bytes: ${first.length}`);
  const published = join(index === 0 ? 'outlayer/stated-jury/target/reproducible' : 'contracts/outlayer-referee/target/reproducible', path);
  return {path:published,raw_bytes:rawFirst.length,raw_sha256:createHash('sha256').update(rawFirst).digest('hex'),bytes:first.length,sha256:createHash('sha256').update(first).digest('hex')};
});
for (const check of ['reproducible_wasm_artifacts', 'no_builder_paths', 'referee_size_limit', 'near_host_imports']) console.log(`PASS: ${check}`);
for (let i = 0; i < artifacts.length; i++) {
  const destination = join(root, artifacts[i].path);
  mkdirSync(dirname(destination), { recursive: true });
  copyFileSync(join(targets[0], artifactNames[i]), destination);
}
const record={observed_at:new Date().toISOString(),status:'PASS',live_execution_verified:false,
  network_calls:'none by this runner; dependency reads are offline',
  reproducibility:{source_checkouts:2,different_checkout_path_lengths:true,cargo_homes:2,target_directories:2,raw_byte_identical:true,byte_identical:true,local_path_scan:'PASS',referee_max_bytes:300000,near_host_imports:'PASS'},
  rustc:spawnSync('rustc',['--version'],{encoding:'utf8'}).stdout.trim(),
  artifacts,commands};
// Evidence is published: replace this checkout's absolute path (which names the local account) with <repo>.
const repoRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '');
let scrubbed = JSON.stringify(record, null, 2);
for (const [path, replacement] of [[repoRoot, '<repo>'], [temp, '<temporary>'], [cargoHome, '<cargo-home>'], [homedir(), '<home>']]) {
  for (const spelling of new Set([path, realpathSync(path)])) scrubbed = scrubbed.split(spelling).join(replacement);
}
writeFileSync(new URL('../evidence/outlayer-local-validation.json',import.meta.url),scrubbed+'\n');
console.log(JSON.stringify(record.artifacts,null,2));
console.log('PASS: local tests, strict clippy, formatting, identical raw and final path-free WASM builds from two copied checkouts, referee size limit, WASM validation and JS parity. No deployment, transactions or live model calls.');
} finally {
  rmSync(temp, { recursive: true, force: true });
}
