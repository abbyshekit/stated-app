// `npm run judge`: a read-only check of Stated's deployed NEAR contracts through public RPC.
// It sends no transaction and reads no key or credential. Checks print PASS or FAIL;
// any failure exits 1. Legacy hashes come from evidence/; OutLayer pins are supplied by the reviewer.
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { verificationFetch } from './verification-network.mjs';

const ROOT = fileURLToPath(new URL('..', import.meta.url));

export const NETWORKS = {
  testnet: ['https://test.rpc.fastnear.com', 'https://rpc.testnet.fastnear.com'],
  mainnet: ['https://free.rpc.fastnear.com', 'https://rpc.mainnet.fastnear.com'],
};
export const ARCHIVAL = {
  mainnet: 'https://archival-rpc.mainnet.near.org',
  testnet: 'https://archival-rpc.testnet.near.org',
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
  return '1'.repeat(value.match(/^(?:00)*/)[0].length / 2) + out;
}

class Rpc {
  constructor(network, { fetchImpl, sleep, diagnostic }, endpoints = NETWORKS[network]) {
    this.endpoints = endpoints;
    this.fetch = verificationFetch(fetchImpl, { attempts: 3, timeoutMs: 15_000, sleep, diagnostic, maxBytes: 4_000_000 });
  }

