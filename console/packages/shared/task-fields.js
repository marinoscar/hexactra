// Task fields (E39.5, #600): the typed, named values a task declares. Task
// parameters (#552, task-params.js) are the INPUTS of a run; task outputs are
// the mirror image, the OUTPUTS an agent must return when it finishes. Both
// read values the same way, so the type names (`text`, `number`, `money`,
// `date`, `choice`) and the key rule (the snake_case of a label, as
// `paramKey` writes it) are shared. Framework-free and dependency-free, so the
// API (apps/api/src/tasks/task-outputs.ts, the runner), the web task form and
// the CLI check, parse and show an output with one copy.
//
// An output definition:
//   { key, label, type, required, options?, help?, sensitive? }
// A stored value (`runs.outputs`, by key):
//   { value, ok, note? }   value: string | number | boolean | { amount, currency } | null
//
// Parsing (`parseOutputValue`) reads a value as the page shows it:
// - number: `1,234.50`, `1.234,50`, `(12.5)` (a negative), `-3`.
// - money: a number with an optional currency sign or ISO code before or after
//   (`$1,234.50`, `EUR 20`, `20.00 CAD`), kept as `{ amount, currency }`. A bare
//   `$` reads as USD; `US$`, `CA$`, `A$` and the ISO codes are explicit.
// - date: ISO `YYYY-MM-DD`, or a local form when it is unambiguous
//   (`03/25/2026`, `25/03/2026`, `25.03.2026`, `March 25, 2026`, `25 March 2026`);
//   `03/04/2026` is ambiguous and is refused.
// - datetime: ISO 8601 with a time, or a local date followed by a time
//   (`March 25, 2026 3:30 PM`).
// - boolean: true/false, yes/no, y/n, 1/0, on/off.
// - url: absolute http or https.
// - choice: one of the options (case-insensitive).

const { paramKey, formatDate } = require('./task-params');

/** The types an output may have. The first five are the parameter types it shares. */
const OUTPUT_TYPES = Object.freeze(['text', 'number', 'money', 'date', 'datetime', 'boolean', 'url', 'choice']);
const MAX_OUTPUTS = 30;
const MAX_OUTPUT_KEY_LENGTH = 40;
const MAX_OUTPUT_LABEL_LENGTH = 80;
const MAX_OUTPUT_HELP_LENGTH = 200;
/** The longest text value an output holds. */
const MAX_OUTPUT_TEXT_LENGTH = 500;
const MAX_URL_LENGTH = 2000;
/** What a sensitive output reads as wherever a person, an export or a hosted AI app sees it. */
const MASKED_OUTPUT = '[hidden]';
/** How many times `finish` is refused for a missing or invalid output before the run finishes with what it has. */
const MAX_OUTPUT_ATTEMPTS = 2;

const KEY_PATTERN = /^[a-z0-9][a-z0-9_]*$/;

/**
 * The key an output label gives: lower-case ASCII letters and digits with `_`
 * between words, at most 40 characters (`Confirmation number` -> `confirmation_number`).
 * Empty when the label has no letter or digit.
 */
function outputKey(label) {
  const ascii = String(label ?? '')
    .normalize('NFKD')
    .replace(/[̀-ͯ]/g, '');
  return paramKey(ascii.replace(/[^A-Za-z0-9 _-]+/g, ' '))
    .slice(0, MAX_OUTPUT_KEY_LENGTH)
    .replace(/_+$/g, '');
}

const CURRENCY_SYMBOLS = Object.freeze({
  'US$': 'USD',
  'CA$': 'CAD',
  'C$': 'CAD',
  'AU$': 'AUD',
  'A$': 'AUD',
  '$': 'USD',
  '€': 'EUR',
  '£': 'GBP',
  '¥': 'JPY',
  '₡': 'CRC',
  '₹': 'INR',
  '₩': 'KRW',
  '₽': 'RUB',
  '₺': 'TRY',
  '₪': 'ILS',
  '₫': 'VND',
  '₦': 'NGN',
  '₱': 'PHP',
  '₴': 'UAH',
  'R$': 'BRL',
  'CHF': 'CHF',
});
const SYMBOL_PATTERN = ['US$', 'CA$', 'AU$', 'R$', 'C$', 'A$', '$', '€', '£', '¥', '₡', '₹', '₩', '₽', '₺', '₪', '₫', '₦', '₱', '₴'];
const CURRENCY_CODES = new Set(
  'USD EUR GBP JPY CAD AUD NZD CHF CNY HKD SGD SEK NOK DKK PLN CZK HUF RON BGN MXN BRL ARS CLP COP PEN CRC UYU INR KRW RUB TRY ILS AED SAR ZAR EGP NGN KES THB MYR IDR PHP VND TWD UAH'.split(' '),
);

