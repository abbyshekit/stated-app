// INTEGRATION: Actual demo process, temporary Postgres and loopback-only synthetic NEAR RPC.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import http from 'node:http';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { test } from 'node:test';
import { createBet } from '../src/bets.mjs';
import { createDb } from '../src/db.mjs';
import { prepareNearAction } from '../src/near-bets.mjs';
import { TESTNET_RPC } from '../src/near-escrow.mjs';
import { completeSetup, ensureDesk, signInFromX } from '../src/store.mjs';
import { startPostgres } from './support/pg.mjs';

const hash = '11111111111111111111111111111111';
const ns = value => (BigInt(new Date(value).getTime()) * 1000000n).toString();
const sleep = ms => new Promise(resolveSleep => setTimeout(resolveSleep, ms));

async function freePort() {
  const server = net.createServer();
  await new Promise((resolveListen, reject) => server.once('error', reject).listen(0, '127.0.0.1', resolveListen));
  const { port } = server.address();
  await new Promise(resolveClose => server.close(resolveClose));
  return port;
}

test('simulated-X startup reconciles external escrow and pending transaction without a verification POST', { timeout: 20000 }, async () => {
  let pg, db, rpcServer, child, directory;
  let stdout = '', stderr = '', calls = [];
  try {
    directory = await mkdtemp(join(tmpdir(), 'stated-demo-near-'));
    const blockedPath = join(directory, 'blocked');
    const preloadPath = join(directory, 'preload.mjs');
    pg = await startPostgres();
    db = createDb(pg.url);
    await db.migrate();
    await ensureDesk(db);
    const user = await completeSetup(db, await signInFromX(db, { id: '98501', username: 'demo_near_owner' }), {});
    const bet = await createBet(db, user, { requestId: randomUUID(), claim: 'Synthetic demo reconciliation', criteria: 'Official result',
      evidenceSourceUrl: 'https://example.org/result', creatorSide: 'yes', stakeNear: '0.1',
      acceptBy: new Date(Date.now() + 86400000).toISOString(), resolveAt: new Date(Date.now() + 172800000).toISOString() });
    const config = { nearContract: 'escrow.testnet' };
    const emptyRpc = async () => new Response(JSON.stringify({ jsonrpc: '2.0', id: 'stated', result: { block_height: 1, result: [...Buffer.from('null')] } }));
    const prepared = await prepareNearAction(db, config, user, bet.id, { action: 'fund', accountId: 'creator.testnet' }, { fetchImpl: emptyRpc });
    const request = await db.one('select * from bilateral_near_requests where id=$1', [prepared.requestId]);
    await db.query('update bilateral_near_requests set transaction_hash=$2 where id=$1', [request.id, hash]);
    const chain = { id: bet.id, terms_hash: bet.terms_hash, stake_yocto: bet.stake_yocto, creator_side: bet.creator_side,
      accept_by_ns: ns(bet.accept_by), resolve_at_ns: ns(bet.resolve_at), invited_account: null,
      creator: 'creator.testnet', creator_binding_hash: prepared.args.binding_hash, acceptor: null, proposal: null, status: 'offered' };
    const tx = { final_execution_status: 'FINAL', transaction: { hash, signer_id: request.wallet_account,
      receiver_id: request.metadata.contract, actions: [{ FunctionCall: { method_name: request.method,
        args: Buffer.from(JSON.stringify(request.args)).toString('base64'), deposit: request.metadata.depositYocto, gas: 100000000000000 } }] },
    status: { SuccessValue: '' } };
    rpcServer = http.createServer(async (req, res) => {
      const chunks = [];
      for await (const chunk of req) chunks.push(chunk);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      calls.push(body.method);
      let result;
      if (body.method === 'query' && body.params.method_name === 'get_bet') {
        const args = JSON.parse(Buffer.from(body.params.args_base64, 'base64'));
        result = { block_height: 100, result: [...Buffer.from(JSON.stringify(args.id === bet.id ? chain : null))] };
      } else if (body.method === 'tx') result = tx;
      else { res.writeHead(400); res.end(); return; }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ jsonrpc: '2.0', id: 'stated', result }));
    });
    await new Promise((resolveListen, reject) => rpcServer.once('error', reject).listen(0, '127.0.0.1', resolveListen));
    const rpcUrl = `http://127.0.0.1:${rpcServer.address().port}`;
    await writeFile(preloadPath, `import { appendFileSync } from 'node:fs';\nconst original = globalThis.fetch;\nglobalThis.fetch = (input, options) => {\n  const url = new URL(typeof input === 'string' || input instanceof URL ? input : input.url);\n  if (url.href === ${JSON.stringify(`${TESTNET_RPC}/`)}) return original(${JSON.stringify(rpcUrl)}, options);\n  if (url.hostname === '127.0.0.1' && url.protocol === 'http:') return original(input, options);\n  appendFileSync(${JSON.stringify(blockedPath)}, url.origin + '\\n');\n  throw new Error('Blocked non-loopback fetch');\n};\n`);
    const appPort = await freePort();
    let xPort = await freePort();
    while (xPort === appPort) xPort = await freePort();
    child = spawn(process.execPath, ['--import', pathToFileURL(preloadPath).href, resolve('server/dev/simulated-x.mjs')], {
      cwd: resolve('.'), env: { PATH: process.env.PATH, DATABASE_URL: pg.url, PORT: String(appPort), SIM_X_PORT: String(xPort),
        SIM_X_STATE: join(directory, 'sim-x.json'), STATED_NEAR_CONTRACT: 'escrow.testnet' },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', data => { stdout += data; });
    child.stderr.on('data', data => { stderr += data; });
    let state;
    const until = Date.now() + 6000;
    while (Date.now() < until) {
      if (child.exitCode !== null) break;
      state = await db.one(`select b.chain_state, r.execution_status from bilateral_bets b
        join bilateral_near_requests r on r.bet_id=b.id where r.id=$1`, [request.id]);
      if (state.chain_state && state.execution_status === 'succeeded') break;
      await sleep(100);
    }
    assert.match(stdout, /Stated \(simulated X\):/, `demo must start; stderr: ${stderr}`);
    const readiness = await fetch(`http://127.0.0.1:${appPort}/demo-readiness`);
    assert.equal(readiness.status, 200);
    assert.match(await readiness.text(), /Reply betting is not configured for this testnet demo/);
    assert.equal((await fetch(`http://127.0.0.1:${appPort}/demo-challenge`)).status, 404);
    assert.equal((await fetch(`http://127.0.0.1:${appPort}/healthz`)).status, 200);
    assert.equal(await readFile(blockedPath, 'utf8').catch(error => error.code === 'ENOENT' ? '' : Promise.reject(error)), '');
    assert.deepEqual(state?.chain_state, chain, 'external funding must reconcile without a verification POST');
    assert.equal(state.execution_status, 'succeeded');
    assert.ok(calls.includes('query') && calls.includes('tx'), 'both synthetic RPC methods were exercised');
  } finally {
    if (child && child.exitCode === null && child.signalCode === null) {
      const exited = new Promise(resolveExit => child.once('exit', resolveExit));
      child.kill('SIGTERM');
      let timer;
      await Promise.race([exited, new Promise(resolveTimeout => { timer = setTimeout(resolveTimeout, 2000); })]);
      clearTimeout(timer);
      if (child.exitCode === null && child.signalCode === null) { child.kill('SIGKILL'); await exited; }
    }
    if (rpcServer?.listening) await new Promise(resolveClose => rpcServer.close(resolveClose));
    if (db) await db.close();
    if (pg) pg.stop();
    if (directory) await rm(directory, { recursive: true, force: true });
  }
});
