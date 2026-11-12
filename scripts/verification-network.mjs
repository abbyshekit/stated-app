// Read-only screening transports. Deadlines include the complete response body.
import { setTimeout as delay } from 'node:timers/promises';

const wrapped = new WeakSet();
const transientCodes = new Set(['ETIMEDOUT', 'ECONNRESET', 'ECONNREFUSED', 'EAI_AGAIN',
  'UND_ERR_CONNECT_TIMEOUT', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT', 'UND_ERR_SOCKET']);

function callName(init) {
  if (!init.body) return init.method || 'GET';
  try {
    const body = JSON.parse(init.body);
    if (body.jsonrpc === '2.0') return `${body.method} ${body.params?.account_id || body.params?.tx_hash || ''}${body.params?.method_name ? `.${body.params.method_name}` : body.params?.request_type ? ` ${body.params.request_type}` : ''}`.trim();
  } catch { /* Non-RPC request. Never log its body. */ }
  return init.method || 'GET';
}

function transportFailure(error) {
  if (error?.name === 'TimeoutError' || error?.name === 'AbortError') return 'timeout';
  const code = error?.cause?.code || error?.code;
  if (transientCodes.has(code)) return `transport ${code}`;
  if (error instanceof TypeError) return 'transport failure';
  return null;
}

export function verificationFetch(fetchImpl = fetch, {
  attempts = 3, backoffMs = [250, 1000], timeoutMs,
  sleep = delay, diagnostic = line => console.error(line), maxBytes = 32_000_000,
} = {}) {
  if (wrapped.has(fetchImpl)) return fetchImpl;
  if (!Number.isSafeInteger(attempts) || attempts < 1 || attempts > 3
    || (timeoutMs !== undefined && (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1))) throw new Error('Invalid verification request options');
  const request = async (url, init = {}) => {
    const endpoint = new URL(url);
    if (endpoint.username || endpoint.password) throw new Error('Verification endpoint must not contain credentials');
    const budget = timeoutMs ?? (endpoint.pathname.endsWith('/verify') ? 90_000
      : endpoint.hostname === 'nras.attestation.nvidia.com' ? 20_000 : 30_000);
    const call = callName(init);
    for (let attempt = 1; attempt <= attempts; attempt++) {
      const start = performance.now();
      const controller = new AbortController();
      let timer;
      let reader;
      let timedOut = false;
      let retry = false;
      let detail;
      try {
        // Imported helpers have their own shorter, opaque signals. This boundary
        // owns the explicit deadline and buffers the body before returning it.
        const work = async () => {
          const response = await fetchImpl(url, { ...init, signal: controller.signal });
          controller.signal.throwIfAborted();
          reader = response.body?.getReader();
          const chunks = [];
          let size = 0;
          for (;;) {
            const { done, value } = reader ? await reader.read() : { done: true };
            controller.signal.throwIfAborted();
            if (done) break;
            size += value.byteLength;
            if (size > maxBytes) throw new Error(`response exceeds ${maxBytes} bytes`);
            chunks.push(value);
          }
          const bytes = Buffer.concat(chunks);
          let body;
          try { body = JSON.parse(bytes.toString('utf8')); } catch { /* Caller validates JSON. */ }
          // A well-formed negative dstack verdict remains a rejection, even on HTTP 500.
          const negativeVerdict = endpoint.pathname.endsWith('/verify') && body?.is_valid === false && body?.details;
          retry = !negativeVerdict && (response.status === 429 || response.status >= 500 && response.status <= 599);
          const rpcMessage = body?.error ? `${body.error.cause?.name || ''} ${body.error.message || ''}` : '';
          const rpcTimeout = /timeout|timed.out/i.test(rpcMessage);
          const rpcTransient = rpcTimeout || /too.many.requests|unavailable/i.test(rpcMessage);
          retry ||= rpcTransient;
          const jsonRequired = /application\/json/i.test(response.headers.get('content-type') || '');
          detail = `HTTP ${response.status}${body?.error ? rpcTimeout ? '; RPC timeout' : rpcTransient ? '; transient RPC error' : '; RPC error'
            : body === undefined && jsonRequired ? '; malformed JSON response' : ''}`;
          return new Response([204, 205, 304].includes(response.status) ? null : bytes,
            { status: response.status, statusText: response.statusText, headers: response.headers });
        };
        const response = await Promise.race([work(), new Promise((_, reject) => {
          timer = setTimeout(() => {
            timedOut = true;
            controller.abort();
            reject(new DOMException(`deadline ${budget}ms`, 'TimeoutError'));
          }, budget);
        })]);
        diagnostic(`[request] ${endpoint.href} | ${call} | attempt ${attempt}/${attempts} | ${Math.round(performance.now() - start)}ms | deadline ${budget}ms | ${detail}${retry ? attempt < attempts ? ' | retry' : ' | give up' : ''}`);
        if (!retry || attempt === attempts) return response;
      } catch (error) {
        detail = timedOut ? 'timeout' : transportFailure(error);
        retry = Boolean(detail);
        detail ||= error?.message === `response exceeds ${maxBytes} bytes` || error?.message === 'response has no body'
          ? error.message : 'request failed';
        const message = `${endpoint.href} | ${call} | attempt ${attempt}/${attempts} | ${Math.round(performance.now() - start)}ms | deadline ${budget}ms | ${detail}`;
        diagnostic(`[request] ${message}${retry && attempt < attempts ? ' | retry' : ' | give up'}`);
        if (!retry || attempt === attempts) throw Object.assign(new Error(message), { unavailable: retry });
      } finally {
        clearTimeout(timer);
        controller.abort();
        // Cancel without waiting: a broken transport must not defeat the deadline.
        if (reader) void reader.cancel().catch(() => {});
      }
      const wait = backoffMs[attempt - 1] ?? 1000;
      diagnostic(`[request] ${endpoint.href} | ${call} | backoff ${wait}ms`);
      await sleep(wait);
    }
  };
  wrapped.add(request);
  return request;
}
