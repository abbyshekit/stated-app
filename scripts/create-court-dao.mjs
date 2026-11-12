// INTEGRATION: Testnet operator command. Dry-run by default; --yes creates a DAO.
// COURT_CREATOR_ACCOUNT and COURT_CREATOR_KEY come from the environment only.
// node scripts/create-court-dao.mjs --name stated-court --relay relay.parent.testnet --council council.testnet [--yes]
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { isDeepStrictEqual } from 'node:util';

export const HOSTED_COURT = Object.freeze({ dao: 'stated-court.sputnik-v2.testnet', escrow: 'stated-escrow-52081551be.testnet',
  operator: 'referee.stated-play-6cf0876dd7.testnet', council: 'stated-court-18ecdebd.testnet', windowSeconds: 600 });
export const FACTORY = 'sputnik-v2.testnet';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
export const testnetAccount = (id) => typeof id === 'string' && /^(?=.{2,64}$)[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*\.testnet$/.test(id);
export function requireTestnet(env) {
  if (env.STATED_NEAR_NETWORK && env.STATED_NEAR_NETWORK !== 'testnet') throw new Error('Testnet only. Set STATED_NEAR_NETWORK=testnet.');
}
export function operatorError(error, env = process.env) {
  let message = String(error?.message || error).replace(/ed25519:[A-Za-z0-9]+/g, '[redacted]');
  for (const [name, value] of Object.entries(env)) {
    if (/(?:KEY|SECRET|TOKEN|PASSWORD)/i.test(name) && typeof value === 'string' && value.length > 3) message = message.replaceAll(value, '[redacted]');
  }
  return message.slice(0, 1000);
}
export function flag(argv, name) {
  if (!argv.includes(name)) return null;
  const value = argv[argv.indexOf(name) + 1];
  if (!value || value.startsWith('--')) throw new Error(`${name} requires a value.`);
  return value;
}
export function assertRelayConfig(config, court = HOSTED_COURT) {
  if (config?.dao !== court.dao || config?.escrow !== court.escrow || config?.operator !== court.operator
    || String(config?.window_ns) !== String(BigInt(court.windowSeconds) * 1_000_000_000n)) {
    throw new Error(`Relay configuration must match the DAO, escrow, operator and ${court.windowSeconds}-second window exactly.`);
  }
}

// Sputnik stores role permissions and Group members as hash sets and returns them in hash order, so
// a policy read back from chain is compared after sorting both (ChangePolicy kinds included).
export function normalizePolicy(policy) {
  const copy = structuredClone(policy);
  for (const role of copy?.roles || []) {
    if (Array.isArray(role.permissions)) role.permissions.sort();
    if (Array.isArray(role.kind?.Group)) role.kind.Group.sort();
  }
  return copy;
}
export const samePolicy = (a, b) => isDeepStrictEqual(normalizePolicy(a), normalizePolicy(b));
export const sameKind = (a, b) => (a?.ChangePolicy && b?.ChangePolicy
  ? samePolicy(a.ChangePolicy.policy, b.ChangePolicy.policy) && isDeepStrictEqual(Object.keys(a), Object.keys(b))
  : isDeepStrictEqual(a, b));

export function courtPolicy({ relay, council }) {
  if (!testnetAccount(relay)) throw new Error('A .testnet relay account is required.');
  if (!Array.isArray(council) || !council.length || !council.every(testnetAccount) || new Set(council).size !== council.length
    || council.includes(relay)) throw new Error('Council must contain distinct .testnet accounts, excluding the relay.');
  // Frozen policy: there is deliberately no policy-management permission after hardening.
  // The immutable relay alone proposes/approves calls; council can only reject or remove them.
  return {
    roles: [
      { name: 'jury', kind: { Group: [relay] }, permissions: ['call:AddProposal', 'call:VoteApprove'], vote_policy: {} },
      { name: 'council', kind: { Group: council }, permissions: ['call:VoteReject', 'call:VoteRemove'], vote_policy: {} },
    ],
    default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 2] },
    proposal_bond: '0', proposal_period: '604800000000000', bounty_bond: '0', bounty_forgiveness_period: '86400000000000',
  };
}

export async function createCourt({ argv = process.argv.slice(2), env = process.env, chain, log = console.log, evidenceRoot = root } = {}) {
  requireTestnet(env);
  const name = flag(argv, '--name');
  const relay = flag(argv, '--relay');
  const council = String(flag(argv, '--council') || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || `${name}.${FACTORY}`.length > 64) throw new Error('--name takes lowercase letters, digits and hyphens.');
  const dao = `${name}.${FACTORY}`;
  const daoArgs = { config: { name, purpose: 'Holds the referee seat for Stated bets. The immutable jury relay enforces the council correction window.', metadata: '' },
    policy: courtPolicy({ relay, council }) };
  const createArgs = { name, args: Buffer.from(JSON.stringify(daoArgs)).toString('base64') };
  log(`DAO: ${dao}\nFactory: ${FACTORY}.create; deposit 6 NEAR; gas 300 Tgas\nFrozen policy: no future policy-management permissions.`);
  log(JSON.stringify(daoArgs, null, 2));
  if (!argv.includes('--yes') || argv.includes('--dry-run')) {
    log('Dry run: nothing was sent. Pass --yes to create.');
    return { dryRun: true, dao, daoArgs, createArgs };
  }
  const creator = env.COURT_CREATOR_ACCOUNT;
  const secret = env.COURT_CREATOR_KEY;
  if (!testnetAccount(creator) || !secret) throw new Error('Set COURT_CREATOR_ACCOUNT and COURT_CREATOR_KEY.');
  chain ||= (await import('../server/src/play.mjs')).nearChain();
  if ((await chain.balance(dao)) != null) throw new Error(`${dao} already exists.`);
  const balance = await chain.balance(creator);
  if (balance == null || BigInt(balance) < 65n * 10n ** 23n) throw new Error('Creator needs at least 6.5 test NEAR.');
  const sent = await chain.call({ signerId: creator, secret, contractId: FACTORY, method: 'create', args: createArgs,
    depositYocto: String(6n * 10n ** 24n), gas: 300_000_000_000_000n });
  if (!sent.ok) throw new Error('Factory creation did not reach final success. Inspect the transaction before retrying.');
  const policy = await chain.view({ contractId: dao, method: 'get_policy' });
  if (!samePolicy(policy, daoArgs.policy)) throw new Error('Created policy does not match the requested frozen policy.');
  const evidence = { dao, factory: FACTORY, creator, transactionHash: sent.hash, args: daoArgs, policy, createdAt: new Date().toISOString() };
  const file = resolve(evidenceRoot, `evidence/court-dao-${dao}-${evidence.createdAt.slice(0, 10)}.json`);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  log(`Created ${dao}; transaction ${sent.hash}; evidence ${file}`);
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  createCourt().catch((error) => { console.error(operatorError(error)); process.exitCode = 1; });
}
