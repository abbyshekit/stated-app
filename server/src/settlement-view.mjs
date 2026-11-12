// DESIGN.md: compact, record-derived jury facts shared by Bet and ruling pages.
import { html } from './html.mjs';
import { modelFace } from './jury-models.mjs';

export const juryLogos = (models = []) => html`<div class="jury-logos" aria-label="The NEAR AI enclave jury">${models.map(modelFace)}</div>`;

export function jurySentence(bet) {
  const ruling = bet.enclave;
  if (!ruling || ruling.mode !== 'ruling' || !ruling.verdicts?.length) return '';
  const count = ruling.verdicts.length;
  const all = ruling.verdicts.every(verdict => verdict.outcome === ruling.outcome
    && verdict.confidence >= ruling.minConfidence);
  if (!all || !['yes', 'no'].includes(ruling.outcome)) return '';
  return `${count === 3 ? 'All three' : `All ${count}`} models said ${ruling.outcome}.`;
}

export async function settlementSentence(db, config, bet) {
  let sentence = jurySentence(bet);
  if (!sentence) return '';
  if (bet.status !== 'settled' || bet.settled_by !== 'referee') return sentence;
  if (bet.outcome !== bet.enclave.outcome) return `${sentence} A reviewer corrected the enclave’s ruling.`;
  const court = config.court?.dao;
  const seconds = config.play?.settleDelaySeconds;
  if (court && bet.referee_wallet === court && bet.settlement_transaction_hash) {
    const filed = await db.one(`select detail from bilateral_bet_events where bet_id=$1 and kind='court_proposal'
      order by id desc limit 1`, [bet.id]);
    const elapsed = new Date(bet.settled_at) - new Date(filed?.detail.filedAt);
    if (filed?.detail.dao === court && filed.detail.outcome === bet.outcome && Number.isFinite(elapsed)
      && Number.isFinite(seconds) && seconds > 0 && elapsed >= seconds * 1000) {
      const wait = seconds === 600 ? 'ten minutes' : seconds % 60 === 0 ? `${seconds / 60} minutes` : `${seconds} seconds`;
      sentence += ` Stated Court let it stand for ${wait}, then ${bet.payout_completed ? 'it paid' : 'settled it'}.`;
      return sentence;
    }
  }
  if (bet.payout_completed) sentence += ' The winner was paid.';
  return sentence;
}
