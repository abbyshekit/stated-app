import test from 'node:test';
import assert from 'node:assert/strict';
import { nearChain } from '../src/play.mjs';

const full = { public_key: 'ed25519:11111111111111111111111111111111', access_key: { nonce: 0, permission: 'FullAccess' } };
const functionKey = { ...full, access_key: { nonce: 1, permission: { FunctionCall: {
  allowance: null, receiver_id: 'escrow.near', method_names: ['resolve'],
} } } };
const read = (result) => nearChain({ fetchImpl: async (_url, options) => {
  assert.deepEqual(JSON.parse(options.body).params, { request_type: 'view_access_key_list', finality: 'final', account_id: 'referee.near' });
  return Response.json({ result });
} }).readAccessKeys('referee.near');

test('account key inspection returns finalized RPC keys including an empty list', async () => {
  assert.deepEqual(await read({ keys: [full, functionKey] }), [full, functionKey]);
  assert.deepEqual(await read({ keys: [] }), []);
});

test('account key inspection rejects missing or malformed data instead of reporting no keys', async () => {
  for (const result of [{}, { keys: null }, { keys: [{}] }, { keys: [{ ...full, access_key: { nonce: -1, permission: 'FullAccess' } }] },
    { keys: [{ ...full, public_key: 'synthetic-invalid-key' }] }, { keys: [{ ...functionKey, access_key: { nonce: 0, permission: { FunctionCall: {} } } }] }]) {
    await assert.rejects(read(result), /Invalid NEAR access key list/);
  }
});
