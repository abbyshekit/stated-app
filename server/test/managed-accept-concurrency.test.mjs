// INTEGRATION: Managed native-form acceptance across two DB pools and HTTP servers.
// Real PostgreSQL/HTTP; X, keys and NEAR are synthetic. No live funds or API calls.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { startStack, Browser } from './support/app.mjs';
import { FakeNear } from './support/fake-near.mjs';
import { FakeOutLayerNear } from './support/fake-outlayer.mjs';
import { enclaveEnv, fakeNearAi, NEARAI_BASE } from './support/enclave.mjs';
import { createDb } from '../src/db.mjs';
import { createApp } from '../src/web.mjs';
import { primaryRpc } from '../src/near-escrow.mjs';
import { prepareNearAction } from '../src/near-bets.mjs';
import { publishBet } from '../src/bet-public.mjs';
import { ensurePlayAccount, playAccountFor, playAction, yocto } from '../src/play.mjs';
import { runBetCommands } from '../src/reply-bets.mjs';
import { tick } from '../src/worker.mjs';
import { userByXId } from '../src/store.mjs';

const deferred = () => {
  let resolve;
  const promise = new Promise(done => { resolve = done; });
  return { promise, resolve };
};
async function until(probe) {
  const deadline = performance.now() + 4000;
  while (performance.now() < deadline) {
    if (await probe()) return;
    await new Promise(resolve => setTimeout(resolve, 25));
  }
  throw new Error('Synthetic concurrency barrier timed out');
}

