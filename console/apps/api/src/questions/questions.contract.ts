// The question contract (epic #285), camelCase as the console's REST API
// speaks it. Pure zod and plain functions (no Nest), so the web app and the
// CLI can take it over unchanged; the fabric's snake_case form is mapped in
// src/runner/fabric-session.ts.
import { z } from 'zod';

export const QUESTION_INPUTS = ['none', 'text', 'secret', 'choice', 'multi_choice', 'number', 'confirm', 'takeover', 'credentials'] as const;
export type QuestionInputType = (typeof QUESTION_INPUTS)[number];

/**
 * Inputs whose answer holds a secret the fabric keeps and types, never
 * returned: `secret` (a code or password) and `credentials` (a sign-in: its
 * username is returned, its password is not, #527).
 */
export function holdsSecret(input: string): boolean {
  return input === 'secret' || input === 'credentials';
}

/** The longest "remember me" label a question carries (the fabric's limit). */
export const REMEMBER_LABEL_MAX = 80;

/** Why a question is asked. */
export const QUESTION_KINDS = ['captcha', 'code', 'passkey', 'login', 'confirmation', 'other'] as const;
export type QuestionKind = (typeof QUESTION_KINDS)[number];

export const QUESTION_STATUSES = ['pending', 'answered', 'cancelled', 'expired'] as const;
export type QuestionStatusType = (typeof QUESTION_STATUSES)[number];

export const QUESTION_OUTCOMES = ['completed', 'cancelled'] as const;
export type QuestionOutcome = (typeof QUESTION_OUTCOMES)[number];

export const TEXT_MAX_LENGTH = 4096;
export const MAX_OPTIONS = 10;
/** A question's lifetime: at least 10 s, at most 24 h (the fabric's bounds); 1 h by default. */
export const QUESTION_TIMEOUT = { minMs: 10_000, maxMs: 24 * 3600_000, defaultMs: 3600_000 } as const;

const OPTION_ID = /^[A-Za-z0-9_-]{1,64}$/;

/** An option: a bare string (its own id and label) or `{ id, label, description? }`. */
export const questionOptionInputSchema = z.union([
  z.string().trim().min(1).max(100),
  z.object({
    id: z.string().regex(OPTION_ID, 'An option id is 1-64 letters, digits, "_" or "-"'),
    label: z.string().trim().min(1).max(100),
    description: z.string().trim().max(200).optional(),
  }),
]);
export type QuestionOptionInput = z.infer<typeof questionOptionInputSchema>;

export interface QuestionOption {
  id: string;
  label: string;
  description?: string;
}

export const questionConstraintsSchema = z
  .object({
    /** text */
    maxLength: z.number().int().min(1).max(TEXT_MAX_LENGTH),
    pattern: z.string().min(1).max(200),
    multiline: z.boolean(),
    /** number */
    min: z.number().finite(),
    max: z.number().finite(),
    step: z.number().finite().positive(),
    unit: z.string().trim().min(1).max(20),
    /** multi_choice */
    minSelections: z.number().int().min(0).max(MAX_OPTIONS),
    maxSelections: z.number().int().min(1).max(MAX_OPTIONS),
  })
  .partial()
  .strict();
export type QuestionConstraints = z.infer<typeof questionConstraintsSchema>;

const CONSTRAINT_KEYS: Record<QuestionInputType, readonly (keyof QuestionConstraints)[]> = {
  none: [],
  takeover: [],
  secret: [],
  credentials: [],
  confirm: [],
  choice: [],
  text: ['maxLength', 'pattern', 'multiline'],
  number: ['min', 'max', 'step', 'unit'],
  multi_choice: ['minSelections', 'maxSelections'],
};

