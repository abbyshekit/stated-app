// Publishes reviewed desk records from a list of public articles. Each
// article is fetched live through the product's own intake; each pick names
// a sentence by a substring and gives the reviewer's attribution. A pick may
// carry reviewed terms, be marked backfill, and record an outcome that is
// already known, with its evidence. Re-running publishes nothing twice. A
// pick the extractor did not offer is reported, not invented.
//
// Only public https pages are accepted, so a local test fixture can never be
// published as a real record. The target database must hold no person
// accounts and no desk records from local or non-https pages. Every check
// runs before the database is changed, and none can be switched off.
//
//   DATABASE_URL=... node server/dev/seed-desk.mjs desk/launch.json

import { readFileSync } from 'node:fs';
import { checkUrl, editorialIntake, selectCandidates } from '../src/articles.mjs';
import { loadConfig, requireConfig } from '../src/config.mjs';
import { createDb } from '../src/db.mjs';
import { resolveStatement } from '../src/notify.mjs';
import { ensureDesk, reviewerSetTerms } from '../src/store.mjs';

const file = process.argv[2] || 'desk/launch.json';
const plan = JSON.parse(readFileSync(file, 'utf8'));
const config = loadConfig({ ...process.env, STATED_FETCH_ALLOW_LOOPBACK: '' });
requireConfig(config, ['databaseUrl']);
for (const article of plan.articles) {
  if (!/^https:\/\//.test(article.url)) throw new Error(`Not a public https page: ${article.url}`);
  try {
    checkUrl(article.url, { allowLoopback: false });
  } catch (err) {
    throw new Error(`Not a public https page: ${article.url} (${err.message})`);
  }
}
const db = createDb(config.databaseUrl);
const migrated = await db.one(`select to_regclass('public.users') is not null as yes`);
if (migrated.yes) {
  const people = await db.one(`select count(*)::int as n from users where kind = 'person'`);
  const fixtures = await db.one(
    `select count(*)::int as n from saves s join users u on u.id = s.owner_user_id
     join statements st on st.id = s.statement_id join sources src on src.id = st.source_id
     where u.kind = 'editorial' and (src.url !~ '^https://' or src.url ~* '^https?://(localhost|127\\.|\\[::1\\]|0\\.0\\.0\\.0)'
       or coalesce(src.title, '') ilike '%test fixture%')`,
  );
  if (people.n > 0 || fixtures.n > 0) {
    await db.close();
    throw new Error(`Refused: this database holds ${people.n} person accounts and ${fixtures.n} desk records from local or test pages. Seed the real desk into a database without test fixtures.`);
  }
}
await db.migrate();
const desk = await ensureDesk(db);

// The desk lists newest first, so articles are published last to first and
// the desk reads in the file's order.
const report = [];
for (const article of [...plan.articles].reverse()) {
  const intake = await editorialIntake(db, config, article.url, { backfill: Boolean(article.backfill) });
  if (intake.status !== 'fetched') {
    report.unshift({ lane: article.lane, url: article.url, status: intake.status, error: intake.error });
    continue;
  }
  const found = new Map();
  const missing = [];
  for (const pick of article.picks) {
    const candidate = intake.candidates.find((c) => c.text.includes(pick.match));
    if (candidate) found.set(pick, candidate);
    else missing.push(pick.match);
  }
  const overrides = {};
  for (const [pick, candidate] of found) {
    overrides[candidate.index] = { speaker: pick.speaker, reportedSpeech: Boolean(pick.quoted), backfill: Boolean(pick.backfill) };
  }
  const saves = found.size
    ? await selectCandidates(db, {
      ownerXUserId: desk.x_user_id,
      intakeId: intake.id,
      indexes: [...found.values()].map((c) => c.index),
      editorial: true,
      overrides,
    })
    : [];
  const records = [];
  for (const [pick, candidate] of found) {
    const statement = await db.one(
      'select id, terms_confirmed_by, status from statements where source_id = $1 and span = $2',
      [intake.source_id, candidate.text],
    );
    if (pick.terms && !statement.terms_confirmed_by) {
      await reviewerSetTerms(db, null, statement.id, {
        deadlineAt: pick.terms.deadline ? `${pick.terms.deadline}T23:59:59Z` : null,
        probability: pick.terms.probability ?? '',
        condition: pick.terms.condition ?? '',
        note: pick.terms.note,
      });
    }
    if (pick.outcome) {
      await resolveStatement(db, {
        statementId: statement.id,
        outcome: pick.outcome.result,
        url: plan.outcomeSources?.[pick.outcome.source] || pick.outcome.source,
        note: pick.outcome.note,
        reviewer: null,
        outcomeAt: `${pick.outcome.knownOn}T00:00:00Z`,
      });
    }
    const save = await db.one('select id, capture from saves where statement_id = $1 and owner_user_id = $2', [statement.id, desk.id]);
    records.push({
      save: save.id,
      speaker: pick.speaker,
      capture: save.capture,
      outcome: pick.outcome?.result || 'open',
      extractedSpeaker: candidate.speaker || null,
      sentence: candidate.text.slice(0, 160),
    });
  }
  report.unshift({
    lane: article.lane,
    url: article.url,
    status: 'fetched',
    candidates: intake.candidates.length,
    published: saves.map((s) => s.id),
    records,
    notOffered: missing,
  });
}

console.log(JSON.stringify({ subject: plan.subject, seededAt: new Date().toISOString(), report }, null, 2));
await db.close();
