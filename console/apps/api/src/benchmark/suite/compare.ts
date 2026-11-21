// How a grader compares what the agent reported with the seeded answer (E44.2, #740). The agent's final answer is free text ("The
// order is Shipped."), so a reported value passes when the answer names the expected value and names none of the other candidates the
// site showed: listing every status, or every price, is not an answer. Comparison ignores case, spacing and currency format.
import type { Check } from './types';

/** Case, Unicode form and spacing removed: `  Out  for\nDelivery ` and `out for delivery` are the same text. */
export function normalise(text: string): string {
  return text.normalize('NFKC').toLowerCase().replace(/\s+/g, ' ').trim();
}

/** Two values a person would call the same. */
export const sameText = (a: string, b: string): boolean => normalise(a) === normalise(b);

/** Whether `text` names `value` as a whole word or phrase (`shipped` is not named by `unshipped`). */
export function mentions(text: string, value: string): boolean {
  const needle = normalise(value);
  if (!needle) return false;
  const escaped = needle.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`(?<![a-z0-9])${escaped}(?![a-z0-9])`).test(normalise(text));
}

/** Every number in a text, in whole cents: `$1,234.50`, `1234.5` and `USD 1,234.50` are all 123450. */
export function amountsIn(text: string): number[] {
  const out: number[] = [];
  for (const m of text.normalize('NFKC').matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const value = Number(m[0].replace(/,/g, ''));
    if (Number.isFinite(value)) out.push(Math.round(value * 100));
  }
  return out;
}

const shown = (result: string): string => (result.trim() ? 'the answer does not name it alone' : 'no answer was given');

/** The answer names `expected` and none of `decoys` (the other values of the same kind the site showed). */
export function reportedValue(name: string, result: string, expected: string, decoys: readonly string[] = []): Check {
  const named = mentions(result, expected);
  const wrong = decoys.filter((d) => !sameText(d, expected) && !mentions(expected, d) && mentions(result, d));
  const pass = named && wrong.length === 0;
  return { name, pass, detail: pass ? `reported ${expected}` : `expected ${expected}; ${wrong.length ? `the answer also names ${wrong[0]}` : shown(result)}` };
}

/** The answer names the amount `expectedCents` (in any currency format) and none of `decoyCents`. */
export function reportedAmount(name: string, result: string, expectedCents: number, decoyCents: readonly number[] = [], format: (cents: number) => string = String): Check {
  const amounts = new Set(amountsIn(result));
  const wrong = decoyCents.filter((d) => d !== expectedCents && amounts.has(d));
  const pass = amounts.has(expectedCents) && wrong.length === 0;
  const expected = format(expectedCents);
  return { name, pass, detail: pass ? `reported ${expected}` : `expected ${expected}; ${wrong.length ? `the answer also names ${format(wrong[0]!)}` : shown(result)}` };
}

/** A stored field equals the expected text (case and spacing ignored). */
export function storedField(name: string, stored: unknown, expected: string): Check {
  const pass = typeof stored === 'string' && sameText(stored, expected);
  return { name, pass, detail: pass ? `stored ${expected}` : `expected ${expected}; stored ${typeof stored === 'string' && stored ? stored.slice(0, 80) : 'nothing'}` };
}
