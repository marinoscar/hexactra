// The neutral trace of a run (E46.5): one `TraceEvent` per tool call, with each argument's PROVENANCE instead of its value. A compiler reads
// these, never step rows (which are redacted and say nothing about where a value came from). `bindArguments` is pure and deterministic.
//
// What a trace never holds: typed text, a secret, a handoff value, a token, page text, a screenshot or the model's reasoning. A value is
// kept only as a `literal`, and only when it is structural (a URL, a selector, a short enum-like token) or the owner's own words (it appears
// in the task's goal), AND it passes the sensitive-value check.
import { defaultIsSensitive, type SensitivePredicate } from '../validate/sensitive';

/** Where one argument's value came from. */
export type TraceBinding =
  | { kind: 'literal'; value: string | number | boolean | null }
  /** The value equals a task parameter's value: the key is stored, never the value. */
  | { kind: 'parameter'; parameter: string }
  /** The value is in an earlier call's result: a field `path` of a JSON result, or a `pattern` (the value's shape, never the value). */
  | { kind: 'output'; seq: number; path?: string; pattern?: string }
  /** Nothing explains it: the model produced it. The compiler turns it into a judge step or leaves the step to the agent. */
  | { kind: 'model' }
  /** It looks like secret material and is not a parameter: nothing of it is stored. */
  | { kind: 'withheld' };

/** What a call left behind, for the checks a compiler writes. Never typed text or page text. */
export interface PostState {
  /** Browser calls: `host` and `path` of the page (no query string, no fragment). */
  host?: string;
  path?: string;
  /** The page view digest the stall detector computed (a hash of structure, not text). */
  viewDigest?: string;
  /** Click and type: the target's role and accessible label, when the host knows them. */
  target?: { role?: string; label?: string };
  /** Account and MCP calls: a digest of the result's shape (keys and types, not values). */
  resultShape?: string;
}

/** One tool call of a run, as a compiler reads it. */
export interface TraceEvent {
  seq: number;
  tool: string;
  family: string;
  commits: boolean;
  ok: boolean;
  outcome: 'ran' | 'refused' | 'asked';
  /** One binding per argument, flattened with dotted keys for nested objects (`a.b`, `items.0`). */
  bindings: Record<string, TraceBinding>;
  post: PostState;
}

/** A task parameter as the run filled it. `sensitive` ones are always a parameter binding when they match, never a value. */
export interface TraceParameter {
  key: string;
  value: unknown;
  sensitive: boolean;
}

/** An earlier call's result, in memory only while the run lasts (never stored). */
export interface EarlierResult {
  seq: number;
  text: string;
}

export interface BindContext {
  /** The task's goal: the owner's words. */
  goal: string;
  parameters: readonly TraceParameter[];
  /** Earlier calls of the same run, oldest first. */
  earlier: readonly EarlierResult[];
  isSensitive?: SensitivePredicate;
}

/** Argument names whose values are structural (they say where to act, not what to type). */
const STRUCTURAL_ARGS = /^(url|href|selector|mark|ref|role|key|keys|button|direction|tab|tabId|frame|wait|waitFor|timeoutMs|x|y|deltaX|deltaY|index|count|limit|max|maxResults|folder|label|fields|format|mode|kind|type|scope|range|sheet|sheetName|calendarId|connection|connectionId|tool|attach|fullPage|mask|submit|clear|newTab|query\.fields|order|orderBy|sort)$/i;

/** Argument names whose values are typed or sent as content: never kept as a literal unless they are the goal's own words. */
const TEXT_ARGS = /^(text|value|content|body|message|subject|q|query|note|comment|answer|reply|html|markdown|code|otp|password|secret|search|term|title|name|description|prompt)$/i;

