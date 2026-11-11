// INTEGRATION: exact signed-byte verification only; hardware evidence remains unverified.
import { Buffer } from 'node:buffer';
import { createHash, createPublicKey, timingSafeEqual, verify } from 'node:crypto';

const MAX_BODY_BYTES = 1024 * 1024;
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');
const utf8 = new TextDecoder('utf-8', { fatal: true });

export function sha256(bytes) {
  if (!(bytes instanceof Uint8Array)) throw new Error('sha256 requires bytes');
  return createHash('sha256').update(bytes).digest('hex');
}

function object(value, name) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${name} must be an object`);
  }
  return value;
}

function nonempty(value, name) {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${name} must be a nonempty string`);
  return value;
}

function hex(value, name, length, prefix = true) {
  if (typeof value !== 'string') throw new Error(`${name} must be hexadecimal`);
  const raw = prefix ? value.replace(/^0x/i, '') : value;
  if (raw.length !== length * 2 || !/^[a-f0-9]+$/i.test(raw)) {
    throw new Error(`${name} must be ${length} hexadecimal bytes`);
  }
  return Buffer.from(raw, 'hex');
}

function equal(left, right) {
  return left.length === right.length && timingSafeEqual(left, right);
}

function body(value, name) {
  if (typeof value !== 'string' || !value.length || value.length > 4 * Math.ceil(MAX_BODY_BYTES / 3)
      || value.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(value)) {
    throw new Error(`${name} must be canonical base64 of at most 1 MiB`);
  }
  const bytes = Buffer.from(value, 'base64');
  if (bytes.length > MAX_BODY_BYTES || bytes.toString('base64') !== value) {
    throw new Error(`${name} must be canonical base64 of at most 1 MiB`);
  }
  return bytes;
}

function json(bytes, name) {
  try { return object(JSON.parse(utf8.decode(bytes)), name); }
  catch { throw new Error(`${name} must contain a UTF-8 JSON object`); }
}

function verdict(value, name) {
  object(value, name);
  const keys = Object.keys(value).sort();
  if (keys.length !== 2 || keys[0] !== 'agrees' || keys[1] !== 'reason'
      || typeof value.agrees !== 'boolean' || typeof value.reason !== 'string' || !value.reason.trim()) {
    throw new Error(`${name} must contain only agrees (boolean) and reason (nonempty string)`);
  }
  if (value.reason.length > 600 || value.reason.trim().split(/\s+/u).length > 40) {
    throw new Error(`${name}.reason must have at most 40 words`);
  }
  return value;
}

function identity(value, name) {
  object(value, name);
  if (value.signing_algo !== 'ed25519') throw new Error(`${name}.signing_algo must be ed25519`);
  return hex(value.signing_address, `${name}.signing_address`, 32);
}

function report(value, name, nonce) {
  object(value, name);
  if (('error' in value && value.error != null) || 'error_code' in value) {
    throw new Error(`${name} contains an error`);
  }
  const signer = identity(value, name);
  if (!equal(hex(value.request_nonce, `${name}.request_nonce`, 32, false), nonce)) {
    throw new Error(`${name}.request_nonce does not match nonce`);
  }
  nonempty(value.intel_quote, `${name}.intel_quote`);
  if (!/^(?:0x)?(?:[a-f0-9]{2})+$/i.test(value.intel_quote)) {
    throw new Error(`${name}.intel_quote must be hexadecimal`);
  }
  let events = value.event_log;
  if (typeof events === 'string') {
    try { events = JSON.parse(events); } catch { throw new Error(`${name}.event_log must contain JSON`); }
  }
  if (!Array.isArray(events)) throw new Error(`${name}.event_log must be an array or JSON array string`);
  return signer;
}

function timestamp(value, name) {
  nonempty(value, name);
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)
      || !Number.isFinite(Date.parse(value))) throw new Error(`${name} must be a UTC ISO timestamp`);
  return Date.parse(value);
}

export function validatePreflight(evidence, nonceHex) {
  const nonce = hex(nonceHex, 'nonce', 32, false);
  object(evidence, 'attestation');
  if (('error' in evidence && evidence.error != null) || 'error_code' in evidence) throw new Error('Attestation unavailable.');
  report(evidence.gateway_attestation, 'attestation.gateway_attestation', nonce);
  if (!Array.isArray(evidence.model_attestations) || !evidence.model_attestations.length) {
    throw new Error('attestation.model_attestations must contain model evidence');
  }
  evidence.model_attestations.forEach((candidate, index) => report(candidate, `attestation.model_attestations[${index}]`, nonce));
}

/**
 * Verify exact-byte SHA-256 and Ed25519 response binding. Report shape, echoed
 * nonce and signer consistency are checked, but no quote is authenticated.
 * modelSigner means a unique match to supplied evidence, not a hardware trust decision.
 */
