// The task builder's live task spec (E42.1, #718): what the builder has
// learned so far about the task the owner wants. Every field is optional: the
// spec fills in over the conversation, and the draft (E42.2) is built from it
// and checked like a saved task. It is data, never an instruction or a
// permission, and it never holds a secret.
import { z } from 'zod';

import { OUTPUT_TYPES, type TaskOutputType } from '@app/shared/task-fields';
import { PARAMETER_TYPES, type TaskParameterType } from '@app/shared/task-params';

import { policyRefSchema } from '../policies/policies.schemas';
import { domainSchema, NEEDS_BROWSER, UNATTENDED_PAYMENTS } from '../tasks/tasks.schemas';
import { scheduleProblem } from '../schedules/cron';

/** The largest spec, as JSON. */
export const SPEC_MAX_BYTES = 16_000;
/** The most schedules a task holds (the task form's `MAX_SCHEDULES`). */
export const SPEC_MAX_SCHEDULES = 10;

const text = (max: number) => z.string().trim().min(1).max(max);
const note = text(300);

const parameterSchema = z
  .object({
    name: text(60).describe('The placeholder\'s name, as it appears in the goal ("Amount" for {{Amount}}).'),
    type: z.enum(PARAMETER_TYPES as unknown as [TaskParameterType, ...TaskParameterType[]]).default('text'),
    default: text(200).optional().describe('A fixed default value. Never a secret.'),
    memory: text(80).optional().describe("The label of the owner's memory that holds the default."),
    attribute: text(80).optional().describe("The name of that memory's value."),
    why: note.optional().describe('Why it varies, in a few words.'),
  })
  .strict();

const outputSchema = z
  .object({
    label: text(80),
    type: z.enum(OUTPUT_TYPES.filter((t) => t !== 'choice') as [TaskOutputType, ...TaskOutputType[]]).default('text'),
    help: text(200).optional(),
  })
  .strict();

const accountSchema = z
  .object({
    label: text(100).describe("The connection's label, as the owner sees it."),
    access: z.enum(['read', 'read_write']).default('read'),
  })
  .strict();

const guardrailsSchema = z
  .object({
    confirmRiskyActions: z.boolean().optional(),
    useSavedLogins: z.boolean().optional(),
    useSavedIdentity: z.boolean().optional(),
    useSavedCards: z.boolean().optional(),
    unattendedPayments: z.enum(UNATTENDED_PAYMENTS).optional(),
  })
  .strict();

const scheduleSchema = z
  .object({
    cron: text(100).describe('A 5-field cron expression, e.g. "0 9 * * 1-5".'),
    timezone: text(64).describe('An IANA time zone, e.g. "America/Costa_Rica".'),
    inputs: z.record(z.string().max(60), z.string().max(200)).optional().describe("Preset values for the task's parameters, by parameter name."),
    description: note.optional(),
  })
  .strict()
  .superRefine((s, ctx) => {
    const problem = scheduleProblem(s.cron, s.timezone);
    if (problem) ctx.addIssue({ code: 'custom', message: problem.message, path: [problem.code === 'INVALID_TIMEZONE' ? 'timezone' : 'cron'] });
  });

const policySchema = z
  .object({
    ref: policyRefSchema.nullable().describe("An agent policy: an own policy's UUID or `builtin:<key>`; null follows the owner's default."),
    why: note.optional(),
  })
  .strict();

/** Every field of a spec, each optional. */
export const specFields = {
  name: text(60).optional(),
  objective: text(1000).optional().describe('What the task achieves and how the owner knows it is done.'),
  goal: text(4000).optional().describe('The standalone instruction so far, with a {{Name}} for each parameter.'),
  sites: z.array(text(200)).max(20).optional().describe('The sites or services involved, in words.'),
  allowedDomains: z.array(domainSchema).max(50).optional(),
  accounts: z.array(accountSchema).max(20).optional(),
  parameters: z.array(parameterSchema).max(20).optional(),
  outputs: z.array(outputSchema).max(12).optional(),
  guardrails: guardrailsSchema.optional(),
  needsBrowser: z.enum(NEEDS_BROWSER).optional(),
  policy: policySchema.optional(),
  schedules: z.array(scheduleSchema).max(SPEC_MAX_SCHEDULES).optional(),
  edgeCases: z.array(note).max(10).optional().describe('What the agent does when something goes wrong (sold out, a login needed).'),
  openQuestions: z.array(note).max(10).optional(),
  suggestions: z.array(note).max(10).optional(),
  ready: z.boolean().optional(),
};

const withinSize = (value: unknown, ctx: z.RefinementCtx) => {
  if (Buffer.byteLength(JSON.stringify(value), 'utf8') > SPEC_MAX_BYTES) ctx.addIssue({ code: 'custom', message: `The spec is larger than ${SPEC_MAX_BYTES} bytes` });
};

export const taskBuilderSpecSchema = z.object(specFields).strict().superRefine(withinSize);
export type TaskBuilderSpec = z.infer<typeof taskBuilderSpecSchema>;

/** A change to a spec: any top-level key; `null` clears it. */
export type TaskBuilderSpecPatch = { [K in keyof TaskBuilderSpec]?: TaskBuilderSpec[K] | null };
const patchShape = Object.fromEntries(Object.entries(specFields).map(([k, v]) => [k, (v as z.ZodOptional<z.ZodType>).unwrap().nullable().optional()]));
export const taskBuilderSpecPatchSchema: z.ZodType<TaskBuilderSpecPatch> = z
  .object(patchShape)
  .strict()
  .refine((p) => Object.keys(p).length > 0, { message: 'Nothing to change' }) as unknown as z.ZodType<TaskBuilderSpecPatch>;

/**
 * The spec after a patch: per top-level key, a value replaces the current one
 * (an array is replaced whole), `null` removes it and an absent key keeps it.
 * `guardrails` merges field by field, so one switch can change alone.
 * Pure; the caller validates the result with `taskBuilderSpecSchema`.
 */
export function mergeSpec(current: TaskBuilderSpec, patch: TaskBuilderSpecPatch): TaskBuilderSpec {
  const next: Record<string, unknown> = { ...current };
  for (const [key, value] of Object.entries(patch)) {
    if (value === undefined) continue;
    if (value === null) delete next[key];
    else if (key === 'guardrails') next[key] = { ...(current.guardrails ?? {}), ...(value as object) };
    else next[key] = value;
  }
  return next as TaskBuilderSpec;
}

/** A stored spec read back: what passes the schema, or an empty spec (a spec is never trusted blindly). */
export function readSpec(raw: unknown): TaskBuilderSpec {
  const parsed = taskBuilderSpecSchema.safeParse(raw ?? {});
  return parsed.success ? parsed.data : {};
}
