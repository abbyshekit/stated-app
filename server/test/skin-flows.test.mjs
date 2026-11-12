// Regression tests for the skinned pages: the header menu and inbox dot, the
// quick track form and "Needs you" list, one-tap confirm, share links,
// visibility toggles, file rows, the stylesheet and the inbox rows. Each test
// drives the real server over HTTP and reads the rendered HTML.

import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { tick } from '../src/worker.mjs';
import { ADMIN_X_ID, Browser, startStack } from './support/app.mjs';

const YEAR = new Date().getUTCFullYear() + 1;
const TODAY = new Date().toISOString().slice(0, 10);
let s;
let anon;
let aliceB;
let bobB;
let daveB;
let erinB;
let frankB;
let hankB;
let adminB;
let ids = {};
let posts = {};

const decode = (text) => text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>');

// Every form on a page: action, method, hidden fields in document order.
function formsOf(text) {
  return [...text.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/g)].map((m) => {
    const attr = (name) => m[1].match(new RegExp(`${name}="([^"]*)"`))?.[1] ?? null;
    const inputs = [...m[2].matchAll(/<input\b([^>]*)>/g)].map((i) => ({
      name: i[1].match(/name="([^"]*)"/)?.[1] ?? null,
      type: i[1].match(/type="([^"]*)"/)?.[1] ?? 'text',
      value: decode(i[1].match(/value="([^"]*)"/)?.[1] ?? ''),
    }));
    return { action: attr('action'), method: attr('method'), body: m[2], inputs, hidden: inputs.filter((i) => i.type === 'hidden' && i.name) };
  });
}

// Submit a form found on a page the way a browser would, without following
// the redirect, so the Location header can be asserted.
function postForm(browser, form, extra = []) {
  const pairs = [...form.hidden.map((i) => [i.name, i.value]), ...extra];
  return browser.request('POST', form.action, { form: pairs });
}

function intentLinks(text) {
  return [...text.matchAll(/href="(https:\/\/x\.com\/intent\/post\?[^"]*)"/g)].map((m) => new URL(decode(m[1])));
}

