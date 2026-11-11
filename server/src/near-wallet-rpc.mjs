// INTEGRATION: The pinned wallet SDK needs a recent block before opening its
// signing popup. Serve only that public read through the application's origin;
// no arbitrary RPC method, account lookup or transaction submission is proxied.
import { baseDecode } from 'near-api-js';
import { rpc } from './near-escrow.mjs';
import { networkName } from './near-network.mjs';
import { UserError } from './store.mjs';

export function registerWalletRpc({ route, config, needUser, json, fetchImpl }) {
  let cached, checkedAt = 0, inflight;
  async function block() {
    if (cached && Date.now() - checkedAt < 1000) return cached;
    inflight ||= (async () => {
      const result = await rpc('block', { finality: 'final' }, { fetchImpl });
      const header = result?.header;
      if (!header || typeof header.hash !== 'string' || header.hash.length > 44
        || baseDecode(header.hash).length !== 32 || !Number.isSafeInteger(header.height) || header.height <= 0) {
        throw new Error('Invalid block');
      }
      cached = { header: { hash: header.hash, height: header.height } };
      checkedAt = Date.now();
      return cached;
    })().finally(() => { inflight = null; });
    return inflight;
  }
  route('POST', /^\/near\/block$/, async (ctx) => {
    if (!(await needUser(ctx))) return;
    const origin = ctx.req.headers.origin;
    if (origin && origin !== new URL(config.baseUrl).origin) throw new UserError('Open the wallet request from Stated.', 403);
    if (!/^application\/json(?:;|$)/i.test(ctx.req.headers['content-type'] || '')) throw new UserError('Use a JSON block request.', 415);
    const chunks = [];
    let length = 0;
    for await (const chunk of ctx.req) {
      length += chunk.length;
      if (length > 2048) throw new UserError('The block request is too large.', 413);
      chunks.push(chunk);
    }
    let input;
    try { input = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
    catch { throw new UserError('Use a valid block request.'); }
    if (!input || input.method !== 'block' || input.jsonrpc !== '2.0'
      || !input.params || !['final', 'optimistic'].includes(input.params.finality)
      || Object.keys(input.params).length !== 1
      || !((typeof input.id === 'string' && input.id.length <= 64) || Number.isSafeInteger(input.id))) {
      throw new UserError('Only a recent block lookup is supported.');
    }
    let result;
    try { result = await block(); }
    catch { throw new UserError(`${networkName()} is unavailable. Retry the wallet request.`, 503); }
    json(ctx.res, 200, { jsonrpc: '2.0', id: input.id, result }, 'private');
  });
}
