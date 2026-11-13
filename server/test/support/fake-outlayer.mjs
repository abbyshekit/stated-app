// INTEGRATION: Extends FakeNear with the immutable OutLayer referee ABI and an
// explicitly optional Open-evidence capability. This fixture never runs inference.
import { createHash, randomBytes } from 'node:crypto';
import { baseEncode } from 'near-api-js';
import { fingerprint } from '../../src/canonical.mjs';
import { FakeNear } from './fake-near.mjs';
import { outlayerEvidenceUrl } from '../../src/outlayer.mjs';

const RULING_GAS = 300_000_000_000_000n;
const DEFAULT_GAS = 100_000_000_000_000n;
const SECOND = 1_000_000_000n;
const STORAGE_PRICE = 10_000_000_000_000_000_000n;
const ROSTER = ['Qwen/Qwen3.8-27B', 'deepseek-ai/DeepSeek-V4.1-Flash-1017', 'z-ai/glm-5.3-flash'];
const clone = (value) => structuredClone(value);
const fail = (message) => { throw new Error(message); };
const ns = (date) => BigInt(new Date(date).getTime()) * 1_000_000n;
const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });
const hash = (text) => createHash('sha256').update(text).digest('hex');

// pg returns Date objects; Date.parse coerces those through a string without milliseconds.
export const outlayerDeadlineMs = bet => new Date(bet.resolve_at).getTime();

function exact(value, keys) {
  if (!value || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).sort().join(',') !== [...keys].sort().join(',')) fail('Invalid material fields');
}

function date(value) {
  if (typeof value !== 'string' || !Number.isFinite(Date.parse(value)) || new Date(value).toISOString() !== value) {
    fail('Canonical UTC milliseconds required');
  }
}

function publicUrl(value) {
  let url;
  try { url = new URL(value); } catch { fail('HTTPS evidence URL required'); }
  if (url.protocol !== 'https:' || url.username || url.password || value.length > 2048
    || !url.hostname.includes('.') || /(?:^|\.)(localhost|local|internal)$/.test(url.hostname)
    || /^[\d.]+$/.test(url.hostname) || url.hostname.includes(':')) fail('HTTPS evidence URL required');
  return value;
}

export function outlayerTermsHash(material, salt) {
  exact(material, ['bet_id', 'claim', 'made_at', 'deadline', 'post_url', 'evidence']);
  if (typeof material.bet_id !== 'string' || !material.bet_id.trim() || Buffer.byteLength(material.bet_id) > 128) fail('Invalid bet ID');
  if (typeof material.claim !== 'string' || !material.claim.trim() || Buffer.byteLength(material.claim) > 16000) fail('Invalid claim');
  date(material.made_at); date(material.deadline);
  if (material.made_at > material.deadline) fail('Deadline precedes the claim');
  publicUrl(material.post_url);
  const evidence = material.evidence;
  if (evidence?.kind === 'auto') exact(evidence, ['kind']);
  else if (evidence?.kind === 'open') {
    exact(evidence, ['kind', 'window_seconds', 'max_per_side']);
    if (!Number.isSafeInteger(evidence.window_seconds) || evidence.window_seconds <= 0
      || evidence.window_seconds > 7 * 86400 || evidence.max_per_side !== 2) fail('Invalid Open evidence policy');
  } else if (evidence?.kind === 'submitted') {
    exact(evidence, ['kind', 'items']);
    if (!Array.isArray(evidence.items) || !evidence.items.length || evidence.items.length > 8) fail('One to eight sources are required');
    for (const item of evidence.items) {
      exact(item, ['side', 'url']);
      if (!['yes', 'no'].includes(item.side)) fail('Invalid evidence side');
      outlayerEvidenceUrl(item.url);
    }
  } else if (evidence?.kind === 'coinbase') {
    exact(evidence, ['kind', 'product', 'window']);
    if (typeof evidence.product !== 'string' || !/^[A-Z0-9]{1,20}-USD$/.test(evidence.product)) fail('Invalid Coinbase USD product');
    if (evidence.window?.kind === 'moment') { exact(evidence.window, ['kind', 'at']); date(evidence.window.at); }
    else if (evidence.window?.kind === 'range') {
      exact(evidence.window, ['kind', 'start', 'end']); date(evidence.window.start); date(evidence.window.end);
      if (evidence.window.start >= evidence.window.end) fail('Invalid price window');
    } else fail('Invalid price window');
  } else fail('Unsupported evidence kind');
  if (!/^[a-f0-9]{64}$/.test(salt || '')) fail('Salt must be 32 bytes lowercase hex');
  return fingerprint({ domain: 'stated-outlayer-v1', material, salt });
}

