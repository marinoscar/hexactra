/** The ids of the sensitive-text patterns, in the order they are applied (E35.3, #538). */
export type PatternId = 'token' | 'urlSecret' | 'email' | 'iban' | 'card' | 'ssn' | 'routing' | 'account' | 'phone' | 'digits';

/** A checksum a match must pass. */
export type PatternCheck = 'luhn' | 'mod97' | 'aba';

/** How a match is shown, as data (the extension implements the same kinds). */
export type PatternMask =
  | { readonly kind: 'last4'; readonly prefix: string }
  | { readonly kind: 'iban'; readonly prefix: string }
  | { readonly kind: 'email' }
  | { readonly kind: 'literal'; readonly text: string }
  | { readonly kind: 'url' };

export interface SensitivePattern {
  readonly id: PatternId;
  /** What matches, in words (the "What is masked" table of docs/runs.md). */
  readonly description: string;
  /** An example of the output. */
  readonly shownAs: string;
  /** The regex source and flags (always global). */
  readonly source: string;
  readonly flags: string;
  readonly check: PatternCheck | null;
  readonly mask: PatternMask;
  /** A fresh global RegExp. */
  regex(): RegExp;
  /** Whether a regex match is sensitive (its checksum passes). */
  test(match: string): boolean;
  /** How a sensitive match is shown. */
  replace(match: string): string;
}

export type PatternHits = Record<PatternId, number>;

/** Bumped when a pattern, its order, its check or its mask changes. */
export const SENSITIVE_PATTERNS_VERSION: number;
/** The pattern table, in the order it is applied (most specific first). */
export const SENSITIVE_PATTERNS: readonly SensitivePattern[];
export const SENSITIVE_PATTERN_IDS: readonly PatternId[];
/** `•` */
export const MASK_CHAR: string;
/** `[redacted token]` */
export const REDACTED_TOKEN: string;
/** The console's and the fabric's credential prefixes (equal to `CONSOLE_TOKEN_PREFIXES` of the API's mcp.redact.ts). */
export const CONSOLE_TOKEN_PREFIXES: readonly string[];
export const CHECKS: Readonly<Record<PatternCheck, (s: string) => boolean>>;
export function luhn(s: string): boolean;
export function mod97(s: string): boolean;
export function aba(s: string): boolean;
export function applyMask(mask: PatternMask, match: string): string;
/** `text` with one pattern applied (its own replace, or `replace`), and how many matches were replaced. */
export function applyPattern(pattern: SensitivePattern, text: string, replace?: (match: string) => string): { text: string; count: number };
export function emptyHits(): PatternHits;
/** Every pattern applied in order. On the server use `maskSensitive` (apps/api/src/tasks/mask.ts). */
export function maskText(text: string): { text: string; hits: PatternHits };
