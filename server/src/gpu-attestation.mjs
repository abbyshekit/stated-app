// INTEGRATION: NVIDIA NRAS verdicts and offline ES384 authentication of stored GPU evidence.
import { createPublicKey, verify } from 'node:crypto';

const NRAS = 'https://nras.attestation.nvidia.com';
const JWKS_URL = `${NRAS}/.well-known/jwks.json`;
const MAX_BYTES = 1_000_000;
const JWKS_TTL_MS = 3_600_000;
// Isolate injected test transports from NVIDIA's production key cache.
const keyCache = new WeakMap();
let loadedKeys;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}

function nonce(value, name) {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/i.test(value)) throw new Error(`${name} must be 32-byte hexadecimal`);
  return value.toLowerCase();
}

function requestSignal(signal) {
  const timeout = AbortSignal.timeout(20_000);
  return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

async function readJson(response, signal) {
  if (!response.ok) throw new Error(`NVIDIA NRAS request failed: HTTP ${response.status}`);
  if (!response.body) throw new Error('NVIDIA NRAS response has no body');
  const chunks = [];
  let size = 0;
  for await (const chunk of response.body) {
    signal.throwIfAborted();
    size += chunk.length;
    if (size > MAX_BYTES) throw new Error('NVIDIA NRAS response exceeds 1 MB');
    chunks.push(chunk);
  }
  signal.throwIfAborted();
  return JSON.parse(utf8.decode(Buffer.concat(chunks)));
}

/** Fetch at most once per hour; never follow a token-supplied URL or a redirect. */
export async function getGpuJwks({ fetchImpl = fetch, signal } = {}) {
  const cached = keyCache.get(fetchImpl);
  signal?.throwIfAborted();
  if (cached?.value && cached.expiresAt > Date.now()) {
    loadedKeys = cached;
    return cached.value;
  }
  if (cached?.pending) return cached.pending;
  const entry = {};
  entry.pending = (async () => {
    const boundedSignal = requestSignal(signal);
    const jwks = object(await readJson(await fetchImpl(JWKS_URL, {
      headers: { accept: 'application/json' }, redirect: 'error', signal: boundedSignal,
    }), boundedSignal), 'NVIDIA JWKS');
    if (!Array.isArray(jwks.keys) || !jwks.keys.length) throw new Error('NVIDIA JWKS must contain keys');
    entry.value = jwks;
    entry.expiresAt = Date.now() + JWKS_TTL_MS;
    loadedKeys = entry;
    return jwks;
  })();
  keyCache.set(fetchImpl, entry);
  try { return await entry.pending; }
  catch (error) { keyCache.delete(fetchImpl); throw error; }
  finally { delete entry.pending; }
}

/** Synchronous readers use explicit keys, or keys loaded by the async verification boundary. */
export function cachedGpuJwks() {
  if (!loadedKeys?.value || loadedKeys.expiresAt <= Date.now()) throw new Error('NVIDIA JWKS unavailable; fetch keys before offline verification');
  return loadedKeys.value;
}

function jwtPart(value, name) {
  if (!value || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error(`GPU JWT ${name} must be base64url`);
  const bytes = Buffer.from(value, 'base64url');
  if (bytes.toString('base64url') !== value) throw new Error(`GPU JWT ${name} must be canonical base64url`);
  return bytes;
}

/** Authenticate a historical token; current expiration is not a test of its recorded verdict. */
export function verifyGpuJwt(jwt, { jwks = cachedGpuJwks() } = {}) {
  if (typeof jwt !== 'string' || Buffer.byteLength(jwt) > MAX_BYTES) throw new Error('GPU JWT must be a string of at most 1 MB');
  const parts = jwt.split('.');
  if (parts.length !== 3) throw new Error('GPU JWT must contain three parts');
  const header = object(JSON.parse(utf8.decode(jwtPart(parts[0], 'header'))), 'GPU JWT header');
  const claims = object(JSON.parse(utf8.decode(jwtPart(parts[1], 'claims'))), 'GPU JWT claims');
  const signature = jwtPart(parts[2], 'signature');
  if (header.alg !== 'ES384' || typeof header.kid !== 'string' || !header.kid
      || 'crit' in header || 'b64' in header || signature.length !== 96) throw new Error('GPU JWT requires ES384 and a key id');
  if (!Array.isArray(jwks?.keys)) throw new Error('NVIDIA JWKS must contain keys');
  const matches = jwks.keys.filter(key => key?.kid === header.kid);
  if (matches.length !== 1) throw new Error('GPU JWT key id not found uniquely in NVIDIA JWKS');
  const key = matches[0];
  if (key.kty !== 'EC' || key.crv !== 'P-384' || (key.alg !== undefined && key.alg !== 'ES384')
      || (key.use !== undefined && key.use !== 'sig')
      || (key.key_ops !== undefined && (!Array.isArray(key.key_ops) || !key.key_ops.includes('verify')))) {
    throw new Error('GPU JWT key must permit ES384 signature verification');
  }
  const publicKey = createPublicKey({ format: 'jwk', key });
  if (!verify('sha384', Buffer.from(`${parts[0]}.${parts[1]}`), { key: publicKey, dsaEncoding: 'ieee-p1363' }, signature)) {
    throw new Error('GPU JWT signature verification failed');
  }
  if (claims.iss !== NRAS) throw new Error('GPU JWT issuer must be NVIDIA NRAS');
  nonce(claims.eat_nonce, 'GPU JWT eat_nonce');
  if (claims['x-nvidia-overall-att-result'] !== true) throw new Error('NVIDIA GPU attestation verdict is not true');
  return { verdict: true, jwt, claims };
}

/** Submit the decoded payload unchanged, after checking its request nonce. */
export async function verifyGpuPayload(nvidiaPayloadString, nonceHex, { fetchImpl = fetch, signal } = {}) {
  const expectedNonce = nonce(nonceHex, 'request nonce');
  if (typeof nvidiaPayloadString !== 'string' || Buffer.byteLength(nvidiaPayloadString) > MAX_BYTES) {
    throw new Error('nvidia_payload must be a JSON string of at most 1 MB');
  }
  const payload = object(JSON.parse(nvidiaPayloadString), 'nvidia_payload');
  if (nonce(payload.nonce, 'nvidia_payload nonce') !== expectedNonce) throw new Error('NVIDIA payload nonce does not match request nonce');
  const boundedSignal = requestSignal(signal);
  boundedSignal.throwIfAborted();
  const result = await readJson(await fetchImpl(`${NRAS}/v3/attest/gpu`, {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(payload), redirect: 'error', signal: boundedSignal,
  }), boundedSignal);
  if (!Array.isArray(result) || !Array.isArray(result[0]) || result[0].length !== 2 || result[0][0] !== 'JWT') {
    throw new Error('NVIDIA NRAS response must begin with a JWT entry');
  }
  const jwks = await getGpuJwks({ fetchImpl, signal: boundedSignal });
  const verified = verifyGpuJwt(result[0][1], { jwks });
  if (nonce(verified.claims.eat_nonce, 'GPU JWT eat_nonce') !== expectedNonce) throw new Error('GPU JWT nonce does not match request nonce');
  return verified;
}
