// INTEGRATION: call pollMentionDiscovery(db, x, { baselineId, processMention })
// before advancing the ordinary mentions cursor. x.searchMentions accepts
// { sinceId, paginationToken, maxResults }; processMention receives (post, includes)
// and must use the ordinary idempotent intake path. Search state contains no text.
import { kvGet, kvSet } from './db.mjs';

const KEY = 'mention_discovery_state';
const INTERVAL_MS = 120_000;
const X_EPOCH = 1_288_834_974_657n;
const validId = (id) => typeof id === 'string' && /^[0-9]{1,20}$/.test(id);

function baselineNow(now) {
  return ((BigInt(now) - X_EPOCH) << 22n).toString();
}

function laterId(a, b) {
  return validId(b) && BigInt(b) > BigInt(a || '0') ? b : a;
}

// The transaction lock spans the request and processing, so concurrent workers
// cannot fetch the same page or overwrite its pagination state. A failed page is
// retried from the same cursor; intake must therefore be idempotent.
export async function pollMentionDiscovery(db, x, { baselineId, includeRecentBacklog = false, processMention, now = Date.now() }) {
  try {
    return await db.tx(async (tx) => {
      const lock = await tx.one('select pg_try_advisory_xact_lock(hashtextextended($1, 0)) as locked', [KEY]);
      if (!lock?.locked) return { status: 'busy' };
      const saved = await kvGet(tx, KEY);
      let state;
      if (saved) {
        state = JSON.parse(saved);
        if ((state.sinceId !== null && !validId(state.sinceId)) || !Number.isSafeInteger(state.lastAttempt)
          || (state.nextToken != null && (typeof state.nextToken !== 'string' || state.nextToken.length > 2048))
          || (state.newest != null && !validId(state.newest))) throw new Error('Invalid mention discovery state');
      } else {
        state = { sinceId: includeRecentBacklog ? null : validId(baselineId) ? baselineId : baselineNow(now), lastAttempt: 0 };
      }
      if (now - state.lastAttempt < INTERVAL_MS) return { status: 'throttled' };
      state.lastAttempt = now;
      // Persist the attempt even when the request or processing fails.
      await kvSet(tx, KEY, JSON.stringify(state));
      let page;
      try {
        page = await x.searchMentions({ sinceId: state.sinceId || undefined, paginationToken: state.nextToken || undefined, maxResults: 10 });
      } catch (error) {
        // X can expire pagination tokens. Restart the window without advancing it.
        if (state.nextToken && error?.status === 400) {
          delete state.nextToken;
          delete state.newest;
          await kvSet(tx, KEY, JSON.stringify(state));
        }
        return { status: 'search_error', httpStatus: Number.isInteger(error?.status) ? error.status : null };
      }
      const posts = page?.data || [];
      const token = page?.meta?.next_token;
      if (!Array.isArray(posts) || posts.length > 10 || posts.some((post) => !validId(post?.id))
        || (token != null && (typeof token !== 'string' || !token || token.length > 2048))) {
        return { status: 'invalid_page' };
      }
      try {
        for (const post of [...posts].sort((a, b) => BigInt(a.id) < BigInt(b.id) ? -1 : BigInt(a.id) > BigInt(b.id) ? 1 : 0)) {
          await processMention(post, page.includes || {});
        }
      } catch {
        return { status: 'processing_error' };
      }
      let newest = state.newest || state.sinceId;
      for (const post of posts) newest = laterId(newest, post.id);
      if (token) {
        state.nextToken = token;
        state.newest = newest;
      } else {
        state.sinceId = newest || baselineNow(now);
        delete state.nextToken;
        delete state.newest;
      }
      await kvSet(tx, KEY, JSON.stringify(state));
      return { status: 'ok', processed: posts.length, hasMore: Boolean(token) };
    });
  } catch {
    return { status: 'state_error' };
  }
}