// The Content-Security-Policy forbids inline styles and inline scripts.
function assertCspClean(page, label) {
  assert.equal(page.status, 200, `${label} did not load`);
  assert.doesNotMatch(page.text, /\sstyle="/, `${label} has a style attribute`);
  const inline = [...page.text.matchAll(/<script\b([^>]*)>/gi)].filter((m) => !/\bsrc=/.test(m[1]));
  assert.equal(inline.length, 0, `${label} has an inline <script>`);
}

const navOf = (text) => text.match(/<nav aria-label="Main">([\s\S]*?)<\/nav>/)?.[1] ?? '';
const mainLinks = (text) => [...navOf(text).matchAll(/<a href="([^"]+)"([^>]*)>/g)].slice(0, 4)
  .map((m) => ({ href: m[1], current: /aria-current="page"/.test(m[2]) }));

async function statementOf(saveId) {
  return (await s.db.one('select statement_id from saves where id = $1', [saveId])).statement_id;
}

async function saveFor(owner, postId) {
  return (await s.db.one(`select s.id from saves s join statements st on st.id = s.statement_id
    join sources src on src.id = st.source_id where s.owner_x_user_id = $1 and src.platform_id = $2`, [owner, postId])).id;
}

async function resolve(statementId, outcome) {
  const res = await adminB.submit(`/admin/resolve/${statementId}`, {
    outcome, url: 'https://example.com/evidence', note: 'Recorded.', known: TODAY,
  }, { from: '/admin' });
  assert.equal(res.status, 200);
}

before(async () => {
  s = await startStack();
  const bot = s.fakeX.addUser('500', 'statedbot');
  const alice = s.fakeX.addUser('100', 'alice');
  const bob = s.fakeX.addUser('200', 'bob');
  const dave = s.fakeX.addUser('400', 'dave');
  const erin = s.fakeX.addUser('700', 'erin');
  const frank = s.fakeX.addUser('800', 'frank');
  const hank = s.fakeX.addUser('850', 'hank');
  s.fakeX.addUser(ADMIN_X_ID, 'reviewer');
  await s.connectBot(bot);

  const say = (author, text) => s.fakeX.post(author.id, text);
  const tag = (author, post) => s.fakeX.post(author.id, '@statedbot', { replyTo: post.id });
  posts = {
    confirm: say(alice, `Gold will close above $4,000 by the end of ${YEAR}, 60% chance.`),
    yes: say(alice, `Bitcoin will close above $150k by the end of ${YEAR}, 70% chance.`),
    no: say(alice, `Ethereum will flip Bitcoin by the end of ${YEAR}, 20% chance.`),
    toggle: say(alice, `Oil will trade above $120 by the end of ${YEAR}, 40% chance.`),
    secret: say(alice, `Copper will reach $6 a pound by the end of ${YEAR}, 55% chance.`),
    open: say(alice, `Silver will pass $60 by the end of ${YEAR}, 50% chance.`),
    resolved: say(alice, `Platinum will pass $2,000 by the end of ${YEAR}, 45% chance.`),
    dave: say(dave, `Tesla will ship robotaxis by the end of ${YEAR}, 65% chance.`),
    erin: say(erin, `Nvidia will be worth $6T by the end of ${YEAR}, 35% chance.`),
    hank: say(hank, `Apple will ship glasses by the end of ${YEAR}, 30% chance.`),
    frank: say(alice, `Uranium will trade above $150 by the end of ${YEAR}, 25% chance.`),
  };
  for (const [owner, post] of [
    [alice, posts.confirm], [alice, posts.yes], [alice, posts.no], [alice, posts.toggle], [alice, posts.secret],
    [alice, posts.open], [alice, posts.resolved], [dave, posts.dave], [erin, posts.erin], [hank, posts.hank],
  ]) tag(owner, post);
  tag(bob, posts.yes);
  tag(bob, posts.no);
  await tick(s.db, s.config, s.x);

  ids = {
    confirm: await saveFor(alice.id, posts.confirm.id),
    yes: await saveFor(alice.id, posts.yes.id),
    no: await saveFor(alice.id, posts.no.id),
    toggle: await saveFor(alice.id, posts.toggle.id),
    secret: await saveFor(alice.id, posts.secret.id),
    open: await saveFor(alice.id, posts.open.id),
    resolved: await saveFor(alice.id, posts.resolved.id),
    dave: await saveFor(dave.id, posts.dave.id),
    erin: await saveFor(erin.id, posts.erin.id),
    hank: await saveFor(hank.id, posts.hank.id),
    bobYes: await saveFor(bob.id, posts.yes.id),
    bobNo: await saveFor(bob.id, posts.no.id),
  };

  aliceB = await s.signIn(alice);
  await aliceB.submit('/setup', { profile: 'public', defaults: 'private' });
  bobB = await s.signIn(bob);
  await bobB.submit('/setup', { profile: 'public', defaults: 'private' });
  daveB = await s.signIn(dave);
  await daveB.submit('/setup', { profile: 'private', defaults: 'private' });
  erinB = await s.signIn(erin);
  await erinB.submit('/setup', { profile: 'private', defaults: 'private' });
  frankB = await s.signIn(frank);
  await frankB.submit('/setup', { profile: 'private', defaults: 'private' });
  hankB = await s.signIn(hank);
  await hankB.submit('/setup', { profile: 'private', defaults: 'private' });
  adminB = await s.signIn({ id: ADMIN_X_ID });
  await adminB.submit('/setup', { profile: 'private', defaults: 'private' });
  anon = new Browser(s.base);

  // The visibility test needs a confirmed prediction: an unconfirmed one leads with Confirm.
  await aliceB.submit(`/me/saves/${ids.toggle}/terms`, { deadline: `${YEAR}-12-31`, probability: '40', condition: '', back: '/me' });
  for (const key of ['yes', 'no', 'toggle', 'open', 'resolved']) {
    await aliceB.submit(`/me/saves/${ids[key]}/visibility`, { visibility: 'public', back: '/me' });
  }
  await bobB.submit(`/me/saves/${ids.bobYes}/visibility`, { visibility: 'public', back: '/me' });
  await bobB.submit(`/me/saves/${ids.bobNo}/visibility`, { visibility: 'public', back: '/me' });
  await tick(s.db, s.config, s.x);
});

after(() => s.close());

test('header menu: one Main nav with four links; signed-out home has one Make a bet action', async () => {
  for (const [path, current] of [['/me', '/me'], ['/me/inbox', '/me/inbox'], ['/me/settings', '/me/settings']]) {
    const page = await aliceB.get(path);
    assert.equal(page.status, 200);
    assert.equal(page.text.match(/<nav aria-label="Main">/g)?.length, 1, `${path} has exactly one Main nav`);
    const links = mainLinks(page.text);
    assert.deepEqual(links.map((l) => l.href), ['/me', '/me/bets', '/me/inbox', '/me/settings']);
    assert.deepEqual(links.filter((l) => l.current).map((l) => l.href), [current], `${path} marks only itself`);
  }
  const out = await anon.get('/');
  assert.doesNotMatch(out.text, /<nav aria-label="Main">/);
  // The signed-out home has one way to sign in: the page's own filled button.
  assert.equal(out.text.match(/href="\/signin"/g)?.length, 1);
  assert.match(out.text, /<a class="pill solid big" href="\/signin">Make a bet<\/a>/);
  // Any other signed-out page offers it in the header, and comes back to the same page.
  const search = await anon.get('/search?q=gold');
  assert.match(search.text, /<a class="pill" href="\/signin\?return=%2Fsearch%3Fq%3Dgold">[\s\S]*?Sign in<\/a>/);
});

test('inbox dot: shown while the user has an open item, gone once every item is done', async () => {
  const before = await erinB.get('/me');
  assert.match(before.text, /<summary[^>]*>[\s\S]*?class="dot"[\s\S]*?<\/summary>/);
  const inbox = await erinB.get('/me/inbox');
  const done = formsOf(inbox.text).filter((f) => /^\/me\/inbox\/\d+\/done$/.test(f.action));
  assert.ok(done.length >= 1, 'erin has an open inbox item');
  for (const form of done) {
    const res = await postForm(erinB, form);
    assert.equal(res.status, 303);
    assert.equal(res.location, '/me/inbox');
  }
  assert.equal((await s.db.one(`select count(*)::int as n from inbox where owner_x_user_id = '700' and done_at is null`)).n, 0);
  const after = await erinB.get('/me');
  assert.doesNotMatch(after.text, /class="dot"/);
  assert.doesNotMatch(after.text, /<summary[^>]*>[\s\S]*?class="dot"[\s\S]*?<\/summary>/);
});

test('quick track on /me posts a url to /me/track with the csrf field; an X post link redirects to the save with done=xsaved', async () => {
  const page = await frankB.get('/me');
  const form = formsOf(page.text).find((f) => f.action === '/me/track');
  assert.ok(form, 'a form posts to /me/track');
  assert.equal(form.method, 'post');
  assert.ok(form.inputs.some((i) => i.name === 'url'), 'an input named url');
  assert.equal(form.hidden.find((i) => i.name === 'csrf')?.value, frankB.csrf(page));
  const res = await postForm(frankB, form, [['url', `https://x.com/alice/status/${posts.frank.id}`]]);
  assert.equal(res.status, 303);
  assert.match(res.location, /^\/me\/s\/\d+\?done=xsaved$/);
});

test('an unconfirmed own prediction asks its one question in its row, confirms in one tap, and stops asking', async () => {
  const rowsOf = (text) => text.split('<li class="prow"').slice(1).map((r) => r.split('</li>')[0]);
  const page = await daveB.get('/me');
  const row = rowsOf(page.text).find((r) => r.includes(`href="/me/s/${ids.dave}"`));
  assert.ok(row, 'the prediction is listed');
  assert.equal(row.match(/aria-label="Confirm what you meant"/g)?.length, 1, 'asked exactly once');
  assert.match(row, /65%\. That right\?/);
  const form = formsOf(row).find((f) => f.action === `/me/saves/${ids.dave}/terms`);
  assert.ok(form, 'the row carries the confirm form');
  const hidden = Object.fromEntries(form.hidden.map((i) => [i.name, i.value]));
  assert.equal(hidden.back, '/me');
  assert.match(hidden.deadline, /^\d{4}-12-31$/);
  assert.equal(hidden.probability, '65');
  assert.match(form.body, /<button class="primary" type="submit">Looks right<\/button>/);
  assert.match(row, new RegExp(`<a class="pill" href="/me/s/${ids.dave}#terms">Edit</a>`));

  const res = await postForm(daveB, form);
  assert.equal(res.location, '/me?done=terms');
  const after = await daveB.get('/me');
  assert.doesNotMatch(after.text, /Confirm what you meant/);
  assert.doesNotMatch(after.text, /That right\?/);
  const revisions = await s.db.many(`select kind from revisions where statement_id = $1 and (save_id is null or save_id = $2) order by id`,
    [await statementOf(ids.dave), ids.dave]);
  assert.deepEqual(revisions.map((r) => r.kind), ['captured', 'author_terms']);
});

test('one-tap confirm: hidden deadline, probability and condition confirm the terms, the form goes away and the history records it', async () => {
  const path = `/me/s/${ids.confirm}`;
  const page = await aliceB.get(path);
  const form = formsOf(page.text).find((f) => f.action === `/me/saves/${ids.confirm}/terms`);
  assert.ok(form, 'a confirm form is offered');
  const hidden = Object.fromEntries(form.hidden.map((i) => [i.name, i.value]));
  assert.ok('deadline' in hidden && 'probability' in hidden && 'condition' in hidden);
  assert.match(hidden.deadline, /^\d{4}-\d{2}-\d{2}$/);
  assert.equal(hidden.probability, '60');
  assert.match(page.text, /Is that what you meant\?/);
  assert.match(form.body, /<button class="primary big" type="submit">Confirm<\/button>/);

  const res = await postForm(aliceB, form);
  assert.equal(res.status, 303);
  assert.equal(res.location, `${path}?done=terms`);

  const after = await aliceB.get(path);
  assert.doesNotMatch(after.text, /Is that what you meant\?/);
  assert.doesNotMatch(after.text, /type="submit">Confirm<\/button>/);
  assert.match(after.text, /<strong>The author confirmed the terms as read<\/strong>/);
  const revisions = await s.db.many(`select kind from revisions where statement_id = $1 and (save_id is null or save_id = $2) order by id`,
    [await statementOf(ids.confirm), ids.confirm]);
  assert.deepEqual(revisions.map((r) => r.kind), ['captured', 'author_terms']);
});

test('share copy: On the record while open; Result wording for the author after yes and no; neutral wording for a follower', async () => {
  const open = await aliceB.get(`/me/s/${ids.yes}`);
  const openLinks = intentLinks(open.text);
  assert.ok(openLinks.length >= 1, 'the page offers an X composer link');
  assert.match(openLinks[0].searchParams.get('text'), /^On the record:/);
  assert.equal(openLinks[0].searchParams.get('url'), `${s.base}/u/alice/${ids.yes}`);

  await resolve(await statementOf(ids.yes), 'yes');
  const yes = await aliceB.get(`/me/s/${ids.yes}`);
  const yesLink = intentLinks(yes.text)[0];
  assert.ok(yesLink, 'the owner still has a composer link');
  assert.ok(yesLink.searchParams.get('text').startsWith('Result: Yes. I called it'), yesLink.searchParams.get('text'));
  assert.equal(yesLink.searchParams.get('url'), `${s.base}/u/alice/${ids.yes}`);
  assert.match(yes.text, /<span class="hl sweep">/, 'the owner sees the words marked');
  assert.match(yes.text, /Post the result<\/a>/);

  await resolve(await statementOf(ids.no), 'no');
  const no = await aliceB.get(`/me/s/${ids.no}`);
  const noLink = intentLinks(no.text)[0];
  assert.ok(noLink.searchParams.get('text').startsWith('Result: No. I got this one wrong'), noLink.searchParams.get('text'));
  assert.match(no.text, /<span class="struck">/, 'a miss is struck through');
  assert.doesNotMatch(no.text, /class="hl/, 'and never highlighted');

  const follower = await bobB.get(`/me/s/${ids.bobYes}`);
  const followerLink = intentLinks(follower.text)[0];
  assert.ok(followerLink, 'the follower has a composer link');
  const text = followerLink.searchParams.get('text');
  assert.ok(text.startsWith('Result: Yes. @alice'), text);
  assert.ok(!text.includes('I called it'), text);
  const followerNo = intentLinks((await bobB.get(`/me/s/${ids.bobNo}`)).text)[0].searchParams.get('text');
  assert.ok(followerNo.startsWith('Result: No. @alice'), followerNo);
  assert.ok(!followerNo.includes('I got this one wrong'), followerNo);

  const publicPage = await anon.get(`/u/alice/${ids.yes}`);
  const publicText = intentLinks(publicPage.text)[0].searchParams.get('text');
  assert.ok(publicText.startsWith('Result: Yes. @alice'), publicText);
});

test('visibility: Make private and Make public round-trip with their flashes, and going public shows the post-on-X nudge', async () => {
  const path = `/me/s/${ids.toggle}`;
  const page = await aliceB.get(path);
  const toPrivate = formsOf(page.text).find((f) => f.action === `/me/saves/${ids.toggle}/visibility`);
  assert.ok(toPrivate, 'a visibility form exists');
  assert.match(toPrivate.body, /<button class="tl" type="submit">Make private<\/button>/);
  const priv = await postForm(aliceB, toPrivate);
  assert.equal(priv.location, `${path}?done=private`);

  const privatePage = await aliceB.get(`${path}?done=private`);
  assert.match(privatePage.text, /<button class="primary big" type="submit">Make public<\/button>/);
  const toPublic = formsOf(privatePage.text).find((f) => f.action === `/me/saves/${ids.toggle}/visibility` && /Make public/.test(f.body));
  assert.ok(toPublic);
  const pub = await postForm(aliceB, toPublic);
  assert.equal(pub.location, `${path}?done=public`);

  const publicPage = await aliceB.get(`${path}?done=public`);
  const nudge = publicPage.text.match(/<div class="notice go"[^>]*>([\s\S]*?)<\/div>/)?.[1];
  assert.ok(nudge, 'the nudge block is shown');
  assert.match(nudge, /href="https:\/\/x\.com\/intent\/post\?/);
});

test('lists: the prediction that came true leads the home page highlighted; every row gives one plain status and its source after the words; a private post never shows its words', async () => {
  await resolve(await statementOf(ids.resolved), 'yes');
  const home = await anon.get('/');
  assert.match(home.text, /<p class="said"><a href="\/u\/\w+\/\d+"><span class="hl sweep">/, 'the result that came true is marked');
  assert.match(home.text, /<p class="verdict yes"><b>Yes<\/b>/);
  const rows = home.text.split('<li class="prow"').slice(1).map((r) => r.split('</li>')[0]);
  assert.ok(rows.length >= 3, `home lists the other public records (${rows.length})`);
  for (const row of rows) {
    const claim = row.indexOf('class="said"');
    const source = row.indexOf('/status/');
    assert.ok(claim >= 0, 'row has the words');
    assert.ok(source > claim, 'the source link comes after the words');
    assert.match(row, /<p class="meta"><span>(\d+ days to go|1 day to go|\d+ months to go|\d+ years to go|Due today|Past due|No date yet|Came true[^<]*|Didn’t happen[^<]*|Ambiguous, not scored|Annulled, not scored|Result disputed)<\/span>/);
    assert.doesNotMatch(row, /class="hl sweep"/, 'only the lead animates');
  }

  const me = await aliceB.get('/me');
  assert.match(me.text, new RegExp(`A post by @alice[\\s\\S]*status/${posts.secret.id}`));
  assert.doesNotMatch(me.text, /Copper will reach/);
  const detail = await aliceB.get(`/me/s/${ids.secret}`);
  assert.doesNotMatch(detail.text, /Copper will reach/);
  assert.doesNotMatch(detail.text, /class="hl|class="struck"/, 'a withheld post is never marked');
});

test('stylesheet: served as text/css with an ETag, 304 on a match, and free of shadows, real gradients, dashed edges and capitals', async () => {
  const first = await anon.request('GET', '/static/skin.css');
  assert.equal(first.status, 200);
  assert.match(first.headers.get('content-type'), /^text\/css/);
  const etag = first.headers.get('etag');
  assert.ok(etag);
  const second = await anon.request('GET', '/static/skin.css', { headers: { 'if-none-match': etag } });
  assert.equal(second.status, 304);
  assert.doesNotMatch(first.text, /box-shadow/);
  // One flat gradient exists: the highlighter sweep, which is a single colour.
  const gradients = first.text.match(/gradient\([^;]*/g) || [];
  assert.deepEqual(gradients.filter((g) => !g.startsWith('gradient(var(--mark), var(--mark))')), []);
  // One !important exists: the rule that keeps the hidden attribute hidden.
  assert.deepEqual(first.text.match(/[^{}]*\{[^{}]*!important[^{}]*\}/g)?.map((r) => r.trim()), ['[hidden] { display: none !important; }']);
  assert.doesNotMatch(first.text, /stroke-dasharray|dashed|dotted/);
  // Capitals are allowed for a one-letter monogram; tracked capitals (the label look) are not.
  for (const block of first.text.match(/[^{}]*\{[^{}]*text-transform:\s*uppercase[^{}]*\}/g) || []) {
    assert.doesNotMatch(block, /letter-spacing:\s*0?\.\d*[1-9]/, 'no tracked capitals');
  }
});

test('no page carries an inline style attribute or an inline script body', async () => {
  const pages = [
    ['/', anon, '/'],
    ['/me', aliceB, '/me'],
    ['/me/inbox', hankB, '/me/inbox'],
    ['/me/settings', aliceB, '/me/settings'],
    ['/me/track', aliceB, '/me/track'],
    ['/me/s/<id>', aliceB, `/me/s/${ids.open}`],
    ['/me/s/<id> (private)', aliceB, `/me/s/${ids.secret}`],
    ['/u/alice', anon, '/u/alice'],
    ['/u/alice/<id>', anon, `/u/alice/${ids.open}`],
    ['/signin page signed out', anon, '/search?q=gold'],
  ];
  for (const [label, browser, path] of pages) assertCspClean(await browser.get(path), label);
});

test('inbox rows: one <li> per open item inside ul.inbox, each with a Done form, and save notices link to the save', async () => {
  const page = await hankB.get('/me/inbox');
  const list = page.text.match(/<ul class="posts inbox">([\s\S]*?)<\/ul>/)?.[1];
  assert.ok(list, 'the inbox list is rendered');
  const items = [...list.matchAll(/<li class="prow note">([\s\S]*?)<\/li>/g)].map((m) => m[1]);
  const open = (await s.db.one(`select count(*)::int as n from inbox where owner_x_user_id = '850' and done_at is null`)).n;
  assert.ok(open >= 1);
  assert.equal(items.length, open);
  for (const li of items) assert.match(li, /<form method="post" action="\/me\/inbox\/\d+\/done">[\s\S]*?<button class="tl" type="submit">Done<\/button>/);
  assert.ok(items.some((li) => /class="what" href="\/me\/s\//.test(li)), 'an item with a save link');
});
