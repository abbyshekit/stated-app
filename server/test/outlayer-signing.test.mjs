import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { baseEncode, KeyPair, SignedTransaction } from 'near-api-js';
import { nearChain } from '../src/play.mjs';

test('OutLayer signing yields a stable hash before any broadcast and resends identical signed bytes', async () => {
  const broadcasts = [];
  const fetchImpl = async (url, options) => {
    assert.equal(url, 'https://synthetic-rpc.example/');
    assert.equal(options.redirect, 'error');
    assert.ok(options.signal instanceof AbortSignal);
    const request = JSON.parse(options.body);
    let result;
    if (request.method === 'query') result = { nonce: 10, permission: 'FullAccess' };
    else if (request.method === 'block') result = { header: { hash: baseEncode(Buffer.alloc(32, 9)), height: 100 } };
    else if (request.method === 'send_tx') {
      broadcasts.push(request.params.signed_tx_base64);
      const signed = SignedTransaction.decode(Buffer.from(request.params.signed_tx_base64, 'base64'));
      const hash = baseEncode(createHash('sha256').update(signed.transaction.encode()).digest());
      assert.equal(signed.transaction.signerId, 'sponsor.testnet');
      assert.equal(signed.transaction.receiverId, 'ref.testnet');
      assert.equal(signed.transaction.actions[0].functionCall.methodName, 'request_ruling');
      assert.equal(signed.transaction.actions[0].functionCall.gas, 300000000000000n);
      assert.equal(signed.transaction.actions[0].functionCall.deposit, 0n);
      result = { final_execution_status: 'FINAL', transaction: { hash, signer_id: signed.transaction.signerId,
        receiver_id: signed.transaction.receiverId }, status: { SuccessValue: Buffer.from('true').toString('base64') } };
    } else throw new Error('Unexpected synthetic RPC method');
    return Response.json({ jsonrpc: '2.0', id: request.id, result });
  };
    const chain = nearChain({ urls: ['https://synthetic-rpc.example/'], fetchImpl });
    const prepared = await chain.prepareCall({ signerId: 'sponsor.testnet', secret: KeyPair.fromRandom('ed25519').toString(),
      contractId: 'ref.testnet', method: 'request_ruling', args: { bet_id: 'synthetic-bet' }, gas: 300000000000000n });
    assert.equal(broadcasts.length, 0);
    assert.match(prepared.hash, /^[1-9A-HJ-NP-Za-km-z]{43,44}$/);
    for (let i = 0; i < 2; i += 1) assert.equal((await chain.broadcastCall(prepared)).hash, prepared.hash);
    assert.deepEqual(broadcasts, [prepared.signedTransaction, prepared.signedTransaction]);
    await assert.rejects(chain.prepareCall({ signerId: 'sponsor.testnet', secret: 'invalid', contractId: 'ref.testnet',
      method: 'request_ruling', args: {}, gas: 300000000000000n }));
    assert.equal(broadcasts.length, 2);
});
