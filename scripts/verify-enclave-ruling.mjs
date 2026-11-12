// INTEGRATION: read-only verifier; compare the public page with the signed Bet material.
import { pathToFileURL } from 'node:url';
import * as engine from '../server/src/enclave-ruling.mjs';
import { sha256 } from '../server/src/attested-signature.mjs';
import { INTEL_SGX_ROOT_CA_PEM } from '../server/src/tdx-quote.mjs';

const DEFAULT_BASE = 'https://stated-production.up.railway.app';
const DEFAULT_BET = 'c171de89-f223-4309-886e-180ad69af092';
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;

function finish(checks) {
  const passed = checks.filter(check => check.status === 'PASS').length;
  const failed = checks.filter(check => check.status === 'FAIL').length;
  const notChecked = checks.length - passed - failed;
  return { exitCode: failed ? 1 : 0, checks, passed, failed, notChecked,
    summary: `${passed} checks passed, ${failed} failed, ${notChecked} not checked` };
}

// Decode once: a claim containing the literal "&quot;" is escaped as "&amp;quot;".
// These are the named entities emitted by Stated's HTML escaper. Reject other
// names rather than silently comparing an undecoded, untrusted attribute.
function attributeText(value) {
  const named = { amp: '&', AMP: '&', lt: '<', LT: '<', gt: '>', GT: '>', quot: '"', QUOT: '"', apos: "'" };
  return value.replace(/&(#(?:[xX][0-9a-fA-F]+|[0-9]+)|[a-zA-Z][a-zA-Z0-9]*);/g, (entity, name) => {
    if (name[0] !== '#') {
      if (!Object.hasOwn(named, name)) throw new Error(`Unsupported HTML attribute entity ${entity}`);
      return named[name];
    }
    const hex = name[1]?.toLowerCase() === 'x';
    const code = Number.parseInt(name.slice(hex ? 2 : 1), hex ? 16 : 10);
    if (code === 0 || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) return '\ufffd';
    // HTML's numeric references use Windows-1252 for these control values.
    const replacements = { 128: 8364, 130: 8218, 131: 402, 132: 8222, 133: 8230, 134: 8224, 135: 8225,
      136: 710, 137: 8240, 138: 352, 139: 8249, 140: 338, 142: 381, 145: 8216, 146: 8217,
      147: 8220, 148: 8221, 149: 8226, 150: 8211, 151: 8212, 152: 732, 153: 8482, 154: 353,
      155: 8250, 156: 339, 158: 382, 159: 376 };
    return String.fromCodePoint(replacements[code] ?? code);
  });
}

