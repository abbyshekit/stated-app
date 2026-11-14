import assert from 'node:assert/strict';
import test from 'node:test';
import { functionCallFunds, gasPurchasePrice, NEAR_CALL_GAS } from '../src/near-escrow.mjs';

function mockGas(current, floor, version = 88) {
  return { fetchImpl: async (_url, request) => {
    const { method } = JSON.parse(request.body);
    if (method === 'gas_price') return Response.json({ jsonrpc: '2.0', id: 'stated', result: { gas_price: current } });
    if (method === 'query') return Response.json({ jsonrpc: '2.0', id: 'stated', result: { amount: '50000000000000000000000', storage_usage: 182 } });
    assert.equal(method, 'EXPERIMENTAL_protocol_config');
    return Response.json({ jsonrpc: '2.0', id: 'stated', result: {
      protocol_version: version,
      runtime_config: { min_gas_purchase_price: floor, storage_amount_per_byte: '10000000000000000000' },
    } });
  } };
}

test('NEAR receipt prepayment uses the protocol floor when the block price is lower', async () => {
  const price = await gasPurchasePrice(mockGas('100000000', '1000000000'));
  assert.equal(price * NEAR_CALL_GAS, 100000000000000000000000n);
  assert.equal(await gasPurchasePrice(mockGas('1200000000', '1000000000')), 1200000000n);
  assert.equal(await gasPurchasePrice(mockGas('100000000', undefined, 84)), 100000000n);
  await assert.rejects(gasPurchasePrice(mockGas('100000000', undefined)), /Invalid yoctoNEAR amount/);
});

test('call liquidity includes the signer storage and fixed fees at the receipt gas price', async () => {
  const options = mockGas('100000000', '1000000000');
  const signer = 'managed.testnet';
  assert.deepEqual(await functionCallFunds(signer, NEAR_CALL_GAS, options), {
    balance: 50_000_000_000_000_000_000_000n, reserve: 106_820_000_000_000_000_000_000n,
  });
  assert.deepEqual(await functionCallFunds(signer, 30_000_000_000_000n, options), {
    balance: 50_000_000_000_000_000_000_000n, reserve: 36_820_000_000_000_000_000_000n,
  });
});
