// INTEGRATION: Exercise the installed Meteor SDK converter, not a shape-only mock.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { MeteorWallet } from '@meteorwallet/sdk';
import { KeyPair } from 'near-api-js';
import { walletTransaction } from '../public/wallet-transaction.mjs';

test('prepared wallet actions survive the real Meteor transaction converter unchanged', async () => {
  const payload = { accountId: 'synthetic.testnet', contract: 'escrow.testnet', method: 'create_bet',
    args: { id: 'synthetic-bet', binding_hash: 'unchanged' }, gas: '100000000000000',
    depositYocto: '110000000000000000000000' };
  const converted = await MeteorWallet.prototype.transformTransactions.call({
    _provider: { viewBlock: async () => ({ header: { hash: '11111111111111111111111111111111' } }) },
    _fakePublicKey: KeyPair.fromRandom('ed25519').getPublicKey(),
  }, { meteorConnectAccount: { identifier: { accountId: payload.accountId } },
    transactions: [walletTransaction(payload)] });
  assert.equal(converted.length, 1);
  assert.equal(converted[0].signerId, payload.accountId);
  assert.equal(converted[0].receiverId, payload.contract);
  const call = converted[0].actions[0].functionCall;
  assert.equal(converted[0].actions.length, 1);
  assert.equal(call.methodName, payload.method);
  assert.deepEqual(JSON.parse(new TextDecoder().decode(call.args)), payload.args);
  assert.equal(call.deposit, BigInt(payload.depositYocto));
  assert.equal(call.gas, BigInt(payload.gas));
});
