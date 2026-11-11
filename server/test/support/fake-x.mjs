// A test double for the parts of X API v2 that Stated calls. It speaks the
// same shapes: mentions with expansions, post lookup, post create with
// reply settings, OAuth 2.0 PKCE, users/me, DM events and DM send.
// It is for tests only; a connector counts as verified only against X.

import { createHash } from 'node:crypto';
import http from 'node:http';

export class FakeX {
  constructor() {
    this.users = new Map();
    this.posts = new Map();
    this.deleted = new Set();
    this.edited = new Set();
    this.created = [];
    this.dmsSent = [];
    this.dmEvents = [];
    this.calls = [];
    this.codes = new Map();
    this.tokens = new Map();
    this.nextId = 1900000000000000000n;
    this.consentAs = null;
    this.failDms = false;
    this.compliance403 = false;
    this.jobs = new Map();
    this.jobSeq = 0;
    this.server = null;
    this.base = '';
  }

  addUser(id, username, extra = {}) {
    const user = { id: String(id), username, name: extra.name || username, protected: Boolean(extra.protected) };
    this.users.set(user.id, user);
    return user;
  }

  tokenFor(userId) {
    const token = `tok-${userId}-${this.tokens.size}`;
    this.tokens.set(token, String(userId));
    return token;
  }

  // Like X, a reply's text starts with a hidden prefix of the handles already
  // in the conversation; display_text_range marks where the typed text begins.
  post(authorId, typed, { replyTo = null, quote = null, at = new Date(), noRange = false, exclude = [] } = {}) {
    this.nextId += 1000n;
    const id = String(this.nextId);
    let prefix = '';
    let inReplyToUserId;
    if (replyTo) {
      const parent = this.posts.get(replyTo);
      inReplyToUserId = parent?.author_id;
      const handles = [];
      const parentAuthor = this.users.get(inReplyToUserId);
      if (parentAuthor && parentAuthor.id !== String(authorId)) handles.push(parentAuthor.username);
      for (const m of parent?.entities?.mentions || []) {
        if (m.id !== String(authorId) && !handles.some((h) => h.toLowerCase() === m.username.toLowerCase())) handles.push(m.username);
      }
      const excluded = new Set(exclude.map((id) => this.users.get(String(id))?.username?.toLowerCase()).filter(Boolean));
      prefix = handles.filter((h) => !excluded.has(h.toLowerCase())).map((h) => `@${h} `).join('');
    }
    const text = prefix + typed;
    const mentions = [];
    for (const m of text.matchAll(/@(\w{1,15})/g)) {
      const user = [...this.users.values()].find((u) => u.username.toLowerCase() === m[1].toLowerCase());
      mentions.push({ start: m.index, end: m.index + m[0].length, username: m[1], ...(user ? { id: user.id } : {}) });
    }
    const urls = [];
    for (const m of text.matchAll(/https?:\/\/\S+/g)) {
      urls.push({ start: m.index, end: m.index + m[0].length, url: m[0], expanded_url: m[0], display_url: m[0] });
    }
    const refs = [];
    if (replyTo) refs.push({ type: 'replied_to', id: replyTo });
    if (quote) refs.push({ type: 'quoted', id: quote });
    const post = {
      id,
      text,
      author_id: String(authorId),
      created_at: new Date(at).toISOString(),
      conversation_id: replyTo ? this.posts.get(replyTo)?.conversation_id || replyTo : id,
      edit_history_tweet_ids: [id],
      ...(noRange ? {} : { display_text_range: [prefix.length, text.length] }),
      ...(refs.length ? { referenced_tweets: refs } : {}),
      ...(inReplyToUserId ? { in_reply_to_user_id: inReplyToUserId } : {}),
      entities: { ...(mentions.length ? { mentions } : {}), ...(urls.length ? { urls } : {}) },
    };
    this.posts.set(id, post);
    return post;
  }

  edit(id, typed) {
    const post = this.posts.get(id);
    post.text = typed;
    post.display_text_range = [0, typed.length];
  }

