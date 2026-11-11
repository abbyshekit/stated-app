// INTEGRATION: Editable, explicitly proposed terms; capture itself never waits for a Bet.
import { effectiveTerms } from './terms.mjs';
import { isPlaceholder } from './xtext.mjs';

export function betDraft(source, { side = 'yes', now = new Date() } = {}) {
  const start = now.getTime();
  const readDate = source ? effectiveTerms(source).deadlineAt : null;
  const sourceTime = readDate ? new Date(readDate).getTime() : null;
  const supported = sourceTime && sourceTime > start + 120000 && sourceTime <= start + 366 * 86400000;
  const resolution = supported ? sourceTime : sourceTime ? null : start + 7 * 86400000;
  const accept = resolution ? Math.min(start + 86400000, resolution - 60000) : null;
  const permitted = source?.available && !isPlaceholder(source);
  const claim = permitted && source.span?.length <= 1000 ? source.span : source?.condition_text || '';
  return {
    claim,
    criteria: source?.condition_text || (claim ? `Yes if the evidence source confirms this by the result date: ${claim}` : ''),
    evidenceSourceUrl: source?.source_url || '',
    creatorSide: side === 'no' ? 'no' : 'yes',
    stakeNear: '0.1',
    acceptBy: accept ? new Date(accept).toISOString() : '',
    resolveAt: resolution ? new Date(resolution).toISOString() : '',
    dateOrigin: supported ? 'Dates read from the post. Check them before you sign'
      : sourceTime ? 'The post is dated more than a year out, so the dates are yours to set'
      : 'Proposed Bet window; does not change the source Prediction',
    wordingOrigin: permitted ? 'Taken from the post. Edit it if your bet is different' : 'The post is private, so its words are not copied here',
  };
}
