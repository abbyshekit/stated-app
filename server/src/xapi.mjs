import { kvSet } from './db.mjs';
import { open, seal } from './crypto.mjs';

export const SIGNIN_SCOPES = ['tweet.read', 'users.read'];
export const BOT_SCOPES = ['tweet.read', 'tweet.write', 'users.read', 'offline.access'];
export const BOT_DM_SCOPES = ['dm.read', 'dm.write'];

// Legacy field names. The live API accepted these on 2026-11-06 although the
// OpenAPI spec lists renamed ones; assertShape fails loudly on a rename.
const TWEET_FIELDS = [
  'author_id',
  'created_at',
  'conversation_id',
  'referenced_tweets',
  'entities',
  'note_tweet',
  'in_reply_to_user_id',
  'edit_history_tweet_ids',
  'display_text_range',
].join(',');
const USER_FIELDS = 'username,name,protected,profile_image_url';
const EXPANSIONS = 'author_id,referenced_tweets.id,referenced_tweets.id.author_id';

export class XError extends Error {
  constructor(status, body, where) {
    const detail = typeof body === 'string' ? body : JSON.stringify(body);
    super(`X API ${where} returned ${status}: ${detail.slice(0, 300)}`);
    this.name = 'XError';
    this.status = status;
    this.body = body;
  }
}

