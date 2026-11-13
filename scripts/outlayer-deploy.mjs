// INTEGRATION: Atomic, keyless referee deployment; review the full preview before sending.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const GAS = 100_000_000_000_000n;
const NETWORKS = {
  testnet: { suffix: '.testnet', outlayer: 'outlayer.testnet', rpc: 'https://rpc.testnet.near.org' },
  mainnet: { suffix: '.near', outlayer: 'outlayer.near', rpc: 'https://rpc.mainnet.near.org' },
};
const OPTIONS = new Set(['network', 'rpc', 'parent', 'account', 'wasm', 'referee-wasm', 'referee-hash', 'jury-wasm', 'jury-hash', 'escrow', 'wasm-url', 'wasm-hash',
  'secrets-owner', 'secrets-profile', 'amount-yocto', 'key-file']);

export function parseOptions(argv) {
  const options = {};
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (token === '--yes') {
      if (options.yes) throw new Error('Duplicate --yes.');
      options.yes = true;
      continue;
    }
    const name = token.startsWith('--') ? token.slice(2) : '';
    if (!OPTIONS.has(name) || Object.hasOwn(options, name) || !argv[i + 1] || argv[i + 1].startsWith('--')) {
      throw new Error('Invalid, duplicate or missing option value.');
    }
    options[name] = argv[++i];
  }
  return options;
}

