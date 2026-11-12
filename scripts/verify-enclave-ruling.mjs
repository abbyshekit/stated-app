// INTEGRATION: read-only verifier; compare the public page with the signed Bet material.
import { pathToFileURL } from 'node:url';
import { readFile } from 'node:fs/promises';
import * as engine from '../server/src/enclave-ruling.mjs';
import { sha256 } from '../server/src/attested-signature.mjs';
import { INTEL_SGX_ROOT_CA_PEM, parseTdxQuote } from '../server/src/tdx-quote.mjs';
import { getGpuJwks, verifyGpuPayload } from '../server/src/gpu-attestation.mjs';
import { verifyWithDstack, dstackPasses, validateDstackVerifierUrl } from '../server/src/dstack-verifier.mjs';
import { fingerprint } from '../server/src/canonical.mjs';
import { proposalKind } from '../server/src/court-dao.mjs';

const DEFAULT_BASE = 'https://stated-production.up.railway.app';
const DEFAULT_BET = 'c171de89-f223-4309-886e-180ad69af092';
export const DEFAULT_DSTACK_VERIFIER = 'https://dstack-verifier-production.up.railway.app';
const UUID = /^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i;
const COURT_RPC = ['https://archival-rpc.testnet.fastnear.com', 'https://archival-rpc.testnet.near.org'];
const COURT_DAO = 'stated-court.sputnik-v2.testnet';
const COURT_ESCROW = 'stated-escrow-52081551be.testnet';
const OFFLINE_REASON = '(offline: needs the network)';
const offlineFetch = () => { throw new Error('Network access is forbidden in offline mode'); };

async function archivalCourtView(dao, method, args, fetchImpl) {
  const errors = [];
  for (const url of COURT_RPC) {
    try {
      const response = await fetchImpl(url, { method: 'POST', redirect: 'error', signal: AbortSignal.timeout(30_000),
        headers: { 'content-type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 'court-ruling', method: 'query',
          params: { request_type: 'call_function', finality: 'final', account_id: dao, method_name: method,
            args_base64: Buffer.from(JSON.stringify(args)).toString('base64') } }) });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const chunks = []; let size = 0;
      if (!response.body) throw new Error('RPC response has no body');
      for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 5_000_000) throw new Error('Court RPC response exceeds size limit');
        chunks.push(chunk);
      }
      const reply = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      if (reply.error || reply.result?.error || !Array.isArray(reply.result?.result)) throw new Error('Court RPC did not return a view result');
      return JSON.parse(Buffer.from(reply.result.result).toString('utf8'));
    } catch (error) { errors.push(`${url}: ${error.message}`); }
  }
  throw new Error(errors.join('; '));
}

/** Anchors the exact fetched document.record, using canonicalJson UTF-8 with
 * sorted object keys and no trailing newline, just as court-dao.mjs does. */
