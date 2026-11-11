// Every public read goes through these predicates. A save is public only
// when its owner finished setup, made the profile public, and made that
// save public. Pending saves (no account yet) are never public. Annotations
// and watch dates are owner-only on every surface.

import { effectiveTerms, isBackfill, outcomeFor, publishedInTime, scoringProbability } from './terms.mjs';
import { isPlaceholder } from './xtext.mjs';

export const PUBLIC_SAVE_SQL = `
  s.visibility = 'public'
  and u.profile_visibility = 'public'
  and u.setup_completed_at is not null
`;

export function isOwner(viewer, user) {
  return Boolean(viewer && user && viewer.id === user.id);
}

export function profileIsPublic(user) {
  return Boolean(user && user.profile_visibility === 'public' && user.setup_completed_at);
}

export function canViewProfile(viewer, user) {
  return isOwner(viewer, user) || profileIsPublic(user);
}

export function saveIsPublic(save, owner) {
  return profileIsPublic(owner) && save.visibility === 'public';
}

export function canViewSave(viewer, save, owner) {
  return isOwner(viewer, owner) || saveIsPublic(save, owner);
}

export function publicSaveView(row) {
  const terms = effectiveTerms(row);
  return {
    id: row.save_id,
    collection: row.relation === 'mine' ? 'my_predictions' : 'following',
    capture: isBackfill(row) ? 'backfill' : 'prospective',
    claim: row.available && !isPlaceholder(row) ? row.span : null,
    speaker: row.speaker,
    reportedSpeech: row.reported_speech,
    sourceUrl: row.available ? row.source_url : null,
    sourceAvailable: row.available,
    sourceTitle: row.title || null,
    platform: row.platform,
    publishedAt: row.published_at,
    deadlineText: row.deadline_text,
    deadlineAt: terms.deadlineAt,
    deadlineBasis: terms.deadlineBasis,
    probability: terms.probability,
    probabilityBasis: terms.probabilityBasis,
    scoredProbability: scoringProbability(row),
    condition: terms.condition,
    hedges: row.hedges,
    status: row.status,
    outcome: outcomeFor(row),
    deadlineMovedTo: terms.movedTo,
    resolutionNote: row.resolution_note,
    resolutionUrl: row.resolution_url,
    savedAt: row.saved_at,
    scored: row.relation === 'mine' && !isBackfill(row) && (row.status === 'yes' || row.status === 'no') && publishedInTime(row),
  };
}

// The owner sees everything Stated holds. For a private X save that is the
// link and the reading, not the words: the words are shown from X on the
// owner's pages and are not stored.
export function ownerSaveView(row) {
  const placeholder = isPlaceholder(row);
  return {
    ...publicSaveView(row),
    claim: placeholder ? null : row.span,
    textStored: !placeholder,
    scored: row.relation === 'mine' && !isBackfill(row) && (row.status === 'yes' || row.status === 'no'),
    sourceUrl: row.source_url,
    visibility: row.visibility,
    annotation: row.annotation,
    watchAt: row.watch_at,
    intake: row.intake,
  };
}
