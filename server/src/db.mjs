import { readFileSync } from 'node:fs';
import pg from 'pg';

pg.types.setTypeParser(20, (value) => value);
pg.types.setTypeParser(1700, (value) => (value == null ? null : Number(value)));

export function createDb(connectionString) {
  if (!connectionString) throw new Error('DATABASE_URL is not set.');
  const pool = new pg.Pool({ connectionString, max: 8 });
  return {
    pool,
    query(text, params) {
      return pool.query(text, params);
    },
    async one(text, params) {
      const result = await pool.query(text, params);
      return result.rows[0] || null;
    },
    async many(text, params) {
      const result = await pool.query(text, params);
      return result.rows;
    },
    async tx(fn) {
      const client = await pool.connect();
      try {
        await client.query('begin');
        const value = await fn({
          query: (text, params) => client.query(text, params),
          one: async (text, params) => (await client.query(text, params)).rows[0] || null,
          many: async (text, params) => (await client.query(text, params)).rows,
        });
        await client.query('commit');
        return value;
      } catch (err) {
        await client.query('rollback');
        throw err;
      } finally {
        client.release();
      }
    },
    async migrate() {
      const sql = readFileSync(new URL('./schema.sql', import.meta.url), 'utf8');
      await pool.query(sql);
    },
    close() {
      return pool.end();
    },
  };
}

export async function kvGet(db, key) {
  const row = await db.one('select value from kv where key = $1', [key]);
  return row ? row.value : null;
}

export async function kvSet(db, key, value) {
  await db.query(
    `insert into kv (key, value) values ($1, $2)
     on conflict (key) do update set value = excluded.value, updated_at = now()`,
    [key, String(value)],
  );
}