export async function verifyCourtProposal(record, betId, add, { fetchImpl = fetch, dao = COURT_DAO, escrow = COURT_ESCROW, offline = false } = {}) {
  if (offline) {
    add('NOT CHECKED', 'Court proposal', `Cannot read the on-chain proposal for Bet ${betId} ${OFFLINE_REASON}`);
    return;
  }
  try {
    let end = Number(await archivalCourtView(dao, 'get_last_proposal_id', {}, fetchImpl));
    if (!Number.isSafeInteger(end) || end < 0) throw new Error('Invalid court proposal count');
    let proposal;
    while (end > 0 && !proposal) {
      const from = Math.max(0, end - 100);
      const rows = await archivalCourtView(dao, 'get_proposals', { from_index: from, limit: end - from }, fetchImpl);
      if (!Array.isArray(rows)) throw new Error('Invalid court proposal list');
      // Identify by Bet id before validating the action, so a changed outcome,
      // receiver, deposit or method cannot be mistaken for a missing proposal.
      proposal = rows.reverse().find(row => row?.kind?.FunctionCall?.actions?.some(action => {
        try { return JSON.parse(Buffer.from(action.args, 'base64').toString('utf8'))?.id === betId; }
        catch { return false; }
      }));
      end = from;
    }
    if (!proposal) {
      // A Bet made before the Court existed names the server's referee account: no proposal applies.
      let referee = null;
      try { referee = (await archivalCourtView(escrow, 'get_bet', { id: betId }, fetchImpl))?.referee ?? null; } catch { /* unknown */ }
      if (typeof referee === 'string' && referee && referee !== dao) {
        add('N/A', 'Court proposal', `Bet ${betId} names ${referee} as its referee, not ${dao}, so no Court proposal applies.`);
      } else add('NOT CHECKED', 'Court proposal', `Bet ${betId} has no court proposal on ${dao}.`);
      return;
    }
    const expected = record.outcome === 'unclear' ? 'void' : record.outcome;
    if (!['yes', 'no', 'void'].includes(expected)
      || fingerprint(proposal.kind) !== fingerprint(proposalKind({ nearContract: escrow }, betId, expected))) {
      add('FAIL', 'Court proposal', `Proposal ${proposal.id} does not resolve this Bet with the recorded outcome and exact escrow action.`);
      return;
    }
    const hashes = [...String(proposal.description || '').matchAll(/\bruling sha256:([a-f0-9]{64})(?=\s|$)/g)].map(match => match[1]);
    const digest = fingerprint(record);
    if (hashes.length !== 1 || hashes[0] !== digest) {
      add('FAIL', 'Court proposal', `Proposal ${proposal.id} does not carry the SHA-256 of the fetched ruling record (${digest}).`);
      return;
    }
    add('PASS', 'Court proposal', `${dao} proposal ${proposal.id} resolves Bet ${betId} as ${expected} and anchors ruling sha256:${digest}.`);
  } catch (error) { add('FAIL', 'Court proposal', `Could not read or validate the court proposal: ${error.message}`); }
}

export function parseVerifierArguments(args, env = process.env) {
  const positional = [];
  let offlineFile;
  let verifier = env.DSTACK_VERIFIER_URL || DEFAULT_DSTACK_VERIFIER;
  let seen = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--offline') {
      if (offlineFile !== undefined || !args[i + 1] || args[i + 1].startsWith('-')) throw new Error('--offline requires one file path');
      offlineFile = args[++i];
    } else if (args[i] === '--dstack-verifier') {
      if (seen || !args[i + 1] || args[i + 1].startsWith('--')) throw new Error('--dstack-verifier requires one URL');
      verifier = args[++i];
      seen = true;
    } else if (args[i].startsWith('-')) throw new Error(`Unknown option ${args[i]}`);
    else positional.push(args[i]);
  }
  if (offlineFile !== undefined) {
    if (positional.length || seen) throw new Error('Usage: --offline FILE (without a base URL, Bet ID or --dstack-verifier)');
    return { offlineFile };
  }
  if (positional.length > 2) throw new Error('Expected at most a base URL and Bet ID');
  return { base: positional[0], betId: positional[1], dstackVerifierUrl: validateDstackVerifierUrl(verifier) };
}

