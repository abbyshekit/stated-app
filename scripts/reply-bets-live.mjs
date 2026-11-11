// INTEGRATION: Explicitly invoked, real NEAR testnet. Runs a Bet made from
// replies end to end: the real server over HTTP, a simulated X, and real
// testnet accounts, contract and transactions. Keys exist only in memory and in
// the throwaway database, sealed. The evidence file holds no secrets.
//
//   node scripts/reply-bets-live.mjs                 deploys a fresh version 2 contract first
//   STATED_NEAR_CONTRACT=<v2>.testnet node scripts/reply-bets-live.mjs   uses one already deployed
import assert from 'node:assert/strict';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { TESTNET_RPC, contractVersion, rpc, viewCredit, viewEscrow } from '../server/src/near-escrow.mjs';
import { nearChain, playAccountFor, refereeId } from '../server/src/play.mjs';
import { runBetCommands, settleReplyBets } from '../server/src/reply-bets.mjs';
import { tick } from '../server/src/worker.mjs';
import { startStack } from '../server/test/support/app.mjs';

if (process.env.STATED_NEAR_NETWORK === 'mainnet') throw new Error('This proof is for NEAR testnet only.');
const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const wasmPath = resolve(root, 'contracts/bilateral-escrow/target/near/stated_bilateral_escrow.wasm');
const evidencePath = resolve(root, `evidence/reply-bets-testnet-live-${new Date().toISOString().replace(/[:.]/g, '-')}.json`);
const chain = nearChain();
const steps = [];
const step = (name, detail = {}) => { steps.push({ name, at: new Date().toISOString(), ...detail }); console.log(`${steps.length}. ${name}`, Object.keys(detail).length ? JSON.stringify(detail) : ''); };