/** The question itself (what is asked and how it may be answered). */
export const questionSpecObject = z.object({
  input: z.enum(QUESTION_INPUTS),
  kind: z.enum(QUESTION_KINDS).default('other'),
  prompt: z.string().trim().min(1).max(2000),
  /** Options of choice and multi_choice; `choices` is accepted as an alias. */
  options: z.array(questionOptionInputSchema).max(MAX_OPTIONS).optional(),
  choices: z.array(questionOptionInputSchema).max(MAX_OPTIONS).optional(),
  constraints: questionConstraintsSchema.optional(),
  confirmLabel: z.string().trim().min(1).max(40).optional(),
  denyLabel: z.string().trim().min(1).max(40).optional(),
  risk: z.enum(['low', 'high']).optional(),
  /** credentials and secret: the site's "remember me" option, in the page's words (#527); the person ticks it or not. */
  rememberLabel: z
    .string()
    .trim()
    .min(1)
    .max(REMEMBER_LABEL_MAX)
    .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), 'One line of text')
    .optional(),
  timeoutMs: z.number().int().min(QUESTION_TIMEOUT.minMs).max(QUESTION_TIMEOUT.maxMs).optional(),
});

/** A question as validated and normalised (options as objects, constraints only for its input). */
export interface QuestionSpec {
  input: QuestionInputType;
  kind: QuestionKind;
  prompt: string;
  options: QuestionOption[] | null;
  constraints: QuestionConstraints | null;
  confirmLabel: string | null;
  denyLabel: string | null;
  risk: 'low' | 'high' | null;
  rememberLabel: string | null;
  timeoutMs: number;
}

export function normalizeOptions(options: readonly QuestionOptionInput[]): QuestionOption[] {
  return options.map((o) => (typeof o === 'string' ? { id: o, label: o } : { id: o.id, label: o.label, ...(o.description ? { description: o.description } : {}) }));
}

function compiles(pattern: string): boolean {
  try {
    new RegExp(pattern, 'u');
    return true;
  } catch {
    return false;
  }
}

/** The rules zod's shape cannot say: what each input type allows. */
function refineSpec(q: z.infer<typeof questionSpecObject>, ctx: z.RefinementCtx): void {
  const issue = (path: string, message: string) => ctx.addIssue({ code: 'custom', path: [path], message });
  if (q.options && q.choices) issue('choices', 'Give options or choices, not both');
  const raw = q.options ?? q.choices;
  const withOptions = q.input === 'choice' || q.input === 'multi_choice';
  if (withOptions) {
    if (!raw || raw.length === 0) issue('options', `${q.input} needs 1-${MAX_OPTIONS} options`);
    else {
      const ids = normalizeOptions(raw).map((o) => o.id);
      if (new Set(ids).size !== ids.length) issue('options', 'Option ids must be unique');
    }
  } else if (raw && raw.length > 0) issue('options', `Options are only allowed with choice or multi_choice, not ${q.input}`);

  const c = q.constraints ?? {};
  const allowed = CONSTRAINT_KEYS[q.input];
  for (const key of Object.keys(c) as (keyof QuestionConstraints)[]) {
    if (!allowed.includes(key)) issue('constraints', `${key} is not a constraint of ${q.input}`);
  }
  if (c.pattern !== undefined && !compiles(c.pattern)) issue('constraints', 'pattern is not a valid regular expression');
  if (c.min !== undefined && c.max !== undefined && c.min > c.max) issue('constraints', 'min is greater than max');
  if (q.input === 'multi_choice' && raw) {
    const min = c.minSelections ?? 1;
    const max = c.maxSelections ?? raw.length;
    if (min > max) issue('constraints', 'minSelections is greater than maxSelections');
    if (max > raw.length) issue('constraints', 'maxSelections is greater than the number of options');
  }
  if (q.input !== 'confirm') {
    if (q.confirmLabel !== undefined || q.denyLabel !== undefined) issue('confirmLabel', 'confirmLabel and denyLabel are only allowed with confirm');
    if (q.risk !== undefined) issue('risk', 'risk is only allowed with confirm');
  }
  if (q.rememberLabel !== undefined && !holdsSecret(q.input)) issue('rememberLabel', 'rememberLabel is only allowed with credentials or secret');
}

