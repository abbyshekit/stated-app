import test from 'node:test';
import assert from 'node:assert/strict';
import { seal } from '../src/crypto.mjs';
import { escrowReadiness, readinessPage } from '../dev/demo-readiness.mjs';
import { recordedPayoutCheck, recordedPayoutPage, verifyRecordedPayout } from '../dev/demo-proof.mjs';
import evidence from '../../evidence/hackathon-demo-20261111.json' with { type: 'json' };

test('demo readiness reports initialization failure, RPC failure and recovery without writes', async () => {
  const config = { near: { real: false }, nearContract: 'escrow.testnet', tokenKey: 'test-key', play: { enabled: true } };
  const values = new Map();
  const db = { one: async (_sql, [key]) => values.has(key) ? { value: values.get(key) } : null };
  let rpcDown = false;
  const chain = {
    balance: async () => { if (rpcDown) throw new Error('private RPC error'); return '100'; },
    faucet: async () => { throw new Error('readiness must not call the faucet'); },
  };
  assert.equal(await escrowReadiness({ db, config, chain }), 'degraded');
  values.set('play_treasury', seal(JSON.stringify({ id: 'bank.testnet', secret: 'private-key' }), config.tokenKey));
  values.set('play_referee', seal(JSON.stringify({ id: 'referee.bank.testnet', secret: 'private-key' }), config.tokenKey));
  rpcDown = true;
  assert.equal(await escrowReadiness({ db, config, chain }), 'degraded');
  rpcDown = false;
  assert.equal(await escrowReadiness({ db, config, chain }), 'checked');
  chain.balance = async () => '0';
  assert.equal(await escrowReadiness({ db, config, chain }), 'degraded');
  assert.equal(await escrowReadiness({ db, config: { ...config, near: { real: true } }, chain }), 'disabled');
  const page = readinessPage('degraded', 'http://127.0.0.1:4310', true);
  assert.match(page, /worker reported an error since startup/);
  assert.match(page, /Browse seeded predictions/);
  assert.match(page, /href="\/demo-proof"/);
  assert.match(page, /Simulated X/);
  assert.doesNotMatch(page, /private-key|private RPC error/);
});

test('the recorded payout requires the exact settled Bet and its finalized transfer and callback', async () => {
  const { environment, payout } = evidence;
  const success = { SuccessValue: 'dHJ1ZQ==' };
  const bet = {
    id: environment.bet, status: 'settled', creator_side: 'no', acceptor: payout.winner,
    resolution: { outcome: 'yes', method: 'referee' }, stake_yocto: (BigInt(payout.deliveredYocto) / 2n).toString(),
  };
  const transaction = {
    final_execution_status: 'FINAL', status: success,
    transaction: { hash: payout.transaction, signer_id: payout.winner, receiver_id: environment.escrow,
      actions: [{ FunctionCall: { method_name: 'withdraw', deposit: '0' } }] },
    receipts: [{
      receipt_id: payout.transferReceipt, predecessor_id: environment.escrow, receiver_id: payout.winner,
      receipt: { Action: { actions: [{ Transfer: { deposit: payout.deliveredYocto } }] } },
    }],
    receipts_outcome: [
      { id: payout.transferReceipt, outcome: { executor_id: payout.winner, status: { SuccessValue: '' } } },
      { id: payout.callbackReceipt, outcome: { executor_id: environment.escrow, status: success } },
    ],
  };
  const verify = (tx, escrow = bet) => verifyRecordedPayout({
    request: async (method, params) => {
      assert.equal(method, 'tx_status');
      assert.deepEqual(params, { tx_hash: payout.transaction, sender_account_id: payout.winner, wait_until: 'FINAL' });
      return tx;
    },
    readBet: async (contract, id) => {
      assert.equal(contract, environment.escrow);
      assert.equal(id, environment.bet);
      return escrow;
    },
  });
  assert.equal(await verify(transaction), true);
  assert.equal(await verify({ ...transaction, final_execution_status: 'EXECUTED' }), false);
  assert.equal(await verify(transaction, { ...bet, status: 'accepted' }), false);
  assert.equal(await verify({ ...transaction, receipts_outcome: transaction.receipts_outcome.slice(0, 1) }), false);
  transaction.receipts[0].receipt.Action.actions[0].Transfer.deposit = '1';
  assert.equal(await verify(transaction), false);
});

test('the payout page distinguishes the recorded proof, verified history and an unavailable check', async () => {
  const recorded = String(recordedPayoutPage(null));
  assert.match(recorded, /0\.4 test NEAR paid/);
  assert.match(recorded, /href="\/demo-proof\?verify=1"/);
  assert.doesNotMatch(recorded, /Verified on NEAR/);
  let requests = 0;
  const check = recordedPayoutCheck(async () => { requests += 1; return true; });
  assert.deepEqual(await Promise.all([check(), check()]), ['verified', 'verified']);
  assert.equal(await check(), 'verified');
  assert.equal(requests, 1);
  assert.match(String(recordedPayoutPage(await check())), /Verified on NEAR testnet/);
  const offline = recordedPayoutCheck(async () => { throw new Error('private RPC details'); });
  const unavailable = String(recordedPayoutPage(await offline()));
  assert.match(unavailable, /The live check is unavailable/);
  assert.match(unavailable, /Open transaction/);
  assert.doesNotMatch(unavailable, /private RPC details|Verified on NEAR/);
});
