// A test double for NEAR (testnet, or mainnet when the process is on it): accounts with balances and keys, the version 2
// escrow contract's rules, and the JSON-RPC answers the server reads (get_bet,
// get_credit, version, view_account, view_access_key, tx, block). It is both
// the `chain` that signs (play.mjs) and the `fetchImpl` that verifies, so a
// test exercises the same reserve, sign, verify and sync path as production.
// It models the contract closely enough to reject what the contract rejects;
// the Rust unit tests remain the authority on the contract itself.
import { randomBytes } from 'node:crypto';
import { baseEncode } from 'near-api-js';
import { primaryRpc } from '../../src/near-escrow.mjs';
import { network } from '../../src/near-network.mjs';

const DAY_NS = 86400000000000n;
const STORAGE_FEE = 10n ** 22n;
const GAS_PRICE = 1_000_000_000n;
const SIGNER_STORAGE = 1_820_000_000_000_000_000_000n;
const callCost = (gas) => (gas + 5_000_000_000_000n) * GAS_PRICE + SIGNER_STORAGE;
const RESOLUTION_WINDOW = 7n * DAY_NS;
const RESPONSE_WINDOW = 2n * DAY_NS;
const json = (value) => new Response(JSON.stringify(value), { headers: { 'content-type': 'application/json' } });

export class FakeNear {
  constructor({ contract = 'escrow.testnet', version = 2 } = {}) {
    this.contract = contract;
    this.version = version;
    this.accounts = new Map([[contract, { balance: 0n, keys: new Set() }]]);
    this.bets = new Map();
    this.credits = new Map();
    this.txs = new Map();
    this.height = 1000;
    this.offsetMs = 0;
    this.sent = [];
    this.faucetCalls = 0;
    this.keySeq = 0;
    // The wrapped-NEAR token contract: who is registered with it, and what each holds.
    this.wrapped = new Map();
    // Sputnik DAOs (v2 rules) by account: their policy and proposals.
    this.daos = new Map();
    this.daoFaults = [];
    this.fetchImpl = (url, options) => (url === primaryRpc() ? this.rpc(JSON.parse(options.body)) : fetch(url, options));
    this.chain = {
      newKey: () => {
        this.keySeq += 1;
        const publicKey = `ed25519:${baseEncode(randomBytes(32))}`;
        return { secret: `ed25519:secret-${this.keySeq}-${publicKey.slice(8, 20)}`, publicKey };
      },
      faucet: async (accountId, publicKey) => {
        this.faucetCalls += 1;
        if (this.accounts.has(accountId)) throw new Error('Testnet faucet refused: HTTP 400');
        this.accounts.set(accountId, { balance: 10n * 10n ** 24n, keys: new Set([publicKey]) });
      },
      balance: async (accountId) => (this.accounts.has(accountId) ? this.accounts.get(accountId).balance.toString() : null),
      callFunds: async (accountId, gas = 100_000_000_000_000n) => ({
        balance: this.accounts.get(accountId).balance, reserve: callCost(gas),
      }),
      hasKey: async (accountId, publicKey) => Boolean(this.accounts.get(accountId)?.keys.has(publicKey)),
      createAccount: async ({ parentId, accountId, publicKey, amountYocto }) => {
        const parent = this.accounts.get(parentId);
        if (!parent || !accountId.endsWith(`.${parentId}`) || this.accounts.has(accountId) || parent.balance < BigInt(amountYocto)) {
          return this.record({ signer: parentId, receiver: accountId, failure: 'CreateAccountNotAllowed' });
        }
        parent.balance -= BigInt(amountYocto);
        this.accounts.set(accountId, { balance: BigInt(amountYocto), keys: new Set([publicKey]) });
        return this.record({ signer: parentId, receiver: accountId });
      },
      transfer: async ({ fromId, toId, amountYocto }) => {
        const from = this.accounts.get(fromId);
        const to = this.accounts.get(toId);
        if (!from || !to || from.balance < BigInt(amountYocto)) return this.record({ signer: fromId, receiver: toId, failure: 'NotEnoughBalance' });
        from.balance -= BigInt(amountYocto);
        to.balance += BigInt(amountYocto);
        return this.record({ signer: fromId, receiver: toId });
      },
      drain: async ({ fromId, toId }) => {
        const from = this.accounts.get(fromId);
        this.accounts.get(toId).balance += from.balance;
        this.accounts.delete(fromId);
        return this.record({ signer: fromId, receiver: fromId });
      },
      rotateKey: async ({ accountId, addPublicKey, removePublicKey }) => {
        const account = this.accounts.get(accountId);
        account.keys.add(addPublicKey);
        account.keys.delete(removePublicKey);
        return this.record({ signer: accountId, receiver: accountId });
      },
      call: async (input) => {
        if (input.contractId === network().wrap) return this.wrapCall(input);
        if (this.daos.has(input.contractId)) return this.daoCall(input);
        return this.call(input);
      },
      view: async ({ contractId, method, args }) => {
        if (this.daos.has(contractId)) return this.daoView(contractId, method, args || {});
        if (contractId !== network().wrap) throw new Error(`unsupported fake view ${contractId}.${method}`);
        if (method === 'storage_balance_of') return this.wrapped.has(args.account_id) ? { total: '1250000000000000000000', available: '0' } : null;
        if (method === 'ft_balance_of') return (this.wrapped.get(args.account_id) || 0n).toString();
        throw new Error(`unsupported fake view ${method}`);
      },
    };
  }

