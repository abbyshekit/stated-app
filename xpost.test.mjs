import assert from 'node:assert/strict';
import test from 'node:test';
import { seedState } from './seed.mjs';
import {
  X_LIMIT,
  callPosts,
  closeStamp,
  fits,
  reasonPost,
  receiptPost,
  updatePost,
  xIntent,
} from './xpost.mjs';

test('every league call fits on X without cutting the sentence or the rule', () => {
  const state = seedState(Date.parse('2026-11-06T13:00:00Z'));
  for (const question of Object.values(state.questions)) {
    const built = callPosts({
      claim: question.claim,
      closeLabel: closeStamp(question.closeAt),
      percent: 54,
      rule: question.postRule,
    });
    for (const post of built.posts) {
      assert.ok(fits(post), `${question.id} is ${post.length} characters`);
    }
    const joined = built.posts.join('\n');
    assert.ok(joined.includes(question.claim));
    assert.ok(joined.includes('54%'));
    assert.ok(joined.includes(question.postRule));
    assert.ok(joined.includes('On record'));
  }
});

test('an update and a receipt stay inside one post and quote the original number', () => {
  const update = updatePost({
    from: 58,
    to: 54,
    reason: 'Shading down ahead of the CPI print. The dissent still keeps a hike plausible.',
  });
  const receipt = receiptPost({
    outcome: 'no',
    percent: 54,
    baseline: -40.2,
    what: 'The implementation note kept the lower bound at 3.75 percent.',
  });
  assert.ok(update.length <= X_LIMIT);
  assert.ok(receipt.length <= X_LIMIT);
  assert.ok(update.includes('Was 58%. Now 54%.'));
  assert.ok(receipt.includes('Recorded. No.'));
  assert.ok(receipt.includes('Baseline -40'));
  assert.equal(reasonPost('  The dissent still matters.  '), 'The dissent still matters.');
});

test('the X link carries the post and the quote', () => {
  const url = xIntent('On record\n\n54%', 'https://x.com/ada/status/1');
  const parsed = new URL(url);
  assert.equal(parsed.origin + parsed.pathname, 'https://x.com/intent/post');
  assert.equal(parsed.searchParams.get('text'), 'On record\n\n54%');
  assert.equal(parsed.searchParams.get('url'), 'https://x.com/ada/status/1');
});
