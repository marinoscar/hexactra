// Task parameters (E36.6, #552): `{{Name}}` placeholders in a task's goal,
// their definitions and the rules a value must meet. Framework-free and
// dependency-free, so the API (apps/api/src/tasks/task-params.ts), the web
// task form and the CLI parse, check and fill a goal with one copy.
//
// Syntax:
// - A placeholder is `{{Name}}`: letters, digits, spaces, `_` and `-`, 1 to 40
//   characters once trimmed. Its key is the name lower-cased with runs of
//   spaces, `_` and `-` collapsed to one `_` (`Phone Number` -> `phone_number`).
//   The same key may appear more than once.
// - Anything else between braces is plain text. `\{{` is a literal `{{`. A `$`
//   before a placeholder is plain text: `${{Amount}}` with 25 reads `$25`.
// - A `{{` that is never closed, an empty `{{ }}` and a name longer than 40
//   characters are errors with their position.
// - At most 20 distinct parameters.
//
// Filling (`render`) is one pass over the parsed goal: an inserted value is
// text, never read again as a placeholder, and the data markers ⟦ ⟧ are
// removed from a value so it cannot close its own marker.

/**
 * The saved identity fields a parameter's default may name (E37.6): the fields of the provider's identity type. The value is never
 * stored or shown: the goal holds `[provided: <label>]` and the fabric fills the field.
 */
const IDENTITY_DEFAULT_FIELDS = ['full_name', 'date_of_birth', 'id_type', 'id_number', 'id_issuing_country', 'address_line1', 'address_line2', 'city', 'region', 'postal_code', 'country', 'phone', 'email'];

const MAX_PARAMETERS = 20;
const MAX_NAME_LENGTH = 40;
const PARAMETER_TYPES = Object.freeze(['text', 'number', 'money', 'date', 'choice', 'phone', 'email']);
/** The longest value a parameter takes (a goal is at most 4000 characters). */
const MAX_VALUE_LENGTH = 500;
/** The data markers around an inserted value in the goal the model reads. */
const MARK_OPEN = '⟦';
const MARK_CLOSE = '⟧';
/** The longest `constraints.pattern`. */
const MAX_PATTERN_LENGTH = 200;

const NAME_CHARS = /^[\p{L}\p{N} _-]+$/u;

/** The key of a placeholder name: `Phone Number` -> `phone_number`. Empty when the name has no letter or digit. */
function paramKey(name) {
  return String(name)
    .trim()
    .toLowerCase()
    .replace(/[\s_-]+/g, '_')
    .replace(/^_+|_+$/g, '');
}

/**
 * The goal as segments: plain text and placeholders, with the problems found.
 * `segments`: `{ text }` or `{ key, name, start, end }` (`start`/`end` index the goal).
 * `params`: `{ key, name }` per distinct key, in order of first appearance.
 * `errors`: `{ position, message }`.
 */
function parseGoal(goal) {
  const text = String(goal ?? '');
  const segments = [];
  const params = [];
  const seen = new Map();
  const errors = [];
  let buf = '';
  let i = 0;
  const flush = () => {
    if (buf) segments.push({ text: buf });
    buf = '';
  };
  while (i < text.length) {
    if (text.startsWith('\\{{', i)) {
      buf += '{{';
      i += 3;
      continue;
    }
    if (text.startsWith('{{', i)) {
      const close = text.indexOf('}}', i + 2);
      if (close === -1) {
        errors.push({ position: i, message: `The "{{" at position ${i} is not closed with "}}" (write \\{{ for a literal "{{")` });
        buf += '{{';
        i += 2;
        continue;
      }
      const inner = text.slice(i + 2, close);
      const name = inner.trim();
      if (name === '' && !/[\r\n]/.test(inner)) {
        errors.push({ position: i, message: `The placeholder at position ${i} has no name` });
        buf += text.slice(i, close + 2);
        i = close + 2;
        continue;
      }
      if (!NAME_CHARS.test(inner) || /[\r\n\t]/.test(inner)) {
        // Anything else between braces is plain text.
        buf += '{{';
        i += 2;
        continue;
      }
      if (name.length > MAX_NAME_LENGTH) {
        errors.push({ position: i, message: `The parameter name at position ${i} is longer than ${MAX_NAME_LENGTH} characters` });
        buf += text.slice(i, close + 2);
        i = close + 2;
        continue;
      }
      const key = paramKey(name);
      if (!key) {
        errors.push({ position: i, message: `The parameter name at position ${i} needs a letter or a digit` });
        buf += text.slice(i, close + 2);
        i = close + 2;
        continue;
      }
      if (!seen.has(key)) {
        if (seen.size >= MAX_PARAMETERS) {
          errors.push({ position: i, message: `At most ${MAX_PARAMETERS} parameters per task (the one at position ${i} is the ${MAX_PARAMETERS + 1}st)` });
          buf += text.slice(i, close + 2);
          i = close + 2;
          continue;
        }
        seen.set(key, name);
        params.push({ key, name });
      }
      flush();
      segments.push({ key, name, start: i, end: close + 2 });
      i = close + 2;
      continue;
    }
    buf += text[i];
    i += 1;
  }
  flush();
  return { segments, params, errors };
}

