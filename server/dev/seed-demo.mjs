#!/usr/bin/env node
// Fills a RUNNING simulated-X demo (server/dev/simulated-x.mjs) with test
// content: posts, three public test profiles, saves made by tagging the bot,
// and four recorded outcomes. Local only: it talks to 127.0.0.1 and refuses
// anything else. Every post it writes starts with "TEST FIXTURE:".
//
//   node server/dev/simulated-x.mjs                      (terminal one)
//   node server/dev/seed-demo.mjs                           (terminal two)
import { writeFileSync } from 'node:fs';
import { Browser } from '../test/support/app.mjs';

const APP = process.env.SEED_APP || 'http://127.0.0.1:4310';
const X = process.env.SEED_X || 'http://127.0.0.1:4311';
for (const base of [APP, X]) {
  if (new URL(base).hostname !== '127.0.0.1') throw new Error(`seed-demo only runs against 127.0.0.1, not ${base}`);
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const BOT = '@sim_statedbot';

async function compose(as, text, replyTo = '') {
  await fetch(`${X}/compose`, {
    method: 'POST',
    redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ as, text, reply_to: replyTo }),
  });
}

async function posts() {
  const page = await (await fetch(`${X}/compose`)).text();
  return [...page.matchAll(/<option value="(\d{6,})">(@\w+): ([^<]*)<\/option>/g)].map((m) => ({ id: m[1], text: m[3] }));
}

// The simulated consent page, approved as the given test account.
async function signIn(id) {
  const browser = new Browser(APP);
  const first = await browser.request('GET', '/signin/x');
  const approve = new URL(first.location, APP);
  approve.pathname = '/i/oauth2/authorize/approve';
  approve.searchParams.set('as', id);
  await browser.follow(approve.toString());
  return browser;
}

const year = new Date().getUTCFullYear() + 1;
// Own these sources rather than relying on the simulated server's first posts:
// its composer lists only the latest 30, including replies from earlier runs.
await compose('1001', `TEST FIXTURE: Bitcoin will close above $150k by the end of ${year}, 70% chance.`);
await compose('1002', `TEST FIXTURE: The Fed will cut rates twice by June 30, ${year}.`);
await compose('1003', `TEST FIXTURE: Rust 2.0 will ship a stable release by March 1, ${year}.`);
await compose('1002', `TEST FIXTURE: Ethereum will trade above $10,000 by June 30, ${year}. 60% chance.`);
await compose('1001', `TEST FIXTURE: The Leafs will win a playoff round by May 31, ${year}.`);
await compose('1003', `TEST FIXTURE: Apple will ship a foldable iPhone by December 31, ${year}.`);
await compose('1003', `TEST FIXTURE: A human will run a marathon under two hours in an open race by October 31, ${year}.`);

const alice = await signIn('1001');
const bob = await signIn('1002');
const carol = await signIn('1003');
const admin = await signIn('1900');
for (const browser of [alice, bob, carol]) {
  await browser.submit('/me/settings/publish', [['confirm', '1'], ['defaults', 'public']], { from: '/setup' });
}
await admin.submit('/setup', { profile: 'private', defaults: 'private' });

const all = await posts();
const find = (needle) => all.find((post) => post.text.includes(needle)).id;
// Stable capture order makes the local screenshot run repeatable.
await compose('1001', BOT, find('Bitcoin')); // 1 alice, her own
await compose('1002', BOT, find('The Fed')); // 2 bob, his own
await compose('1003', BOT, find('Rust 2.0')); // 3 carol, her own
await compose('1003', BOT, find('Bitcoin')); // 4 carol follows alice
await compose('1001', BOT, find('Ethereum')); // 5 alice follows bob
await compose('1001', BOT, find('Leafs')); // 6 alice, her own
await compose('1002', BOT, find('foldable')); // 7 bob follows carol
await compose('1003', BOT, find('foldable')); // 8 carol, her own
await compose('1001', BOT, find('marathon')); // 9 alice follows carol
await sleep(9000); // the demo worker polls every three seconds

const today = new Date().toISOString().slice(0, 10);
const outcomes = [
  ['Rust 2.0', 'yes', 'TEST FIXTURE: release published.'],
  ['foldable', 'yes', 'TEST FIXTURE: shipped.'],
  ['Leafs', 'no', 'TEST FIXTURE: eliminated.'],
  ['The Fed', 'ambiguous', 'TEST FIXTURE: the wording covers two readings.'],
];
for (const [needle, outcome, note] of outcomes) {
  const page = await admin.get('/admin');
  const form = page.text.split('action="/admin/resolve/').slice(1).find((part) => part.includes(needle));
  if (!form) { console.log(`not found on the admin page: ${needle}`); continue; }
  const result = await admin.submit(`/admin/resolve/${form.match(/^(\d+)/)[1]}`, { outcome, url: 'https://example.com/test-fixture', note, known: today }, { from: '/admin' });
  console.log(`${needle}: ${outcome} (${result.status})`);
}

// Optional: local demo session cookies for a screenshot script. Never a real session.
if (process.env.SEED_OUT) {
  writeFileSync(process.env.SEED_OUT, JSON.stringify({ cookies: { alice: alice.cookieHeader(), carol: carol.cookieHeader(), admin: admin.cookieHeader() } }, null, 2));
}
console.log(`Seeded. Open ${APP}`);