  includesFor(posts) {
    const users = new Map();
    const tweets = new Map();
    for (const post of posts) {
      const author = this.users.get(post.author_id);
      if (author) users.set(author.id, author);
      for (const ref of post.referenced_tweets || []) {
        const target = this.posts.get(ref.id);
        if (target && !this.deleted.has(ref.id)) {
          tweets.set(target.id, target);
          const ta = this.users.get(target.author_id);
          if (ta) users.set(ta.id, ta);
        }
      }
    }
    return { users: [...users.values()], tweets: [...tweets.values()] };
  }

  bearer(req) {
    const auth = String(req.headers.authorization || '');
    return this.tokens.get(auth.replace(/^Bearer\s+/i, '')) || null;
  }

  async start() {
    this.server = http.createServer((req, res) => this.handle(req, res).catch((err) => {
      res.writeHead(500);
      res.end(String(err.stack || err));
    }));
    await new Promise((resolve) => this.server.listen(0, '127.0.0.1', resolve));
    this.base = `http://127.0.0.1:${this.server.address().port}`;
    return this;
  }

  stop() {
    return new Promise((resolve) => this.server.close(resolve));
  }

  async body(req) {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    return Buffer.concat(chunks).toString('utf8');
  }

  send(res, status, data) {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(data));
  }

  async handle(req, res) {
    const url = new URL(req.url, this.base);
    const path = url.pathname;
    this.calls.push({ method: req.method, path, query: Object.fromEntries(url.searchParams) }); // test-evidence: allow

    if (req.method === 'GET' && path === '/i/oauth2/authorize/approve') {
      this.consentAs = url.searchParams.get('as');
      url.searchParams.delete('as');
      res.writeHead(302, { location: `/i/oauth2/authorize?${url.searchParams}` });
      return res.end();
    }

    if (req.method === 'GET' && path === '/i/oauth2/authorize' && !this.consentAs && this.interactive) {
      const options = [...this.users.values()]
        .filter((u) => !this.botIds?.has(u.id))
        .map((u) => {
          const q = new URLSearchParams(url.searchParams);
          q.set('as', u.id);
          return `<li><a href="/i/oauth2/authorize/approve?${q}">Authorize as @${u.username}</a></li>`;
        })
        .join('');
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      return res.end(`<!doctype html><meta name="viewport" content="width=device-width, initial-scale=1"><title>Simulated X sign-in</title>
        <body style="font-family: system-ui; max-width: 32rem; margin: 2rem auto; padding: 0 1rem">
        <h1>Simulated X sign-in</h1><p>This is the local test double, not x.com. Scopes requested: ${url.searchParams.get('scope')}</p>
        <ul>${options}</ul></body>`);
    }

    if (req.method === 'GET' && path === '/i/oauth2/authorize') {
      const userId = this.consentAs;
      if (this.interactive) this.consentAs = null;
      if (!userId) {
        res.writeHead(302, { location: `${url.searchParams.get('redirect_uri')}?error=access_denied&state=${url.searchParams.get('state')}` });
        return res.end();
      }
      const code = `code-${this.codes.size + 1}`;
      this.codes.set(code, {
        userId,
        challenge: url.searchParams.get('code_challenge'),
        redirectUri: url.searchParams.get('redirect_uri'),
        clientId: url.searchParams.get('client_id'),
        scope: url.searchParams.get('scope'),
      });
      res.writeHead(302, { location: `${url.searchParams.get('redirect_uri')}?code=${code}&state=${url.searchParams.get('state')}` });
      return res.end();
    }

    if (req.method === 'POST' && path === '/2/oauth2/token') {
      const form = new URLSearchParams(await this.body(req));
      if (form.get('grant_type') === 'authorization_code') {
        const entry = this.codes.get(form.get('code'));
        if (!entry) return this.send(res, 400, { error: 'invalid_request' });
        const challenge = createHash('sha256').update(form.get('code_verifier') || '').digest('base64url');
        if (challenge !== entry.challenge || form.get('redirect_uri') !== entry.redirectUri || form.get('client_id') !== entry.clientId) {
          return this.send(res, 400, { error: 'invalid_grant' });
        }
        this.codes.delete(form.get('code'));
        return this.send(res, 200, {
          token_type: 'bearer',
          access_token: this.tokenFor(entry.userId),
          refresh_token: `refresh-${entry.userId}-${Date.now()}`,
          expires_in: 7200,
          scope: entry.scope,
        });
      }
      if (form.get('grant_type') === 'refresh_token') {
        const presented = String(form.get('refresh_token') || '');
        const m = presented.match(/^refresh-(\w+)-/);
        if (!m || this.spentRefresh?.has(presented)) return this.send(res, 400, { error: 'invalid_grant' });
        this.spentRefresh = this.spentRefresh || new Set();
        this.spentRefresh.add(presented);
        this.refreshGrants = (this.refreshGrants || 0) + 1;
        return this.send(res, 200, {
          token_type: 'bearer', access_token: this.tokenFor(m[1]), refresh_token: `refresh-${m[1]}-${Date.now()}`, expires_in: 7200, scope: '',
        });
      }
      return this.send(res, 400, { error: 'unsupported_grant_type' });
    }

    // publish.x.com/oembed: public, unauthenticated, same blockquote shape.
    if (req.method === 'GET' && path === '/oembed') {
      const id = String(url.searchParams.get('url') || '').match(/\/status(?:es)?\/(\d+)/)?.[1];
      const post = id && this.posts.get(id);
      const author = post && this.users.get(post.author_id);
      if (!post || this.deleted.has(id) || !author || author.protected) return this.send(res, 404, { error: 'not found' });
      const esc = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
      const shown = post.display_text_range ? post.text.slice(post.display_text_range[0]) : post.text;
      return this.send(res, 200, {
        url: `https://twitter.com/${author.username}/status/${id}`,
        author_name: author.name,
        author_url: `https://twitter.com/${author.username}`,
        html: `<blockquote class="twitter-tweet" data-dnt="true"><p lang="en" dir="ltr">${esc(shown).replace(/\n/g, '<br>')}</p>&mdash; ${esc(author.name)} (@${author.username}) <a href="https://twitter.com/${author.username}/status/${id}?ref_src=twsrc%5Etfw">${new Date(post.created_at).toDateString()}</a></blockquote>\n`,
        width: 550,
        height: null,
        type: 'rich',
        cache_age: '3153600000',
        provider_name: 'Twitter',
        provider_url: 'https://twitter.com',
        version: '1.0',
      });
    }

    if (path.startsWith('/2/compliance/jobs') || path.startsWith('/upload/') || path.startsWith('/download/')) {
      return this.compliance(req, res, path);
    }

    const userId = this.bearer(req);
    if (!userId) return this.send(res, 401, { title: 'Unauthorized' });

    if (req.method === 'GET' && path === '/2/users/me') {
      return this.send(res, 200, { data: this.users.get(userId) });
    }

    const mentions = path.match(/^\/2\/users\/(\d+)\/mentions$/);
    if (req.method === 'GET' && mentions) {
      const target = this.users.get(mentions[1]);
      const since = url.searchParams.get('since_id');
      const max = Number(url.searchParams.get('max_results') || 10);
      const list = [...this.posts.values()]
        .filter((p) => !this.deleted.has(p.id))
        .filter((p) => (p.entities?.mentions || []).some((m) => m.id === target.id || m.username.toLowerCase() === target.username.toLowerCase()))
        .filter((p) => !since || BigInt(p.id) > BigInt(since))
        .sort((a, b) => (BigInt(b.id) > BigInt(a.id) ? 1 : -1));
      const page = list.slice(0, max);
      if (!page.length) return this.send(res, 200, { meta: { result_count: 0 } });
      return this.send(res, 200, {
        data: page,
        includes: this.includesFor(page),
        meta: { result_count: page.length, newest_id: page[0].id, oldest_id: page[page.length - 1].id },
      });
    }

    if (req.method === 'GET' && path === '/2/tweets') {
      const ids = String(url.searchParams.get('ids') || '').split(',').filter(Boolean);
      const found = ids.map((id) => this.posts.get(id)).filter((p) => p && !this.deleted.has(p.id));
      const missing = ids.filter((id) => !found.some((p) => p.id === id));
      const users = [...new Set(found.map((p) => p.author_id))].map((id) => this.users.get(id)).filter(Boolean);
      return this.send(res, 200, {
        ...(found.length ? { data: found, includes: { users } } : {}),
        ...(missing.length ? { errors: missing.map((id) => ({ resource_id: id, title: 'Not Found Error' })) } : {}),
      });
    }

    if (req.method === 'POST' && path === '/2/tweets') {
      const body = JSON.parse(await this.body(req));
      const post = this.post(userId, body.text, {
        replyTo: body.reply?.in_reply_to_tweet_id,
        exclude: body.reply?.exclude_reply_user_ids || [],
      });
      this.created.push({ ...body, id: post.id, author_id: userId });
      return this.send(res, 201, { data: { id: post.id, text: post.text } });
    }

    const dm = path.match(/^\/2\/dm_conversations\/with\/(\d+)\/messages$/);
    if (req.method === 'POST' && dm) {
      const body = JSON.parse(await this.body(req));
      if (this.failDms) return this.send(res, 403, { title: 'Forbidden', detail: 'You cannot send messages to this user.' });
      this.dmsSent.push({ to: dm[1], text: body.text });
      return this.send(res, 201, { data: { dm_event_id: `dm-${this.dmsSent.length}` } });
    }

    if (req.method === 'GET' && path === '/2/dm_events') {
      return this.send(res, 200, { data: this.dmEvents, meta: { result_count: this.dmEvents.length } });
    }

    return this.send(res, 404, { title: 'Not Found' });
  }

  async compliance(req, res, path) {
    const auth = req.headers.authorization || '';
    if (path.startsWith('/upload/') && req.method === 'PUT') {
      const id = path.slice('/upload/'.length);
      const job = this.jobs.get(id);
      if (!job) return this.send(res, 404, { title: 'Not Found' });
      job.ids = (await this.body(req)).split(/\s+/).filter(Boolean);
      job.status = 'complete';
      res.writeHead(204);
      return res.end();
    }
    if (path.startsWith('/download/') && req.method === 'GET') {
      const job = this.jobs.get(path.slice('/download/'.length));
      if (!job) return this.send(res, 404, { title: 'Not Found' });
      const rows = [];
      for (const id of job.ids) {
        if (job.type === 'tweets' && this.deleted.has(id)) rows.push({ id, action: 'delete' });
        else if (job.type === 'tweets' && this.edited.has(id)) rows.push({ id, action: 'rehydrate' });
        else if (job.type === 'users' && this.users.get(id)?.suspended) rows.push({ id, action: 'delete' });
      }
      return this.send(res, 200, rows);
    }
    if (auth !== 'Bearer app-bearer') return this.send(res, 401, { title: 'Unauthorized' });
    if (this.compliance403) return this.send(res, 403, { title: 'Forbidden', detail: 'App not enrolled' });
    if (req.method === 'POST' && path === '/2/compliance/jobs') {
      const body = JSON.parse(await this.body(req));
      const id = `job-${this.jobSeq += 1}`;
      this.jobs.set(id, { type: body.type, ids: [], status: 'created' });
      return this.send(res, 200, { data: { id, type: body.type, status: 'created', upload_url: `${this.base}/upload/${id}` } });
    }
    const one = path.match(/^\/2\/compliance\/jobs\/([^/]+)$/);
    if (req.method === 'GET' && one) {
      const job = this.jobs.get(one[1]);
      if (!job) return this.send(res, 404, { title: 'Not Found' });
      return this.send(res, 200, { data: { id: one[1], status: job.status, download_url: job.status === 'complete' ? `${this.base}/download/${one[1]}` : null } });
    }
    return this.send(res, 404, { title: 'Not Found' });
  }
}
