import assert from 'node:assert/strict';
import test from 'node:test';
import { removeSave, UserError } from '../src/store.mjs';

// Unit coverage for the user-facing guard; the real FK and transaction races
// are covered against PostgreSQL in bets.test.mjs.
for (const status of ['offered', 'accepted', 'settled', 'refunded']) {
  test(`removeSave refuses a referenced save before side effects (${status})`, async () => {
    const user = { id: '7' };
    const save = { save_id: '11', statement_id: '13', owner_user_id: user.id, visibility: 'private' };
    const tx = {
      async one(sql, params) {
        if (/from saves/.test(sql)) return { id: save.save_id };
        assert.match(sql, /from bilateral_bets/);
        assert.doesNotMatch(sql, /\bstatus\s*(?:=|in)/i, 'every Bet status protects its source');
        assert.deepEqual(params, [save.save_id]);
        return { id: 'bet', status };
      },
      async query(sql) { assert.fail(`Deletion side effect reached: ${sql}`); },
    };
    const db = { one: async () => save, tx: (fn) => fn(tx) };
    await assert.rejects(removeSave(db, user, save.save_id), (error) => error instanceof UserError
      && error.status === 409 && error.message === 'This post has a bet on it, so it stays. You can make it private instead.');
  });
}
