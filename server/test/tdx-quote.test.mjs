import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { X509Certificate } from 'node:crypto';
import {
  INTEL_SGX_ROOT_CA_PEM, bindingOf, makeTestQuote, makeTestRoot, parseTdxQuote,
  verifyAttestationReport, verifyTdxQuote,
} from '../src/tdx-quote.mjs';

const fixture = JSON.parse(readFileSync(new URL('./fixtures/nearai-attestation-20261111.json', import.meta.url)));
const nonce = readFileSync(new URL('./fixtures/nearai-attestation-20261111.nonce', import.meta.url), 'utf8').trim();
const now = new Date('2026-11-12T00:00:00Z');
const reports = [['gateway', fixture.gateway_attestation], ['model', fixture.model_attestations[0]]];
const gateway = fixture.gateway_attestation;
const parsedGateway = parseTdxQuote(gateway.intel_quote);
const canonicalBytes = 636 + parsedGateway.signatureDataLength;

function flip(hex, offset) {
  const bytes = Buffer.from(hex, 'hex');
  bytes[offset] ^= 1;
  return bytes.toString('hex');
}

function writeLength(hex, offset, value, size = 4) {
  const bytes = Buffer.from(hex, 'hex');
  if (size === 2) bytes.writeUInt16LE(value, offset); else bytes.writeUInt32LE(value, offset);
  return bytes.toString('hex');
}

for (const [name, report] of reports) {
  test(`real ${name} fixture authenticates with the captured nonce and fixed date`, () => {
    const parsed = verifyTdxQuote(report.intel_quote, { now });
    assert.equal(parsed.version, 4);
    assert.equal(parsed.teeType, 0x81);
    assert.equal(parsed.header.attestationKeyType, 2);
    assert.equal(parsed.signature.quoteSignature.length, 64);
    assert.equal(parsed.signature.attestationKey.length, 64);
    assert.equal(parsed.signature.qeReport.length, 384);
    assert.equal(parsed.certificationData.type, 5);
    assert.equal(parsed.certificationData.outerType, 6);
    assert.equal(parsed.certificationData.certificates.length, 3);
    assert.equal(parsed.paddingBytes, 70);
    assert.equal(parsed.body.reportData, report.signing_address + nonce);
    assert.deepEqual(bindingOf(report, nonce), { signingAddress: report.signing_address });
    const verified = verifyAttestationReport(report, nonce, { now });
    assert.equal(verified.signingAddress, report.signing_address);
    assert.deepEqual(verified.measurements, Object.fromEntries(
      ['mrtd', 'rtmr0', 'rtmr1', 'rtmr2', 'rtmr3'].map(key => [key, report.info.tcb_info[key]]),
    ));
  });

  test(`real ${name} rejects a different nonce even if the echoed nonce is changed`, () => {
    const otherNonce = flip(nonce, 0);
    assert.throws(() => verifyAttestationReport(report, otherNonce, { now }), /request_nonce/);
    assert.throws(() => verifyAttestationReport({ ...report, request_nonce: otherNonce }, otherNonce, { now }), /does not bind/);
  });

  test(`real ${name} rejects a different signing address`, () => {
    assert.throws(() => verifyAttestationReport({ ...report, signing_address: flip(report.signing_address, 0) }, nonce, { now }), /does not bind/);
  });
}

test('embedded Intel root has the captured identity and SHA-256 fingerprint', () => {
  const root = new X509Certificate(INTEL_SGX_ROOT_CA_PEM);
  assert.equal(root.fingerprint256, '44:A0:19:6B:2B:99:F8:89:B8:E1:49:E9:5B:80:7A:35:0E:74:24:96:43:99:E8:85:A7:CB:B8:CC:FA:B6:74:D3');
  assert.equal(root.subject, 'CN=Intel SGX Root CA\nO=Intel Corporation\nL=Santa Clara\nST=CA\nC=US');
  for (const [, report] of reports) {
    const embedded = parseTdxQuote(report.intel_quote).certificationData.certificates.at(-1);
    assert.deepEqual(new X509Certificate(embedded).raw, root.raw);
  }
});

