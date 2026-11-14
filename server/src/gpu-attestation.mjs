// INTEGRATION: NVIDIA NRAS verdicts and offline ES384 authentication of stored GPU evidence.
import { createPublicKey, verify, X509Certificate } from 'node:crypto';
import { readFileSync } from 'node:fs';

const NRAS = 'https://nras.attestation.nvidia.com';
const JWKS_URL = `${NRAS}/.well-known/jwks.json`;
// NVIDIA source: https://prod.vault.nvidia.com/v1/dgxc-attestation/pki/nras-prod/ca_chain
// Re-fetch that chain, extract its self-signed CA 001 root, and compare
// new X509Certificate(rootPem).fingerprint256 with this pin before replacing the PEM.
const NVIDIA_ROOT_FINGERPRINT = 'CD:E2:69:E3:F7:2C:66:7A:EC:C2:D8:C1:AB:32:C4:E4:2A:AF:55:07:37:9F:15:F2:21:C7:7C:55:18:10:1A:1E';
const SNAPSHOT_URL = new URL('../../evidence/nvidia-jwks-snapshot-20261114.json', import.meta.url);
const ROOT_URL = new URL('../../evidence/nvidia-attestation-root-ca-001.pem', import.meta.url);
const SNAPSHOT_SOURCE = `snapshot of 2026-11-14, certificate chain checked to NVIDIA Attestation Service CA 001 (${NVIDIA_ROOT_FINGERPRINT})`;
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

function requestSignal(signal, timeoutMs = 20_000) {
  // null delegates the deadline to the offline-screening transport, which
  // buffers the complete body and reports each attempt before returning it.
  const timeout = timeoutMs === null ? new AbortController().signal : AbortSignal.timeout(timeoutMs);
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
export async function getGpuJwks({ fetchImpl = fetch, signal, timeoutMs = 20_000 } = {}) {
  const cached = keyCache.get(fetchImpl);
  signal?.throwIfAborted();
  if (cached?.value && cached.expiresAt > Date.now()) {
    loadedKeys = cached;
    return cached.value;
  }
  if (cached?.pending) return cached.pending;
  const entry = {};
  entry.pending = (async () => {
    const boundedSignal = requestSignal(signal, timeoutMs);
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

function snapshotKey(kid, iat, { snapshot, rootPem }) {
  snapshot ??= JSON.parse(readFileSync(SNAPSHOT_URL, 'utf8'));
  if (!Array.isArray(snapshot?.keys)) throw new Error('NVIDIA snapshot must contain keys');
  const matches = snapshot.keys.filter(key => key?.kid === kid);
  if (!matches.length) throw Object.assign(new Error('NVIDIA has retired this signing key'), { code: 'NVIDIA_KEY_RETIRED' });
  if (matches.length !== 1) throw new Error('GPU JWT key id not found uniquely in NVIDIA snapshot');
  const key = matches[0];
  const root = new X509Certificate(rootPem ?? readFileSync(ROOT_URL));
  if (root.fingerprint256 !== NVIDIA_ROOT_FINGERPRINT) throw new Error('NVIDIA root fingerprint differs from the pin');
  if (!Array.isArray(key.x5c) || key.x5c.length !== 2) throw new Error('NVIDIA snapshot requires a leaf and intermediate certificate');
  const [leaf, intermediate] = key.x5c.map(value => {
    if (typeof value !== 'string') throw new Error('NVIDIA snapshot certificate must be canonical base64 DER');
    const cert = new X509Certificate(Buffer.from(value, 'base64'));
    if (cert.raw.toString('base64') !== value) throw new Error('NVIDIA snapshot certificate must be canonical base64 DER');
    return cert;
  });
  const leafKey = leaf.publicKey.export({ format: 'jwk' });
  if (['kty', 'crv', 'x', 'y'].some(field => leafKey[field] !== key[field])) {
    throw new Error('NVIDIA leaf public key differs from the snapshot JWK');
  }
  if (leaf.ca || !leaf.checkIssued(intermediate) || !leaf.verify(intermediate.publicKey)) {
    throw new Error('NVIDIA leaf is not signed by its intermediate');
  }
  if (!intermediate.ca || !intermediate.checkIssued(root) || !intermediate.verify(root.publicKey)
      || !root.ca || !root.checkIssued(root) || !root.verify(root.publicKey)) {
    throw new Error('NVIDIA intermediate does not chain to the pinned root CA');
  }
  const issuedAt = typeof iat === 'number' ? iat * 1000 : NaN;
  if (!Number.isFinite(issuedAt) || [leaf, intermediate, root].some(cert =>
    !(issuedAt >= Date.parse(cert.validFrom) && issuedAt <= Date.parse(cert.validTo)))) {
    throw new Error('NVIDIA certificate chain was not valid at token iat');
  }
  return key;
}

/** Authenticate a historical token; current expiration is not a test of its recorded verdict. */
export function verifyGpuJwt(jwt, { jwks = cachedGpuJwks(), stored = false, snapshot, rootPem } = {}) {
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
  const useSnapshot = !matches.length && stored === true;
  if (!useSnapshot && matches.length !== 1) throw new Error('GPU JWT key id not found uniquely in NVIDIA JWKS');
  const key = useSnapshot ? snapshotKey(header.kid, claims.iat, { snapshot, rootPem }) : matches[0];
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
  return { verdict: true, jwt, claims, keySource: useSnapshot ? SNAPSHOT_SOURCE : 'live JWKS' };
}

/** Submit the decoded payload unchanged, after checking its request nonce. */
export async function verifyGpuPayload(nvidiaPayloadString, nonceHex, { fetchImpl = fetch, signal, timeoutMs = 20_000 } = {}) {
  const expectedNonce = nonce(nonceHex, 'request nonce');
  if (typeof nvidiaPayloadString !== 'string' || Buffer.byteLength(nvidiaPayloadString) > MAX_BYTES) {
    throw new Error('nvidia_payload must be a JSON string of at most 1 MB');
  }
  const payload = object(JSON.parse(nvidiaPayloadString), 'nvidia_payload');
  if (nonce(payload.nonce, 'nvidia_payload nonce') !== expectedNonce) throw new Error('NVIDIA payload nonce does not match request nonce');
  const boundedSignal = requestSignal(signal, timeoutMs);
  boundedSignal.throwIfAborted();
  const result = await readJson(await fetchImpl(`${NRAS}/v3/attest/gpu`, {
    method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' },
    body: JSON.stringify(payload), redirect: 'error', signal: boundedSignal,
  }), boundedSignal);
  if (!Array.isArray(result) || !Array.isArray(result[0]) || result[0].length !== 2 || result[0][0] !== 'JWT') {
    throw new Error('NVIDIA NRAS response must begin with a JWT entry');
  }
  const jwks = await getGpuJwks({ fetchImpl, signal: boundedSignal, timeoutMs });
  const verified = verifyGpuJwt(result[0][1], { jwks });
  if (nonce(verified.claims.eat_nonce, 'GPU JWT eat_nonce') !== expectedNonce) throw new Error('GPU JWT nonce does not match request nonce');
  return verified;
}