for (const network of ['testnet', 'mainnet']) {
  test(`${network}: managed acceptance concurrency with separate DB pools`, { timeout: 30000 }, async t => {
    const real = network === 'mainnet';
    const near = real ? new FakeOutLayerNear({ contract: 'escrow.stated.near', referee: 'jury.stated.near' })
      : new FakeNear({ contract: 'escrow.testnet' });
    const ai = fakeNearAi({ respond: () => ({ source: 'evidence' }) });
    if (real) near.accounts.set('stated.near', { balance: BigInt(yocto('100')), keys: new Set(['ed25519:synthetic-bank']) });
    let s, db2, server2, failLockedBet;
    const transactionResults = new Map();
    const fetchImpl = async (url, options) => {
      if (real && new URL(url).origin === new URL(NEARAI_BASE).origin) return ai.fetchImpl(url, options);
      if (String(url) === primaryRpc()) {
        const input = JSON.parse(options.body);
        if (input.method === 'tx' && transactionResults.has(input.params.tx_hash)) return Response.json({ result: transactionResults.get(input.params.tx_hash) });
        if (failLockedBet && input.params?.method_name === 'get_bet'
          && JSON.parse(Buffer.from(input.params.args_base64, 'base64')).id === failLockedBet
          && (await s.db.one("select exists(select 1 from pg_locks where locktype='advisory' and granted) as held")).held) {
          throw new Error('SYNTHETIC: final escrow RPC unavailable under acceptance guard');
        }
        return near.rpc(input);
      }
      if (s && String(url).startsWith(`${s.fakeX.base}/`)) return fetch(url, options);
      throw new Error('This test refuses external requests');
    };
    try {
      s = await startStack({ STATED_NEAR_NETWORK: network, STATED_NEAR_CONTRACT: near.contract,
        STATED_PLAY: '1', STATED_PLAY_AUTOPROVISION: '1', STATED_REPLIES_PER_TAGGER_PER_HOUR: '100',
        ...(real ? { ...enclaveEnv, STATED_ENCLAVE_RULINGS: '', STATED_OUTLAYER_REFEREE: near.referee,
          STATED_MAINNET: 'real-funds', STATED_TOKEN_KEY: 't'.repeat(44),
          STATED_PLAY_TREASURY: 'stated.near', STATED_PLAY_TREASURY_KEY: 'ed25519:synthetic-bank',
          STATED_PILOT_X_IDS: '*' } : {}) }, { fetchImpl, chain: near.chain, intents: { tokens: async () => [] } });
      await s.connectBot(s.fakeX.addUser('500', 'statedbot'));
      const maker = s.fakeX.addUser('8601', 'race_maker');
      const alice = s.fakeX.addUser('8602', 'race_alice');
      const bob = s.fakeX.addUser('8603', 'race_bob');
      const sourceAuthor = s.fakeX.addUser('8604', 'race_source');
      const browsers = new Map();
      for (const user of [maker, alice, bob]) {
        const browser = await s.signIn(user);
        await browser.submit('/setup', { profile: 'private', defaults: 'private' });
        await ensurePlayAccount(s.db, s.config, near.chain, { xUserId: user.id, username: user.username });
        const account = await playAccountFor(s.db, user.id);
        near.accounts.get(account.account_id).balance += BigInt(yocto('10'));
        browsers.set(user.id, browser);
      }
      db2 = createDb(s.pg.url);
      let busyLockObserved = false;
      db2.pool.on('connect', client => {
        const query = client.query;
        client.query = function (...args) {
          const result = query.apply(this, args);
          if (typeof args[0] !== 'string' || !args[0].includes('pg_try_advisory_lock') || !result?.then) return result;
          return result.then(value => {
            if (value.rows.some(row => Object.values(row).includes(false))) busyLockObserved = true;
            return value;
          });
        };
      });
      let handler;
      server2 = http.createServer((req, res) => handler(req, res));
      await new Promise(resolve => server2.listen(0, '127.0.0.1', resolve));
      const base2 = `http://127.0.0.1:${server2.address().port}`;
      handler = createApp({ db: db2, config: { ...s.config, baseUrl: base2 }, fetchImpl, chain: near.chain,
        intents: { tokens: async () => [] } });
      const browser2 = user => {
        const browser = new Browser(base2);
        browser.jar = new Map(browsers.get(user.id).jar);
        return browser;
      };
      const offer = async () => {
        const source = s.fakeX.post(sourceAuthor.id, `SYNTHETIC: a release ships before March 1, ${new Date().getUTCFullYear() + 1}.`);
        const command = s.fakeX.post(maker.id, '@statedbot bet 0.1 no', { replyTo: source.id });
        await tick(s.db, s.config, s.x);
        assert.equal((await runBetCommands(s.db, s.config, near.chain, { fetchImpl, botUsername: 'statedbot' })).done, 1);
        if (real) {
          const row = await s.db.one('select bet_id from bet_commands where event_id=$1', [command.id]);
          const user = await userByXId(s.db, maker.id);
          await playAction(s.db, s.config, near.chain, user, row.bet_id, { action: 'fund' }, { fetchImpl });
          await publishBet(s.db, user, row.bet_id);
        }
        return s.db.one('select b.* from bilateral_bets b join bet_commands c on c.bet_id=b.id where c.event_id=$1', [command.id]);
      };
      const send = async (browser, bet) => {
        const path = `/bets/${bet.id}?join=1`;
        const page = await browser.get(path);
        return browser.request('POST', `/bets/${bet.id}/take`, { headers: { referer: `${browser.base}${path}` },
          form: { csrf: browser.csrf(page), termsHash: bet.terms_hash, publicConsent: '1' } });
      };
      const counts = async bet => ({
        calls: near.sent.filter(tx => tx.method === 'accept_bet' && tx.args?.id === bet.id).length,
        notices: (await s.db.one('select count(*)::int as n from bot_outbox where dedupe_key=$1', [`match:${bet.id}`])).n,
        requests: await s.db.many('select execution_status,transaction_hash from bilateral_near_requests where bet_id=$1 and method=$2', [bet.id, 'accept_bet']),
      });

      for (const uppercaseRetry of [false, true]) await t.test(`same actor retries during signing without a second broadcast or false error${uppercaseRetry ? ' across UUID case aliases' : ''}`, async () => {
        const bet = await offer(), entered = deferred(), release = deferred();
        const original = near.chain.call;
        let callsEntered = 0, secondDone = false;
        busyLockObserved = false;
        near.chain.call = async input => {
          if (input.method === 'accept_bet' && input.args.id === bet.id && ++callsEntered === 1) {
            entered.resolve(); await release.promise;
          }
          return original(input);
        };
        let first, second;
        try {
          first = send(browsers.get(alice.id), bet).then(response => ({ response }), error => ({ error }));
          await entered.promise;
          second = send(browser2(alice), uppercaseRetry ? { ...bet, id: bet.id.toUpperCase() } : bet)
            .then(response => { secondDone = true; return { response }; }, error => { secondDone = true; return { error }; });
          await until(async () => callsEntered >= 2 || secondDone || busyLockObserved
            || (await s.db.one("select exists(select 1 from pg_locks where locktype in ('advisory','transactionid','tuple') and not granted) as waiting")).waiting);
          release.resolve();
          const results = await Promise.all([first, second]);
          const observed = await counts(bet);
          assert.deepEqual({ statuses: results.map(value => value.response?.status || 'error'), calls: observed.calls, notices: observed.notices },
            { statuses: [303, 303], calls: 1, notices: 1 });
          assert.equal(observed.requests.length, 1);
          assert.equal(observed.requests[0].execution_status, 'succeeded');
          assert.ok(observed.requests[0].transaction_hash);
          assert.equal((await send(browser2(alice), bet)).status, 303);
          assert.equal((await counts(bet)).calls, 1, 'completed replay must not sign again');
        } finally {
          release.resolve();
          await Promise.all([first, second].filter(Boolean));
          near.chain.call = original;
        }
      });

      await t.test('failed signing releases the guard and permits a genuine retry', async () => {
        const bet = await offer();
        const original = near.chain.call;
        let fail = true;
        near.chain.call = async input => {
          if (input.method === 'accept_bet' && input.args.id === bet.id && fail) {
            fail = false; throw new Error('SYNTHETIC: transport failed before submission');
          }
          return original(input);
        };
        try {
          assert.equal((await send(browsers.get(alice.id), bet)).status, 500);
          assert.equal(near.bets.get(bet.id).status, 'offered');
          assert.equal((await send(browser2(alice), bet)).status, 303);
          assert.deepEqual({ calls: (await counts(bet)).calls, notices: (await counts(bet)).notices }, { calls: 1, notices: 1 });
        } finally { near.chain.call = original; }
      });

      if (!real) await t.test('a fresh recipient in two tabs provisions and accepts only once', async () => {
        const fresh = s.fakeX.addUser('8605', 'race_fresh');
        const browser = await s.signIn(fresh);
        await browser.submit('/setup', { profile: 'private', defaults: 'private' });
        browsers.set(fresh.id, browser);
        const bet = await offer(), entered = deferred(), release = deferred();
        const original = near.chain.createAccount;
        let createCalls = 0, secondDone = false;
        busyLockObserved = false;
        near.chain.createAccount = async input => {
          if (input.accountId.startsWith(`${fresh.username}.`) && ++createCalls === 1) {
            entered.resolve(); await release.promise;
          }
          return original(input);
        };
        let first, second;
        try {
          first = send(browser, bet).then(response => ({ response }), error => ({ error }));
          await entered.promise;
          second = send(browser2(fresh), bet).then(response => { secondDone = true; return { response }; }, error => { secondDone = true; return { error }; });
          await until(() => createCalls >= 2 || secondDone || busyLockObserved);
          release.resolve();
          const results = await Promise.all([first, second]);
          assert.deepEqual({ statuses: results.map(value => value.response?.status || 'error'), creates: createCalls,
            accepts: (await counts(bet)).calls }, { statuses: [303, 303], creates: 1, accepts: 1 });
          assert.equal((await playAccountFor(s.db, fresh.id)).ready, true);
          assert.equal((await counts(bet)).notices, 1);
        } finally {
          release.resolve(); await Promise.all([first, second].filter(Boolean)); near.chain.createAccount = original;
        }
      });

      await t.test('a different recipient is never credited with the winning private binding', async () => {
        const bet = await offer(), entered = deferred(), release = deferred();
        const original = near.chain.call;
        let callsEntered = 0, secondDone = false;
        near.chain.call = async input => {
          if (input.method === 'accept_bet' && input.args.id === bet.id && ++callsEntered === 1) {
            entered.resolve(); await release.promise;
          }
          return original(input);
        };
        let first, second;
        try {
          first = send(browsers.get(alice.id), bet).then(response => ({ response }), error => ({ error }));
          await entered.promise;
          second = send(browser2(bob), bet).then(response => { secondDone = true; return { response }; }, error => { secondDone = true; return { error }; });
          await until(() => callsEntered >= 2 || secondDone);
          release.resolve();
          const results = await Promise.all([first, second]);
          assert.ok([404, 409].includes(results[0].response?.status));
          assert.equal(results[1].response?.status, 303);
          const winner = await s.db.one('select acceptor_user_id,acceptor_wallet from bilateral_bets where id=$1', [bet.id]);
          assert.equal(String(winner.acceptor_user_id), String((await s.db.one('select id from users where x_user_id=$1', [bob.id])).id));
          assert.equal(winner.acceptor_wallet, (await playAccountFor(s.db, bob.id)).account_id);
          assert.equal((await counts(bet)).notices, 1);
          const requests = await counts(bet);
          assert.deepEqual(requests.requests.map(row => row.execution_status).sort(), ['failed', 'succeeded']);
        } finally {
          release.resolve(); await Promise.all([first, second].filter(Boolean)); near.chain.call = original;
        }
      });

      await t.test('a recorded pending transaction is checked without another signature or false acceptance', async () => {
        const bet = await offer();
        const user = await s.db.one('select * from users where x_user_id=$1', [alice.id]);
        const account = await playAccountFor(s.db, alice.id);
        const prepared = await prepareNearAction(s.db, s.config, user, bet.id,
          { action: 'accept', accountId: account.account_id, termsHash: bet.terms_hash }, { fetchImpl });
        const hash = '11111111111111111111111111111111';
        transactionResults.set(hash, { final_execution_status: 'INCLUDED' });
        await s.db.query("update bilateral_near_requests set transaction_hash=$2,execution_status='pending' where id=$1", [prepared.requestId, hash]);
        for (const [browser, reference] of [
          [browsers.get(alice.id), bet],
          [browser2(alice), { ...bet, id: bet.id.toUpperCase() }],
        ]) {
          assert.equal((await send(browser, reference)).status, 303);
          assert.equal((await browser.get(`/bets/${bet.id}`)).text.includes('Both sides are in'), false,
            'an unresolved transaction must not be presented as accepted');
        }
        let observed = await counts(bet);
        assert.equal(observed.calls, 0);
        assert.equal(observed.notices, 0);
        assert.deepEqual(observed.requests, [{ execution_status: 'pending', transaction_hash: hash }]);
        assert.equal(near.bets.get(bet.id).status, 'offered');
        transactionResults.set(hash, { final_execution_status: 'FINAL', transaction: {
          hash, signer_id: account.account_id, receiver_id: near.contract,
          actions: [{ FunctionCall: { method_name: 'accept_bet', args: Buffer.from(JSON.stringify(prepared.args)).toString('base64'),
            deposit: prepared.depositYocto, gas: 100000000000000 } }] }, status: { Failure: { ActionError: {} } } });
        assert.equal((await send(browser2(alice), bet)).status, 409);
        assert.equal((await counts(bet)).requests[0].execution_status, 'failed');
        assert.equal((await send(browser2(alice), bet)).status, 303);
        observed = await counts(bet);
        assert.equal(observed.calls, 1);
        assert.equal(observed.notices, 1);
        assert.equal(observed.requests[0].execution_status, 'succeeded');
        assert.notEqual(observed.requests[0].transaction_hash, hash);
      });

      await t.test('an unavailable final snapshot never permits signing and does not strand the guard', async () => {
        const bet = await offer();
        failLockedBet = bet.id;
        try {
          assert.equal((await send(browser2(alice), bet)).status, 503);
          assert.equal((await counts(bet)).calls, 0);
          assert.equal((await counts(bet)).notices, 0);
          assert.equal(near.bets.get(bet.id).status, 'offered');
        } finally { failLockedBet = null; }
        assert.equal((await send(browser2(alice), bet)).status, 303);
        assert.equal((await counts(bet)).calls, 1);
        assert.equal((await counts(bet)).notices, 1);
      });
    } finally {
      if (server2) await new Promise(resolve => server2.close(resolve));
      if (db2) await db2.close();
      if (s) await s.close();
    }
  });
}
