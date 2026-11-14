import assert from 'node:assert/strict';
import { test } from 'node:test';
import { betProposition, betTerms } from '../src/bet-view.mjs';

test('presentation separates the exact committed criteria while preserving canonical terms', () => {
  const criteria = 'Yes if the agreed page lists example.com at the deadline.';
  const proposition = 'IANA lists example.com by midnight UTC';
  for (const binding of [{ outlayer_material: {} }, { outlayer_bound: true }]) {
    const bet = Object.freeze({ ...binding, claim: `${proposition}\n\nCounts as yes:\n${criteria}`, criteria,
      stake_yocto: '100000000000000000000000', evidence_source_url: 'https://www.iana.org/domains/reserved',
      accept_by: '2026-11-14T20:59Z', resolve_at: '2026-11-14T21:00Z' });
    assert.equal(betProposition(bet), proposition);
    assert.equal(bet.claim, `${proposition}\n\nCounts as yes:\n${criteria}`);
    assert(String(betTerms(bet)).includes(criteria), 'full criteria stay in Rules');
  }
});

test('source words containing the marker are preserved unless the exact appended criteria match', () => {
  const claim = 'The source says\n\nCounts as yes:\nits own literal words';
  assert.equal(betProposition({ outlayer_bound: true, claim, criteria: 'Different criteria' }), claim);
  assert.equal(betProposition({ claim, criteria: 'its own literal words' }), claim);
  assert.equal(betProposition({ outlayer_bound: true, claim, criteria: '' }), claim);
  const bet = { outlayer_bound: true, claim: claim + '\n\nCounts as yes:\nAgreed criteria', criteria: 'Agreed criteria' };
  assert.equal(betProposition(bet), claim);
});
