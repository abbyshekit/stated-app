// INTEGRATION: Public, read-only proof for the two operator-controlled mainnet trials.
// Importing this file performs no network request, credential read, or filesystem write.
import { writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { pathToFileURL } from 'node:url';
import { canonicalJson, fingerprint } from '../server/src/canonical.mjs';
import { rpc } from '../server/src/near-escrow.mjs';
import { deliveryFromReceipts } from '../server/src/near-delivery.mjs';
import { judgeOptions, runOutlayerJudge } from './judge-chain.mjs';

const ESCROW = 'escrow.statedforecast.near';
const REFEREE = 'referee.statedforecast.near';
const WINNER = 'abhishekesq.play.statedforecast.near';
const OPPONENT = 'statedforecast.play.statedforecast.near';
const OPERATOR = 'play.statedforecast.near';
const SOURCE = 'https://www.iana.org/help/example-domains';
const STAKE = '100000000000000000000000';
const POT = '200000000000000000000000';
const PROVIDERS = ['https://free.rpc.fastnear.com', 'https://near.drpc.org'];
const MODELS = ['Qwen/Qwen3.8-27B', 'deepseek-ai/DeepSeek-V4.1-Flash-1017', 'z-ai/glm-5.3-flash'];
const CASES = [
  { id: '52fe13e9-0bc5-4dd1-9ff9-6dfecfe2bb25', outcome: 'yes',
    register: '36Wpp2HdUy8GXm8WDY3kEGvb9owcuo13zWXnEo6rZ9yG',
    ruling: 'H7pZgi5CkGZ99JzRhBA5jvU8Ky3NWSDSgf4AQyKKxrrS',
    withdrawal: 'Cd1bvxP93A8DEmF4mU27tjMvDXiQkYSyt44NrzbhRiQm',
    withdrawalTag: '74749781-2399-40cb-baed-f63d3817df89',
    materialHash: '4e75465031fb904c335f728c4ddbf0cebf733aa50c5110bafad4470977c0d32f' },
  { id: '8e3b3349-bb3e-4d83-80c3-6c133c0652d8', outcome: 'no',
    register: '5CBYVhTzDnTsZe8nrxJNgvndPhWpubAJ4iHzKsdVqVnH',
    ruling: '5GVdQRjuGfNZV8QRdu6DZBTyWUPuFWitKLw8FkE4u6XK',
    withdrawal: 'CPgughxzKn2segrVaDSR8d56wKFC1PSDn48GyS1Pchwy',
    withdrawalTag: 'ec691e2f-29bc-4faf-af8c-48d8c506cd2c',
    materialHash: '4f0371d3372cb8fcb34af8b68fa70d0eafb16e040062bc558df32fcfb290d93f' },
];
const JUDGE_FLAGS = [
  '--outlayer', '--network', 'mainnet', '--escrow', ESCROW, '--referee', REFEREE,
  '--referee-sha256', '1f6b35b9fce99165af5090ff04d4ff6493933ec90ab3c0a37a532255bf46ed83',
  '--jury-sha256', '85198c7afbfca6ad6cb42c76fe064abdf480d18f4db4955b90ce205d768d9791',
  '--wasm-url', 'https://stated-production.up.railway.app/static/outlayer/stated-jury-85198c7afbfca6ad6cb42c76fe064abdf480d18f4db4955b90ce205d768d9791.wasm',
  '--outlayer-contract', 'outlayer.near', '--secrets-owner', 'statedforecast.near', '--secrets-profile', 'jury',
];
const need = (condition, message) => { if (!condition) throw new Error(message); };
const same = (a, b) => canonicalJson(a) === canonicalJson(b);
// Same canonical envelope as outlayerTermsHash in server/src/outlayer.mjs; importing
// that server module would also load its database and signer dependencies.
const outlayerTermsHash = (material, salt) => fingerprint({ domain: 'stated-outlayer-v1', material, salt });
// Same ordered MaterialFields serialization as stated-jury::material_hash and
// server/src/enclave-ruling.mjs materialHash (both inspected before using it).
const juryMaterialHash = (material, termsHash) => createHash('sha256').update(JSON.stringify({
  claim: material.claim, madeAt: material.made_at, deadline: material.deadline,
  postUrl: material.post_url, bets: [{ id: material.bet_id, termsHash }],
})).digest('hex');

function callArgs(tx, hash, signer, receiver, method, args, gas, deposit = '0') {
  need(tx?.final_execution_status === 'FINAL' && typeof tx.status?.SuccessValue === 'string'
    && Object.keys(tx.status).length === 1, `${method}: transaction not final and successful`);
  const transaction = tx.transaction;
  need(transaction?.hash === hash && transaction.signer_id === signer && transaction.receiver_id === receiver,
    `${method}: transaction identity mismatch`);
  const actions = transaction.actions;
  need(actions?.length === 1 && Object.keys(actions[0]).length === 1
    && Object.hasOwn(actions[0], 'FunctionCall'), `${method}: unexpected actions`);
  const call = actions[0].FunctionCall;
  need(call.method_name === method && call.deposit === deposit && String(call.gas) === gas,
    `${method}: unexpected call method, gas, or deposit`);
  const encoded = call.args;
  const text = Buffer.from(encoded, 'base64').toString('utf8');
  let parsed;
  try { parsed = JSON.parse(text); } catch { throw new Error(`${method}: invalid call arguments`); }
  need(JSON.stringify(parsed) === text && same(parsed, args), `${method}: call arguments mismatch`);
}

function linkedReceipt(tx, receiptId) {
  const receipts = new Map(tx.receipts?.map(item => [item.receipt_id, item]));
  const outcomes = new Map(tx.receipts_outcome?.map(item => [item.id, item.outcome]));
  need(receipts.size === tx.receipts?.length && outcomes.size === tx.receipts_outcome?.length,
    'duplicate or missing receipt records');
  const initial = tx.transaction_outcome;
  const transaction = tx.transaction;
  const root = initial?.outcome?.status?.SuccessReceiptId;
  need(initial?.id === transaction.hash && initial.outcome.executor_id === transaction.signer_id
    && root && same(initial.outcome.receipt_ids, [root]), 'transaction root receipt missing');
  const rootReceipt = receipts.get(root);
  need(rootReceipt?.predecessor_id === transaction.signer_id
    && rootReceipt.receiver_id === transaction.receiver_id
    && rootReceipt.receipt?.Action?.signer_id === transaction.signer_id
    && same(rootReceipt.receipt.Action.actions, transaction.actions), 'root receipt does not match transaction');
  const seen = new Set();
  const queue = [{ id: root, parent: transaction.signer_id }];
  while (queue.length) {
    const { id, parent } = queue.shift();
    need(!seen.has(id) && receipts.has(id) && outcomes.has(id), 'invalid receipt linkage');
    seen.add(id);
    const receipt = receipts.get(id);
    const outcome = outcomes.get(id);
    need((receipt.predecessor_id === parent || receipt.predecessor_id === 'system' && id !== root)
      && receipt.receiver_id === outcome.executor_id && Array.isArray(outcome.receipt_ids)
      && (receipt.predecessor_id === 'system'
        || receipt.receipt?.Action?.signer_id === transaction.signer_id),
    'receipt predecessor, signer, or executor mismatch');
    queue.push(...outcome.receipt_ids.map(child => ({ id: child, parent: receipt.receiver_id })));
  }
  need(seen.size === receipts.size && seen.has(receiptId), 'settlement receipt detached');
}

async function providerCase(endpoint, record, fetchImpl) {
  const options = { fetchImpl, urls: [endpoint] };
  const query = (method, params) => rpc(method, params, options);
  const view = async (accountId, method, args = {}) => {
    const result = await query('query', { request_type: 'call_function', finality: 'final', account_id: accountId,
      method_name: method, args_base64: Buffer.from(JSON.stringify(args)).toString('base64') });
    need(Array.isArray(result?.result), `${method}: invalid view result`);
    return JSON.parse(Buffer.from(result.result).toString('utf8'));
  };
  const tx = (hash, signer) => query('EXPERIMENTAL_tx_status', { tx_hash: hash, sender_account_id: signer, wait_until: 'FINAL' });
  const [bet, ruling, registration, request, withdrawal] = await Promise.all([
    view(ESCROW, 'get_bet', { id: record.id }), view(REFEREE, 'get_ruling', { bet_id: record.id }),
    tx(record.register, OPERATOR), tx(record.ruling, OPERATOR), tx(record.withdrawal, WINNER),
  ]);
  need(bet?.id === record.id && bet.creator === WINNER && bet.acceptor === OPPONENT
    && bet.creator_side === record.outcome && bet.stake_yocto === STAKE && bet.referee === REFEREE
    && bet.status === 'settled' && bet.resolution?.outcome === record.outcome
    && bet.resolution.method === 'referee' && /^\d+$/.test(bet.resolution.resolved_at_ns),
  'settled bet mismatch');
  need(ruling?.terms_hash === bet.terms_hash && ruling.stage === 'settled'
    && ruling.outcome === record.outcome && ruling.result?.bet_id === record.id
    && ruling.result.terms_hash === bet.terms_hash && ruling.result.outcome === record.outcome
    && ruling.result.material_hash === record.materialHash
    && String(ruling.result.attempt) === ruling.accepted_attempt, 'ruling or result binding mismatch');
  const material = JSON.parse(ruling.material_json);
  need(material.bet_id === record.id && material.post_url === SOURCE
    && material.evidence?.kind === 'submitted'
    && same(material.evidence.items, [{ side: record.outcome, url: SOURCE }])
    && BigInt(bet.resolve_at_ns) === BigInt(ruling.deadline_ns)
    && Number.isFinite(Date.parse(material.deadline))
    && BigInt(Date.parse(material.deadline)) * 1_000_000n === BigInt(bet.resolve_at_ns),
  'registered material mismatch');
  const registrationArgs = JSON.parse(Buffer.from(registration.transaction.actions[0].FunctionCall.args, 'base64').toString('utf8'));
  need(typeof registrationArgs.salt === 'string' && /^[0-9a-f]{64}$/.test(registrationArgs.salt), 'registration salt invalid');
  const registrationDeposit = registration.transaction.actions[0].FunctionCall.deposit;
  need(typeof registrationDeposit === 'string' && /^\d+$/.test(registrationDeposit)
    && BigInt(registrationDeposit) > 0n, 'registration deposit invalid');
  callArgs(registration, record.register, OPERATOR, REFEREE, 'register_material',
    { material, salt: registrationArgs.salt }, '100000000000000', registrationDeposit);
  need(outlayerTermsHash(material, registrationArgs.salt) === bet.terms_hash
    && await view(REFEREE, 'terms_hash', { material, salt: registrationArgs.salt }) === bet.terms_hash,
    'material does not commit to escrow terms');
  need(juryMaterialHash(material, bet.terms_hash) === ruling.result.material_hash,
    'jury result material hash mismatch');
  callArgs(request, record.ruling, OPERATOR, REFEREE, 'request_ruling', { bet_id: record.id }, '300000000000000');
  const settlementReceipts = request.receipts.filter(receipt => receipt.predecessor_id === REFEREE
    && receipt.receiver_id === ESCROW && receipt.receipt?.Action?.actions?.length === 1
    && receipt.receipt.Action.actions[0]?.FunctionCall?.method_name === 'referee_resolve');
  need(settlementReceipts.length === 1, 'referee settlement receipt missing or duplicated');
  const settlementCall = settlementReceipts[0].receipt.Action.actions[0].FunctionCall;
  need(settlementCall.deposit === '0'
    && same(JSON.parse(Buffer.from(settlementCall.args, 'base64').toString('utf8')),
      { id: record.id, outcome: record.outcome }), 'referee settlement arguments mismatch');
  const settlementOutcome = request.receipts_outcome.find(item => item.id === settlementReceipts[0].receipt_id);
  need(settlementOutcome?.outcome?.executor_id === ESCROW
    && typeof settlementOutcome.outcome.status?.SuccessValue === 'string', 'referee settlement receipt failed');
  linkedReceipt(request, settlementReceipts[0].receipt_id);
  callArgs(withdrawal, record.withdrawal, WINNER, ESCROW, 'withdraw',
    { stated_request_id: record.withdrawalTag }, '100000000000000');
  const verdicts = ruling.result.verdicts;
  need(Array.isArray(verdicts) && verdicts.length === MODELS.length
    && verdicts.every((item, index) => item?.model === MODELS[index]
      && item.outcome === record.outcome && typeof item.confidence === 'number'
      && item.confidence >= 0.8 && item.confidence <= 1), 'jury roster or decision policy mismatch');
  need(ruling.result.evidence_summary?.kind === 'submitted'
    && ruling.result.evidence_summary.items?.length === 1
    && ruling.result.evidence_summary.items[0].url === SOURCE
    && ruling.result.evidence_summary.items[0].side === record.outcome,
  'jury evidence source mismatch');
  const delivery = deliveryFromReceipts(withdrawal, { transactionHash: record.withdrawal,
    accountId: WINNER, amountYocto: POT, wrapContractId: 'wrap.near' });
  need(delivery?.final === true && delivery.kind === 'native' && delivery.deliveredYocto === POT,
    'full native NEAR pot delivery unverified');
  need(deliveryFromReceipts(withdrawal, { transactionHash: record.withdrawal,
    accountId: WINNER, amountYocto: STAKE, wrapContractId: 'wrap.near' }) === null,
  'wrong payout amount was accepted');
  return { bet, ruling, material, verdicts };
}

export async function verifyMainnetDemo({ fetchImpl = fetch, urls = PROVIDERS } = {}) {
  need(Array.isArray(urls) && urls.length === 2 && urls.every(url => PROVIDERS.includes(url))
    && new Set(urls).size === 2, 'Both fixed public providers are required');
  const artifact = { schemaVersion: 1, network: 'mainnet', mode: 'operator-controlled',
    checkedAt: new Date().toISOString(), escrow: ESCROW, referee: REFEREE,
    overall: 'FAIL', checks: [], cases: [] };
  const check = (name, ok, detail) => artifact.checks.push({ name, ok, detail });
  for (const record of CASES) {
    const results = [];
    for (const url of urls) {
      try {
        results.push({ url, value: await providerCase(url, record, fetchImpl) });
        check(`${record.outcome}: ${new URL(url).host}`, true, 'Bet, ruling, calls, and full receipt delivery verified');
      } catch (error) { check(`${record.outcome}: ${new URL(url).host}`, false, String(error.message).slice(0, 250)); }
    }
    if (results.length !== urls.length) continue;
    const [first, second] = results.map(item => item.value);
    const agrees = same(first.bet, second.bet) && same(first.ruling, second.ruling);
    check(`${record.outcome}: provider corroboration`, agrees, agrees ? 'Public state agrees across both providers' : 'Provider states differ');
    if (!agrees) continue;
    artifact.cases.push({ id: record.id, outcome: record.outcome, claim: first.material.claim,
      stakeYocto: STAKE, potYocto: POT, creatorSide: first.bet.creator_side, winner: WINNER,
      resolvedAtNs: first.bet.resolution.resolved_at_ns,
      verdicts: first.verdicts.map(({ model, outcome, confidence }) => ({ model, outcome, confidence })),
      sourceUrl: SOURCE, payout: { hash: record.withdrawal, amountYocto: POT, recipient: WINNER, verified: true },
      settlement: { hash: record.ruling, method: first.bet.resolution.method, referee: REFEREE },
      providers: results.map(item => item.url) });
  }
  const options = judgeOptions(JUDGE_FLAGS, {});
  const checks = await runOutlayerJudge(options, { fetchImpl });
  for (const item of checks) check(item.name, item.ok, item.detail);
  artifact.overall = artifact.cases.length === CASES.length && artifact.checks.every(item => item.ok) ? 'PASS' : 'FAIL';
  return artifact;
}

async function main(argv) {
  need(argv.length === 0 || argv.length === 2 && argv[0] === '--save' && argv[1],
    'Usage: node scripts/verify-mainnet-demo.mjs [--save PUBLIC_JSON_PATH]');
  const result = await verifyMainnetDemo();
  if (argv.length) await writeFile(argv[1], `${JSON.stringify(result, null, 2)}\n`, { flag: 'w' });
  console.log(`${result.overall} mainnet demo: ${result.cases.length}/${CASES.length} cases; ${result.checks.filter(item => item.ok).length}/${result.checks.length} checks`);
  for (const item of result.checks.filter(item => !item.ok)) console.error(`FAIL ${item.name}: ${item.detail}`);
  if (result.overall !== 'PASS') process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).catch(error => { console.error(`FAIL mainnet demo: ${error.message}`); process.exitCode = 1; });
}
