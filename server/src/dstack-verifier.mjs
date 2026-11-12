// INTEGRATION: Submit CVM evidence to dstack and validate persisted verifier results.
const MAX_BYTES = 1_000_000;
const RESULT_KEYS = ['verifier', 'checkedAt', 'isValid', 'quoteVerified', 'eventLogVerified', 'osImageHashVerified', 'acpiTablesVerified', 'osImageIsDev', 'osImageVersion', 'teeVariant', 'tcbStatus', 'advisoryIds', 'osImageHash', 'composeHash', 'reason'];
const ERROR_KEYS = ['verifier', 'checkedAt', 'error'];

function object(value, name) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error(`${name} must be an object`);
  return value;
}
function exactKeys(value, keys) {
  const actual = Object.keys(value);
  return actual.length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function nullableString(value) { return value === null || typeof value === 'string'; }
function hash(value) { return value === null || (typeof value === 'string' && /^[0-9a-f]{64}$/i.test(value)); }
function strings(value) { return Array.isArray(value) && value.every(item => typeof item === 'string'); }
function timestamp(value) {
  return typeof value === 'string' && !Number.isNaN(Date.parse(value)) && new Date(value).toISOString() === value;
}
function unavailable(message, cause) {
  const error = new Error(cause ? `${message}: ${cause.message}` : message, { cause });
  error.unavailable = true;
  return error;
}

export function validateDstackVerifierUrl(value) {
  if (typeof value !== 'string' || !value || value.trim() !== value) throw new Error('Invalid dstack verifier URL');
  let parsed;
  try { parsed = new URL(value); } catch { throw new Error('Invalid dstack verifier URL'); }
  if (parsed.username || parsed.password || parsed.search || parsed.hash || !['https:', 'http:'].includes(parsed.protocol)
      || (parsed.protocol === 'http:' && !['localhost', '127.0.0.1'].includes(parsed.hostname))) {
    throw new Error('Invalid dstack verifier URL');
  }
  return parsed.href.replace(/\/+$/, '');
}

function validateResult(value) {
  if (!exactKeys(value, RESULT_KEYS) || !timestamp(value.checkedAt)) return false;
  try { if (validateDstackVerifierUrl(value.verifier) !== value.verifier) return false; } catch { return false; }
  if (typeof value.isValid !== 'boolean') return false;
  for (const key of ['quoteVerified', 'eventLogVerified', 'osImageHashVerified', 'acpiTablesVerified']) {
    if (typeof value[key] !== 'boolean') return false;
  }
  return (typeof value.osImageIsDev === 'boolean' || value.osImageIsDev === null)
    && ['osImageVersion', 'teeVariant', 'tcbStatus', 'reason'].every(key => nullableString(value[key]))
    && strings(value.advisoryIds) && hash(value.osImageHash) && hash(value.composeHash);
}

export function validateDstackRecord(value) {
  object(value, 'dstack record');
  if (!exactKeys(value, ['gateway', 'model'])) throw new Error('Invalid dstack record');
  for (const item of Object.values(value)) {
    object(item, 'dstack record entry');
    if (exactKeys(item, ERROR_KEYS)) {
      if (!timestamp(item.checkedAt) || typeof item.error !== 'string' || !item.error.trim()) throw new Error('Invalid dstack error entry');
      if (validateDstackVerifierUrl(item.verifier) !== item.verifier) throw new Error('Invalid dstack error verifier');
    } else if (!validateResult(item)) throw new Error('Invalid dstack result entry');
  }
  return value;
}

// The enclave booted the published production image and its quote and event log verify.
// Intel's TCB status is recorded but not required here: a TCB recovery would otherwise stop every ruling.
export function dstackBootPasses(result) {
  return result?.isValid === true && result.quoteVerified === true && result.eventLogVerified === true
    && result.osImageHashVerified === true && result.acpiTablesVerified === true && result.osImageIsDev === false;
}

export function dstackPasses(result) {
  return result?.isValid === true && result.quoteVerified === true && result.eventLogVerified === true
    && result.osImageHashVerified === true && result.acpiTablesVerified === true
    && result.osImageIsDev === false && result.tcbStatus === 'UpToDate';
}

async function readResponse(response, signal) {
  const length = response.headers.get('content-length');
  if (length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BYTES)) throw new Error('Invalid or oversized dstack response');
  if (!/^application\/(?:[\w.+-]+\+)?json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') || '')) throw new Error('dstack response must be JSON');
  if (!response.body) throw new Error('dstack response has no body');
  const chunks = [];
  let size = 0;
  try {
    for await (const chunk of response.body) {
      signal.throwIfAborted();
      size += chunk.length;
      if (size > MAX_BYTES) throw new RangeError('dstack response exceeds 1 MB');
      chunks.push(chunk);
    }
    signal.throwIfAborted();
  } catch (error) {
    if (error instanceof RangeError && error.message === 'dstack response exceeds 1 MB') throw error;
    throw unavailable('dstack response transport failed', error);
  }
  try { return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks))); }
  catch { throw new Error('Malformed dstack JSON response'); }
}