export function verifyAttestedRecord(record) {
  object(record, 'record');
  const model = nonempty(record.model, 'model');
  const nonce = hex(record.nonce, 'nonce', 32, false);
  const requestBytes = body(record.requestBody, 'requestBody');
  const responseBytes = body(record.responseBody, 'responseBody');
  const requestHash = sha256(requestBytes);
  const responseHash = sha256(responseBytes);
  if (!equal(hex(record.requestHash, 'requestHash', 32, false), Buffer.from(requestHash, 'hex'))) {
    throw new Error('requestHash does not match exact request bytes');
  }
  if (!equal(hex(record.responseHash, 'responseHash', 32, false), Buffer.from(responseHash, 'hex'))) {
    throw new Error('responseHash does not match exact response bytes');
  }

  const request = json(requestBytes, 'requestBody');
  const response = json(responseBytes, 'responseBody');
  if (request.model !== model) throw new Error('signed request model does not match model');
  nonempty(record.completionId, 'completionId');
  if (response.id !== record.completionId) throw new Error('signed response id does not match completionId');
  const savedVerdict = verdict(record.verdict, 'verdict');
  const content = response.choices?.[0]?.message?.content;
  if (typeof content !== 'string') throw new Error('signed response must contain a JSON verdict message');
  let parsedVerdict;
  try { parsedVerdict = JSON.parse(content); } catch { throw new Error('signed response verdict must be strict JSON'); }
  verdict(parsedVerdict, 'signed response verdict');
  if (parsedVerdict.agrees !== savedVerdict.agrees || parsedVerdict.reason !== savedVerdict.reason) {
    throw new Error('signed response verdict does not match verdict');
  }

  const started = timestamp(record.startedAt, 'startedAt');
  const attested = timestamp(record.attestedAt, 'attestedAt');
  const completed = timestamp(record.completedAt, 'completedAt');
  if (started > attested || attested > completed) throw new Error('timestamps must retain operation/preflight/completion order');

  const signature = object(record.signature, 'signature');
  if (signature.signature_kind !== 'provider_tee') throw new Error('signature_kind must be provider_tee');
  const signer = identity(signature, 'signature');
  const expectedText = `${model}:${requestHash}:${responseHash}`;
  if (signature.text !== expectedText) throw new Error('signature text does not bind model and exact bytes');
  const signatureBytes = hex(signature.signature, 'signature.signature', 64);

  const evidence = object(record.attestation, 'attestation');
  if (('error' in evidence && evidence.error != null) || 'error_code' in evidence) {
    throw new Error('attestation contains an error');
  }
  report(evidence.gateway_attestation, 'attestation.gateway_attestation', nonce);
  if (!Array.isArray(evidence.model_attestations) || !evidence.model_attestations.length) {
    throw new Error('attestation.model_attestations must contain model evidence');
  }
  let matches = 0;
  for (const [index, candidate] of evidence.model_attestations.entries()) {
    if (equal(report(candidate, `attestation.model_attestations[${index}]`, nonce), signer)) matches += 1;
  }
  if (matches !== 1) throw new Error('signature must match exactly one model-attestation signer');
  const publicKey = createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, signer]), format: 'der', type: 'spki' });
  if (!verify(null, Buffer.from(expectedText, 'utf8'), publicKey, signatureBytes)) {
    throw new Error('Ed25519 signature verification failed');
  }
  return { requestHash: true, responseHash: true, signature: true, modelSigner: true, hardwareAttestation: 'not_verified' };
}

export const verificationRecipe = Object.freeze({
  scope: 'This helper verifies exact signed bytes and signer consistency only. Hardware quotes and attestation trust are not verified.',
  preflight: 'Generate and retain a fresh 32-byte nonce. Before completion, request /v1/attestation/report with canonical model, provider=near, signing_algo=ed25519, nonce, and x-no-aliasing:true. Retain every returned model candidate and the gateway report.',
  exactBytes: 'Send the canonical request model with x-no-aliasing:true and Accept-Encoding:identity. Preserve exact request and decompressed response bytes. Request the response signature with signing_algo=ed25519.',
  hardware: 'Use the official Verification Center or a DCAP quote verifier on the gateway and every model candidate. Apply explicit TCB/advisory and measurement/provenance policy; reject debug mode. Read signer and nonce binding from the verified quote report data and compare echoed fields.',
  measurements: 'Replay the event log and compare RTMR3 with the verified quote. Hash the raw app_compose UTF-8 string; require MRCONFIGID = 0x01 || SHA-256(app_compose) || 15 zero bytes. Apply a declared GPU-evidence policy and verify NVIDIA evidence and nonce when required.',
  limit: 'A matching provider_tee signer binds model identity and bytes, but shared model keys do not establish the same serving instance or a model-to-gateway-to-response chain. Saved timestamps are unauthenticated metadata.',
  verificationCenter: 'https://cloud.near.ai/verify',
  responseSignatures: 'https://docs.near.ai/cloud/verification/cloud-api/response-signatures',
  signatureReference: 'https://docs.near.ai/cloud/verification/reference/response-signature-verification',
  reportReference: 'https://docs.near.ai/cloud/verification/reference/quote-nonce-signer',
});