/** Validates and normalises a question. */
export const questionSpecSchema = questionSpecObject.superRefine(refineSpec).transform(
  (q): QuestionSpec => {
    const raw = q.options ?? q.choices;
    const constraints = q.constraints && Object.keys(q.constraints).length > 0 ? q.constraints : null;
    return {
      input: q.input,
      kind: q.kind,
      prompt: q.prompt,
      options: q.input === 'choice' || q.input === 'multi_choice' ? normalizeOptions(raw ?? []) : null,
      constraints,
      confirmLabel: q.confirmLabel ?? null,
      denyLabel: q.denyLabel ?? null,
      risk: q.input === 'confirm' ? (q.risk ?? 'high') : null,
      rememberLabel: q.rememberLabel ?? null,
      timeoutMs: q.timeoutMs ?? QUESTION_TIMEOUT.defaultMs,
    };
  },
);

/** An answer as a person (or a channel on their behalf) sends it. */
export const questionAnswerSchema = z
  .object({
    outcome: z.enum(QUESTION_OUTCOMES).default('completed'),
    /** text, secret, choice (an option id), number (a decimal; a JSON number is accepted), confirm (`approve` | `deny`). */
    value: z.union([z.string().max(TEXT_MAX_LENGTH), z.number().finite()]).optional(),
    /** multi_choice: option ids. */
    values: z.array(z.string().max(64)).max(MAX_OPTIONS).optional(),
    /** credentials: the password (the username is `value`). Sent to the fabric only, never stored. */
    secret: z.string().max(TEXT_MAX_LENGTH).optional(),
    /** The person's choice for the question's "remember me" option. */
    remember: z.boolean().optional(),
  })
  .strict();
export type QuestionAnswerInput = z.infer<typeof questionAnswerSchema>;

/** A validated answer, ready to store (without a secret) and to forward. */
export interface NormalizedAnswer {
  outcome: QuestionOutcome;
  value?: string;
  values?: string[];
  /** credentials: the password, forwarded to the fabric and never stored. */
  secret?: string;
  remember?: boolean;
}

/** The stored and returned response. Never carries a secret value. */
export interface QuestionResponse {
  outcome: QuestionOutcome;
  value?: string;
  values?: string[];
  valueWithheld: boolean;
  /** What the person chose for the "remember me" option, when one was offered. */
  remember?: boolean;
  channel?: string;
  by?: string;
  answeredAt: string;
}

export class AnswerInvalidError extends Error {}

/** A number as a canonical decimal string (`"007.50"` → `"7.5"`), or null. */
export function canonicalDecimal(v: string | number): string | null {
  const s = typeof v === 'number' ? String(v) : v.trim();
  if (!/^-?\d+(\.\d+)?$/.test(s)) return null;
  const n = Number(s);
  if (!Number.isFinite(n)) return null;
  const out = String(n);
  return /e/i.test(out) ? null : out === '-0' ? '0' : out;
}

/** Whether `value` is a whole number of `step`s from `base` (decimal-safe for ordinary steps). */
function onStep(value: number, base: number, step: number): boolean {
  const k = (value - base) / step;
  return Math.abs(k - Math.round(k)) < 1e-9;
}

/**
 * Checks an answer against its question and normalises it; throws
 * `AnswerInvalidError` with a message the person can act on. A declined
 * question (`cancelled`) carries no value.
 */
