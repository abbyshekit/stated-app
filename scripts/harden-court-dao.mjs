// INTEGRATION: Irreversibly freezes the hosted court policy. Testnet only, dry-run default.
// COURT_COUNCIL_ACCOUNT / COURT_COUNCIL_KEY are environment-only signer credentials.
// node scripts/harden-court-dao.mjs --relay relay.parent.testnet [--yes]
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';
import { HOSTED_COURT, assertRelayConfig, courtPolicy, flag, operatorError, requireTestnet, sameKind, samePolicy, testnetAccount } from './create-court-dao.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const allows = (role, action) => role.permissions?.some((p) => ['*:*', `policy:${action}`, `*:${action}`, 'policy:*'].includes(p));

export function assertCouncilCanHarden(policy, account) {
  const role = policy?.roles?.find((r) => r.name === 'council' && r.kind?.Group?.includes(account));
  if (!role || !allows(role, 'AddProposal') || !allows(role, 'VoteApprove')) throw new Error('Current council lacks ChangePolicy proposal/approval permissions.');
  const vote = role.vote_policy?.policy || policy.default_vote_policy;
  if (role.kind.Group.length !== 1 || vote?.weight_kind !== 'RoleWeight' || String(vote.quorum) !== '0'
    || !Array.isArray(vote.threshold) || vote.threshold[0] !== 1 || vote.threshold[1] !== 2) {
    throw new Error('This command requires the current single-member council and majority policy; multi-voter migration needs a separate reviewed plan.');
  }
  if (!/^\d+$/.test(String(policy.proposal_bond))) throw new Error('Current proposal bond is invalid.');
}

export async function assertLockedRelay({ relay, query, wasm, encodeHash }) {
  const state = await query('query', { request_type: 'view_account', finality: 'final', account_id: relay });
  const keys = await query('query', { request_type: 'view_access_key_list', finality: 'final', account_id: relay });
  const sha256 = createHash('sha256').update(wasm).digest();
  if (state?.code_hash !== encodeHash(sha256)) throw new Error('Relay code hash differs from the local jury-relay WASM. Build and review the exact deployment before freezing.');
  if (!Array.isArray(keys?.keys) || keys.keys.length !== 0) throw new Error('Relay must have zero access keys before the DAO can be frozen.');
  return { wasmSha256: sha256.toString('hex'), codeHash: state.code_hash, accessKeys: 0 };
}

