// INTEGRATION: offline TDX v4 signature/chain authentication; callers supply trust policy.
import {
  X509Certificate, createHash, createPublicKey, generateKeyPairSync, sign,
  timingSafeEqual, verify,
} from 'node:crypto';

// Extracted verbatim from the captured NEAR AI gateway/model PCK chains.
export const INTEL_SGX_ROOT_CA_PEM = `-----BEGIN CERTIFICATE-----
MIICjzCCAjSgAwIBAgIUImUM1lqdNInzg7SVUr9QGzknBqwwCgYIKoZIzj0EAwIw
aDEaMBgGA1UEAwwRSW50ZWwgU0dYIFJvb3QgQ0ExGjAYBgNVBAoMEUludGVsIENv
cnBvcmF0aW9uMRQwEgYDVQQHDAtTYW50YSBDbGFyYTELMAkGA1UECAwCQ0ExCzAJ
BgNVBAYTAlVTMB4XDTE4MDUyMTEwNDUxMFoXDTQ5MTIzMTIzNTk1OVowaDEaMBgG
A1UEAwwRSW50ZWwgU0dYIFJvb3QgQ0ExGjAYBgNVBAoMEUludGVsIENvcnBvcmF0
aW9uMRQwEgYDVQQHDAtTYW50YSBDbGFyYTELMAkGA1UECAwCQ0ExCzAJBgNVBAYT
AlVTMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEC6nEwMDIYZOj/iPWsCzaEKi7
1OiOSLRFhWGjbnBVJfVnkY4u3IjkDYYL0MxO4mqsyYjlBalTVYxFP2sJBK5zlKOB
uzCBuDAfBgNVHSMEGDAWgBQiZQzWWp00ifODtJVSv1AbOScGrDBSBgNVHR8ESzBJ
MEegRaBDhkFodHRwczovL2NlcnRpZmljYXRlcy50cnVzdGVkc2VydmljZXMuaW50
ZWwuY29tL0ludGVsU0dYUm9vdENBLmRlcjAdBgNVHQ4EFgQUImUM1lqdNInzg7SV
Ur9QGzknBqwwDgYDVR0PAQH/BAQDAgEGMBIGA1UdEwEB/wQIMAYBAf8CAQEwCgYI
KoZIzj0EAwIDSQAwRgIhAOW/5QkR+S9CiSDcNoowLuPRLsWGf/Yi7GSX94BgwTwg
AiEA4J0lrHoMs+Xo5o/sX6O9QWxHRAvZUGOdRQ7cvqRXaqI=
-----END CERTIFICATE-----`;

const MAX_QUOTE_BYTES = 64 * 1024;
const MAX_EVENT_LOG_BYTES = 1024 * 1024;
const MAX_EVENTS = 4096;
const HEADER_BYTES = 48;
const BODY_BYTES = 584;
const SIGNED_BYTES = HEADER_BYTES + BODY_BYTES;
const MEASUREMENTS = ['mrtd', 'rtmr0', 'rtmr1', 'rtmr2', 'rtmr3'];
const INTEL_QE_VENDOR_ID = '939a7233f79c4ca9940a0db3957f0607';

function hexBytes(value, name, length) {
  if (typeof value !== 'string') throw new Error(`${name} must be hexadecimal`);
  const raw = value.replace(/^0x/i, '');
  if (!raw.length || raw.length % 2 || (length !== undefined && raw.length !== length * 2)
      || !/^[0-9a-f]+$/i.test(raw)) {
    throw new Error(`${name} must be ${length === undefined ? 'even-length' : `${length}-byte`} hexadecimal`);
  }
  return Buffer.from(raw, 'hex');
}

function equal(a, b) {
  return a.length === b.length && timingSafeEqual(a, b);
}

