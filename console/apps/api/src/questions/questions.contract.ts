// The question contract (epic #285), camelCase as the console's REST API
// speaks it. Pure zod and plain functions (no Nest), so the web app and the
// CLI can take it over unchanged; the fabric's snake_case form is mapped in
// src/runner/fabric-session.ts.
import { z } from 'zod';

/** The inputs an agent (or a person's own automation) may ask with. */
export const QUESTION_INPUTS = ['none', 'text', 'secret', 'choice', 'multi_choice', 'number', 'confirm', 'takeover', 'credentials'] as const;
/**
 * The inputs only the server creates: `memory` (#553), a memory the agent
 * proposes and the owner saves or declines on its card; `form` (#552), the
 * missing parameter values of a task run, asked at once before it starts;
 * `save_login` (E37.4b), "Save this login?" after the owner signed in by hand.
 * Never accepted from a question spec (`POST /api/questions`, `request_human`,
 * an external agent).
 */
export const SERVER_QUESTION_INPUTS = ['memory', 'form', 'save_login'] as const;
export type AskableInputType = (typeof QUESTION_INPUTS)[number];
export type QuestionInputType = AskableInputType | (typeof SERVER_QUESTION_INPUTS)[number];

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
export const QUESTION_KINDS = ['captcha', 'code', 'passkey', 'login', 'confirmation', 'verification', 'other'] as const;
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
  memory: [],
  save_login: [],
  takeover: [],
  secret: [],
  credentials: [],
  form: [],
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
  /**
   * The commitment the server's confirmation gate stopped (#550). Set by the runner only, after the
   * request is parsed: `questionSpecSchema` has no such field, so one sent by a model or an API caller is dropped.
   */
  gate?: QuestionGate | null;
  /**
   * What a "Don't ask again" tick would remember (#555), computed by the server in the runner from the gate's
   * verdict or a fixed topic, and the page the fabric reports. Like `gate`, it is not in `questionSpecSchema`:
   * a `rememberable` sent by a model or an API caller is dropped.
   */
  rememberable?: QuestionRememberable | null;
}

/** The kinds of question a saved approval can be made from (#555). */
export const REMEMBERABLE_KINDS = ['gate', 'ask', 'connection'] as const;

/**
 * What the owner can tick "Don't ask again" for (#555): a `gate` (the server stopped a commitment; keyed on the
 * category and the element's label) or an `ask` (the agent asked on its own; keyed on a fixed topic). `host` is
 * the registrable domain of the page the fabric reported. `summary` is the sentence the owner reads and the rule stores.
 */
export interface QuestionRememberable {
  kind: (typeof REMEMBERABLE_KINDS)[number];
  host: string;
  category: string | null;
  matchKey: string;
  summary: string;
  /** Where a rule may be limited to: `everywhere` always; `this_task` and `this_chat` when the run has one. */
  scopes?: (typeof REMEMBER_RULE_SCOPES)[number][];
  /**
   * A saved card (E37.7): `<provider>:<item id>`, set by the runner from its own record of the card. The rule is then for paying
   * with that card on `host`, and the owner's amount limit is REQUIRED (the answer is refused without it). `currency` is the
   * limit's currency and `amount` the purchase this approval is for.
   */
  cardRef?: string;
  /**
   * A call through one of the owner's connections (E39.7, `kind: 'connection'`): `host` is the connection's id and `matchKey` the tool. `recipients`
   * are the addresses the approved call reaches (set by the server from its validated arguments); the owner chooses to remember those people or
   * anyone at their domains (`rememberRule.recipientsFrom`). Absent for a tool that reaches no one.
   */
  recipients?: string[];
  requiresLimit?: boolean;
  currency?: string;
  amount?: string;
}

/** The scopes a "Don't ask again" rule may be limited to (#555). */
export const REMEMBER_RULE_SCOPES = ['everywhere', 'this_task', 'this_chat'] as const;

/**
 * The owner's "Don't ask again" tick on an approval (#555), with its optional limits. Accepted only with an
 * approval, only on a `rememberable` question and only from the signed-in web or Android app. Distinct from
 * `remember`, the site's own "remember me" option of a sign-in (#527).
 */
