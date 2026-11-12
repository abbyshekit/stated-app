import test from 'node:test';
import assert from 'node:assert/strict';
import { betTerms } from '../src/bet-view.mjs';

const base = {
  criteria: 'Yes if what the post says has happened by 19:15 UTC 12 Nov 2026.',
  evidence_source_url: 'https://x.com/ChainAbstracted/status/2120950017922150650',
  stake_yocto: '10000000000000000000000',
  accept_by: new Date('2026-11-12T19:14:00Z'),
  resolve_at: new Date('2026-11-12T19:15:00Z'),
};

test('a Court-refereed bet describes the Court path, and other bets keep their wording', () => {
  const court = String(betTerms({ ...base, referee_wallet: 'stated-court.sputnik-v2.testnet' }, { juryReview: true }));
  assert.match(court, /The recorded Result becomes a proposal in Stated Court/);
  assert.match(court, /Its council can vote the proposal down for ten minutes; after that the DAO settles the contract\./);
  assert.match(court, /A reviewer can ask the council to vote a ruling down within those ten minutes\./);
  assert.doesNotMatch(court, /carries it to the contract|correct a ruling before it pays out/);

  const mainnetCourt = String(betTerms({ ...base, referee_wallet: 'stated-court.sputnik-dao.near' }));
  assert.match(mainnetCourt, /becomes a proposal in Stated Court/);
  assert.doesNotMatch(mainnetCourt, /A reviewer can/, 'no reviewer sentence without jury review');

  const server = String(betTerms({ ...base, referee_wallet: 'referee.stated-play-6cf0876dd7.testnet' }, { juryReview: true }));
  assert.match(server, /the referee account <span class="mono">referee\.stated-play-6cf0876dd7\.testnet<\/span> carries it to the contract/);
  assert.match(server, /A reviewer can correct a ruling before it pays out\./);
  assert.doesNotMatch(server, /Stated Court/);

  const agreed = String(betTerms({ ...base, referee_wallet: null }));
  assert.match(agreed, /Both must agree on the result\./);
  assert.doesNotMatch(agreed, /Stated Court|A reviewer can/);
});
