// INTEGRATION: Every image read rechecks public authorization before rendering.
import { publicBet, publicBetsForSave } from './bet-public.mjs';
import { renderShareImage } from './share-image.mjs';
import { publicSave, publicPredictionOwner } from './store.mjs';
import { effectiveTerms, outcomeFor } from './terms.mjs';
import { isPlaceholder } from './xtext.mjs';

const betName = (username, wallet) => (username ? `@${username}` : wallet);

export function registerShareRoutes({ route, db, config, notFound, headersFor }) {
  const cache = new Map();
  function image(res, input) {
    // The cache contains authorized public projections only. Authorization and
    // current content are read before every lookup, including withdrawal.
    // The card text counts days, so the UTC date is part of the key.
    const betNow = (bet) => bet?.status === 'offered' && new Date(bet.acceptBy).getTime() <= Date.now();
    const key = JSON.stringify({ ...input, day: new Date().toISOString().slice(0, 10),
      acceptanceExpired: input.kind === 'bet' ? betNow(input) : betNow(input.bet) });
    let png = cache.get(key);
    if (!png) {
      png = renderShareImage(input);
      if (cache.size >= 32) cache.delete(cache.keys().next().value);
      cache.set(key, png);
    }
    res.writeHead(200, { ...headersFor('public'), 'cache-control': 'no-store',
      'content-type': 'image/png', 'content-length': png.length });
    res.end(png);
  }

  route('GET', /^\/share\/bets\/([a-fA-F0-9-]{36})\.png$/, async (ctx) => {
    const bet = await publicBet(db, ctx.params[0]);
    if (!bet) return notFound(ctx);
    // The post's author, when the Bet was made on a post whose public page names them.
    let author = {};
    const linked = bet.referee_wallet ? await db.one('select source_save_id from bilateral_bets where id=$1', [bet.id]) : null;
    if (linked?.source_save_id) {
      const owner = await publicPredictionOwner(db, linked.source_save_id);
      const row = owner ? await publicSave(db, owner, linked.source_save_id) : null;
      if (row?.available && row.platform === 'x' && row.author_username && !row.reported_speech) {
        author = { authorName: row.author_name || `@${row.author_username}`, handle: `@${row.author_username}` };
      }
    }
    image(ctx.res, { ...author, kind: 'bet', id: bet.id, claim: bet.claim,
      status: bet.status, outcome: bet.outcome, settledBy: bet.settled_by, acceptBy: bet.accept_by, funded: bet.funded,
      settlementVerified: Boolean(bet.settlement_transaction_hash),
      date: bet.resolve_at, creatorSide: bet.creator_side,
      creatorName: betName(bet.creator_username, bet.creator_wallet),
      acceptorName: betName(bet.acceptor_username, bet.acceptor_wallet),
      stakeYocto: bet.stake_yocto, publicUrl: `${config.baseUrl}/bets/${bet.id}` });
  });

  route('GET', /^\/share\/predictions\/(\d{1,18})\.png$/, async (ctx) => {
    const owner = await publicPredictionOwner(db, ctx.params[0]);
    const row = owner ? await publicSave(db, owner, ctx.params[0]) : null;
    if (!row) return notFound(ctx);
    const path = owner.kind === 'editorial' ? `/desk/${row.save_id}` : `/u/${owner.x_username}/${row.save_id}`;
    const direct = row.available && row.platform === 'x' && row.author_username && !row.reported_speech;
    const [first] = await publicBetsForSave(db, row.save_id);
    image(ctx.res, { kind: 'prediction', id: String(row.save_id), speaker: row.speaker,
      authorName: direct ? row.author_name || undefined : undefined,
      handle: direct ? `@${row.author_username}` : undefined,
      deadline: ['open', 'pending'].includes(row.status) ? effectiveTerms(row).deadlineAt || undefined : undefined,
      bet: first ? { creatorName: betName(first.creator_username, first.creator_wallet),
        acceptorName: betName(first.acceptor_username, first.acceptor_wallet), creatorSide: first.creator_side,
        stakeYocto: first.stake_yocto, status: first.status, outcome: first.outcome, funded: first.funded,
        acceptBy: first.accept_by } : undefined,
      claim: !row.available ? 'The source is no longer available; its words are withheld.'
        : isPlaceholder(row) ? `A prediction by ${row.speaker}. View the public source.` : row.span,
      status: ['yes', 'no'].includes(row.status) ? outcomeFor(row) : row.status,
      evidenceUrl: row.resolution_url,
      date: row.outcome_at || row.resolved_at, publicUrl: `${config.baseUrl}${path}` });
  });
}