  /** Tries each endpoint (with bounded retries inside) and returns the first RPC result. */
  async call(method, params) {
    let last;
    for (const url of this.endpoints) {
      try {
        const response = await this.fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' },
          redirect: 'error', body: JSON.stringify({ jsonrpc: '2.0', id: 'judge', method, params }) });
        const body = await response.json();
        if (response.ok && body && !body.error && body.result && !body.result.error) return body.result;
        last = new Error(`${new URL(url).host}: ${body?.error?.cause?.name || body?.result?.error || `HTTP ${response.status}`}`);
      } catch (error) {
        last = new Error(`${new URL(url).host}: ${error.message}`);
      }
    }
    throw last;
  }

  query(params) { return this.call('query', { ...(params.block_id === undefined ? { finality: 'final' } : {}), ...params }); }

  async at(params, block_id) {
    const result = await this.query({ ...params, ...(block_id === undefined ? {} : { block_id }) });
    if (typeof block_id === 'string' && result.block_hash !== block_id) throw new Error('Historical view returned a different block');
    return result;
  }

  account(account_id, block_id) { return this.at({ request_type: 'view_account', account_id }, block_id); }

  async keys(account_id, block_id) { return (await this.at({ request_type: 'view_access_key_list', account_id }, block_id)).keys; }

  async view(account_id, method_name, args = {}, block_id) {
    const result = await this.at({ request_type: 'call_function', account_id, method_name,
      args_base64: Buffer.from(JSON.stringify(args)).toString('base64') }, block_id);
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

const requireCheck = (condition, message) => { if (!condition) throw new Error(message); };
const isAccount = value => typeof value === 'string' && value.length >= 2 && value.length <= 64
  && /^[a-z0-9]+(?:[._-][a-z0-9]+)*$/.test(value);
const isHash = value => typeof value === 'string' && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(value);
const uint = value => typeof value === 'string' && /^(0|[1-9][0-9]{0,38})$/.test(value);
const succeeded = status => status && Object.keys(status).length === 1
  && (typeof status.SuccessValue === 'string' || isHash(status.SuccessReceiptId));

const FLAGS = {
  '--network': 'network', '--referee': 'referee', '--referee-sha256': 'refereeSha256',
  '--jury-sha256': 'jurySha256', '--escrow': 'escrow', '--outlayer-contract': 'outlayer',
  '--wasm-url': 'wasmUrl', '--secrets-owner': 'secretsOwner', '--secrets-profile': 'secretsProfile',
  '--bet-id': 'betId', '--settlement-tx': 'settlementTx', '--settlement-signer': 'settlementSigner', '--save': 'save',
};
const ENV = {
  network: 'JUDGE_NETWORK', referee: 'JUDGE_REFEREE', refereeSha256: 'JUDGE_REFEREE_SHA256',
  jurySha256: 'JUDGE_JURY_SHA256', escrow: 'JUDGE_ESCROW', outlayer: 'JUDGE_OUTLAYER_CONTRACT',
  wasmUrl: 'JUDGE_WASM_URL', secretsOwner: 'JUDGE_SECRETS_OWNER', secretsProfile: 'JUDGE_SECRETS_PROFILE',
  betId: 'JUDGE_BET_ID', settlementTx: 'JUDGE_SETTLEMENT_TX', settlementSigner: 'JUDGE_SETTLEMENT_SIGNER',
};

export function judgeOptions(argv, env = {}) {
  const options = Object.fromEntries(Object.entries(ENV).filter(([, key]) => env[key]).map(([key, name]) => [key, env[name]]));
  for (let i = 0; i < argv.length; i++) {
    const flag = argv[i];
    if (flag === '--outlayer') { options.mode = 'outlayer'; continue; }
    if (flag === '--verbose') { options.verbose = true; continue; }
    requireCheck(Object.hasOwn(FLAGS, flag), 'Unknown judge option');
    requireCheck(typeof argv[i + 1] === 'string' && !argv[i + 1].startsWith('--') && argv[i + 1].length > 0, `Missing value for ${flag}`);
    options[FLAGS[flag]] = argv[++i];
  }
  if (options.mode !== 'outlayer') {
    requireCheck(!Object.keys(ENV).some(key => options[key]), 'OutLayer options require --outlayer');
    return options;
  }
  options.network ||= 'mainnet';
  requireCheck(Object.hasOwn(NETWORKS, options.network), 'Network must be mainnet or testnet');
  options.escrow ||= options.network === 'mainnet' ? MAINNET_ESCROW : TESTNET_ESCROW;
  options.outlayer ||= options.network === 'mainnet' ? 'outlayer.near' : 'outlayer.testnet';
  options.secretsProfile ||= 'jury';
  for (const key of ['referee', 'escrow', 'outlayer', 'secretsOwner']) requireCheck(isAccount(options[key]), `Missing or invalid ${key} account`);
  for (const key of ['refereeSha256', 'jurySha256']) {
    requireCheck(typeof options[key] === 'string' && /^[a-f0-9]{64}$/i.test(options[key]), `Missing or invalid ${key}: require SHA-256 hex`);
    options[key] = options[key].toLowerCase();
  }
  let url;
  try { url = new URL(options.wasmUrl); } catch { throw new Error('Missing or invalid wasmUrl: require public HTTPS URL'); }
  requireCheck(url.protocol === 'https:' && !url.username && !url.password && !url.hash && url.href.length <= 2048,
    'wasmUrl must be HTTPS without credentials or fragment');
  requireCheck(/^[a-zA-Z0-9_-]{1,64}$/.test(options.secretsProfile), 'Invalid secretsProfile');
  if (options.betId !== undefined) requireCheck(/^[a-zA-Z0-9_-]{1,128}$/.test(options.betId), 'Invalid betId');
  if (options.settlementTx || options.settlementSigner) {
    requireCheck(options.betId && isHash(options.settlementTx) && isAccount(options.settlementSigner),
      'Settlement lookup requires bet-id, settlement-tx and original settlement-signer');
  }
  return options;
}

function callArgs(receipt, method) {
  const actions = receipt?.receipt?.Action?.actions;
  if (!Array.isArray(actions) || actions.length !== 1 || actions[0]?.FunctionCall?.method_name !== method) return null;
  const call = actions[0].FunctionCall;
  if (call.deposit !== '0' || typeof call.args !== 'string' || call.args.length > 32768) return null;
  try { return JSON.parse(Buffer.from(call.args, 'base64').toString('utf8')); } catch { return null; }
}

// Find the exact execution block from the escrow's nanosecond resolution time.
// Bounded height search tolerates skipped heights; predecessor reads use prev_hash.
async function settlementBlock(rpc, timestamp) {
  requireCheck(uint(timestamp), 'Missing resolution timestamp');
  const head = await rpc.call('block', { finality: 'final' });
  let low = 0;
  let high = head.header.height;
  const finalHeight = high;
  requireCheck(Number.isSafeInteger(high) && high > 0 && uint(head.header.timestamp_nanosec)
    && BigInt(timestamp) <= BigInt(head.header.timestamp_nanosec), 'Invalid final block header or future resolution timestamp');
  const atOrAfter = async height => {
    for (let n = height; n <= Math.min(height + 32, finalHeight); n++) {
      try { return await rpc.call('block', { block_id: n }); }
      catch (error) { if (!/UNKNOWN_BLOCK/.test(error.message)) throw error; }
    }
    throw new Error('Block search exceeded skipped-height limit');
  };
  for (let n = 0; low < high && n < 64; n++) {
    const mid = Math.floor((low + high) / 2);
    const block = await atOrAfter(mid);
    requireCheck(uint(block.header?.timestamp_nanosec), 'Invalid archival block timestamp');
    if (BigInt(block.header.timestamp_nanosec) < BigInt(timestamp)) low = block.header.height + 1;
    else high = mid;
  }
  const block = await atOrAfter(low);
  requireCheck(block.header.timestamp_nanosec === timestamp, `Resolution timestamp ${timestamp}; found block timestamp ${block.header.timestamp_nanosec}`);
  return block;
}

async function discoverSettlement(rpc, options, block) {
  const changes = await rpc.call('EXPERIMENTAL_changes', { changes_type: 'data_changes', account_ids: [options.escrow],
    key_prefix_base64: '', block_id: block.header.hash });
  requireCheck(changes.block_hash === block.header.hash && Array.isArray(changes.changes), 'Invalid settlement state changes');
  const ids = [...new Set(changes.changes.filter(c => c.cause?.type === 'receipt_processing').map(c => c.cause.receipt_hash))];
  requireCheck(ids.length > 0 && ids.length <= 64 && ids.every(isHash), 'No bounded settlement receipt candidates');
  for (const receipt_id of ids) {
    const receipt = await rpc.call('EXPERIMENTAL_receipt', { receipt_id });
    const args = callArgs(receipt, 'referee_resolve');
    if (receipt.predecessor_id === options.referee && receipt.receiver_id === options.escrow && args?.id === options.betId) {
      const origin = await rpc.call('EXPERIMENTAL_receipt_to_tx', { receipt_id, block_height: block.header.height });
      requireCheck(isHash(origin.transaction_hash) && isAccount(origin.sender_account_id), 'Invalid originating transaction');
      return { hash: origin.transaction_hash, signer: origin.sender_account_id };
    }
  }
  throw new Error('No referee_resolve receipt found for this bet');
}

function settlementReceipt(tx, origin, options, bet, block) {
  requireCheck(tx.final_execution_status === 'FINAL' && succeeded(tx.status), 'Settlement transaction is not FINAL and successful');
  requireCheck(tx.transaction?.hash === origin.hash && tx.transaction.signer_id === origin.signer,
    'Settlement transaction hash or original signer mismatch');
  requireCheck(Array.isArray(tx.receipts) && tx.receipts.length <= 512 && Array.isArray(tx.receipts_outcome)
    && tx.receipts_outcome.length <= 512, 'Missing or oversized receipt graph');
  const receipts = new Map(tx.receipts.map(receipt => [receipt.receipt_id, receipt]));
  const outcomes = new Map(tx.receipts_outcome.map(item => [item.id, { ...item.outcome, block_hash: item.block_hash }]));
  requireCheck(receipts.size === tx.receipts.length && outcomes.size === tx.receipts_outcome.length, 'Duplicate receipt IDs');
  const root = tx.transaction_outcome;
  requireCheck(root?.id === origin.hash && root.outcome?.executor_id === origin.signer && succeeded(root.outcome.status)
    && isHash(root.outcome.status.SuccessReceiptId) && root.outcome.receipt_ids?.includes(root.outcome.status.SuccessReceiptId), 'Invalid transaction root');
  const reachable = new Set();
  const visit = outcome => {
    requireCheck(Array.isArray(outcome?.receipt_ids), 'Incomplete receipt graph');
    for (const id of outcome.receipt_ids) {
      if (reachable.has(id)) continue;
      reachable.add(id);
      requireCheck(outcomes.has(id), 'Missing linked receipt outcome');
      requireCheck(receipts.has(id) && outcomes.get(id).executor_id === receipts.get(id).receiver_id, 'Linked receipt executor mismatch');
      visit(outcomes.get(id));
    }
  };
  visit(root.outcome);
  const matches = tx.receipts.filter(receipt => {
    const args = callArgs(receipt, 'referee_resolve');
    return receipt.predecessor_id === options.referee && receipt.receiver_id === options.escrow
      && args?.id === options.betId && args.outcome === bet.resolution.outcome;
  });
  requireCheck(matches.length === 1, `Expected one settlement receipt for ${bet.resolution.outcome}; saw ${matches.length}`);
  const receipt = matches[0];
  const outcome = outcomes.get(receipt.receipt_id);
  requireCheck(reachable.has(receipt.receipt_id) && outcome?.executor_id === options.escrow
    && succeeded(outcome.status) && outcome.block_hash === block.header.hash, 'Settlement receipt failed, detached, or in wrong block');
  return receipt.receipt_id;
}

async function verifySettlement(options, bet, ruling, transport) {
  const endpoint = ARCHIVAL[options.network];
  const rpc = new Rpc(options.network, transport, [endpoint]);
  requireCheck(bet?.status === 'settled', `Settlement pending: escrow status ${bet?.status}`);
  requireCheck(bet.resolution?.method === 'referee' && bet.resolution.outcome === ruling?.outcome,
    `Escrow resolution ${JSON.stringify(bet.resolution)}; ruling outcome ${ruling?.outcome}`);
  requireCheck(['yes', 'no', 'void'].includes(ruling.outcome) && ruling.stage === 'settled',
    `Ruling stage ${ruling.stage}, outcome ${ruling.outcome}`);
  requireCheck(isAccount(bet.creator) && isAccount(bet.acceptor) && bet.creator !== bet.acceptor
    && ['yes', 'no'].includes(bet.creator_side) && uint(bet.stake_yocto) && BigInt(bet.stake_yocto) > 0n, 'Invalid funded bet participants or stake');
  const block = await settlementBlock(rpc, bet.resolution.resolved_at_ns);
  const origin = options.settlementTx ? { hash: options.settlementTx, signer: options.settlementSigner }
    : await discoverSettlement(rpc, options, block);
  const tx = await rpc.call('EXPERIMENTAL_tx_status', { tx_hash: origin.hash, sender_account_id: origin.signer, wait_until: 'FINAL' });
  const receiptId = settlementReceipt(tx, origin, options, bet, block);
  const before = block.header.prev_hash;
  const after = block.header.hash;
  const escrowHash = toBase58(evidence(`${ROOT}evidence`, options.network === 'mainnet'
    ? 'escrow-deploy-mainnet-20261111.json' : 'reply-bets-testnet-live.json',
  value => options.network === 'mainnet' ? value.wasmSha256 : value.contractDeployment.wasmSha256));
  const integrity = [];
  for (const [id, hash] of [[options.referee, toBase58(options.refereeSha256)], [options.escrow, escrowHash]]) {
    for (const block_id of [before, after]) {
      const [account, keys] = await Promise.all([rpc.account(id, block_id), rpc.keys(id, block_id)]);
      requireCheck(account.code_hash === hash && Array.isArray(keys) && keys.length === 0,
        `${id} at ${block_id}: code hash ${account.code_hash}; keys ${JSON.stringify(keys?.length)}; expected ${hash} and 0 keys`);
    }
    integrity.push(`${id} code ${hash}, 0 keys before/after`);
  }
  const [oldBet, newBet] = await Promise.all([before, after].map(hash => rpc.view(options.escrow, 'get_bet', { id: options.betId }, hash)));
  requireCheck(oldBet && !['settled', 'refunded', 'cancelled', 'expired'].includes(oldBet.status)
    && newBet?.status === 'settled' && JSON.stringify(newBet.resolution) === JSON.stringify(bet.resolution), 'Historical bet transition mismatch');
  for (const key of ['id', 'terms_hash', 'referee', 'creator', 'acceptor', 'creator_side', 'stake_yocto']) {
    requireCheck(oldBet[key] === bet[key] && newBet[key] === bet[key], `Historical bet ${key} mismatch`);
  }
  const stake = BigInt(bet.stake_yocto);
  const winner = bet.creator_side === ruling.outcome ? bet.creator : bet.acceptor;
  const credits = [];
  for (const account_id of [bet.creator, bet.acceptor]) {
    const [a, b] = await Promise.all([before, after].map(hash => rpc.view(options.escrow, 'get_credit', { account_id }, hash)));
    requireCheck(uint(a) && uint(b), 'Invalid historical credit amount');
    const delta = BigInt(b) - BigInt(a);
    const want = ruling.outcome === 'void' ? stake : account_id === winner ? stake * 2n : 0n;
    requireCheck(delta === want, `${account_id}: net credit delta ${delta} yoctoNEAR; expected ${want} for outcome ${ruling.outcome} (other activity in this block also fails this check)`);
    credits.push(`${account_id} +${delta} yoctoNEAR`);
  }
  return `archival RPC ${endpoint}; transaction ${origin.hash}; signer ${origin.signer}; receipt ${receiptId}; ${integrity.join('; ')}; outcome ${ruling.outcome}; net escrow credits: ${credits.join(', ')}; wallet withdrawal not checked`;
}

export async function runOutlayerJudge(options, { fetchImpl = fetch, sleep, diagnostic = () => {} } = {}) {
  const transport = { fetchImpl, sleep, diagnostic };
  const rpc = new Rpc(options.network, transport);
  const results = [];
  const check = async (name, fn) => {
    try { results.push({ name, ok: true, detail: await fn() }); }
    catch (error) { results.push({ name, ok: false, detail: error.message }); }
  };
  await check(`referee ${options.referee}: no access keys`, async () => {
    const keys = await rpc.keys(options.referee);
    requireCheck(Array.isArray(keys), 'Invalid access key response');
    requireCheck(keys.length === 0, `${keys.length} access keys`);
    return '0 access keys';
  });
  await check(`referee ${options.referee}: reproducible code hash`, async () => {
    const account = await rpc.account(options.referee);
    const expected = toBase58(options.refereeSha256);
    requireCheck(account.code_hash === expected, `code hash ${account.code_hash}; expected ${expected} (SHA-256 ${options.refereeSha256})`);
    return `code hash ${account.code_hash}; SHA-256 ${options.refereeSha256}`;
  });
  let config;
  let configError;
  try { config = await rpc.view(options.referee, 'get_config'); } catch (error) { configError = error; }
  const expectedConfig = { escrow: options.escrow, outlayer: options.outlayer, wasm_url: options.wasmUrl,
    wasm_hash: options.jurySha256, secrets_owner: options.secretsOwner, secrets_profile: options.secretsProfile };
  for (const [key, value] of Object.entries(expectedConfig)) {
    await check(`referee get_config.${key}`, async () => {
      if (configError) throw configError;
      requireCheck(config?.[key] === value, `saw ${JSON.stringify(config?.[key])}; expected ${JSON.stringify(value)}`);
      return JSON.stringify(config[key]);
    });
  }
  await check('jury download: pinned SHA-256', async () => {
    requireCheck(config?.wasm_url === options.wasmUrl && config?.wasm_hash === options.jurySha256,
      'Refusing download: on-chain jury URL/hash differs from expected values');
    const download = verificationFetch(fetchImpl, { sleep, diagnostic, maxBytes: 32_000_000, timeoutMs: 30_000 });
    const response = await download(options.wasmUrl, { redirect: 'error' });
    requireCheck(response.ok, `Jury download HTTP ${response.status}`);
    const hash = createHash('sha256').update(Buffer.from(await response.arrayBuffer())).digest('hex');
    requireCheck(hash === config.wasm_hash, `downloaded SHA-256 ${hash}; expected ${config.wasm_hash}`);
    return `${options.wasmUrl}; SHA-256 ${hash}`;
  });
  if (options.betId) {
    let bet;
    let ruling;
    await check(`escrow get_bet ${options.betId}: named referee`, async () => {
      bet = await rpc.view(options.escrow, 'get_bet', { id: options.betId });
      requireCheck(bet?.id === options.betId && bet.referee === options.referee, `bet id ${bet?.id}; referee ${bet?.referee}; expected ${options.referee}`);
      return `referee ${bet.referee}; status ${bet.status}; outcome ${bet.resolution?.outcome ?? null}`;
    });
    await check(`referee get_ruling ${options.betId}: stage and outcome`, async () => {
      ruling = await rpc.view(options.referee, 'get_ruling', { bet_id: options.betId });
      requireCheck(['idle', 'reading', 'pricing', 'running', 'paying', 'settled'].includes(ruling?.stage)
        && (ruling.outcome === null || ['yes', 'no', 'void'].includes(ruling.outcome)), `stage ${ruling?.stage}; outcome ${ruling?.outcome}`);
      requireCheck(bet?.terms_hash && ruling.terms_hash === bet.terms_hash, `ruling terms_hash ${ruling.terms_hash}; escrow terms_hash ${bet?.terms_hash}`);
      return `stage ${ruling.stage}; outcome ${ruling.outcome}; terms_hash ${ruling.terms_hash}`;
    });
    await check(`bet ${options.betId}: settlement and credited side (${ARCHIVAL[options.network]})`, async () => {
      requireCheck(bet?.referee === options.referee && ruling?.terms_hash === bet?.terms_hash, 'Bet/ruling binding failed');
      return verifySettlement(options, bet, ruling, transport);
    });
  }
  return results;
}

// Persist only the public checks. Never serialize argv, environment, cwd, stack or save destination.
function savedDetail(value) {
  return String(value).replace(/file:\/\/\S+|(?<![:/\w])\/(?!\/)[^\s"']+/g, '[local path]')
    .replace(/\b(?:evidence\/)[^\s"']+/g, '[evidence file]');
}

export async function main(argv = process.argv.slice(2), out = line => console.log(line), options = {}) {
  let config;
  let results;
  try { config = judgeOptions(argv, options.env ?? process.env); }
  catch (error) {
    const index = argv.lastIndexOf('--save');
    const destination = index >= 0 ? argv[index + 1] : undefined;
    config = { invalid: true, mode: argv.includes('--outlayer') ? 'outlayer' : undefined,
      save: typeof destination === 'string' && !destination.startsWith('--') ? destination : undefined };
    results = [{ name: 'configuration', ok: false, detail: error.message }];
  }
  if (!results) {
    const transport = { diagnostic: config.verbose ? line => console.error(line) : () => {}, ...options };
    results = config.mode === 'outlayer' ? await runOutlayerJudge(config, transport) : await runJudge(transport);
  }
  for (const r of results) {
    out(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
    out(`      ${r.detail}`);
  }
  const failed = results.filter(r => !r.ok).length;
  if (config.save) {
    const report = { schema: 1, checkedAt: new Date().toISOString(), mode: config.mode ?? 'legacy',
      ...(config.mode ? { network: config.network, referee: config.referee, betId: config.betId ?? null,
        scope: config.invalid ? 'configuration invalid; no chain checks run'
          : config.betId ? 'bet settlement credits; wallet withdrawal not checked' : 'deployment only; no bet checked' } : {}),
      overall: failed ? 'FAIL' : 'PASS', results: results.map(r => ({ ...r, detail: savedDetail(r.detail) })) };
    try { writeFileSync(config.save, `${JSON.stringify(report, null, 2)}\n`, { mode: 0o600 }); }
    catch { out('FAIL  could not save judge JSON'); return 1; }
  }
  out(failed ? `judge-chain: FAIL (${failed} of ${results.length} checks failed)` : `judge-chain: PASS (${results.length} of ${results.length} checks)`);
  return failed ? 1 : 0;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().then(code => { process.exitCode = code; }, error => { console.error(error); process.exitCode = 1; });
}
