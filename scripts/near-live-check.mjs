// INTEGRATION: Explicitly invoked, testnet-only live check. Keys exist only in
// memory. Its public evidence file contains no secrets or real user data.
import assert from 'node:assert/strict';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions } from 'near-api-js';
import { betFor } from '../server/src/bets.mjs';
import { TESTNET_RPC, viewCredit, viewEscrow } from '../server/src/near-escrow.mjs';
import { completeSetup, signInFromX } from '../server/src/store.mjs';
import { startStack } from '../server/test/support/app.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const evidencePath = resolve(root, 'evidence/near-testnet-live.json');
const wasmPath = resolve(root, 'contracts/bilateral-escrow/target/near/stated_bilateral_escrow.wasm');
const faucet = 'https://helper.testnet.near.org/account';
const gas = 100000000000000n;
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

async function provision(provider, suffix) {
  const id = `stated${randomBytes(8).toString('hex')}${suffix}.testnet`;
  const key = KeyPair.fromRandom('ed25519');
  const publicKey = key.getPublicKey().toString();
  // https://github.com/near/near-contract-helper#create-account-works-only-on-test-networks
  const response = await fetch(faucet, { method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ newAccountId: id, newAccountPublicKey: publicKey }),
    signal: AbortSignal.timeout(30000), redirect: 'error' });
  if (!response.ok) throw new Error(`Testnet faucet rejected account creation: HTTP ${response.status}: ${(await response.text()).slice(0, 500)}`);
  return { id, publicKey, account: new Account(id, provider, new KeyPairSigner(key)) };
}

function outcome(result, expectedFailure = null) {
  assert.ok(result.transaction?.hash, 'Missing transaction hash');
  const status = result.status;
  assert.ok(status && typeof status === 'object', 'Missing final transaction status');
  const failed = Object.hasOwn(status, 'Failure');
  assert.equal(failed, Boolean(expectedFailure), `Unexpected transaction status: ${JSON.stringify(status)}`);
  if (failed) assert.ok(JSON.stringify(status.Failure).includes(expectedFailure), `Unexpected contract failure: ${JSON.stringify(status.Failure)}`);
  if (!failed) assert.ok(Object.hasOwn(status, 'SuccessValue') || Object.hasOwn(status, 'SuccessReceiptId'), 'Transaction did not execute successfully');
  return { hash: result.transaction.hash, blockHash: result.transaction_outcome?.block_hash, status };
}

async function call(wallet, contract, method, args, deposit = '0', expectedFailure = null) {
  const result = await wallet.account.signAndSendTransaction({ receiverId: contract,
    actions: [actions.functionCall(method, args, gas, BigInt(deposit))], waitUntil: 'FINAL', throwOnFailure: false });
  return outcome(result, expectedFailure);
}

