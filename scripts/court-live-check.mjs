// INTEGRATION: Explicitly invoked, testnet only, test NEAR only. Proves the Stated Court
// path on the real chain, outside the app:
//   1. two fresh faucet accounts make and accept a real bet on the version 2 escrow with
//      referee = the DAO (0.1 NEAR each);
//   2. the council files add_proposal with the exact FunctionCall court-dao.mjs builds
//      (referee_resolve, outcome yes), then act_proposal with the exact arguments
//      approveRuling sends (including the extra `proposal` field);
//   3. the proposal is Approved and get_bet shows settled by the referee;
//   4. the winner withdraws the credit and the transfer lands;
//   5. on a second bet, a council VoteReject moves the proposal to Rejected and the bet stays active.
//
//   COURT_COUNCIL_CREDENTIALS  path to the council account's near-cli credentials file
//                              (default ~/.near-credentials/testnet/stated-court-18ecdebd.testnet.json)
//   node scripts/court-live-check.mjs
//
// New keys are saved to ~/.near-credentials/testnet/<account>.json with mode 600; no key is printed.
// Writes evidence/court-live-<date>.json with every transaction hash and explorer link.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { KeyPair } from 'near-api-js';
import { loadConfig } from '../server/src/config.mjs';
import { network, transactionLink, accountLink } from '../server/src/near-network.mjs';
import { nearChain } from '../server/src/play.mjs';
import { proposalKind } from '../server/src/court-dao.mjs';

const ESCROW = 'stated-escrow-52081551be.testnet';
const DAO = 'stated-court.sputnik-v2.testnet';
const FAUCET = 'https://helper.testnet.near.org/account';
const STAKE = 10n ** 23n; // 0.1 NEAR
const STORAGE_FEE = 10n ** 22n;
const APPROVE_GAS = 200_000_000_000_000n;
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const credentialsDir = join(homedir(), '.near-credentials', 'testnet');

loadConfig(process.env);
if (network().id !== 'testnet') { console.error('Testnet only.'); process.exit(1); }
const chain = nearChain();
const config = { nearContract: ESCROW };
const evidence = { escrow: ESCROW, dao: DAO, startedAt: new Date().toISOString(), steps: [] };
let failed = false;
const step = (name, pass, detail = {}) => {
  evidence.steps.push({ name, pass, ...detail });
  if (!pass) failed = true;
  const link = detail.hash ? ` ${transactionLink(detail.hash)}` : '';
  console.log(`${pass ? 'PASS' : 'FAIL'} ${name}${link}${detail.note ? ` (${detail.note})` : ''}`);
  return pass;
};
const view = (contractId, method, args = {}) => chain.view({ contractId, method, args });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const hex = () => randomBytes(32).toString('hex');

async function credentials(path) {
  const file = JSON.parse(await readFile(path, 'utf8'));
  return { id: file.account_id, secret: file.private_key };
}

async function faucetAccount(label) {
  const id = `court-check-${randomBytes(4).toString('hex')}-${label}.testnet`;
  const key = KeyPair.fromRandom('ed25519');
  await mkdir(credentialsDir, { recursive: true, mode: 0o700 });
  await writeFile(join(credentialsDir, `${id}.json`), JSON.stringify({ account_id: id, public_key: key.getPublicKey().toString(),
    private_key: key.toString() }), { mode: 0o600 });
  const response = await fetch(FAUCET, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newAccountId: id, newAccountPublicKey: key.getPublicKey().toString() }), signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error(`faucet refused ${id}: HTTP ${response.status}`);
  for (let i = 0; i < 30 && (await chain.balance(id)) == null; i += 1) await sleep(2000);
  if ((await chain.balance(id)) == null) throw new Error(`${id} did not appear`);
  return { id, secret: key.toString() };
}

async function makeBet(creator, acceptor, label) {
  const id = randomUUID();
  const now = Date.now();
  const acceptBy = BigInt(now + 3 * 60_000) * 1_000_000n;
  const resolveAt = BigInt(now + 5 * 60_000) * 1_000_000n;
  const termsHash = createHash('sha256').update(JSON.stringify({ check: 'court-live', id, label })).digest('hex');
  const created = await chain.call({ signerId: creator.id, secret: creator.secret, contractId: ESCROW, method: 'create_bet',
    args: { id, terms_hash: termsHash, creator_side: 'yes', stake_yocto: STAKE.toString(), accept_by_ns: acceptBy.toString(),
      resolve_at_ns: resolveAt.toString(), invited_account: null, binding_hash: hex(), referee: DAO },
    depositYocto: (STAKE + STORAGE_FEE).toString() });
  step(`${label}: create_bet with referee ${DAO}`, created.ok, { hash: created.hash, note: created.failure || undefined });
  const accepted = await chain.call({ signerId: acceptor.id, secret: acceptor.secret, contractId: ESCROW, method: 'accept_bet',
    args: { id, binding_hash: hex() }, depositYocto: STAKE.toString() });
  step(`${label}: accept_bet`, accepted.ok, { hash: accepted.hash, note: accepted.failure || undefined });
  const bet = await view(ESCROW, 'get_bet', { id });
  step(`${label}: get_bet shows accepted, referee = DAO`, bet?.status === 'accepted' && bet?.referee === DAO, { note: `status ${bet?.status}, referee ${bet?.referee}` });
  return id;
}