/** The keys of a goal's placeholders in order of first appearance, with their display names, and its errors. */
function parsePlaceholders(goal) {
  const { params, errors } = parseGoal(goal);
  return { params, errors };
}

/** A value as it may be inserted: the data markers removed. */
function cleanValue(v) {
  return String(v).split(MARK_OPEN).join('').split(MARK_CLOSE).join('');
}

/**
 * The goal with `values` (by key) filled in. A placeholder without a value is
 * left as written (`{{Name}}`), or replaced by `opts.missing(param)` when given.
 * `opts.mark`: wrap each inserted value in ⟦ ⟧ (what the runner gives the model).
 * `opts.display(key, value)`: the text inserted for a value (a date in words).
 */
function render(goal, values, opts) {
  const o = opts || {};
  const vals = values || {};
  let out = '';
  for (const s of parseGoal(goal).segments) {
    if (s.text !== undefined) {
      out += s.text;
      continue;
    }
    const has = Object.prototype.hasOwnProperty.call(vals, s.key) && vals[s.key] !== undefined && vals[s.key] !== null;
    if (!has) {
      out += o.missing ? o.missing({ key: s.key, name: s.name }) : `{{${s.name}}}`;
      continue;
    }
    const shown = cleanValue(o.display ? o.display(s.key, vals[s.key]) : vals[s.key]);
    out += o.mark ? `${MARK_OPEN}${shown}${MARK_CLOSE}` : shown;
  }
  return out;
}