  // What NEAR Intents does when a payment completes: wrapped NEAR lands in a registered account, or plain NEAR in any account.
  deliver(accountId, yocto, { wrapped = true } = {}) {
    if (!this.accounts.has(accountId)) throw new Error(`no account ${accountId}`);
    if (!wrapped) { this.accounts.get(accountId).balance += BigInt(yocto); return; }
    if (!this.wrapped.has(accountId)) throw new Error('The account is not registered for wrapped NEAR');
    this.wrapped.set(accountId, this.wrapped.get(accountId) + BigInt(yocto));
  }

  // The two wrapped-NEAR methods the server uses, with the contract's own conditions.
  wrapCall({ signerId, contractId, method, args, depositYocto = '0', gas = 100_000_000_000_000n }) {
    const signer = this.accounts.get(signerId);
    const deposit = BigInt(depositYocto);
    this.sent.push({ signerId, method, args, depositYocto, gas });
    const fail = (failure) => this.record({ signer: signerId, receiver: contractId, method, args, deposit: depositYocto, failure });
    if (!signer) return { hash: null, ok: false, failure: 'unknown account' };
    if (signer.balance < deposit + callCost(gas)) return { hash: null, ok: false, failure: 'NotEnoughBalance' };
    if (method === 'storage_deposit') {
      if (deposit < 1250000000000000000000n) return fail('The attached deposit is less than the minimum storage balance');
      signer.balance -= deposit;
      if (!this.wrapped.has(args.account_id)) this.wrapped.set(args.account_id, 0n);
      return this.record({ signer: signerId, receiver: contractId, method, args, deposit: depositYocto });
    }
    if (method === 'near_withdraw') {
      if (deposit !== 1n) return fail('Requires attached deposit of exactly 1 yoctoNEAR');
      const held = this.wrapped.get(signerId);
      const amount = BigInt(args.amount);
      if (held == null || held < amount) return fail('The account doesn\'t have enough balance');
      this.wrapped.set(signerId, held - amount);
      signer.balance += amount;
      return this.record({ signer: signerId, receiver: contractId, method, args, deposit: depositYocto });
    }
    return fail(`MethodNotFound ${method}`);
  }

  // A Sputnik v2 DAO: role permissions as '<kind label>:<action>' with '*' wildcards, RoleWeight voting with
  // threshold max(quorum, floor(size * num / den) + 1) per role, and on approval the FunctionCall actions
  // run with the DAO as predecessor. Only what Stated uses (FunctionCall proposals) is modelled.
  addDao(daoId, policy, { balance = 6n * 10n ** 24n } = {}) {
    this.accounts.set(daoId, { balance, keys: new Set() });
    this.daos.set(daoId, { policy: structuredClone(policy), proposals: [] });
  }

  daoAllowed(dao, signer, label, action) {
    const roles = dao.policy.roles.filter((role) => role.kind === 'Everyone' || role.kind?.Group?.includes(signer));
    const grants = [`${label}:${action}`, `${label}:*`, `*:${action}`, '*:*'];
    return roles.filter((role) => role.permissions.some((permission) => grants.includes(permission)));
  }

  daoStatus(dao, proposal) {
    const { quorum, threshold: [num, den] } = dao.policy.default_vote_policy;
    for (const [name, [approve, reject, remove]] of Object.entries(proposal.vote_counts)) {
      const size = dao.policy.roles.find((role) => role.name === name)?.kind?.Group?.length || 1;
      const needed = Math.max(Number(quorum), Math.floor((size * num) / den) + 1);
      if (approve >= needed) return 'Approved';
      if (reject >= needed) return 'Rejected';
      if (remove >= needed) return 'Removed';
    }
    return 'InProgress';
  }

