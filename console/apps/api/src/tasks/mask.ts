// The one masking module for everything a run trace shows or exports (E35.3,
// #538): the trace view, the JSON export and the PDF report call it, and the
// extension's screenshot masking applies the same table (a generated copy,
// packages/contracts/sensitive-patterns.json). Pure: no I/O, no clock.
//
// What is sensitive and how it is shown is the pattern table of
// `@app/shared/sensitive-patterns` (docs/runs.md, "What is masked"). Here the
// console's own token redaction (`redactTokens`, mcp.redact.ts) and URL
// redaction (`redactUrl`, redact.ts) are applied in place of the table's
// equivalents, so the server keeps one implementation of each.
//
// Deterministic and idempotent: masking masked text changes nothing.
import { SENSITIVE_PATTERNS, applyPattern, emptyHits, type PatternHits, type PatternId } from '@app/shared/sensitive-patterns';

import { REDACTED_TOKEN, redactTokens } from '../mcp/mcp.redact';
import { redactUrl } from './redact';

export type { PatternHits, PatternId } from '@app/shared/sensitive-patterns';
export { SENSITIVE_PATTERNS_VERSION } from '@app/shared/sensitive-patterns';

/** What `maskSensitive` returns: the masked text and how many matches each pattern replaced. */
export interface MaskedText {
  text: string;
  hits: PatternHits;
}

/** What `maskValue` returns: the value in the same shape, and the hits summed over every string in it. */
export interface MaskedValue<T> {
  value: T;
  hits: PatternHits;
}

function countOf(text: string, needle: string): number {
  let n = 0;
  for (let i = text.indexOf(needle); i !== -1; i = text.indexOf(needle, i + needle.length)) n++;
  return n;
}

/** `text` with every sensitive pattern masked, in table order, and the hits per pattern. */
export function maskSensitive(text: string): MaskedText {
  const hits = emptyHits();
  let out = text;
  for (const p of SENSITIVE_PATTERNS) {
    if (p.id === 'token') {
      const before = countOf(out, REDACTED_TOKEN);
      out = redactTokens(out);
      hits.token += countOf(out, REDACTED_TOKEN) - before;
    }
    const r = applyPattern(p, out, p.id === 'urlSecret' ? redactUrl : undefined);
    out = r.text;
    hits[p.id] += r.count;
  }
  return { text: out, hits };
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  if (v === null || typeof v !== 'object') return false;
  const proto = Object.getPrototypeOf(v) as unknown;
  return proto === Object.prototype || proto === null;
}

/**
 * `value` with every string inside it masked: strings in arrays and plain
 * objects, at any depth. Keys, numbers, booleans, null and other objects (a
 * Date, a Buffer) are left as they are; the shape is kept.
 */
export function maskValue<T>(value: T): MaskedValue<T> {
  const hits = emptyHits();
  const add = (h: PatternHits) => {
    for (const id of Object.keys(h) as PatternId[]) hits[id] += h[id];
  };
  const seen = new WeakSet<object>();
  const walk = (v: unknown): unknown => {
    if (typeof v === 'string') {
      const r = maskSensitive(v);
      add(r.hits);
      return r.text;
    }
    if (Array.isArray(v) || isPlainObject(v)) {
      if (seen.has(v)) return '[circular]';
      seen.add(v);
      const out = Array.isArray(v) ? v.map(walk) : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
      seen.delete(v);
      return out;
    }
    return v;
  };
  return { value: walk(value) as T, hits };
}
