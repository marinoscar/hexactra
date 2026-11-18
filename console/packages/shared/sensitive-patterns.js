// What counts as sensitive text in a run trace, and how it is shown (E35.3,
// #538). One table, so the trace view, the JSON export, the PDF report and
// the extension's screenshot masking cannot disagree: the API applies it in
// apps/api/src/tasks/mask.ts (`maskSensitive`, `maskValue`), the web app
// imports it from `@app/shared/sensitive-patterns`, and the extension reads a
// generated copy (packages/contracts/sensitive-patterns.json at the repository
// root, written by scripts/gen-sensitive-patterns.mjs; CI fails when stale).
//
// Rules for a pattern:
// - Every quantifier is bounded, so no pattern takes super-linear time on
//   hostile input (a 100 kB string masks in under 50 ms, tested).
// - A pattern never matches its own output, nor any other pattern's: masking
//   masked text changes nothing.
// - `check` names a checksum the match must pass (`luhn`, `mod97`, `aba`), or
//   is null. Context ("near the word routing") is part of the regex, as a
//   lookbehind, so the regex is all the extension needs besides the check.
// - The table is applied in its order (most specific first); a later pattern
//   sees the earlier patterns' output.
//
// Names, addresses, balances and amounts are not patterns. Reports say
// "masked", never "anonymised".

/** Bump when a pattern, its order, its check or its mask changes. */
const SENSITIVE_PATTERNS_VERSION = 1;

/** The character a masked digit or letter reads as. */
const MASK_CHAR = '•';

/** What a redacted token reads as (the same text as `REDACTED_TOKEN` of apps/api/src/mcp/mcp.redact.ts). */
const REDACTED_TOKEN = '[redacted token]';

/**
 * The prefixes of the console's and the fabric's credentials (the same list as
 * `CONSOLE_TOKEN_PREFIXES` of apps/api/src/mcp/mcp.redact.ts; a test pins them equal).
 */
const CONSOLE_TOKEN_PREFIXES = Object.freeze(['pat_', 'oat_', 'ort_', 'oac_', 'nod_', 'hxs_', 'hxe_', 'hxh_', 'whsec_']);

// ---------------------------------------------------------------- checks

function digitsOf(s) {
  return String(s).replace(/\D/g, '');
}

/** The Luhn check of a card number (separators ignored). */
function luhn(s) {
  const d = digitsOf(s);
  if (d.length < 2) return false;
  let sum = 0;
  for (let i = 0; i < d.length; i++) {
    let n = d.charCodeAt(d.length - 1 - i) - 48;
    if (i % 2 === 1) {
      n *= 2;
      if (n > 9) n -= 9;
    }
    sum += n;
  }
  return sum % 10 === 0;
}

/** The ISO 13616 mod-97 check of an IBAN (spaces ignored). */
function mod97(s) {
  const iban = String(s).replace(/\s/g, '').toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  const moved = iban.slice(4) + iban.slice(0, 4);
  let rem = 0;
  for (const ch of moved) {
    const v = ch >= 'A' && ch <= 'Z' ? String(ch.charCodeAt(0) - 55) : ch;
    for (const c of v) rem = (rem * 10 + (c.charCodeAt(0) - 48)) % 97;
  }
  return rem === 1;
}

/** The ABA checksum of a US routing number (9 digits). */
function aba(s) {
  const d = digitsOf(s);
  if (d.length !== 9) return false;
  const w = [3, 7, 1, 3, 7, 1, 3, 7, 1];
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += w[i] * (d.charCodeAt(i) - 48);
  return sum % 10 === 0;
}

const CHECKS = Object.freeze({ luhn, mod97, aba });

// ---------------------------------------------------------------- masks

const M = MASK_CHAR;

/** The last four digits of a match. */
function last4(s) {
  return digitsOf(s).slice(-4);
}

/** `https://host/path (query removed)`, the same as `redactUrl` of apps/api/src/tasks/redact.ts. */
function urlWithoutQuery(raw) {
  try {
    const u = new URL(raw);
    return `${u.origin}${u.pathname}${u.search || u.hash ? ' (query removed)' : ''}`;
  } catch {
    return '[invalid url]';
  }
}