/**
 * A number as a page writes it: `1,234.50`, `1.234,50`, `1 234,5`, `12,50`, `(12.5)` (negative), `-3`.
 * Returns the number, or null. `1,234` reads as 1234 (a comma then exactly three digits is a thousands separator).
 */
function parseLocalizedNumber(text) {
  let s = String(text).trim();
  if (s === '') return null;
  let negative = false;
  const paren = /^\((.*)\)$/.exec(s);
  if (paren) {
    negative = true;
    s = paren[1].trim();
  }
  if (/^[-−–]/.test(s)) {
    negative = !negative;
    s = s.slice(1).trim();
  } else if (s.startsWith('+')) s = s.slice(1).trim();
  // Spaces, thin spaces and apostrophes group thousands in some locales.
  s = s.replace(/[\s  '’](?=\d{3}(?:\D|$))/g, '');
  if (!/^\d[\d.,]*$/.test(s) || /[.,]$/.test(s)) return null;
  const commas = (s.match(/,/g) || []).length;
  const dots = (s.match(/\./g) || []).length;
  let normal;
  if (commas && dots) {
    const decimal = s.lastIndexOf(',') > s.lastIndexOf('.') ? ',' : '.';
    const group = decimal === ',' ? '.' : ',';
    const parts = s.split(decimal);
    if (parts.length !== 2) return null;
    const whole = parts[0];
    if (!new RegExp(`^\\d{1,3}(\\${group}\\d{3})+$`).test(whole)) return null;
    if (!/^\d+$/.test(parts[1])) return null;
    normal = `${whole.split(group).join('')}.${parts[1]}`;
  } else if (commas) {
    if (/^\d{1,3}(,\d{3})+$/.test(s)) normal = s.split(',').join('');
    else if (commas === 1 && /^\d+,\d+$/.test(s)) normal = s.replace(',', '.');
    else return null;
  } else if (dots > 1) {
    if (!/^\d{1,3}(\.\d{3})+$/.test(s)) return null;
    normal = s.split('.').join('');
  } else normal = s;
  if (!/^\d+(\.\d+)?$/.test(normal)) return null;
  const n = Number(normal);
  if (!Number.isFinite(n)) return null;
  return negative ? -n : n;
}

/** `{ amount, currency }` from a money value as a page shows it, or null. A bare number has a null currency. */
function parseMoney(text) {
  let s = String(text).trim();
  if (s === '') return null;
  let currency = null;
  // A code before or after the amount: `EUR 20`, `20.00 CAD`.
  const lead = /^([A-Za-z]{3})\s*(?=[\d(+\-−–])/.exec(s);
  const tail = /(?<=[\d)])\s*([A-Za-z]{3})$/.exec(s);
  if (lead && CURRENCY_CODES.has(lead[1].toUpperCase())) {
    currency = lead[1].toUpperCase();
    s = s.slice(lead[0].length);
  } else if (tail && CURRENCY_CODES.has(tail[1].toUpperCase())) {
    currency = tail[1].toUpperCase();
    s = s.slice(0, s.length - tail[0].length);
  }
  // A sign: leading (`$12`, `-$12`, `$-12`) or trailing (`12 €`).
  let negative = false;
  s = s.trim();
  if (/^[-−–]/.test(s)) {
    negative = true;
    s = s.slice(1).trim();
  }
  for (const sym of SYMBOL_PATTERN) {
    if (s.startsWith(sym)) {
      currency = currency ?? CURRENCY_SYMBOLS[sym];
      s = s.slice(sym.length).trim();
      break;
    }
    if (s.endsWith(sym)) {
      currency = currency ?? CURRENCY_SYMBOLS[sym];
      s = s.slice(0, s.length - sym.length).trim();
      break;
    }
  }
  const n = parseLocalizedNumber(s);
  if (n === null) return null;
  return { amount: negative ? -Math.abs(n) : n, currency };
}

const MONTHS = ['january', 'february', 'march', 'april', 'may', 'june', 'july', 'august', 'september', 'october', 'november', 'december'];
const MONTH_ABBR = { jan: 1, feb: 2, mar: 3, apr: 4, may: 5, jun: 6, jul: 7, aug: 8, sep: 9, sept: 9, oct: 10, nov: 11, dec: 12 };

function monthNumber(word) {
  const w = word.toLowerCase().replace(/\.$/, '');
  const full = MONTHS.indexOf(w);
  if (full !== -1) return full + 1;
  return MONTH_ABBR[w] ?? null;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

function isoDate(y, m, d) {
  if (m < 1 || m > 12 || d < 1 || d > 31) return null;
  const iso = `${String(y).padStart(4, '0')}-${pad(m)}-${pad(d)}`;
  const dt = new Date(`${iso}T00:00:00Z`);
  return !Number.isNaN(dt.getTime()) && dt.toISOString().slice(0, 10) === iso ? iso : null;
}

/** A date as `YYYY-MM-DD`, from ISO or an unambiguous local form; `{ error }` otherwise. */
function parseDateText(text) {
  const s = String(text).trim().replace(/\s+/g, ' ');
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})$/.exec(s) || /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(s);
  if (m) {
    const iso = isoDate(Number(m[1]), Number(m[2]), Number(m[3]));
    return iso ? { value: iso } : { error: 'not a real date' };
  }
  m = /^(\d{1,2})\.(\d{1,2})\.(\d{4})$/.exec(s);
  if (m) {
    const iso = isoDate(Number(m[3]), Number(m[2]), Number(m[1]));
    return iso ? { value: iso } : { error: 'not a real date' };
  }
  m = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})$/.exec(s);
  if (m) {
    const a = Number(m[1]);
    const b = Number(m[2]);
    const y = Number(m[3]);
    if (a > 12 && b <= 12) {
      const iso = isoDate(y, b, a);
      return iso ? { value: iso } : { error: 'not a real date' };
    }
    if (b > 12 && a <= 12) {
      const iso = isoDate(y, a, b);
      return iso ? { value: iso } : { error: 'not a real date' };
    }
    if (a <= 12 && b <= 12 && a !== b) return { error: `ambiguous (day or month first): write it as YYYY-MM-DD` };
    const iso = isoDate(y, a, b);
    return iso ? { value: iso } : { error: 'not a real date' };
  }
  const word = '([A-Za-z]{3,9}\\.?)';
  // `Wednesday, March 25, 2026`, `March 25th, 2026`
  m = new RegExp(`^(?:[A-Za-z]{3,9},? )?${word} (\\d{1,2})(?:st|nd|rd|th)?,? (\\d{4})$`).exec(s);
  if (m && monthNumber(m[1])) {
    const iso = isoDate(Number(m[3]), monthNumber(m[1]), Number(m[2]));
    return iso ? { value: iso } : { error: 'not a real date' };
  }
  // `25 March 2026`, `Wed 25 Mar 2026`
  m = new RegExp(`^(?:[A-Za-z]{3,9},? )?(\\d{1,2})(?:st|nd|rd|th)? ${word},? (\\d{4})$`).exec(s);
  if (m && monthNumber(m[2])) {
    const iso = isoDate(Number(m[3]), monthNumber(m[2]), Number(m[1]));
    return iso ? { value: iso } : { error: 'not a real date' };
  }
  return { error: 'not a date: write it as YYYY-MM-DD' };
}