export async function verifyWithDstack(report, { url, fetchImpl = fetch, signal } = {}) {
  const verifier = validateDstackVerifierUrl(url);
  object(report, 'report');
  object(report.info, 'report.info');
  if (typeof report.intel_quote !== 'string' || !report.intel_quote || typeof report.info.vm_config !== 'string'
      || !(typeof report.event_log === 'string' || Array.isArray(report.event_log))) throw new Error('Invalid dstack report');
  const body = JSON.stringify({ quote: report.intel_quote, event_log: typeof report.event_log === 'string' ? report.event_log : JSON.stringify(report.event_log), vm_config: report.info.vm_config });
  const timeout = AbortSignal.timeout(90_000);
  const requestSignal = signal ? AbortSignal.any([signal, timeout]) : timeout;
  requestSignal.throwIfAborted();
  let response;
  try {
    response = await fetchImpl(`${verifier}/verify`, { method: 'POST', headers: { accept: 'application/json', 'content-type': 'application/json' }, body, redirect: 'manual', signal: requestSignal });
  } catch (error) { throw unavailable('dstack request failed', error); }
  if (response.redirected || (response.status >= 300 && response.status < 400)) throw new Error('dstack redirect rejected');
  const hasJson = /^application\/(?:[\w.+-]+\+)?json(?:\s*;|\s*$)/i.test(response.headers.get('content-type') || '');
  if (!response.ok && !hasJson) {
    await response.body?.cancel();
    if (response.status >= 500 && response.status < 600) throw unavailable(`dstack request failed: HTTP ${response.status}`);
    throw new Error(`dstack request failed: HTTP ${response.status}`);
  }
  // dstack also returns well-formed negative verdicts with HTTP 500. They are
  // answered rejections, never optional transport failures.
  const reply = object(await readResponse(response, requestSignal), 'dstack reply');
  const details = object(reply.details, 'dstack reply details');
  const info = details.app_info === null ? null : object(details.app_info, 'dstack reply app_info');
  const result = {
    verifier, checkedAt: new Date().toISOString(), isValid: reply.is_valid,
    quoteVerified: details.quote_verified, eventLogVerified: details.event_log_verified,
    osImageHashVerified: details.os_image_hash_verified, acpiTablesVerified: details.acpi_tables_verified,
    osImageIsDev: details.os_image_is_dev, osImageVersion: details.os_image_version,
    teeVariant: details.tee_variant, tcbStatus: details.tcb_status, advisoryIds: details.advisory_ids,
    osImageHash: info === null ? null : info.os_image_hash, composeHash: info === null ? null : info.compose_hash,
    reason: reply.reason,
  };
  if (!validateResult(result)) throw new Error('Malformed dstack verifier reply');
  if (!response.ok && result.isValid) throw new Error(`dstack success verdict has failure HTTP status ${response.status}`);
  return result;
}
