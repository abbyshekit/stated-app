// Real PostgreSQL and HTTP handlers; fake X and fake NEAR only. No live funds or posts.
import test from 'node:test';
import assert from 'node:assert/strict';
import { startStack } from './support/app.mjs';
import { FakeNear } from './support/fake-near.mjs';
import { ensurePlayAccount, playAccountFor, yocto } from '../src/play.mjs';
import { queueWebMatchNotice, runBetCommands } from '../src/reply-bets.mjs';
import { reserveNearRequest } from '../src/near-request.mjs';
import { tick } from '../src/worker.mjs';

for (const network of ['testnet', 'mainnet']) {
  test(`${network}: web acceptance match notices (real PG/HTTP, fake NEAR/X)`, async (t) => {
    const real = network === 'mainnet';
    const contract = real ? 'escrow.stated.near' : 'escrow.testnet';
    const near = new FakeNear({ contract });
    if (real) near.accounts.set('stated.near', { balance: BigInt(yocto('100')), keys: new Set(['ed25519:treasury']) });
    const s = await startStack({
      STATED_NEAR_NETWORK: network, STATED_NEAR_CONTRACT: contract, STATED_PLAY: '1', STATED_PLAY_AUTOPROVISION: '1',
      STATED_REPLIES_PER_TAGGER_PER_HOUR: '100',
      ...(real ? { STATED_MAINNET: 'real-funds', STATED_TOKEN_KEY: 't'.repeat(44), STATED_PLAY_TREASURY: 'stated.near',
        STATED_PLAY_TREASURY_KEY: 'ed25519:test-only', STATED_PILOT_X_IDS: '*' } : {}),
    }, { fetchImpl: near.fetchImpl, chain: near.chain });
    try {
      await s.connectBot(s.fakeX.addUser('500', 'statedbot'));
      const creator = s.fakeX.addUser('8101', 'notice_maker');
      const taker = s.fakeX.addUser('8102', 'notice_taker');
      const outsider = s.fakeX.addUser('8103', 'notice_other');
      const sourceAuthor = s.fakeX.addUser('8104', 'source_author');
      const browsers = new Map();
      for (const person of [creator, taker, outsider]) {
        const browser = await s.signIn(person);
        await browser.submit('/setup', { profile: 'private', defaults: 'private' });
        await ensurePlayAccount(s.db, s.config, near.chain, { xUserId: person.id, username: person.username });
        const account = await playAccountFor(s.db, person.id);
        near.accounts.get(account.account_id).balance += BigInt(yocto('10'));
        browsers.set(person.id, browser);
      }
      const b = browsers.get(taker.id);
      const run = () => runBetCommands(s.db, s.config, near.chain, { fetchImpl: near.fetchImpl, botUsername: 'statedbot' });
      const offer = async () => {
        const source = s.fakeX.post(sourceAuthor.id, `A private phrase ships before March 1, ${new Date().getUTCFullYear() + 1}.`);
        const command = s.fakeX.post(creator.id, '@statedbot bet 0.1 no', { replyTo: source.id });
        await tick(s.db, s.config, s.x);
        const ran = await run();
        assert.deepEqual(ran, { done: 1, refused: 0, retry: 0, failed: 0 },
          JSON.stringify(await s.db.one('select detail from bet_commands where event_id=$1', [command.id])));
        const bet = await s.db.one('select b.* from bilateral_bets b join bet_commands c on c.bet_id=b.id where c.event_id=$1', [command.id]);
        return { ...bet, command, path: `/bets/${bet.id}` };
      };
      const take = (bet, browser = b, fields = {}) => browser.submit(`${bet.path}/take`, { termsHash: bet.terms_hash, publicConsent: '1', ...fields }, { from: `${bet.path}?join=1` });
      const notices = (bet) => s.db.many('select * from bot_outbox where dedupe_key=$1', [`match:${bet.id}`]);
      const acceptTransactions = (bet) => near.sent.filter((tx) => tx.method === 'accept_bet' && tx.args.id === bet.id);

      await t.test('queues one nonmention notice only after finalized web acceptance; retry never deposits twice', async () => {
        const bet = await offer();
        const postsBefore = s.fakeX.posts.size;
        const response = await take(bet);
        assert.equal(response.status, 200);
        assert.equal(near.bets.get(bet.id).status, 'accepted');
        const rows = await notices(bet);
        assert.equal(rows.length, 1, 'a verified web take must queue the missing match notice');
        assert.equal(rows[0].status, 'pending');
        assert.equal(rows[0].in_reply_to, bet.command.id, 'anchor to the creator who explicitly summoned the bot');
        assert.deepEqual(rows[0].exclude, (await s.db.one('select exclude from bet_commands where event_id=$1', [bet.command.id])).exclude);
        assert.ok(rows[0].exclude.includes(sourceAuthor.id), 'retain the unrelated source author exclusion');
        assert.equal(rows[0].body, `Both sides are funded. 0.2 ${real ? 'NEAR' : 'test NEAR'} is held on ${real ? 'NEAR' : 'NEAR testnet'}.`);
        assert.doesNotMatch(rows[0].body, /@|private phrase|notice_maker|notice_taker|source_author/i);
        assert.equal(s.fakeX.posts.size, postsBefore, 'HTTP acceptance queues only; it never calls X');
        await take(bet);
        assert.equal((await notices(bet)).length, 1);
        assert.equal(acceptTransactions(bet).length, 1);
        // Simulate interruption after chain finality but before the outbox insert.
        await s.db.query('delete from bot_outbox where dedupe_key=$1', [`match:${bet.id}`]);
        await take(bet);
        assert.equal((await notices(bet)).length, 1, 'the already-accepted branch repairs the missing notice');
        assert.equal(acceptTransactions(bet).length, 1, 'recovery never signs another acceptance');
      });

      await t.test('reply flag, per-creator hourly cap, daily cap and optional link use existing outbox policy', async () => {
        for (const mode of ['disabled', 'hourly', 'daily', 'link']) {
          const bet = await offer();
          const previous = { enabled: s.config.x.repliesEnabled, hourly: s.config.x.repliesPerTaggerPerHour,
            daily: s.config.play.repliesPerDay, links: s.config.x.replyLinks };
          try {
            if (mode === 'disabled') s.config.x.repliesEnabled = false;
            if (mode === 'hourly') s.config.x.repliesPerTaggerPerHour = 1;
            if (mode === 'daily') s.config.play.repliesPerDay = 1;
            if (mode === 'link') s.config.x.replyLinks = true;
            assert.equal((await take(bet)).status, 200);
            const [row] = await notices(bet);
            assert.ok(row);
            assert.equal(row.status, mode === 'link' ? 'pending' : 'held');
            assert.equal(row.in_reply_to, bet.command.id);
            assert.equal(row.body.includes(`${s.base}${bet.path}`), mode === 'link');
            assert.doesNotMatch(row.body, /@/);
          } finally {
            s.config.x.repliesEnabled = previous.enabled;
            s.config.x.repliesPerTaggerPerHour = previous.hourly;
            s.config.play.repliesPerDay = previous.daily;
            s.config.x.replyLinks = previous.links;
          }
        }
      });

      await t.test('private, unfunded, refused, failed and wrong-actor takes queue nothing', async () => {
        for (const mode of ['private', 'unfunded', 'consent', 'terms', 'csrf', 'funds', 'failed', 'actor']) {
          const bet = await offer();
          const account = await playAccountFor(s.db, taker.id);
          const balance = near.accounts.get(account.account_id).balance;
          const call = near.chain.call;
          try {
            if (mode === 'private') await s.db.query('update bilateral_bet_publications set withdrawn_at=clock_timestamp() where bet_id=$1', [bet.id]);
            if (mode === 'unfunded') {
              near.bets.delete(bet.id);
              await s.db.query('update bilateral_bets set chain_state=null where id=$1', [bet.id]);
            }
            if (mode === 'funds') {
              near.accounts.get(account.account_id).balance = 0n;
              await s.db.query('update play_accounts set granted_yocto=$2 where x_user_id=$1', [taker.id, yocto('6')]);
            }
            if (mode === 'failed') near.chain.call = async (input) => input.method === 'accept_bet'
              ? near.record({ signer: input.signerId, receiver: contract, method: input.method, args: input.args,
                deposit: input.depositYocto, failure: 'Synthetic refusal' }) : call(input);
            if (mode === 'actor') {
              await take(bet);
              await s.db.query('delete from bot_outbox where dedupe_key=$1', [`match:${bet.id}`]);
            }
            const response = mode === 'csrf'
              ? await b.request('POST', `${bet.path}/take`, { form: { termsHash: bet.terms_hash, publicConsent: '1', csrf: 'wrong' } })
              : await take(bet, mode === 'actor' ? browsers.get(outsider.id) : b,
                mode === 'consent' ? { publicConsent: '0' } : mode === 'terms' ? { termsHash: 'wrong' } : {});
            assert.ok(response.status >= 400, `${mode}: refusal must reach HTTP`);
            assert.equal((await notices(bet)).length, 0, mode);
            assert.equal(acceptTransactions(bet).length, mode === 'actor' ? 1 : 0, mode);
          } finally {
            near.chain.call = call;
            near.accounts.get(account.account_id).balance = balance;
            await s.db.query('update play_accounts set granted_yocto=$2 where x_user_id=$1', [taker.id, account.granted_yocto]);
          }
        }
      });

      await t.test('recovery requires the mapped acceptor wallet, managed account and original creator command', async () => {
        for (const mode of ['wallet', 'binding', 'claimed', 'origin', 'creator', 'consent', 'terminal']) {
          const bet = await offer();
          await take(bet);
          await s.db.query('delete from bot_outbox where dedupe_key=$1', [`match:${bet.id}`]);
          const account = await playAccountFor(s.db, taker.id);
          try {
            if (mode === 'wallet') await s.db.query('update play_accounts set account_id=$2 where x_user_id=$1', [taker.id, real ? 'other.stated.near' : 'other.testnet']);
            if (mode === 'binding') near.bets.get(bet.id).acceptor_binding_hash = 'f'.repeat(64);
            if (mode === 'claimed') await s.db.query('update play_accounts set claimed_at=clock_timestamp() where x_user_id=$1', [taker.id]);
            if (mode === 'origin') await s.db.query("update bet_commands set status='refused' where event_id=$1", [bet.command.id]);
            if (mode === 'creator') await s.db.query('update bet_commands set x_user_id=$2 where event_id=$1', [bet.command.id, outsider.id]);
            if (mode === 'consent') await s.db.query('delete from bilateral_bet_public_consents where bet_id=$1', [bet.id]);
            if (mode === 'terminal') near.settle(near.bets.get(bet.id), 'void', 'referee');
            await take(bet);
            assert.equal((await notices(bet)).length, 0, mode);
            assert.equal(acceptTransactions(bet).length, 1, mode);
          } finally {
            await s.db.query('update play_accounts set account_id=$2, claimed_at=null where x_user_id=$1', [taker.id, account.account_id]);
          }
        }
      });

      await t.test('X and web retry paths share the same match dedupe key', async () => {
        // This file has exercised the creator's hourly offer allowance already.
        await s.db.query("update bilateral_bets set created_at=clock_timestamp() - interval '2 hours'");
        const bet = await offer();
        const command = s.fakeX.post(taker.id, '@statedbot take', { replyTo: bet.command.id });
        await tick(s.db, s.config, s.x);
        assert.deepEqual(await run(), { done: 1, refused: 0, retry: 0, failed: 0 });
        const [original] = await notices(bet);
        assert.match(original.body, /@notice_maker/);
        await take(bet);
        const rows = await notices(bet);
        assert.equal(rows.length, 1);
        assert.equal(rows[0].id, original.id);
        assert.equal(rows[0].body, original.body, 'existing explicit X take copy remains unchanged');
        assert.equal(acceptTransactions(bet).length, 1);
      });

      await t.test('concurrent wallet reservation and notice use users before bet for either participant', async () => {
        for (const participant of [creator, taker]) {
          const offerBet = await offer();
          await take(offerBet);
          await s.db.query('delete from bot_outbox where dedupe_key=$1', [`match:${offerBet.id}`]);
          const bet = await s.db.one('select * from bilateral_bets where id=$1', [offerBet.id]);
          const user = await s.db.one('select * from users where x_user_id=$1', [participant.id]);
          const takerUser = await s.db.one('select * from users where x_user_id=$1', [taker.id]);
          const account = await playAccountFor(s.db, participant.id);
          let userLocked; let releaseReservation;
          const reservationReady = new Promise((resolve) => { userLocked = resolve; });
          const noticeReady = new Promise((resolve) => { releaseReservation = resolve; });
          let firstNoticeLock = null;
          const noticeDb = { tx: (fn) => s.db.tx(async (tx) => {
            await tx.query("set local lock_timeout='3s'");
            const read = (method) => async (sql, values) => {
              const userLock = /from users where[\s\S]*for share/i.test(sql);
              const betLock = sql.includes('for share of b,p');
              if (userLock && !firstNoticeLock) {
                firstNoticeLock = 'users';
                // A correct order waits here for the reservation's user lock,
                // leaving its later bet lock free to complete.
                releaseReservation();
                assert.match(sql, /order by id for share/i, 'participant locks use stable database ordering');
                assert.deepEqual(new Set(values[0].map(String)),
                  new Set([String(bet.creator_user_id), String(takerUser.id)]), 'prelock both participants, including the creator');
              }
              const result = await tx[method](sql, values);
              if (betLock && !firstNoticeLock) {
                firstNoticeLock = 'bet';
                // The old order holds the bet first, reproducing 40P01 when
                // the reservation proceeds from its user lock to that bet.
                releaseReservation();
              }
              return result;
            };
            return fn({ ...tx, one: read('one'), many: read('many') });
          }) };
          const reservationDb = { tx: (fn) => s.db.tx(async (tx) => {
            await tx.query("set local lock_timeout='3s'");
            return fn({ ...tx, one: async (sql, values) => {
              const row = await tx.one(sql, values);
              if (sql === 'select id, kind, setup_completed_at from users where id=$1 for update') {
                userLocked();
                await noticeReady;
              }
              return row;
            } });
          }) };
          const reservation = reserveNearRequest(reservationDb, { bet, user, account: account.account_id,
            method: 'propose_outcome', args: { id: bet.id, proposal_id: '99999999-9999-4999-a999-999999999999', outcome: 'void' },
            metadata: { note: 'Synthetic lock-order regression.', proposalRevision: '1' }, depositYocto: '0', contract });
          let timer; let notice;
          const deadline = new Promise((_, reject) => {
            timer = setTimeout(() => reject(new Error('Concurrency fixture exceeded its deadline')), 8000);
          });
          try {
            await Promise.race([reservationReady, deadline, reservation.then(() => {
              throw new Error('Wallet reservation completed before acquiring its user lock');
            })]);
            notice = queueWebMatchNotice(noticeDb, s.config, takerUser, bet.id);
            const results = await Promise.race([
              Promise.allSettled([notice, reservation]),
              deadline,
            ]);
            const failures = results.filter((result) => result.status === 'rejected')
              .map((result) => ({ code: result.reason.code, message: result.reason.message }));
            assert.deepEqual(failures, [], `${participant.username}: both real helpers must complete without a PostgreSQL deadlock`);
            assert.equal(firstNoticeLock, 'users', 'all participant user locks precede the publication/bet locks');
            assert.equal((await notices(bet)).length, 1);
            await queueWebMatchNotice(s.db, s.config, takerUser, bet.id);
            assert.equal((await notices(bet)).length, 1, 'concurrent completion stays idempotent');
            assert.equal(acceptTransactions(bet).length, 1, 'neither helper redeposits a stake');
          } finally {
            clearTimeout(timer);
            releaseReservation();
            await Promise.allSettled([notice, reservation]);
          }
        }
      });
    } finally { await s.close(); }
  });
}
