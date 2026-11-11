import { pkcePair, token } from './crypto.mjs';
import { authorizeUrl, BOT_DM_SCOPES, BOT_SCOPES } from './xapi.mjs';

// The bot account authorizes the same app through the server's /callback.
// Only a state created here can store bot credentials.
export async function startBotAuth(db, config) {
  const { verifier, challenge } = pkcePair();
  const state = token(24);
  await db.query(
    `insert into oauth_states (state, code_verifier, purpose) values ($1, $2, 'bot')`,
    [state, verifier],
  );
  const scopes = config.x.dmEnabled ? [...BOT_SCOPES, ...BOT_DM_SCOPES] : BOT_SCOPES;
  return authorizeUrl(config, { state, challenge, scopes });
}
