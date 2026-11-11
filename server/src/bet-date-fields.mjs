// INTEGRATION: Render with betDateFields({ name, label, value, parts, error, now });
// parse submissions with readBetDate(form, name), retain its parts on errors, and
// apply the existing business date-window validation to its returned value.
import { html } from './html.mjs';

const fields = ['Day', 'Month', 'Year', 'Hour', 'Minute'];
const months = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'];
const maxPartLength = 32;

function fromValue(value) {
  const date = new Date(value);
  if (!value || Number.isNaN(date.getTime())) return {};
  return {
    Day: String(date.getUTCDate()), Month: String(date.getUTCMonth() + 1),
    Year: String(date.getUTCFullYear()), Hour: String(date.getUTCHours()),
    Minute: String(date.getUTCMinutes()),
  };
}

function optionList(values, selected, placeholder) {
  const current = String(selected ?? '');
  const matches = values.some(([value]) => String(value) === current);
  return [
    html`<option value="" ${current === '' ? 'selected' : ''}>${placeholder}</option>`,
    current && !matches ? html`<option value="${current}" selected>${current}</option>` : '',
    values.map(([value, text]) => html`<option value="${value}" ${String(value) === current ? 'selected' : ''}>${text}</option>`),
  ];
}

function range(start, end, pad = false) {
  return Array.from({ length: end - start + 1 }, (_, index) => {
    const value = start + index;
    return [String(value), pad ? String(value).padStart(2, '0') : String(value)];
  });
}

export function betDateFields({ name, label, value, parts, error = false, errorText = '', now = new Date() }) {
  const selected = parts ?? fromValue(value);
  const currentYear = now.getUTCFullYear();
  const years = [currentYear, currentYear + 1];
  const selectedYear = String(selected.Year ?? '');
  if (/^\d{1,4}$/.test(selectedYear) && !years.includes(Number(selectedYear))) years.push(Number(selectedYear));
  years.sort((a, b) => a - b);
  const options = {
    Day: range(1, 31), Month: months.map((month, index) => [String(index + 1), month]),
    Year: years.map(year => [String(year), String(year)]),
    Hour: range(0, 23, true), Minute: range(0, 59, true),
  };
  const select = (part) => html`<label class="date-part" for="${name}${part}">${part}<select id="${name}${part}" name="${name}${part}" ${error ? html`aria-invalid="true"` : ''}>${optionList(options[part], selected[part], part)}</select></label>`;
  return html`<fieldset class="date-field"><legend>${label}</legend>${errorText ? html`<p class="err" role="alert">${errorText}</p>` : ''}<input type="hidden" name="${name}DateInput" value="1"><div class="date-row">${['Day', 'Month', 'Year'].map(select)}</div><div class="time-row">${['Hour', 'Minute'].map(select)}<span>UTC</span></div></fieldset>`;
}

export function readBetDate(form, name) {
  if (form.get(`${name}DateInput`) !== '1') {
    return { value: String(form.get(name) ?? '').trim(), parts: undefined, error: false };
  }
  const parts = Object.fromEntries(fields.map(part => [part, String(form.get(`${name}${part}`) ?? '').slice(0, maxPartLength)]));
  const invalid = () => ({ value: '', parts, error: `Enter a valid ${/resol/i.test(name) ? 'resolution' : 'acceptance'} date and time.` });
  if (fields.some(part => !/^\d{1,4}$/.test(parts[part]))) return invalid();
  const [day, month, year, hour, minute] = fields.map(part => Number(parts[part]));
  if (year < 1900 || year > 9999 || month < 1 || month > 12 || day < 1 || day > 31 || hour > 23 || minute > 59) return invalid();
  const date = new Date(Date.UTC(year, month - 1, day, hour, minute));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return invalid();
  return { value: date.toISOString(), parts, error: false };
}