  daoCall({ signerId, contractId, method, args, depositYocto = '0' }) {
    const dao = this.daos.get(contractId);
    this.sent.push({ signerId, contractId, method, args, depositYocto });
    const fault = this.daoFaults.shift();
    if (fault === 'reject') return { hash: null, ok: false, failure: 'RPC refused the transaction' };
    const fail = (failure) => this.record({ signer: signerId, receiver: contractId, method, args, deposit: depositYocto, failure });
    if (!this.accounts.has(signerId)) return { hash: null, ok: false, failure: 'unknown account' };
    if (method === 'add_proposal') {
      const kind = args.proposal?.kind;
      if (!kind?.FunctionCall) return fail('Only FunctionCall proposals are modelled');
      if (!this.daoAllowed(dao, signerId, 'call', 'AddProposal').length) return fail('ERR_PERMISSION_DENIED');
      if (BigInt(depositYocto) < BigInt(dao.policy.proposal_bond)) return fail('ERR_MIN_BOND');
      const id = dao.proposals.length;
      dao.proposals.push({ id, proposer: signerId, description: args.proposal.description, kind: structuredClone(kind),
        status: 'InProgress', vote_counts: {}, votes: {}, submission_time: this.nowNs().toString() });
      // 'lost': the proposal lands but the caller never hears back.
      if (fault === 'lost') throw new Error('socket hang up');
      return this.record({ signer: signerId, receiver: contractId, method, args, deposit: depositYocto, value: JSON.stringify(id) });
    }
    if (method === 'act_proposal') {
      if (BigInt(depositYocto) !== 0n) return fail("Method act_proposal doesn't accept deposit");
      const proposal = dao.proposals[args.id];
      if (!proposal) return fail('ERR_NO_PROPOSAL');
      if (args.proposal !== undefined && JSON.stringify(args.proposal) !== JSON.stringify(proposal.kind)) return fail('ERR_WRONG_KIND');
      const vote = { VoteApprove: 0, VoteReject: 1, VoteRemove: 2 }[args.action];
      if (vote === undefined) return fail('ERR_WRONG_ACTION');
      const roles = this.daoAllowed(dao, signerId, 'call', args.action);
      if (!roles.length) return fail('ERR_PERMISSION_DENIED');
      if (proposal.status !== 'InProgress') return fail('ERR_PROPOSAL_NOT_READY_FOR_VOTE');
      if (proposal.votes[signerId]) return fail('ERR_ALREADY_VOTED');
      proposal.votes[signerId] = ['Approve', 'Reject', 'Remove'][vote];
      for (const role of roles) {
        proposal.vote_counts[role.name] ||= [0, 0, 0];
        proposal.vote_counts[role.name][vote] += 1;
      }
      proposal.status = this.daoStatus(dao, proposal);
      if (proposal.status === 'Approved') {
        const call = proposal.kind.FunctionCall;
        for (const action of call.actions) {
          const done = this.call({ signerId: contractId, contractId: call.receiver_id, method: action.method_name,
            args: JSON.parse(Buffer.from(action.args, 'base64').toString('utf8')), depositYocto: action.deposit });
          if (!done.ok) proposal.status = 'Failed';
        }
      }
      return this.record({ signer: signerId, receiver: contractId, method, args, deposit: depositYocto });
    }
    return fail(`MethodNotFound ${method}`);
  }

  daoView(daoId, method, args) {
    const dao = this.daos.get(daoId);
    if (method === 'get_policy') return structuredClone(dao.policy);
    if (method === 'get_last_proposal_id') return dao.proposals.length;
    if (method === 'get_proposal') {
      if (!dao.proposals[args.id]) throw new Error('NEAR view error: ERR_NO_PROPOSAL');
      return structuredClone(dao.proposals[args.id]);
    }
    if (method === 'get_proposals') return structuredClone(dao.proposals.slice(args.from_index, args.from_index + args.limit));
    if (method === 'version') return '2.0.0';
    throw new Error(`unsupported fake DAO view ${method}`);
  }

  nowNs() { return BigInt(Date.now() + this.offsetMs) * 1000000n; }
  advance(ms) { this.offsetMs += ms; }

