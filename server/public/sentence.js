// DESIGN.md: keep the sentence in this browser through sign-in, then open its review.
const draftKey = 'stated.sentence-draft';
const maxAge = 15 * 60 * 1000;

function savedDraft() {
  try {
    const draft = JSON.parse(sessionStorage.getItem(draftKey));
    const age = Date.now() - Date.parse(draft?.draftedAt);
    if (typeof draft?.sentence === 'string' && draft.sentence.length <= 1100
      && typeof draft.id === 'string' && age >= 0 && age <= maxAge) return draft;
    sessionStorage.removeItem(draftKey);
  } catch { /* Ordinary GET forms remain available when browser storage is disabled. */ }
  return null;
}

const start = document.querySelector('form[data-bet-start]');
if (start) {
  const field = start.elements.namedItem('sentence');
  const saved = savedDraft();
  if (saved && !field.value) field.value = saved.sentence;
  start.addEventListener('submit', event => {
    try {
      const draft = { id: crypto.randomUUID(), sentence: field.value, draftedAt: new Date().toISOString() };
      sessionStorage.setItem(draftKey, JSON.stringify(draft));
      const destination = new URL(start.action);
      destination.searchParams.set('draft', draft.id);
      event.preventDefault();
      location.assign(destination.href);
    } catch { /* Preserve the standard form submission. */ }
  });
}

const sentence = document.querySelector('form[data-bet-sentence]');
if (sentence) {
  sentence.elements.namedItem('timeZone').value = Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  const saved = savedDraft();
  const field = sentence.elements.namedItem('sentence');
  const continuing = saved && new URL(location.href).searchParams.get('draft') === saved.id;
  if (saved && !field.value) {
    field.value = saved.sentence;
    sentence.elements.namedItem('draftedAt').value = saved.draftedAt;
  }
  try { sessionStorage.removeItem(draftKey); } catch { /* The form works without storage. */ }
  sentence.addEventListener('submit', () => {
    const status = sentence.querySelector('[data-sentence-status]');
    if (status) status.textContent = 'Preparing your bet…';
    sentence.querySelector('button[type="submit"]').disabled = true;
  });
  window.addEventListener('pageshow', event => {
    if (event.persisted) {
      sentence.querySelector('button[type="submit"]').disabled = false;
      const status = sentence.querySelector('[data-sentence-status]');
      if (status) status.textContent = '';
    }
  });
  if (continuing && sentence.checkValidity()) sentence.requestSubmit();
}
