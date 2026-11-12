import test from 'node:test';
import assert from 'node:assert/strict';
import { registerCourtRoutes } from '../src/court-pages.mjs';
import { proposalKind, clearCourtCache } from '../src/court-dao.mjs';
import { useNetwork } from '../src/near-network.mjs';

test('/court filters malformed Bet ids before the database and shows the relay trust model', async () => {
  useNetwork('testnet'); clearCourtCache();
  const config = { nearContract: 'escrow.testnet', court: { dao: 'court.testnet', relay: 'relay.testnet' }, play: { settleDelaySeconds: 600 } };
  const betId = 'c171de89-f223-4309-886e-180ad69af092';
  let handler; let response;
  const queries = [];
  const policy = { roles: [], proposal_period: '604800000000000', default_vote_policy: { threshold: [1, 2] } };
  const chain = { async view({ method }) {
    if (method === 'get_policy') return policy;
    if (method === 'get_last_proposal_id') return 2;
    return ['not-a-uuid', betId].map((id, index) => ({ id: index, status: 'InProgress', kind: proposalKind(config, id, 'yes') }));
  } };
  registerCourtRoutes({ config, route: (method, pattern, fn) => { handler = fn; }, chain: () => chain,
    db: { async many(sql, params) { queries.push(params); return [{ id: betId }]; } },
    layout: async (ctx, title, body) => body, send: (res, status, body) => { response = { status, body: String(body) }; },
    notFound: () => assert.fail('unexpected 404') });
  await handler({ res: {} });
  assert.equal(response.status, 200);
  assert.deepEqual(queries, [[[betId]]]);
  assert.match(response.body, /cannot approve it until ten minutes have passed/);
  assert.match(response.body, /council can only vote a ruling down or remove it/);
  assert.match(response.body, /Nobody can change these rules/);
  assert.match(response.body, /href="https:\/\/testnet.nearblocks.io\/address\/relay.testnet"/);
  assert.doesNotMatch(response.body, /not-a-uuid/);
});