function reader(bytes, name) {
  let offset = 0;
  return {
    take(size) {
      if (!Number.isSafeInteger(size) || size < 0 || size > bytes.length - offset) {
        throw new Error(`Truncated ${name}`);
      }
      const result = bytes.subarray(offset, offset + size);
      offset += size;
      return result;
    },
    u16() { return this.take(2).readUInt16LE(); },
    u32() { return this.take(4).readUInt32LE(); },
    done() { if (offset !== bytes.length) throw new Error(`Unexpected trailing bytes in ${name}`); },
  };
}

function certificatePems(data) {
  // A single terminal NUL is allowed by DCAP's PEM-chain representation.
  const text = data.toString('utf8').replace(/\0$/, '');
  const pattern = /-----BEGIN CERTIFICATE-----\r?\n[A-Za-z0-9+/=\r\n]+-----END CERTIFICATE-----/g;
  const certificates = text.match(pattern) ?? [];
  if (certificates.length < 2 || certificates.length > 8 || text.replace(pattern, '').trim()) {
    throw new Error('Invalid PCK PEM certificate chain');
  }
  return certificates;
}

/** Parse Intel TDX ECDSA quote v4 (Intel DCAP API, Appendix A.3). No trust decision. */
export function parseTdxQuote(hex) {
  // Check the encoded size before allocating or scanning an unbounded input.
  if (typeof hex !== 'string' || hex.length > MAX_QUOTE_BYTES * 2 + 2) {
    throw new Error('TDX quote exceeds 64 KiB or is not hexadecimal');
  }
  const raw = hexBytes(hex, 'TDX quote');
  if (raw.length > MAX_QUOTE_BYTES) throw new Error('TDX quote exceeds 64 KiB');
  const quote = reader(raw, 'TDX quote');
  const headerRaw = quote.take(HEADER_BYTES);
  const header = {
    version: headerRaw.readUInt16LE(0), attestationKeyType: headerRaw.readUInt16LE(2),
    teeType: headerRaw.readUInt32LE(4), reserved: headerRaw.subarray(8, 12).toString('hex'),
    qeVendorId: headerRaw.subarray(12, 28).toString('hex'),
    userData: headerRaw.subarray(28, 48).toString('hex'),
  };
  if (header.version !== 4 || header.attestationKeyType !== 2 || header.teeType !== 0x81) {
    throw new Error('Only Intel TDX ECDSA P-256 quote version 4 is supported');
  }
  if (header.reserved !== '00000000' || header.qeVendorId !== INTEL_QE_VENDOR_ID) {
    throw new Error('Invalid Intel TDX quote header');
  }
  const bodyReader = reader(quote.take(BODY_BYTES), 'TDX report body');
  const body = {};
  for (const [name, size] of [
    ['teeTcbSvn', 16], ['mrseam', 48], ['mrSignerSeam', 48], ['seamAttributes', 8],
    ['tdAttributes', 8], ['xfam', 8], ['mrtd', 48], ['mrConfigId', 48],
    ['mrOwner', 48], ['mrOwnerConfig', 48], ['rtmr0', 48], ['rtmr1', 48],
    ['rtmr2', 48], ['rtmr3', 48], ['reportData', 64],
  ]) body[name] = bodyReader.take(size).toString('hex');
  bodyReader.done();

  const signatureDataLength = quote.u32();
  const signatureReader = reader(quote.take(signatureDataLength), 'TDX signature data');
  // Both real fixture quotes retain exactly 70 zero allocation-padding bytes.
  // They are outside the declared quote, unauthenticated, and never interpreted.
  // Accept canonical quotes or this exact transport quirk; reject all other tails.
  const paddingBytes = raw.length - (SIGNED_BYTES + 4 + signatureDataLength);
  if (paddingBytes !== 0 && paddingBytes !== 70) throw new Error('Unexpected TDX quote padding');
  if (quote.take(paddingBytes).some(byte => byte !== 0)) throw new Error('Nonzero TDX quote padding');
  quote.done();
  const quoteSignature = signatureReader.take(64);
  const attestationKey = signatureReader.take(64);
  const outerType = signatureReader.u16();
  const outerSize = signatureReader.u32();
  if (outerType !== 6) throw new Error('TDX quote requires QE report certification data (type 6)');
  const qeReader = reader(signatureReader.take(outerSize), 'QE report certification data');
  signatureReader.done();
  const qeReport = qeReader.take(384);
  const qeReportSignature = qeReader.take(64);
  const qeAuthData = qeReader.take(qeReader.u16());
  const type = qeReader.u16();
  const size = qeReader.u32();
  if (type !== 5) throw new Error('TDX quote requires an embedded PCK certificate chain (type 5)');
  const data = qeReader.take(size);
  qeReader.done();
  return {
    version: header.version, teeType: header.teeType, header, body,
    signatureDataLength, paddingBytes, signedData: raw.subarray(0, SIGNED_BYTES),
    signature: { quoteSignature, attestationKey, qeReport, qeReportSignature, qeAuthData },
    certificationData: { type, size, data, certificates: certificatePems(data), outerType, outerSize },
  };
}