const isUrl = (v: string) => /^https?:\/\/[^\s]{1,2000}$/i.test(v);
const isSelectorish = (v: string) => v.length <= 300 && /^[#.[\]a-zA-Z0-9_:="'(),>+~\s*-]+$/.test(v) && /[#.[\]=>]/.test(v);
const isEnumish = (v: string) => /^[a-z][a-z0-9_-]{0,31}$/.test(v);

/** Flatten an argument object to leaf values with dotted keys (depth ≤ 4, ≤ 100 leaves). */
export function flattenArgs(args: unknown, prefix = '', out: Record<string, unknown> = {}, depth = 0): Record<string, unknown> {
  if (Object.keys(out).length >= 100) return out;
  if (args !== null && typeof args === 'object' && depth < 4) {
    for (const [k, v] of Array.isArray(args) ? args.map((x, i) => [String(i), x] as const) : Object.entries(args as Record<string, unknown>)) flattenArgs(v, prefix ? `${prefix}.${k}` : k, out, depth + 1);
    return out;
  }
  if (prefix) out[prefix] = args;
  return out;
}

/** A regex of the value's shape: letters, digits and separators as classes, never the characters themselves. Bounded. */
export function shapeOf(value: string): string {
  const parts: string[] = [];
  let prev = '';
  let n = 0;
  const flush = () => {
    if (prev) parts.push(n === 1 ? prev : `${prev}{${n}}`);
  };
  for (const ch of value.slice(0, 64)) {
    const cls = /[0-9]/.test(ch) ? '\\d' : /[A-Z]/.test(ch) ? '[A-Z]' : /[a-z]/.test(ch) ? '[a-z]' : /\s/.test(ch) ? '\\s' : /[-_./:#@]/.test(ch) ? `\\${ch}` : '.';
    if (cls === prev) n++;
    else {
      flush();
      prev = cls;
      n = 1;
    }
  }
  flush();
  return parts.join('');
}

/** The dotted path of the first field of `json` whose value equals `value`, or null. */
function pathTo(json: unknown, value: unknown, prefix = '', depth = 0): string | null {
  if (depth > 6) return null;
  if (json !== null && typeof json === 'object') {
    for (const [k, v] of Array.isArray(json) ? json.map((x, i) => [String(i), x] as const) : Object.entries(json as Record<string, unknown>)) {
      const p = prefix ? `${prefix}.${k}` : k;
      if (v === value || (typeof v === 'number' && String(v) === value)) return p;
      const deeper = pathTo(v, value, p, depth + 1);
      if (deeper) return deeper;
    }
  }
  return null;
}

function parseJson(text: string): unknown {
  const t = text.trim();
  if (!(t.startsWith('{') || t.startsWith('['))) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

const sameValue = (a: unknown, b: unknown) => a === b || (a !== null && b !== null && a !== undefined && b !== undefined && typeof a !== 'object' && typeof b !== 'object' && String(a).trim() === String(b).trim() && String(a).trim() !== '');

/** One argument's binding. */
export function bindValue(name: string, value: unknown, ctx: BindContext): TraceBinding {
  const isSensitive = ctx.isSensitive ?? defaultIsSensitive;
  // 1. A task parameter (a sensitive one included: only its key is kept).
  const param = ctx.parameters.find((p) => sameValue(p.value, value));
  if (param) return { kind: 'parameter', parameter: param.key };
  if (value === null || typeof value === 'boolean') return { kind: 'literal', value };
  if (typeof value !== 'string' && typeof value !== 'number') return { kind: 'model' };
  const text = String(value);
  // 2. Secret material that is not a parameter: nothing of it is kept.
  if (isSensitive(text)) return { kind: 'withheld' };
  // 3. An earlier result, newest first (exact field of a JSON result, else a substring of its text, kept as its shape).
  if (text.trim().length >= 3) {
    for (const e of [...ctx.earlier].reverse()) {
      const json = parseJson(e.text);
      const path = json === undefined ? null : pathTo(json, value);
      if (path) return { kind: 'output', seq: e.seq, path };
      if (e.text.includes(text)) return { kind: 'output', seq: e.seq, pattern: shapeOf(text) };
    }
  }
  // 4. Structural, or the owner's own words. What is typed (a text argument) is never structural: only the goal's words are kept of it.
  const typed = TEXT_ARGS.test(name);
  if (typeof value === 'number') return !typed && STRUCTURAL_ARGS.test(name) ? { kind: 'literal', value } : { kind: 'model' };
  const structural = !typed && (STRUCTURAL_ARGS.test(name) || isUrl(text) || isSelectorish(text) || isEnumish(text));
  const inGoal = text.trim().length >= 2 && ctx.goal.toLowerCase().includes(text.trim().toLowerCase());
  if (structural || inGoal) return { kind: 'literal', value: text };
  // 5. The model produced it.
  return { kind: 'model' };
}

/** Every argument's binding (dotted keys for nested objects). Never holds a value that is not a safe literal. */
export function bindArguments(args: unknown, ctx: BindContext): Record<string, TraceBinding> {
  const out: Record<string, TraceBinding> = {};
  for (const [name, value] of Object.entries(flattenArgs(args))) out[name] = bindValue(name.split('.').pop() ?? name, value, ctx);
  return out;
}

/** The shape of a JSON result: keys and value types, sorted, never values. `text` when it is not JSON. */
export function resultShapeOf(text: string): string {
  const json = parseJson(text);
  if (json === undefined) return 'text';
  const shape = (v: unknown, depth: number): string => {
    if (Array.isArray(v)) return depth > 3 ? '[]' : `[${v.length ? shape(v[0], depth + 1) : ''}]`;
    if (v !== null && typeof v === 'object') {
      if (depth > 3) return '{}';
      return `{${Object.keys(v as object).sort().slice(0, 50).map((k) => `${k}:${shape((v as Record<string, unknown>)[k], depth + 1)}`).join(',')}}`;
    }
    return v === null ? 'null' : typeof v;
  };
  return shape(json, 0).slice(0, 2000);
}

/** Host and path of a URL, without the query string or fragment; null when it is not a URL. */
export function hostAndPath(url: string | null | undefined): { host: string; path: string } | null {
  if (!url) return null;
  try {
    const u = new URL(url);
    if (u.protocol !== 'http:' && u.protocol !== 'https:') return null;
    return { host: u.hostname.toLowerCase(), path: u.pathname };
  } catch {
    return null;
  }
}
