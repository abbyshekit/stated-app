// INTEGRATION: Offline replay of captured public mainnet RPC responses, including
// a synthetic wrapped-token payout that must not pass the native-NEAR demo proof.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { deliveryFromReceipts } from '../server/src/near-delivery.mjs';
import { verifyMainnetDemo } from './verify-mainnet-demo.mjs';

const capture = JSON.parse(readFileSync(new URL('./fixtures/mainnet-demo-rpc-20261114.json', import.meta.url), 'utf8'));
const YES_WITHDRAWAL = 'Cd1bvxP93A8DEmF4mU27tjMvDXiQkYSyt44NrzbhRiQm';
const WINNER = 'abhishekesq.play.statedforecast.near';
const ESCROW = 'escrow.statedforecast.near';
const POT = '200000000000000000000000';

function replay(records) {
  const responses = new Map();
  for (const record of records) {
    const key = `${record.url}\0${record.requestBody || ''}`;
    assert.equal(responses.has(key), false, `Duplicate captured request: ${record.url}`);
    const body = record.assetPath
      ? readFileSync(new URL(`../${record.assetPath}`, import.meta.url)) : record.body;
    responses.set(key, { body, status: record.status,
      contentType: record.headers?.['content-type'] || 'application/json' });
  }
  const seen = new Set();
  const fetchImpl = async (url, init = {}) => {
    const key = `${url}\0${init.body || ''}`;
    const response = responses.get(key);
    assert.ok(response, `Uncaptured request: ${url} ${String(init.body).slice(0, 100)}`);
    seen.add(key);
    return new Response(response.body, { status: response.status,
      headers: { 'content-type': response.contentType } });
  };
  return { fetchImpl, assertAllUsed: () => assert.equal(seen.size, responses.size) };
}

function wrappedPayout(records) {
  let changed = 0;
  const modified = records.map(record => {
    if (!record.requestBody) return record;
    const request = JSON.parse(record.requestBody);
    if (request.method !== 'EXPERIMENTAL_tx_status' || request.params.tx_hash !== YES_WITHDRAWAL) return record;
    const payload = JSON.parse(record.body);
    const result = payload.result;
    const transfer = result.receipts.find(receipt => receipt.predecessor_id === ESCROW
      && receipt.receiver_id === WINNER && receipt.receipt?.Action?.actions?.[0]?.Transfer?.deposit === POT);
    assert.ok(transfer, 'Captured native payout receipt missing');
    transfer.receiver_id = 'wrap.near';
    transfer.receipt.Action.actions = [{ FunctionCall: { method_name: 'ft_transfer',
      args: Buffer.from(JSON.stringify({ receiver_id: WINNER, amount: POT })).toString('base64'),
      deposit: '0', gas: 100000000000000 } }];
    const outcome = result.receipts_outcome.find(item => item.id === transfer.receipt_id)?.outcome;
    assert.ok(outcome, 'Captured payout outcome missing');
    outcome.executor_id = 'wrap.near';
    outcome.logs = [`EVENT_JSON:${JSON.stringify({ standard: 'nep141', version: '1.0.0',
      event: 'ft_transfer', data: [{ old_owner_id: ESCROW, new_owner_id: WINNER, amount: POT }] })}`];
    assert.deepEqual(deliveryFromReceipts(result, { transactionHash: YES_WITHDRAWAL,
      accountId: WINNER, amountYocto: POT, wrapContractId: 'wrap.near' }),
    { final: true, kind: 'wrapped', deliveredYocto: POT });
    changed++;
    return { ...record, body: JSON.stringify(payload) };
  });
  assert.equal(changed, 2, 'Both independent public-provider responses must be mutated');
  return modified;
}

test('captured public mainnet responses verify both funded trials', async () => {
  const transport = replay(capture.records);
  const result = await verifyMainnetDemo({ fetchImpl: transport.fetchImpl });
  transport.assertAllUsed();
  assert.equal(result.overall, 'PASS', JSON.stringify(result.checks.filter(item => !item.ok)));
  assert.deepEqual(result.cases.map(item => item.outcome), ['yes', 'no']);
  assert.equal(result.checks.length, 15);
});

test('wrapped tokens cannot satisfy a native NEAR payout', async () => {
  const transport = replay(wrappedPayout(capture.records));
  const result = await verifyMainnetDemo({ fetchImpl: transport.fetchImpl });
  transport.assertAllUsed();
  assert.equal(result.overall, 'FAIL');
  assert.equal(result.cases.some(item => item.outcome === 'yes' && item.payout.verified), false);
  assert.equal(result.checks.filter(item => item.name.startsWith('yes:') && !item.ok).length, 2);
});