function validAt(certificate, now) {
  const start = Date.parse(certificate.validFrom);
  const end = Date.parse(certificate.validTo);
  if (!Number.isFinite(start) || !Number.isFinite(end) || now < start || now > end) {
    throw new Error('PCK certificate is outside its validity period');
  }
}

function p256(key, name) {
  if (key.asymmetricKeyType !== 'ec' || key.asymmetricKeyDetails?.namedCurve !== 'prime256v1') {
    throw new Error(`${name} must be ECDSA P-256`);
  }
  return key;
}

function publicKeyBytes(key) {
  return key.export({ type: 'spki', format: 'der' });
}

function verifyChain(pems, roots, now) {
  if (!Array.isArray(roots) || !roots.length || roots.length > 8) {
    throw new Error('roots must contain between one and eight trusted root certificates');
  }
  if (!(now instanceof Date) || !Number.isFinite(now.getTime())) throw new Error('now must be a valid Date');
  const chain = pems.map(pem => new X509Certificate(pem));
  for (const certificate of chain) validAt(certificate, now.getTime());
  if (chain[0].ca) throw new Error('PCK leaf certificate must not be a CA');
  for (let i = 0; i < chain.length - 1; i += 1) {
    const child = chain[i];
    const issuer = chain[i + 1];
    if (!issuer.ca || child.issuer !== issuer.subject || !child.checkIssued(issuer)
        || !child.verify(issuer.publicKey)) throw new Error('PCK certificate chain verification failed');
  }
  const embeddedRoot = chain.at(-1);
  if (!embeddedRoot.ca || embeddedRoot.subject !== embeddedRoot.issuer
      || !embeddedRoot.verify(embeddedRoot.publicKey)) throw new Error('Invalid embedded PCK root certificate');
  const trusted = roots.map(pem => new X509Certificate(pem)).find(root =>
    equal(publicKeyBytes(root.publicKey), publicKeyBytes(embeddedRoot.publicKey)));
  if (!trusted) throw new Error('PCK root public key is not trusted');
  validAt(trusted, now.getTime());
  if (!trusted.ca || trusted.subject !== trusted.issuer || !trusted.verify(trusted.publicKey)) {
    throw new Error('Invalid trusted PCK root certificate');
  }
  return p256(chain[0].publicKey, 'PCK leaf key');
}

/**
 * Authenticate the quote, QE key binding and embedded certificate chain offline.
 * NOT checked: TCB level, QE identity collateral, certificate revocation collateral
 * (no network), NVIDIA GPU payload or workload allowlist policy. Report-level
 * event-log replay is applied by verifyAttestationReport below.
 * A valid chain/signature alone does not establish an acceptable platform TCB.
 */
