import test, { before, after } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { KeyPair, SignedTransaction, baseEncode } from 'near-api-js';
import { InvalidNonceError, TransactionExpiredError } from 'near-api-js/rpc-errors';
import { createDb } from '../src/db.mjs';
import { seal } from '../src/crypto.mjs';
import { UserError } from '../src/store.mjs';
import { verifyBetTransaction } from '../src/near-execution-state.mjs';
import { assertSignerAvailable, ensureFunds, inPilot, nearChain, playAccountFor, reservePlaySigner,
  secretOf, withAvailablePlaySigner, yocto } from '../src/play.mjs';
import { useNetwork } from '../src/near-network.mjs';
import { startPostgres } from './support/pg.mjs';

let db, pg;
before(async () => { useNetwork('mainnet'); pg = await startPostgres(); db = createDb(pg.url); await db.migrate(); });
after(async () => { await db?.close(); pg?.stop(); });
const config = { nearContract: 'escrow.stated.near', near: { real: true }, tokenKey: 'synthetic-replay-key',
  play: { enabled: true, pilotXIds: ['*'], fundsStakes: false } };
const hash = value => baseEncode(createHash('sha256').update(value).digest());

for (const action of ['fund', 'accept']) {
  for (const consumed of [false, true]) {
    test(`${action}: expired persisted replay ${consumed ? 'retains ambiguous consumed-nonce bytes' : 'recovers with proven never-executed replacement'}`, async () => {
      const state = { nonce: 10, height: 100, signed: [], broadcasts: [], completed: new Map() };
      const fetchImpl = async (_url, options) => {
        const { id, method, params } = JSON.parse(options.body);
        const reply = result => Response.json({ jsonrpc: '2.0', id, result });
        const failure = (name, invalid) => Response.json({ jsonrpc: '2.0', id, error: { code: -32000,
          message: 'Server error', cause: { name }, ...(invalid ? { data: { TxExecutionError: { InvalidTxError: invalid } } } : {}) } });
        if (method === 'gas_price') return reply({ gas_price: '1000000000' });
        if (method === 'EXPERIMENTAL_protocol_config') return reply({ transaction_validity_period: 100, protocol_version: 85,
          runtime_config: { min_gas_purchase_price: '1000000000', storage_amount_per_byte: '10000000000000000000' } });
        if (method === 'block') {
          const height = params.block_id === hash('block100') ? 100 : state.height;
          return reply({ header: { hash: hash(`block${height}`), height } });
        }
        if (method === 'query') return reply(params.request_type === 'view_access_key'
          ? { nonce: state.nonce, permission: 'FullAccess' } : { amount: yocto('1'), storage_usage: 182 });
        if (method === 'tx' || method === 'tx_status') return state.completed.has(params.tx_hash)
          ? reply(state.completed.get(params.tx_hash)) : failure('UNKNOWN_TRANSACTION');
        assert.equal(method, 'send_tx');
        state.broadcasts.push(params.signed_tx_base64);
        const signed = SignedTransaction.decode(Buffer.from(params.signed_tx_base64, 'base64'));
        if (baseEncode(Buffer.from(signed.transaction.blockHash)) === hash('block100')) return failure('INVALID_TRANSACTION', 'Expired');
        assert.equal(Number(signed.transaction.nonce), state.nonce + 1);
        state.nonce++;
        const call = signed.transaction.actions[0].functionCall;
        const transactionHash = baseEncode(createHash('sha256').update(signed.transaction.encode()).digest());
        const result = { final_execution_status: 'FINAL', status: { SuccessValue: '' }, transaction: {
          hash: transactionHash, signer_id: signed.transaction.signerId, receiver_id: signed.transaction.receiverId,
          actions: [{ FunctionCall: { method_name: call.methodName, args: Buffer.from(call.args).toString('base64'),
            deposit: call.deposit.toString(), gas: call.gas.toString() } }] } };
        state.completed.set(transactionHash, result);
        return reply(result);
      };
      const chain = nearChain({ fetchImpl });
      const prepare = chain.prepareCall;
      chain.prepareCall = async input => { const signed = await prepare(input); state.signed.push(signed); return signed; };
      const key = KeyPair.fromRandom('ed25519');
      const xUserId = randomUUID(), accountId = `replay-${xUserId.slice(0, 8)}.stated.near`;
      const user = await db.one("insert into users(x_user_id,x_username,setup_completed_at) values($1,'synthetic',now()) returning *", [xUserId]);
      await db.query('insert into play_accounts(x_user_id,account_id,public_key,secret_sealed,ready) values($1,$2,$3,$4,true)',
        [xUserId, accountId, key.getPublicKey().toString(), seal(key.toString(), config.tokenKey)]);
      const bet = await db.one(`insert into bilateral_bets(id,creator_user_id,request_id,claim,criteria,evidence_source_url,
        creator_side,stake_yocto,accept_by,resolve_at,terms_hash,terms_salt,chain_state) values($1,$2,$3,'Synthetic','Synthetic',
        'https://example.test','yes',$4,now()+interval '1 hour',now()+interval '2 hours','terms','salt','{"status":"offered"}') returning *`,
        [randomUUID(), user.id, randomUUID(), yocto('0.1')]);
      const binding = createHash('sha256').update(randomUUID()).digest('hex');
      const request = await db.one(`insert into bilateral_near_requests(id,bet_id,user_id,wallet_account,method,args,binding_hash,metadata)
        values($1,$2,$3,$4,$5,$6,$7,$8) returning *`, [randomUUID(), bet.id, user.id, accountId,
        action === 'fund' ? 'create_bet' : 'accept_bet', { id: bet.id, binding_hash: binding }, binding,
        { contract: config.nearContract, depositYocto: bet.stake_yocto }]);
      const original = await reservePlaySigner(db, chain, accountId, `request:${request.id}`,
        () => chain.prepareCall({ signerId: accountId, secret: key.toString(), contractId: config.nearContract,
          method: request.method, args: request.args, depositYocto: request.metadata.depositYocto }), { requestId: request.id });
      assert.equal(state.broadcasts.length, 0, 'simulate interruption after durable signing and before broadcast');
      state.height = 201;
      if (consumed) state.nonce = 11;
      const source = await readFile(process.env.STATED_TEST_SOURCE_ROOT ? `${process.env.STATED_TEST_SOURCE_ROOT}/play.mjs`
        : new URL('../src/play.mjs', import.meta.url), 'utf8');
      const body = source.slice(source.indexOf('async function performPlayAction('), source.indexOf('/** The referee settles'));
      const deps = { assertPlay: () => {}, playAccountFor, secretOf, ensureFunds, inPilot, assertSignerAvailable,
        reservePlaySigner, withAvailablePlaySigner, verifyBetTransaction, UserError, InvalidNonceError, TransactionExpiredError,
        GAS: 100000000000000n, prepareNearAction: () => assert.fail('retry must retain its original request'), syncNearBet: async () => bet };
      const perform = new Function(...Object.keys(deps), `${body};return performPlayAction`)(...Object.values(deps));
      const result = await perform(db, config, chain, user, bet.id, { action, termsHash: bet.terms_hash }, { fetchImpl });
      const persisted = await db.one('select * from bilateral_near_requests where id=$1', [request.id]);
      assert.equal(result.hash, persisted.transaction_hash, 'verify and return the actual reserved replacement hash');
      assert.equal(result.status, consumed ? 'pending' : 'succeeded');
      assert.equal(state.signed.length, consumed ? 1 : 2);
      if (consumed) {
        assert.equal(persisted.signed_transaction, original.signedTransaction);
        assert.deepEqual(state.broadcasts, [original.signedTransaction]);
      } else {
        assert.notEqual(persisted.transaction_hash, original.hash);
        assert.equal(state.completed.size, 1);
        assert.equal(state.broadcasts.length, 1, 'expired original bytes are not broadcast after replacement proof');
        assert.equal(persisted.execution_status, 'succeeded');
      }
    });
  }
}