test('flipping a TD body byte invalidates the quote signature', () => {
  assert.throws(() => verifyTdxQuote(flip(gateway.intel_quote, 184), { now }), /quote signature verification failed/);
});

test('flipping the quote signature invalidates it', () => {
  assert.throws(() => verifyTdxQuote(flip(gateway.intel_quote, 636), { now }), /quote signature verification failed/);
});

test('flipping the QE report signature invalidates it', () => {
  assert.throws(() => verifyTdxQuote(flip(gateway.intel_quote, 770 + 384), { now }), /QE report signature verification failed/);
});

test('QE authentication data must bind to the certified attestation key', () => {
  // Auth bytes are outside the quote signature and the signed QE report itself.
  assert.throws(() => verifyTdxQuote(flip(gateway.intel_quote, 1220), { now }), /does not bind the attestation key/);
});

test('flipping a certificate signature byte invalidates the embedded chain', () => {
  const pem = parsedGateway.certificationData.certificates[0];
  const der = Buffer.from(pem.replace(/-----[^-]+-----|\s/g, ''), 'base64');
  der[der.length - 1] ^= 1;
  const changed = `-----BEGIN CERTIFICATE-----\n${der.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----`;
  assert.equal(changed.length, pem.length);
  const bytes = Buffer.from(gateway.intel_quote, 'hex');
  const offset = bytes.indexOf(Buffer.from(pem));
  assert.ok(offset > 0);
  Buffer.from(changed).copy(bytes, offset);
  assert.throws(() => verifyTdxQuote(bytes.toString('hex'), { now }), /certificate chain verification failed/);
});

test('a fresh synthetic quote authenticates only against its own root', () => {
  const { rootKey, rootPem } = makeTestRoot();
  const quote = makeTestQuote({ signingAddress: gateway.signing_address, nonceHex: nonce, rootKey });
  const parsed = verifyTdxQuote(quote, { roots: [rootPem], now });
  assert.equal(parsed.body.reportData, gateway.signing_address + nonce);
  assert.equal(parsed.paddingBytes, 0);
  const report = { ...gateway, intel_quote: quote, info: undefined };
  assert.deepEqual(verifyAttestationReport(report, nonce, { roots: [rootPem], now }), {
    signingAddress: gateway.signing_address,
    measurements: Object.fromEntries(['mrtd', 'rtmr0', 'rtmr1', 'rtmr2', 'rtmr3'].map(key => [key, '00'.repeat(48)])),
  });
  assert.throws(() => verifyTdxQuote(quote, { now }), /root public key is not trusted/);
  assert.throws(() => verifyTdxQuote(quote, { roots: [makeTestRoot().rootPem], now }), /root public key is not trusted/);
  assert.throws(() => verifyTdxQuote(gateway.intel_quote, { roots: [rootPem], now }), /root public key is not trusted/);
});

test('a quote from a debug TD is rejected; test quotes and the real fixtures are not debug', () => {
  const { rootKey, rootPem } = makeTestRoot();
  const plain = makeTestQuote({ signingAddress: gateway.signing_address, nonceHex: nonce, rootKey });
  assert.equal(Buffer.from(parseTdxQuote(plain).body.tdAttributes, 'hex')[0] & 1, 0);
  verifyTdxQuote(plain, { roots: [rootPem], now });
  const debug = makeTestQuote({ signingAddress: gateway.signing_address, nonceHex: nonce, rootKey, debug: true });
  assert.equal(Buffer.from(parseTdxQuote(debug).body.tdAttributes, 'hex')[0] & 1, 1);
  assert.throws(() => verifyTdxQuote(debug, { roots: [rootPem], now }), /debug TD/);
  assert.throws(() => verifyAttestationReport({ ...gateway, intel_quote: debug, info: undefined }, nonce, { roots: [rootPem], now }), /debug TD/);
  // The captured NEAR AI quotes are production TDs, and still verify against the Intel root.
  assert.equal(Buffer.from(parseTdxQuote(gateway.intel_quote).body.tdAttributes, 'hex')[0] & 1, 0);
  verifyTdxQuote(gateway.intel_quote, { now });
});

