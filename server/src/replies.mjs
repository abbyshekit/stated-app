// Templated replies only; no model writes public text. One reply per
// mention, addressed to the tagger's own post, never naming the author of the
// saved post. A private save gets no link to its content. Links are off by
// default because a post with a URL may bill at $0.20 instead of $0.01.

export function replyFor({ outcome, relation, visibility, owner, saveId, baseUrl, links = false }) {
  const signedUp = Boolean(owner && owner.setup_completed_at);
  const where = relation === 'mine' ? 'My predictions' : 'Following';
  const site = baseUrl.replace(/^https?:\/\//, '');
  if (outcome === 'saved') {
    if (!signedUp) {
      return links
        ? `Saved to ${where} on your Stated profile. Only you can see it. Sign in with X to finish setup: ${baseUrl}/signin?r=reply`
        : `Saved to ${where} on your Stated profile. Only you can see it. Sign in with X at ${site} to see it.`;
    }
    if (visibility === 'public') {
      return links
        ? `Saved to ${where} on ${owner.x_username}'s public profile: ${baseUrl}/u/${owner.x_username}/${saveId}?r=reply`
        : `Saved to ${where} on ${owner.x_username}'s public Stated profile.`;
    }
    return `Saved privately to ${where}. Only you can see it.`;
  }
  if (outcome === 'duplicate') {
    return `Already in ${where} on your Stated profile.`;
  }
  if (outcome === 'article') {
    if (!signedUp) return `Got the link. Sign in with X at ${site} to pick which predictions to track.`;
    return 'Got the link. Pick which predictions to track in your private Stated inbox.';
  }
  if (outcome === 'source_unavailable') {
    return 'Unable to read that post. It may be deleted, or from a protected account.';
  }
  return null;
}
