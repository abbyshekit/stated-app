import { NEARAI_BASE } from './enclave.mjs';
import { primaryRpc } from '../../src/near-escrow.mjs';

// Inject only the three local/synthetic transports needed by the OutLayer stack.
export function outlayerTestFetch({ ai, near, xBase, localFetch = fetch }) {
  return (url, init) => {
    if (new URL(url).origin === new URL(NEARAI_BASE).origin) return ai.fetchImpl(url, init);
    if (String(url) === primaryRpc()) return near().fetchImpl(url, init);
    if (xBase() && new URL(url).origin === new URL(xBase()).origin) return localFetch(url, init);
    throw new Error(`Unexpected test fetch: ${url}`);
  };
}
