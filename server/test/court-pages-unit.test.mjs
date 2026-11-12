import test from 'node:test';
import assert from 'node:assert/strict';
import { registerCourtRoutes, courtLine } from '../src/court-pages.mjs';
import { proposalKind, clearCourtCache } from '../src/court-dao.mjs';
import { useNetwork } from '../src/near-network.mjs';

test('/court links every valid chain target, puts rejected rulings first and keeps setup collapsed', async () => {
  useNetwork('testnet'); clearCourtCache();
  const config = { nearContract: 'escrow.testnet', court: { dao: 'court.testnet', relay: 'relay.testnet' }, play: { settleDelaySeconds: 600 } };
  const published = 'c171de89-f223-4309-886e-180ad69af092';
  const missing = 'c171de89-f223-4309-886e-180ad69af093';
  const unusual = '00000000-0000-0000-0000-000000000000';
  const policy = { roles: [{ name: 'council', kind: { Group: ['member.testnet'] } }], proposal_period: '604800000000000', default_vote_policy: { threshold: [1, 2] } };
  const proposals = [
    { id: 0, status: 'Rejected', kind: proposalKind(config, published, 'no') },
    { id: 1, status: 'Approved', kind: proposalKind(config, missing, 'yes') },
    { id: 2, status: 'InProgress', kind: proposalKind(config, unusual, 'void') },
    { id: 3, status: 'InProgress', kind: proposalKind(config, 'not-a-uuid', 'yes') },
  ];
  const chain = { async view({ method }) { return method === 'get_policy' ? policy : method === 'get_last_proposal_id' ? proposals.length : proposals; } };
  const lookedUp = [];
  const db = { async tx(fn) { return fn({ async one(sql, [id]) {
    if (sql.includes('from bilateral_bets b\n  join bilateral_bet_publications')) {
      lookedUp.push(id);
      return id === published ? { id, claim: 'A public claim <safe>', read_at: new Date(), chain_state: null } : null;
    }
    return null;
  } }); } };
  let handler; let response;
  registerCourtRoutes({ config, route: (method, pattern, fn) => { handler = fn; }, chain: () => chain, db,
    layout: async (ctx, title, body) => body, send: (res, status, body) => { response = { status, body: String(body) }; },
    notFound: () => assert.fail('unexpected 404') });
  await handler({ res: {} });
  assert.equal(response.status, 200);
  assert.match(response.body, /Every ruling waits ten minutes on NEAR\. The council can vote it down before anyone is paid\./);
  assert.match(response.body, /A public claim &lt;safe&gt;/);
  for (const id of [published, missing, unusual]) assert.ok(response.body.includes(`href="/bets/${id}"`));
  assert.doesNotMatch(response.body, /not-a-uuid/);
  assert.deepEqual(lookedUp.sort(), [published, missing].sort());
  assert.ok(response.body.indexOf(`/bets/${published}`) < response.body.indexOf(`/bets/${missing}`));
  assert.match(response.body, /<b>Voted down<\/b>/);
  assert.match(response.body, /Proposal 0 is voted down\./);
  assert.match(response.body, /<details class="fold"><summary>How the court is set up<\/summary>/);
  assert.ok(response.body.indexOf('member.testnet') > response.body.indexOf('How the court is set up'));
  assert.match(response.body, /relay\.testnet/);
  assert.match(response.body, /more than 1 in 2/);
  config.play.settleDelaySeconds = 120;
  await handler({ res: {} });
  assert.match(response.body, /Every ruling waits 2 minutes on NEAR/);
});

test('courtLine uses sentences for the referee and proposal', async () => {
  useNetwork('testnet'); clearCourtCache();
  const config = { court: { dao: 'court.testnet' } };
  const db = { async one() { return { detail: { proposalId: 5 } }; } };
  const line = String(await courtLine(db, config, () => ({ async view() { return { status: 'Rejected' }; } }),
    { id: 'bet', referee_wallet: 'court.testnet' }));
  assert.match(line, /Stated Court<\/a>, a Sputnik DAO on NEAR, is the referee\. Proposal 5 is voted down\./);
  assert.doesNotMatch(line, /Referee:|Proposal 5:/);
});
