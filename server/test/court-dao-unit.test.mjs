import test from 'node:test';
import assert from 'node:assert/strict';
import * as court from '../src/court-dao.mjs';
import { loadConfig } from '../src/config.mjs';
import { seal } from '../src/crypto.mjs';
import { fingerprint } from '../src/canonical.mjs';

const DAO = 'court.sputnik-v2.testnet';
const RELAY = 'relay.bank.testnet';
const OPERATOR = 'referee.bank.testnet';
const BET = 'c171de89-f223-4309-886e-180ad69af092';
const config = { nearContract: 'escrow.testnet', near: { network: 'testnet' }, tokenKey: 'test-only',
  court: { dao: DAO, relay: RELAY, operator: OPERATOR }, play: { settleDelaySeconds: 600 } };

test('proposalTarget rejects non-UUID ids before the page uuid[] query', () => {
  assert.equal(court.proposalTarget(config, { kind: court.proposalKind(config, 'not-a-uuid', 'yes') }), null);
});

test('relay setting rejects invalid or wrong-network accounts instead of silently disabling protection', () => {
  for (const relay of ['bad..testnet', 'relay.near', 'x', 'UPPER.testnet']) {
    assert.throws(() => loadConfig({ STATED_COURT_DAO: DAO, STATED_COURT_RELAY: relay }));
  }
  assert.equal(loadConfig({ STATED_COURT_DAO: DAO, STATED_COURT_RELAY: RELAY }).court.relay, RELAY);
});

function harness({ relay = RELAY } = {}) {
  const cfg = structuredClone(config);
  cfg.court.relay = relay;
  let revision = '7';
  const events = [];
  const proposals = [];
  const sent = [];
  const record = { outcome: 'yes', nested: { z: 1, a: 2 } };
  const db = {
    async one(sql, params) {
      if (sql.includes('from kv')) return { value: seal(JSON.stringify({ id: OPERATOR, secret: 'not-a-real-key' }), cfg.tokenKey) };
      if (sql.includes('from revisions') || sql.includes('join revisions')) return { result_revision: revision, at: new Date('2026-11-12T00:00:00Z') };
      if (sql.includes("kind = 'enclave_ruling'")) return { detail: record };
      if (sql.includes("kind = 'court_proposal'")) return { detail: events.find(e => e.outcome === params[1] && e.resultRevision === params[2]) };
      throw new Error(`Unexpected query ${sql}`);
    },
    async query(sql, params) { assert.match(sql, /insert into bilateral_bet_events/); events.push(params[2]); },
  };
  const policy = { roles: [
    { name: 'jury', kind: { Group: [relay || OPERATOR] }, permissions: ['call:AddProposal', 'call:VoteApprove'], vote_policy: {} },
    { name: 'council', kind: { Group: ['council.testnet'] }, permissions: ['call:VoteReject', 'call:VoteRemove'], vote_policy: {} },
  ], default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 2] }, proposal_bond: '0',
  proposal_period: '604800000000000', bounty_bond: '0', bounty_forgiveness_period: '86400000000000' };
  const chain = {
    async balance() { return '1000000000000000000000000'; },
    async view({ contractId, method, args }) {
      if (method === 'version') return '2.0.0';
      if (method === 'get_config') return { dao: DAO, escrow: cfg.nearContract, operator: OPERATOR, window_ns: '600000000000' };
      if (method === 'get_policy') return policy;
      if (method === 'get_last_proposal_id') return proposals.length;
      if (method === 'get_proposals') return proposals.slice(args.from_index, args.from_index + args.limit);
      if (method === 'get_proposal') { assert.equal(contractId, DAO); return proposals[args.id]; }
      throw new Error(`Unexpected view ${method}`);
    },
    async call(call) {
      sent.push(call);
      if (call.method === 'file' || call.method === 'add_proposal') {
        const proposal = call.method === 'file' ? { description: call.args.description, kind: court.proposalKind(cfg, call.args.id, call.args.outcome) } : call.args.proposal;
        const id = proposals.length;
        proposals.push({ ...proposal, id, proposer: relay || OPERATOR, status: 'InProgress', votes: {}, submission_time: '1794441600000000000' });
        return { ok: true, hash: 'synthetic', value: id };
      }
      const p = proposals[call.args.id];
      p.votes[relay || OPERATOR] = 'Approve'; p.status = 'Approved';
      return { ok: true, hash: 'synthetic' };
    },
  };
  return { cfg, db, chain, sent, events, proposals, record, policy, revise: () => { revision = String(BigInt(revision) + 1n); } };
}

