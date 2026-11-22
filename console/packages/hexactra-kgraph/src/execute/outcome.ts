// Outcome checks (E46.11): step checks prove the path was followed, not that the answer is right. For a task with declared outputs, every
// required output is present, of its type and within its options, and plausible against the SHAPE of earlier verified results. A shape holds
// statistics only — an order of magnitude, a year, a character class and a length band — never a value, and none at all for a sensitive output.

export type OutputType = 'text' | 'number' | 'money' | 'date' | 'datetime' | 'boolean' | 'url' | 'choice';

export interface DeclaredOutput {
  key: string;
  type: OutputType;
  required: boolean;
  options?: readonly string[];
  sensitive?: boolean;
}

/** What earlier verified results looked like. No value. */
export type OutputShape =
  | { kind: 'number'; minMagnitude: number; maxMagnitude: number; samples: number }
  | { kind: 'date'; minYear: number; samples: number }
  | { kind: 'string'; charClass: CharClass; minLength: number; maxLength: number; samples: number };

export type CharClass = 'digits' | 'letters' | 'alnum' | 'mixed';

const num = (v: unknown): number | null => {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v !== 'string') return null;
  const n = Number(v.replace(/[\s,$€£¥]/g, ''));
  return Number.isFinite(n) ? n : null;
};
const magnitude = (n: number) => (n === 0 ? 0 : Math.floor(Math.log10(Math.abs(n))));
export const charClassOf = (s: string): CharClass => (/^\d+$/.test(s) ? 'digits' : /^[A-Za-z\s]+$/.test(s) ? 'letters' : /^[A-Za-z0-9\s]+$/.test(s) ? 'alnum' : 'mixed');
const yearOf = (v: unknown): number | null => {
  const t = typeof v === 'string' || typeof v === 'number' ? Date.parse(String(v)) : NaN;
  return Number.isFinite(t) ? new Date(t).getUTCFullYear() : null;
};
const blank = (v: unknown) => v === undefined || v === null || (typeof v === 'string' && v.trim() === '');

/** The type and options check of one value. Null: fine. */
export function typeProblem(o: DeclaredOutput, v: unknown): string | null {
  switch (o.type) {
    case 'number':
    case 'money':
      return num(v) === null ? 'is not a number' : null;
    case 'date':
    case 'datetime':
      return yearOf(v) === null ? 'is not a date' : null;
    case 'boolean':
      return typeof v === 'boolean' || v === 'true' || v === 'false' ? null : 'is not yes or no';
    case 'url':
      try {
        const u = new URL(String(v));
        return u.protocol === 'http:' || u.protocol === 'https:' ? null : 'is not a web address';
      } catch {
        return 'is not a web address';
      }
    case 'choice':
      return o.options?.length && !o.options.includes(String(v)) ? 'is not one of its options' : null;
    default:
      return typeof v === 'string' || typeof v === 'number' ? null : 'is not text';
  }
}

/** Fold one verified value into a shape. A sensitive output has no shape. */
export function learnShape(o: DeclaredOutput, prev: OutputShape | undefined, v: unknown): OutputShape | undefined {
  if (o.sensitive || blank(v)) return prev;
  if (o.type === 'number' || o.type === 'money') {
    const n = num(v);
    if (n === null) return prev;
    const m = magnitude(n);
    return prev?.kind === 'number' ? { kind: 'number', minMagnitude: Math.min(prev.minMagnitude, m), maxMagnitude: Math.max(prev.maxMagnitude, m), samples: prev.samples + 1 } : { kind: 'number', minMagnitude: m, maxMagnitude: m, samples: 1 };
  }
  if (o.type === 'date' || o.type === 'datetime') {
    const y = yearOf(v);
    if (y === null) return prev;
    return prev?.kind === 'date' ? { kind: 'date', minYear: Math.min(prev.minYear, y), samples: prev.samples + 1 } : { kind: 'date', minYear: y, samples: 1 };
  }
  if (o.type === 'boolean' || o.type === 'choice') return prev;
  const s = String(v);
  const c = charClassOf(s);
  if (prev?.kind === 'string') return { kind: 'string', charClass: prev.charClass === c ? c : 'mixed', minLength: Math.min(prev.minLength, s.length), maxLength: Math.max(prev.maxLength, s.length), samples: prev.samples + 1 };
  return { kind: 'string', charClass: c, minLength: s.length, maxLength: s.length, samples: 1 };
}

/** Whether a value fits an earlier shape (an order of magnitude either side; not before the earliest year minus one; the same class, a length within 3×). */
export function shapeProblem(shape: OutputShape | undefined, v: unknown): string | null {
  if (!shape) return null;
  if (shape.kind === 'number') {
    const n = num(v);
    if (n === null) return 'is not a number';
    const m = magnitude(n);
    return m < shape.minMagnitude - 1 || m > shape.maxMagnitude + 1 ? 'is far from earlier values' : null;
  }
  if (shape.kind === 'date') {
    const y = yearOf(v);
    return y === null ? 'is not a date' : y < shape.minYear - 1 ? 'is far in the past' : null;
  }
  const s = String(v);
  if (shape.charClass !== 'mixed' && charClassOf(s) !== shape.charClass && charClassOf(s) !== 'mixed') return 'looks unlike earlier values';
  return s.length > shape.maxLength * 3 + 3 || s.length * 3 + 3 < shape.minLength ? 'is unlike earlier values in length' : null;
}

export interface OutcomeVerdict {
  ok: boolean;
  /** Which output and why: keys and reasons only, never a value. */
  problems: string[];
}

/** The outcome check of a finished replay. */
export function checkOutcome(declared: readonly DeclaredOutput[], outputs: Readonly<Record<string, unknown>>, shapes: Readonly<Record<string, OutputShape>> = {}): OutcomeVerdict {
  const problems: string[] = [];
  for (const o of declared) {
    const v = outputs[o.key];
    if (blank(v)) {
      if (o.required) problems.push(`${o.key} is missing`);
      continue;
    }
    const t = typeProblem(o, v);
    if (t) {
      problems.push(`${o.key} ${t}`);
      continue;
    }
    const s = o.sensitive ? null : shapeProblem(shapes[o.key], v);
    if (s) problems.push(`${o.key} ${s}`);
  }
  return { ok: problems.length === 0, problems };
}

/** Whether a run is an audit run: every Nth run of a task (N = `auditEvery`; 0 never). Chosen by the server from the task's run count. */
export function isAuditRun(runNumber: number, auditEvery: number): boolean {
  return auditEvery > 0 && runNumber > 0 && runNumber % auditEvery === 0;
}
