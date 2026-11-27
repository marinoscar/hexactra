// The Secret Material check of a skill (#1008): the same value patterns a memory refuses (`@app/shared/sensitive-patterns`, the masking
// table of #538), read over free text, plus a secret written as `password: …` or `api_key = …`. A skill is guidance the agent reads, so it
// never holds a password, a code, a token or a full card, account, IBAN, routing or Social Security number. Pure: no I/O.
import { SENSITIVE_PATTERNS, type PatternId, type SensitivePattern } from '@app/shared/sensitive-patterns';

/** A secret written as a named value: the word, then `:` or `=`, then something. */
const SECRET_PAIR = /(^|[^\p{L}])(pass(word|wd|code|phrase)?|pin|otp|one[ _-]?time[ _-]?(code|password)|cvv2?|cvc2?|csc|security[ _-]?(answer|code)|token|secret|api[ _-]?key|private[ _-]?key|2fa|mfa|totp)\s*[:=]\s*\S/iu;

const REFUSED: readonly PatternId[] = ['token', 'iban', 'card', 'ssn', 'routing', 'account'];
/** A run of 12 or more digits that is not an international phone number is a full account number. */
const LONG_DIGITS = /(?<![\d+])\d(?:[ -]?\d){11,}(?!\d)/;
const PATTERNS: readonly SensitivePattern[] = SENSITIVE_PATTERNS.filter((p) => REFUSED.includes(p.id));

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

export const SKILL_SECRET_HINT = 'Skills never hold passwords, codes, tokens or full card, account or Social Security numbers: the agent asks you for those, or signs in with a saved login.';

export const SKILL_FIELD_LABEL: Record<string, string> = { name: 'The name', description: 'When to use it', body: 'The text' };

export interface SkillSecretHit {
  field: 'name' | 'description' | 'body';
  reason: string;
  message: string;
}

function matches(p: SensitivePattern, text: string): boolean {
  for (const m of text.matchAll(p.regex())) if (p.test(m[0])) return true;
  return false;
}

function hitIn(field: SkillSecretHit['field'], text: string): SkillSecretHit | null {
  const why = (reason: string): SkillSecretHit => ({ field, reason, message: `${SKILL_FIELD_LABEL[field]} ${WHY[reason]}. ${SKILL_SECRET_HINT}` });
  if (SECRET_PAIR.test(text)) return why('key');
  for (const p of PATTERNS) if (matches(p, text)) return why(p.id);
  if (LONG_DIGITS.test(text)) return why('digits');
  return null;
}

/** Every field of a skill that holds a secret; empty when it may be stored. */
export function findSkillSecrets(input: { name?: string; description?: string; body?: string }): SkillSecretHit[] {
  const hits: SkillSecretHit[] = [];
  for (const field of ['name', 'description', 'body'] as const) {
    const v = input[field];
    if (!v) continue;
    const hit = hitIn(field, v);
    if (hit) hits.push(hit);
  }
  return hits;
}
