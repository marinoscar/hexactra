// Amounts of a card payment (E37.7): pure helpers, no I/O.

/** A decimal amount with at most two places, greater than zero and at most 10,000,000.00: `"42.50"`, `"7"`. */
export function isAmount(v: string): boolean {
  return /^\d{1,8}(\.\d{1,2})?$/.test(v) && cents(v) > 0 && cents(v) <= 1_000_000_000;
}

/** An amount in hundredths. `NaN` for something that is not an amount. */
export function cents(v: string): number {
  const m = /^(\d{1,8})(?:\.(\d{1,2}))?$/.exec(v.trim());
  if (!m) return Number.NaN;
  return Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0');
}

/** `4250` → `"42.50"`. */
export function amountOfCents(c: number): string {
  const n = Math.round(c);
  return `${Math.floor(n / 100)}.${String(n % 100).padStart(2, '0')}`;
}

/** The amount as a decimal with two places (`"7"` → `"7.00"`), or null when it is not an amount. */
export function normaliseAmount(v: string | number): string | null {
  const s = typeof v === 'number' ? (Number.isFinite(v) ? v.toFixed(2) : '') : v.trim().replace(/,/g, '');
  const m = /^\$?(\d{1,8})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  const out = amountOfCents(Number(m[1]) * 100 + Number((m[2] ?? '').padEnd(2, '0') || '0'));
  return isAmount(out) ? out : null;
}

/** The currency as three upper-case letters, or null. */
export function normaliseCurrency(v: string): string | null {
  const c = v.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(c) ? c : null;
}

/**
 * Whether the amount on the confirmation page is the declared one, within a small tolerance: one cent, or one percent of the
 * declared amount, whichever is larger (a rounding of a tax, not a different price).
 */
export function amountsAgree(declared: string, confirmed: string): boolean {
  const d = cents(declared);
  const c = cents(confirmed);
  if (!Number.isFinite(d) || !Number.isFinite(c)) return false;
  return Math.abs(d - c) <= Math.max(1, Math.round(d * 0.01));
}