async function deployContract() {
  const wasm = await readFile(wasmPath);
  const key = chain.newKey();
  const id = `stated-escrow-${randomBytes(5).toString('hex')}.testnet`;
  await chain.faucet(id, key.publicKey);
  const deployed = await chain.deploy({ accountId: id, secret: key.secret, wasm });
  assert.ok(deployed.ok, `Deploy failed: ${deployed.failure}`);
  step('Deployed the version 2 escrow', { contract: id, transaction: deployed.hash, wasmSha256: createHash('sha256').update(wasm).digest('hex') });
  // The contract account gives up its only key, so its code cannot be replaced and nothing can sign for it.
  const locked = await chain.lock({ accountId: id, secret: key.secret, publicKey: key.publicKey });
  assert.ok(locked.ok, `Locking failed: ${locked.failure}`);
  // A node can answer from a block just before the one that removed the key, so ask until it has caught up.
  let keys = null;
  for (let i = 0; i < 15; i += 1) {
    keys = await (await fetch(TESTNET_RPC, { method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_access_key_list', finality: 'final', account_id: id } }) })).json();
    if (keys.result?.keys?.length === 0) break;
    await new Promise((ok) => setTimeout(ok, 1000));
  }
  assert.equal(keys.result.keys.length, 0, 'the contract account has no access keys');
  step('Locked the contract account: it has no access keys', { transaction: locked.hash });
  return id;
}

async function main() {
  const { STATED_PLAY_TREASURY, STATED_PLAY_TREASURY_KEY } = process.env;
  if (Boolean(STATED_PLAY_TREASURY) !== Boolean(STATED_PLAY_TREASURY_KEY)) throw new Error('Provide both testnet treasury settings.');
  if (STATED_PLAY_TREASURY && !STATED_PLAY_TREASURY.endsWith('.testnet')) throw new Error('The proof treasury must be a testnet account.');
  const contract = process.env.STATED_NEAR_CONTRACT || await deployContract();
  assert.equal(await contractVersion(contract), 2, 'The contract must be version 2');
  const s = await startStack({ STATED_NEAR_CONTRACT: contract, STATED_PLAY: '1',
    STATED_PLAY_TREASURY, STATED_PLAY_TREASURY_KEY, STATED_PLAY_AUTOPROVISION: STATED_PLAY_TREASURY ? '0' : '1',
    STATED_PLAY_SETTLE_DELAY_SECONDS: '0' });
  try {
    await s.connectBot(s.fakeX.addUser('500', 'statedbot'));
    const tag = `${randomBytes(3).toString('hex')}`;
    const lena = s.fakeX.addUser('91001', `lena_${tag}`);
    const oskar = s.fakeX.addUser('91002', `oskar_${tag}`);
    const admin = await s.signIn(s.fakeX.addUser('900', 'reviewer'));
    await admin.submit('/setup', { profile: 'private', defaults: 'private' });
    const run = async () => {
      const result = await runBetCommands(s.db, s.config, chain, { botUsername: 'statedbot' });
      if (result.done !== 1) console.error('Command did not complete:', JSON.stringify(await s.db.many('select kind, status, attempts, detail from bet_commands')));
      return result;
    };
    const botReplies = () => [...s.fakeX.posts.values()].filter((p) => p.author_id === '500').map((p) => p.text.replace(/^(@\w+ )+/, ''));
    const year = new Date().getUTCFullYear() + 1;

    const post = s.fakeX.post(lena.id, `SYNTHETIC TEST: Nightjar 2.0 ships a stable release before March 1, ${year}.`);
    const offer = s.fakeX.post(oskar.id, '@statedbot bet 0.2 no', { replyTo: post.id });
    await tick(s.db, s.config, s.x);
    assert.deepEqual(await run(), { done: 1, refused: 0, retry: 0, failed: 0 });
    const { bet_id: betId } = await s.db.one('select bet_id from bet_commands where event_id = $1', [offer.id]);
    const oskarAccount = (await playAccountFor(s.db, oskar.id)).account_id;
    let onChain = await viewEscrow(contract, betId);
    assert.equal(onChain.status, 'offered');
    assert.equal(onChain.creator, oskarAccount);
    assert.equal(onChain.referee, await refereeId(s.db, s.config));
    step('“bet 0.2 no” funded an offer from the handle’s account', { betId, account: oskarAccount, referee: onChain.referee });
    await tick(s.db, s.config, s.x);
    assert.match(botReplies().at(-1), /^0\.2 test NEAR says this does not happen by 28 Feb/);

    const offerReply = [...s.fakeX.posts.values()].find((p) => p.author_id === '500' && p.text.includes('To take the other side'));
    const take = s.fakeX.post(lena.id, '@statedbot take', { replyTo: offerReply.id });
    await tick(s.db, s.config, s.x);
    assert.deepEqual(await run(), { done: 1, refused: 0, retry: 0, failed: 0 });
    const lenaAccount = (await playAccountFor(s.db, lena.id)).account_id;
    onChain = await viewEscrow(contract, betId);
    assert.equal(onChain.status, 'accepted');
    assert.equal(onChain.acceptor, lenaAccount);
    step('“take” matched the stake', { account: lenaAccount });
    await tick(s.db, s.config, s.x);
    assert.match(botReplies().at(-1), /^It’s on\. 0\.4 test NEAR is held on NEAR testnet/);
    assert.equal((await s.browser().get(`/bets/${betId}`)).status, 200);

    const lenaBefore = BigInt(await chain.balance(lenaAccount));
    const st = await s.db.one('select st.id from statements st join sources src on src.id = st.source_id where src.platform_id = $1', [post.id]);
    const resolved = await admin.submit(`/admin/resolve/${st.id}`, { outcome: 'yes', url: 'https://docs.near.org/', note: 'SYNTHETIC TEST: recorded as yes.',
      known: new Date().toISOString().slice(0, 10) }, { from: '/admin' });
    assert.equal(resolved.status, 200);
    assert.deepEqual(await settleReplyBets(s.db, s.config, chain), { settled: 1, reclaimed: 0, errors: 0 });
    onChain = await viewEscrow(contract, betId);
    assert.equal(onChain.status, 'settled');
    assert.deepEqual({ outcome: onChain.resolution.outcome, method: onChain.resolution.method }, { outcome: 'yes', method: 'referee' });
    const lenaAfter = BigInt(await chain.balance(lenaAccount));
    assert.ok(lenaAfter > lenaBefore + 390000000000000000000000n, 'the winner received both stakes, less gas');
    assert.equal(await viewCredit(contract, lenaAccount), '0');
    step('The referee settled from the recorded Result and the winner was paid', { resolution: onChain.resolution, winnerGainYocto: (lenaAfter - lenaBefore).toString() });
    await tick(s.db, s.config, s.x);
    assert.equal(botReplies().at(-1), `It happened. @lena_${tag} wins the 0.4 test NEAR pot.`);
    const refereeEvent = await s.db.one(`select detail from bilateral_bet_events where bet_id = $1 and kind = 'referee_resolved'`, [betId]);
    const settlementHash = refereeEvent.detail.transactionHash;
    const page = await s.browser().get(`/bets/${betId}`);
    assert.match(page.text, new RegExp(`@lena_${tag} won`));
    const settlementUrl = `https://testnet.nearblocks.io/txns/${settlementHash}`;
    assert.ok(page.text.includes(settlementUrl));
    assert.match(page.text, />Verify settlement<\/a>/);
    const settled = await rpc('tx', {
      tx_hash: settlementHash, sender_account_id: onChain.referee, wait_until: 'FINAL',
    });
    assert.equal(settled.final_execution_status, 'FINAL');
    assert.equal(typeof settled.status.SuccessValue, 'string');
    assert.equal(settled.transaction.receiver_id, contract);
    assert.equal(settled.transaction.signer_id, onChain.referee);
    assert.equal(settled.transaction.actions.length, 1);
    const resolveCall = settled.transaction.actions[0].FunctionCall;
    assert.equal(resolveCall.method_name, 'referee_resolve');
    assert.deepEqual(JSON.parse(Buffer.from(resolveCall.args, 'base64').toString()), { id: betId, outcome: 'yes' });
    step('The signed-out Result links to the exact finalized settlement', { settlementUrl, betId, outcome: 'yes' });
    const card = await fetch(`${s.base}/share/bets/${betId}.png`);
    assert.equal(card.status, 200);

    const requests = await s.db.many(`select method, wallet_account, transaction_hash, execution_status from bilateral_near_requests where bet_id = $1 order by created_at`, [betId]);
    assert.ok(requests.every((r) => r.execution_status === 'succeeded' && r.transaction_hash), 'every signed request was verified as final');
    const evidence = { verifiedAt: new Date().toISOString(), network: 'testnet', contract, contractVersion: 2, betId,
      accounts: { creator: oskarAccount, acceptor: lenaAccount, referee: onChain.referee },
      x: 'simulated locally; no live X calls', replies: botReplies(),
      transactions: [...requests.map((r) => ({ method: r.method, signer: r.wallet_account, hash: r.transaction_hash })),
        { method: 'referee_resolve', signer: onChain.referee, hash: settlementHash }],
      finalState: onChain, steps };
    await mkdir(dirname(evidencePath), { recursive: true });
    await writeFile(evidencePath, `${JSON.stringify(evidence, null, 2)}\n`, { flag: 'wx' });
    console.log(`Passed. Evidence: ${evidencePath}`);
  } finally {
    await s.close();
  }
}

main().catch((error) => { console.error('Reply-bet live check failed:', error.stack || error.message); process.exitCode = 1; });
