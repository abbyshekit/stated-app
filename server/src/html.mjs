class Raw {
  constructor(value) {
    this.value = String(value);
  }

  toString() {
    return this.value;
  }
}

const ESCAPES = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };

export function esc(value) {
  return String(value).replace(/[&<>"']/g, (ch) => ESCAPES[ch]);
}

export function raw(value) {
  return new Raw(value);
}

function render(value) {
  if (value == null || value === false || value === true) return '';
  if (value instanceof Raw) return value.value;
  if (Array.isArray(value)) return value.map(render).join('');
  return esc(value);
}

export function html(strings, ...values) {
  let out = '';
  strings.forEach((part, i) => {
    out += part;
    if (i < values.length) out += render(values[i]);
  });
  return new Raw(out);
}

export function when(value) {
  if (!value) return '';
  return new Intl.DateTimeFormat('en-US', {
    timeZone: 'UTC', month: 'short', day: 'numeric', year: 'numeric',
  }).format(new Date(value));
}

// DESIGN.md: exact times share one UTC clock and calendar date.
export function utcTime(value) {
  if (!value) return '';
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return '';
  const clock = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', hour: '2-digit', minute: '2-digit',
  }).format(date);
  const day = new Intl.DateTimeFormat('en-GB', {
    timeZone: 'UTC', day: 'numeric', month: 'short', year: 'numeric',
  }).format(date);
  return `${clock} UTC ${day}`;
}

export function pct(p) {
  return p == null ? '' : `${Math.round(Number(p) * 100)}%`;
}

export function signed(n) {
  const r = Math.round(n);
  return r > 0 ? `+${r}` : String(r);
}
