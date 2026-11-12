// INTEGRATION: Builds and deploys a locked testnet relay in one atomic transaction.
// STATED_PLAY_TREASURY / STATED_PLAY_TREASURY_KEY are read only from the environment.
// node scripts/deploy-jury-relay.mjs --name jury-relay [--dao DAO --escrow ESCROW --operator OPERATOR --window-seconds 600] [--yes]
import { createHash, randomBytes } from 'node:crypto';
import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';
import { HOSTED_COURT, flag, operatorError, requireTestnet, testnetAccount } from './create-court-dao.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const GAS = 100_000_000_000_000n;
export function relayInit({ dao = HOSTED_COURT.dao, escrow = HOSTED_COURT.escrow, operator = HOSTED_COURT.operator,
  windowSeconds = HOSTED_COURT.windowSeconds } = {}) {
  if (![dao, escrow, operator].every(testnetAccount)) throw new Error('DAO, escrow and operator must be .testnet accounts.');
  if (!Number.isSafeInteger(windowSeconds) || windowSeconds < 60 || windowSeconds > 86_400) throw new Error('Window must be an integer from 60 through 86400 seconds.');
  return { dao, escrow, operator, window_seconds: windowSeconds };
}
export function assertDeploymentConfig(config, init) {
  if (config?.dao !== init.dao || config?.escrow !== init.escrow || config?.operator !== init.operator
    || String(config?.window_ns) !== String(BigInt(init.window_seconds) * 1_000_000_000n)) {
    throw new Error('Deployed relay configuration differs from the requested initialization.');
  }
}

export async function buildRelay({ projectRoot = root, run = promisify(execFile), env = process.env } = {}) {
  // Cargo receives build settings, without the operator's signing credentials.
  const buildEnv = Object.fromEntries(['PATH', 'HOME', 'CARGO_HOME', 'RUSTUP_HOME', 'TMPDIR'].filter((k) => env[k]).map((k) => [k, env[k]]));
  await run('cargo', ['near', 'build', 'non-reproducible-wasm', '--locked', '--no-abi'], {
    cwd: resolve(projectRoot, 'contracts/jury-relay'), env: buildEnv, timeout: 300_000, maxBuffer: 4 * 1024 * 1024,
  });
  return readFile(resolve(projectRoot, 'contracts/jury-relay/target/near/stated_jury_relay.wasm'));
}

// No AddKey action exists. Initialization is in the same transaction as creation and code.
export function relayDeployActions(actions, { wasm, amountYocto, init = relayInit() }) {
  return [actions.createAccount(), actions.transfer(BigInt(amountYocto)), actions.deployContract(wasm),
    actions.functionCall('new', init, GAS, 0n)];
}

async function sendLocked({ parentId, secret, accountId, wasm, amountYocto, init }) {
  const { Account, FailoverRpcProvider, JsonRpcProvider, KeyPair, KeyPairSigner, actions } = await import('near-api-js');
  const { rpcUrls } = await import('../server/src/near-escrow.mjs');
  const provider = new FailoverRpcProvider(rpcUrls().map((url) => new JsonRpcProvider({ url })));
  const signer = new Account(parentId, provider, new KeyPairSigner(KeyPair.fromString(secret)));
  const result = await signer.signAndSendTransaction({ receiverId: accountId, actions: relayDeployActions(actions, { wasm, amountYocto, init }),
    waitUntil: 'FINAL', throwOnFailure: false });
  return { hash: result?.transaction?.hash, ok: result?.final_execution_status === 'FINAL' && typeof result?.status?.SuccessValue === 'string' };
}

