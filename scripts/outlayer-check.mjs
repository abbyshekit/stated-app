// INTEGRATION: Read-only inspection of an immutable OutLayer referee. No keys are loaded.
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { baseEncode, JsonRpcProvider } from 'near-api-js';
import { networkOptions, validAccount } from './outlayer-deploy.mjs';

export async function checkOutlayer({ argv = process.argv.slice(2), query, log = console.log } = {}) {
  const values = {};
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    if (!['--network','--rpc','--account','--wasm','--code-hash','--escrow','--outlayer','--wasm-url','--wasm-hash',
      '--secrets-owner','--secrets-profile'].includes(name) || values[name]
      || !argv[i + 1] || argv[i + 1].startsWith('--')) throw new Error('Invalid, duplicate or missing option.');
    values[name] = argv[i + 1];
  }
  const network = values['--network'];
  const account = values['--account'];
  const settings = networkOptions(network, values['--rpc']);
  if (!validAccount(account, settings.suffix)) throw new Error('Invalid referee account for this network.');
  for (const name of ['escrow', 'wasm-url', 'wasm-hash', 'secrets-owner', 'secrets-profile']) {
    if (!values[`--${name}`]) throw new Error(`Expected --${name} is required.`);
  }
  const expectedConfig = { escrow: values['--escrow'], outlayer: values['--outlayer'] ?? settings.outlayer,
    wasm_url: values['--wasm-url'], wasm_hash: values['--wasm-hash'], secrets_owner: values['--secrets-owner'],
    secrets_profile: values['--secrets-profile'] };
  for (const name of ['escrow', 'outlayer', 'secrets_owner']) {
    if (!validAccount(expectedConfig[name], settings.suffix)) throw new Error(`Invalid expected ${name} account.`);
  }
  let url;
  try { url = new URL(expectedConfig.wasm_url); } catch { throw new Error('Expected --wasm-url must be HTTPS.'); }
  if (url.protocol !== 'https:' || !url.hostname || url.username || url.password || expectedConfig.wasm_url.length > 2048) {
    throw new Error('Expected --wasm-url must be HTTPS without credentials.');
  }
  if (!/^[0-9a-f]{64}$/.test(expectedConfig.wasm_hash)) throw new Error('Expected --wasm-hash must be lowercase SHA256 hex.');
  if (!/^[a-zA-Z0-9_-]{1,64}$/.test(expectedConfig.secrets_profile)) throw new Error('Invalid expected --secrets-profile.');
  let expected = values['--code-hash'];
  if (values['--wasm']) {
    const digest = baseEncode(createHash('sha256').update(await readFile(values['--wasm'])).digest());
    if (expected && expected !== digest) throw new Error('--wasm and --code-hash disagree.');
    expected = digest;
  }
  if (!expected) throw new Error('Expected --code-hash or --wasm is required.');
  if (!query) {
    const provider = new JsonRpcProvider({ url: settings.rpc });
    query = (params) => provider.query(params);
  }
  const view = async (method) => {
    const reply = await query({ request_type: 'call_function', finality: 'final', account_id: account,
      method_name: method, args_base64: 'e30=' });
    if (!reply || reply.error || !Array.isArray(reply.result)) throw new Error(`Unable to read ${method}.`);
    return JSON.parse(Buffer.from(reply.result).toString('utf8'));
  };
  const [state, keys, config, computeBudget] = await Promise.all([
    query({ request_type: 'view_account', finality: 'final', account_id: account }),
    query({ request_type: 'view_access_key_list', finality: 'final', account_id: account }),
    view('get_config'), view('get_compute_budget'),
  ]);
  const codeMatches = !state?.error && state?.code_hash === expected;
  const zeroKeys = !keys?.error && Array.isArray(keys?.keys) && keys.keys.length === 0;
  const configMatches = config !== null && typeof config === 'object' && !Array.isArray(config)
    && Object.entries(expectedConfig).every(([name, value]) => config[name] === value);
  const result = { network, rpc: settings.rpc, account, codeHash: state?.code_hash, expectedCodeHash: expected,
    codeMatches, zeroKeys, keyCount: keys?.keys?.length ?? null, configMatches, expectedConfig, config, computeBudget };
  log(JSON.stringify(result, null, 2));
  if (!zeroKeys || !codeMatches || !configMatches) throw new Error('Referee verification failed. Do not fund new bets.');
  return result;
}

if (process.argv[1] && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url))) {
  checkOutlayer().catch(error => { console.error(error.message); process.exitCode = 1; });
}
