// The Secret Material check of a memory (#551). A memory is data the agent may
// read, so it never holds a password, a code, a token or a full card, account,
// routing or Social Security number. The value patterns are the masking table
// of #538 (`@app/shared/sensitive-patterns`), so what the trace masks and what
// a memory refuses never disagree. Pure: no I/O.
import { SENSITIVE_PATTERNS, type PatternId, type SensitivePattern } from '@app/shared/sensitive-patterns';

/** Words that make an attribute name a secret, whatever its value. */
const SECRET_KEY = /(^|[^a-z])(pass(word|wd|code|phrase)?|pin|otp|one[ _-]?time|cvv2?|cvc2?|csc|security[ _-]?(answer|code|question)|token|secret|api[ _-]?key|private[ _-]?key|2fa|mfa|totp)([^a-z]|$)/i;

/** The value patterns that are refused (the others, email and phone, are ordinary facts). */
const REFUSED: readonly PatternId[] = ['token', 'iban', 'card', 'ssn', 'routing', 'account'];

/** A run of 12 or more digits that is not an international phone number is a full account number. */
const LONG_DIGITS = /(?<![\d+])\d(?:[ -]?\d){11,}(?!\d)/;

const PATTERNS: readonly SensitivePattern[] = SENSITIVE_PATTERNS.filter((p) => REFUSED.includes(p.id));

/** Why a value was refused, in the owner's words. */
const WHY: Record<string, string> = {
  key: 'looks like a password, code or other secret',
  token: 'looks like an access token or API key',
  iban: 'looks like a full IBAN',
  card: 'looks like a full card number',
  ssn: 'looks like a full Social Security number',
  routing: 'looks like a full routing number',
  account: 'looks like a full account number',
  digits: 'looks like a full account number',
};

export const MEMORY_SECRET_HINT = 'Memories never hold passwords, codes or full card, account or Social Security numbers. Keep only the last four digits, for example "ending 0659".';

export interface MemorySecretHit {
  /** The attribute name, or `label`, `note`, `aliases`. */
  field: string;
  /** Which rule matched: `key` (the attribute name), or a pattern id. */
  reason: string;
  message: string;
}

function matches(p: SensitivePattern, text: string): boolean {
  for (const m of text.matchAll(p.regex())) if (p.test(m[0])) return true;
  return false;
}

/** The first secret in a value, read with its attribute name in front so "account: 123456789012" is seen as an account number. */
function valueHit(field: string, value: string): MemorySecretHit | null {
  const text = `${field}: ${value}`;
  for (const p of PATTERNS) {
    if (matches(p, text)) return { field, reason: p.id, message: `"${field}" ${WHY[p.id]}. ${MEMORY_SECRET_HINT}` };
  }
  if (LONG_DIGITS.test(value)) return { field, reason: 'digits', message: `"${field}" ${WHY.digits}. ${MEMORY_SECRET_HINT}` };
  return null;
}

/** Every secret a memory's fields hold; empty when the memory may be stored. */
export function findMemorySecrets(input: { label?: string; aliases?: readonly string[]; note?: string | null; attributes?: Record<string, string> }): MemorySecretHit[] {
  const hits: MemorySecretHit[] = [];
  for (const [key, value] of Object.entries(input.attributes ?? {})) {
    if (SECRET_KEY.test(key)) {
      hits.push({ field: key, reason: 'key', message: `"${key}" ${WHY.key}. ${MEMORY_SECRET_HINT}` });
      continue;
    }
    const hit = valueHit(key, value);
    if (hit) hits.push(hit);
  }
  if (input.label) {
    const hit = valueHit('label', input.label);
    if (hit) hits.push(hit);
  }
  for (const alias of input.aliases ?? []) {
    const hit = valueHit('aliases', alias);
    if (hit) {
      hits.push(hit);
      break;
    }
  }
  if (input.note) {
    const hit = valueHit('note', input.note);
    if (hit) hits.push(hit);
  }
  return hits;
}