export async function hardenCourt({ argv = process.argv.slice(2), env = process.env, chain, query, encodeHash,
  readWasm = readFile, log = console.log, evidenceRoot = root, projectRoot = root } = {}) {
  requireTestnet(env);
  const relay = flag(argv, '--relay') || env.STATED_COURT_RELAY;
  // The hosted court by default; --dao, --operator and --window-seconds rehearse the same freeze on a test DAO.
  const window = flag(argv, '--window-seconds');
  if (window !== null && !/^\d+$/.test(window)) throw new Error('--window-seconds requires a whole number of seconds.');
  const court = Object.freeze({ ...HOSTED_COURT, ...(flag(argv, '--dao') ? { dao: flag(argv, '--dao') } : {}),
    ...(flag(argv, '--operator') ? { operator: flag(argv, '--operator') } : {}), ...(window !== null ? { windowSeconds: Number(window) } : {}) });
  if (!testnetAccount(court.dao) || !testnetAccount(court.operator)) throw new Error('--dao and --operator take .testnet accounts.');
  if (!testnetAccount(relay) || [court.dao, court.operator, court.council, court.escrow].includes(relay)) throw new Error('Supply a distinct .testnet relay with --relay.');
  const account = env.COURT_COUNCIL_ACCOUNT;
  if (account !== court.council) throw new Error(`Set COURT_COUNCIL_ACCOUNT=${court.council}.`);
  chain ||= (await import('../server/src/play.mjs')).nearChain();
  query ||= (await import('../server/src/near-escrow.mjs')).rpc;
  encodeHash ||= (await import('near-api-js')).baseEncode;
  const wasm = await readWasm(resolve(projectRoot, 'contracts/jury-relay/target/near/stated_jury_relay.wasm'));
  const locked = await assertLockedRelay({ relay, query, wasm, encodeHash });
  const config = await chain.view({ contractId: relay, method: 'get_config' });
  assertRelayConfig(config, court);
  const current = await chain.view({ contractId: court.dao, method: 'get_policy' });
  const policy = courtPolicy({ relay, council: [account] });
  // Preserve the deployed economic and voting defaults; refuse unexpected drift.
  for (const key of ['default_vote_policy', 'proposal_bond', 'proposal_period', 'bounty_bond', 'bounty_forgiveness_period']) {
    if (!isDeepStrictEqual(current[key], policy[key])) throw new Error(`Current ${key} differs from the established court defaults. Review before freezing.`);
  }
  log('New frozen policy (no policy-management permissions remain):');
  log(JSON.stringify(policy, null, 2));
  if (samePolicy(current, policy)) { log('Policy already hardened. Nothing was sent.'); return { alreadyHardened: true, policy }; }
  assertCouncilCanHarden(current, account);
  if (!argv.includes('--yes') || argv.includes('--dry-run')) { log('Dry run: nothing was sent. Pass --yes to freeze this policy.'); return { dryRun: true, policy }; }
  if (!env.COURT_COUNCIL_KEY) throw new Error('Set COURT_COUNCIL_KEY.');
  // Re-read immediately before mutation; a changed policy invalidates this reviewed plan.
  if (!samePolicy(await chain.view({ contractId: court.dao, method: 'get_policy' }), current)) throw new Error('DAO policy changed during preflight. Nothing was sent.');
  assertRelayConfig(await chain.view({ contractId: relay, method: 'get_config' }), court);
  await assertLockedRelay({ relay, query, wasm, encodeHash });
  const kind = { ChangePolicy: { policy } };
  const call = (method, args, depositYocto = '0') => chain.call({ signerId: account, secret: env.COURT_COUNCIL_KEY,
    contractId: court.dao, method, args, depositYocto, gas: 200_000_000_000_000n });
  const added = await call('add_proposal', { proposal: { description: `Freeze Stated Court behind immutable jury relay ${relay}.`, kind } }, String(current.proposal_bond));
  if (!added.ok || added.value === null || added.value === '' || !Number.isSafeInteger(Number(added.value)) || Number(added.value) < 0) throw new Error('ChangePolicy filing unconfirmed. Inspect chain state before retrying.');
  const id = Number(added.value);
  let proposal = await chain.view({ contractId: court.dao, method: 'get_proposal', args: { id } });
  if (!sameKind(proposal.kind, kind)) throw new Error('Filed ChangePolicy content differs. Refusing to approve.');
  let approved = null;
  if (proposal.status === 'InProgress') {
    approved = await call('act_proposal', { id, action: 'VoteApprove', proposal: kind });
    if (!approved.ok) throw new Error('ChangePolicy approval unconfirmed. Inspect the proposal before retrying.');
    proposal = await chain.view({ contractId: court.dao, method: 'get_proposal', args: { id } });
  }
  const final = await chain.view({ contractId: court.dao, method: 'get_policy' });
  const verified = proposal.status === 'Approved' && samePolicy(final, policy);
  const hardenedAt = new Date().toISOString();
  const evidence = { hardenedAt, dao: court.dao, relay, config, locked, council: account, proposalId: id,
    proposalTransaction: added.hash, approvalTransaction: approved?.hash ?? null, proposalStatus: proposal.status, verified, policy: final };
  const file = resolve(evidenceRoot, `evidence/court-harden-testnet-${hardenedAt.slice(0, 10).replaceAll('-', '')}.json`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`);
  log(`Evidence: ${file}`);
  if (!verified) throw new Error('Final policy verification failed. Inspect proposal and policy before proceeding.');
  log('Frozen policy verified on chain.');
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  hardenCourt().catch((error) => { console.error(operatorError(error)); process.exitCode = 1; });
}