export function verifyTdxQuote(hex, { roots = [INTEL_SGX_ROOT_CA_PEM], now = new Date() } = {}) {
  const parsed = parseTdxQuote(hex);
  const { quoteSignature, attestationKey, qeReport, qeReportSignature, qeAuthData } = parsed.signature;
  const leafKey = verifyChain(parsed.certificationData.certificates, roots, now);
  const attestationPublicKey = createPublicKey({
    format: 'jwk', key: {
      kty: 'EC', crv: 'P-256', x: attestationKey.subarray(0, 32).toString('base64url'),
      y: attestationKey.subarray(32).toString('base64url'),
    },
  });
  // Quote EC coordinates and r||s are big-endian byte arrays, unlike length fields.
  if (!verify('sha256', parsed.signedData, { key: attestationPublicKey, dsaEncoding: 'ieee-p1363' }, quoteSignature)) {
    throw new Error('TDX quote signature verification failed');
  }
  if (!verify('sha256', qeReport, { key: leafKey, dsaEncoding: 'ieee-p1363' }, qeReportSignature)) {
    throw new Error('QE report signature verification failed');
  }
  const binding = createHash('sha256').update(attestationKey).update(qeAuthData).digest();
  if (!equal(qeReport.subarray(320, 352), binding) || qeReport.subarray(352).some(byte => byte !== 0)) {
    throw new Error('QE report data does not bind the attestation key and authentication data');
  }
  // TD_ATTRIBUTES bit 0 is DEBUG: a debug TD's memory and keys are open to the host, so it proves nothing.
  if (Buffer.from(parsed.body.tdAttributes, 'hex')[0] & 1) throw new Error('TDX quote is from a debug TD');
  return parsed;
}

function checkedBinding(report, nonceHex, parsed) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) throw new Error('report must be an object');
  if (report.signing_algo !== 'ed25519') throw new Error('report signing algorithm must be ed25519');
  if (('error' in report && report.error != null) || 'error_code' in report) throw new Error('report contains an error');
  const signingAddress = hexBytes(report.signing_address, 'signing_address', 32);
  const nonce = hexBytes(nonceHex, 'nonce', 32);
  if (!equal(hexBytes(report.request_nonce, 'request_nonce', 32), nonce)) throw new Error('request_nonce does not match nonce');
  // NEAR AI layout observed in BOTH captured reports: raw Ed25519 key || raw nonce.
  const reportData = Buffer.from(parsed.body.reportData, 'hex');
  if (!equal(reportData, Buffer.concat([signingAddress, nonce]))) {
    throw new Error('TDX report_data does not bind the signing address and nonce');
  }
  if (report.report_data !== undefined && !equal(hexBytes(report.report_data, 'report_data', 64), reportData)) {
    throw new Error('report_data does not match the quote');
  }
  if (report.signing_public_key !== undefined
      && !equal(hexBytes(report.signing_public_key, 'signing_public_key', 32), signingAddress)) {
    throw new Error('signing_public_key does not match signing_address');
  }
  return { signingAddress: signingAddress.toString('hex') };
}

/** Check binding only; use verifyAttestationReport for authenticated report data. */
export function bindingOf(report, nonceHex) {
  return checkedBinding(report, nonceHex, parseTdxQuote(report?.intel_quote));
}

function parseEventLog(input) {
  if (typeof input === 'string') {
    if (Buffer.byteLength(input) > MAX_EVENT_LOG_BYTES) throw new Error('event_log exceeds 1 MiB');
    try { input = JSON.parse(input); } catch { throw new Error('event_log must be valid JSON'); }
  }
  if (!Array.isArray(input) || input.length > MAX_EVENTS) throw new Error('event_log must be a bounded array');
  let size = 0;
  for (const event of input) {
    if (!event || typeof event !== 'object' || Array.isArray(event)) throw new Error('Invalid event_log event');
    if (event.imr !== 3) continue;
    if (!Number.isInteger(event.event_type) || event.event_type < 0 || event.event_type > 0xffffffff
        || typeof event.event !== 'string' || (event.event_payload != null && typeof event.event_payload !== 'string')
        || (event.digest != null && typeof event.digest !== 'string')) {
      throw new Error('Invalid RTMR3 event');
    }
    size += Buffer.byteLength(event.event) + (event.event_payload?.length ?? 0) + (event.digest?.length ?? 0);
    if (size > MAX_EVENT_LOG_BYTES) throw new Error('event_log exceeds 1 MiB');
    if (event.event_payload) hexBytes(event.event_payload, 'event_payload');
    if (event.digest) hexBytes(event.digest, 'digest', 48);
  }
  return input;
}

