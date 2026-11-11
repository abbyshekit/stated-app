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