export class FakeOutLayerNear extends FakeNear {
  constructor({ referee = 'outlayer-referee.testnet', supportsOpenEvidence = true, ...options } = {}) {
    super(options);
    this.referee = referee;
    this.outlayers = new Map();
    this.rulingResults = new Map();
    this.addOutLayer(referee, { supports_open_evidence: supportsOpenEvidence });
    const call = this.chain.call;
    const view = this.chain.view;
    this.chain.call = async (input) => this.outlayers.has(input.contractId) ? this.outlayerCall(input) : call(input);
    this.chain.view = async (input) => this.outlayers.has(input.contractId)
      ? this.outlayerView(input.contractId, input.method, input.args || {}) : view(input);
    const signed = new Map();
    this.chain.prepareCall = async (input) => {
      const hash = baseEncode(randomBytes(32));
      // Secrets are deliberately omitted from this synthetic signing fixture.
      const { secret: _secret, ...transaction } = input;
      signed.set(hash, { input: transaction, result: null });
      return { hash, signedTransaction: hash };
    };
    this.chain.broadcastCall = async ({ signedTransaction }) => {
      const stored = signed.get(signedTransaction);
      if (!stored) throw new Error('Unknown signed test transaction');
      if (stored.result) return stored.result;
      const result = await this.chain.call(stored.input);
      if (!result.hash) return result;
      const tx = this.txs.get(result.hash);
      this.txs.delete(result.hash);
      tx.transaction.hash = signedTransaction;
      this.txs.set(signedTransaction, tx);
      stored.result = { ...result, hash: signedTransaction };
      return stored.result;
    };
  }

  addOutLayer(accountId, config = {}) {
    this.accounts.set(accountId, { balance: 10n ** 24n, keys: new Set() });
    this.outlayers.set(accountId, {
      config: { escrow: this.contract, outlayer: 'outlayer.testnet', wasm_url: 'https://artifacts.test/jury.wasm',
        wasm_hash: 'a'.repeat(64), secrets_owner: 'sponsor.testnet', secrets_profile: 'jury',
        timeout_seconds: 600, retry_seconds: 300, max_undecided: 3, max_failures: 8,
        supports_open_evidence: true, ...clone(config) },
      rulings: new Map(), evidence: new Map(), computeBudget: 10n ** 24n,
    });
    return this.outlayers.get(accountId);
  }

  queueRuling(betId, patch) {
    const queue = this.rulingResults.get(betId) || [];
    queue.push(clone(patch));
    this.rulingResults.set(betId, queue);
  }

  outlayerView(accountId, method, args = {}) {
    const referee = this.outlayers.get(accountId);
    if (!referee) fail('Unknown referee');
    if (method === 'get_config') return clone(referee.config);
    if (method === 'terms_hash') {
      if (args.material?.evidence?.kind === 'open' && !referee.config.supports_open_evidence) fail('Unsupported evidence kind');
      return outlayerTermsHash(args.material, args.salt);
    }
    if (method === 'get_ruling') return clone(referee.rulings.get(args.bet_id) || null);
    if (method === 'get_compute_budget') return referee.computeBudget.toString();
    fail(`MethodNotFound ${method}`);
  }

  record(input) {
    const result = super.record(input);
    if (input.gas != null && input.method) this.txs.get(result.hash).transaction.actions[0].FunctionCall.gas = Number(input.gas);
    return result;
  }

