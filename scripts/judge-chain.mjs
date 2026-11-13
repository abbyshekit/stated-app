// `npm run judge`: a read-only check of Stated's deployed NEAR contracts through public RPC.
// It sends no transaction and reads no key or credential. Each line ends PASS or FAIL;
// the exit code is 1 if any line is FAIL. Expected code hashes come from evidence/, not from this file.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { verificationFetch } from './verification-network.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const NETWORKS = {
  testnet: ['https://test.rpc.fastnear.com', 'https://rpc.testnet.fastnear.com'],
  mainnet: ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.fastnear.com'],
};
export const TESTNET_ESCROW = 'stated-escrow-52081551be.testnet';
export const MAINNET_ESCROW = 'escrow.statedforecast.near';
export const RELAY = 'jury.stated-court-relay.testnet';
export const DAO = 'stated-court.sputnik-v2.testnet';
export const BET_ID = '3668aa04-7009-4b85-b19d-debfabebbf96';

const B58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

/** Hex sha256 to the base58 form NEAR reports as `code_hash`. Base58 input passes through. */
export function toBase58(value) {
  if (!/^[0-9a-f]{64}$/i.test(value)) return value;
  let n = BigInt(`0x${value}`);
  let out = '';
  while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
  return out;
}

class Rpc {
  constructor(network, { fetchImpl, sleep, diagnostic }) {
    this.endpoints = NETWORKS[network];
    this.fetch = verificationFetch(fetchImpl, { attempts: 3, timeoutMs: 15_000, sleep, diagnostic, maxBytes: 4_000_000 });
  }

