// The public record is a post on X. The sentence, the deadline, the
// probability, and the rule have to be in the post. Nothing is cut to fit.
// If the call is longer than 280 characters, it becomes two posts: the
// sentence, then the rule as the reply.

export const X_LIMIT = 280;

export function closeStamp(ms, timeZone = 'America/New_York') {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
    timeZoneName: 'short',
  }).formatToParts(new Date(ms));
  const get = (type) => parts.find((part) => part.type === type)?.value || '';
  const minute = get('minute');
  const clock = minute === '00'
    ? `${get('hour')} ${get('dayPeriod')}`
    : `${get('hour')}:${minute} ${get('dayPeriod')}`;
  const zone = get('timeZoneName').replace(/E[DS]T|GMT-5|GMT-4/, 'ET');
  return `${get('month')} ${get('day')}, ${clock} ${zone}`.replace(/\s+/g, ' ').trim();
}

export function callPosts({ claim, closeLabel, percent, rule }) {
  const head = `On record · closes ${closeLabel}\n\n${claim}\n\n${percent}%`;
  const together = `${head}\n\n${rule}`;
  if (together.length <= X_LIMIT) return { posts: [together], split: false };
  return {
    posts: [`${head}\n\nRule is the next post.`, rule],
    split: true,
  };
}

export function reasonPost(reason) {
  return String(reason || '').trim();
}

export function updatePost({ from, to, reason }) {
  const note = String(reason || '').trim();
  const change = `Update. Same sentence, same rule. Was ${from}%. Now ${to}%.`;
  return note ? `${change}\n\n${note}` : change;
}

export function receiptPost({ outcome, percent, baseline, what }) {
  const rounded = Math.round(baseline);
  const score = rounded > 0 ? `+${rounded}` : String(rounded);
  const word = outcome === 'yes' ? 'Yes' : outcome === 'no' ? 'No' : outcome;
  const happened = String(what || '').trim();
  const head = `Recorded. ${word}.\n\nI said ${percent}%. Baseline ${score}.`;
  return happened ? `${head}\n\n${happened}` : head;
}

export function xIntent(text, quoteUrl = '') {
  const params = new URLSearchParams();
  params.set('text', text);
  if (quoteUrl) params.set('url', quoteUrl);
  return `https://x.com/intent/post?${params.toString()}`;
}

export function fits(text) {
  return String(text || '').length <= X_LIMIT;
}
