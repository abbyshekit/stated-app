// Small conveniences for payments and shared Bet links.
//
// A deadline is written by the server in UTC; here it is rewritten in the person's own time.
for (const time of document.querySelectorAll('time[datetime]')) {
  const at = new Date(time.dateTime);
  if (!Number.isNaN(at.getTime())) time.textContent = at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}
// The cost shown on the form is for the amount and token it opened with. Change either and it goes,
// so the page never shows a price for something else.
const cost = document.getElementById('add-cost');
if (cost) for (const id of ['add-near', 'add-with']) document.getElementById(id)?.addEventListener('input', () => { cost.hidden = true; });

// Only the server-marked managed acceptance form gets pending feedback.
for (const form of document.querySelectorAll('form[data-managed-take]')) {
  const action = new URL(form.action, window.location.href);
  if (form.method.toLowerCase() !== 'post' || action.origin !== window.location.origin ||
      action.pathname !== `/bets/${form.dataset.managedTake}/take` || action.search || action.hash) continue;
  const button = form.querySelector('button[type="submit"]');
  const status = document.getElementById('managed-take-status');
  if (!button || !status) continue;
  const label = button.textContent, disabled = button.disabled, busy = form.getAttribute('aria-busy');
  let pending = false, generation = 0;
  const reset = () => {
    pending = false; generation++;
    button.textContent = label; button.disabled = disabled; status.textContent = '';
    if (busy === null) form.removeAttribute('aria-busy'); else form.setAttribute('aria-busy', busy);
  };
  form.addEventListener('submit', event => {
    if (event.defaultPrevented) return;
    if (pending) { event.preventDefault(); return; }
    pending = true;
    const current = ++generation;
    // Wait until all submit listeners have run and the browser has serialized the submitter.
    setTimeout(() => {
      if (current !== generation) return;
      if (event.defaultPrevented) { reset(); return; }
      button.disabled = true; button.textContent = 'Matching stake';
      form.setAttribute('aria-busy', 'true'); status.textContent = 'Matching stake';
    }, 0);
  });
  window.addEventListener('pageshow', reset);
}

// Each button names the link or text it copies. The source remains available
// when the browser lacks clipboard access.
for (const button of document.querySelectorAll('button[data-copy]')) {
  const source = document.getElementById(button.dataset.copy);
  if (!source || !navigator.clipboard || !window.isSecureContext) continue;
  const link = source instanceof HTMLAnchorElement;
  const status = link ? button.parentElement.querySelector('[data-copy-status]') : null;
  const label = button.textContent;
  let timer;
  if (link) source.hidden = true;
  button.hidden = false;
  button.addEventListener('click', async () => {
    try {
      await navigator.clipboard.writeText(link ? source.href : source.textContent.replace(/\s+/g, ''));
      button.textContent = 'Copied';
      if (status) status.textContent = 'Bet link copied.';
    } catch {
      if (link) {
        button.hidden = true;
        source.hidden = false;
        source.focus();
        if (status) status.textContent = 'Copy the link from your browser.';
        return;
      }
      button.textContent = 'Could not copy';
    }
    clearTimeout(timer);
    timer = setTimeout(() => {
      button.textContent = label;
      if (status) status.textContent = '';
    }, 1800);
  });
}
