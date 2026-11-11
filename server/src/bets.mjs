// INTEGRATION: Private immutable bet terms and reads only. near-bets.mjs owns
// verified NEAR testnet escrow synchronization; forecast scores never change.
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { idOf, ownerSave, publicSave, publicPredictionOwner, UserError } from './store.mjs';
import { parseTestNear } from './near-escrow.mjs';
import { isAccount, network, unit } from './near-network.mjs';

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const SELECT_BET = `select b.*, creator.x_username as creator_username,
  taker.x_username as acceptor_username, invited.x_username as invited_username,
  (b.status = 'offered' and b.accept_by <= clock_timestamp()) as expired
  from bilateral_bets b join users creator on creator.id = b.creator_user_id
  left join users taker on taker.id = b.acceptor_user_id
  left join users invited on invited.id = b.invited_user_id`;

function person(user) {
  if (!user) throw new UserError('Sign in to view or make a bet.', 401);
  if (user.kind !== 'person' || !user.setup_completed_at) {
    throw new UserError('Complete account setup before using bets.', 403);
  }
  return BigInt(idOf(user.id)).toString();
}

function uuid(value, label = 'bet reference') {
  if (typeof value !== 'string' || !UUID.test(value)) {
    throw new UserError(`Use a valid ${label}.`);
  }
  return value.toLowerCase();
}

function text(value, label, max, required = true) {
  if (value == null && !required) return '';
  if (typeof value !== 'string') throw new UserError(`Enter ${label}.`);
  const normalized = value.trim();
  if ((required && !normalized) || normalized.length > max) {
    throw new UserError(`Enter ${label}${required ? '' : ' if needed'}, using ${max} characters or fewer.`);
  }
  return normalized;
}

function publicUrl(value, label, required = true) {
  const source = text(value, label, 2048, required);
  if (!source && !required) return null;
  let url;
  try { url = new URL(source); } catch { throw new UserError(`Enter a public HTTPS ${label}.`); }
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  // URLs are references only and are never fetched here. DNS names still need
  // normal SSRF protections if a separate service later fetches these links.
  const literal = host.replace(/^\[|\]$/g, '');
  if (url.protocol !== 'https:' || url.username || url.password || isIP(literal)
      || !host.includes('.') || host === 'localhost'
      || /(?:^|\.)(?:localhost|local|internal|test|invalid)$/.test(host)
      || !/^(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/.test(host)) {
    throw new UserError(`Enter a public HTTPS ${label} without credentials or a local address.`);
  }
  return url.href;
}

function instant(value, label) {
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?Z$/.test(value)) {
    throw new UserError(`Enter ${label} as a UTC ISO timestamp, for example 2027-01-01T12:00:00Z.`);
  }
  const date = new Date(value);
  const normalized = value.replace(/(?:\.(\d{1,3}))?Z$/, (_, fraction) => `.${(fraction || '').padEnd(3, '0')}Z`);
  if (!Number.isFinite(date.getTime()) || date.toISOString() !== normalized) {
    throw new UserError(`Enter a real ${label}.`);
  }
  return date.toISOString();
}

function stake(value) {
  try { return parseTestNear(value); } catch {
    throw new UserError(`Enter a ${unit()} stake greater than zero and at most 1, with up to 24 decimal places.`);
  }
}

function invitedWallet(value) {
  const account = text(value, `the opponent ${network().id} account`, 64, false);
  if (!account) return null;
  if (!isAccount(account)) {
    throw new UserError(`Enter an opponent account ending in .${network().suffix} or a 64-character lowercase hexadecimal account.`);
  }
  return account;
}