export function validAccount(id, suffix) {
  return typeof id === 'string' && id.length >= 2 && id.length <= 64 && id.endsWith(suffix)
    && /^[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*$/.test(id);
}

export function networkOptions(name, rpc) {
  const defaults = NETWORKS[name];
  if (!defaults) throw new Error('--network must be testnet or mainnet.');
  let url;
  try { url = new URL(rpc ?? defaults.rpc); } catch { throw new Error('--rpc must be an HTTP or HTTPS URL.'); }
  if (!['https:', 'http:'].includes(url.protocol) || !url.hostname || url.username || url.password
    || (rpc ?? defaults.rpc).length > 2048) throw new Error('--rpc must be an HTTP or HTTPS URL without credentials.');
  return { ...defaults, rpc: rpc ?? defaults.rpc };
}

export function validateOptions(options) {
  const network = networkOptions(options.network, options.rpc);
  for (const name of ['parent', 'account', 'escrow', 'secrets-owner']) {
    if (!validAccount(options[name], network.suffix)) throw new Error(`--${name} must be a valid ${options.network} account.`);
  }
  const prefix = options.account.slice(0, -(options.parent.length + 1));
  if (!options.account.endsWith(`.${options.parent}`) || !prefix || prefix.includes('.')) {
    throw new Error('--account must be a direct child of --parent.');
  }
  if (options.wasm && options['referee-wasm']) throw new Error('Use only one referee WASM path flag.');
  if (options['wasm-hash'] && options['jury-hash']) throw new Error('Use only one jury hash flag.');
  const refereeWasm = options['referee-wasm'] || options.wasm;
  const juryHash = options['jury-hash'] || options['wasm-hash'];
  if (!refereeWasm || !options['jury-wasm']) throw new Error('Referee and jury WASM paths are required.');
  if (!/^[0-9a-f]{64}$/.test(options['referee-hash'] || '')) throw new Error('--referee-hash must be lowercase SHA256 hex.');
  if (!/^[0-9a-f]{64}$/.test(juryHash || '')) throw new Error('--jury-hash must be lowercase SHA256 hex.');
  let url;
  try { url = new URL(options['wasm-url']); } catch { throw new Error('--wasm-url must be an HTTPS URL.'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || options['wasm-url'].length > 2048) {
    throw new Error('--wasm-url must be an HTTPS URL without credentials.');
  }
  const profile = options['secrets-profile'] ?? 'jury';
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(profile)) throw new Error('Invalid --secrets-profile.');
  if (!/^[1-9][0-9]*$/.test(options['amount-yocto'] || '') || BigInt(options['amount-yocto']) >= 2n ** 128n) {
    throw new Error('--amount-yocto must be a positive u128 integer.');
  }
  if (options.yes && !options['key-file']) throw new Error('--key-file is required with --yes.');
  return { network, init: { escrow: options.escrow, outlayer: network.outlayer, wasm_url: options['wasm-url'],
    wasm_hash: juryHash, secrets_owner: options['secrets-owner'], secrets_profile: profile }, refereeWasm };
}

export function deployActions(actions, { wasm, amountYocto, init }) {
  return [actions.createAccount(), actions.transfer(BigInt(amountYocto)), actions.deployContract(wasm),
    actions.functionCall('new', init, GAS, 0n)];
}

export function buildPreview(options, wasm, init) {
  if (wasm.length < 8 || !wasm.subarray(0, 8).equals(Buffer.from([0, 97, 115, 109, 1, 0, 0, 0]))) {
    throw new Error('Referee WASM must have the core WebAssembly header.');
  }
  return { network: options.network, signer_id: options.parent, receiver_id: options.account,
    actions: [{ type: 'CreateAccount' }, { type: 'Transfer', deposit: options['amount-yocto'] },
      { type: 'DeployContract', code_base64: wasm.toString('base64'), sha256: createHash('sha256').update(wasm).digest('hex') },
      { type: 'FunctionCall', method_name: 'new', args_base64: Buffer.from(JSON.stringify(init)).toString('base64'),
        args: init, gas: GAS.toString(), deposit: '0' }] };
}

async function sendTransaction({ options, network, wasm, init, secret }) {
  const { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions } = await import('near-api-js');
  const signer = new Account(options.parent, new JsonRpcProvider({ url: network.rpc }), new KeyPairSigner(KeyPair.fromString(secret)));
  const result = await signer.signAndSendTransaction({ receiverId: options.account,
    actions: deployActions(actions, { wasm, amountYocto: options['amount-yocto'], init }), waitUntil: 'FINAL', throwOnFailure: false });
  if (result?.final_execution_status !== 'FINAL' || typeof result?.status?.SuccessValue !== 'string' || !result?.transaction?.hash) {
    throw new Error('Transaction did not reach final success; inspect chain state before retrying.');
  }
  return result.transaction.hash;
}

export async function deployOutlayer({ argv = process.argv.slice(2), log = console.log, send = sendTransaction,
  fetch = globalThis.fetch, query } = {}) {
  const options = parseOptions(argv);
  const { network, init, refereeWasm } = validateOptions(options);
  const [wasm, jury] = await Promise.all([readFile(refereeWasm), readFile(options['jury-wasm'])]);
  if (createHash('sha256').update(wasm).digest('hex') !== options['referee-hash']) throw new Error('Referee artifact hash mismatch.');
  if (createHash('sha256').update(jury).digest('hex') !== init.wasm_hash) throw new Error('Jury artifact hash mismatch.');
  let published;
  try {
    const response = await fetch(init.wasm_url, { redirect: 'error' });
    if (!response.ok || response.redirected) throw new Error('Unsuccessful or redirected response.');
    published = Buffer.from(await response.arrayBuffer());
  } catch { throw new Error('Unable to fetch the published jury WASM without redirects.'); }
  if (createHash('sha256').update(published).digest('hex') !== init.wasm_hash) {
    throw new Error('Published jury WASM hash mismatch.');
  }
  if (!query) {
    const { JsonRpcProvider } = await import('near-api-js');
    const provider = new JsonRpcProvider({ url: network.rpc });
    query = params => provider.query(params);
  }
  await Promise.all([init.escrow, init.secrets_owner].map(async account => {
    let state;
    try { state = await query({ request_type: 'view_account', finality: 'final', account_id: account }); }
    catch { throw new Error(`Unable to verify account ${account}.`); }
    if (state?.error || typeof state?.code_hash !== 'string' || !state.code_hash) {
      throw new Error(`Unable to verify account ${account}.`);
    }
    if (account === init.escrow && state.code_hash === '11111111111111111111111111111111') {
      throw new Error('Escrow account must contain deployed code.');
    }
  }));
  const preview = buildPreview(options, wasm, init);
  log(JSON.stringify(preview, null, 2));
  if (!options.yes) return { dryRun: true, preview };
  let key;
  try { key = JSON.parse(await readFile(options['key-file'], 'utf8')); } catch { throw new Error('Unable to read a valid JSON key file.'); }
  if (key?.account_id !== options.parent || typeof key?.private_key !== 'string' || !key.private_key) {
    throw new Error('Key file must contain the parent account_id and private_key.');
  }
  let hash;
  try { hash = await send({ options, network, wasm, init, secret: key.private_key }); }
  catch { throw new Error('Deployment failed or finality is unknown; inspect chain state before retrying.'); }
  log(`Finalized transaction: ${hash}`);
  return { dryRun: false, hash, preview };
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  deployOutlayer().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
