// INTEGRATION: durable NVIDIA JWKS/root snapshot coverage for offline GPU JWT verification.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { X509Certificate } from 'node:crypto';
import test from 'node:test';
import { verifyGpuJwt } from '../src/gpu-attestation.mjs';

const snapshot = JSON.parse(fs.readFileSync(new URL('../../evidence/nvidia-jwks-snapshot-20261114.json', import.meta.url), 'utf8'));
const rootPemPath = new URL('../../evidence/nvidia-attestation-root-ca-001.pem', import.meta.url);
const rootPem = fs.readFileSync(rootPemPath, 'utf8');
const ruling = JSON.parse(fs.readFileSync(new URL('../../evidence/enclave-ruling-3668aa04.json', import.meta.url), 'utf8'));
const snapshotKids = new Set(snapshot.keys.map(key => key.kid));
const realJwt = [ruling.record.plan, ...ruling.record.verdicts]
  .map(call => call.gpu?.jwt)
  .find(jwt => snapshotKids.has(JSON.parse(Buffer.from(jwt.split('.')[0], 'base64url')).kid));
assert.ok(realJwt, 'evidence must contain a JWT signed by the committed snapshot');
const realHeader = JSON.parse(Buffer.from(realJwt.split('.')[0], 'base64url'));
const realKey = snapshot.keys.find(key => key.kid === realHeader.kid);
const storedOptions = { jwks: { keys: [] }, stored: true, snapshot, rootPem };

function mutateClaims(jwt, change) {
  const [header, claims, signature] = jwt.split('.');
  const next = JSON.parse(Buffer.from(claims, 'base64url'));
  change(next);
  return `${header}.${Buffer.from(JSON.stringify(next)).toString('base64url')}.${signature}`;
}

test('a real archived NVIDIA JWT verifies through the stored snapshot and root chain', () => {
  const result = verifyGpuJwt(realJwt, storedOptions);
  assert.equal(result.verdict, true);
  assert.equal(result.keySource, 'snapshot of 2026-11-14, certificate chain checked to NVIDIA Attestation Service CA 001 (CD:E2:69:E3:F7:2C:66:7A:EC:C2:D8:C1:AB:32:C4:E4:2A:AF:55:07:37:9F:15:F2:21:C7:7C:55:18:10:1A:1E)');
  assert.deepEqual(verifyGpuJwt(realJwt, { jwks: { keys: [] }, stored: true }), result, 'default committed evidence is used');
});

test('stored verification binds the leaf certificate to the JWK public key', () => {
  const key = structuredClone(realKey);
  key.x = `${key.x.slice(0, -1)}${key.x.endsWith('A') ? 'B' : 'A'}`;
  assert.throws(() => verifyGpuJwt(realJwt, { ...storedOptions, snapshot: { keys: [key] } }), /leaf public key differs/);
});

test('stored verification rejects a swapped intermediate certificate', () => {
  const key = structuredClone(realKey);
  key.x5c[1] = rootPem.replace(/-----BEGIN CERTIFICATE-----|-----END CERTIFICATE-----|\s/g, '');
  key.x5c[1] = Buffer.from(key.x5c[1], 'base64').toString('base64');
  assert.throws(() => verifyGpuJwt(realJwt, { ...storedOptions, snapshot: { keys: [key] } }), /leaf is not signed by its intermediate/);
});

test('stored verification authenticates both certificate signatures', () => {
  for (const [index, error] of [[0, /leaf is not signed/], [1, /intermediate does not chain/]]) {
    const key = structuredClone(realKey);
    const der = Buffer.from(key.x5c[index], 'base64');
    der[der.length - 1] ^= 1;
    key.x5c[index] = der.toString('base64');
    assert.throws(() => verifyGpuJwt(realJwt, { ...storedOptions, snapshot: { keys: [key] } }), error);
  }
});

test('stored verification rejects noncanonical certificate encodings', () => {
  for (const index of [0, 1]) {
    for (const value of [realKey.x5c[index] + '@@@', Buffer.concat([Buffer.from(realKey.x5c[index], 'base64'), Buffer.from([0])]).toString('base64'), 1]) {
      const key = structuredClone(realKey);
      key.x5c[index] = value;
      assert.throws(() => verifyGpuJwt(realJwt, { ...storedOptions, snapshot: { keys: [key] } }), /canonical base64 DER/);
    }
  }
});

test('stored verification rejects a root PEM with the wrong pinned fingerprint', () => {
  const wrongRoot = new X509Certificate(Buffer.from(realKey.x5c[1], 'base64')).toString();
  assert.throws(() => verifyGpuJwt(realJwt, { ...storedOptions, rootPem: wrongRoot }), /root fingerprint differs from the pin/);
});

test('stored verification checks iat against the leaf validity window before signature', () => {
  const leaf = new X509Certificate(Buffer.from(realKey.x5c[0], 'base64'));
  for (const iat of [Date.parse(leaf.validFrom) / 1000 - 1, Date.parse(leaf.validTo) / 1000 + 1, undefined, '1794511028', null]) {
    const outside = mutateClaims(realJwt, claims => { claims.iat = iat; });
    assert.throws(() => verifyGpuJwt(outside, storedOptions), /certificate chain was not valid at token iat/);
  }
});

test('a live matching key wins even when the stored snapshot and root are corrupt', () => {
  const corruptSnapshot = { keys: [{ ...structuredClone(realKey), x5c: ['not-a-certificate'] }] };
  const result = verifyGpuJwt(realJwt, { jwks: { keys: [realKey] }, stored: true, snapshot: corruptSnapshot, rootPem: 'not-a-root' });
  assert.equal(result.verdict, true);
  assert.equal(result.keySource, 'live JWKS');
});

test('ambiguous or invalid live matches cannot fall back to a valid snapshot', () => {
  assert.throws(() => verifyGpuJwt(realJwt, { ...storedOptions, jwks: { keys: [realKey, realKey] } }), /not found uniquely in NVIDIA JWKS/);
  const other = snapshot.keys.find(key => key.x !== realKey.x);
  assert.ok(other, 'a different real NVIDIA key exists');
  assert.throws(() => verifyGpuJwt(realJwt, { ...storedOptions, jwks: { keys: [{ ...other, kid: realKey.kid }] } }), /signature verification failed/);
});

test('a checked certificate chain still requires the GPU JWT signature', () => {
  const [header, claims, signature] = realJwt.split('.');
  const bytes = Buffer.from(signature, 'base64url');
  bytes[0] ^= 1;
  assert.throws(() => verifyGpuJwt(`${header}.${claims}.${bytes.toString('base64url')}`, storedOptions), /signature verification failed/);
});

test('fresh verification never falls back to the stored snapshot', () => {
  for (const stored of [false, 'false', 1]) {
    assert.throws(() => verifyGpuJwt(realJwt, { jwks: { keys: [] }, stored, snapshot, rootPem }), /key id not found|JWKS/i);
  }
});

test('stored verification reports a retired NVIDIA key distinctly', () => {
  const retired = ruling.record.plan.gpu.jwt;
  const retiredKid = JSON.parse(Buffer.from(retired.split('.')[0], 'base64url')).kid;
  assert.equal(snapshotKids.has(retiredKid), false);
  assert.throws(() => verifyGpuJwt(retired, storedOptions), error => error?.code === 'NVIDIA_KEY_RETIRED');
});