/** A date and time as `YYYY-MM-DDTHH:MM:SS` (with `Z` or an offset when the page gives one); `{ error }` otherwise. */
function parseDateTimeText(text) {
  const s = String(text).trim().replace(/\s+/g, ' ');
  const iso = /^(\d{4}-\d{1,2}-\d{1,2})[T ](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\.\d+)?\s?(Z|[+-]\d{2}:?\d{2})?$/i.exec(s);
  let datePart;
  let h;
  let min;
  let sec;
  let zone = '';
  if (iso) {
    datePart = iso[1];
    h = Number(iso[2]);
    min = Number(iso[3]);
    sec = iso[4] === undefined ? 0 : Number(iso[4]);
    if (iso[5]) zone = iso[5].toUpperCase() === 'Z' ? 'Z' : iso[5].replace(/^([+-]\d{2})(\d{2})$/, '$1:$2');
  } else {
    const t = /^(.*?)(?:,| at)? (\d{1,2}):(\d{2})(?::(\d{2}))?\s?(am|pm)?$/i.exec(s);
    if (!t) return { error: 'not a date and time: write it as YYYY-MM-DDTHH:MM' };
    datePart = t[1];
    h = Number(t[2]);
    min = Number(t[3]);
    sec = t[4] === undefined ? 0 : Number(t[4]);
    if (t[5]) {
      if (h < 1 || h > 12) return { error: 'not a real time' };
      h = (h % 12) + (t[5].toLowerCase() === 'pm' ? 12 : 0);
    }
  }
  if (h > 23 || min > 59 || sec > 59) return { error: 'not a real time' };
  const d = parseDateText(datePart);
  if (d.error) return d;
  return { value: `${d.value}T${pad(h)}:${pad(min)}:${pad(sec)}${zone}` };
}

