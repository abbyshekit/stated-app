// INTEGRATION: Explicitly invoked, testnet only. Creates Stated Court, the Sputnik DAO that
// holds the referee seat of new reply Bets, through the sputnik-v2.testnet factory.
//
//   COURT_CREATOR_ACCOUNT  the testnet account that pays (about 6 NEAR, plus gas)
//   COURT_CREATOR_KEY      its full-access key (ed25519:...). Read from the environment only; never printed.
//
//   node scripts/create-court-dao.mjs --name stated-court --council alice.testnet,bob.testnet --dry-run
//   node scripts/create-court-dao.mjs --name stated-court --council alice.testnet,bob.testnet
//   --jury <account>   the jury member (default: the hosted referee account)
//
// The policy has two roles. jury: the referee account, which may only add FunctionCall
// proposals and vote to approve them. council: may do anything, including voting a ruling down.
// Each role votes on its own (RoleWeight, more than half), with no proposal bond.
// The policy JSON shape matches sodalis.sputnik-v2.testnet's get_policy (version 2.0.0).
import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadConfig } from '../server/src/config.mjs';
import { network, transactionLink, accountLink } from '../server/src/near-network.mjs';
import { nearChain } from '../server/src/play.mjs';

const FACTORY = 'sputnik-v2.testnet';
const DEPOSIT_YOCTO = (6n * 10n ** 24n).toString();
const GAS = 300_000_000_000_000n;
const DEFAULT_JURY = 'referee.stated-play-6cf0876dd7.testnet';
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (name) => (argv.includes(name) ? argv[argv.indexOf(name) + 1] : null);
const fail = (message) => { console.error(message); process.exit(1); };
const testnetAccount = (id) => /^(?=.{2,64}$)[a-z0-9]+(?:[-_][a-z0-9]+)*(?:\.[a-z0-9]+(?:[-_][a-z0-9]+)*)*\.testnet$/.test(id);

loadConfig(process.env); // selects the network
if (network().id !== 'testnet') fail('Stated Court is created on testnet only. Unset STATED_NEAR_NETWORK.');
const name = flag('--name');
const jury = flag('--jury') || DEFAULT_JURY;
const council = String(flag('--council') || '').split(',').map((s) => s.trim()).filter(Boolean);
const dryRun = argv.includes('--dry-run');
if (!name || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name) || `${name}.${FACTORY}`.length > 64) fail('--name takes lowercase letters, digits and hyphens.');
if (!testnetAccount(jury)) fail('--jury must be a .testnet account.');
if (!council.length || !council.every(testnetAccount)) fail('--council takes one or more .testnet accounts, comma-separated.');
if (council.includes(jury)) fail('The jury account cannot also sit on the council.');

export function courtPolicy({ jury, council }) {
  return {
    roles: [
      { name: 'jury', kind: { Group: [jury] }, permissions: ['call:AddProposal', 'call:VoteApprove'], vote_policy: {} },
      { name: 'council', kind: { Group: council }, permissions: ['*:*'], vote_policy: {} },
    ],
    default_vote_policy: { weight_kind: 'RoleWeight', quorum: '0', threshold: [1, 2] },
    proposal_bond: '0',
    proposal_period: '604800000000000',
    bounty_bond: '0',
    bounty_forgiveness_period: '86400000000000',
  };
}

const daoArgs = {
  config: { name, purpose: 'Holds the referee seat for Stated bets. The enclave jury files each ruling here; the council can vote one down before it pays.', metadata: '' },
  policy: courtPolicy({ jury, council }),
};
const createArgs = { name, args: Buffer.from(JSON.stringify(daoArgs)).toString('base64') };
const dao = `${name}.${FACTORY}`;

console.log(`DAO: ${dao}`);
console.log(`Factory call: ${FACTORY}.create, attached deposit 6 NEAR, gas 300 Tgas`);
console.log('DAO arguments:');
console.log(JSON.stringify(daoArgs, null, 2));
if (dryRun) {
  console.log('create arguments (as sent):');
  console.log(JSON.stringify(createArgs));
  console.log('Dry run: nothing was sent.');
  process.exit(0);
}

const creator = process.env.COURT_CREATOR_ACCOUNT || '';
const key = process.env.COURT_CREATOR_KEY || '';
if (!testnetAccount(creator) || !key) fail('Set COURT_CREATOR_ACCOUNT (a .testnet account with 6.5 NEAR or more) and COURT_CREATOR_KEY.');
const chain = nearChain();
if ((await chain.balance(dao)) != null) fail(`${dao} already exists. Choose another --name.`);
const balance = await chain.balance(creator);
if (balance == null || BigInt(balance) < BigInt(DEPOSIT_YOCTO) + 5n * 10n ** 23n) fail(`${creator} needs about 6.5 NEAR; it has ${balance ?? 'no account'}.`);

const sent = await chain.call({ signerId: creator, secret: key, contractId: FACTORY, method: 'create', args: createArgs, depositYocto: DEPOSIT_YOCTO, gas: GAS });
if (!sent.ok) fail(`The factory did not create the DAO: ${sent.failure || 'not accepted'} (transaction ${sent.hash || 'none'})`);
const policy = await chain.view({ contractId: dao, method: 'get_policy' });
const version = await chain.view({ contractId: dao, method: 'version' }).catch(() => null);
console.log(`Created ${dao} in ${transactionLink(sent.hash)}`);
console.log('get_policy:');
console.log(JSON.stringify(policy, null, 2));
const date = new Date().toISOString().slice(0, 10);
const file = resolve(root, `evidence/court-dao-${name}-${date}.json`);
await mkdir(dirname(file), { recursive: true });
await writeFile(file, `${JSON.stringify({ dao, factory: FACTORY, version, creator, transactionHash: sent.hash,
  transaction: transactionLink(sent.hash), account: accountLink(dao), args: daoArgs, policy, createdAt: new Date().toISOString() }, null, 2)}\n`);
console.log(`Evidence: ${file}`);
console.log(`Set STATED_COURT_DAO=${dao} on the server.`);
