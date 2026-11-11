// The simulated X as threads: every post with its replies under it. A plain
// local page with its own look, labelled as a stand-in. It is served by the
// demo server and nothing in it reaches x.com.
const esc = (v) => String(v).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

// Who the page posts as: the cookie's test account, or the first one.
export function personFrom(x, req) {
  const id = /(?:^|;\s*)simas=(\d+)/.exec(req.headers.cookie || '')?.[1];
  const people = [...x.users.values()].filter((u) => !x.botIds.has(u.id));
  return x.users.has(id) && !x.botIds.has(id) ? id : people[0]?.id;
}

// `only` is the id of one post: the page then shows that thread alone.
export function threadPage(x, req, { app, only = null, take = false, say = '' } = {}) {
  // Only a whole bet command is ever typed for the visitor; anything else is dropped.
  const typed = /^bet (?:0|[1-9]\d*)(?:\.\d{1,6})? (?:yes|no)$/.test(say || '') ? say : '';
  const me = personFrom(x, req);
  const people = [...x.users.values()].filter((u) => !x.botIds.has(u.id));
  const botName = [...x.users.values()].find((u) => x.botIds.has(u.id))?.username || 'bot';
  const all = [...x.posts.values()].sort((a, b) => (BigInt(a.id) > BigInt(b.id) ? 1 : -1));
  const parentOf = (p) => (p.referenced_tweets || []).find((r) => r.type === 'replied_to')?.id;
  const kids = new Map();
  for (const p of all) {
    const parent = parentOf(p);
    if (parent && x.posts.has(parent)) kids.set(parent, [...(kids.get(parent) || []), p]);
  }
  const roots = only && x.posts.has(only) ? [x.posts.get(only)]
    : all.filter((p) => !parentOf(p) || !x.posts.has(parentOf(p))).reverse().slice(0, 12);
  const words = (text) => esc(text)
    .replace(/https?:\/\/[^\s<]+[^\s<.,)]/g, (link) => `<a href="${link}">${link.replace(/^https?:\/\//, '')}</a>`)
    .replace(/(^|\s)@(\w+)/g, '$1<b>@$2</b>');
  const picture = (u) => (u?.profile_image_url
    ? `<img class="pic" src="${esc(u.profile_image_url)}" alt="">`
    : `<span class="pic">${esc((u?.username || '?').replace(/^sim_/, '').slice(0, 1).toUpperCase())}</span>`);
  // Like X, a reply's leading mentions of the people it answers are not shown as part of its words.
  const shown = (p) => (Array.isArray(p.display_text_range) && p.display_text_range[0] > 0 ? [...p.text].slice(p.display_text_range[0]).join('') : p.text);
  // A thread reads top to bottom: the post, then every reply under it in the order it was made.
  const under = (id) => (kids.get(id) || []).flatMap((kid) => [kid, ...under(kid.id)]);
  const one = (p, root) => {
    const u = x.users.get(p.author_id);
    const takeOffer = take && p.id === only && x.botIds.has(p.author_id);
    const command = takeOffer ? 'take' : (typed && p.id === only ? typed : '');
    return `<article id="p${p.id}"${root ? '' : ' class="reply"'}>${picture(u)}<div>
      <p class="who"><b>${esc(u?.name || '')}</b> <span>@${esc(u?.username || p.author_id)}</span>${root && !only ? ` <a href="/?c=${p.id}">Open thread</a>` : ''}</p>
      <p class="text">${words(shown(p))}</p>
      <details${command ? ' open' : ''}><summary>Reply</summary><form method="post" action="/post"><input type="hidden" name="reply_to" value="${p.id}">${only ? `<input type="hidden" name="c" value="${esc(only)}">` : ''}
        <textarea name="text" rows="2" aria-label="Your reply">@${esc(botName)} ${esc(command)}</textarea><button type="submit">Reply</button></form></details></div></article>`;
  };
  const thread = (p) => `<section>${one(p, true)}${under(p.id).sort((m, n) => (BigInt(m.id) > BigInt(n.id) ? 1 : -1)).map((kid) => one(kid, false)).join('')}</section>`;
  const size = x.posts.size;
  return `<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Simulated X</title>
<style>
:root { --bg: #0d1014; --ink: #e9ecef; --dim: #8b949e; --line: #262c33; --field: #161b21; --btn: #e9ecef; --btn-ink: #0d1014; }
* { box-sizing: border-box; }
body { margin: 0; background: var(--bg); color: var(--ink); font: 16px/1.45 system-ui, -apple-system, "Segoe UI", sans-serif; }
main { max-width: 600px; margin: 0 auto; border-left: 1px solid var(--line); border-right: 1px solid var(--line); min-height: 100vh; }
header { padding: 14px 16px; border-bottom: 1px solid var(--line); display: flex; flex-wrap: wrap; gap: 6px 16px; align-items: center; justify-content: space-between; }
header h1 { font-size: 18px; margin: 0; }
header p { margin: 0; color: var(--dim); font-size: 14px; flex-basis: 100%; }
header form { display: flex; gap: 8px; align-items: center; font-size: 14px; color: var(--dim); }
select, textarea, button { font: inherit; color: var(--ink); }
select { background: var(--field); border: 1px solid var(--line); border-radius: 8px; padding: 6px 8px; }
.new { padding: 14px 16px; border-bottom: 1px solid var(--line); display: grid; gap: 8px; }
textarea { width: 100%; background: var(--field); border: 1px solid var(--line); border-radius: 12px; padding: 10px 12px; resize: vertical; }
button { justify-self: end; background: var(--btn); color: var(--btn-ink); border: 0; border-radius: 999px; padding: 8px 18px; font-weight: 700; cursor: pointer; }
main > section { padding: 14px 16px 6px; border-bottom: 1px solid var(--line); }
article { display: grid; grid-template-columns: 40px minmax(0, 1fr); gap: 0 12px; }
article.reply { margin: 10px 0 0 20px; }
.pic { width: 40px; height: 40px; border-radius: 50%; background: var(--field); display: grid; place-items: center; font-weight: 700; }
.who { margin: 0; display: flex; flex-wrap: wrap; gap: 0 6px; align-items: baseline; }
.who span { color: var(--dim); }
.who a { margin-left: auto; color: var(--dim); font-size: 14px; white-space: nowrap; }
header h1 a { color: inherit; text-decoration: none; }
.text { margin: 2px 0 6px; overflow-wrap: anywhere; font-size: 17px; }
.text a { color: inherit; }
details { margin-bottom: 8px; } summary { color: var(--dim); font-size: 14px; cursor: pointer; width: max-content; list-style: none; }
summary::-webkit-details-marker { display: none; }
details form { display: grid; gap: 8px; margin-top: 8px; }
.empty { padding: 28px 16px; color: var(--dim); }
:focus-visible { outline: 2px solid var(--ink); outline-offset: 2px; }
</style>
<main>
<header><h1>${only ? '<a href="/" aria-label="All posts">←</a> ' : ''}Simulated X</h1>
  <form method="get" action="/as">${only ? `<input type="hidden" name="c" value="${esc(only)}">` : ''}${take ? '<input type="hidden" name="take" value="1">' : ''}${typed ? `<input type="hidden" name="say" value="${esc(typed)}">` : ''}<label for="as">Posting as</label>
    <select id="as" name="id" onchange="this.form.submit()">${people.map((u) => `<option value="${u.id}"${u.id === me ? ' selected' : ''}>@${esc(u.username)}</option>`).join('')}</select>
    <noscript><button type="submit">Switch</button></noscript></form>
  <p>A local stand-in for X, with test accounts. Nothing here reaches x.com. <a href="${esc(app)}" style="color: inherit">Open Stated</a></p></header>
${only ? '' : `<form class="new" method="post" action="/post"><textarea name="text" rows="2" aria-label="New post" placeholder="Make a prediction"></textarea><button type="submit">Post</button></form>`}
${roots.map(thread).join('') || '<p class="empty">No posts yet. Make a prediction above.</p>'}
</main>
<script>
// Reload when someone posts (the bot answers within seconds), unless a reply is being typed.
(() => {
  const start = ${size};
  const typing = () => [...document.querySelectorAll('textarea')].some((t) => t === document.activeElement || (t.defaultValue !== t.value));
  setInterval(async () => {
    try {
      const now = Number(await (await fetch('/count', { cache: 'no-store' })).text());
      if (now !== start && !typing()) location.reload();
    } catch {}
  }, 2000);
  for (const d of document.querySelectorAll('details')) d.addEventListener('toggle', () => {
    const t = d.querySelector('textarea');
    if (d.open && t) { t.focus(); t.setSelectionRange(t.value.length, t.value.length); }
  });
})();
</script></html>`;
}
