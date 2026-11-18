// MCP elicitation for a run's question (#463), on protocol 2026-07-28 only:
// the multi round-trip pattern (`resultType: "input_required"`, retried with
// `inputResponses` and `requestState`), specification
// docs/specification/2026-07-28/basic/patterns/mrtr and client/elicitation.
// Pure functions: the form schema of a typed question, the answer a form
// result stands for, and the sealed `requestState`.
import { createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

import { answerableHere, type ProgressQuestion } from './run-progress';

/** The one key of `inputRequests` / `inputResponses` a tool uses. */
export const ELICIT_KEY = 'hexactra_question';
/** The one field of the form. */
export const ELICIT_FIELD = 'answer';
/** How long a `requestState` is honoured (the person needs time to answer the form). */
export const REQUEST_STATE_TTL_MS = 15 * 60_000;
/** The tools that may elicit a run's question. */
export const ELICITING_TOOLS: ReadonlySet<string> = new Set(['run_wait', 'run_goal', 'task_run']);

/**
 * Whether the client declared form elicitation in this request's
 * `clientCapabilities`: `elicitation: {}` (form only, for backwards
 * compatibility) or `elicitation: { form: {} }`.
 */
export function clientCanElicitForm(caps: Record<string, unknown> | undefined): boolean {
  const e = caps?.elicitation;
  if (e === null || typeof e !== 'object' || Array.isArray(e)) return false;
  const modes = e as Record<string, unknown>;
  return Object.keys(modes).length === 0 || (modes.form !== undefined && modes.form !== null);
}

/**
 * Whether a question may be put to the client's user as a form: only the
 * public answers (text, choice, multi_choice, number, low-risk confirm).
 * Never a secret (form mode must not ask for one, and URL mode is not used
 * for it: the console link goes in the text), a takeover, a `none` or a
 * high-risk confirm, whoever the caller is.
 */
export function mayElicit(q: Pick<ProgressQuestion, 'input' | 'risk'>): boolean {
  return answerableHere(q, 'oauth');
}

type Constraints = { maxLength?: number; pattern?: string; min?: number; max?: number; step?: number; unit?: string; minSelections?: number; maxSelections?: number };

/** The one-field form schema of a question (the spec's restricted JSON Schema: flat, primitive). */
export function elicitationSchema(q: ProgressQuestion): Record<string, unknown> {
  const c = (q.constraints ?? {}) as Constraints;
  const opts = q.options ?? [];
  let field: Record<string, unknown>;
  switch (q.input) {
    case 'choice':
      field = { type: 'string', title: 'Answer', oneOf: opts.map((o) => ({ const: o.id, title: o.label })) };
      break;
    case 'multi_choice':
      field = {
        type: 'array',
        title: 'Answer',
        items: { anyOf: opts.map((o) => ({ const: o.id, title: o.label })) },
        minItems: c.minSelections ?? 1,
        maxItems: c.maxSelections ?? opts.length,
      };
      break;
    case 'number': {
      const whole = c.step !== undefined && Number.isInteger(c.step) && Number.isInteger(c.min ?? 0);
      const notes = [c.step !== undefined ? `in steps of ${c.step}` : null, c.unit ? `in ${c.unit}` : null].filter(Boolean);
      field = {
        type: whole ? 'integer' : 'number',
        title: 'Answer',
        ...(c.min !== undefined ? { minimum: c.min } : {}),
        ...(c.max !== undefined ? { maximum: c.max } : {}),
        ...(notes.length ? { description: `A number ${notes.join(', ')}` } : {}),
      };
      break;
    }
    case 'confirm':
      field = { type: 'boolean', title: 'Approve', description: 'Yes approves, no denies' };
      break;
    default:
      // text. The specification's StringSchema has no `pattern`: the format is described and checked on our side.
      field = {
        type: 'string',
        title: 'Answer',
        minLength: 1,
        maxLength: c.maxLength ?? 4096,
        ...(c.pattern ? { description: `Must match the format ${c.pattern}` } : {}),
      };
  }
  return { type: 'object', properties: { [ELICIT_FIELD]: field }, required: [ELICIT_FIELD] };
}

/** The `elicitation/create` request (form mode) for a question. */
export function elicitationRequest(q: ProgressQuestion, note?: string): { method: 'elicitation/create'; params: Record<string, unknown> } {
  return {
    method: 'elicitation/create',
    params: { mode: 'form', message: `Your Hexactra agent asks: ${q.prompt}${note ? `\n\n${note}` : ''}`, requestedSchema: elicitationSchema(q) },
  };
}

/** The answer an accepted form stands for (`POST /questions/:id/answer`), or `null` when the form holds no usable value. */
export function answerFromForm(q: Pick<ProgressQuestion, 'input'>, content: Record<string, unknown> | undefined): { outcome: 'completed'; value?: string | number; values?: string[] } | null {
  const v = content?.[ELICIT_FIELD];
  switch (q.input) {
    case 'multi_choice':
      return Array.isArray(v) && v.every((x) => typeof x === 'string') ? { outcome: 'completed', values: v as string[] } : null;
    case 'confirm':
      if (typeof v === 'boolean') return { outcome: 'completed', value: v ? 'approve' : 'deny' };
      return v === 'approve' || v === 'deny' ? { outcome: 'completed', value: v } : null;
    case 'number':
      return typeof v === 'number' || (typeof v === 'string' && v.trim() !== '') ? { outcome: 'completed', value: v } : null;
    default:
      return typeof v === 'string' ? { outcome: 'completed', value: v } : null;
  }
}

/** What a `requestState` carries (signed). */
export interface RequestState {
  v: 1;
  /** The tool and a digest of its arguments: a state is valid only on a retry of the same call. */
  tool: string;
  args: string;
  /** The authenticated user it was issued to. */
  sub: string;
  exp: number;
  runId: string;
  questionId: string;
  cursor: string | null;
}

/** A stable digest of a tool's (validated) arguments. */
export function argsDigest(args: Record<string, unknown>): string {
  const stable = (v: unknown): unknown =>
    Array.isArray(v) ? v.map(stable) : v !== null && typeof v === 'object' ? Object.fromEntries(Object.keys(v as object).sort().map((k) => [k, stable((v as Record<string, unknown>)[k])])) : v;
  return createHash('sha256').update(JSON.stringify(stable(args))).digest('base64url').slice(0, 32);
}

let processKey: Buffer | null = null;

/** The HMAC key of `requestState`: derived from `JWT_SECRET` (every replica agrees), else a per-process key. */
export function stateKey(secret = process.env.JWT_SECRET): Buffer {
  if (secret) return createHmac('sha256', secret).update('hexactra.mcp.request-state.v1').digest();
  processKey ??= randomBytes(32);
  return processKey;
}

/** Seal a state: base64url JSON, a dot, its HMAC-SHA256. */
export function sealState(s: RequestState, key: Buffer = stateKey()): string {
  const body = Buffer.from(JSON.stringify(s), 'utf8').toString('base64url');
  const mac = createHmac('sha256', key).update(body).digest('base64url');
  return `${body}.${mac}`;
}

/**
 * Open a state the client echoed back: refused (`null`) when it was altered,
 * expired, issued to another user, or belongs to another call.
 */
export function openState(token: unknown, expect: { sub: string; tool: string; args: string; now?: number }, key: Buffer = stateKey()): RequestState | null {
  if (typeof token !== 'string' || token.length > 4096) return null;
  const dot = token.indexOf('.');
  if (dot <= 0) return null;
  const body = token.slice(0, dot);
  const mac = Buffer.from(token.slice(dot + 1), 'base64url');
  const want = createHmac('sha256', key).update(body).digest();
  if (mac.length !== want.length || !timingSafeEqual(mac, want)) return null;
  let s: RequestState;
  try {
    s = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as RequestState;
  } catch {
    return null;
  }
  if (s.v !== 1 || s.sub !== expect.sub || s.tool !== expect.tool || s.args !== expect.args) return null;
  if (typeof s.exp !== 'number' || s.exp < (expect.now ?? Date.now())) return null;
  if (typeof s.runId !== 'string' || typeof s.questionId !== 'string') return null;
  return s;
}