async function propose(council, betId, outcome, label) {
  const description = `Stated court live check: ${outcome} on bet ${betId}.`;
  const policy = await view(DAO, 'get_policy');
  const sent = await chain.call({ signerId: council.id, secret: council.secret, contractId: DAO, method: 'add_proposal',
    args: { proposal: { description, kind: proposalKind(config, betId, outcome) } }, depositYocto: String(policy.proposal_bond || '0') });
  const id = Number(sent.value);
  step(`${label}: add_proposal returns the proposal id`, sent.ok && Number.isSafeInteger(id), { hash: sent.hash, proposalId: id, note: sent.failure || `id ${id}` });
  return id;
}

try {
  const councilPath = process.env.COURT_COUNCIL_CREDENTIALS || join(credentialsDir, 'stated-court-18ecdebd.testnet.json');
  const council = await credentials(councilPath);
  const version = await view(ESCROW, 'version');
  step('escrow is version 2', String(version) === '2', { note: `version ${version}` });
  step('DAO is Sputnik 2.0.0 with the court policy', (await view(DAO, 'version')) === '2.0.0'
    && (await view(DAO, 'get_policy')).roles.some((r) => r.name === 'council' && r.kind.Group?.includes(council.id)));

  const a = await faucetAccount('a');
  const b = await faucetAccount('b');
  evidence.accounts = { creator: a.id, acceptor: b.id, council: council.id };
  step('two faucet accounts', true, { note: `${a.id}, ${b.id}` });

  // Bet 1: approved by the DAO.
  const bet1 = await makeBet(a, b, 'bet 1');
  const p1 = await propose(council, bet1, 'yes', 'bet 1');
  const kind = (await view(DAO, 'get_proposal', { id: p1 })).kind;
  // Exactly what approveRuling sends: id, action and the proposal kind, with 200 Tgas and no deposit.
  let vote = await chain.call({ signerId: council.id, secret: council.secret, contractId: DAO, method: 'act_proposal',
    args: { id: p1, action: 'VoteApprove', proposal: kind }, gas: APPROVE_GAS });
  evidence.actProposalForm = vote.ok ? 'id, action, proposal (accepted by 2.0.0)' : null;
  step('bet 1: act_proposal {id, action: VoteApprove, proposal: kind} accepted by Sputnik 2.0.0', vote.ok, { hash: vote.hash, note: vote.failure || undefined });
  if (!vote.ok) {
    vote = await chain.call({ signerId: council.id, secret: council.secret, contractId: DAO, method: 'act_proposal',
      args: { id: p1, action: 'VoteApprove' }, gas: APPROVE_GAS });
    evidence.actProposalForm = vote.ok ? 'id, action (the extra proposal field is refused)' : 'neither form';
    step('bet 1: act_proposal {id, action: VoteApprove} without the proposal field', vote.ok, { hash: vote.hash, note: vote.failure || undefined });
  }
  const proposal1 = await view(DAO, 'get_proposal', { id: p1 });
  step('bet 1: proposal is Approved', proposal1.status === 'Approved', { note: `status ${proposal1.status}` });
  const settled = await view(ESCROW, 'get_bet', { id: bet1 });
  step('bet 1: get_bet shows settled by the referee, outcome yes',
    settled?.status === 'settled' && String(settled?.resolution?.method).toLowerCase() === 'referee' && String(settled?.resolution?.outcome).toLowerCase() === 'yes',
    { note: `status ${settled?.status}, resolution ${JSON.stringify(settled?.resolution)}` });

  const credit = BigInt(await view(ESCROW, 'get_credit', { account_id: a.id }));
  const before = BigInt(await chain.balance(a.id));
  const withdrawn = await chain.call({ signerId: a.id, secret: a.secret, contractId: ESCROW, method: 'withdraw', args: {} });
  const after = BigInt(await chain.balance(a.id));
  const left = BigInt(await view(ESCROW, 'get_credit', { account_id: a.id }));
  step('bet 1: the winner withdraws both stakes', withdrawn.ok && credit === 2n * STAKE && left === 0n && after - before > 2n * STAKE - 10n ** 22n,
    { hash: withdrawn.hash, note: `credit ${credit}, balance +${after - before}` });

  // Bet 2: a council VoteReject.
  const bet2 = await makeBet(a, b, 'bet 2');
  const p2 = await propose(council, bet2, 'no', 'bet 2');
  const reject = await chain.call({ signerId: council.id, secret: council.secret, contractId: DAO, method: 'act_proposal',
    args: { id: p2, action: 'VoteReject', proposal: (await view(DAO, 'get_proposal', { id: p2 })).kind }, gas: APPROVE_GAS });
  step('bet 2: council VoteReject accepted', reject.ok, { hash: reject.hash, note: reject.failure || undefined });
  const proposal2 = await view(DAO, 'get_proposal', { id: p2 });
  step('bet 2: proposal is Rejected', proposal2.status === 'Rejected', { note: `status ${proposal2.status}` });
  const open = await view(ESCROW, 'get_bet', { id: bet2 });
  step('bet 2: the bet stays active', open?.status === 'accepted' && !open?.resolution, { note: `status ${open?.status}` });
  evidence.bets = { approved: bet1, rejected: bet2 };
  evidence.proposals = { approved: p1, rejected: p2 };
} catch (error) {
  step('run', false, { note: String(error?.message || error).slice(0, 300) });
}

evidence.finishedAt = new Date().toISOString();
evidence.links = Object.fromEntries(evidence.steps.filter((s) => s.hash).map((s) => [s.name, transactionLink(s.hash)]));
evidence.daoLink = accountLink(DAO);
const file = resolve(root, `evidence/court-live-${evidence.startedAt.slice(0, 10)}.json`);
await mkdir(dirname(file), { recursive: true });
await writeFile(file, `${JSON.stringify(evidence, null, 2)}\n`);
console.log(`${failed ? 'FAIL' : 'PASS'} overall. Evidence: ${file}`);
process.exitCode = failed ? 1 : 0;
