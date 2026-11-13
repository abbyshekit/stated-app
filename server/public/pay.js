// Small conveniences for payments and shared Bet links. A page may include this script from two folds.
if (!globalThis.statedPayEnhanced) {
globalThis.statedPayEnhanced = true;
//
// DESIGN.md: preserve the server's complete UTC timestamps, including post times.
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

// DESIGN.md: update persisted balance text in place; keep the account selectable when copying fails.
for (const panel of document.querySelectorAll('[data-funding]')) {
  const button = panel.querySelector('[data-refresh-balance]');
  const balance = panel.querySelector('[data-funding-balance]');
  const missing = panel.querySelector('[data-funding-missing]');
  const status = panel.querySelector('[data-funding-status]');
  const account = panel.querySelector('#funding-account');
  if (!button || !balance || !missing || !status || !account) continue;
  let pending = false;
  const refresh = async () => {
    if (pending) return;
    pending = true; button.disabled = true;
    try {
      const response = await fetch(`/me/wallet/balance?need=${encodeURIComponent(panel.dataset.neededYocto)}`, {
        credentials: 'same-origin', cache: 'no-store', signal: AbortSignal.timeout(8000),
      });
      if (!response.ok) throw new Error('Balance unavailable');
      const value = await response.json();
      if (value.accountId !== account.textContent || value.neededYocto !== panel.dataset.neededYocto
        || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value.balanceNear)
        || !/^(?:0|[1-9][0-9]*)(?:\.[0-9]+)?$/.test(value.missingNear)) throw new Error('Invalid balance');
      balance.textContent = `${value.balanceNear} NEAR`;
      missing.textContent = `${value.missingNear} NEAR`;
      status.textContent = value.missingNear === '0' ? 'Balance updated. You can return to the bet.' : 'Balance updated.';
    } catch { status.textContent = 'Balance could not be refreshed. Retry the balance check.'; }
    finally { pending = false; button.disabled = false; }
  };
  button.hidden = false;
  button.addEventListener('click', refresh);
  setInterval(() => { if (!document.hidden) void refresh(); }, 10000);
}
}