export async function deployRelay({ argv = process.argv.slice(2), env = process.env, chain, query, build = buildRelay,
  send = sendLocked, encodeHash, log = console.log, projectRoot = root, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  requireTestnet(env);
  const parentId = env.STATED_PLAY_TREASURY;
  if (!testnetAccount(parentId)) throw new Error('STATED_PLAY_TREASURY must be a .testnet account.');
  const name = flag(argv, '--name') || `jury-relay-${randomBytes(4).toString('hex')}`;
  if (!/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name)) throw new Error('--name takes lowercase letters, digits and hyphens.');
  const accountId = `${name}.${parentId}`;
  if (!testnetAccount(accountId)) throw new Error('Relay account name exceeds the account-name limit.');
  const go = argv.includes('--yes') && !argv.includes('--dry-run');
  if (go && !env.STATED_PLAY_TREASURY_KEY) throw new Error('Set STATED_PLAY_TREASURY_KEY.');
  const window = flag(argv, '--window-seconds');
  if (window !== null && !/^\d+$/.test(window)) throw new Error('--window-seconds requires a whole number of seconds.');
  const init = relayInit({ dao: flag(argv, '--dao') || HOSTED_COURT.dao, escrow: flag(argv, '--escrow') || HOSTED_COURT.escrow,
    operator: flag(argv, '--operator') || HOSTED_COURT.operator, windowSeconds: window === null ? HOSTED_COURT.windowSeconds : Number(window) });
  const wasm = await build({ projectRoot, env });
  const digest = createHash('sha256').update(wasm).digest();
  const amountYocto = String(BigInt(wasm.length) * 10n ** 19n + 2n * 10n ** 23n);
  log(JSON.stringify({ network: 'testnet', parentId, accountId, wasmBytes: wasm.length, sha256: digest.toString('hex'), amountYocto,
    actions: ['CreateAccount', 'Transfer', 'DeployContract', 'FunctionCall:new'], accessKeys: 0, init }, null, 2));
  if (!go) { log('Dry run: build complete; nothing was sent. Pass --yes to deploy.'); return { dryRun: true, accountId, init, amountYocto }; }
  if (!chain) chain = (await import('../server/src/play.mjs')).nearChain();
  if (!query) query = (await import('../server/src/near-escrow.mjs')).rpc;
  if (!encodeHash) encodeHash = (await import('near-api-js')).baseEncode;
  if ((await chain.balance(accountId)) != null) throw new Error('Relay account already exists. Choose another --name.');
  const balance = await chain.balance(parentId);
  // A fixed additional test-NEAR reserve covers prepaid gas without float arithmetic.
  if (balance == null || BigInt(balance) < BigInt(amountYocto) + 10n ** 23n) throw new Error('Treasury lacks the deployment amount plus 0.1 test NEAR gas reserve.');
  const sent = await send({ parentId, secret: env.STATED_PLAY_TREASURY_KEY, accountId, wasm, amountYocto, init });
  if (!sent.ok || !sent.hash) throw new Error('Deployment did not reach final success. Inspect chain state before retrying.');
  let state; let keys; let config; let verified = false;
  for (let attempt = 0; attempt < 20; attempt += 1) {
    try {
      state = await query('query', { request_type: 'view_account', finality: 'final', account_id: accountId });
      keys = await query('query', { request_type: 'view_access_key_list', finality: 'final', account_id: accountId });
      config = await chain.view({ contractId: accountId, method: 'get_config' });
      assertDeploymentConfig(config, init);
      verified = state?.code_hash === encodeHash(digest) && Array.isArray(keys?.keys) && keys.keys.length === 0;
      if (verified) break;
    } catch { /* Finalized state may lag the transaction. */ }
    if (attempt < 19) await sleep(1000);
  }
  const deployedAt = new Date().toISOString();
  const evidence = { deployedAt, network: 'testnet', relay: accountId, paidBy: parentId, transaction: sent.hash,
    transactionUrl: `https://testnet.nearblocks.io/txns/${sent.hash}`, wasmBytes: wasm.length, wasmSha256: digest.toString('hex'),
    sentYocto: amountYocto, init, checks: { verified, codeMatchesTheBuild: state?.code_hash === encodeHash(digest), accessKeys: keys?.keys?.length ?? null, config } };
  const file = resolve(projectRoot, `evidence/jury-relay-deploy-testnet-${deployedAt.slice(0, 10).replaceAll('-', '')}.json`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`);
  log(`Evidence: ${file}`);
  if (!verified) throw new Error('Deployment verification failed. Do not harden the DAO or use this relay.');
  log(`STATED_COURT_RELAY=${accountId}`);
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  deployRelay().catch((error) => { console.error(operatorError(error)); process.exitCode = 1; });
}
