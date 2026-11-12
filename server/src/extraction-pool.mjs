import { Worker } from 'node:worker_threads';
import { BoundedSemaphore } from './page-limits.mjs';
import { UserError } from './store.mjs';

const slots = Array.from({ length: 2 }, () => ({ worker: null, busy: false }));
const capacity = new BoundedSemaphore(slots.length, 8, 3000);
const timeoutError = () => new UserError('The page took too long to read.');

// The wall deadline includes queueing, worker startup, parsing and result transfer.
export async function extractInWorker(operation, html, finalUrl, options = {}, { timeoutMs = 3000, signal } = {}) {
  if (!['article', 'evidence'].includes(operation)) throw new TypeError('Unknown extraction operation.');
  const controller = new AbortController();
  const forwardAbort = () => controller.abort(signal.reason);
  signal?.throwIfAborted();
  signal?.addEventListener('abort', forwardAbort, { once: true });
  const timer = setTimeout(() => controller.abort(timeoutError()), timeoutMs);
  let release;
  try {
    release = await capacity.acquire({ signal: controller.signal });
    controller.signal.throwIfAborted();
    const slot = slots.find((entry) => !entry.busy);
    slot.busy = true;
    try {
      if (!slot.worker) {
        slot.worker = new Worker(new URL('./extract-worker.mjs', import.meta.url), {
          // No parent flags: a test runner's or loader's flags can be invalid in a worker.
          execArgv: [],
          resourceLimits: { maxOldGenerationSizeMb: 96, stackSizeMb: 4 },
        });
      }
      const worker = slot.worker;
      worker.ref();
      return await new Promise((resolve, reject) => {
        let settled = false;
        const finish = async (error, result, terminate = false) => {
          if (settled) return;
          settled = true;
          controller.signal.removeEventListener('abort', abort);
          worker.removeListener('message', message);
          worker.removeListener('error', failed);
          worker.removeListener('exit', exited);
          if (terminate) {
            slot.worker = null;
            // A terminated worker must exit before its slot can be reused.
            await worker.terminate().catch(() => {});
          } else worker.unref();
          if (error) reject(error); else resolve(result);
        };
        const abort = () => finish(controller.signal.reason, null, true);
        const failed = () => finish(new UserError('Unable to read that page.'), null, true);
        const exited = () => failed();
        const message = (reply) => reply.error
          ? finish(new UserError(reply.error), null)
          : finish(null, reply.result);
        controller.signal.addEventListener('abort', abort, { once: true });
        worker.once('message', message);
        worker.once('error', failed);
        worker.once('exit', exited);
        try { worker.postMessage({ operation, html: String(html || ''), finalUrl, options }); }
        catch { failed(); }
      });
    } finally { slot.busy = false; }
  } finally {
    release?.(); clearTimeout(timer); signal?.removeEventListener('abort', forwardAbort);
  }
}