/** Why a `constraints.pattern` cannot be used, or null: too long, invalid, a back-reference or a nested quantifier. */
function patternProblem(pattern) {
  if (typeof pattern !== 'string' || pattern.length === 0) return 'The pattern is empty';
  if (pattern.length > MAX_PATTERN_LENGTH) return `The pattern is longer than ${MAX_PATTERN_LENGTH} characters`;
  try {
    new RegExp(pattern, 'u');
  } catch {
    return 'The pattern is not a valid regular expression';
  }
  if (/\\[1-9]|\\k</.test(pattern)) return 'The pattern may not use back-references';
  // A quantified group that holds a quantifier ((a+)+, (\d{2})*, (a|b*){3}) can take exponential time.
  if (/\((?:[^()\\]|\\.)*(?:[+*]|\{\d+(?:,\d*)?\})(?:[^()\\]|\\.)*\)\s*(?:[+*?]|\{\d)/.test(pattern)) return 'The pattern may not repeat a group that repeats (nested quantifiers)';
  return null;
}

function pad(n) {
  return String(n).padStart(2, '0');
}

/** Today's date (`YYYY-MM-DD`) in a time zone (UTC when the zone is unknown). */
function todayIn(timeZone, now) {
  const d = now instanceof Date ? now : new Date(now === undefined ? Date.now() : now);
  try {
    const parts = new Intl.DateTimeFormat('en-CA', { timeZone: timeZone || 'UTC', year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(d);
    const get = (t) => parts.find((p) => p.type === t).value;
    return `${get('year')}-${get('month')}-${get('day')}`;
  } catch {
    return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
  }
}

function addDays(iso, days) {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

function validIsoDate(v) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(v)) return false;
  const d = new Date(`${v}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === v;
}

/** A date (`YYYY-MM-DD`) in words: "Wednesday, November 18, 2026". */
function formatDate(iso) {
  if (!validIsoDate(iso)) return iso;
  return new Intl.DateTimeFormat('en-US', { timeZone: 'UTC', weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(`${iso}T00:00:00Z`));
}

/** The text a value reads as in the goal (a date in words; everything else as stored). */
function displayValue(def, value) {
  if (def && def.type === 'date') return formatDate(String(value));
  return String(value);
}

function rangeError(n, c) {
  if (c && typeof c.min === 'number' && n < c.min) return `At least ${c.min}`;
  if (c && typeof c.max === 'number' && n > c.max) return `At most ${c.max}`;
  return null;
}

/**
 * A value checked against its parameter and normalised: `{ value }`, or
 * `{ error }` with a sentence the person can act on. An empty value is
 * `{ error: 'Enter a value' }` (the caller decides whether it is missing).
 * `opts.timeZone` and `opts.now` resolve `today` and `tomorrow`.
 */
function normalizeValue(def, raw, opts) {
  const o = opts || {};
  const c = (def && def.constraints) || {};
  const v = raw === undefined || raw === null ? '' : String(raw).trim();
  if (v === '') return { error: 'Enter a value' };
  if (v.length > MAX_VALUE_LENGTH) return { error: `At most ${MAX_VALUE_LENGTH} characters` };
  if (typeof c.maxLength === 'number' && v.length > c.maxLength) return { error: `At most ${c.maxLength} characters` };
  if (/[\r\n]/.test(v)) return { error: 'One line only' };
  const withPattern = (value) => {
    if (c.pattern && (def.type === 'text' || def.type === 'phone' || def.type === 'email')) {
      if (patternProblem(c.pattern)) return { error: 'This parameter has an invalid pattern' };
      if (!new RegExp(`^(?:${c.pattern})$`, 'u').test(value)) return { error: 'This does not have the expected format' };
    }
    return { value };
  };
  switch (def && def.type) {
    case 'number': {
      if (!/^-?\d+(\.\d+)?$/.test(v)) return { error: 'Enter a number' };
      const e = rangeError(Number(v), c);
      return e ? { error: e } : { value: v };
    }
    case 'money': {
      const s = v.replace(/^[$€£¥₡]\s*/u, '').replace(/^([A-Z]{3})\s+/, '');
      if (!/^\d+(\.\d{1,2})?$/.test(s)) return { error: 'Enter an amount such as 25 or 25.50' };
      const e = rangeError(Number(s), c);
      return e ? { error: e } : { value: s };
    }
    case 'date': {
      const w = v.toLowerCase();
      const today = todayIn(o.timeZone, o.now);
      const iso = w === 'today' ? today : w === 'tomorrow' ? addDays(today, 1) : v;
      if (!validIsoDate(iso)) return { error: 'Enter a date as YYYY-MM-DD, or today or tomorrow' };
      return { value: iso };
    }
    case 'choice': {
      const options = Array.isArray(def.options) ? def.options : [];
      const hit = options.find((x) => x === v) || options.find((x) => x.toLowerCase() === v.toLowerCase());
      return hit ? { value: hit } : { error: `Choose one of: ${options.join(', ')}` };
    }
    case 'phone': {
      const digits = v.replace(/\D/g, '');
      if (!/^\+?[\d\s().-]+$/.test(v) || digits.length < 7 || digits.length > 15) return { error: 'Enter a phone number' };
      return withPattern(v);
    }
    case 'email':
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) return { error: 'Enter an email address' };
      return withPattern(v);
    case 'text':
    default:
      return withPattern(v);
  }
}

/**
 * Problems with a definition that zod's shape cannot say, as `{ key, message }`:
 * options only for `choice` (2 to 50), a usable pattern, min not above max, a
 * valid fixed default, and no default on a sensitive parameter.
 */
function definitionProblems(def) {
  const out = [];
  const add = (message) => out.push({ key: def.key, message });
  if (!PARAMETER_TYPES.includes(def.type)) add(`Unknown type ${def.type}`);
  if (def.type === 'choice') {
    const n = Array.isArray(def.options) ? def.options.length : 0;
    if (n < 2 || n > 50) add('A choice needs 2 to 50 options');
    else if (new Set(def.options).size !== n) add('The options must be different');
  } else if (def.options && def.options.length) add('Options are only for a choice');
  const c = def.constraints || {};
  if (c.pattern !== undefined) {
    const p = patternProblem(c.pattern);
    if (p) add(p);
  }
  if (typeof c.min === 'number' && typeof c.max === 'number' && c.min > c.max) add('The minimum is above the maximum');
  if (def.sensitive && def.default) add('A sensitive parameter cannot have a default: it is asked for every time');
  if (def.default && def.default.identity !== undefined) {
    const f = def.default.identity && def.default.identity.field;
    if (!IDENTITY_DEFAULT_FIELDS.includes(f)) add(`The default: choose one of the saved detail fields (${IDENTITY_DEFAULT_FIELDS.join(', ')})`);
    if (def.options && def.options.length) add('A parameter taken from your saved details has no options');
  }
  if (def.default && def.default.value !== undefined) {
    const r = normalizeValue(def, def.default.value, {});
    // `today` and `tomorrow` are good defaults for a date: they are resolved at run time.
    if (r.error && !(def.type === 'date' && /^(today|tomorrow)$/i.test(String(def.default.value).trim()))) add(`The default: ${r.error}`);
  }
  return out;
}

/**
 * The definitions a goal has: one per placeholder, in order of first
 * appearance. A placeholder without a definition gets one (text, required,
 * labelled with its name); a definition without a placeholder is dropped.
 * A definition's own `key` is taken from the placeholder.
 */
function reconcileParameters(goal, defs) {
  const { params, errors } = parsePlaceholders(goal);
  const byKey = new Map();
  for (const d of defs || []) {
    if (d && typeof d.key === 'string') byKey.set(paramKey(d.key) || d.key, d);
  }
  const parameters = params.map((p) => {
    const d = byKey.get(p.key);
    if (!d) return { key: p.key, label: p.name, type: 'text', required: true };
    return { ...d, key: p.key, label: d.label || p.name, type: d.type || 'text', required: d.required !== false };
  });
  return { parameters, errors };
}

/** The key an input names: a key, a placeholder or display name, or a label (case and spacing do not matter). Null when none matches. */
function matchInputKey(parameters, name) {
  const k = paramKey(name);
  for (const p of parameters || []) {
    if (p.key === name || p.key === k) return p.key;
  }
  for (const p of parameters || []) {
    if (p.label && paramKey(p.label) === k) return p.key;
  }
  return null;
}

exports.IDENTITY_DEFAULT_FIELDS = IDENTITY_DEFAULT_FIELDS;
exports.MAX_PARAMETERS = MAX_PARAMETERS;
exports.MAX_NAME_LENGTH = MAX_NAME_LENGTH;
exports.MAX_VALUE_LENGTH = MAX_VALUE_LENGTH;
exports.MAX_PATTERN_LENGTH = MAX_PATTERN_LENGTH;
exports.PARAMETER_TYPES = PARAMETER_TYPES;
exports.MARK_OPEN = MARK_OPEN;
exports.MARK_CLOSE = MARK_CLOSE;
exports.paramKey = paramKey;
exports.parseGoal = parseGoal;
exports.parsePlaceholders = parsePlaceholders;
exports.render = render;
exports.cleanValue = cleanValue;
exports.patternProblem = patternProblem;
exports.todayIn = todayIn;
exports.formatDate = formatDate;
exports.displayValue = displayValue;
exports.normalizeValue = normalizeValue;
exports.definitionProblems = definitionProblems;
exports.reconcileParameters = reconcileParameters;
exports.matchInputKey = matchInputKey;
