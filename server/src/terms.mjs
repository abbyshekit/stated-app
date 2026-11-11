// The terms a viewer of a save sees. An author's own confirmation is part of
// the author's save, so it shows wherever that save shows and nowhere else.
//
// A prediction is held to the earliest deadline it ever had: the one stated
// in the post (as read, or as corrected in review) or the earliest the author
// confirmed, whichever is sooner. The author may later move the deadline;
// the move is shown, but scoring, resolution and the public-record check
// still use the committed deadline.
export function effectiveTerms(row) {
  const own = row.relation === 'mine' && row.author_confirmed_at;
  const stated = row.deadline_at || row.proposed_deadline_at || null;
  const authorFirst = own ? row.author_committed_deadline_at || null : null;
  let deadlineAt = stated;
  let deadlineBasis = 'none';
  if (authorFirst && (!stated || time(authorFirst) <= time(stated))) {
    deadlineAt = authorFirst;
    deadlineBasis = 'author';
  } else if (row.deadline_at) deadlineBasis = 'reviewer';
  else if (row.proposed_deadline_at) deadlineBasis = 'reading';
  const latest = own ? row.author_deadline_at || null : null;
  const movedTo = latest && deadlineAt && time(latest) > time(deadlineAt) ? latest : null;
  let probability = null;
  let probabilityBasis = 'none';
  if (own && row.author_probability != null) {
    probability = Number(row.author_probability);
    probabilityBasis = row.author_probability_added ? 'author_added' : 'author';
  } else if (row.reviewed_probability != null) {
    probability = Number(row.reviewed_probability);
    probabilityBasis = 'reviewer';
  } else if (row.probability != null) {
    probability = Number(row.probability);
    probabilityBasis = 'stated';
  }
  const condition = (own && row.author_condition) || row.reviewed_condition || row.condition_text || null;
  return {
    deadlineAt,
    deadlineBasis,
    movedTo,
    movedAt: movedTo ? row.author_deadline_moved_at || null : null,
    probability,
    probabilityBasis,
    condition,
  };
}

function time(value) {
  return new Date(value).getTime();
}

// The probability a forecast is scored on: the one stated when the claim was
// made (or a reviewer's correction of how it was read). A number the author
// adds or changes afterwards is shown but never scored.
export function scoringProbability(row) {
  if (row.reviewed_probability != null) return Number(row.reviewed_probability);
  if (row.probability != null) return Number(row.probability);
  return null;
}

// The outcome a save is held to. A reviewer resolves the claim against the
// deadline it states. When the author committed to an earlier deadline, or
// the claim states none, a "came true" that became known only after the
// committed deadline counts as did not come true by it.
export function outcomeFor(row) {
  if (row.status !== 'yes') return row.status;
  const due = effectiveTerms(row).deadlineAt;
  const stated = row.deadline_at || row.proposed_deadline_at;
  const known = row.outcome_at || row.resolved_at;
  if (due && known && (!stated || time(due) < time(stated)) && time(known) > time(due)) return 'no';
  return 'yes';
}

export function cameTrueLate(row) {
  return row.status === 'yes' && outcomeFor(row) === 'no';
}

export function isBackfill(row) {
  return row.save_capture === 'backfill';
}

// A resolved record counts in a public record only if it was public before
// its outcome was known and before its committed deadline. Otherwise
// publishing only the hits, or moving a deadline, would curate the record.
export function publishedInTime(row) {
  if (!row.first_public_at) return false;
  const published = time(row.first_public_at);
  const known = row.outcome_at || row.resolved_at;
  if (known && published > time(known)) return false;
  const due = effectiveTerms(row).deadlineAt;
  if (due && published > time(due)) return false;
  return true;
}
