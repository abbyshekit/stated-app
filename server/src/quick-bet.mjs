import Decimal from 'decimal.js';
import { deadlineOf } from './interpret.mjs';
import { UserError } from './store.mjs';

const DAY = 86400000;
const MINUTE = 60000;
const ACCEPT_BUFFER = 10 * MINUTE;
const STAKE = /^(?:0|[1-9][0-9]*)(?:\.[0-9]{1,24})?$/;

function validZone(zone) {
  try { new Intl.DateTimeFormat('en', { timeZone: zone }).format(); return true; }
  catch { return false; }
}

function localParts(date, zone) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23',
  }).formatToParts(date);
  return Object.fromEntries(parts.filter((p) => p.type !== 'literal').map(({ type, value }) => [type, Number(value)]));
}

function localMidnight(parts, zone) {
  const target = Date.UTC(parts.year, parts.month - 1, parts.day);
  let instant = target;
  for (let i = 0; i < 3; i += 1) {
    const p = localParts(new Date(instant), zone);
    instant += target - Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second);
  }
  return new Date(instant);
}

function resolveDeadline(claim, now, timeZone) {
  const timeWord = claim.match(/\bby midnight(?:\s+(?:\((EST|EDT|ET|UTC)\)|(EST|EDT|ET|UTC)))?$/i);
  if (timeWord) {
    const explicit = (timeWord[1] || timeWord[2] || '').toUpperCase();
    timeZone = { EST: 'Etc/GMT+5', EDT: 'Etc/GMT+4', ET: 'America/New_York', UTC: 'UTC' }[explicit] || timeZone;
    const p = localParts(now, timeZone);
    const next = new Date(Date.UTC(p.year, p.month - 1, p.day + 1));
    return localMidnight({ year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() }, timeZone);
  }
  const read = deadlineOf(claim, now);
  if (!read.text || !read.at || !Number.isFinite(read.at.getTime())) return null;
  return read.at;
}

/** Parse an explicit proposal such as "Claim by 30 Nov 2026, 0.25 NEAR on yes". */
export function parseQuickBet(text, { now = new Date(), timeZone = 'UTC' } = {}) {
  const raw = String(text ?? '').trim();
  const match = raw.match(/^([\s\S]*?)\s*,\s*([0-9]+(?:\.[0-9]+)?)\s+NEAR\s+on\s+(yes|no)\.?(?:\s+(https:\/\/\S+))?\s*$/i);
  if (!match) return null;
  const [, claimPart, amount, side, contextUrl] = match;
  if (!validZone(timeZone)) throw new UserError('Choose a valid IANA time zone.');
  const claim = claimPart.trim();
  if (!claim || claim.length > 1000) throw new UserError('Keep the claim between 1 and 1000 characters.');
  if (!STAKE.test(amount) || !new Decimal(amount).gte('0.1') || !new Decimal(amount).lte('1')) {
    throw new UserError('Enter a stake from 0.1 to 1 NEAR with at most 24 decimal places.');
  }
  const instant = now instanceof Date ? now : new Date(now);
  if (!Number.isFinite(instant.getTime())) throw new UserError('Choose a valid creation time.');
  const resolution = resolveDeadline(claim, instant, timeZone);
  if (!resolution) throw new UserError('Add a recognizable deadline to the claim.');
  const resolveMs = resolution.getTime();
  const nowMs = instant.getTime();
  if (resolveMs <= nowMs + ACCEPT_BUFFER) throw new UserError('The deadline is too close to accept this bet.');
  const acceptMs = Math.min(resolveMs - ACCEPT_BUFFER, nowMs + DAY);
  if (resolveMs > nowMs + 365 * DAY) throw new UserError('Choose a deadline within a year.');
  return {
    claim,
    criteria: 'Yes if reliable public evidence confirms the claim by the specified deadline. No if the evidence establishes that it did not happen by then. If the evidence cannot establish either outcome, return both stakes.',
    creatorSide: side.toLowerCase(),
    stakeNear: new Decimal(amount).toFixed(),
    acceptBy: new Date(acceptMs).toISOString(),
    resolveAt: resolution.toISOString(),
    ...(contextUrl ? { evidenceSourceUrl: contextUrl } : {}),
  };
}
