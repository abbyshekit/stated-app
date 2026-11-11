// INTEGRATION: Explicitly invoked. Deploys the version 2 escrow as an account
// under the treasury's name, with its code and no access key, in one
// transaction. Nobody, the operator included, can afterwards replace the code
// or sign for the contract.
//
// It reads the same settings the server does and prints no secret:
//   STATED_NEAR_NETWORK        testnet (default) or mainnet
//   STATED_MAINNET=real-funds  required on mainnet
//   STATED_PLAY_TREASURY       the account that pays, for example stated.near
//   STATED_PLAY_TREASURY_KEY   its full-access key (ed25519:…)
//
//   node scripts/deploy-escrow.mjs                 says what it would do and what it costs; sends nothing
//   node scripts/deploy-escrow.mjs --yes           does it
//   node scripts/deploy-escrow.mjs --name escrow   names the account escrow.<treasury> instead of escrow-<random>
//
// Build the contract first:
//   (cd contracts/bilateral-escrow && cargo near build non-reproducible-wasm --locked --no-abi)
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { baseEncode } from 'near-api-js';
import Decimal from 'decimal.js';
import { assertNetworkConfig, loadConfig } from '../server/src/config.mjs';
import { contractVersion, gasPurchasePrice, NEAR_CALL_GAS, rpc } from '../server/src/near-escrow.mjs';
import { accountLink, isNamedAccount, network, transactionLink } from '../server/src/near-network.mjs';
import { near, nearChain } from '../server/src/play.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wasmPath = resolve(root, 'contracts/bilateral-escrow/target/near/stated_bilateral_escrow.wasm');
const args = process.argv.slice(2);
const go = args.includes('--yes');
const named = args.includes('--name') ? args[args.indexOf('--name') + 1] : null;
const fail = (message) => { console.error(message); process.exit(1); };

const config = loadConfig({ ...process.env, STATED_NEAR_CONTRACT: '', STATED_PLAY: '' });
try { assertNetworkConfig(config); } catch (error) { fail(error.message); }
const net = network();
const treasury = config.play.treasury;
const key = config.play.treasuryKey;
if (!treasury || !key) fail('Set STATED_PLAY_TREASURY and STATED_PLAY_TREASURY_KEY to the account that pays for the deployment.');
if (!isNamedAccount(treasury)) fail(`STATED_PLAY_TREASURY must be a .${net.suffix} account on ${net.id}.`);
if (named && !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(named)) fail('--name takes lowercase letters, digits and hyphens.');

let wasm;
try { wasm = await readFile(wasmPath); } catch { fail(`No contract build at ${wasmPath}. Build it first (see the top of this file).`); }
const sha256 = createHash('sha256').update(wasm).digest();
const contract = `${named || `escrow-${randomBytes(4).toString('hex')}`}.${treasury}`;
if (contract.length > 64) fail(`${contract} is longer than an account name may be.`);

// An account locks 0.00001 NEAR for every byte it stores. The contract's code is nearly all of
// that; 0.2 NEAR on top covers the account record and its first state. Each Bet then pays its own storage.
const storageYocto = new Decimal(wasm.length).mul('1e19');
const amountYocto = storageYocto.plus('2e23').toFixed(0);

const chain = nearChain();
const balance = await chain.balance(treasury);
if (balance == null) fail(`${treasury} does not exist on ${net.id}.`);
if ((await chain.balance(contract)) != null) fail(`${contract} already exists. Choose another --name.`);

console.log(`Network          ${net.name}${net.real ? '  (real NEAR)' : ''}`);
console.log(`Pays             ${treasury}, which holds ${near(balance)} NEAR`);
console.log(`New contract     ${contract}`);
console.log(`Code             ${wasm.length} bytes, sha256 ${sha256.toString('hex')}`);
console.log(`Sent with it     ${near(amountYocto)} NEAR (${near(storageYocto.toFixed(0))} locked by the code's size, 0.2 for the account), plus a network fee of a few thousandths`);
console.log('Access keys      none: the code can never be replaced and nobody can sign for the contract');
const minimum = BigInt(amountYocto) + NEAR_CALL_GAS * await gasPurchasePrice() + 2n * 10n ** 22n;
if (BigInt(balance) < minimum) fail(`${treasury} needs at least ${near(minimum.toString())} NEAR for the deposit and prepaid fees.`);
if (!go) {
  console.log('\nNothing was sent. Run again with --yes to deploy.');
  process.exit(0);
}

const sent = await chain.deployLocked({ parentId: treasury, parentSecret: key, accountId: contract, wasm, amountYocto });
if (!sent.ok) fail(`The deployment did not go through: ${sent.failure || 'not accepted'}${sent.hash ? `\n${transactionLink(sent.hash)}` : ''}`);

// A node can answer from a block just before the deployment, so ask until it has caught up.
let state = null; let keys = null;
for (let i = 0; i < 20; i += 1) {
  try {
    state = await rpc('query', { request_type: 'view_account', finality: 'final', account_id: contract });
    keys = await rpc('query', { request_type: 'view_access_key_list', finality: 'final', account_id: contract });
    if (state.code_hash === baseEncode(sha256)) break;
  } catch { /* not visible yet */ }
  await new Promise((ok) => setTimeout(ok, 1000));
}
const checks = {
  codeMatchesTheBuild: state?.code_hash === baseEncode(sha256),
  accessKeys: keys?.keys?.length ?? null,
  version: await contractVersion(contract),
};
const good = checks.codeMatchesTheBuild && checks.accessKeys === 0 && checks.version === 2;
const evidence = { deployedAt: new Date().toISOString(), network: net.id, contract, paidBy: treasury, transaction: sent.hash,
  transactionUrl: transactionLink(sent.hash), contractUrl: accountLink(contract), wasmBytes: wasm.length, wasmSha256: sha256.toString('hex'),
  sentYocto: amountYocto, checks };
const evidencePath = resolve(root, `evidence/escrow-deploy-${net.id}-${evidence.deployedAt.slice(0, 10).replaceAll('-', '')}.json`);
await mkdir(dirname(evidencePath), { recursive: true });
await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`\nDeployed in ${transactionLink(sent.hash)}`);
console.log(`Checked on chain: code matches the build ${checks.codeMatchesTheBuild}, access keys ${checks.accessKeys}, version ${checks.version}`);
console.log(`Recorded in ${evidencePath}`);
if (!good) fail('One of the checks did not pass. Do not use this contract until it is understood.');
console.log(`\nSTATED_NEAR_CONTRACT=${contract}`);