export function validateAnswer(q: Pick<QuestionSpec, 'input' | 'options' | 'constraints'> & { rememberLabel?: string | null }, a: QuestionAnswerInput): NormalizedAnswer {
  if (a.outcome === 'cancelled') return { outcome: 'cancelled' };
  if (a.secret !== undefined && q.input !== 'credentials') throw new AnswerInvalidError('secret is only for a sign-in (credentials)');
  if (a.remember !== undefined && !q.rememberLabel) throw new AnswerInvalidError('This question offered no "remember me" option');
  const remember = a.remember !== undefined ? { remember: a.remember } : {};
  const fail = (m: string): never => {
    throw new AnswerInvalidError(m);
  };
  const c = q.constraints ?? {};
  const str = (): string => {
    if (a.value === undefined) fail(`A ${q.input} answer needs a value`);
    if (typeof a.value !== 'string') fail('The value must be a string');
    return a.value as string;
  };
  if (q.input !== 'multi_choice' && a.values !== undefined) fail(`values is only for multi_choice answers`);
  switch (q.input) {
    case 'none':
    case 'takeover':
      if (a.value !== undefined) fail(`A ${q.input} question takes no value`);
      return { outcome: 'completed' };
    case 'secret': {
      const v = str();
      if (v.length === 0) fail('The secret is empty');
      return { outcome: 'completed', value: v, ...remember };
    }
    case 'credentials': {
      const user = str().trim();
      if (user.length === 0) fail('The username is empty');
      if (/[\r\n]/.test(user)) fail('The username must be one line');
      if (!a.secret) fail('The password is empty');
      return { outcome: 'completed', value: user, secret: a.secret, ...remember };
    }
    case 'text': {
      const v = str();
      if (v.length > (c.maxLength ?? TEXT_MAX_LENGTH)) fail(`The answer is longer than ${c.maxLength ?? TEXT_MAX_LENGTH} characters`);
      if (c.multiline === false && /[\r\n]/.test(v)) fail('The answer must be one line');
      if (c.pattern !== undefined && !new RegExp(`^(?:${c.pattern})$`, 'u').test(v)) fail('The answer does not have the expected format');
      return { outcome: 'completed', value: v };
    }
    case 'choice': {
      const v = str();
      if (!(q.options ?? []).some((o) => o.id === v)) fail('Not one of the options');
      return { outcome: 'completed', value: v };
    }
    case 'multi_choice': {
      if (a.value !== undefined) fail('A multi_choice answer uses values, not value');
      const vs = a.values ?? fail('A multi_choice answer needs values');
      const ids = new Set((q.options ?? []).map((o) => o.id));
      if (new Set(vs).size !== vs.length) fail('Each option may be chosen once');
      if (vs.some((v) => !ids.has(v))) fail('Not one of the options');
      const min = c.minSelections ?? 1;
      const max = c.maxSelections ?? ids.size;
      if (vs.length < min || vs.length > max) fail(min === max ? `Choose ${min}` : `Choose between ${min} and ${max}`);
      return { outcome: 'completed', values: [...vs] };
    }
    case 'number': {
      if (a.value === undefined) fail('A number answer needs a value');
      const canon = canonicalDecimal(a.value as string | number) ?? fail('Not a number');
      const n = Number(canon);
      if (c.min !== undefined && n < c.min) fail(`The number is below ${c.min}`);
      if (c.max !== undefined && n > c.max) fail(`The number is above ${c.max}`);
      if (c.step !== undefined && !onStep(n, c.min ?? 0, c.step)) fail(`The number must be in steps of ${c.step}`);
      return { outcome: 'completed', value: canon };
    }
    case 'confirm': {
      const v = str();
      if (v !== 'approve' && v !== 'deny') fail('A confirm answer is approve or deny');
      return { outcome: 'completed', value: v };
    }
  }
}

/** The response a question stores and returns: a secret value is withheld. */
export function toResponse(input: QuestionInputType, a: NormalizedAnswer, meta: { channel?: string; by?: string; answeredAt: Date }): QuestionResponse {
  const withheld = holdsSecret(input) && a.outcome === 'completed';
  // A sign-in's username is not a secret: it is kept, its password never is.
  const keepValue = a.value !== undefined && input !== 'secret';
  return {
    outcome: a.outcome,
    ...(keepValue ? { value: a.value } : {}),
    ...(a.values !== undefined ? { values: a.values } : {}),
    valueWithheld: withheld,
    ...(a.remember !== undefined ? { remember: a.remember } : {}),
    ...(meta.channel ? { channel: meta.channel } : {}),
    ...(meta.by ? { by: meta.by } : {}),
    answeredAt: meta.answeredAt.toISOString(),
  };
}