async function waitFor(label, fn, predicate) {
  for (let i = 0; i < 30; i++) {
    const value = await fn();
    if (predicate(value)) return value;
    await sleep(2000);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function main() {
  console.log('Starting live NEAR testnet escrow check; creating ephemeral accounts.');
  const wasm = await readFile(wasmPath);
  const provider = new JsonRpcProvider({ url: TESTNET_RPC });
  const owner = await provision(provider, 'a');
  const taker = await provision(provider, 'b');
  console.log(`Testnet accounts created: ${owner.id}, ${taker.id}. Deploying contract.`);
  const transactions = {};
  transactions.deploy = outcome(await owner.account.signAndSendTransaction({ receiverId: owner.id,
    actions: [actions.deployContract(wasm), actions.functionCall('new', {}, gas, 0n)], waitUntil: 'FINAL', throwOnFailure: false }));
  let stack;
  try {
    stack = await startStack({ STATED_NEAR_CONTRACT: owner.id });
    const creator = await completeSetup(stack.db, await signInFromX(stack.db, { id: '990000001', username: 'synthetic_a', name: 'Synthetic A' }), {});
    const opponent = await completeSetup(stack.db, await signInFromX(stack.db, { id: '990000002', username: 'synthetic_b', name: 'Synthetic B' }), {});
    const browserA = await stack.signIn(stack.fakeX.addUser('990000001', 'synthetic_a'));
    const browserB = await stack.signIn(stack.fakeX.addUser('990000002', 'synthetic_b'));
    const follower = await stack.signIn(stack.fakeX.addUser('990000003', 'synthetic_follower'));
    const now = Date.now();
    const resolveAt = now + 105000;
    const created = await browserA.submit('/me/bets', { requestId: randomUUID(), claim: 'SYNTHETIC TEST: testnet escrow settlement',
      criteria: 'The synthetic test succeeds if both participants confirm yes.', evidenceSourceUrl: 'https://docs.near.org/',
      creatorSide: 'yes', stakeNear: '0.1', acceptBy: new Date(now + 90000).toISOString(), resolveAt: new Date(resolveAt).toISOString(),
      opponentUsername: 'synthetic_b', opponentAccount: taker.id }, { from: '/me/bets/new' });
    assert.equal(created.status, 200, 'HTTP Bet creation failed');
    const betId = new URL(created.url).pathname.match(/^\/bets\/([a-f0-9-]{36})$/)?.[1];
    assert.ok(betId, 'HTTP creation did not return a Bet');
    const bet = await betFor(stack.db, creator, betId);
    const prepare = async (user, wallet, action, extra = {}) => {
      const browser = String(user.id) === String(creator.id) ? browserA : browserB;
      const page = await browser.submit(`/bets/${bet.id}/${action}`, { accountId: wallet.id,
        publicConsent: '1', ...extra }, { from: `/bets/${bet.id}` });
      assert.equal(page.status, 200, `HTTP ${action} request failed`);
      const encoded = page.text.match(/name="walletPayload" value="([^"]+)"/)?.[1];
      assert.ok(encoded, `HTTP ${action} did not render a wallet request`);
      const payload = JSON.parse(encoded.replace(/&(?:amp|lt|gt|quot|#39);/g,
        value => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'" })[value]));
      assert.equal(payload.accountId, wallet.id);
      assert.equal(payload.contract, owner.id);
      assert.equal(payload.gas, gas.toString());
      assert.ok(payload.requestId);
      return payload;
    };
    const verify = async () => {
      const page = await browserA.submit(`/bets/${bet.id}/verify`, {}, { from: `/bets/${bet.id}` });
      assert.equal(page.status, 200, 'HTTP finalized verification failed');
      return betFor(stack.db, creator, bet.id);
    };
    const submit = async (wallet, prepared, deposit = prepared.depositYocto, fail = null) => {
      const result = await call(wallet, owner.id, prepared.method, prepared.args, deposit, fail);
      if (!fail) {
        const browser = wallet.id === owner.id ? browserA : browserB;
        const page = await browser.submit(`/bets/${bet.id}/transactions`, {
          requestId: prepared.requestId, transactionHash: result.hash,
        }, { from: `/bets/${bet.id}` });
        assert.equal(page.status, 200, `HTTP ${prepared.method} transaction reconciliation failed`);
      }
      return result;
    };
    const fund = await prepare(creator, owner, 'fund');
    transactions.fund = await submit(owner, fund);
    await waitFor('funded offer', verify, b => b.chain_state?.status === 'offered');
    assert.equal((await browserA.submit(`/bets/${bet.id}/publish`, { confirm: '1' })).status, 200);
    console.log(`Public test Bet (local HTTP, real NEAR testnet): ${stack.base}/bets/${bet.id}`);
    const publicPage = await stack.browser().get(`/bets/${bet.id}`);
    assert.equal(publicPage.status, 200);
    assert.match(publicPage.text, /Take other side/);
    const card = await fetch(`${stack.base}/share/bets/${bet.id}.png`);
    assert.equal(card.status, 200);
    assert.equal(Buffer.from(await card.arrayBuffer()).readUInt32BE(16), 1200);
    assert.equal((await follower.submit(`/bets/${bet.id}/follow`, {}, { from: `/bets/${bet.id}` })).status, 200);
    assert.equal((await stack.db.one("select setup_completed_at from users where x_user_id='990000003'")).setup_completed_at, null);
    console.log('Offer funded and finalized. Testing wrong deposit and acceptance.');
    const accept = await prepare(opponent, taker, 'accept', { termsHash: bet.terms_hash });
    transactions.wrongDeposit = await submit(taker, accept, (BigInt(accept.depositYocto) - 1n).toString(), 'Deposit must equal stake');
    assert.equal((await viewEscrow(owner.id, bet.id)).status, 'offered');
    transactions.accept = await submit(taker, accept);
    await waitFor('accepted offer', verify, b => b.status === 'accepted');
    assert.ok((await stack.browser().get(`/bets/${bet.id}`)).text.includes('@synthetic_b'));
    assert.ok((await follower.get('/me/inbox')).text.includes('Both participants deposited'));
    console.log('Acceptance finalized. Waiting for resolution time.');
    while (Date.now() < resolveAt + 3000) {
      await sleep(Math.min(10000, resolveAt + 3000 - Date.now()));
      console.log('Waiting for resolution time.');
    }
    const proposal = await prepare(creator, owner, 'propose', { outcome: 'yes', note: 'Synthetic test confirmation.', evidenceUrl: 'https://docs.near.org/' });
    transactions.propose = await submit(owner, proposal);
    const proposed = await waitFor('proposed result', verify, b => b.status === 'proposed');
    const confirmation = await prepare(opponent, taker, 'confirm', { proposalId: proposed.chain_state.proposal.id,
      proposalRevision: proposed.chain_state.proposal.revision, proposalOutcome: proposed.chain_state.proposal.outcome });
    transactions.selfConfirmation = await submit(owner, confirmation, '0', 'Other participant must respond');
    assert.equal((await viewEscrow(owner.id, bet.id)).status, 'proposed');
    transactions.confirm = await submit(taker, confirmation);
    await waitFor('settlement', verify, b => b.status === 'settled');
    transactions.duplicateConfirmation = await submit(taker, confirmation, '0', 'Bet is not active');
    const creditBefore = await waitFor('winner credit', () => viewCredit(owner.id, owner.id), c => c === '200000000000000000000000');
    const withdrawal = await prepare(creator, owner, 'withdraw');
    transactions.withdraw = await submit(owner, withdrawal);
    const creditAfter = await waitFor('withdrawal', () => viewCredit(owner.id, owner.id), c => c === '0');
    const paidPage = await browserA.get(`/bets/${bet.id}`);
    assert.match(paidPage.text, /withdrawal transfer completed/);
    assert.doesNotMatch(paidPage.text, />Withdraw tokens</);
    const chain = await viewEscrow(owner.id, bet.id);
    assert.equal(chain.status, 'settled');
    assert.ok((await follower.get('/me/inbox')).text.includes('credited for withdrawal'));
    const evidence = { verifiedAt: new Date().toISOString(), network: 'testnet', rpc: TESTNET_RPC,
      wasmSha256: createHash('sha256').update(wasm).digest('hex'),
      contract: owner.id, accounts: [owner.id, taker.id], betId: bet.id,
      httpFlow: { authenticatedPreparation: true, preparedWalletPayloadsExecuted: true,
        explicitPublication: true, anonymousPublicPageAndPng: true, followerWithoutWalletOrSetup: true,
        boundConsentedAcceptor: true, inboxTransitions: true, finalizedVerification: true, transactionReconciliation: true,
        interactiveWalletSigning: false, xApi: 'simulated locally; no live X calls' },
      transactions, finalState: chain, creditBeforeYocto: creditBefore, creditAfterYocto: creditAfter,
      checks: { funded: true, wrongDepositRejected: true, accepted: true, selfConfirmationRejected: true,
        confirmed: true, duplicateConfirmationRejected: true, winnerCredit: true, withdrawn: true } };
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`);
    console.log(`Live testnet check passed. Public evidence: ${evidencePath}`);
  } finally {
    if (stack) await stack.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  main().catch(error => { console.error('Live testnet check failed:', error.message); process.exitCode = 1; });
}
