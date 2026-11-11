// INTEGRATION: Pure certificate presentation and privacy-filtered avatars; DESIGN.md supplies selected visual rules.
// Presentation helpers for the certificate look. Pure functions plus one
// read-only query; nothing here changes what a page is allowed to show.
import { html } from './html.mjs';

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

// "1 Mar 27", in UTC like every other date on the site.
export function shortDay(value) {
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return '';
  return `${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${String(d.getUTCFullYear()).slice(2)}`;
}

// The save's own ID, padded: a filing number, not a new identifier.
export function serial(id) {
  return `№ ${String(id).padStart(4, '0')}`;
}

// The content policy admits images from pbs.twimg.com and data: only, so any
// other address falls back to the monogram instead of a broken image.
function allowedAvatar(url) {
  return typeof url === 'string' && (url.startsWith('https://pbs.twimg.com/') || url.startsWith('data:image/'));
}

export function face({ url = null, name = '', size = '' } = {}) {
  const cls = `face${size ? ` ${size}` : ''}`;
  if (allowedAvatar(url)) return html`<img class="${cls}" src="${url}" alt="" width="44" height="44">`;
  const letter = (String(name).replace(/^@/, '').match(/[\p{L}\p{N}]/u) || ['?'])[0];
  return html`<span class="${cls}" aria-hidden="true">${letter}</span>`;
}

// Stated holds a profile photo only for people who signed in. A photo is
// shown for the viewer themself and for accounts whose profile is public and
// set up; everyone else gets the monogram. No badge is ever inferred.
export async function facesFor(db, rows, viewer = null) {
  const faces = new Map();
  if (viewer?.x_user_id && allowedAvatar(viewer.x_avatar_url)) faces.set(String(viewer.x_user_id), viewer.x_avatar_url);
  const ids = [...new Set(rows.map((row) => row.speaker_x_user_id).filter(Boolean).map(String))];
  if (!ids.length) return faces;
  const found = await db.many(
    `select x_user_id, x_avatar_url from users
      where x_user_id = any($1) and x_avatar_url is not null
        and profile_visibility = 'public' and setup_completed_at is not null`,
    [ids],
  );
  for (const user of found) if (allowedAvatar(user.x_avatar_url)) faces.set(String(user.x_user_id), user.x_avatar_url);
  return faces;
}

// The same rule for people named on a Bet: a photo only for accounts whose
// profile is public and set up. Keys are lower-cased usernames.
export async function facesByUsername(db, usernames, viewer = null) {
  const faces = new Map();
  if (viewer?.x_username && allowedAvatar(viewer.x_avatar_url)) faces.set(String(viewer.x_username).toLowerCase(), viewer.x_avatar_url);
  const names = [...new Set(usernames.filter(Boolean).map((name) => String(name).toLowerCase()))];
  if (!names.length) return faces;
  const found = await db.many(
    `select x_username, x_avatar_url from users
      where lower(x_username) = any($1) and x_avatar_url is not null
        and profile_visibility = 'public' and setup_completed_at is not null`,
    [names],
  );
  for (const user of found) if (allowedAvatar(user.x_avatar_url)) faces.set(String(user.x_username).toLowerCase(), user.x_avatar_url);
  return faces;
}