function pageMaterial(page) {
  // Tokenize whole tags, keeping quoted values together. Markers in comments,
  // raw-text elements and inert templates cannot stand in for the public h1.
  const tags = /<!--[\s\S]*?-->|<![^>]*>|<\?[^>]*\?>|<\/?[a-zA-Z][^>"']*(?:(?:"[^"]*"|'[^']*')[^>"']*)*>/g;
  const matches = [];
  let raw = null;
  let templates = 0;
  for (const [tag] of page.matchAll(tags)) {
    const head = tag.match(/^<(\/?)([a-zA-Z][\w:-]*)\b/);
    if (!head) continue;
    const closing = Boolean(head[1]);
    const name = head[2].toLowerCase();
    if (raw) { if (closing && name === raw) raw = null; continue; }
    if (['script', 'style', 'textarea', 'title', 'xmp', 'iframe', 'noembed', 'noframes'].includes(name) && !closing) {
      raw = name;
      continue;
    }
    if (name === 'template') { templates += closing ? -1 : 1; if (templates < 0) throw new Error('Malformed public page template'); continue; }
    if (templates || closing || name !== 'h1') continue;
    const attributes = new Map();
    let rest = tag.slice(head[0].length, -1);
    while (rest.trim() && rest.trim() !== '/') {
      const attribute = rest.match(/^\s+([^\s"'<>\/=]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/);
      if (!attribute) throw new Error('Malformed public page heading attributes');
      const key = attribute[1].toLowerCase();
      if (attributes.has(key)) throw new Error(`Duplicate public page heading attribute ${key}`);
      attributes.set(key, attributeText(attribute[2] ?? attribute[3] ?? attribute[4] ?? ''));
      rest = rest.slice(attribute[0].length);
    }
    if (attributes.has('data-bet-outcome')) matches.push(attributes);
  }
  if (matches.length !== 1) throw new Error('Public page must expose exactly one h1 with displayed Bet material');
  const attributes = matches[0];
  const outcome = attributes.get('data-bet-outcome');
  if (!['yes', 'no', 'void', 'pending'].includes(outcome)) throw new Error('Public page outcome is invalid');
  const claim = attributes.get('data-bet-claim');
  const deadline = attributes.get('data-bet-deadline');
  if (claim === undefined || !deadline) throw new Error('Public page must expose the claim and deadline on its outcome h1');
  return { outcome, claim, deadline, termsHash: attributes.get('data-bet-terms-hash') };
}

function quoteMeasurements(record, add) {
  if (typeof engine.quoteSummary !== 'function') {
    add('NOT CHECKED', 'Quote measurements', 'This engine does not export quoteSummary');
    return;
  }
  const quotes = engine.quoteSummary(record, { roots: [INTEL_SGX_ROOT_CA_PEM] });
  const measurements = ['mrtd', 'rtmr0', 'rtmr1', 'rtmr2', 'rtmr3'];
  if (!Array.isArray(quotes) || !quotes.some(quote => quote?.role === 'gateway') || !quotes.some(quote => quote?.role === 'model')) {
    throw new Error('Quote summary must contain gateway and model measurements');
  }
  for (const quote of quotes) {
    if (!quote || !['gateway', 'model'].includes(quote.role) || typeof quote.model !== 'string' || !quote.model
      || typeof quote.signingAddress !== 'string' || !/^[a-f0-9]{64}$/i.test(quote.signingAddress)
      || measurements.some(name => typeof quote[name] !== 'string' || !/^[a-f0-9]{96}$/i.test(quote[name]))) {
      throw new Error('Quote summary contains malformed measurements');
    }
    add('NOT CHECKED', 'Quote measurements', `Reported, not compared: ${quote.role} ${JSON.stringify(quote.model)}; signing key ${quote.signingAddress}; ${measurements.map(name => `${name} ${quote[name]}`).join('; ')}`);
  }
}

async function readText(url, limit, fetchImpl) {
  let response;
  try { response = await fetchImpl(url, { redirect: 'error', signal: AbortSignal.timeout(30_000) }); }
  catch (error) { throw Object.assign(new Error(error.message), { unavailable: true }); }
  if (!response.ok) throw Object.assign(new Error(`HTTP ${response.status}`), { unavailable: true });
  if (!response.body) throw new Error('Response has no body');
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > limit) throw Object.assign(new Error('Response exceeds size limit'), { invalid: true });
      chunks.push(chunk);
    }
  } catch (error) {
    if (!error.invalid) error.unavailable = true;
    throw error;
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
}

