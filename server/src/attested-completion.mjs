// One attested completion on NEAR AI Cloud: a fresh nonce, the attestation
// report for it, a chat completion whose exact bytes are kept, and the
// enclave's signature over them. The signed second opinion (attested-check.mjs)
// and the enclave ruling (enclave-ruling.mjs) both go through here, so there is
// one place that decides what a verifiable completion record holds.
import { randomBytes } from 'node:crypto';
import { sha256, validatePreflight, verifyAttestedRecord } from './attested-signature.mjs';
import { verifyGpuPayload } from './gpu-attestation.mjs';

async function bytesFrom(response, maxBytes, signal) {
  if (!response.ok) throw new Error('NEAR AI request failed.');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    size += chunk.length;
    if (size > maxBytes) throw new Error('NEAR AI response exceeds the limit.');
    chunks.push(chunk);
  }
  return Buffer.concat(chunks);
}

// The base URL comes from configuration only. Plain http is allowed for a
// loopback test server and nowhere else.
function baseUrl(config) {
  const url = new URL(config.nearai.baseUrl);
  const local = config.fetch?.allowLoopback && ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
  if ((url.protocol !== 'https:' && !(local && url.protocol === 'http:'))
    || url.username || url.password || url.search || url.hash) throw new Error('Invalid NEAR AI base URL.');
  return url.toString().replace(/\/$/, '');
}

/**
 * Runs one completion and returns its verified record: model, requestBody,
 * responseBody, requestHash, responseHash, completionId, signature,
 * attestation, nonce, verdict (the parsed reply), startedAt, attestedAt and
 * completedAt. `parse` turns the reply text into the verdict and throws when it
 * is unusable; `checkContent` is the shape check verifyAttestedRecord applies
 * to it (the agrees/reason verdict when omitted). Reasoning models can spend
 * the whole token budget and return empty content: that fails in `parse`, so an
 * empty reply is a failed call, never a verdict. maxTokens defaults to the
 * signed second opinion's 2048; the enclave ruling asks for more.
 */
export async function attestedCompletion(config, { model = config.nearai.model, system, input, parse, checkContent,
  maxTokens = 2048, fetchImpl = fetch, signal = AbortSignal.timeout(60_000), startedAt = new Date().toISOString() }) {
  const base = baseUrl(config);
  const headers = { authorization: `Bearer ${config.nearai.apiKey}`, accept: 'application/json',
    'accept-encoding': 'identity', 'x-no-aliasing': 'true' };
  const get = async (path, limit) => bytesFrom(await fetchImpl(`${base}${path}`, {
    headers, signal, redirect: 'error',
  }), limit, signal);
  const nonce = randomBytes(32).toString('hex');
  const query = new URLSearchParams({ model, provider: 'near',
    signing_algo: 'ed25519', nonce, include_tls_fingerprint: 'false' });
  const attestation = JSON.parse((await get(`/attestation/report?${query}`, 2_000_000)).toString('utf8'));
  // Test stacks set config.nearai.quoteRoots to their own root; production uses the pinned Intel root.
  const roots = config.nearai?.quoteRoots;
  validatePreflight(attestation, nonce, { roots });
  const gpuEvidence = new Map();
  for (const candidate of attestation.model_attestations) {
    if (!Object.hasOwn(candidate, 'nvidia_payload')) continue;
    const { jwt, verdict } = await verifyGpuPayload(candidate.nvidia_payload, nonce, { fetchImpl, signal });
    gpuEvidence.set(candidate, { jwt, verdict, checkedAt: new Date().toISOString() });
  }
  const attestedAt = new Date().toISOString();
  const requestBytes = Buffer.from(JSON.stringify({ model, stream: false,
    response_format: { type: 'json_object' }, max_tokens: maxTokens,
    ...(model === 'zai-org/GLM-5.1-FP8' ? { chat_template_kwargs: { enable_thinking: false } } : {}),
    messages: [{ role: 'system', content: system }, { role: 'user', content: input }] }));
  const responseBytes = await bytesFrom(await fetchImpl(`${base}/chat/completions`, {
    method: 'POST', headers: { ...headers, 'content-type': 'application/json' },
    body: requestBytes, signal, redirect: 'error',
  }), 1_000_000, signal);
  const response = JSON.parse(responseBytes.toString('utf8'));
  if (typeof response.id !== 'string' || !/^[a-zA-Z0-9_-]{1,200}$/.test(response.id)) throw new Error('Invalid completion ID.');
  const verdict = parse(response.choices?.[0]?.message?.content);
  const signature = JSON.parse((await get(`/signature/${encodeURIComponent(response.id)}?signing_algo=ed25519`, 16_384)).toString('utf8'));
  const record = { model, requestBody: requestBytes.toString('base64'),
    responseBody: responseBytes.toString('base64'), requestHash: sha256(requestBytes),
    responseHash: sha256(responseBytes), completionId: response.id, signature, attestation, nonce, verdict,
    startedAt, attestedAt, completedAt: new Date().toISOString() };
  verifyAttestedRecord(record, checkContent ? { checkContent, roots } : { roots });
  // The response signer must uniquely match a retained, verified preflight report.
  const normalized = value => String(value).replace(/^0x/i, '').toLowerCase();
  const signingCandidate = attestation.model_attestations.find(candidate =>
    candidate.signing_algo === signature.signing_algo
    && normalized(candidate.signing_address) === normalized(signature.signing_address));
  if (gpuEvidence.has(signingCandidate)) record.gpu = gpuEvidence.get(signingCandidate);
  signal.throwIfAborted();
  return record;
}