test('relay filing binds canonical ruling hash and Result revision; retries recover lost replies and veto permits a new revision', async () => {
  const h = harness();
  const bet = { id: BET, referee_wallet: DAO };
  const first = await court.fileRuling(h.db, h.cfg, h.chain, bet, 'yes', { rulingUrl: 'https://example.org' });
  assert.equal(h.sent[0].contractId, RELAY);
  assert.equal(h.sent[0].method, 'file');
  assert.equal(h.sent[0].signerId, OPERATOR);
  assert.match(h.sent[0].args.description, new RegExp(`ruling sha256:${fingerprint(h.record)}(?: |$)`));
  assert.match(h.sent[0].args.description, /Result revision:7(?: |$)/);
  h.proposals[0].status = 'Rejected';
  assert.deepEqual(await court.fileRuling(h.db, h.cfg, h.chain, bet, 'yes'), first);
  h.revise();
  const second = await court.fileRuling(h.db, h.cfg, h.chain, bet, 'yes');
  assert.notEqual(second.proposalId, first.proposalId);
  h.events.pop(); // reply landed on chain, append-only local event was lost
  const recovered = await court.fileRuling(h.db, h.cfg, h.chain, bet, 'yes');
  assert.equal(recovered.proposalId, second.proposalId);
  assert.equal(recovered.txHash, null);
  assert.equal(h.sent.length, 2);
});

test('relay approval uses 300 Tgas and relay vote identity; legacy path still files and votes directly', async () => {
  for (const relay of [RELAY, '']) {
    const h = harness({ relay });
    const filed = await court.fileRuling(h.db, h.cfg, h.chain, { id: BET, referee_wallet: DAO }, 'yes', { reviewer: true });
    const result = await court.approveRuling(h.db, h.cfg, h.chain, filed);
    assert.equal(result.hash, 'synthetic');
    const vote = h.sent[1];
    assert.equal(vote.method, relay ? 'approve' : 'act_proposal');
    assert.equal(vote.contractId, relay || DAO);
    assert.equal(vote.gas, relay ? 300_000_000_000_000n : 200_000_000_000_000n);
    assert.equal((await court.approveRuling(h.db, h.cfg, h.chain, filed)).hash, null);
    assert.equal(h.sent.length, 2);
  }
});

test('startup gate accepts the frozen policy and fails closed on each trust-model mutation', async () => {
  assert.deepEqual(await court.checkCourt(harness().cfg, harness().chain), []);
  const mutations = [
    h => { h.cfg.court.dao = 'court.near'; },
    h => { h.cfg.court.operator = ''; h.cfg.play.treasury = ''; },
    h => { h.policy.roles[0].kind.Group.push(OPERATOR); },
    h => { h.policy.roles[0].kind.Group = [OPERATOR]; },
    h => { h.policy.roles[0].permissions.push('*:*'); },
    h => { h.policy.roles[1].permissions = ['*:*']; },
    h => { h.policy.roles[1].permissions.push('policy:VoteApprove'); },
    h => { h.policy.roles.push({ name: 'other', kind: 'Everyone', permissions: ['*:*'] }); },
    h => { h.policy.roles[0].vote_policy = { call: { threshold: '0' } }; },
    h => { h.policy.default_vote_policy.threshold = [0, 1]; },
    h => { h.policy.proposal_bond = '2000000000000000000000000'; },
    h => { h.policy.proposal_bond = 'invalid'; },
    h => { h.chain.balance = async () => null; },
    h => { const view = h.chain.view; h.chain.view = c => c.method === 'version' ? 'other' : view(c); },
    h => { h.chain.view = async () => { throw new Error('RPC unavailable'); }; },
  ];
  for (const mutate of mutations) {
    const h = harness(); mutate(h);
    assert.ok((await court.checkCourt(h.cfg, h.chain)).length, mutate.toString());
    assert.equal(h.sent.length, 0);
  }
  for (const field of ['dao', 'escrow', 'operator', 'window_ns']) {
    const h = harness(); const view = h.chain.view;
    h.chain.view = async c => c.method === 'get_config' ? { ...await view(c), [field]: 'wrong' } : view(c);
    assert.ok((await court.checkCourt(h.cfg, h.chain)).some(p => p.includes('relay config')), field);
  }
});

test('lost filing recovery searches beyond the last 100 proposals', async () => {
  const h = harness();
  const bet = { id: BET, referee_wallet: DAO };
  const first = await court.fileRuling(h.db, h.cfg, h.chain, bet, 'yes', { reviewer: true });
  h.events.length = 0;
  for (let i = 0; i < 101; i++) h.proposals.push({ id: i + 1, description: 'unrelated' });
  assert.equal((await court.fileRuling(h.db, h.cfg, h.chain, bet, 'yes', { reviewer: true })).proposalId, first.proposalId);
  assert.equal(h.sent.length, 1);
});