function replayEvents(events) {
  let rtmr3 = Buffer.alloc(48);
  for (const event of events) {
    if (event.imr !== 3) continue;
    const eventType = Buffer.alloc(4);
    eventType.writeUInt32LE(event.event_type);
    const payload = event.event_payload ? hexBytes(event.event_payload, 'event_payload') : Buffer.alloc(0);
    const digest = createHash('sha384').update(eventType).update(':').update(event.event, 'utf8')
      .update(':').update(payload).digest();
    if (event.digest && !equal(hexBytes(event.digest, 'digest', 48), digest)) {
      throw new Error(`digest mismatch for event ${event.event}`);
    }
    rtmr3 = createHash('sha384').update(rtmr3).update(digest).digest();
  }
  return rtmr3;
}

export function replayRtmr3(eventLog) {
  return replayEvents(parseEventLog(eventLog));
}

export function verifyAttestationReport(report, nonceHex, options = {}) {
  const parsed = verifyTdxQuote(report?.intel_quote, options);
  const { signingAddress } = checkedBinding(report, nonceHex, parsed);
  const tcbInfo = report.info?.tcb_info;
  if (tcbInfo !== undefined && (!tcbInfo || typeof tcbInfo !== 'object' || Array.isArray(tcbInfo))) {
    throw new Error('info.tcb_info must be an object');
  }
  const measurements = {};
  for (const name of MEASUREMENTS) {
    measurements[name] = parsed.body[name];
    if (tcbInfo && Object.hasOwn(tcbInfo, name)
        && !equal(hexBytes(tcbInfo[name], `info.tcb_info.${name}`, 48), Buffer.from(measurements[name], 'hex'))) {
      throw new Error(`Quote ${name} does not match info.tcb_info`);
    }
  }
  const result = { signingAddress, measurements };
  if (Object.hasOwn(report, 'event_log')) {
    const events = parseEventLog(report.event_log);
    if (!equal(replayEvents(events), Buffer.from(parsed.body.rtmr3, 'hex'))) {
      throw new Error('event log does not match RTMR3');
    }
    for (const event of events) {
      if (event.imr !== 3) continue;
      const payload = event.event_payload ? hexBytes(event.event_payload, 'event_payload') : Buffer.alloc(0);
      if (event.event === 'app-id') result.appId = payload;
      if (event.event === 'compose-hash') result.composeHash = payload;
    }
  }
  return result;
}

// Minimal DER writer used only for the exported, ephemeral test certificate factory.
function der(tag, ...parts) {
  const content = Buffer.concat(parts);
  const length = content.length < 128 ? Buffer.from([content.length])
    : content.length < 256 ? Buffer.from([0x81, content.length])
      : Buffer.from([0x82, content.length >> 8, content.length & 255]);
  return Buffer.concat([Buffer.from([tag]), length, content]);
}
const sequence = (...parts) => der(0x30, ...parts);
const oid = value => der(0x06, Buffer.from(value, 'hex'));
const ECDSA_SHA256 = sequence(oid('2a8648ce3d040302'));
const testName = name => sequence(der(0x31, sequence(oid('550403'), der(0x0c, Buffer.from(name)))));
const TEST_ROOT_NAME = testName('Stated ephemeral test root');

