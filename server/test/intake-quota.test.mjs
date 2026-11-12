// Requires real PostgreSQL. This file is deliberately separate from database-free parser checks.
import assert from 'node:assert/strict';
import http from 'node:http';
import { test } from 'node:test';
import { createDb } from '../src/db.mjs';
import { createIntake, INTAKES_PER_HOUR, personIntake } from '../src/articles.mjs';
import { reserveIntake } from '../src/limits.mjs';
import { startPostgres } from './support/pg.mjs';

test('40 parallel person intakes reserve at most 20 rows before fetching, across DB pools', { timeout: 30_000 }, async (t) => {
  const pg = await startPostgres();
  const db = createDb(pg.url); const db2 = createDb(pg.url);
  let site;
  t.after(async () => {
    if (site?.listening) {
      site.closeAllConnections(); await new Promise((resolve) => site.close(resolve));
    }
    await db.close(); await db2.close(); pg.stop();
  });
  await db.migrate();
  const user = await db.one(`insert into users (x_user_id, x_username) values ('quota-person', 'quota_person') returning *`);
  let requests = 0; let missingReservation = false;
  site = http.createServer(async (req, res) => {
    requests += 1;
    const row = await db.one('select id from url_intakes where owner_x_user_id = $1 and url = $2',
      [user.x_user_id, `http://127.0.0.1:${site.address().port}${req.url}`]);
    missingReservation ||= !row;
    res.writeHead(200, { 'content-type': 'text/html' });
    res.end('<p>The public record remains available for inspection.</p>');
  });
  await new Promise((resolve) => site.listen(0, '127.0.0.1', resolve));
  const base = `http://127.0.0.1:${site.address().port}`;
  const config = { baseUrl: base, fetch: { allowLoopback: true, timeoutMs: 1000, maxBytes: 2_000_000 } };
  const results = await Promise.allSettled(Array.from({ length: 40 }, (_, index) =>
    personIntake(index % 2 ? db : db2, config, user, `${base}/${index}`)));
  const { n } = await db.one('select count(*)::int as n from url_intakes where owner_x_user_id = $1', [user.x_user_id]);
  assert.equal(n, INTAKES_PER_HOUR);
  assert.equal(results.filter((result) => result.status === 'fulfilled').length, INTAKES_PER_HOUR);
  assert.equal(results.filter((result) => result.status === 'rejected' && result.reason.status === 429).length, 40 - INTAKES_PER_HOUR);
  assert.equal(requests, INTAKES_PER_HOUR);
  assert.equal(missingReservation, false);

  // Routes sharing the helper cannot each consume a separate allowance.
  const mixed = await Promise.allSettled(Array.from({ length: 40 }, (_, index) => createIntake(index % 2 ? db : db2, {
    ownerXUserId: 'mixed-person', url: `${base}/mixed/${index}`, route: ['web', 'dm', 'mention'][index % 3],
  })));
  assert.equal(mixed.filter((result) => result.status === 'fulfilled').length, INTAKES_PER_HOUR);
  assert.equal((await db.one(`select count(*)::int as n from url_intakes where owner_x_user_id = 'mixed-person'`)).n, INTAKES_PER_HOUR);

  // Failed work consumes its reservation; another person has an independent quota.
  await db.query(`update url_intakes set status = 'failed' where owner_x_user_id = $1`, [user.x_user_id]);
  await assert.rejects(reserveIntake(db, { ownerXUserId: user.x_user_id, url: `${base}/retry`, route: 'web' }), { status: 429 });
  assert.ok(await reserveIntake(db2, { ownerXUserId: 'another-person', url: `${base}/other`, route: 'web' }));

  // A rolled-back insert does not leak the transaction-scoped advisory lock.
  await assert.rejects(reserveIntake(db, { ownerXUserId: 'rollback-person', url: `${base}/bad`, route: 'invalid' }));
  assert.ok(await reserveIntake(db2, { ownerXUserId: 'rollback-person', url: `${base}/good`, route: 'web' }));
});
