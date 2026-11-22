// The parameters of the builder's `update_spec` tool (#802), in the subset of JSON Schema that strict function calling accepts: every field
// required and nullable (null: leave it as it is), objects closed, no record, no default. The platform sends every tool strict, and one schema
// outside the subset fails the whole model call (as the chat's #675 did). `toSpecPatch` turns the tool's arguments into a spec change, which
// `patchSpec` then checks like any other (domains, cron and time zone, size).
import { z } from 'zod';

import { OUTPUT_TYPES, type TaskOutputType } from '@app/shared/task-fields';
import { PARAMETER_TYPES, type TaskParameterType } from '@app/shared/task-params';

import { NEEDS_BROWSER, UNATTENDED_PAYMENTS } from '../tasks/tasks.schemas';
import type { TaskBuilderSpecPatch } from './task-builder.spec.schema';

const str = () => z.string().nullable();
const strs = () => z.array(z.string()).nullable();

/** The spec fields `clear` can remove. */
export const CLEARABLE_FIELDS = ['name', 'objective', 'goal', 'sites', 'allowedDomains', 'accounts', 'parameters', 'outputs', 'guardrails', 'needsBrowser', 'policy', 'schedules', 'edgeCases', 'openQuestions', 'suggestions'] as const;

export const updateSpecParameters = z.object({
  name: str().describe('A short name for the task.'),
  objective: str().describe('What must be true at the end, and how the owner knows it worked.'),
  goal: str().describe('The standalone instruction, with a {{Name}} placeholder for each parameter.'),
  sites: strs().describe('The sites or services involved, in words.'),
  allowedDomains: strs().describe('Hostnames the agent is kept to (example.test or *.example.test), only when the owner wants that.'),
  accounts: z.array(z.object({ label: z.string(), access: z.enum(['read', 'read_write']) })).nullable().describe("Connected accounts by their label, read or read and change."),
  parameters: z
    .array(
      z.object({
        name: z.string().describe('As in the goal: "Amount" for {{Amount}}.'),
        type: z.enum(PARAMETER_TYPES as unknown as [TaskParameterType, ...TaskParameterType[]]),
        default: str().describe('A fixed default value; never a secret.'),
        memory: str().describe("The label of the owner's memory that holds the default."),
        attribute: str().describe("The name of that memory's value."),
        why: str(),
      }),
    )
    .nullable(),
  outputs: z.array(z.object({ label: z.string(), type: z.enum(OUTPUT_TYPES.filter((t) => t !== 'choice') as [TaskOutputType, ...TaskOutputType[]]), help: str() })).nullable(),
  guardrails: z
    .object({
      confirmRiskyActions: z.boolean().nullable(),
      useSavedLogins: z.boolean().nullable(),
      useSavedIdentity: z.boolean().nullable(),
      useSavedCards: z.boolean().nullable(),
      unattendedPayments: z.enum(UNATTENDED_PAYMENTS).nullable(),
    })
    .nullable()
    .describe('Only the switches given (not null) change.'),
  needsBrowser: z.enum(NEEDS_BROWSER).nullable(),
  policy: z.object({ ref: z.string().nullable().describe("A policy reference from list_policies; null for the owner's default."), why: str() }).nullable(),
  schedules: z
    .array(
      z.object({
        cron: z.string().describe('5-field cron, e.g. "0 9 * * 1-5".'),
        timezone: z.string().describe('An IANA time zone.'),
        inputs: z.array(z.object({ name: z.string(), value: z.string() })).nullable().describe('Preset values for parameters, by parameter name.'),
        description: str(),
      }),
    )
    .nullable(),
  edgeCases: strs(),
  openQuestions: strs(),
  suggestions: strs(),
  clear: z.array(z.enum(CLEARABLE_FIELDS)).nullable().describe('Fields to remove from the spec.'),
});
export type UpdateSpecArgs = z.infer<typeof updateSpecParameters>;

/** An object without its null (or absent) fields. */
function present<T extends Record<string, unknown>>(o: T): Partial<{ [K in keyof T]: NonNullable<T[K]> }> {
  return Object.fromEntries(Object.entries(o).filter(([, v]) => v !== null && v !== undefined)) as Partial<{ [K in keyof T]: NonNullable<T[K]> }>;
}

/**
 * The spec change the tool's arguments ask for: a field given (not null) replaces the spec's, a field named in `clear` is removed, every other
 * field is left alone. Absent fields count as null, so a partial call (or a model that leaves keys out) changes only what it names.
 */
export function toSpecPatch(args: Partial<UpdateSpecArgs>): TaskBuilderSpecPatch {
  const a = (args ?? {}) as Partial<UpdateSpecArgs>;
  const patch: Record<string, unknown> = {};
  for (const k of ['name', 'objective', 'goal', 'sites', 'allowedDomains', 'edgeCases', 'openQuestions', 'suggestions', 'needsBrowser'] as const) if (a[k] !== null && a[k] !== undefined) patch[k] = a[k];
  if (a.accounts) patch.accounts = a.accounts.map((x) => present(x));
  if (a.parameters) patch.parameters = a.parameters.map((p) => present(p));
  if (a.outputs) patch.outputs = a.outputs.map((o) => present(o));
  if (a.guardrails) {
    const g = present(a.guardrails);
    if (Object.keys(g).length) patch.guardrails = g;
  }
  if (a.policy) patch.policy = { ref: a.policy.ref ?? null, ...(a.policy.why ? { why: a.policy.why } : {}) };
  if (a.schedules) {
    patch.schedules = a.schedules.map((s) => {
      const { inputs, ...rest } = present(s);
      return { ...rest, ...(inputs && inputs.length ? { inputs: Object.fromEntries(inputs.map((i) => [i.name, i.value])) } : {}) };
    });
  }
  for (const k of a.clear ?? []) if (!(k in patch)) patch[k] = null;
  return patch as TaskBuilderSpecPatch;
}
