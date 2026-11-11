// Explicitly invoked. Records one Bet made from replies, from the prediction to
// the payout, as a short clip: it drives a running simulated-X demo the way
// people would (posts and replies on the thread page, the reviewer's form on
// the site) and photographs each step in headless Chrome.
//
//   npm run demo                                   # in one terminal, with bets from replies on
//   node scripts/record-demo.mjs out/demo          # in another
//
// Writes <out>/demo.mp4, <out>/demo.gif and <out>/demo.json (what was done and
// how long each answer took). It records whatever chain the demo is running
// on, so only a demo on NEAR testnet gives a clip that may be shown as one.
// Needs Google Chrome and ffmpeg. X is always the simulated one.
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deliveryFromReceipts } from '../server/src/near-delivery.mjs';
import { rpc, viewCredit } from '../server/src/near-escrow.mjs';
import { useNetwork } from '../server/src/near-network.mjs';
import { Browser } from '../server/test/support/app.mjs';

const OUT = resolve(process.argv[2] || 'out/demo');
const APP = process.env.APP || 'http://127.0.0.1:4310';
const X = process.env.SIMX || 'http://127.0.0.1:4311';
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const PORT = Number(process.env.CHROME_PORT || 9357);
const CLAIM = process.env.CLAIM || 'Nightjar 2.0 ships before March 1, 2027.';
const RECORD_CONTRACT = process.env.RECORD_TESTNET_CONTRACT || '';
const RECORD_WINNER = process.env.RECORD_TESTNET_WINNER || '';
if (RECORD_CONTRACT && (!RECORD_CONTRACT.endsWith('.testnet') || !RECORD_WINNER.endsWith('.testnet'))) {
  throw new Error('Verified recording requires the testnet contract and exact winner account.');
}
const W = 390, H = 760;
const sleep = (ms) => new Promise((ok) => setTimeout(ok, ms));
mkdirSync(`${OUT}/frames`, { recursive: true });

// ---- the simulated X, used the way its thread page uses it
async function xpost(as, text, replyTo = null) {
  const res = await fetch(`${X}/post`, { method: 'POST', redirect: 'manual',
    headers: { 'content-type': 'application/x-www-form-urlencoded', cookie: `simas=${as}` },
    body: new URLSearchParams({ text, ...(replyTo ? { reply_to: replyTo } : {}) }) });
  const id = /#p(\d+)/.exec(res.headers.get('location') || '')?.[1];
  if (!id) throw new Error(`The simulated X did not take the post: ${text}`);
  return id;
}
const count = async () => Number(await (await fetch(`${X}/count`)).text());
async function answered(from, label, seconds = 180) {
  const t0 = Date.now();
  for (;;) {
    if (await count() > from) return Number(((Date.now() - t0) / 1000).toFixed(1));
    if (Date.now() - t0 > seconds * 1000) throw new Error(`No answer from the bot: ${label}`);
    await sleep(400);
  }
}
const thread = async (root) => [...(await (await fetch(`${X}/?c=${root}`)).text()).matchAll(/<article id="p(\d+)"/g)].map((m) => m[1]);

// ---- the site, signed in through the simulated consent page
async function signIn(id) {
  const browser = new Browser(APP);
  const first = await browser.request('GET', '/signin/x');
  const approve = new URL(first.location, APP);
  approve.pathname = '/i/oauth2/authorize/approve';
  approve.searchParams.set('as', id);
  await browser.follow(approve.toString());
  return browser;
}

// ---- headless Chrome
const chromeProfile = mkdtempSync(join(tmpdir(), 'stated-demo-chrome-'));
const chrome = spawn(CHROME, ['--headless=new', '--disable-gpu', '--hide-scrollbars', `--remote-debugging-port=${PORT}`,
  `--user-data-dir=${chromeProfile}`, 'about:blank'], { stdio: 'ignore' });
let target;
for (let i = 0; i < 200 && !target; i += 1) {
  try { target = (await (await fetch(`http://127.0.0.1:${PORT}/json`)).json()).find((t) => t.type === 'page'); } catch { /* not up yet */ }
  if (!target) await sleep(200);
}
if (!target) throw new Error('Chrome did not start');
const ws = new WebSocket(target.webSocketDebuggerUrl);
await new Promise((ok) => { ws.onopen = ok; });
let seq = 0;
const waiting = new Map();
ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && waiting.has(d.id)) { waiting.get(d.id)(d); waiting.delete(d.id); } };
const send = (method, params = {}) => new Promise((ok) => { seq += 1; waiting.set(seq, ok); ws.send(JSON.stringify({ id: seq, method, params })); });
await send('Page.enable');
await send('Network.enable');
await send('Animation.enable');
await send('Emulation.setDeviceMetricsOverride', { width: W, height: H, deviceScaleFactor: 2, mobile: true });
await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] });

