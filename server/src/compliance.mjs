// Daily deletion compliance. X treats a stored post ID as X Content, so a
// delete result removes the ID, not only the words. Batch jobs need an
// app-only bearer token. Without one, or if X says the app is not enrolled,
// the caller keeps the weekly per-post lookup.

import { scrubSource } from './notify.mjs';

async function readJson(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return { raw: text };
  }
}

async function job(config, fetchImpl, type, ids) {
  const created = await fetchImpl(`${config.x.apiBase}/2/compliance/jobs`, {
    method: 'POST',
    headers: {
      authorization: `Bearer ${config.x.complianceBearer}`,
      'content-type': 'application/json',
    },
    body: JSON.stringify({ type, name: `stated-${type}` }),
  });
  const body = await readJson(created);
  if (created.status === 403) {
    const err = new Error('App not enrolled');
    err.status = 403;
    throw err;
  }
  if (!created.ok) throw new Error(`Compliance job failed (${created.status}).`);
  const upload = await fetchImpl(body.data.upload_url, {
    method: 'PUT',
    headers: { 'content-type': 'text/plain' },
    body: `${ids.join('\n')}\n`,
  });
  if (!upload.ok && upload.status !== 204) throw new Error(`Compliance upload failed (${upload.status}).`);
  let download = body.data.download_url;
  for (let i = 0; i < 5 && !download; i += 1) {
    const status = await fetchImpl(`${config.x.apiBase}/2/compliance/jobs/${body.data.id}`, {
      headers: { authorization: `Bearer ${config.x.complianceBearer}` },
    });
    const row = await readJson(status);
    if (row.data?.status === 'complete' || row.data?.download_url) download = row.data.download_url;
  }
  if (!download) throw new Error('Compliance job did not finish.');
  const file = await fetchImpl(download);
  const payload = await readJson(file);
  const rows = Array.isArray(payload) ? payload : (payload.data || []);
  const ofAction = (action) => rows.filter((row) => row.action === action).map((row) => String(row.id));
  return { deleted: ofAction('delete'), rehydrate: ofAction('rehydrate') };
}

async function erase(db, source) {
  await db.tx(async (tx) => {
    await scrubSource(tx, source.id, source.platform_id, 'deleted on X');
    await tx.query(
      `update sources set platform_id = $2, url = '', author_username = null, author_name = null,
         author_x_user_id = null, published_at = null where id = $1`,
      [source.id, `removed-${source.id}`],
    );
    await tx.query(`delete from author_commitments where platform = 'x' and platform_id = $1`, [source.platform_id]);
    await tx.query(
      `update public_withdrawals set dedupe_key = 'erased-' || id::text where dedupe_key = $1`,
      [`x:${source.platform_id}`],
    );
    await tx.query(
      `update inbox set body = 'The original post was deleted on X.'
       where statement_id in (select id from statements where source_id = $1)`,
      [source.id],
    );
  });
}

export async function runCompliance(db, config, fetchImpl = fetch) {
  if (!config.x.complianceBearer) return { mode: 'unavailable' };
  const posts = await db.many(`select id, platform_id, author_x_user_id from sources where platform = 'x' and available and platform_id not like 'removed-%'`);
  const users = await db.many(`select distinct author_x_user_id as id from sources where platform = 'x' and available and author_x_user_id is not null`);
  let deletedPosts = [];
  let deletedUsers = [];
  let rehydrate = [];
  try {
    if (posts.length) {
      const tweets = await job(config, fetchImpl, 'tweets', posts.map((p) => p.platform_id));
      deletedPosts = tweets.deleted;
      rehydrate = tweets.rehydrate;
    }
    if (users.length) deletedUsers = (await job(config, fetchImpl, 'users', users.map((u) => u.id))).deleted;
  } catch (err) {
    if (err.status === 403) return { mode: 'fallback' };
    throw err;
  }
  const gonePosts = new Set(deletedPosts);
  const goneUsers = new Set(deletedUsers);
  const targets = posts.filter((p) => gonePosts.has(p.platform_id) || goneUsers.has(p.author_x_user_id));
  for (const source of targets) {
    const full = await db.one('select * from sources where id = $1', [source.id]);
    if (full && full.available) await erase(db, full);
  }
  return { mode: 'batch', deletedPosts: deletedPosts.length, deletedUsers: deletedUsers.length, erased: targets.length, rehydrate };
}
