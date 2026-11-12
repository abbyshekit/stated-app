// INTEGRATION: Explicit testnet synthetic check. Dry-run default; --yes creates faucet
// accounts and sends test transactions. A full run waits through the on-chain window and bet deadline.
// node scripts/court-live-check.mjs --relay relay.parent.testnet [--yes]
// COURT_OPERATOR_CREDENTIALS / COURT_COUNCIL_CREDENTIALS select near-cli credential files.
// New synthetic keys are saved with mode 600; no secret is printed or recorded as evidence.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { HOSTED_COURT, assertRelayConfig, courtPolicy, flag, operatorError, requireTestnet, samePolicy, testnetAccount } from './create-court-dao.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const STAKE = 10n ** 23n;
const GAS = 300_000_000_000_000n;
const link = (hash) => `https://testnet.nearblocks.io/txns/${hash}`;
const resolveKind = (id, outcome, escrow = HOSTED_COURT.escrow) => ({ FunctionCall: { receiver_id: escrow, actions: [{ method_name: 'referee_resolve',
  args: Buffer.from(JSON.stringify({ id, outcome })).toString('base64'), deposit: '0', gas: '100000000000000' }] } });

export async function readCredentials(path, expected, read = readFile) {
  const file = JSON.parse(await read(path, 'utf8'));
  if (file.account_id !== expected || typeof file.private_key !== 'string' || !file.private_key.startsWith('ed25519:')) {
    throw new Error(`Credential file must belong to ${expected}.`);
  }
  return { id: file.account_id, secret: file.private_key };
}