/**
 * How a match is shown, as data (the extension implements the same kinds):
 * - `last4`: `prefix` then the match's last four digits;
 * - `iban`: the country code, `prefix`, then the last four characters;
 * - `email`: the first character, `•••`, then `@` and the domain;
 * - `literal`: `text`;
 * - `url`: origin and path, then ` (query removed)`.
 */
function applyMask(mask, match) {
  switch (mask.kind) {
    case 'last4':
      return `${mask.prefix}${last4(match)}`;
    case 'iban': {
      const compact = match.replace(/\s/g, '');
      return `${compact.slice(0, 2).toUpperCase()}${mask.prefix}${compact.slice(-4)}`;
    }
    case 'email': {
      const at = match.indexOf('@');
      return `${match[0]}${M}${M}${M}${match.slice(at)}`;
    }
    case 'literal':
      return mask.text;
    case 'url':
      return urlWithoutQuery(match);
    default:
      throw new Error(`unknown mask kind ${mask.kind}`);
  }
}

// ---------------------------------------------------------------- regex parts

// A number starts where no word character, bullet, hyphen or decimal point
// (a digit then "." or ",") is before it, and ends where none is after it.
// This keeps UUIDs, run ids, selectors, prices, decimals and masked text out.
const NUM_START = `(?<![\\w${M}-]|\\d[.,])`;
const NUM_END = `(?![\\w${M}-]|[.,]\\d)`;

// The words a routing or account number is near: up to 24 characters with no
// digit and no line break between the word and the number.
const NEAR = '[^\\d\\n]{0,24}';

/**
 * The pattern table, in the order it is applied (most specific first). Each
 * entry: `id`, `description` (what matches), `shownAs` (an example of the
 * output), `source` and `flags` (the regex), `check` (a checksum name or null)
 * and `mask` (how a match is shown, see `applyMask`).
 */