function digest(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function creationInput(input) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new UserError('Enter the bet terms.');
  const side = input.creatorSide;
  if (side !== 'yes' && side !== 'no') throw new UserError('Choose Yes or No as your side.');
  let opponent = text(input.opponentUsername, 'an opponent username', 16, false).replace(/^@/, '').toLowerCase();
  if (opponent && !/^[a-z0-9_]{1,15}$/.test(opponent)) throw new UserError('Enter a valid X username for the opponent.');
  opponent ||= null;
  const terms = {
    claim: text(input.claim, 'a claim', 1000),
    criteria: text(input.criteria, 'resolution criteria', 2000),
    evidenceSourceUrl: publicUrl(input.evidenceSourceUrl, 'evidence source URL'),
    creatorSide: side,
    stakeYocto: stake(input.stakeNear),
    invitedWallet: invitedWallet(input.opponentAccount),
    acceptBy: instant(input.acceptBy, 'the acceptance deadline'),
    resolveAt: instant(input.resolveAt, 'the resolution date'),
  };
  // Only present when a referee is named, so Bets without one keep the terms hash they always had.
  const referee = invitedWallet(input.refereeAccount);
  if (referee) {
    if (referee === terms.invitedWallet) throw new UserError('The referee cannot take a side.');
    terms.refereeWallet = referee;
  }
  if (opponent && !terms.invitedWallet) throw new UserError(`Enter the named opponent’s ${network().id} account to bind their invitation.`);
  if (terms.acceptBy >= terms.resolveAt) throw new UserError('Set the resolution date after the acceptance deadline.');
  const sourceSaveId = input.sourceSaveId ? idOf(input.sourceSaveId) : null;
  return { requestId: uuid(input.requestId, 'request ID'), terms, opponent, sourceSaveId };
}

export async function sourceForBet(db, user, saveId) {
  person(user);
  const id = idOf(saveId);
  let source = null;
  try { source = await ownerSave(db, user, id); }
  catch (error) { if (!(error instanceof UserError) || error.status !== 404) throw error; }
  if (!source) {
    const owner = await publicPredictionOwner(db, id);
    if (owner) source = await publicSave(db, owner, id);
  }
  if (!source) throw new UserError('This Prediction is unavailable to your account.', 404);
  if (!source.available || source.status !== 'open') throw new UserError('Choose an available Prediction whose outcome is still open.', 409);
  return source;
}

function participant(bet, actor) {
  return String(bet.creator_user_id) === actor || String(bet.acceptor_user_id) === actor;
}

function visible(bet, actor) {
  if (participant(bet, actor)) return true;
  if (['cancelled', 'expired'].includes(bet.status) && bet.invited_user_id) return String(bet.invited_user_id) === actor;
  return bet.status === 'offered' && (!bet.invited_user_id || String(bet.invited_user_id) === actor);
}

function present(row) {
  return {
    ...row,
    acceptor_unbound: Boolean(row.acceptor_wallet && !row.acceptor_user_id),
    display_status: row.expired ? 'expired' : row.status,
    winner_user_id: row.status === 'settled' && row.outcome !== 'void'
      ? (row.outcome === row.creator_side ? row.creator_user_id : row.acceptor_user_id) : null,
  };
}

async function detail(db, actor, id) {
  const row = await db.one(`${SELECT_BET} where b.id = $1`, [id]);
  if (!row || !visible(row, actor)) throw new UserError('This bet is unavailable to your account.', 404);
  const events = await db.many(
    `select e.*, u.x_username as actor_username from bilateral_bet_events e
     join users u on u.id = e.actor_user_id where e.bet_id = $1 order by e.id`, [id],
  );
  const proposals = await db.many(
    `select p.*, u.x_username as proposer_username from bilateral_bet_proposals p
     join users u on u.id = p.proposer_user_id where p.bet_id = $1 order by p.created_at, p.id`, [id],
  );
  return { ...present(row), events, proposals,
    current_proposal: proposals.find((p) => p.id === row.current_proposal_id && String(p.revision) === String(row.current_proposal_revision)) || null };
}

async function event(tx, betId, actor, kind, value = {}) {
  await tx.query(
    'insert into bilateral_bet_events (bet_id, actor_user_id, kind, detail) values ($1, $2, $3, $4)',
    [betId, actor, kind, value],
  );
}

