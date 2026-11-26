// Typed secrets never come back (E49.3, #960).
//
// The fabric types a secret (a handoff code, a password, a saved value) with a
// sensitive `type` / `type_keys`; the model never sees it. But a script the
// agent runs (`evaluate`), the page text or the element list could read it back
// from the field (a run did: it read the `.value` of every code box). This
// module remembers what was typed, in the service worker's memory only, for a
// short time, and replaces it with `[secret]` in those results before they
// leave the extension.
//
// - Whole occurrences in any string of the result.
// - A value read one box at a time (`[["txtCode1","5"],["txtCode2","8"],...]`):
//   short strings that are each a piece of a remembered value and, in order,
//   spell it out, are each replaced.
//
// Residual risk: a script can still transform the value (reverse it, sum the
// digits) before returning it. The agent is told never to read a typed field
// back (E49.2); a complete fix would cut `evaluate` off from typed fields,
// against the owner's full powers (VISION §27).

export const SECRET_MARK = '[secret]';
/** How long a typed value is remembered. */
export const REMEMBER_MS = 10 * 60_000;
/** At most this many values are remembered; the oldest goes first. */
export const REMEMBER_MAX = 20;
/** Shorter values are not remembered: a 1–3 character match would mark ordinary text. */
export const MIN_LENGTH = 4;
/** A piece of a value read box by box is at most this long (a code box holds 1–4 characters). */
const PIECE_MAX = 4;

let typed: { value: string; at: number }[] = [];

function live(now: number): string[] {
  typed = typed.filter((t) => now - t.at < REMEMBER_MS);
  return typed.map((t) => t.value);
}

/** Remember a value the fabric typed as Secret Material. */
export function rememberTyped(value: string, now = Date.now()): void {
  const v = value.trim();
  if (v.length < MIN_LENGTH) return;
  typed = typed.filter((t) => t.value !== v);
  typed.push({ value: v, at: now });
  if (typed.length > REMEMBER_MAX) typed = typed.slice(-REMEMBER_MAX);
}

/** Forget everything (tests). */
export function forgetTyped(): void {
  typed = [];
}

/** Whether anything is remembered now. */
export function hasTyped(now = Date.now()): boolean {
  return live(now).length > 0;
}

function scrubString(s: string, values: string[]): string {
  let out = s;
  for (const v of values) if (out.includes(v)) out = out.split(v).join(SECRET_MARK);
  return out;
}

/** Replace every remembered value in a JSON-like result. Returns the result unchanged when nothing is remembered. */
export function scrubTyped<T>(result: T, now = Date.now()): T {
  const values = live(now).sort((a, b) => b.length - a.length);
  if (values.length === 0) return result;
  // Whole occurrences, in every string.
  const leaves: { holder: Record<string | number, unknown>; key: string | number; value: string }[] = [];
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') return scrubString(v, values);
    if (Array.isArray(v)) {
      const arr = v.map(walk);
      arr.forEach((x, i) => typeof x === 'string' && leaves.push({ holder: arr as unknown as Record<number, unknown>, key: i, value: x }));
      return arr;
    }
    if (v && typeof v === 'object') {
      const obj: Record<string, unknown> = {};
      for (const [k, x] of Object.entries(v)) {
        obj[k] = walk(x);
        if (typeof obj[k] === 'string') leaves.push({ holder: obj, key: k, value: obj[k] as string });
      }
      return obj;
    }
    return v;
  };
  const out = walk(result) as T;
  // A value read piece by piece: the short strings that are pieces of it, in the order they were read.
  // Leaves are collected bottom-up per container; sort them into document order by a second, ordered walk.
  const ordered: typeof leaves = [];
  const seen = new Set(leaves);
  const byHolder = new Map<unknown, typeof leaves>();
  for (const l of leaves) byHolder.set(l.holder, [...(byHolder.get(l.holder) ?? []), l]);
  const order = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    const own = byHolder.get(v) ?? [];
    for (const [k, x] of Object.entries(v)) {
      const leaf = own.find((l) => String(l.key) === k);
      if (leaf && seen.has(leaf)) ordered.push(leaf);
      else order(x);
    }
  };
  order(out);
  for (const v of values) {
    const pieces = ordered.filter((l) => l.value.length > 0 && l.value.length <= PIECE_MAX && v.includes(l.value));
    let joined = '';
    const spans: { leaf: (typeof leaves)[number]; from: number; to: number }[] = [];
    for (const leaf of pieces) {
      spans.push({ leaf, from: joined.length, to: joined.length + leaf.value.length });
      joined += leaf.value;
    }
    for (let at = joined.indexOf(v); at >= 0; at = joined.indexOf(v, at + v.length)) {
      for (const s of spans) if (s.from < at + v.length && s.to > at) s.leaf.holder[s.leaf.key] = SECRET_MARK;
    }
  }
  if (typeof out === 'string') return scrubString(out, values) as T;
  return out;
}
