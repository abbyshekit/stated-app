// INTEGRATION: Keep the source guard and shipped wallet bundle aligned with settlement intents.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import vm from 'node:vm';

const source = readFileSync(new URL('../public/wallet-client.mjs', import.meta.url), 'utf8')
  .replace(/^import .+;\n/gm, '');

for (const method of ['finalize_unanswered', 'referee_resolve', 'submit_evidence']) {
  test(`the browser accepts ${method} and rejects unrelated wallet methods`, () => {
    const requestId = '1102581f-dc77-4d06-886e-8aa4b006ff26';
    const payload = { requestId, accountId: 'bettor.testnet', contract: 'escrow.testnet',
      method, args: { id: 'a-bet', proposal_id: 'a-proposal', expected_revision: '1' },
      depositYocto: '0', gas: '100000000000000' };
    const form = { elements: { namedItem(name) {
      return { value: name === 'walletPayload' ? JSON.stringify(payload) : requestId };
    } } };
    const context = { form, setEnvConfig() {}, document: { querySelectorAll: () => [] } };
    const script = new vm.Script(source + '\nreadPayload(form, "testnet");');
    const parsed = script.runInNewContext({ ...context });
    assert.equal(parsed.method, method);
    assert.equal(parsed.args.expected_revision, '1');
    payload.method = 'delete_account';
    assert.throws(() => script.runInNewContext({ ...context }), /Invalid request/);
  });
}

test('the shipped wallet bundle includes every server wallet method and the reviewed settlement methods', () => {
  const server = readFileSync(new URL('../src/near-request.mjs', import.meta.url), 'utf8');
  const bundle = readFileSync(new URL('../public/wallet.js', import.meta.url), 'utf8');
  const serverMethods = [...server.match(/const METHODS = new Set\(\[([^\]]+)\]/)[1].matchAll(/'([^']+)'/g)].map(match => match[1]);
  const bundledMethods = JSON.parse(bundle.match(/\[("create_bet","accept_bet"[^\]]+)\]/)[0]);
  assert.ok(serverMethods.length >= 10);
  for (const method of [...serverMethods, 'referee_resolve']) assert.ok(bundledMethods.includes(method), `Bundle rejects ${method}`);
  assert.ok(!bundledMethods.includes('delete_account'));
});