export async function createBet(db, user, input) {
  const actor = person(user);
  const { requestId, terms, opponent, sourceSaveId } = creationInput(input);
  if (sourceSaveId) await sourceForBet(db, user, sourceSaveId);
  const requestFingerprint = digest({ version: 1, ...terms, opponent, sourceSaveId });
  return db.tx(async (tx) => {
    const owner = await tx.one('select id, kind, setup_completed_at from users where id = $1 for update', [actor]);
    if (!owner || owner.kind !== 'person' || !owner.setup_completed_at) throw new UserError('Complete account setup before making a bet.', 403);
    const existing = await tx.one('select * from bilateral_bets where creator_user_id = $1 and request_id = $2', [actor, requestId]);
    if (existing) {
      const created = await tx.one(
        `select detail from bilateral_bet_events where bet_id = $1 and kind = 'created' order by id limit 1`, [existing.id],
      );
      if (created?.detail?.requestFingerprint !== requestFingerprint) {
        throw new UserError('That request ID already belongs to different terms. Start a new bet.', 409);
      }
      return detail(tx, actor, existing.id);
    }
    const { at } = await tx.one('select clock_timestamp() as at');
    if (new Date(terms.acceptBy) <= new Date(at)) throw new UserError('Set an acceptance deadline in the future.');
    if (new Date(terms.resolveAt).getTime() > new Date(at).getTime() + 366 * 86400000) {
      throw new UserError('Set resolution within 366 days, matching the escrow contract.');
    }
    const count = await tx.one(
      `select count(*)::int as n from bilateral_bets where creator_user_id = $1 and created_at > $2::timestamptz - interval '1 hour'`,
      [actor, at],
    );
    if (count.n >= 20) throw new UserError('You have made 20 offers in the past hour. Try again after an older offer leaves that window.', 429);
    let invitedId = null;
    if (opponent) {
      const invited = await tx.one(
        `select id, kind, setup_completed_at from users where lower(x_username) = $1 order by updated_at desc limit 1`, [opponent],
      );
      if (!invited || invited.kind !== 'person' || !invited.setup_completed_at) {
        throw new UserError('Choose a registered opponent who has completed account setup.');
      }
      invitedId = String(invited.id);
      if (invitedId === actor) throw new UserError('Choose another person as the opponent.');
    }
    const termsSalt = randomBytes(32).toString('hex');
    const termsHash = digest({ version: 2, salt: termsSalt, creatorUserId: actor, invitedUserId: invitedId, ...terms });
    const id = randomUUID();
    await tx.query(
      `insert into bilateral_bets (id, creator_user_id, invited_user_id, request_id, claim, criteria,
       evidence_source_url, creator_side, stake_yocto, accept_by, resolve_at, terms_hash, status, created_at,
       invited_wallet, chain_state, creator_wallet, acceptor_wallet, terms_salt, source_save_id, referee_wallet)
       values ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,'offered',$13,$14,null,null,null,$15,$16,$17)`,
      [id, actor, invitedId, requestId, terms.claim, terms.criteria, terms.evidenceSourceUrl,
        terms.creatorSide, terms.stakeYocto, terms.acceptBy, terms.resolveAt, termsHash, at, terms.invitedWallet, termsSalt, sourceSaveId,
        terms.refereeWallet || null],
    );
    await event(tx, id, actor, 'created', { requestFingerprint, termsHash });
    return detail(tx, actor, id);
  });
}

export async function betFor(db, user, id) {
  const actor = person(user);
  const reference = uuid(id);
  return db.tx(async (tx) => {
    // Keep an invite preview from reading events added by an acceptance that
    // would revoke this viewer's access halfway through the detail read.
    const bet = await tx.one('select * from bilateral_bets where id = $1 for share', [reference]);
    if (!bet || !visible(bet, actor)) throw new UserError('This bet is unavailable to your account.', 404);
    return detail(tx, actor, reference);
  });
}

export async function betsFor(db, user) {
  const actor = person(user);
  const rows = await db.many(
    `${SELECT_BET} where b.creator_user_id = $1 or b.invited_user_id = $1 or b.acceptor_user_id = $1
     order by b.created_at desc, b.id limit 100`, [actor],
  );
  return rows.map(present);
}