const TRUE_WORDS = new Set(['true', 'yes', 'y', '1', 'on']);
const FALSE_WORDS = new Set(['false', 'no', 'n', '0', 'off']);

function isMissing(raw) {
  return raw === undefined || raw === null || (typeof raw === 'string' && raw.trim() === '');
}

function shown(raw) {
  const t = typeof raw === 'string' ? raw : JSON.stringify(raw);
  return t.length > 60 ? `${t.slice(0, 59)}…` : t;
}

/**
 * One value read for its output definition: `{ ok: true, value }` or `{ ok: false, error }` (a short reason with no
 * value in it: it is stored and shown). A missing value (`null`, `undefined`, an empty string) is `{ missing: true }`,
 * decided by the caller (a required output needs one; an optional one may stay empty).
 */
function parseOutputValue(def, raw) {
  if (isMissing(raw)) return { ok: false, missing: true, error: 'Not found' };
  const type = def && def.type;
  const fail = (error) => ({ ok: false, error });
  switch (type) {
    case 'number': {
      const n = typeof raw === 'number' ? raw : typeof raw === 'string' ? parseLocalizedNumber(raw) : null;
      return n !== null && Number.isFinite(n) ? { ok: true, value: n } : fail('not a number');
    }
    case 'money': {
      if (typeof raw === 'number') return Number.isFinite(raw) ? { ok: true, value: { amount: raw, currency: null } } : fail('not an amount of money');
      if (typeof raw === 'object' && raw !== null && typeof raw.amount === 'number') {
        const cur = typeof raw.currency === 'string' && CURRENCY_CODES.has(raw.currency.toUpperCase()) ? raw.currency.toUpperCase() : null;
        return Number.isFinite(raw.amount) ? { ok: true, value: { amount: raw.amount, currency: cur } } : fail('not an amount of money');
      }
      const m = typeof raw === 'string' ? parseMoney(raw) : null;
      return m ? { ok: true, value: m } : fail('not an amount of money');
    }
    case 'date': {
      if (typeof raw !== 'string') return fail('not a date: write it as YYYY-MM-DD');
      const d = parseDateText(raw);
      return d.error ? fail(d.error) : { ok: true, value: d.value };
    }
    case 'datetime': {
      if (typeof raw !== 'string') return fail('not a date and time');
      const d = parseDateTimeText(raw);
      return d.error ? fail(d.error) : { ok: true, value: d.value };
    }
    case 'boolean': {
      if (typeof raw === 'boolean') return { ok: true, value: raw };
      const w = String(raw).trim().toLowerCase();
      if (TRUE_WORDS.has(w)) return { ok: true, value: true };
      if (FALSE_WORDS.has(w)) return { ok: true, value: false };
      return fail('not true or false');
    }
    case 'url': {
      const t = String(raw).trim();
      if (t.length > MAX_URL_LENGTH) return fail(`longer than ${MAX_URL_LENGTH} characters`);
      let u;
      try {
        u = new URL(t);
      } catch {
        return fail('not an absolute web address');
      }
      return u.protocol === 'http:' || u.protocol === 'https:' ? { ok: true, value: t } : fail('not an http or https address');
    }
    case 'choice': {
      const options = Array.isArray(def.options) ? def.options : [];
      const t = String(raw).trim();
      const hit = options.find((x) => x === t) || options.find((x) => x.toLowerCase() === t.toLowerCase());
      return hit ? { ok: true, value: hit } : fail(`not one of: ${options.join(', ')}`);
    }
    case 'text':
    default: {
      if (typeof raw === 'object') return fail('not text');
      const t = String(raw).replace(/\s*[\r\n]+\s*/g, ' ').trim();
      if (t.length > MAX_OUTPUT_TEXT_LENGTH) return fail(`longer than ${MAX_OUTPUT_TEXT_LENGTH} characters`);
      return { ok: true, value: t };
    }
  }
}

/**
 * Problems with a list of output definitions that a schema's shape cannot say, as `{ key, message }`: at most 30, a
 * valid and unique key, a known type, 2 to 50 different options for a choice and none for any other type.
 */
