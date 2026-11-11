import test from 'node:test';
import assert from 'node:assert/strict';
import { deliveryFromReceipts } from '../src/near-delivery.mjs';
import { nearChain } from '../src/play.mjs';

const transactionHash = '9'.repeat(44);
const accountId = 'bettor.stated.testnet';
const wrapContractId = 'wrap.testnet';
const amountYocto = '100000000000000000000000';
const wanted = { transactionHash, accountId, wrapContractId, amountYocto };
const tx = (receipts, final = 'FINAL') => ({
  transaction: { hash: transactionHash }, final_execution_status: final, status: { SuccessValue: '' },
  receipts: receipts.map(({ receiver, sender, transfer }, i) => ({
    receipt_id: String(i), receiver_id: receiver, predecessor_id: sender,
    receipt: { Action: { actions: transfer ? [{ Transfer: { deposit: transfer } }] : [] } },
  })),
  receipts_outcome: receipts.map(({ receiver, logs, failed }, i) => ({
    id: String(i), outcome: { executor_id: receiver, status: failed ? { Failure: {} } : { SuccessValue: '' }, logs },
  })),
});
const wrapped = (from, to, amount, receiver = wrapContractId) => ({
  receiver, sender: from, logs: ['EVENT_JSON:' + JSON.stringify({ standard: 'nep141', version: '1.0.0',
    event: 'ft_transfer', data: [{ old_owner_id: from, new_owner_id: to, amount }] })],
});

test('only a finalized successful transfer to the exact account proves native delivery', () => {
  const receipt = { sender: 'solver.testnet', receiver: accountId, transfer: amountYocto };
  assert.deepEqual(deliveryFromReceipts(tx([receipt, { ...receipt, sender: 'system' }]), wanted),
    { final: true, kind: 'native', deliveredYocto: amountYocto });
  for (const invalid of [tx([receipt], 'EXECUTED'), tx([{ ...receipt, failed: true }]),
    tx([{ ...receipt, receiver: 'someone.testnet' }]), tx([{ ...receipt, transfer: '1' }])]) {
    assert.equal(deliveryFromReceipts(invalid, wanted), null);
  }
});

test('only net wrapped delivery from the actual token contract counts', () => {
  const transfer = wrapped('solver.testnet', accountId, amountYocto);
  assert.deepEqual(deliveryFromReceipts(tx([transfer]), wanted), { final: true, kind: 'wrapped', deliveredYocto: amountYocto });
  assert.equal(deliveryFromReceipts(tx([wrapped('solver.testnet', accountId, amountYocto, 'fake.testnet')]), wanted), null);
  assert.equal(deliveryFromReceipts(tx([transfer, wrapped(accountId, 'solver.testnet', '1')]), wanted), null);
  assert.equal(deliveryFromReceipts(tx([{ ...transfer, failed: true }]), wanted), null);
  const older = { ...transfer, logs: [`Transfer ${amountYocto} from solver.testnet to ${accountId}`] };
  assert.deepEqual(deliveryFromReceipts(tx([older]), wanted), { final: true, kind: 'wrapped', deliveredYocto: amountYocto });
  assert.equal(deliveryFromReceipts(tx([{ ...older, logs: [...older.logs, `Refund 1 from ${accountId} to solver.testnet`] }]), wanted), null);
});

test('old-style RPC missing-key results cannot authorize treasury or account recovery', async () => {
  const testChain = (result) => nearChain({ fetchImpl: async () => Response.json({ result }) });
  assert.equal(await testChain({ error: 'access key ed25519:public does not exist while viewing' }).hasKey(accountId, 'ed25519:public'), false);
  assert.equal(await testChain({ nonce: 42, permission: 'FullAccess' }).hasKey(accountId, 'ed25519:public', { fullAccess: true }), true);
  assert.equal(await testChain({ nonce: 42, permission: { FunctionCall: {} } }).hasKey(accountId, 'ed25519:public', { fullAccess: true }), false);
  await assert.rejects(testChain({ error: 'internal error' }).hasKey(accountId, 'ed25519:public'), /Invalid NEAR access key/);
});
