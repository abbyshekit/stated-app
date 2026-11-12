import test from 'node:test';
import assert from 'node:assert/strict';
import { evidenceForBet, readPublicBet } from '../src/bet-public.mjs';

// Persisted snapshot shape from bet-public.test.mjs's storeFinalizedSnapshot.
const ns = value => (BigInt(new Date(value).getTime()) * 1000000n).toString();
function snapshot(id, acceptorConsented) {
  const row = { id, creator_user_id: '1', acceptor_user_id: '2', creator_username: 'maker',
    acceptor_username: 'private_taker', creator_bound: true, acceptor_bound: true,
    acceptor_consented: acceptorConsented, claim: 'Will the event occur?', criteria: 'Official result',
    terms_hash: 'c'.repeat(64), stake_yocto: '100000000000000000000000', creator_side: 'yes',
    creator_wallet: 'creator.testnet', acceptor_wallet: 'joiner.testnet',
    accept_by: '2027-01-01T00:00:00.000Z', resolve_at: '2027-01-02T00:00:00.000Z',
    near_height: '321', near_verified_at: new Date(), read_at: new Date() };
  row.chain_state = { id, creator: row.creator_wallet, acceptor: row.acceptor_wallet,
    creator_binding_hash: 'a'.repeat(64), acceptor_binding_hash: 'b'.repeat(64),
    terms_hash: row.terms_hash, stake_yocto: row.stake_yocto, creator_side: row.creator_side,
    accept_by_ns: ns(row.accept_by), resolve_at_ns: ns(row.resolve_at), status: 'accepted' };
  return row;
}

test('evidence uses the originating Bet identity consent and binding, including sibling Bets', async () => {
  const id = '00000000-0000-4000-8000-000000000001';
  const siblingId = '00000000-0000-4000-8000-000000000002';
  const current = snapshot(id, false);
  const sibling = snapshot(siblingId, false);
  sibling.creator_user_id = '4';
  sibling.acceptor_user_id = '5';
  const evidence = [current, sibling].map((row, i) => ({ id: String(i + 1), bet_id: row.id,
    user_id: row.acceptor_user_id, side: 'no', url: `https://example.org/evidence/${i}`, x_username: 'private_taker',
    evidence_creator_id: row.creator_user_id, evidence_acceptor_id: row.acceptor_user_id }));
  evidence.push({ id: '3', bet_id: id, user_id: '1', side: 'yes', url: 'https://example.org/creator', x_username: 'maker' });
  const db = {
    async one(sql) {
      if (sql.includes('select e.detail')) return null;
      if (sql.includes('select s.statement_id')) return { statement_id: '7' };
      assert.match(sql, /p.withdrawn_at is null/);
      return current;
    },
    async many(sql) {
      if (sql.includes('from bet_evidence')) return evidence;
      assert.match(sql, /b.id\s*=\s*any/);
      return [current, sibling];
    },
  };
  const read = () => readPublicBet(db, id);
  let bet = await read();
  assert.equal(bet.acceptor_username, null);
  assert.deepEqual(bet.evidence.items.map(item => [item.side, item.by]), [['no', null], ['no', null], ['yes', 'maker']]);
  assert.doesNotMatch(JSON.stringify(bet), /private_taker/);
  const outsiderEvidence = await evidenceForBet(db, '7', id, '3');
  assert.deepEqual(outsiderEvidence.map(item => item.x_username), [null, null, 'maker']);
  assert.deepEqual((await evidenceForBet(db, '7', id, '1')).map(item => item.x_username),
    ['private_taker', null, 'maker'], 'participants in this Bet do not gain a sibling Bet’s private identity');
  assert.equal((await evidenceForBet(db, '7', id, '2'))[0].x_username, 'private_taker', 'a source Bet participant can see their own identity');
  current.acceptor_consented = true;
  bet = await read();
  assert.deepEqual(bet.evidence.items.map(item => item.by), ['private_taker', null, 'maker']);
  sibling.acceptor_consented = true;
  assert.deepEqual((await read()).evidence.items.map(item => item.by), ['private_taker', 'private_taker', 'maker']);
  sibling.acceptor_bound = false;
  assert.equal((await read()).evidence.items[1].by, null, 'consent alone does not establish a bound identity');
  sibling.acceptor_bound = true;
  sibling.chain_state.terms_hash = 'tampered';
  assert.equal((await read()).evidence.items[1].by, null, 'an unverified sibling snapshot cannot name its bettor');
});
