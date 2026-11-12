import { UserError } from './store.mjs';

// The queue contains request continuations, never response bodies.
export class BoundedSemaphore {
  constructor(limit, maxQueued, timeoutMs) {
    this.limit = limit; this.maxQueued = maxQueued; this.timeoutMs = timeoutMs;
    this.active = 0; this.queue = [];
  }

  async acquire({ signal, timeoutMs = this.timeoutMs } = {}) {
    signal?.throwIfAborted();
    if (this.active < this.limit) { this.active += 1; return this.releaseOnce(); }
    if (this.queue.length >= this.maxQueued) throw new UserError('Too many pages are being read. Try again later.', 503);
    return new Promise((resolve, reject) => {
      const entry = { resolve, cleanup: null };
      const fail = (error) => {
        const index = this.queue.indexOf(entry);
        if (index < 0) return;
        this.queue.splice(index, 1); entry.cleanup(); reject(error);
      };
      const abort = () => fail(signal.reason);
      const timer = setTimeout(() => fail(new UserError('The page waited too long to read. Try again.', 503)), timeoutMs);
      entry.cleanup = () => { clearTimeout(timer); signal?.removeEventListener('abort', abort); };
      signal?.addEventListener('abort', abort, { once: true });
      this.queue.push(entry);
    });
  }

  releaseOnce() {
    let released = false;
    return () => {
      if (released) return;
      released = true;
      const next = this.queue.shift();
      if (next) { next.cleanup(); next.resolve(this.releaseOnce()); }
      else this.active -= 1;
    };
  }
}

export const PAGE_FETCH_LIMIT = 4;
export const PAGE_FETCH_QUEUE = 16;
export const pageFetchSlots = new BoundedSemaphore(PAGE_FETCH_LIMIT, PAGE_FETCH_QUEUE, 3000);