function finish(checks) {
  const passed = checks.filter(check => check.status === 'PASS').length;
  const failed = checks.filter(check => check.status === 'FAIL').length;
  const notApplicable = checks.filter(check => check.status === 'N/A').length;
  const notChecked = checks.length - passed - failed - notApplicable;
  // 0: every check that applies passed. 2: none failed, but some could not be checked (they say why).
  // 1: at least one failed. Links the jury read are reported, not re-read, and do not make a run incomplete.
  const incomplete = checks.some(check => check.status === 'NOT CHECKED');
  return { exitCode: failed ? 1 : incomplete ? 2 : 0, checks, passed, failed, notChecked, notApplicable,
    summary: `${passed} checks passed, ${failed} failed, ${notChecked} not checked${notApplicable ? `, ${notApplicable} not applicable` : ''}` };
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

export async function verifyRulingAttestations(record, add, { fetchImpl = fetch, jwks, offline = false, dstackVerifierUrl = process.env.DSTACK_VERIFIER_URL || DEFAULT_DSTACK_VERIFIER } = {}) {
  const failures = [];
  const unavailable = [];
  for (const [role, call] of [['plan', record.plan], ...record.verdicts.map(call => ['verdict', call])]) {
    const name = `${role} ${JSON.stringify(call.model)}`;
    const normalize = value => String(value).replace(/^0x/i, '').toLowerCase();
    const matches = call.attestation.model_attestations.filter(candidate =>
      candidate.signing_algo === call.signature.signing_algo &&
      normalize(candidate.signing_address) === normalize(call.signature.signing_address));
    if (matches.length !== 1) {
      add('FAIL', 'Quote measurements', `${name}: signing report is not unique`);
      failures.push(`${name}: signing report is not unique`);
      continue;
    }
    const reports = [['gateway', call.attestation.gateway_attestation], ['model', matches[0]]];
    for (const [kind, report] of reports) {
      const label = `${name} ${kind}`;
      const stored = call.dstack?.[kind];
      if (stored) add(stored.error ? 'NOT CHECKED' : dstackPasses(stored) ? 'PASS' : 'FAIL',
        'Stored dstack verification', `${label}; ${JSON.stringify(stored)}`);
      if (offline) {
        add('NOT CHECKED', 'Quote measurements', `Cannot compare ${label} with the published dstack image ${OFFLINE_REASON}`);
        continue;
      }
      try {
        const result = await verifyWithDstack(report, { url: dstackVerifierUrl, fetchImpl, signal: AbortSignal.timeout(90_000) });
        if (!dstackPasses(result) || !result.osImageHash || !result.osImageVersion) {
          const reason = result.reason || `policy status: isValid=${result.isValid}, quote=${result.quoteVerified}, eventLog=${result.eventLogVerified}, image=${result.osImageHashVerified}, ACPI=${result.acpiTablesVerified}, dev=${result.osImageIsDev}, TCB=${result.tcbStatus}, imageVersion=${result.osImageVersion}, imageHash=${result.osImageHash}`;
          add('FAIL', 'Quote measurements', `Checked now: ${label}; ${reason}`);
          failures.push(`${label}: ${reason}`);
        } else {
          add('PASS', 'Quote measurements', `Checked now: ${label}; MRTD and RTMR0-2 match the published dstack ${result.osImageVersion} image named by os_image_hash ${result.osImageHash.slice(0, 12)}; production build`);
          if (result.advisoryIds.length) failures.push(`${label}: advisories ${result.advisoryIds.join(', ')}`);
        }
      } catch (error) {
        if (error.unavailable) {
          unavailable.push(`${label}: ${error.message}`);
          const { body } = parseTdxQuote(report.intel_quote);
          const measurements = ['mrtd', 'rtmr0', 'rtmr1', 'rtmr2', 'rtmr3'].map(key => `${key} ${body[key]}`).join('; ');
          add('NOT CHECKED', 'Quote measurements', `Reported, not compared: ${label}; ${measurements}; ${error.message}`);
        } else {
          failures.push(`${label}: ${error.message}`);
          add('FAIL', 'Quote measurements', `Checked now: ${label}; ${error.message}`);
        }
      }
    }
    if (offline && ((Object.hasOwn(call, 'gpu') && jwks === undefined)
      || (!Object.hasOwn(call, 'gpu') && Object.hasOwn(matches[0], 'nvidia_payload')))) {
      add('NOT CHECKED', 'GPU attestation', `${name}; ${Object.hasOwn(call, 'gpu')
        ? 'NVIDIA signing keys are not supplied' : 'Stored raw evidence requires NVIDIA NRAS and signing keys'} ${OFFLINE_REASON}`);
    } else if (call.gpu) add('PASS', 'GPU attestation', `NVIDIA NRAS verdict true, signed token verified; ${name}`);
    else if (Object.hasOwn(matches[0], 'nvidia_payload')) {
      try {
        await verifyGpuPayload(matches[0].nvidia_payload, call.nonce, { fetchImpl });
        add('PASS', 'GPU attestation', `NVIDIA NRAS verifies the stored evidence (checked now); ${name}`);
      } catch (error) { add('FAIL', 'GPU attestation', `${name}; ${error.message}`); }
    } else add('NOT CHECKED', 'GPU attestation', `no GPU evidence stored; ${name}`);
  }
  if (failures.length) add('FAIL', 'Intel collateral', failures.join('; '));
  if (unavailable.length) add('NOT CHECKED', 'Attestation limits', `Intel collateral unavailable: ${unavailable.join('; ')}`);
  if (offline) add('NOT CHECKED', 'Intel collateral', `Cannot check current TCB status, revocation or advisories through the dstack verifier ${OFFLINE_REASON}`);
  else if (!failures.length && !unavailable.length) add('PASS', 'Intel collateral', 'TCB UpToDate, no advisories, for every report');
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

export async function verifyHostedEnclaveRuling(base = DEFAULT_BASE, betId = DEFAULT_BET, { fetchImpl = fetch, document: suppliedDocument, offline = false, jwks, dstackVerifierUrl = process.env.DSTACK_VERIFIER_URL || DEFAULT_DSTACK_VERIFIER } = {}) {
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
    if (!offline) dstackVerifierUrl = validateDstackVerifierUrl(dstackVerifierUrl);
    add('PASS', 'Arguments', offline ? `Bet ${betId} from the saved document` : `Bet ${betId} on ${origin}`);
    if (offline) add('NOT CHECKED', 'Dstack verifier', `Cannot contact the dstack verifier ${OFFLINE_REASON}`);
    else add('PASS', 'Dstack verifier', dstackVerifierUrl === DEFAULT_DSTACK_VERIFIER
      ? `${dstackVerifierUrl} is a Stated-hosted copy of the official image, so this run trusts Stated for the measurement check; for an independent one, run docker run -p 8080:8080 ghcr.io/dstack-tee/dstack-verifier:0.6.3, then pass --dstack-verifier http://localhost:8080`
      : `${dstackVerifierUrl}, your own instance of the official image`);
  } catch (error) {
    add('FAIL', 'Arguments', error.message);
    return finish(checks);
  }

  let record;
  try {
    if (offline && suppliedDocument === undefined) throw new Error('Offline verification requires a saved document');
    const document = offline || suppliedDocument !== undefined ? suppliedDocument
      : JSON.parse(await readText(new URL(`/bets/${betId}/enclave-ruling.json`, origin), 32_000_000, fetchImpl));
    if (!document || typeof document !== 'object' || !document.record || typeof document.recipe !== 'string') {
      throw new Error('Expected record and verification recipe');
    }
    if (typeof engine.verifyEnclaveRecord !== 'function' || typeof engine.rulingCovers !== 'function') {
      throw new Error('Engine must export verifyEnclaveRecord and rulingCovers');
    }
    const calls = [document.record.plan, ...(document.record.verdicts || [])];
    if (!offline && jwks === undefined && calls.some(call => call && Object.hasOwn(call, 'gpu'))) {
      jwks = await getGpuJwks({ fetchImpl });
    }
    // GPU tokens are unsigned supplemental attachments, not part of the model's
    // signed bytes. Without independently supplied NVIDIA keys, defer only that
    // attachment check; retain the original record for explicit NOT CHECKED rows.
    const withoutGpu = call => {
      if (!call || typeof call !== 'object') return call;
      if (Object.hasOwn(call, 'gpu')) {
        try {
          // An explicit null bypasses the process-wide key cache. Reuse the
          // metadata/JWT shape checks, deferring only the missing-key boundary.
          engine.verifyRulingGpu(call, { jwks: null });
        } catch (error) {
          if (error.message !== 'NVIDIA JWKS must contain keys') throw error;
        }
      }
      const signedCall = { ...call };
      delete signedCall.gpu;
      return signedCall;
    };
    const coreRecord = offline && jwks === undefined ? { ...document.record,
      plan: withoutGpu(document.record.plan),
      verdicts: Array.isArray(document.record.verdicts) ? document.record.verdicts.map(withoutGpu) : document.record.verdicts,
    } : document.record;
    engine.verifyEnclaveRecord(coreRecord, { roots: [INTEL_SGX_ROOT_CA_PEM], jwks });
    record = document.record;
    add('PASS', 'Signed ruling', `Verified ${record.mode} outcome ${record.outcome}`);
    add('PASS', 'Intel TDX quotes', 'Gateway and signing-model quotes chain to the pinned Intel SGX root and bind each signing key and request nonce; event logs replay against RTMR3. Measurement matching is checked separately.');
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
  await verifyCourtProposal(record, betId, add, { fetchImpl, offline });
  try { await verifyRulingAttestations(record, add, { fetchImpl, jwks, dstackVerifierUrl, offline }); }
  catch (error) { add('FAIL', 'Quote measurements', error.message); }

  add('PASS', 'Jury policy', `Models ${record.jury.models.map(model => JSON.stringify(model)).join(', ')}; minimum confidence ${record.jury.minConfidence}; every model must agree for Yes or No`);
  for (const verdict of record.verdicts) {
    add('PASS', 'Signed model verdict', `${JSON.stringify(verdict.model)} outcome ${verdict.parsed.outcome}; confidence ${verdict.parsed.confidence}`);
  }

  if (record.evidence.kind === 'coinbase-candles') {
    if (offline) add('PASS', 'Stored Coinbase evidence', `Stored candle text matches signed evidence hash ${record.evidence.textHash} and is exactly the evidence in every signed jury request`);
    const bodies = [];
    let complete = true;
    for (const url of record.evidence.urls) {
      if (offline) {
        complete = false;
        add('NOT CHECKED', 'Coinbase source', `Cannot refetch ${url} ${OFFLINE_REASON}`);
        continue;
      }
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
    } else add('NOT CHECKED', 'Coinbase evidence hash', offline
      ? `Cannot compare refetched candles with the signed hash ${OFFLINE_REASON}`
      : 'Cannot compare the hash without every source response');
  } else {
    add('NOT RE-READ', 'Submitted evidence', `${record.evidence.items.length} links; signed hash ${record.evidence.textHash} covers the evidence text Stated read, not a fresh read of the linked pages`);
    for (const item of record.evidence.items) {
      const posted = item.postedUrl !== item.url ? `; posted URL ${JSON.stringify(item.postedUrl)}` : '';
      add('NOT RE-READ', 'Evidence link', `Side ${item.side}; final URL ${JSON.stringify(item.url)}${posted}; hash of the text Stated read ${item.textHash}`);
    }
  }

  if (offline) {
    for (const field of ['claim', 'deadline', 'terms hash', 'outcome']) {
      add('NOT CHECKED', `Public ${field}`, `Cannot read the public Bet page ${OFFLINE_REASON}`);
    }
    return finish(checks);
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

/** Read exact saved response bytes; the shared verifier must never use transport. */
export async function verifyOfflineEnclaveRuling(file, { fetchImpl = offlineFetch, jwks } = {}) {
  let firstLine;
  try {
    const bytes = await readFile(file);
    firstLine = `Record read from file ${JSON.stringify(file)}; sha256:${sha256(bytes)}`;
    if (bytes.length > 32_000_000) throw new Error('Saved ruling exceeds size limit');
    const document = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    const betId = document?.record?.material?.bets?.[0]?.id;
    if (typeof betId !== 'string') throw new Error('Saved ruling must identify a Bet in record.material.bets');
    const result = await verifyHostedEnclaveRuling(DEFAULT_BASE, betId, { document, offline: true, fetchImpl, jwks });
    return { ...result, firstLine };
  } catch (error) {
    return { ...finish([{ status: 'FAIL', check: 'Offline file', detail: `Cannot verify ${JSON.stringify(file)}: ${error.message}` }]), firstLine };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  let result;
  try {
    const args = parseVerifierArguments(process.argv.slice(2));
    result = args.offlineFile !== undefined
      ? await verifyOfflineEnclaveRuling(args.offlineFile)
      : await verifyHostedEnclaveRuling(args.base, args.betId, { dstackVerifierUrl: args.dstackVerifierUrl });
  } catch (error) {
    result = finish([{ status: 'FAIL', check: 'Arguments', detail: error.message }]);
  }
  if (result.firstLine) console.log(result.firstLine);
  for (const check of result.checks) console.log(`${check.status} ${check.check}: ${check.detail}`.replace(/[\r\n\u2028\u2029]+/g, ' '));
  console.log(result.summary);
  process.exitCode = result.exitCode;
}
