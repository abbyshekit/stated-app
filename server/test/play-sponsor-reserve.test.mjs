import test from 'node:test';
import assert from 'node:assert/strict';
import { shortfall, yocto } from '../src/play.mjs';

test('the sponsored grant can fund stakes while the fee grant stays reserved', async () => {
  const config = { near: { real: true }, play: { fundsStakes: false } };
  const chain = { callFunds: async () => ({ balance: BigInt(yocto('1')), reserve: BigInt(yocto('0.01')) }) };
  const sponsored = { account_id: 'user.stated.near', granted_yocto: yocto('1') };
  assert.equal(await shortfall(config, chain, sponsored, yocto('0.9')), '0');
  assert.equal(await shortfall(config, chain, { ...sponsored, granted_yocto: yocto('0.05') }, yocto('1')), yocto('0.05'));
  assert.equal(await shortfall(config, chain, sponsored, '0'), '0', 'withdrawals can use the fee reserve');
  assert.equal(await shortfall({ ...config, near: { real: false } }, chain, sponsored, yocto('0.9')), yocto('0.9'), 'testnet behavior stays unchanged');
});