export async function courtLiveCheck({ argv = process.argv.slice(2), env = process.env, chain, log = console.log, evidenceRoot = root,
  read = readFile, makeAccount, sleep = (ms) => new Promise((r) => setTimeout(r, ms)), now = Date.now } = {}) {
  requireTestnet(env);
  const relay = flag(argv, '--relay') || env.STATED_COURT_RELAY;
  if (!testnetAccount(relay)) throw new Error('Supply a .testnet relay with --relay or STATED_COURT_RELAY.');
  // The hosted court by default; --dao, --operator and --window-seconds run the same check on a test court.
  const window = flag(argv, '--window-seconds');
  if (window !== null && !/^\d+$/.test(window)) throw new Error('--window-seconds requires a whole number of seconds.');
  const court = Object.freeze({ ...HOSTED_COURT, ...(flag(argv, '--dao') ? { dao: flag(argv, '--dao') } : {}),
    ...(flag(argv, '--operator') ? { operator: flag(argv, '--operator') } : {}), ...(window !== null ? { windowSeconds: Number(window) } : {}) });
  if (!testnetAccount(court.dao) || !testnetAccount(court.operator)) throw new Error('--dao and --operator take .testnet accounts.');
  const plan = { network: 'testnet', relay, ...court, checks: ['operator files through relay', 'council cannot propose or approve',
    'permissionless approval rejected before window', 'permissionless approval rejected after window before bet deadline',
    'early filing rejected after bet deadline', 'post-deadline filing settles after challenge window', 'council veto keeps another bet active'] };
  log(JSON.stringify(plan, null, 2));
  if (!argv.includes('--yes') || argv.includes('--dry-run')) { log('Dry run: no credentials read, faucet requests or transactions sent. Pass --yes for the live check.'); return { dryRun: true, plan }; }
  chain ||= (await import('../server/src/play.mjs')).nearChain();
  const credentialsDir = join(homedir(), '.near-credentials', 'testnet');
  const operator = await readCredentials(env.COURT_OPERATOR_CREDENTIALS || join(credentialsDir, `${court.operator}.json`), court.operator, read);
  const council = await readCredentials(env.COURT_COUNCIL_CREDENTIALS || join(credentialsDir, `${court.council}.json`), court.council, read);
  const view = (contractId, method, args = {}) => chain.view({ contractId, method, args });
  assertRelayConfig(await view(relay, 'get_config'), court);
  if (!samePolicy(await view(court.dao, 'get_policy'), courtPolicy({ relay, council: [council.id] }))) throw new Error('DAO must have the exact hardened relay-only policy before this check.');
  if (String(await view(court.escrow, 'version')) !== '2') throw new Error('Hosted escrow is not version 2.');
  const evidence = { ...plan, startedAt: new Date(now()).toISOString(), steps: [] };
  const check = (name, pass, details = {}) => {
    evidence.steps.push({ name, pass, ...details });
    log(`${pass ? 'PASS' : 'FAIL'} ${name}${details.hash ? ` ${link(details.hash)}` : ''}`);
    if (!pass) throw new Error(`Live check failed: ${name}.`);
  };
  const send = (actor, contractId, method, args, depositYocto = '0') => chain.call({ signerId: actor.id, secret: actor.secret,
    contractId, method, args, depositYocto, gas: GAS });
  const denied = (result) => !result.ok && /permission|not allowed|not authorized|unauthorized|ERR_NOT_OPERATOR|Operator only/i.test(result.failure || '');
  const createAccount = makeAccount || (async (label) => {
    const { KeyPair } = await import('near-api-js');
    const key = KeyPair.fromRandom('ed25519');
    const id = `court-check-${randomBytes(4).toString('hex')}-${label}.testnet`;
    await mkdir(credentialsDir, { recursive: true, mode: 0o700 });
    await writeFile(join(credentialsDir, `${id}.json`), JSON.stringify({ account_id: id, public_key: key.getPublicKey().toString(), private_key: key.toString() }), { mode: 0o600, flag: 'wx' });
    await chain.faucet(id, key.getPublicKey().toString());
    for (let i = 0; i < 30; i += 1) {
      if ((await chain.balance(id)) != null) return { id, secret: key.toString() };
      await sleep(2000);
    }
    throw new Error('Synthetic faucet account did not appear.');
  });
  const makeBet = async (a, b, label) => {
    const id = randomUUID();
    const created = await send(a, court.escrow, 'create_bet', { id, terms_hash: createHash('sha256').update(`court-relay-check:${id}`).digest('hex'),
      creator_side: 'yes', stake_yocto: String(STAKE), accept_by_ns: String(BigInt(now() + 180_000) * 1_000_000n),
      // Leave five minutes after the challenge window for a distinct deadline refusal.
      resolve_at_ns: String(BigInt(now() + court.windowSeconds * 1000 + 300_000) * 1_000_000n), invited_account: null, binding_hash: randomBytes(32).toString('hex'), referee: court.dao }, String(STAKE + 10n ** 22n));
    check(`${label}: create bet`, created.ok, { hash: created.hash, betId: id });
    const accepted = await send(b, court.escrow, 'accept_bet', { id, binding_hash: randomBytes(32).toString('hex') }, String(STAKE));
    check(`${label}: accept bet`, accepted.ok, { hash: accepted.hash });
    return id;
  };
  const file = async (id, outcome) => {
    const result = await send(operator, relay, 'file', { id, outcome, description: `Stated synthetic relay check: ${outcome} on ${id}.` });
    const proposalId = Number(result.value);
    check('operator files through relay', result.ok && result.value !== null && result.value !== '' && Number.isSafeInteger(proposalId) && proposalId >= 0,
      { hash: result.hash, betId: id, proposalId });
    const proposal = await view(court.dao, 'get_proposal', { id: proposalId });
    check('DAO proposal was filed by relay', proposal.proposer === relay && proposal.status === 'InProgress', { proposalId });
    return { proposalId, proposal };
  };
  let failure;
  try {
    const a = await createAccount('a'); const b = await createAccount('b');
    evidence.accounts = { creator: a.id, acceptor: b.id, operator: operator.id, council: council.id };
    const bet = await makeBet(a, b, 'approved');
    const { proposalId, proposal } = await file(bet, 'yes');
    const forbiddenFile = await send(b, relay, 'file', { id: randomUUID(), outcome: 'yes', description: 'Unauthorized synthetic check' });
    check('non-operator cannot file through relay', denied(forbiddenFile), { hash: forbiddenFile.hash });
    const forbiddenProposal = await send(council, court.dao, 'add_proposal', { proposal: { description: 'Unauthorized synthetic check', kind: resolveKind(bet, 'yes', court.escrow) } });
    check('council cannot propose calls', denied(forbiddenProposal), { hash: forbiddenProposal.hash });
    const forbiddenApproval = await send(council, court.dao, 'act_proposal', { id: proposalId, action: 'VoteApprove', proposal: proposal.kind });
    check('council cannot approve calls', denied(forbiddenApproval), { hash: forbiddenApproval.hash });
    const early = await send(b, relay, 'approve', { id: proposalId });
    check('permissionless approval blocked before window', !early.ok && /window|early|not ready|deadline|too soon|ERR_TOO_EARLY/i.test(early.failure || ''), { hash: early.hash });
    check('early approval leaves proposal open', (await view(court.dao, 'get_proposal', { id: proposalId })).status === 'InProgress');
    const rejectedBet = await makeBet(a, b, 'vetoed');
    const veto = await file(rejectedBet, 'no');
    const rejected = await send(council, court.dao, 'act_proposal', { id: veto.proposalId, action: 'VoteReject', proposal: veto.proposal.kind });
    check('council veto succeeds', rejected.ok, { hash: rejected.hash });
    check('vetoed DAO proposal is rejected', (await view(court.dao, 'get_proposal', { id: veto.proposalId })).status === 'Rejected');
    const readyAt = Number(BigInt(proposal.submission_time) / 1_000_000n) + court.windowSeconds * 1000 + 2000;
    if (!Number.isSafeInteger(readyAt)) throw new Error('Invalid proposal timestamp.');
    while (now() < readyAt) { const remaining = readyAt - now(); log(`Waiting for on-chain window: ${Math.ceil(remaining / 1000)}s remaining.`); await sleep(Math.min(30_000, remaining)); }
    const pending = await view(court.escrow, 'get_bet', { id: bet });
    const resolveAt = BigInt(pending.resolve_at_ns);
    check('challenge window elapsed before bet deadline', BigInt(now()) * 1_000_000n < resolveAt,
      { betId: bet, resolveAtNs: String(resolveAt) });
    const beforeDeadline = await send(b, relay, 'approve', { id: proposalId });
    check('permissionless approval blocked before bet deadline', !beforeDeadline.ok && /Bet deadline has not arrived/i.test(beforeDeadline.failure || ''),
      { hash: beforeDeadline.hash });
    check('deadline refusal leaves proposal open', (await view(court.dao, 'get_proposal', { id: proposalId })).status === 'InProgress');
    const unsettled = await view(court.escrow, 'get_bet', { id: bet });
    check('deadline refusal leaves bet unsettled', unsettled?.status === 'accepted' && !unsettled.resolution);
    const deadlineReadyAt = Number(resolveAt / 1_000_000n) + 2000;
    if (!Number.isSafeInteger(deadlineReadyAt)) throw new Error('Invalid bet deadline.');
    while (now() < deadlineReadyAt) { const remaining = deadlineReadyAt - now(); log(`Waiting for bet deadline: ${Math.ceil(remaining / 1000)}s remaining.`); await sleep(Math.min(30_000, remaining)); }
    const earlyAfterDeadline = await send(b, relay, 'approve', { id: proposalId });
    check('early filing rejected after bet deadline', !earlyAfterDeadline.ok && /Ruling filed before the bet deadline/i.test(earlyAfterDeadline.failure || ''),
      { hash: earlyAfterDeadline.hash });
    check('early filing remains open after deadline', (await view(court.dao, 'get_proposal', { id: proposalId })).status === 'InProgress');
    const stillUnsettled = await view(court.escrow, 'get_bet', { id: bet });
    check('early filing leaves bet unsettled after deadline', stillUnsettled?.status === 'accepted' && !stillUnsettled.resolution);
    const valid = await file(bet, 'yes');
    const validReadyAt = Number(BigInt(valid.proposal.submission_time) / 1_000_000n) + court.windowSeconds * 1000 + 2000;
    if (!Number.isSafeInteger(validReadyAt)) throw new Error('Invalid proposal timestamp.');
    while (now() < validReadyAt) { const remaining = validReadyAt - now(); log(`Waiting for on-chain window: ${Math.ceil(remaining / 1000)}s remaining.`); await sleep(Math.min(30_000, remaining)); }
    const approved = await send(b, relay, 'approve', { id: valid.proposalId });
    check('permissionless approval succeeds after bet deadline', approved.ok, { hash: approved.hash });
    check('approved DAO proposal is final', (await view(court.dao, 'get_proposal', { id: valid.proposalId })).status === 'Approved');
    const settled = await view(court.escrow, 'get_bet', { id: bet });
    check('escrow settled yes through DAO', settled?.status === 'settled' && String(settled?.resolution?.method).toLowerCase() === 'referee'
      && String(settled?.resolution?.outcome).toLowerCase() === 'yes');
    check('escrow settlement timestamp reaches bet deadline', BigInt(settled.resolution.resolved_at_ns) >= resolveAt);
    const blocked = await send(b, relay, 'approve', { id: veto.proposalId });
    check('permissionless approval cannot revive veto', !blocked.ok && /InProgress|Rejected|terminal/i.test(blocked.failure || ''), { hash: blocked.hash });
    const active = await view(court.escrow, 'get_bet', { id: rejectedBet });
    check('vetoed bet remains active', active?.status === 'accepted' && !active.resolution);
    const credit = BigInt(await view(court.escrow, 'get_credit', { account_id: a.id }));
    const before = BigInt(await chain.balance(a.id));
    const withdrawn = await send(a, court.escrow, 'withdraw', {});
    const after = BigInt(await chain.balance(a.id));
    check('winner withdraws both stakes', withdrawn.ok && credit === 2n * STAKE && BigInt(await view(court.escrow, 'get_credit', { account_id: a.id })) === 0n
      && after - before > 2n * STAKE - 10n ** 22n, { hash: withdrawn.hash });
    evidence.bets = { approved: bet, vetoed: rejectedBet };
    evidence.proposals = { early: proposalId, approved: valid.proposalId, vetoed: veto.proposalId };
  } catch (error) { failure = error; }
  evidence.finishedAt = new Date(now()).toISOString();
  evidence.passed = !failure;
  if (failure) evidence.failure = operatorError(failure, env);
  const evidenceFile = resolve(evidenceRoot, `evidence/court-relay-live-${court.dao === HOSTED_COURT.dao ? 'hosted' : 'test'}-${court.dao}-${evidence.startedAt.slice(0, 10)}.json`);
  await mkdir(dirname(evidenceFile), { recursive: true });
  await writeFile(evidenceFile, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
  log(`Evidence: ${evidenceFile}`);
  if (failure) throw failure;
  return evidence;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  courtLiveCheck().catch((error) => { console.error(operatorError(error)); process.exitCode = 1; });
}