const PATTERN_SPECS = [
  {
    id: 'token',
    description: 'The console\'s and the fabric\'s credentials (`pat_`, `oat_`, `hxs_`, …), `Bearer …` values, JWTs, and `sk-…`, `key-…` style API keys',
    shownAs: REDACTED_TOKEN,
    source: [
      // The console's own credentials, as redactTokens of mcp.redact.ts reads them: a digit somewhere in the body.
      `(?<![A-Za-z0-9])(?:${CONSOLE_TOKEN_PREFIXES.join('|')})(?=[A-Za-z0-9_\\-]{0,256}[0-9])[A-Za-z0-9_\\-]{16,512}`,
      // An Authorization value (a digit in it, so "Bearer responsibility" stays).
      '\\bBearer[ \\t]{1,4}(?=[A-Za-z0-9._~+/\\-]{0,4096}[0-9])[A-Za-z0-9._~+/\\-]{8,4096}={0,2}',
      // A JWT: three base64url segments, the first two JSON objects.
      '\\beyJ[A-Za-z0-9_\\-]{4,4096}\\.eyJ[A-Za-z0-9_\\-]{4,8192}\\.[A-Za-z0-9_\\-]{0,4096}',
      // Provider API keys: sk-…, sk-proj-…, key-…, sk_live_…, ghp_…, github_pat_…, xoxb-…, AKIA…; a digit in the body.
      '(?<![A-Za-z0-9_\\-])(?:sk|rk|pk|key|sk_live|sk_test|rk_live|rk_test|pk_live|pk_test|ghp|gho|ghs|ghu|github_pat|xox[abprs])[-_](?=[A-Za-z0-9_\\-]{0,256}[0-9])[A-Za-z0-9_\\-]{16,512}',
      '\\bAKIA[0-9A-Z]{16}\\b',
    ].join('|'),
    flags: 'g',
    check: null,
    mask: { kind: 'literal', text: REDACTED_TOKEN },
  },
  {
    id: 'urlSecret',
    description: 'The query and fragment of an `http(s)` URL (they can carry tokens); origin and path stay',
    shownAs: 'https://example.test/path (query removed)',
    source: '\\bhttps?:\\/\\/(?:(?!:\\/\\/)[^\\s?#"\'<>`]){1,2048}[?#][^\\s"\'<>`]{0,4096}[^\\s"\'<>`.,;:!?)\\]]',
    flags: 'gi',
    check: null,
    mask: { kind: 'url' },
  },
  {
    id: 'email',
    description: 'An email address',
    shownAs: `o${M}${M}${M}@example.test`,
    // Not an image name such as `icon@2x.png`.
    source: '(?<![\\w.%+\\-])[A-Za-z0-9][A-Za-z0-9._%+\\-]{0,63}@(?!\\d{1,2}x\\.)(?:[A-Za-z0-9\\-]{1,63}\\.){1,8}[A-Za-z]{2,24}(?![\\w\\-])',
    flags: 'g',
    check: null,
    mask: { kind: 'email' },
  },
  {
    id: 'iban',
    description: 'An IBAN: country code, two check digits, 11 to 30 letters and digits (grouped by four or not), passing the mod-97 check',
    shownAs: `GB${M}${M} ${M}${M}${M}${M} 3456`,
    source: '(?<![A-Za-z0-9])[A-Z]{2}\\d{2}(?:[A-Z0-9]{11,30}|(?: [A-Z0-9]{4}){2,7}(?: [A-Z0-9]{1,4})?)(?![A-Za-z0-9])',
    flags: 'g',
    check: 'mod97',
    mask: { kind: 'iban', prefix: `${M}${M} ${M}${M}${M}${M} ` },
  },
  {
    id: 'card',
    description: 'A payment card number: 13 to 19 digits, plain or in groups split by spaces or dashes, passing the Luhn check',
    shownAs: `${M}${M}${M}${M} 4242`,
    source: `${NUM_START}(?:\\d{13,19}|\\d{4}([ -])\\d{4}\\1\\d{4}\\1\\d{1,4}(?:\\1\\d{1,3})?|\\d{4}([ -])\\d{6}\\2\\d{4,5})${NUM_END}`,
    flags: 'g',
    check: 'luhn',
    mask: { kind: 'last4', prefix: `${M}${M}${M}${M} ` },
  },
  {
    id: 'ssn',
    description: 'A US Social Security number `ddd-dd-dddd`, and 9 digits after the words SSN or Social Security',
    shownAs: `${M}${M}${M}-${M}${M}-6789`,
    source: [
      `${NUM_START}(?!000|666|9\\d\\d)\\d{3}-(?!00)\\d{2}-(?!0000)\\d{4}${NUM_END}`,
      `${NUM_START}(?<=\\b(?:ssn|social security(?: number| no\\.?| #)?)[\\s:#.\\-]{1,4})\\d{9}${NUM_END}`,
    ].join('|'),
    flags: 'gi',
    check: null,
    mask: { kind: 'last4', prefix: `${M}${M}${M}-${M}${M}-` },
  },
  {
    id: 'routing',
    description: 'A US routing number: 9 digits passing the ABA checksum, after the words routing, ABA or RTN',
    shownAs: `${M}${M}${M}${M}${M}6789`,
    source: `${NUM_START}(?<=\\b(?:routing|aba|rtn)\\b${NEAR})\\d{9}${NUM_END}`,
    flags: 'gi',
    check: 'aba',
    mask: { kind: 'last4', prefix: `${M}${M}${M}${M}${M}` },
  },
  {
    id: 'account',
    description: 'An account number: 6 to 17 digits after the words account, acct, checking, savings or IBAN, or after a "#"',
    shownAs: `${M}${M}${M}${M}0659`,
    source: `${NUM_START}(?<=\\b(?:accounts?|acct|checking|savings|iban)\\b${NEAR}|(?<![\\w&])#[ \\t]?)\\d{6,17}${NUM_END}`,
    flags: 'gi',
    check: null,
    mask: { kind: 'last4', prefix: `${M}${M}${M}${M}` },
  },
  {
    id: 'phone',
    description: 'A phone number: US forms (`(555) 123-4567`, `555-123-4567`, `+1 555 123 4567`) and international forms with a leading `+`',
    shownAs: `${M}${M}${M}-${M}${M}${M}-6020`,
    source: [
      `(?<![\\w${M}+.\\-(]|\\d[.,])(?:\\+?1[ .\\-]?)?(?:\\(\\d{3}\\)[ ]?|\\d{3}[ .\\-])\\d{3}[ .\\-]\\d{4}${NUM_END}`,
      `(?<![\\w${M}+])\\+(?=(?:[ .\\-]?\\d){7,15}(?![ .\\-]?\\d))\\d{1,3}(?:[ .\\-]\\d{1,6}){1,6}${NUM_END}`,
    ].join('|'),
    flags: 'g',
    check: null,
    mask: { kind: 'last4', prefix: `${M}${M}${M}-${M}${M}${M}-` },
  },
  {
    id: 'digits',
    description: 'Any other run of 9 or more digits',
    shownAs: `${M}${M}${M}${M}1234`,
    source: `${NUM_START}\\d{9,256}${NUM_END}`,
    flags: 'g',
    check: null,
    mask: { kind: 'last4', prefix: `${M}${M}${M}${M}` },
  },
];