  record({ signer, receiver, method = null, args = null, deposit = '0', failure = null, value = '' }) {
    this.height += 1;
    const hash = baseEncode(randomBytes(32));
    const tx = { final_execution_status: 'FINAL',
      transaction: { hash, signer_id: signer, receiver_id: receiver,
        actions: method ? [{ FunctionCall: { method_name: method, args: Buffer.from(JSON.stringify(args)).toString('base64'), deposit, gas: 100000000000000 } }] : [{ Transfer: {} }] },
      status: failure ? { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: failure } } } } } : { SuccessValue: Buffer.from(value).toString('base64') } };
    this.txs.set(hash, tx);
    let parsed = null;
    if (!failure && value) { try { parsed = JSON.parse(value); } catch { parsed = value; } }
    return { hash, ok: !failure, value: parsed, failure };
  }

  credit(account, amount) { this.credits.set(account, (this.credits.get(account) || 0n) + amount); }

  settle(bet, outcome, method) {
    if (outcome === 'void') { this.credit(bet.creator, bet.stake); this.credit(bet.acceptor, bet.stake); }
    else this.credit(outcome === bet.creator_side ? bet.creator : bet.acceptor, bet.stake * 2n);
    bet.status = 'settled';
    bet.resolution = { outcome, method, resolved_at_ns: this.nowNs().toString() };
  }

  // The contract's rules. A thrown string is the panic message.
  apply(signer, method, args, deposit) {
    const now = this.nowNs();
    const bet = method === 'create_bet' || method === 'withdraw' ? null : this.bets.get(args.id);
    if (method !== 'create_bet' && method !== 'withdraw' && !bet) throw 'Bet not found';
    const active = () => { if (!['accepted', 'proposed', 'disputed'].includes(bet.status)) throw 'Bet is not active'; };
    const current = () => {
      if (bet.status !== 'proposed') throw 'Proposal is not open';
      if (bet.proposal.id !== args.proposal_id) throw 'Proposal is stale';
      if (bet.proposal.revision !== String(args.expected_revision)) throw 'Proposal revision is stale';
    };
    const other = () => { current(); if (![bet.creator, bet.acceptor].includes(signer)) throw 'Only participants can resolve'; if (bet.proposal.proposer === signer) throw 'Other participant must respond'; };
    switch (method) {
      case 'create_bet': {
        if (this.bets.has(args.id)) throw 'Bet already exists';
        const stake = BigInt(args.stake_yocto);
        if (deposit !== stake + STORAGE_FEE) throw 'Deposit must equal stake plus storage fee';
        if (!(now < BigInt(args.accept_by_ns) && BigInt(args.accept_by_ns) < BigInt(args.resolve_at_ns))) throw 'Invalid deadlines';
        if (args.referee && this.version < 2) throw 'Unknown argument referee';
        if (args.referee && (args.referee === signer || args.referee === args.invited_account)) throw 'Referee cannot be a participant';
        this.bets.set(args.id, { id: args.id, terms_hash: args.terms_hash, creator_binding_hash: args.binding_hash, acceptor_binding_hash: null,
          creator: signer, acceptor: null, invited_account: args.invited_account || null, creator_side: args.creator_side, stake,
          accept_by_ns: args.accept_by_ns, resolve_at_ns: args.resolve_at_ns, status: 'offered', proposal: null,
          referee: args.referee || null, resolution: null });
        return '';
      }
      case 'accept_bet':
        if (bet.status !== 'offered') throw 'Bet is not offered';
        if (now >= BigInt(bet.accept_by_ns)) throw 'Acceptance deadline passed';
        if (signer === bet.creator) throw 'Creator cannot accept own bet';
        if (signer === bet.referee) throw 'Referee cannot be a participant';
        if (bet.invited_account && bet.invited_account !== signer) throw 'Account is not invited';
        if (deposit !== bet.stake) throw 'Deposit must equal stake';
        Object.assign(bet, { acceptor: signer, acceptor_binding_hash: args.binding_hash, status: 'accepted' });
        return '';
      case 'cancel_bet':
        if (signer !== bet.creator) throw 'Only creator can cancel';
        if (bet.status !== 'offered') throw 'Only offered bet can be cancelled';
        bet.status = 'cancelled'; this.credit(bet.creator, bet.stake); return '';
      case 'expire_bet':
        if (bet.status !== 'offered') throw 'Only offered bet can expire';
        if (now < BigInt(bet.accept_by_ns)) throw 'Acceptance deadline has not passed';
        bet.status = 'expired'; this.credit(bet.creator, bet.stake); return '';
      case 'propose_outcome':
        active();
        if (now < BigInt(bet.resolve_at_ns)) throw 'Resolution time has not arrived';
        if (now >= BigInt(bet.resolve_at_ns) + RESOLUTION_WINDOW) throw 'Resolution window closed; refund required';
        if (![bet.creator, bet.acceptor].includes(signer)) throw 'Only participants can resolve';
        bet.proposal = { id: args.proposal_id, revision: String(BigInt(bet.proposal?.revision || '0') + 1n), outcome: args.outcome, proposer: signer, proposed_at_ns: now.toString() };
        bet.status = 'proposed'; return '';
      case 'confirm_outcome': active(); other(); this.settle(bet, bet.proposal.outcome, 'agreement'); return '';
      case 'dispute_outcome': active(); other(); bet.status = 'disputed'; return '';
      case 'finalize_unanswered':
        active(); current();
        if (bet.referee) throw 'A referee decides this bet';
        if (bet.proposal.proposer !== signer) throw 'Only the proposer can finalize';
        if (now < BigInt(bet.proposal.proposed_at_ns) + RESPONSE_WINDOW) throw 'Response window remains open';
        this.settle(bet, bet.proposal.outcome, 'unanswered'); return '';
      case 'referee_resolve':
        if (!bet.referee || bet.referee !== signer) throw 'Only the referee can resolve';
        active(); this.settle(bet, args.outcome, 'referee'); return '';
      case 'refund_unresolved':
        active();
        if (bet.status === 'proposed' && !bet.referee) throw 'An unanswered result stands; dispute it or let it finalize';
        if (now < BigInt(bet.resolve_at_ns) + RESOLUTION_WINDOW) throw 'Resolution window remains open';
        bet.status = 'refunded'; this.credit(bet.creator, bet.stake); this.credit(bet.acceptor, bet.stake); return '';
      case 'withdraw': {
        const amount = this.credits.get(signer) || 0n;
        if (amount === 0n) throw 'No withdrawal credit';
        this.credits.set(signer, 0n);
        this.accounts.get(signer).balance += amount;
        return 'true';
      }
      default: throw `MethodNotFound ${method}`;
    }
  }

  call({ signerId, contractId, method, args, depositYocto = '0', gas = 100_000_000_000_000n }) {
    const signer = this.accounts.get(signerId);
    const deposit = BigInt(depositYocto);
    this.sent.push({ signerId, method, args, depositYocto });
    if (!signer || contractId !== this.contract) return { hash: null, ok: false, failure: 'unknown account' };
    if (signer.balance < deposit + callCost(gas)) return { hash: null, ok: false, failure: 'NotEnoughBalance' };
    try {
      const value = this.apply(signerId, method, args, deposit);
      signer.balance -= deposit;
      return this.record({ signer: signerId, receiver: contractId, method, args, deposit: depositYocto, value });
    } catch (failure) {
      if (typeof failure !== 'string') throw failure;
      return this.record({ signer: signerId, receiver: contractId, method, args, deposit: depositYocto, failure });
    }
  }

  view(bet) {
    if (!bet) return null;
    const { stake, ...rest } = bet;
    const shown = { ...rest, stake_yocto: stake.toString() };
    if (this.version < 2) {
      delete shown.referee; delete shown.resolution;
      if (shown.proposal) { const { proposed_at_ns: _, ...proposal } = shown.proposal; shown.proposal = proposal; }
    }
    return shown;
  }

  rpc({ method, params }) {
    const view = (value) => json({ result: { block_height: this.height, block_hash: 'fakeblock', result: [...Buffer.from(JSON.stringify(value))] } });
    if (method === 'block') return json({ result: { header: { height: this.height, hash: 'fakeblock', timestamp_nanosec: this.nowNs().toString() } } });
    if (method === 'tx') {
      const tx = this.txs.get(params.tx_hash);
      return tx ? json({ result: tx }) : json({ error: { message: 'Transaction not found', cause: { name: 'UNKNOWN_TRANSACTION' } } });
    }
    if (method === 'query' && params.request_type === 'view_account') {
      const account = this.accounts.get(params.account_id);
      return account ? json({ result: { amount: account.balance.toString() } }) : json({ error: { message: `account ${params.account_id} does not exist` } });
    }
    if (method === 'query' && params.request_type === 'call_function') {
      const args = JSON.parse(Buffer.from(params.args_base64, 'base64').toString());
      if (params.method_name === 'get_bet') return view(this.view(this.bets.get(args.id)));
      if (params.method_name === 'get_credit') return view((this.credits.get(args.account_id) || 0n).toString());
      if (params.method_name === 'version') return this.version >= 2 ? view('2') : json({ error: { message: 'MethodNotFound' } });
    }
    return json({ error: { message: `unsupported fake rpc ${method}` } });
  }
}