function testCertificate(publicKey, issuerKey, { ca, subject, serial }) {
  const basicConstraints = sequence(oid('551d13'), der(0x01, Buffer.from([255])),
    der(0x04, ca ? sequence(der(0x01, Buffer.from([255]))) : sequence()));
  const keyUsage = sequence(oid('551d0f'), der(0x01, Buffer.from([255])),
    der(0x04, der(0x03, Buffer.from(ca ? [1, 6] : [7, 128]))));
  const tbs = sequence(
    der(0xa0, der(0x02, Buffer.from([2]))), der(0x02, Buffer.from([serial])), ECDSA_SHA256,
    TEST_ROOT_NAME, sequence(der(0x17, Buffer.from('200101000000Z')), der(0x17, Buffer.from('491231235959Z'))),
    subject, publicKeyBytes(publicKey), der(0xa3, sequence(basicConstraints, keyUsage)),
  );
  const certificate = sequence(tbs, ECDSA_SHA256, der(0x03, Buffer.from([0]), sign('sha256', tbs, issuerKey)));
  return `-----BEGIN CERTIFICATE-----\n${certificate.toString('base64').match(/.{1,64}/g).join('\n')}\n-----END CERTIFICATE-----\n`;
}

/** Test-only helper. Returns { rootKey: private KeyObject, rootPem: string }. */
export function makeTestRoot() {
  const { privateKey: rootKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  return { rootKey, rootPem: testCertificate(publicKey, rootKey, { ca: true, subject: TEST_ROOT_NAME, serial: 1 }) };
}

function littleEndian(value, size) {
  const result = Buffer.alloc(size);
  if (size === 2) result.writeUInt16LE(value); else result.writeUInt32LE(value);
  return result;
}

/** Test-only helper. Returns quote hex; its root is never trusted by default. debug sets TD_ATTRIBUTES bit 0. */
export function makeTestQuote({ signingAddress, nonceHex, rootKey, debug = false, rtmr3 }) {
  p256(rootKey, 'test root key');
  if (rootKey.type !== 'private') throw new Error('test root key must be private');
  const reportData = Buffer.concat([hexBytes(signingAddress, 'signingAddress', 32), hexBytes(nonceHex, 'nonce', 32)]);
  const { privateKey: pckKey, publicKey: pckPublicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const { privateKey: akKey, publicKey: akPublicKey } = generateKeyPairSync('ec', { namedCurve: 'prime256v1' });
  const rootPem = testCertificate(createPublicKey(rootKey), rootKey, { ca: true, subject: TEST_ROOT_NAME, serial: 1 });
  const leafPem = testCertificate(pckPublicKey, rootKey, { ca: false, subject: testName('Stated test PCK'), serial: 2 });
  const header = Buffer.alloc(HEADER_BYTES);
  header.writeUInt16LE(4, 0);
  header.writeUInt16LE(2, 2);
  header.writeUInt32LE(0x81, 4);
  Buffer.from(INTEL_QE_VENDOR_ID, 'hex').copy(header, 12);
  const body = Buffer.alloc(BODY_BYTES);
  if (rtmr3 !== undefined) hexBytes(rtmr3, 'rtmr3', 48).copy(body, 472);
  reportData.copy(body, 520);
  // tdAttributes follows teeTcbSvn (16), mrseam (48), mrSignerSeam (48) and seamAttributes (8).
  if (debug) body[120] |= 1;
  const signedData = Buffer.concat([header, body]);
  const jwk = akPublicKey.export({ format: 'jwk' });
  const attestationKey = Buffer.concat([Buffer.from(jwk.x, 'base64url'), Buffer.from(jwk.y, 'base64url')]);
  const qeAuthData = Buffer.alloc(32);
  const qeReport = Buffer.alloc(384);
  createHash('sha256').update(attestationKey).update(qeAuthData).digest().copy(qeReport, 320);
  const pems = Buffer.from(leafPem + rootPem);
  const qeData = Buffer.concat([
    qeReport, sign('sha256', qeReport, { key: pckKey, dsaEncoding: 'ieee-p1363' }),
    littleEndian(qeAuthData.length, 2), qeAuthData,
    littleEndian(5, 2), littleEndian(pems.length, 4), pems,
  ]);
  const signatureData = Buffer.concat([
    sign('sha256', signedData, { key: akKey, dsaEncoding: 'ieee-p1363' }), attestationKey,
    littleEndian(6, 2), littleEndian(qeData.length, 4), qeData,
  ]);
  return Buffer.concat([signedData, littleEndian(signatureData.length, 4), signatureData]).toString('hex');
}
