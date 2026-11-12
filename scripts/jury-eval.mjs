// Re-runs the enclave jury on a file of written cases: the production prompt, the production
// input built by the engine's own functions, the production models and threshold, through
// NEAR AI Cloud. It measures the models' judgment only; it does not attest or sign (every
// production call is attested and signed, see scripts/verify-enclave-ruling.mjs).
// Usage: NEARAI_API_KEY=... node scripts/jury-eval.mjs <cases.json> [results.json]
import { readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomUUID } from 'node:crypto';
import { VERDICT_PROMPT, decide, makeMaterial, submittedEvidence, verdictInput } from '../server/src/enclave-ruling.mjs';

const [casesPath, outPath] = process.argv.slice(2);
if (!casesPath || !process.env.NEARAI_API_KEY) {
  console.error('Usage: NEARAI_API_KEY=... node scripts/jury-eval.mjs <cases.json> [results.json]');
  process.exit(2);
}
const base = String(process.env.NEARAI_BASE_URL || 'https://cloud-api.near.ai/v1').replace(/\/$/, '');
const models = String(process.env.NEARAI_RULING_MODELS || 'Qwen/Qwen3.8-27B,deepseek-ai/DeepSeek-V4.1-Flash-1017,z-ai/glm-5.3-flash')
  .split(',').map((m) => m.trim()).filter(Boolean);
const minConfidence = Number(process.env.NEARAI_RULING_MIN_CONFIDENCE || 0.8);
const jury = { models, minConfidence };
const cases = JSON.parse(readFileSync(casesPath, 'utf8'));
const sha = (text) => createHash('sha256').update(text).digest('hex');

// The same reply checks production applies: strict JSON, a known outcome, a confidence from 0 to 1, a short reason.
function reply(content) {
  const v = JSON.parse(content);
  if (!['yes', 'no', 'unclear'].includes(v.outcome) || typeof v.confidence !== 'number' || v.confidence < 0 || v.confidence > 1
    || typeof v.reason !== 'string' || v.reason.trim().split(/\s+/u).length > 40) throw new Error('reply out of shape');
  return { outcome: v.outcome, confidence: v.confidence, reason: v.reason };
}

async function ask(model, input) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const started = Date.now();
    try {
      const r = await fetch(`${base}/chat/completions`, { method: 'POST', signal: AbortSignal.timeout(170_000),
        headers: { authorization: `Bearer ${process.env.NEARAI_API_KEY}`, 'content-type': 'application/json' },
        body: JSON.stringify({ model, stream: false, response_format: { type: 'json_object' }, max_tokens: 8192,
          messages: [{ role: 'system', content: VERDICT_PROMPT }, { role: 'user', content: input }] }) });
      const j = await r.json();
      return { ...reply(j.choices?.[0]?.message?.content), ms: Date.now() - started, attempts: attempt + 1 };
    } catch (error) {
      if (attempt === 2) return { error: String(error.message || error).slice(0, 160), ms: Date.now() - started, attempts: 3 };
    }
  }
}

const results = [];
let next = 0;
const calls = cases.flatMap((c, index) => models.map((model) => ({ c, index, model })));
const byCase = new Map();
async function worker() {
  while (next < calls.length) {
    const { c, index, model } = calls[next++];
    if (!byCase.has(index)) {
      const bet = { id: randomUUID(), termsHash: sha(c.claim) };
      const material = makeMaterial({ claim: c.claim, madeAt: c.madeAt, deadline: c.deadline,
        postUrl: `https://x.com/example/status/${1000000 + index}`, bets: [bet] });
      const rows = (c.items || []).map((item, n) => ({ id: n + 1, side: item.side, url: item.url, final_url: item.url,
        title: item.title || '', body: item.text, x_username: item.side === 'yes' ? 'yes_bettor' : 'no_bettor', at: c.deadline }));
      const evidence = submittedEvidence(rows, c.deadline);
      byCase.set(index, { input: verdictInput(material, c.now, jury, evidence.text, 'ruling'), verdicts: {} });
    }
    const entry = byCase.get(index);
    entry.verdicts[model] = await ask(model, entry.input);
  }
}
await Promise.all(Array.from({ length: Number(process.env.CONCURRENCY || 12) }, worker));

const tally = { cases: cases.length, correct: 0, refundedInstead: 0, wrongWinner: 0, paidInsteadOfRefund: 0, failed: 0 };
const perModel = Object.fromEntries(models.map((m) => [m, { exact: 0, errors: 0 }]));
cases.forEach((c, index) => {
  const { verdicts } = byCase.get(index);
  const list = models.map((m) => verdicts[m]);
  list.forEach((v, i) => { if (v.error) perModel[models[i]].errors += 1; else if (v.outcome === c.expect) perModel[models[i]].exact += 1; });
  let outcome;
  if (list.some((v) => v.error)) { outcome = 'failed'; tally.failed += 1; }
  else {
    outcome = decide(list, minConfidence);
    if (outcome === c.expect) tally.correct += 1;
    else if (outcome === 'unclear') tally.refundedInstead += 1;
    else if (c.expect === 'unclear') tally.paidInsteadOfRefund += 1;
    else tally.wrongWinner += 1;
  }
  results.push({ id: c.id, author: c.author, claim: c.claim, expect: c.expect, jury: outcome,
    verdicts: models.map((m) => ({ model: m, ...verdicts[m] })) });
});
const summary = { ranAt: new Date().toISOString(), base, jury, prompt: 'VERDICT_PROMPT from server/src/enclave-ruling.mjs', tally, perModel };
console.log(JSON.stringify(summary, null, 1));
for (const r of results.filter((r) => r.jury !== r.expect)) {
  console.log(`MISS ${r.id} expect=${r.expect} jury=${r.jury} | ${r.verdicts.map((v) => v.error ? 'ERR' : `${v.outcome}@${v.confidence}`).join(' ')} | ${r.claim.slice(0, 90)}`);
}
if (outPath) writeFileSync(outPath, JSON.stringify({ summary, results }, null, 1));