const frames = [];
async function grab(seconds) {
  const png = await send('Page.captureScreenshot', { format: 'png' });
  if (!png.result?.data) return false;   // a page that is still arriving cannot be photographed
  const file = `${OUT}/frames/f${String(frames.length + 1).padStart(3, '0')}.png`;
  writeFileSync(file, Buffer.from(png.result.data, 'base64'));
  frames.push({ file, seconds });
  return true;
}
async function open(url, { cookies = null, bottom = false } = {}) {
  await send('Network.clearBrowserCookies');
  if (cookies) {
    for (const pair of cookies.split('; ')) {
      const i = pair.indexOf('=');
      await send('Network.setCookie', { name: pair.slice(0, i), value: pair.slice(i + 1), url: APP });
    }
  }
  await send('Page.navigate', { url });
  await sleep(700);
  await send('Runtime.evaluate', { expression: 'document.fonts.ready.then(() => 1)', awaitPromise: true });
  if (bottom) await send('Runtime.evaluate', { expression: 'window.scrollTo(0, document.documentElement.scrollHeight)' });
  await sleep(150);
}
// One held frame of a page.
async function scene(url, seconds, options) { await open(url, options); await grab(seconds); }
// A page whose arrival is the point: its entrance is slowed five times while it is photographed, then played at speed.
async function arrival(url, seconds, options) {
  await send('Animation.setPlaybackRate', { playbackRate: 0.2 });
  await send('Network.clearBrowserCookies');
  await send('Page.navigate', { url });
  await sleep(200);
  const t0 = Date.now();
  while (Date.now() - t0 < 3200) { await grab(0.04); await sleep(60); }
  await send('Animation.setPlaybackRate', { playbackRate: 1 });
  await sleep(300);
  if (!(await grab(seconds))) { await sleep(500); await grab(seconds); }
  void options;
}

const log = [];
const step = (what, detail = {}) => { log.push({ what, at: new Date().toISOString(), ...detail }); console.log(`${log.length}. ${what}`, Object.keys(detail).length ? JSON.stringify(detail) : ''); };

async function verifyPayout(onChain) {
  if (!RECORD_CONTRACT) return null;
  const transactionHash = /^https:\/\/testnet\.nearblocks\.io\/txns\/([1-9A-HJ-NP-Za-km-z]{43,44})$/.exec(onChain || '')?.[1];
  if (!transactionHash) throw new Error('The winner page did not link to a verified testnet payout.');
  const { wrap } = useNetwork('testnet');
  const amountYocto = '400000000000000000000000';
  const result = await rpc('tx_status', { tx_hash: transactionHash, sender_account_id: RECORD_WINNER, wait_until: 'FINAL' });
  const delivery = deliveryFromReceipts(result, { transactionHash, accountId: RECORD_WINNER, amountYocto, wrapContractId: wrap });
  const transfer = result.receipts?.find(receipt => receipt.predecessor_id === RECORD_CONTRACT && receipt.receiver_id === RECORD_WINNER
    && receipt.receipt?.Action?.actions?.some(action => action.Transfer?.deposit === amountYocto));
  if (result.transaction?.receiver_id !== RECORD_CONTRACT || result.transaction?.signer_id !== RECORD_WINNER
    || result.status?.SuccessValue !== 'dHJ1ZQ==' || delivery?.kind !== 'native' || !transfer
    || await viewCredit(RECORD_CONTRACT, RECORD_WINNER) !== '0') throw new Error('The filmed payout did not pass exact finalized chain checks.');
  return { network: 'testnet', contract: RECORD_CONTRACT, winner: RECORD_WINNER, transactionHash,
    transferReceipt: transfer.receipt_id, deliveredYocto: amountYocto, winnerCreditYocto: '0' };
}

