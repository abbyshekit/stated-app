// Operator-only repair of a missing extraction. Input is a fresh observation
// of one original X post, passed on stdin. No X requests or text persistence.
import { pathToFileURL } from 'node:url';
import { createDb } from '../server/src/db.mjs';
import { readTerms, xClaimText } from '../server/src/xtext.mjs';

export async function repairMissingXDeadline(db, input) {
  const { saveId, sourcePostId, sourceUrl, text } = input || {};
  if (![saveId, sourcePostId].every((id) => typeof id === 'string' && /^\d{1,25}$/.test(id))
    || typeof text !== 'string' || !text.trim() || text.length > 64_000
    || typeof sourceUrl !== 'string' || sourceUrl.length > 300) throw new Error('Invalid source observation.');
  const match = sourceUrl.match(/^https:\/\/x\.com\/[A-Za-z0-9_]{1,15}\/status\/(\d{1,25})$/);
  if (match?.[1] !== sourcePostId) throw new Error('The observation URL does not match the source post.');
  return db.tx(async (tx) => {
    const row = await tx.one(
      `select s.*, st.id as statement_id, st.proposed_deadline_at, st.deadline_at, st.deadline_text,
         st.terms_confirmed_by, st.terms_confirmed_at, st.status, st.span, st.capture as statement_capture,
         st.outcome_at, src.platform, src.platform_id, src.author_x_user_id, src.available,
         src.author_protected, src.text as source_text, src.published_at
       from saves s join statements st on st.id = s.statement_id join sources src on src.id = st.source_id
       where s.id = $1 and src.platform_id = $2 for update of s, st, src`,
      [saveId, sourcePostId],
    );
    if (!row || row.platform !== 'x' || !row.available || row.author_protected
      || row.visibility !== 'private' || row.relation !== 'mine' || row.intake !== 'mention'
      || row.owner_x_user_id !== row.author_x_user_id || !row.published_at
      || row.source_text !== '' || row.span !== `X post ${sourcePostId}` || row.deadline_text !== null
      || row.status !== 'open' || row.outcome_at || row.deadline_at || row.terms_confirmed_by || row.terms_confirmed_at
      || row.author_confirmed_at || row.author_deadline_at || row.author_committed_deadline_at
      || row.capture !== 'prospective' || row.statement_capture !== 'prospective') {
      throw new Error('This save is not eligible for a missing-deadline repair.');
    }
    const other = await tx.one('select id from saves where statement_id = $1 and id <> $2 limit 1', [row.statement_id, saveId]);
    const committed = await tx.one('select owner_x_user_id from author_commitments where statement_id = $1 limit 1', [row.statement_id]);
    if (other || committed) throw new Error('The prediction has shared or committed terms.');
    const { proposedDeadlineAt } = readTerms(xClaimText(text), row.published_at, { keepWords: false });
    if (!proposedDeadlineAt || proposedDeadlineAt <= new Date(row.created_at)) {
      throw new Error('The observation does not yield a deadline after capture.');
    }
    const result = { saveId, sourcePostId, proposedDeadlineAt: proposedDeadlineAt.toISOString(), changed: false };
    if (row.proposed_deadline_at) {
      if (new Date(row.proposed_deadline_at).getTime() === proposedDeadlineAt.getTime()) return result;
      throw new Error('The prediction already has a different deadline reading.');
    }
    await tx.query('update statements set proposed_deadline_at = $2 where id = $1', [row.statement_id, proposedDeadlineAt]);
    await tx.query(
      `insert into revisions (statement_id, save_id, kind, actor, before, after, note)
       values ($1, $2, 'terms_reparsed', 'system', $3, $4, $5)`,
      [row.statement_id, saveId, { proposedDeadlineAt: null }, { proposedDeadlineAt },
        'The deadline read from the original post was corrected. It remains unconfirmed by the author.'],
    );
    return { ...result, changed: true };
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let db;
  try {
    let input = '';
    for await (const chunk of process.stdin) {
      input += chunk;
      if (input.length > 66_000) throw new Error('Source observation exceeds the input limit.');
    }
    const observation = JSON.parse(input);
    db = createDb(process.env.DATABASE_URL);
    console.log(JSON.stringify(await repairMissingXDeadline(db, observation)));
  } catch {
    console.error('Deadline repair failed. Check the source observation and save eligibility.');
    process.exitCode = 1;
  } finally {
    await db?.close();
  }
}
