import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { repairMissingXDeadline } from '../../scripts/repair-x-deadline.mjs';
import { createDb } from '../src/db.mjs';
import { startPostgres } from './support/pg.mjs';

let pg;
let db;
let nextId = 7000;
const text = 'The launch will happen by 10 November 2026.';
before(async () => {
  pg = await startPostgres();
  db = createDb(pg.url);
  await db.migrate();
});
after(async () => { await db?.close(); pg?.stop(); });

async function seed() {
  const postId = String(nextId++);
  const source = await db.one(
    `insert into sources (platform, platform_id, url, author_x_user_id, text, published_at, acquisition)
     values ('x', $1, $2, '123', '', '2026-11-09T12:00:00Z', 'mention') returning *`,
    [postId, `https://x.com/owner/status/${postId}`],
  );
  const statement = await db.one(
    `insert into statements (source_id, span, speaker, speaker_x_user_id)
     values ($1, $2, '@owner', '123') returning *`, [source.id, `X post ${postId}`],
  );
  const save = await db.one(
    `insert into saves (owner_x_user_id, statement_id, relation, intake, created_at)
     values ('123', $1, 'mine', 'mention', '2026-11-09T12:05:00Z') returning *`, [statement.id],
  );
  return { source, statement, save, input: { saveId: save.id, sourcePostId: postId, sourceUrl: source.url, text } };
}

test('repair writes only the missing date and a private audit, and concurrent replay changes nothing', async () => {
  const f = await seed();
  const results = await Promise.all([repairMissingXDeadline(db, f.input), repairMissingXDeadline(db, f.input)]);
  assert.equal(results.filter((r) => r.changed).length, 1);
  assert.ok(results.every((r) => r.proposedDeadlineAt === '2026-11-10T23:59:59.000Z'));
  const statement = await db.one('select * from statements where id = $1', [f.statement.id]);
  assert.equal(statement.proposed_deadline_at.toISOString(), '2026-11-10T23:59:59.000Z');
  assert.deepEqual({ ...statement, proposed_deadline_at: null }, f.statement);
  assert.deepEqual(await db.one('select * from saves where id = $1', [f.save.id]), f.save);
  assert.deepEqual(await db.one('select * from sources where id = $1', [f.source.id]), f.source);
  const revisions = await db.many('select * from revisions where statement_id = $1', [f.statement.id]);
  assert.equal(revisions.length, 1);
  assert.equal(revisions[0].save_id, f.save.id);
  assert.equal(revisions[0].kind, 'terms_reparsed');
  assert.equal(revisions[0].actor, 'system');
  assert.deepEqual(revisions[0].before, { proposedDeadlineAt: null });
  assert.deepEqual(revisions[0].after, { proposedDeadlineAt: '2026-11-10T23:59:59.000Z' });
  assert.doesNotMatch(JSON.stringify(revisions), /10 November|The launch/);
});

test('repair refuses changes to public, confirmed, shared or already interpreted predictions', async () => {
  const changes = [
    async (f) => db.query("update saves set visibility = 'public' where id = $1", [f.save.id]),
    async (f) => db.query('update saves set author_confirmed_at = now() where id = $1', [f.save.id]),
    async (f) => db.query("update statements set deadline_at = '2026-11-10', terms_confirmed_by = 'reviewer' where id = $1", [f.statement.id]),
    async (f) => db.query("update statements set proposed_deadline_at = '2026-11-11' where id = $1", [f.statement.id]),
    async (f) => db.query("insert into saves (owner_x_user_id, statement_id, relation, intake) values ('456', $1, 'following', 'mention')", [f.statement.id]),
    async (f) => db.query("update sources set available = false where id = $1", [f.source.id]),
  ];
  for (const change of changes) {
    const f = await seed();
    await change(f);
    const before = await db.one('select * from statements where id = $1', [f.statement.id]);
    await assert.rejects(() => repairMissingXDeadline(db, f.input));
    assert.deepEqual(await db.one('select * from statements where id = $1', [f.statement.id]), before);
    assert.equal((await db.one('select count(*)::int as n from revisions where statement_id = $1', [f.statement.id])).n, 0);
  }
});

test('repair rejects mismatched source URLs, excessive input, absent and already passed dates', async () => {
  const f = await seed();
  for (const input of [
    { ...f.input, sourceUrl: 'https://x.com/owner/status/999' },
    { ...f.input, text: 'x'.repeat(64_001) },
    { ...f.input, text: 'The launch will happen.' },
    { ...f.input, text: 'The launch will happen by 1 November 2026.' },
  ]) await assert.rejects(() => repairMissingXDeadline(db, input));
  assert.equal((await db.one('select proposed_deadline_at from statements where id = $1', [f.statement.id])).proposed_deadline_at, null);
  assert.equal((await db.one('select count(*)::int as n from revisions where statement_id = $1', [f.statement.id])).n, 0);
});