async function readBody(res) {
  const text = await res.text();
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

export function assertShape(page) {
  if (!page || typeof page !== 'object') throw new XError(0, 'empty response', 'shape');
  if (page.includes?.posts || (page.data || []).some((p) => p.referenced_posts || p.edit_history_post_ids)) {
    throw new XError(0, 'X renamed tweet fields to post fields; update xapi.mjs', 'shape');
  }
  for (const p of page.data || []) {
    if (!p.id || !p.author_id) throw new XError(0, `post without id or author_id: ${JSON.stringify(p).slice(0, 120)}`, 'shape');
  }
  return page;
}

export function authorizeUrl(config, { state, challenge, scopes }) {
  const url = new URL(config.x.authorizeUrl);
  url.searchParams.set('response_type', 'code');
  url.searchParams.set('client_id', config.x.clientId);
  url.searchParams.set('redirect_uri', config.x.redirectUri);
  url.searchParams.set('scope', scopes.join(' '));
  url.searchParams.set('state', state);
  url.searchParams.set('code_challenge', challenge);
  url.searchParams.set('code_challenge_method', 'S256');
  return url.toString();
}

function tokenHeaders(config) {
  const headers = { 'content-type': 'application/x-www-form-urlencoded' };
  if (config.x.clientSecret) {
    const basic = Buffer.from(`${config.x.clientId}:${config.x.clientSecret}`).toString('base64');
    headers.authorization = `Basic ${basic}`;
  }
  return headers;
}

async function tokenRequest(config, params, fetchImpl) {
  const body = new URLSearchParams({ client_id: config.x.clientId, ...params });
  const res = await fetchImpl(`${config.x.apiBase}/2/oauth2/token`, {
    method: 'POST',
    headers: tokenHeaders(config),
    body,
  });
  const data = await readBody(res);
  if (!res.ok) throw new XError(res.status, data, 'token');
  return {
    accessToken: data.access_token,
    refreshToken: data.refresh_token || null,
    expiresAt: data.expires_in ? new Date(Date.now() + Number(data.expires_in) * 1000) : null,
    scopes: data.scope || '',
  };
}

export function exchangeCode(config, { code, verifier }, fetchImpl = fetch) {
  return tokenRequest(config, {
    grant_type: 'authorization_code',
    code,
    redirect_uri: config.x.redirectUri,
    code_verifier: verifier,
  }, fetchImpl);
}

export function refreshToken(config, refresh, fetchImpl = fetch) {
  return tokenRequest(config, { grant_type: 'refresh_token', refresh_token: refresh }, fetchImpl);
}

export async function getMe(config, accessToken, fetchImpl = fetch) {
  const res = await fetchImpl(`${config.x.apiBase}/2/users/me?user.fields=${USER_FIELDS}`, {
    headers: { authorization: `Bearer ${accessToken}` },
  });
  const data = await readBody(res);
  if (!res.ok) throw new XError(res.status, data, 'users/me');
  return data.data;
}

export async function saveBotCredentials(db, config, { user, tokens }) {
  await db.query(
    `insert into bot_credentials (id, x_user_id, x_username, access_token, refresh_token, expires_at, scopes, updated_at)
     values (1, $1, $2, $3, $4, $5, $6, now())
     on conflict (id) do update set
       x_user_id = excluded.x_user_id, x_username = excluded.x_username,
       access_token = excluded.access_token, refresh_token = excluded.refresh_token,
       expires_at = excluded.expires_at, scopes = excluded.scopes, updated_at = now()`,
    [
      user.id,
      user.username,
      seal(tokens.accessToken, config.tokenKey),
      tokens.refreshToken ? seal(tokens.refreshToken, config.tokenKey) : null,
      tokens.expiresAt,
      tokens.scopes,
    ],
  );
  await kvSet(db, 'bot_status', 'connected');
}

function decode(row, config) {
  return {
    userId: row.x_user_id,
    username: row.x_username,
    accessToken: open(row.access_token, config.tokenKey),
    refreshToken: row.refresh_token ? open(row.refresh_token, config.tokenKey) : null,
    expiresAt: row.expires_at ? new Date(row.expires_at) : null,
    scopes: row.scopes || '',
    version: new Date(row.updated_at).getTime(),
  };
}

// Refresh tokens are single-use. The worker and the CLI are separate
// processes, so the refresh runs under a row lock: whoever takes the lock
// second sees the newer row and uses it instead of spending the old token.
export function botClient(db, config, fetchImpl = fetch) {
  let cached = null;

  async function load() {
    const row = await db.one('select * from bot_credentials where id = 1');
    if (!row) throw new Error('The bot account is not connected. Run: node server/src/cli.mjs bot-auth');
    cached = decode(row, config);
    return cached;
  }

  async function refresh(seenVersion) {
    const next = await db.tx(async (tx) => {
      const row = await tx.one('select * from bot_credentials where id = 1 for update');
      if (!row) throw new Error('The bot account is not connected.');
      const current = decode(row, config);
      if (current.version !== seenVersion && current.expiresAt && current.expiresAt.getTime() - Date.now() > 60_000) {
        return current;
      }
      if (!current.refreshToken) throw new Error('The bot token expired and has no refresh token. Run bot-auth again.');
      let tokens;
      try {
        tokens = await refreshToken(config, current.refreshToken, fetchImpl);
      } catch (err) {
        if (err.status === 400 || err.status === 401) {
          await tx.query(`insert into kv (key, value) values ('bot_status', 'disconnected') on conflict (key) do update set value = 'disconnected', updated_at = now()`);
        }
        throw err;
      }
      const updated = await tx.one(
        `update bot_credentials set access_token = $1, refresh_token = $2, expires_at = $3,
           scopes = coalesce(nullif($4, ''), scopes), updated_at = clock_timestamp()
         where id = 1 returning *`,
        [
          seal(tokens.accessToken, config.tokenKey),
          seal(tokens.refreshToken || current.refreshToken, config.tokenKey),
          tokens.expiresAt,
          tokens.scopes,
        ],
      );
      return decode(updated, config);
    });
    cached = next;
    return next;
  }

  async function token() {
    const current = cached || await load();
    if (current.expiresAt && current.expiresAt.getTime() - Date.now() < 60_000) return (await refresh(current.version)).accessToken;
    return current.accessToken;
  }

  async function call(path, { method = 'GET', body } = {}, retried = false) {
    const res = await fetchImpl(`${config.x.apiBase}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${await token()}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      body: body ? JSON.stringify(body) : undefined,
    });
    if (res.status === 401 && !retried) {
      await refresh(cached?.version);
      return call(path, { method, body }, true);
    }
    const data = await readBody(res);
    if (!res.ok) {
      const err = new XError(res.status, data, `${method} ${path.split('?')[0]}`);
      err.resetAt = res.headers.get('x-rate-limit-reset');
      throw err;
    }
    return data;
  }

  return {
    async identity() {
      const current = cached || await load();
      return { userId: current.userId, username: current.username, scopes: current.scopes };
    },
    async mentions({ sinceId, paginationToken, maxResults = 100 } = {}) {
      const { userId } = await this.identity();
      const params = new URLSearchParams({
        max_results: String(Math.max(5, maxResults)),
        'tweet.fields': TWEET_FIELDS,
        'user.fields': USER_FIELDS,
        expansions: EXPANSIONS,
      });
      if (sinceId) params.set('since_id', sinceId);
      if (paginationToken) params.set('pagination_token', paginationToken);
      return assertShape(await call(`/2/users/${userId}/mentions?${params}`));
    },
    async posts(ids, { fields = TWEET_FIELDS, expansions = 'author_id', userFields = USER_FIELDS } = {}) {
      const params = new URLSearchParams({
        ids: ids.join(','),
        'tweet.fields': fields,
      });
      if (expansions) {
        params.set('expansions', expansions);
        if (userFields) params.set('user.fields', userFields);
      }
      return assertShape(await call(`/2/tweets?${params}`));
    },
    async reply({ text, inReplyTo, exclude = [] }) {
      const reply = { in_reply_to_tweet_id: inReplyTo };
      if (exclude.length) reply.exclude_reply_user_ids = exclude;
      const data = await call('/2/tweets', { method: 'POST', body: { text, reply } });
      return data.data;
    },
    async sendDm({ to, text }) {
      const data = await call(`/2/dm_conversations/with/${to}/messages`, { method: 'POST', body: { text } });
      return data.data;
    },
    async dmEvents({ paginationToken } = {}) {
      const params = new URLSearchParams({
        event_types: 'MessageCreate',
        'dm_event.fields': 'id,text,sender_id,created_at,entities,event_type',
        max_results: '100',
      });
      if (paginationToken) params.set('pagination_token', paginationToken);
      return call(`/2/dm_events?${params}`);
    },
  };
}

export function postText(post) {
  return post?.note_tweet?.text || post?.text || '';
}

export function postUrl(username, id) {
  return `https://x.com/${username || 'i/web'}/status/${id}`;
}

export function displaySourceUrl(source, simulatedOrigin, original = source.source_url) {
  if (!simulatedOrigin || source.platform !== 'x' || !original) return original;
  return source.platform_id ? `${simulatedOrigin}/?c=${encodeURIComponent(source.platform_id)}` : `${simulatedOrigin}/`;
}

// Whether X's errors say this post is gone for good: not found (deleted),
// suspended, or not authorised (protected). Any other omission is transient.
export function goneOnX(errors, id) {
  const e = (errors || []).find((err) => String(err.resource_id ?? err.value ?? '') === String(id));
  return Boolean(e && /not found|authoriz|forbidden|suspend/i.test(`${e.title} ${e.detail || ''} ${e.type || ''}`));
}

// Null only when X says the post is not there (deleted, suspended,
// protected). A rate limit, a 5xx or a network failure throws, so the caller
// retries instead of telling someone their post is gone.
export function postFetcher(x) {
  return async (id) => {
    const data = await x.posts([id]);
    const post = data.data?.[0];
    if (post) {
      const author = (data.includes?.users || []).find((u) => u.id === post.author_id) || null;
      if (author?.protected) return null;
      return { post, author };
    }
    const errors = data.errors || [];
    if (!errors.length || errors.some((e) => /not found|authoriz|forbidden|suspend/i.test(`${e.title} ${e.detail || ''} ${e.type || ''}`))) return null;
    const err = new XError(503, errors, `post ${id}`);
    throw err;
  };
}

// A reply carries the replied-to handles as a hidden prefix. Only a mention
// inside the visible text is a request to the bot; being in the thread is not.
export function explicitlyMentions(post, botUsername) {
  if (!botUsername) return true;
  const text = String(post?.text || '');
  const re = new RegExp(`@${botUsername}\\b`, 'gi');
  const range = post?.display_text_range;
  if (Array.isArray(range) && range.length === 2) {
    for (const m of text.matchAll(re)) if (m.index >= range[0] && m.index < range[1]) return true;
    return false;
  }
  if (!post?.in_reply_to_user_id) return re.test(text);
  const prefix = text.match(/^(?:\s*@\w{1,15})+/)?.[0] || '';
  return re.test(text.slice(prefix.length));
}
