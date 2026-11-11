import { startBotAuth } from './botauth.mjs';
import { loadConfig, requireConfig } from './config.mjs';
import { createDb } from './db.mjs';
import { processMention, sendPendingReplies } from './intake.mjs';
import { metrics } from './metrics.mjs';
import { syncNearBets } from './near-worker.mjs';
import { ensureDesk } from './store.mjs';
import { postFetcher, tick } from './worker.mjs';
import { botClient } from './xapi.mjs';
import { applyTextPolicy } from './xtext.mjs';

const [command, ...args] = process.argv.slice(2);
const config = loadConfig();
requireConfig(config, ['databaseUrl']);
const db = createDb(config.databaseUrl);

async function main() {
  await db.migrate();
  await ensureDesk(db);
  const policy = await applyTextPolicy(db, config);
  if (command === 'migrate') {
    console.log('Schema is current.');
    if (policy.dropped || policy.inbox) console.log(`Text policy applied: words dropped for ${policy.dropped} private X posts, ${policy.inbox} inbox items rewritten.`);
  } else if (command === 'near-sync') {
    requireConfig(config, ['nearContract']);
    const result = await syncNearBets(db, config);
    console.log(JSON.stringify(result));
    if (result.errors) process.exitCode = 1;
  } else if (command === 'bot-auth') {
    requireConfig(config, ['x.clientId', 'tokenKey']);
    const url = await startBotAuth(db, config);
    console.log('Sign in to X as the bot account, open this link, and approve.');
    console.log(`The server must be running at ${config.x.redirectUri}.`);
    const current = await db.one('select x_user_id, x_username from bot_credentials where id = 1');
    if (config.x.botUserId) console.log(`Only X user ${config.x.botUserId} (X_BOT_USER_ID) can approve it.`);
    else if (current) console.log(`Only the connected bot, @${current.x_username} (${current.x_user_id}), can approve it. Set X_BOT_USER_ID to connect a different account.`);
    else console.log('No bot is connected and X_BOT_USER_ID is not set, so the first X account to approve this link becomes the bot. Set X_BOT_USER_ID to the bot\'s numeric ID to prevent that.');
    console.log(url);
  } else if (command === 'whoami') {
    console.log(JSON.stringify(await botClient(db, config).identity()));
  } else if (command === 'tick') {
    const summary = await tick(db, config, botClient(db, config), { sourceCheck: args.includes('--sources') });
    console.log(JSON.stringify(summary, null, 2));
  } else if (command === 'replay') {
    const id = args[0];
    const row = await db.one('select payload from mention_events where event_id = $1', [id]);
    if (!row?.payload) throw new Error(`No stored mention ${id}.`);
    const x = botClient(db, config);
    const result = await processMention(db, config, {
      mention: row.payload.mention,
      includes: row.payload.includes,
      bot: await x.identity(),
      fetchPost: postFetcher(x),
    });
    const sent = await sendPendingReplies(db, x);
    const saves = await db.one('select count(*)::int as n from saves where origin_event_id = $1', [id]);
    console.log(JSON.stringify({ outcome: result.outcome, newReplies: sent.length, savesForEvent: saves.n }));
  } else if (command === 'verify-tag') {
    // Evidence for one real tag: event, owner, source, collection, reply;
    // then a replay that must change nothing. Exit code 1 if any check fails.
    const [id, ...rest] = args;
    const opt = (name) => rest[rest.indexOf(`--${name}`) + 1] && rest.includes(`--${name}`) ? rest[rest.indexOf(`--${name}`) + 1] : null;
    if (!id) throw new Error('Usage: verify-tag <mention-id> --owner <x-user-id> --source <post-id> --relation mine|following');
    const event = await db.one('select * from mention_events where event_id = $1', [id]);
    const save = event?.save_id ? await db.one(
      `select s.*, src.platform_id as source_post, st.speaker, st.speaker_x_user_id from saves s
       join statements st on st.id = s.statement_id join sources src on src.id = st.source_id where s.id = $1`,
      [event.save_id],
    ) : null;
    const before = {
      saves: (await db.one('select count(*)::int as n from saves where origin_event_id = $1', [id])).n,
      replies: (await db.one(`select count(*)::int as n from mention_events where event_id = $1 and reply_status = 'sent'`, [id])).n,
    };
    const x = botClient(db, config);
    const replay = event?.payload ? await processMention(db, config, {
      mention: event.payload.mention, includes: event.payload.includes, bot: await x.identity(), fetchPost: postFetcher(x),
    }) : null;
    const sent = await sendPendingReplies(db, x);
    const after = {
      saves: (await db.one('select count(*)::int as n from saves where origin_event_id = $1', [id])).n,
      replyPostId: (await db.one('select reply_post_id from mention_events where event_id = $1', [id]))?.reply_post_id || null,
    };
    const checks = [
      ['event received', Boolean(event)],
      ['event saved', event?.outcome === 'saved'],
      ['owner is the tagger', Boolean(save) && (!opt('owner') || save.owner_x_user_id === opt('owner'))],
      ['source is the tagged post', Boolean(save) && (!opt('source') || save.source_post === opt('source'))],
      ['collection', Boolean(save) && (!opt('relation') || save.relation === opt('relation'))],
      ['exactly one save', after.saves === 1],
      ['replay is a replay', replay?.outcome === 'replay'],
      ['replay adds no save', after.saves === before.saves],
      ['replay adds no reply', sent.length === 0],
    ];
    const result = {
      mention: id,
      event: event && { outcome: event.outcome, author: event.author_x_user_id, replyStatus: event.reply_status, replyPostId: after.replyPostId, replyError: event.reply_error },
      save: save && { id: save.id, owner: save.owner_x_user_id, relation: save.relation, visibility: save.visibility, sourcePost: save.source_post, speaker: save.speaker },
      checks: Object.fromEntries(checks),
      pass: checks.every(([, ok]) => ok),
    };
    console.log(JSON.stringify(result, null, 2));
    if (!result.pass) process.exitCode = 1;
  } else if (command === 'metrics') {
    console.log(JSON.stringify(await metrics(db, { exclude: config.excludeXIds }), null, 2));
  } else {
    console.log('Usage: node server/src/cli.mjs <migrate|near-sync|bot-auth|whoami|tick [--sources]|replay <mention-id>|verify-tag <mention-id> [--owner id --source id --relation mine|following]|metrics>');
    process.exitCode = 1;
  }
}

main()
  .catch((err) => {
    console.error(err.message);
    process.exitCode = 1;
  })
  .finally(() => db.close());
