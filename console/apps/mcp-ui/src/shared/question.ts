// A typed question as the widgets know it (#467), read from the three shapes
// tool results carry it in:
// - the progress block's `question` and the question tools' `question`
//   (snake_case: `expires_at`, `confirm_label`, `run_id`, ...);
// - an inbox item of `inbox_list` (the REST shape: `questionId`, `expiresAt`, ...).
// Constraints keep the REST names (camelCase) the shared answer rules read
// (packages/shared/question-rules.js). Every string is the asker's (an agent,
// a web page): data only, rendered as text.
import type { RuleConstraints, RuleOption } from '@app/shared/question-rules';

import { num, obj, str } from './text';

export interface CardQuestion {
  id: string;
  input: string;
  prompt: string;
  kind?: string;
  options: RuleOption[];
  constraints: RuleConstraints | null;
  risk: 'low' | 'high' | null;
  confirmLabel: string | null;
  denyLabel: string | null;
  /** ISO 8601, when known. */
  expiresAt?: string;
  runId?: string | null;
  askedBy?: string;
  /** The run's goal (inbox items). */
  goal?: string;
  /** takeover: the desktop viewer in the console. */
  viewerUrl?: string;
  /** The progress block's verdict for the model's own relay (the run card's "Answer in the chat"). */
  answerable_here?: boolean;
  how_to_answer?: string;
}

const CONSTRAINT_NUMBERS = ['maxLength', 'min', 'max', 'step', 'minSelections', 'maxSelections'] as const;

function constraintsOf(v: unknown): RuleConstraints | null {
  const c = obj(v);
  if (!c) return null;
  const out: RuleConstraints = {};
  for (const k of CONSTRAINT_NUMBERS) if (typeof c[k] === 'number' && Number.isFinite(c[k])) out[k] = num(c[k]);
  if (typeof c.pattern === 'string') out.pattern = c.pattern;
  if (typeof c.unit === 'string') out.unit = c.unit;
  if (c.multiline === true) out.multiline = true;
  return Object.keys(out).length ? out : null;
}

function optionsOf(v: unknown): RuleOption[] {
  if (!Array.isArray(v)) return [];
  return v.flatMap((o) => {
    if (typeof o === 'string') return [{ id: o, label: o }];
    const x = obj(o);
    if (!x || typeof x.id !== 'string') return [];
    return [{ id: x.id, label: str(x.label) ?? x.id, ...(str(x.description) ? { description: str(x.description) } : {}) }];
  });
}

function riskOf(v: unknown): 'low' | 'high' | null {
  return v === 'low' || v === 'high' ? v : null;
}

/** A question from a progress block or a question tool's `question` (snake_case), or `undefined`. */
export function questionFromBlock(v: unknown): CardQuestion | undefined {
  const q = obj(v);
  if (!q || typeof q.id !== 'string') return undefined;
  return {
    id: q.id,
    input: str(q.input) ?? '',
    prompt: str(q.prompt) ?? '',
    ...(str(q.kind) ? { kind: str(q.kind) } : {}),
    options: optionsOf(q.options),
    constraints: constraintsOf(q.constraints),
    risk: riskOf(q.risk),
    confirmLabel: str(q.confirm_label) ?? null,
    denyLabel: str(q.deny_label) ?? null,
    ...(str(q.expires_at) ? { expiresAt: str(q.expires_at) } : {}),
    ...(q.run_id !== undefined ? { runId: str(q.run_id) ?? null } : {}),
    ...(str(q.asked_by) ? { askedBy: str(q.asked_by) } : {}),
    ...(str(q.viewer_url) ? { viewerUrl: str(q.viewer_url) } : {}),
    answerable_here: q.answerable_here === true,
    ...(str(q.how_to_answer) ? { how_to_answer: str(q.how_to_answer) } : {}),
  };
}

/** A question from an `inbox_list` item (the REST inbox shape), or `undefined`. */
export function questionFromInbox(v: unknown): CardQuestion | undefined {
  const q = obj(v);
  if (!q || typeof q.questionId !== 'string') return undefined;
  return {
    id: q.questionId,
    input: str(q.input) ?? '',
    prompt: str(q.prompt) ?? '',
    ...(str(q.kind) ? { kind: str(q.kind) } : {}),
    options: optionsOf(q.options),
    constraints: constraintsOf(q.constraints),
    risk: riskOf(q.risk),
    confirmLabel: str(q.confirmLabel) ?? null,
    denyLabel: str(q.denyLabel) ?? null,
    ...(str(q.expiresAt) ? { expiresAt: str(q.expiresAt) } : {}),
    runId: str(q.runId) ?? null,
    ...(str(q.askedBy) ? { askedBy: str(q.askedBy) } : {}),
    // A free-standing question's inbox item repeats its prompt as the goal: the run's goal only.
    ...(str(q.runId) && str(q.goal) && q.goal !== q.prompt ? { goal: str(q.goal) } : {}),
    ...(str(q.viewerUrl) ? { viewerUrl: str(q.viewerUrl) } : {}),
  };
}

/** Who asked, in words: `agent:packer` is "packer", `run:<id>` "your browser agent", `user:<id>` "you". */
export function askerText(askedBy: string | undefined): string {
  if (!askedBy) return 'an agent';
  const [who, ...rest] = askedBy.split(':');
  const name = rest.join(':');
  if (who === 'agent') return name || 'an agent';
  if (who === 'run') return 'your browser agent';
  if (who === 'user') return 'you';
  return askedBy;
}

/** Seconds until `expiresAt`, or `null` when it is not a date. */
export function secondsLeft(expiresAt: string | undefined, now: number): number | null {
  if (!expiresAt) return null;
  const t = Date.parse(expiresAt);
  return Number.isNaN(t) ? null : Math.floor((t - now) / 1000);
}

/** The countdown is shown when less than this is left. */
export const COUNTDOWN_BELOW_S = 10 * 60;