export const rememberRuleSchema = z
  .object({
    enabled: z.literal(true),
    scope: z.enum(REMEMBER_RULE_SCOPES).optional(),
    maxAmount: z.number().finite().positive().max(1_000_000_000).optional(),
    expiresInDays: z.number().int().min(1).max(3650).optional(),
    /** A connection call that reaches people (E39.7): remember `these` people or `domain` (anyone at their domains). There is no "anyone". Default `these`. */
    recipientsFrom: z.enum(['these', 'domain']).optional(),
  })
  .strict();
export type RememberRuleInput = z.infer<typeof rememberRuleSchema>;

/** What the confirmation gate stopped (#550): the page's host (from the fabric), the commitment's category, the element's label. */
export interface QuestionGate {
  host: string | null;
  category: string;
  label: string | null;
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

// ---- Memory proposals (#553) ----

export const MEMORY_PROPOSAL_KINDS = ['person', 'account', 'preference', 'fact'] as const;
/** How long a memory proposal waits for the owner before it expires. */
export const MEMORY_PROPOSAL_TTL_MS = 7 * 24 * 3600_000;

const proposalLabel = z.string().trim().min(1).max(120);
const proposalAliases = z.array(z.string().trim().min(1).max(60)).max(10);
const proposalAttributes = z
  .record(z.string().trim().min(1).max(60), z.string().trim().min(1).max(500))
  .refine((r) => Object.keys(r).length >= 1 && Object.keys(r).length <= 20, { message: 'Between 1 and 20 attributes' });

/** A memory as the agent proposes it (stored on the question, shown on the card). */
export const memoryProposalSchema = z
  .object({
    kind: z.enum(MEMORY_PROPOSAL_KINDS),
    label: proposalLabel,
    aliases: proposalAliases.default([]),
    attributes: proposalAttributes,
    /** The id of the active memory this one would replace (a changed value). */
    supersedes: z.uuid().nullable().default(null),
  })
  .strict();
export type MemoryProposal = z.infer<typeof memoryProposalSchema>;

/** What the owner saves from a proposal's card: the proposal, edited. */
export const memoryProposalAnswerSchema = z
  .object({
    kind: z.enum(MEMORY_PROPOSAL_KINDS).optional(),
    label: proposalLabel,
    aliases: proposalAliases.optional(),
    attributes: proposalAttributes,
  })
  .strict();
export type MemoryProposalAnswer = z.infer<typeof memoryProposalAnswerSchema>;

// ---- "Save this login?" (E37.4b) ----

/** How long the fabric holds the typed password after the owner gave it (its `SECRET_TTL`): the proposal cannot be answered later. */
export const SAVE_LOGIN_VALUE_TTL_MS = 10 * 60_000;
/** The longest name a saved login may have (the fabric's and Vault's limit). */
export const SAVE_LOGIN_NAME_MAX = 200;

const saveLoginName = z
  .string()
  .trim()
  .min(1)
  .max(SAVE_LOGIN_NAME_MAX)
  .refine((v) => !/[\u0000-\u001f\u007f]/.test(v), 'One line of text');

/**
 * The sign-in the owner typed by hand, offered to their secrets provider (stored on the question, shown on its card). Never the
 * password: that is in the fabric's memory only. `handoffId` is the fabric's handoff that holds it (an id, not a secret).
 */
export const saveLoginProposalSchema = z
  .object({
    /** The host of the sign-in page, as the card says it ("example.test"). */
    site: z.string().trim().min(1).max(255),
    /** `scheme://host[:port]` of the sign-in page, as the fabric reported it: the login is bound to exactly this origin. */
    origin: z.string().trim().min(1).max(300),
    /** The registrable domain, the unit "Never for this site" is remembered at. */
    domain: z.string().trim().min(1).max(255),
    /** The name the agent suggests; the owner edits it on the card. */
    name: saveLoginName,
    /** The username the owner typed: shown on the card (it is not secret). */
    username: z.string().trim().min(1).max(200),
    handoffId: z.uuid(),
    provider: z.enum(['vault']),
    /** When the fabric stops holding the password: the card is "too late" after it. */
    valueExpiresAt: z.string().min(1).max(40),
  })
  .strict();
export type SaveLoginProposal = z.infer<typeof saveLoginProposalSchema>;

/** What the owner saves from the card: the name, edited. */
export const saveLoginAnswerSchema = z.object({ name: saveLoginName }).strict();
export type SaveLoginAnswer = z.infer<typeof saveLoginAnswerSchema>;

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
    /** "Don't ask again" (#555): make a saved approval of this approval. Signed-in web and Android app only. */
    rememberRule: rememberRuleSchema.optional(),
    /** form (#552): the value of each field, by key. */
    fields: z.record(z.string().min(1).max(80), z.union([z.string().max(TEXT_MAX_LENGTH), z.number().finite()])).optional(),
    /** memory (#553): the memory as the owner saves it, edited on the card; omitted, the proposal is saved as proposed. */
    memory: memoryProposalAnswerSchema.optional(),
    /** save_login (E37.4b): Save, with the name as the owner edited it. */
    saveLogin: saveLoginAnswerSchema.optional(),
    /** save_login: "Never for this site", sent with a declined answer: the registrable domain is not offered again. */
    neverForSite: z.literal(true).optional(),
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
  /** form (#552): the values by key, before the parameter checks (the run starter applies them). */
  fields?: Record<string, string>;
  /** memory: what the owner saves. */
  memory?: MemoryProposalAnswer;
  /** save_login: the name the login is saved under. */
  saveLogin?: SaveLoginAnswer;
  /** save_login: declined with "Never for this site". */
  neverForSite?: boolean;
}