try {
  // The author has a public profile, so the prediction has a public page.
  const author = await signIn('1001');
  await author.submit('/me/settings/publish', [['confirm', '1'], ['defaults', 'public']], { from: '/setup' });
  // The two bettors have signed in before and have public profiles, so their pictures show. Betting itself needs no sign-in.
  const bettors = {};
  for (const id of ['1002', '1003']) {
    bettors[id] = await signIn(id);
    await bettors[id].submit('/me/settings/publish', [['confirm', '1'], ['defaults', 'public']], { from: '/setup' });
  }
  const root = await xpost('1001', CLAIM);
  const tracked = await author.submit('/me/track', { url: `https://x.com/sim_alice/status/${root}` }, { from: '/me' });
  const saveId = /\/me\/s\/(\d+)/.exec(tracked.url)?.[1];
  if (!saveId) throw new Error('The post was not saved to the author’s profile');
  // A post added on the site starts private. The author makes this one public.
  await author.submit(`/me/saves/${saveId}/visibility`, { visibility: 'public', back: `/me/s/${saveId}` }, { from: `/me/s/${saveId}` });
  if ((await fetch(`${APP}/u/sim_alice/${saveId}`)).status !== 200) throw new Error('The prediction has no public page');
  const view = `${X}/?c=${root}`;
  const page = `${APP}/u/sim_alice/${saveId}`;
  step('A prediction is posted', { post: root });
  await scene(view, 1.8);

  let n = await count();
  const bet = await xpost('1002', '@sim_statedbot bet 0.2 no', root);
  await scene(view, 1.3);
  const offerSeconds = await answered(n + 1, 'the offer');
  const offer = (await thread(root)).at(-1);
  step('“bet 0.2 no” is answered', { seconds: offerSeconds });
  await scene(view, 2.6);

  n = await count();
  await xpost('1003', '@sim_statedbot take', offer);
  await scene(view, 1.2, { bottom: true });
  const matchSeconds = await answered(n + 1, 'the match');
  step('“take” is answered', { seconds: matchSeconds });
  await scene(view, 2.6, { bottom: true });
  await scene(page, 2.2);

  // The reviewer records the Result with its evidence, as on any prediction.
  const reviewer = await signIn('1900');
  await reviewer.submit('/setup', { profile: 'private', defaults: 'private' }, { from: '/setup' });
  const admin = await reviewer.get('/admin');
  const forms = admin.text.split('action="/admin/resolve/').slice(1);
  // On a fresh demo this is the only prediction waiting; otherwise it is found by its words.
  const form = forms.find((part) => part.includes(CLAIM.slice(0, 12))) || (forms.length === 1 ? forms[0] : null);
  if (!form) throw new Error('The prediction is not on the reviewer’s page');
  n = await count();
  await reviewer.submit(`/admin/resolve/${form.match(/^(\d+)/)[1]}`, { outcome: 'yes', url: 'https://example.com/nightjar/releases/2.0',
    note: 'Release 2.0 is tagged.', known: new Date().toISOString().slice(0, 10) }, { from: '/admin' });
  const resultSeconds = await answered(n, 'the result');
  step('The Result is recorded and the Bet is settled', { seconds: resultSeconds });
  await scene(view, 2.6, { bottom: true });
  await arrival(page, 2.8);

  // The winner's own view of the Bet.
  const winner = bettors['1003'];
  const betId = /\/bets\/([0-9a-f-]{36})/.exec((await winner.get('/me/bets')).text)?.[1];
  if (!betId) throw new Error('The winner has no Bet on their list');
  await scene(`${APP}/bets/${betId}`, 3.2, { cookies: winner.cookieHeader() });
  const paid = await winner.get(`/bets/${betId}`);
  const onChain = /Paid to your account\.\s*<a href="(https:\/\/testnet\.nearblocks\.io\/txns\/[^"]+)"/.exec(paid.text)?.[1] || null;
  const verifiedPayout = await verifyPayout(onChain);
  step('The winner sees the payout', { bet: betId, onChain, verifiedPayout });
  void bet;

  const list = frames.map((f) => `file '${f.file}'\nduration ${f.seconds}`).join('\n') + `\nfile '${frames.at(-1).file}'\n`;
  writeFileSync(`${OUT}/frames.txt`, list);
  const ff = (args) => execFileSync('ffmpeg', ['-loglevel', 'error', '-y', '-f', 'concat', '-safe', '0', '-i', `${OUT}/frames.txt`, ...args]);
  ff(['-vf', 'fps=30,format=yuv420p', '-c:v', 'libx264', '-crf', '22', '-movflags', '+faststart', `${OUT}/demo.mp4`]);
  ff(['-vf', `fps=12,scale=${W}:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=96[p];[b][p]paletteuse=dither=bayer:bayer_scale=4`, `${OUT}/demo.gif`]);
  const seconds = Number(frames.reduce((sum, f) => sum + f.seconds, 0).toFixed(1));
  writeFileSync(`${OUT}/demo.json`, `${JSON.stringify({ recordedAt: new Date().toISOString(), app: APP, x: 'simulated locally', claim: CLAIM,
    clipSeconds: seconds, frames: frames.length, steps: log }, null, 2)}\n`);
  console.log(`Wrote ${OUT}/demo.mp4 and demo.gif, ${seconds} s, ${frames.length} frames.`);
} finally {
  ws.close();
  if (chrome.exitCode === null && chrome.signalCode === null) {
    const exited = new Promise(ok => chrome.once('exit', ok));
    chrome.kill();
    await exited;
  }
  rmSync(chromeProfile, { recursive: true, force: true });
}