/** The pattern ids, in table order. */
const SENSITIVE_PATTERN_IDS = Object.freeze(PATTERN_SPECS.map((p) => p.id));

const SENSITIVE_PATTERNS = Object.freeze(
  PATTERN_SPECS.map((spec) => {
    const check = spec.check ? CHECKS[spec.check] : null;
    return Object.freeze({
      ...spec,
      mask: Object.freeze({ ...spec.mask }),
      /** A fresh global RegExp (a shared one would carry `lastIndex` between callers). */
      regex() {
        return new RegExp(spec.source, spec.flags);
      },
      /** Whether a regex match is sensitive (its checksum passes). */
      test(match) {
        return check ? check(match) : true;
      },
      /** How a sensitive match is shown. */
      replace(match) {
        return applyMask(spec.mask, match);
      },
    });
  }),
);

/**
 * `text` with one pattern applied: every match that passes the pattern's test
 * replaced by `replace(match)` (the pattern's own by default), and how many were.
 */
function applyPattern(pattern, text, replace) {
  const fn = replace || pattern.replace;
  let count = 0;
  const out = text.replace(pattern.regex(), (match) => {
    if (!pattern.test(match)) return match;
    const next = fn(match);
    if (next !== match) count++;
    return next;
  });
  return { text: out, count };
}

/** Zero hits for every pattern. */
function emptyHits() {
  const hits = {};
  for (const id of SENSITIVE_PATTERN_IDS) hits[id] = 0;
  return hits;
}

/**
 * `text` with every pattern applied in order, and the hits per pattern. The
 * API's `maskSensitive` (apps/api/src/tasks/mask.ts) is this plus its own
 * token and URL redaction; use that one on the server.
 */
function maskText(text) {
  const hits = emptyHits();
  let out = String(text);
  for (const p of SENSITIVE_PATTERNS) {
    const r = applyPattern(p, out);
    out = r.text;
    hits[p.id] += r.count;
  }
  return { text: out, hits };
}

exports.SENSITIVE_PATTERNS_VERSION = SENSITIVE_PATTERNS_VERSION;
exports.SENSITIVE_PATTERNS = SENSITIVE_PATTERNS;
exports.SENSITIVE_PATTERN_IDS = SENSITIVE_PATTERN_IDS;
exports.MASK_CHAR = MASK_CHAR;
exports.REDACTED_TOKEN = REDACTED_TOKEN;
exports.CONSOLE_TOKEN_PREFIXES = CONSOLE_TOKEN_PREFIXES;
exports.CHECKS = CHECKS;
exports.luhn = luhn;
exports.mod97 = mod97;
exports.aba = aba;
exports.applyMask = applyMask;
exports.applyPattern = applyPattern;
exports.emptyHits = emptyHits;
exports.maskText = maskText;