/** The stored and returned response. Never carries a secret value. */
export interface QuestionResponse {
  outcome: QuestionOutcome;
  value?: string;
  values?: string[];
  valueWithheld: boolean;
  /** What the person chose for the "remember me" option, when one was offered. */
  remember?: boolean;
  /** The saved approval this answer created or found ("Don't ask again", #555). */
  ruleId?: string;
  /** form (#552): the values given, masked (#538). */
  fields?: Record<string, string>;
  /** memory (#553): the memory the answer saved. */
  memoryId?: string;
  /** save_login (E37.4b): declined with "Never for this site". */
  neverForSite?: boolean;
  /** save_login: the name the login was saved under (not the password, which the console never holds). */
  savedAs?: string;
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
  if (a.saveLogin !== undefined && q.input !== 'save_login') throw new AnswerInvalidError('saveLogin is only for a "Save this login?" card');
  if (a.neverForSite !== undefined) {
    if (q.input !== 'save_login') throw new AnswerInvalidError('neverForSite is only for a "Save this login?" card');
    if (a.outcome !== 'cancelled') throw new AnswerInvalidError('"Never for this site" is a declined answer');
  }
  if (a.outcome === 'cancelled') return { outcome: 'cancelled', ...(a.neverForSite ? { neverForSite: true } : {}) };
  if (a.memory !== undefined && q.input !== 'memory') throw new AnswerInvalidError('memory is only for a memory proposal');
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
  if (q.input !== 'form' && a.fields !== undefined) fail('fields is only for a form');
  switch (q.input) {
    case 'memory':
      // The memory itself is checked where it is written (the secret check, the label rule, the limit).
      if (a.value !== undefined) fail('A memory proposal is answered with memory, not value');
      return { outcome: 'completed', ...(a.memory ? { memory: a.memory } : {}) };
    case 'save_login': {
      if (a.value !== undefined) fail('A "Save this login?" answer uses saveLogin, not value');
      if (!a.saveLogin) fail('Give the name to save the login under');
      return { outcome: 'completed', saveLogin: a.saveLogin };
    }
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
    case 'form': {
      // The fields are checked against the task's parameter rules by the run starter (#552).
      if (a.value !== undefined) fail('A form answer uses fields, not value');
      const f = a.fields ?? fail('A form answer needs fields');
      return { outcome: 'completed', fields: Object.fromEntries(Object.entries(f).map(([k, v]) => [k, String(v)])) };
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
    ...(a.fields !== undefined ? { fields: a.fields } : {}),
    ...(a.neverForSite ? { neverForSite: true } : {}),
    ...(a.saveLogin ? { savedAs: a.saveLogin.name } : {}),
    ...(meta.channel ? { channel: meta.channel } : {}),
    ...(meta.by ? { by: meta.by } : {}),
    answeredAt: meta.answeredAt.toISOString(),
  };
}