export async function verifyHostedEnclaveRuling(base = DEFAULT_BASE, betId = DEFAULT_BET, { fetchImpl = fetch } = {}) {
  const checks = [];
  const add = (status, check, detail) => checks.push({ status, check, detail });
  let origin;
  try {
    const url = new URL(base);
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
      throw new Error('Base URL must be an HTTP(S) origin');
    }
    if (!UUID.test(betId)) throw new Error('Bet ID must be a UUID');
    betId = betId.toLowerCase();
    origin = url.origin;
    add('PASS', 'Arguments', `Bet ${betId} on ${origin}`);
  } catch (error) {
    add('FAIL', 'Arguments', error.message);
    return finish(checks);
  }

  let record;
  try {
    const body = await readText(new URL(`/bets/${betId}/enclave-ruling.json`, origin), 32_000_000, fetchImpl);
    const document = JSON.parse(body);
    if (!document || typeof document !== 'object' || !document.record || typeof document.recipe !== 'string') {
      throw new Error('Expected record and verification recipe');
    }
    if (typeof engine.verifyEnclaveRecord !== 'function' || typeof engine.rulingCovers !== 'function') {
      throw new Error('Engine must export verifyEnclaveRecord and rulingCovers');
    }
    record = engine.verifyEnclaveRecord(document.record, { roots: [INTEL_SGX_ROOT_CA_PEM] });
    add('PASS', 'Signed ruling', `Verified ${record.mode} outcome ${record.outcome}`);
    add('PASS', 'Intel TDX quotes', 'Gateway and signing-model quotes chain to the pinned Intel SGX root and bind each signing key and request nonce. This is not a measurement match.');
  } catch (error) {
    add('FAIL', 'Signed ruling', error.message);
    return finish(checks);
  }

  const coveredBet = record.material.bets.find(bet => bet.id === betId);
  if (!coveredBet || !engine.rulingCovers(record, { betId, termsHash: coveredBet.termsHash })) {
    add('FAIL', 'Bet coverage', `Signed material does not cover requested Bet ${betId}`);
    return finish(checks);
  }
  add('PASS', 'Bet coverage', `Signed material lists Bet ${betId}; signed terms hash ${coveredBet.termsHash}`);
  try { quoteMeasurements(record, add); }
  catch (error) { add('FAIL', 'Quote measurements', error.message); }
  add('NOT CHECKED', 'Attestation limits', 'No comparison against published enclave measurements; TCB level, revocation lists and other collateral, NVIDIA GPU payload and event-log replay are not checked.');

  add('PASS', 'Jury policy', `Models ${record.jury.models.map(model => JSON.stringify(model)).join(', ')}; minimum confidence ${record.jury.minConfidence}; every model must agree for Yes or No`);
  for (const verdict of record.verdicts) {
    add('PASS', 'Signed model verdict', `${JSON.stringify(verdict.model)} outcome ${verdict.parsed.outcome}; confidence ${verdict.parsed.confidence}`);
  }

  if (record.evidence.kind === 'coinbase-candles') {
    const bodies = [];
    let complete = true;
    for (const url of record.evidence.urls) {
      try {
        // Verification binds every URL, in order, to the server-built segments.
        bodies.push(await readText(url, 200_000, fetchImpl));
        add('PASS', 'Coinbase source', url);
      } catch (error) {
        complete = false;
        add(error.unavailable ? 'NOT CHECKED' : 'FAIL', 'Coinbase source', `${url}: ${error.message}`);
      }
    }
    if (complete) {
      try {
        const { text } = engine.candleEvidence(record.plan.parsed, bodies);
        const textHash = sha256(Buffer.from(text, 'utf8'));
        if (textHash !== record.evidence.textHash) throw new Error('Refetched candles differ from the signed evidence hash');
        add('PASS', 'Coinbase evidence hash', `All segments match signed text hash ${textHash}`);
      } catch (error) {
        add('FAIL', 'Coinbase evidence hash', error.message);
      }
    } else add('NOT CHECKED', 'Coinbase evidence hash', 'Cannot compare the hash without every source response');
  } else {
    add('NOT RE-READ', 'Submitted evidence', `${record.evidence.items.length} links; signed hash ${record.evidence.textHash} covers the evidence text Stated read, not a fresh read of the linked pages`);
    for (const item of record.evidence.items) {
      const posted = item.postedUrl !== item.url ? `; posted URL ${JSON.stringify(item.postedUrl)}` : '';
      add('NOT RE-READ', 'Evidence link', `Side ${item.side}; final URL ${JSON.stringify(item.url)}${posted}; hash of the text Stated read ${item.textHash}`);
    }
  }

  try {
    const page = await readText(new URL(`/bets/${betId}`, origin), 5_000_000, fetchImpl);
    const displayedMaterial = pageMaterial(page);
    const displayed = displayedMaterial.outcome;
    if (displayedMaterial.claim !== record.material.claim) add('FAIL', 'Public claim', 'Page claim differs from the signed claim');
    else add('PASS', 'Public claim', 'Page claim exactly matches the signed claim');
    if (displayedMaterial.deadline !== record.material.deadline) add('FAIL', 'Public deadline', `Page deadline ${JSON.stringify(displayedMaterial.deadline)} differs from signed deadline ${record.material.deadline}`);
    else add('PASS', 'Public deadline', `Page deadline matches signed deadline ${record.material.deadline}`);
    if (displayedMaterial.termsHash !== undefined) {
      if (!displayedMaterial.termsHash || !engine.rulingCovers(record, { betId, termsHash: displayedMaterial.termsHash })) {
        add('FAIL', 'Public terms hash', `Page terms hash ${JSON.stringify(displayedMaterial.termsHash)} is not covered by the signed ruling`);
      } else add('PASS', 'Public terms hash', `Page terms hash matches signed terms hash ${coveredBet.termsHash}`);
    } else add('NOT CHECKED', 'Public terms hash', `Page has no terms hash; compare signed terms hash ${coveredBet.termsHash} with the Bet on chain`);
    const expected = record.outcome === 'unclear' ? 'void' : record.outcome;
    if (displayed === 'pending') {
      add('NOT CHECKED', 'Public outcome', `Settlement is pending; ruling says ${record.outcome}`);
    } else if (displayed !== expected) {
      add('FAIL', 'Public outcome', `Page displays ${displayed}; ruling says ${record.outcome}. ${record.mode === 'review' ? 'The signed second opinion disagrees with the Result.' : 'A reviewer may have corrected the Result.'}`);
    } else add('PASS', 'Public outcome', `Page shows ${displayed}, matching the ruling ${record.outcome}`);
  } catch (error) {
    add('FAIL', 'Public outcome', error.message);
  }
  return finish(checks);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifyHostedEnclaveRuling(process.argv[2], process.argv[3]);
  for (const check of result.checks) console.log(`${check.status} ${check.check}: ${check.detail}`.replace(/[\r\n\u2028\u2029]+/g, ' '));
  console.log(result.summary);
  process.exitCode = result.exitCode;
}
