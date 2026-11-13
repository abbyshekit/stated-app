import { assertHostedConfig, assertNetworkConfig, botOwnershipLine, loadConfig, requireConfig } from './config.mjs';
import { createDb } from './db.mjs';
import { ensureDesk } from './store.mjs';
import { createApp } from './web.mjs';
import { createServer } from './http-server.mjs';
import { startWorker } from './worker.mjs';
import { startNearWorker } from './near-worker.mjs';
import { startPlayWorker } from './reply-bets.mjs';
import { assertDatabaseNetwork } from './play.mjs';
import { botClient } from './xapi.mjs';
import { applyTextPolicy } from './xtext.mjs';

const config = loadConfig();
requireConfig(config, ['databaseUrl', 'tokenKey', 'x.clientId']);
try {
  assertHostedConfig(config);
  assertNetworkConfig(config);
} catch (error) {
  // One readable message, then a failed start: the platform keeps the last good deploy.
  console.error(error.message);
  process.exit(1);
}

const db = createDb(config.databaseUrl);
await db.migrate();
try {
  await assertDatabaseNetwork(db, config);
} catch (error) {
  console.error(error.message);
  process.exit(1);
}
await ensureDesk(db);
await applyTextPolicy(db, config);

const handler = createApp({ db, config });
const server = createServer(handler);
// Last resort: a stray rejection is logged rather than ending the process for every user.
process.on('unhandledRejection', (reason) => console.error('[unhandled rejection]', reason?.stack || reason));
server.listen(config.port, () => {
  console.log(`Stated on ${config.baseUrl} (port ${config.port})`);
});

let stopWorker = null;
console.log(botOwnershipLine(config));
const stopNearWorker = config.nearContract ? startNearWorker(db, config, {
  onError: (error) => console.error('[near]', error.message),
}) : null;
const botName = async () => (await db.one('select x_username from bot_credentials where id = 1'))?.x_username;
const stopPlayWorker = config.play.enabled ? startPlayWorker(db, config, {
  botUsername: botName, onError: (error) => console.error('[play]', error.message),
}) : null;
if (config.worker.enabled) {
  stopWorker = startWorker(db, config, botClient(db, config));
  console.log(`Worker polling mentions every ${Math.round(config.worker.pollMs / 1000)}s`);
} else {
  console.log('X worker off: no mention polling, source checks or text fills (STATED_WORKER=1 turns it on).');
}
if (config.near.real) console.log(`NEAR MAINNET: stakes are real NEAR. Betting is open to ${config.play.pilotXIds.includes('*') ? 'anyone' : `${config.play.pilotXIds.length} listed X accounts`}. Payments from other chains ${config.intents.deposits ? 'on' : 'off'}.`);
console.log(`NEAR refresher ${stopNearWorker ? `on for ${config.nearContract}` : 'off'}. Bets from replies ${stopPlayWorker ? 'on' : 'off'}. Replies ${config.x.repliesEnabled ? 'on' : 'off'}. DMs ${config.x.dmEnabled ? 'on' : 'off'}.`);

// A platform stop (SIGTERM) lets requests in flight finish, then closes the
// pool. Anything still open after ten seconds is dropped so a deploy never hangs.
let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  if (stopWorker) stopWorker();
  if (stopNearWorker) stopNearWorker();
  if (stopPlayWorker) stopPlayWorker();
  const force = setTimeout(() => server.closeAllConnections(), 10000);
  force.unref();
  await new Promise((resolve) => {
    server.close(() => resolve());
    server.closeIdleConnections();
  });
  clearTimeout(force);
  await db.close();
  process.exit(0);
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