  /** Tries each endpoint (with bounded retries inside) and returns the first RPC result. */
  async query(params) {
    let last;
    for (const url of this.endpoints) {
      try {
        const response = await this.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ jsonrpc: '2.0', id: 'judge', method: 'query', params: { finality: 'final', ...params } }) });
        const body = await response.json();
        if (response.ok && body && !body.error && body.result && !body.result.error) return body.result;
        last = new Error(`${new URL(url).host}: ${body?.error?.cause?.name || body?.result?.error || `HTTP ${response.status}`}`);
      } catch (error) {
        last = new Error(`${new URL(url).host}: ${error.message}`);
      }
    }
    throw last;
  }

  account(account_id) { return this.query({ request_type: 'view_account', account_id }); }

  async keys(account_id) { return (await this.query({ request_type: 'view_access_key_list', account_id })).keys; }

  async view(account_id, method_name, args = {}) {
    const result = await this.query({ request_type: 'call_function', account_id, method_name,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
    return JSON.parse(Buffer.from(result.result).toString('utf8'));
  }
}

function evidence(dir, file, pick) {
  const value = pick(JSON.parse(readFileSync(`${dir}/${file}`, 'utf8')));
  if (typeof value !== 'string' || !value) throw new Error(`evidence/${file} has no recorded value`);
  return value;
}

const same = (a, b) => Array.isArray(a) && a.length === b.length && b.every(item => a.includes(item));

/** The DAO policy, as server/src/court-dao.mjs checkCourt requires it: the relay is the only jury member,
 * the council can only vote a ruling down (VoteReject, VoteRemove), and nobody has a role-specific vote. */
export function courtPolicyProblems(policy, relay = RELAY) {
  const problems = [];
  const roles = Array.isArray(policy?.roles) ? policy.roles : [];
  const jury = roles.filter(r => r.name === 'jury');
  const council = roles.filter(r => r.name === 'council');
  if (roles.length !== 2 || jury.length !== 1 || council.length !== 1) problems.push(`expected exactly the roles jury and council, found ${roles.map(r => r.name).join(', ') || 'none'}`);
  const j = jury[0];
  const c = council[0];
  if (j && (!same(j.kind?.Group, [relay]))) problems.push(`jury is ${JSON.stringify(j.kind?.Group)}, not only ${relay}`);
  if (j && !same(j.permissions, ['call:AddProposal', 'call:VoteApprove'])) problems.push(`jury permissions are ${JSON.stringify(j.permissions)}`);
  if (c && (!Array.isArray(c.kind?.Group) || !c.kind.Group.length || c.kind.Group.includes(relay))) problems.push('council is empty or contains the relay');
  if (c && !same(c.permissions, ['call:VoteReject', 'call:VoteRemove'])) problems.push(`council permissions are ${JSON.stringify(c.permissions)}, not only VoteReject and VoteRemove`);
  if (roles.some(r => !r.vote_policy || typeof r.vote_policy !== 'object' || Object.keys(r.vote_policy).length)) problems.push('a role has its own voting rule');
  return problems;
}

/** Runs every check. Returns [{ name, ok, detail }]; never throws. */
export async function runJudge({ fetchImpl = fetch, sleep, diagnostic = () => {}, evidenceDir = `${ROOT}evidence` } = {}) {
  const testnet = new Rpc('testnet', { fetchImpl, sleep, diagnostic });
  const mainnet = new Rpc('mainnet', { fetchImpl, sleep, diagnostic });
  const results = [];
  const check = async (name, fn) => {
    try {
      const detail = await fn();
      results.push({ name, ok: true, detail });
    } catch (error) {
      results.push({ name, ok: false, detail: error.message });
    }
  };
  const expect = (cond, message) => { if (!cond) throw new Error(message); };

  const escrow = (rpc, id, expectedHex) => async () => {
    const want = toBase58(await expectedHex());
    const [account, keys, version] = await Promise.all([rpc.account(id), rpc.keys(id), rpc.view(id, 'version')]);
    expect(keys.length === 0, `${keys.length} access keys`);
    expect(version === '2', `version is ${JSON.stringify(version)}, not "2"`);
    expect(account.code_hash === want, `code hash ${account.code_hash} is not the recorded ${want}`);
    return `0 access keys, version "2", code hash ${account.code_hash} equals the recorded value`;
  };

  await check(`${label('testnet escrow', TESTNET_ESCROW)}: no keys, version 2, recorded code hash`, escrow(testnet, TESTNET_ESCROW,
    async () => {
      const f = 'reply-bets-testnet-live.json';
      const d = JSON.parse(readFileSync(`${evidenceDir}/${f}`, 'utf8')).contractDeployment;
      expect(d?.contract === TESTNET_ESCROW, `evidence/${f} does not record ${TESTNET_ESCROW}`);
      return evidence(evidenceDir, f, x => x.contractDeployment.wasmSha256);
    }));
  await check(`${label('mainnet escrow', MAINNET_ESCROW)}: no keys, version 2, recorded code hash`, escrow(mainnet, MAINNET_ESCROW,
    async () => {
      const f = 'escrow-deploy-mainnet-20261111.json';
      expect(JSON.parse(readFileSync(`${evidenceDir}/${f}`, 'utf8')).contract === MAINNET_ESCROW, `evidence/${f} does not record ${MAINNET_ESCROW}`);
      return evidence(evidenceDir, f, x => x.wasmSha256);
    }));
  await check(`${label('relay', RELAY)}: no access keys`, async () => {
    const keys = await testnet.keys(RELAY);
    expect(keys.length === 0, `${keys.length} access keys`);
    return '0 access keys';
  });
  await check(`${label('Court DAO', DAO)}: relay is the only jury member; council can only vote down`, async () => {
    const problems = courtPolicyProblems(await testnet.view(DAO, 'get_policy'));
    expect(!problems.length, problems.join('; '));
    return `jury = [${RELAY}] with call:AddProposal, call:VoteApprove; council has only call:VoteReject, call:VoteRemove`;
  });
  await check(`bet ${BET_ID.slice(0, 8)} on ${TESTNET_ESCROW}: settled, outcome yes`, async () => {
    const bet = await testnet.view(TESTNET_ESCROW, 'get_bet', { id: BET_ID });
    expect(bet && bet.id === BET_ID, 'the escrow has no such bet');
    expect(bet.status === 'settled', `status is ${bet.status}`);
    expect(bet.resolution?.outcome === 'yes', `outcome is ${bet.resolution?.outcome}`);
    return `status settled, outcome yes, method ${bet.resolution.method}`;
  });
  return results;
}

function label(kind, id) { return `${kind} ${id}`; }

export async function main(argv = process.argv.slice(2), out = line => console.log(line), options = {}) {
  const verbose = argv.includes('--verbose');
  const results = await runJudge({ diagnostic: verbose ? line => console.error(line) : () => {}, ...options });
  for (const r of results) {
    out(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
    out(`      ${r.detail}`);
  }
  const failed = results.filter(r => !r.ok).length;
  out(failed ? `judge-chain: FAIL (${failed} of ${results.length} checks failed)` : `judge-chain: PASS (${results.length} of ${results.length} checks)`);
  return failed ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => { console.error(error); process.exitCode = 1; });
}
