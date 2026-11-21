// Small helpers the challenges share (E44.2, #740).
import type { Seeded } from '../seeded';
import type { Json, SiteState } from '../types';

/** `count` different values from a generator (a seeded name or code can repeat; a list a person searches must not). */
export function distinct<T>(draw: () => T, count: number, key: (value: T) => string | number = (v) => String(v)): T[] {
  const seen = new Set<string | number>();
  const out: T[] = [];
  for (let tries = 0; out.length < count && tries < count * 200; tries++) {
    const value = draw();
    const k = key(value);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(value);
  }
  if (out.length < count) throw new Error(`distinct: only ${out.length} of ${count} different values`);
  return out;
}

/** An item of a list other than `not`. */
export function pickOther<T>(g: Seeded, items: readonly T[], not: T): T {
  return g.pick(items.filter((i) => i !== not));
}

/** A state's value as a plain object, or an empty one. */
export function record(state: SiteState, key: string): { [key: string]: Json } {
  const v = state[key];
  return v !== null && typeof v === 'object' && !Array.isArray(v) ? v : {};
}

/** A date as a person writes it in a goal: `14 March 2030` from `2030-03-14`. */
export const MONTHS = ['January', 'February', 'March', 'April', 'May', 'June', 'July', 'August', 'September', 'October', 'November', 'December'] as const;
export function longDate(iso: string): string {
  const [y, m, d] = iso.split('-').map(Number) as [number, number, number];
  return `${d} ${MONTHS[m - 1]} ${y}`;
}

/** Invented place names: no real town. */
export const TOWNS = ['Fernvale', 'Marlow Reach', 'Quillhaven', 'Ostbrook', 'Tindle Cross', 'Varrowby', 'Lindmere', 'Eskerton', 'Pellham Wick', 'Corrin Bay'] as const;
export const STREETS = ['Maple Road', 'Juniper Lane', 'Slate Street', 'Ember Close', 'Tidal Way', 'Granite Row', 'Hazel Court', 'Linen Walk'] as const;

/** A state's counter, or 0. */
export const counter = (state: SiteState, key: string): number => (typeof state[key] === 'number' ? (state[key] as number) : 0);

/** A state's value as a list, or an empty one. */
export function list(state: SiteState, key: string): Json[] {
  const v = state[key];
  return Array.isArray(v) ? v : [];
}

/** At most this many entries of a list a page appends to: a state stays small however often the agent clicks. */
export const MAX_ENTRIES = 30;
export const appended = (items: readonly Json[], item: Json): Json[] => [...items, item].slice(-MAX_ENTRIES);

/** A posted integer within bounds, or null. */
export function intField(body: Readonly<Record<string, Json>>, name: string, min: number, max: number): number | null {
  const v = body[name];
  const n = typeof v === 'number' ? v : typeof v === 'string' && /^-?\d{1,9}$/.test(v.trim()) ? Number(v.trim()) : NaN;
  return Number.isInteger(n) && n >= min && n <= max ? n : null;
}

/** A JSON value as a plain object, or an empty one. */
export const asRecord = (v: Json | undefined): { [key: string]: Json } => (v !== null && v !== undefined && typeof v === 'object' && !Array.isArray(v) ? v : {});
