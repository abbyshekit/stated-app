// INTEGRATION: read-only verifier; requires Node 22 and no account or API key.
import { pathToFileURL } from 'node:url';
import { verifyAttestedRecord } from '../server/src/attested-signature.mjs';

export async function verifyHostedCheck(base, betId, { fetchImpl = fetch } = {}) {
  let bytes;
  try {
    if (!/^[a-f0-9]{8}-(?:[a-f0-9]{4}-){3}[a-f0-9]{12}$/i.test(betId || '')) throw new Error('Use a valid Bet ID.');
    const url = new URL(`/bets/${betId}/attested-check.json`, base);
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password) throw new Error('Use an HTTP(S) origin.');
    const response = await fetchImpl(url, { signal: AbortSignal.timeout(30_000), redirect: 'error' });
    if (!response.ok) throw new Error(`Endpoint returned ${response.status}.`);
    const chunks = [];
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.length;
      if (size > 5_000_000) return { exitCode: 1, report: { pass: false, mismatch: true, error: 'Record exceeds size limit.' } };
      chunks.push(chunk);
    }
    bytes = Buffer.concat(chunks);
  } catch (error) {
    return { exitCode: 2, report: { pass: false, unavailable: true, error: error.message } };
  }
  try {
    const record = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
    return { exitCode: 0, report: { pass: true, completionId: record.completionId, ...verifyAttestedRecord(record) } };
  } catch (error) {
    return { exitCode: 1, report: { pass: false, mismatch: true, error: error.message } };
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const result = await verifyHostedCheck(process.argv[2], process.argv[3]);
  console.log(JSON.stringify(result.report, null, 2));
  process.exitCode = result.exitCode;
}