test('checks certificate validity and rejects an invalid verification date', () => {
  for (const date of ['2026-11-01T00:00:00Z', '2050-01-01T00:00:00Z']) {
    assert.throws(() => verifyTdxQuote(gateway.intel_quote, { now: new Date(date) }), /validity period/);
  }
  assert.throws(() => verifyTdxQuote(gateway.intel_quote, { now: new Date('invalid') }), /valid Date/);
  assert.throws(() => verifyTdxQuote(gateway.intel_quote, { roots: [], now }), /roots must contain/);
});

for (const measurement of ['mrtd', 'rtmr0', 'rtmr1', 'rtmr2', 'rtmr3']) {
  test(`rejects an echoed ${measurement} that differs from the signed quote`, () => {
    const report = { ...gateway, info: { tcb_info: { ...gateway.info.tcb_info,
      [measurement]: flip(gateway.info.tcb_info[measurement], 0) } } };
    assert.throws(() => verifyAttestationReport(report, nonce, { now }), new RegExp(`Quote ${measurement} does not match`));
  });
}

test('checks optional report_data and signing_public_key echoes', () => {
  assert.throws(() => verifyAttestationReport({ ...gateway, report_data: flip(gateway.report_data, 0) }, nonce, { now }), /report_data does not match/);
  assert.throws(() => verifyAttestationReport({ ...gateway, signing_public_key: '00'.repeat(32) }, nonce, { now }), /signing_public_key does not match/);
  assert.throws(() => verifyAttestationReport({ ...gateway, signing_algo: 'ecdsa' }, nonce, { now }), /must be ed25519/);
  assert.throws(() => verifyAttestationReport({ ...gateway, error: 'unavailable' }, nonce, { now }), /contains an error/);
});

test('rejects junk, malformed hex, non-strings and oversized inputs with Error', () => {
  for (const input of ['abcd', '', '0x', 'abc', 'zz', null, {}, '00'.repeat(65537)]) {
    assert.throws(() => parseTdxQuote(input), Error);
    assert.throws(() => verifyTdxQuote(input, { now }), Error);
  }
});

test('every truncated declared-quote prefix fails with a controlled Error', () => {
  for (let length = 0; length < canonicalBytes; length += 1) {
    assert.throws(() => parseTdxQuote(gateway.intel_quote.slice(0, length * 2)), error => error.constructor === Error,
      `truncated quote length ${length}`);
  }
});

test('accepts canonical length and exact fixture padding, rejects other trailing data', () => {
  const canonical = gateway.intel_quote.slice(0, canonicalBytes * 2);
  assert.equal(verifyTdxQuote(canonical, { now }).paddingBytes, 0);
  for (let length = canonicalBytes + 1; length < gateway.intel_quote.length / 2; length += 1) {
    assert.throws(() => parseTdxQuote(gateway.intel_quote.slice(0, length * 2)), /padding/);
  }
  assert.throws(() => parseTdxQuote(canonical + '00'), /padding/);
  assert.throws(() => parseTdxQuote(gateway.intel_quote + '00'), /padding/);
  assert.throws(() => parseTdxQuote(flip(gateway.intel_quote, canonicalBytes)), /Nonzero/);
});

test('all nested sizes and certification types are bounded and exact', () => {
  for (const [offset, size] of [[632, 4], [766, 4], [1218, 2], [1254, 4]]) {
    for (const value of [0, size === 2 ? 65535 : 0xffffffff]) {
      assert.throws(() => parseTdxQuote(writeLength(gateway.intel_quote, offset, value, size)), Error);
    }
  }
  assert.throws(() => parseTdxQuote(writeLength(gateway.intel_quote, 764, 5, 2)), /type 6/);
  assert.throws(() => parseTdxQuote(writeLength(gateway.intel_quote, 1252, 6, 2)), /type 5/);
  for (const offset of [0, 2, 4, 8, 12]) assert.throws(() => parseTdxQuote(flip(gateway.intel_quote, offset)), Error);
});