function outputDefinitionProblems(defs) {
  const out = [];
  const list = Array.isArray(defs) ? defs : [];
  if (list.length > MAX_OUTPUTS) out.push({ key: '', message: `At most ${MAX_OUTPUTS} outputs per task` });
  const seen = new Set();
  for (const def of list) {
    const key = String(def && def.key);
    const add = (message) => out.push({ key, message });
    if (!KEY_PATTERN.test(key) || key.length > MAX_OUTPUT_KEY_LENGTH) add(`The key must be 1 to ${MAX_OUTPUT_KEY_LENGTH} characters: lower-case letters, digits and _`);
    if (seen.has(key)) add('Two outputs have the same key');
    seen.add(key);
    if (!OUTPUT_TYPES.includes(def.type)) add(`Unknown type ${def.type}`);
    if (def.type === 'choice') {
      const n = Array.isArray(def.options) ? def.options.length : 0;
      if (n < 2 || n > 50) add('A choice needs 2 to 50 options');
      else if (new Set(def.options).size !== n) add('The options must be different');
    } else if (def.options && def.options.length) add('Options are only for a choice');
  }
  return out;
}

/**
 * What the agent gave for each output, read and checked.
 * `defs`: the definitions. `raw`: the `outputs` the agent passed (an object by key; anything else counts as none).
 * Unknown keys are dropped.
 * Returns:
 * - `fields`: `{ [key]: { value, ok, note? } }`, every defined key. A value that did not read is `null`, `ok: false`
 *   and a `note` with the reason (never the value); a missing optional value is `null`, `ok: true`; a missing required
 *   one is `null`, `ok: false`, note "Not found".
 * - `problems`: `{ key, message }` for what the agent must fix (the sentence it is answered with, a bad value shown back
 *   in quotes unless the output is sensitive).
 * - `complete`: every output is `ok`.
 */
function parseOutputs(defs, raw) {
  const given = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  const fields = {};
  const problems = [];
  for (const def of defs || []) {
    const has = Object.prototype.hasOwnProperty.call(given, def.key);
    const value = has ? given[def.key] : undefined;
    const r = parseOutputValue(def, value);
    if (r.ok) {
      fields[def.key] = { value: r.value, ok: true };
    } else if (r.missing) {
      const required = def.required !== false;
      fields[def.key] = required ? { value: null, ok: false, note: 'Not found' } : { value: null, ok: true };
      if (required) problems.push({ key: def.key, message: `\`${def.key}\` is required` });
    } else {
      fields[def.key] = { value: null, ok: false, note: r.error.charAt(0).toUpperCase() + r.error.slice(1) };
      problems.push({ key: def.key, message: `\`${def.key}\` is ${r.error}${def.sensitive ? '' : `: '${shown(value)}'`}` });
    }
  }
  return { fields, problems, complete: Object.values(fields).every((f) => f.ok) };
}

/** A value as a person or a spreadsheet reads it: `{ amount, currency }` as `USD 25.50`, a boolean as Yes or No, null as an empty string. */
function formatOutputValue(def, value) {
  if (value === null || value === undefined) return '';
  if (typeof value === 'object' && value !== null && typeof value.amount === 'number') {
    const n = Number.isInteger(value.amount) ? String(value.amount) : value.amount.toFixed(2);
    return value.currency ? `${value.currency} ${n}` : n;
  }
  if (typeof value === 'boolean') return value ? 'Yes' : 'No';
  if (def && def.type === 'date' && typeof value === 'string') return formatDate(value);
  return String(value);
}

exports.OUTPUT_TYPES = OUTPUT_TYPES;
exports.MAX_OUTPUTS = MAX_OUTPUTS;
exports.MAX_OUTPUT_KEY_LENGTH = MAX_OUTPUT_KEY_LENGTH;
exports.MAX_OUTPUT_LABEL_LENGTH = MAX_OUTPUT_LABEL_LENGTH;
exports.MAX_OUTPUT_HELP_LENGTH = MAX_OUTPUT_HELP_LENGTH;
exports.MAX_OUTPUT_TEXT_LENGTH = MAX_OUTPUT_TEXT_LENGTH;
exports.MASKED_OUTPUT = MASKED_OUTPUT;
exports.MAX_OUTPUT_ATTEMPTS = MAX_OUTPUT_ATTEMPTS;
exports.outputKey = outputKey;
exports.parseLocalizedNumber = parseLocalizedNumber;
exports.parseMoney = parseMoney;
exports.parseDateText = parseDateText;
exports.parseDateTimeText = parseDateTimeText;
exports.parseOutputValue = parseOutputValue;
exports.outputDefinitionProblems = outputDefinitionProblems;
exports.parseOutputs = parseOutputs;
exports.formatOutputValue = formatOutputValue;
