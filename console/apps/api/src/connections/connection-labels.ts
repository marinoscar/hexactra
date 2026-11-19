// Labels (E39.2, #599): what the owner calls an account. Unique per owner, ignoring case ("Work" and "work" are one name), so a
// label can resolve an account without guessing. The database holds the exact-case unique index; this is the rule above it.
import { MAX_LABEL_LENGTH } from './connections.constants';

/** A label for an account the owner did not name: `Google (person.a@example.test)`, shortened to fit. */
export function defaultLabel(provider: string, email: string): string {
  const name = provider === 'google' ? 'Google' : provider === 'microsoft' ? 'Microsoft' : 'Account';
  const base = `${name} (${email})`;
  return base.length <= MAX_LABEL_LENGTH ? base : `${name} (${email.slice(0, MAX_LABEL_LENGTH - name.length - 6)}…)`;
}

/** `wanted`, or `wanted 2`, `wanted 3`, … the first not in `taken` (compared ignoring case), kept within the length limit. */
export function uniqueLabel(wanted: string, taken: readonly string[]): string {
  const used = new Set(taken.map((l) => l.toLowerCase()));
  if (!used.has(wanted.toLowerCase())) return wanted;
  for (let n = 2; n < 1000; n++) {
    const suffix = ` ${n}`;
    const candidate = `${wanted.slice(0, MAX_LABEL_LENGTH - suffix.length)}${suffix}`;
    if (!used.has(candidate.toLowerCase())) return candidate;
  }
  return `${wanted.slice(0, MAX_LABEL_LENGTH - 5)} ${Date.now() % 10000}`;
}
