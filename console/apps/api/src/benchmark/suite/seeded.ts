// A small seeded generator for a challenge's data (E44, epic #738): names, prices, codes, picks. Deterministic in (seed, scope), with
// no dependency beyond `node:crypto`. Not for anything secret: these are fixture values a browser shows.
import { createHash } from 'node:crypto';

import type { Seed } from './types';

/** Letters and digits that are not mistaken for one another when read off a screen (no 0/O, 1/I/L). */
const CODE_ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';
const LETTERS = 'ABCDEFGHJKLMNPQRSTUVWXYZ';
/** Invented product words: no brand, no company. */
const ADJECTIVES = ['Amber', 'Brisk', 'Cobalt', 'Dusky', 'Ember', 'Fern', 'Granite', 'Hazel', 'Ivory', 'Juniper', 'Linen', 'Maple', 'Nimbus', 'Opal', 'Pebble', 'Quartz', 'Russet', 'Slate', 'Tidal', 'Umber'] as const;
const NOUNS = ['Lamp', 'Kettle', 'Notebook', 'Backpack', 'Chair', 'Mug', 'Blanket', 'Clock', 'Planter', 'Shelf', 'Tray', 'Basket', 'Bottle', 'Cushion', 'Desk', 'Frame', 'Stool', 'Towel', 'Vase', 'Whisk'] as const;

export interface Price {
  /** Whole cents, so sums are exact. */
  cents: number;
  /** `$1,234.50`: how a page shows it. */
  text: string;
}

export interface Seeded {
  /** A float in [0, 1). */
  next(): number;
  /** An integer in [min, max], both included. */
  int(min: number, max: number): number;
  /** One item of a non-empty list. */
  pick<T>(items: readonly T[]): T;
  /** A new array in a seeded order; the input is not changed. */
  shuffle<T>(items: readonly T[]): T[];
  /** `count` distinct items of the list (all of them, shuffled, when it is shorter). */
  sample<T>(items: readonly T[], count: number): T[];
  /** A fixture person: `Person QK`. Never a real name. */
  person(): string;
  /** A fixture address on the reserved test domain: `person.qk@mail.example.test`. */
  email(): string;
  /** An invented product: `Cobalt Kettle`. */
  product(): string;
  /** A price between two amounts in whole currency units (default 5 to 500), to the cent. */
  price(min?: number, max?: number): Price;
  /** A code of `length` characters (default 6) from an alphabet without look-alikes. */
  code(length?: number): string;
  /** An order-style reference: `ORD-48213`. */
  reference(prefix?: string): string;
  /** A calendar date `YYYY-MM-DD` within `days` days after `from` (default 2030-01-01, 365 days): fixed, never "today". */
  date(from?: string, days?: number): string;
  /** An independent generator for a named part of the state: adding a draw to one part never shifts another. */
  fork(scope: string): Seeded;
}

/** `$1,234.50` from whole cents. */
export function formatPrice(cents: number): string {
  const sign = cents < 0 ? '-' : '';
  const abs = Math.abs(Math.round(cents));
  const units = Math.floor(abs / 100).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign}$${units}.${(abs % 100).toString().padStart(2, '0')}`;
}

/** mulberry32: a 32-bit generator, plenty for fixture data. */
function mulberry32(a: number): () => number {
  let state = a >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * The generator of a seed. `scope` separates independent streams of one seed (`seeded(seed, 'orders')`); a challenge normally takes
 * one generator and forks it per part of its state.
 */
export function seeded(seed: Seed, scope = ''): Seeded {
  const next = mulberry32(createHash('sha256').update(`${seed}\u0000${scope}`).digest().readUInt32BE(0));
  const int = (min: number, max: number): number => {
    const lo = Math.ceil(Math.min(min, max));
    const hi = Math.floor(Math.max(min, max));
    return lo + Math.floor(next() * (hi - lo + 1));
  };
  const pick = <T>(items: readonly T[]): T => {
    if (items.length === 0) throw new Error('seeded.pick: empty list');
    return items[int(0, items.length - 1)]!;
  };
  const shuffle = <T>(items: readonly T[]): T[] => {
    const out = [...items];
    for (let i = out.length - 1; i > 0; i--) {
      const j = int(0, i);
      [out[i], out[j]] = [out[j]!, out[i]!];
    }
    return out;
  };
  const chars = (alphabet: string, length: number): string => Array.from({ length }, () => alphabet[int(0, alphabet.length - 1)]).join('');
  const initials = (): string => chars(LETTERS, 2);
  return {
    next,
    int,
    pick,
    shuffle,
    sample: (items, count) => shuffle(items).slice(0, Math.max(0, count)),
    person: () => `Person ${initials()}`,
    email: () => `person.${initials().toLowerCase()}@mail.example.test`,
    product: () => `${pick(ADJECTIVES)} ${pick(NOUNS)}`,
    price: (min = 5, max = 500) => {
      const cents = int(Math.round(min * 100), Math.round(max * 100));
      return { cents, text: formatPrice(cents) };
    },
    code: (length = 6) => chars(CODE_ALPHABET, length),
    reference: (prefix = 'ORD') => `${prefix}-${int(10_000, 99_999)}`,
    date: (from = '2030-01-01', days = 365) => new Date(Date.parse(`${from}T00:00:00Z`) + int(0, Math.max(0, days - 1)) * 86_400_000).toISOString().slice(0, 10),
    fork: (child) => seeded(seed, `${scope}/${child}`),
  };
}