  outlayerCall({ signerId, contractId, method, args = {}, depositYocto = '0', gas = DEFAULT_GAS }) {
    const referee = this.outlayers.get(contractId);
    const deposit = BigInt(depositYocto);
    const signer = this.accounts.get(signerId);
    this.sent.push({ signerId, contractId, method, args: clone(args), depositYocto, gas });
    if (!signer) return { hash: null, ok: false, failure: 'unknown account' };
    const reserve = (BigInt(gas) + 5_000_000_000_000n) * 1_000_000_000n + 1_820_000_000_000_000_000_000n;
    if (signer.balance < deposit + reserve) return { hash: null, ok: false, failure: 'NotEnoughBalance' };
    const record = (value = null, failure = null) => this.record({ signer: signerId, receiver: contractId,
      method, args, deposit: depositYocto, gas, value: JSON.stringify(value), failure });
    const before = clone(referee);
    try {
      let value;
      if (method === 'fund_compute') {
        if (deposit <= 0n) fail('Attach a compute donation');
        referee.computeBudget += deposit; signer.balance -= deposit;
        this.accounts.get(contractId).balance += deposit;
        value = referee.computeBudget.toString();
      } else if (method === 'register_material') {
        const termsHash = this.outlayerView(contractId, 'terms_hash', args);
        const material = args.material;
        const bet = this.bets.get(material.bet_id);
        if (referee.rulings.has(material.bet_id)) fail('Already registered');
        const cost = BigInt(Buffer.byteLength(JSON.stringify(material)) + 33792 + 512) * STORAGE_PRICE;
        value = Boolean(bet && bet.terms_hash === termsHash && bet.referee === contractId
          && bet.resolve_at_ns === ns(material.deadline).toString()
          && ['offered', 'accepted', 'proposed', 'disputed'].includes(bet.status) && deposit >= cost);
        if (value) {
          signer.balance -= cost;
          referee.rulings.set(material.bet_id, { material_json: JSON.stringify(material), terms_hash: termsHash,
            deadline_ns: ns(material.deadline).toString(), nonce: 0, undecided: 0, failures: 0,
            stage: 'idle', started_ns: '0', next_ns: '0', outcome: null, last_error: null });
          referee.evidence.set(material.bet_id, []);
        }
      } else if (method === 'submit_evidence') {
        if (deposit <= 0n) fail('Attach evidence storage deposit');
        const ruling = referee.rulings.get(args.bet_id);
        if (!ruling) fail('Register material first');
        const material = JSON.parse(ruling.material_json);
        const bet = this.bets.get(args.bet_id);
        if (!referee.config.supports_open_evidence || material.evidence.kind !== 'open') fail('Open evidence is unavailable');
        if (!bet || !['accepted', 'proposed', 'disputed'].includes(bet.status)) fail('Bet is not active');
        if (![bet.creator, bet.acceptor].includes(signerId)) fail('Only bettors may submit evidence');
        const now = this.nowNs();
        if (now < ns(material.deadline) || now >= ns(material.deadline) + BigInt(material.evidence.window_seconds) * SECOND) fail('Evidence is closed');
        if (ruling.stage !== 'idle') fail('Ruling already started');
        const side = signerId === bet.creator ? bet.creator_side : bet.creator_side === 'yes' ? 'no' : 'yes';
        if (args.side !== undefined && args.side !== side) fail('Evidence must support the bettor side');
        outlayerEvidenceUrl(args.url);
        const items = referee.evidence.get(args.bet_id);
        const existing = items.find((item) => item.account_id === signerId && item.url === args.url);
        if (!existing) {
          if (items.filter((item) => item.side === side).length >= 2) fail('At most two links per side');
          items.push({ side, url: args.url, account_id: signerId });
        }
        value = true;
      } else if (method === 'request_ruling') {
        if (deposit !== 0n) fail('Use fund_compute for donations');
        if (BigInt(gas) !== RULING_GAS) fail('request_ruling requires 300 Tgas');
        const ruling = referee.rulings.get(args.bet_id);
        if (!ruling) fail('Register material first');
        const material = JSON.parse(ruling.material_json);
        const now = this.nowNs();
        let ready = ns(material.deadline);
        if (material.evidence.kind === 'open') ready += BigInt(material.evidence.window_seconds) * SECOND;
        if (material.evidence.kind === 'auto') ready += 180n * SECOND;
        if (material.evidence.kind === 'coinbase') {
          const window = material.evidence.window;
          ready = window.kind === 'moment' ? (ns(window.at) / (60n * SECOND) + 2n) * 60n * SECOND
            : ((ns(window.end) + 60n * SECOND - 1n) / (60n * SECOND) + 1n) * 60n * SECOND;
          if (ready < ns(material.deadline)) ready = ns(material.deadline);
        }
        if (now < ready) fail('Resolution evidence is not ready');
        if (ruling.stage === 'settled') fail('Already settled');
        if (['reading', 'pricing', 'running', 'paying'].includes(ruling.stage)) {
          if (now < BigInt(ruling.started_ns) + 600n * SECOND) fail('Ruling in flight');
          if (ruling.stage === 'running') ruling.failures += 1;
        } else if (now < BigInt(ruling.next_ns)) fail('Retry delay remains');
        const bet = this.bets.get(args.bet_id);
        if (!bet || bet.referee !== contractId || bet.terms_hash !== ruling.terms_hash) fail('Escrow does not match registration');
        ruling.nonce += 1; ruling.started_ns = now.toString();
        if (['settled', 'refunded', 'cancelled', 'expired'].includes(bet.status)) {
          ruling.stage = 'settled'; value = 'Escrow is terminal';
        } else {
          if (!['accepted', 'proposed', 'disputed'].includes(bet.status)) fail('Bet is not active');
          const patch = this.rulingResults.get(args.bet_id)?.shift() || {};
          Object.assign(ruling, { stage: 'running', ...patch });
          if (['yes', 'no', 'void'].includes(ruling.outcome)) {
            const juryOutcome = ruling.outcome === 'void' ? 'unclear' : ruling.outcome;
            ruling.result ||= { bet_id: args.bet_id, terms_hash: ruling.terms_hash, outcome: juryOutcome,
              verdicts: ROSTER.map((model) => ({ model, outcome: juryOutcome, confidence: 0.9 })),
              evidence_summary: material.evidence.kind === 'open' ? { kind: 'submitted',
                items: referee.evidence.get(args.bet_id).map(({ side, url }) => ({ side, url, textHash: hash(url) })) }
                : { kind: material.evidence.kind },
              material_hash: hash(JSON.stringify({ claim: material.claim, madeAt: material.made_at,
                deadline: material.deadline, postUrl: material.post_url, bets: [{ id: args.bet_id, termsHash: ruling.terms_hash }] })) };
            this.settle(bet, ruling.outcome, 'referee'); ruling.stage = 'settled';
          }
          value = ruling.stage;
        }
      } else fail(`MethodNotFound ${method}`);
      return record(value);
    } catch (error) {
      Object.assign(referee, before);
      return record(null, String(error.message || error));
    }
  }

  rpc(input) {
    const { method, params } = input;
    if ((method === 'tx_status' || method === 'EXPERIMENTAL_tx_status') && this.txs.has(params.tx_hash)) {
      return json({ result: this.txs.get(params.tx_hash) });
    }
    if (method === 'query' && params.request_type === 'call_function' && this.outlayers.has(params.account_id)) {
      try {
        const args = JSON.parse(Buffer.from(params.args_base64, 'base64').toString());
        const value = this.outlayerView(params.account_id, params.method_name, args);
        return json({ result: { block_height: this.height, block_hash: 'fakeblock', result: [...Buffer.from(JSON.stringify(value))] } });
      } catch (error) { return json({ error: { message: String(error.message || error) } }); }
    }
    return super.rpc(input);
  }
}
