// Task parameter definitions (E36.6, #552): the zod shape of `tasks.parameters`
// and of the `inputs` a run or a schedule is given. The syntax and the value
// rules are the shared ones (`@app/shared/task-params`), so the web form and the
// API check a goal the same way.
import { z } from 'zod';
import { IDENTITY_DEFAULT_FIELDS, MAX_PARAMETERS, MAX_VALUE_LENGTH, PARAMETER_TYPES, type TaskParameter } from '@app/shared/task-params';

export type { TaskParameter } from '@app/shared/task-params';

const defaultSchema = z.union([
  z.object({ value: z.string().trim().min(1).max(MAX_VALUE_LENGTH) }).strict(),
  z.object({ memory: z.object({ id: z.uuid(), attribute: z.string().trim().min(1).max(100) }).strict() }).strict(),
  z.object({ identity: z.object({ field: z.enum(IDENTITY_DEFAULT_FIELDS as [string, ...string[]]) }).strict() }).strict(),
]);

export const taskParameterSchema = z
  .object({
    key: z.string().trim().min(1).max(60).describe('The placeholder\'s key: its name lower-cased, spaces, `_` and `-` as one `_` (`Phone Number` → `phone_number`).'),
    label: z.string().trim().min(1).max(80).optional().describe('What a form shows; defaults to the placeholder\'s name.'),
    type: z.enum(['text', 'number', 'money', 'date', 'choice', 'phone', 'email'] satisfies typeof PARAMETER_TYPES).default('text'),
    required: z.boolean().default(true),
    options: z.array(z.string().trim().min(1).max(100)).max(50).optional().describe('choice: 2 to 50 options.'),
    help: z.string().trim().max(200).optional().describe('One line under the field.'),
    default: defaultSchema.optional().describe("A fixed value (`{ value }`), an attribute of one of your memories (`{ memory: { id, attribute } }`), or a field of your saved identity details (`{ identity: { field } }`, E37.6: the goal shows `[provided: <label>]` and the system fills the field without the model seeing it), resolved when the task runs."),
    constraints: z
      .object({ min: z.number().finite().optional(), max: z.number().finite().optional(), maxLength: z.number().int().min(1).max(MAX_VALUE_LENGTH).optional(), pattern: z.string().min(1).max(200).optional() })
      .strict()
      .optional(),
    sensitive: z.boolean().optional().describe('Never stored or shown to the model: asked every time in the signed-in console and typed by the browser. No default; never accepted from the API.'),
  })
  .strict();

export const taskParametersField = z.array(taskParameterSchema).max(MAX_PARAMETERS).describe(
  "Definitions of the goal's `{{Name}}` placeholders. Each placeholder without one gets a required `text` parameter; a definition without a placeholder is dropped. The response lists every parameter.",
);

/** Values for a run or a schedule, by key or by display name. */
export const taskInputsField = z
  .record(z.string().min(1).max(80), z.union([z.string().max(MAX_VALUE_LENGTH), z.number().finite()]))
  .refine((r) => Object.keys(r).length <= MAX_PARAMETERS, { message: `At most ${MAX_PARAMETERS} inputs` })
  .describe("Values for the task's parameters, by key (`phone_number`) or display name (`Phone Number`).");

/** Where a run's value came from. */
export const INPUT_SOURCES = ['provided', 'default', 'memory', 'asked', 'schedule', 'saved_details', 'email'] as const;
export type InputSource = (typeof INPUT_SOURCES)[number];

/** What `runs.inputs` holds: the values and their sources, and the sensitive parameters asked at run time (never their values). */
export interface RunInputs {
  values: Record<string, { value: string; source: InputSource; label: string }>;
  sensitive: { key: string; label: string }[];
  /** Parameters taken from the owner's saved identity details (E37.6): the field to fill, never a value. */
  identity?: { key: string; label: string; field: string }[];
}

/** A task's parameters as stored (an empty list for none). */
export function readParameters(raw: unknown): TaskParameter[] {
  return Array.isArray(raw) ? (raw as TaskParameter[]) : [];
}

export function readRunInputs(raw: unknown): RunInputs | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Partial<RunInputs>;
  return { values: r.values && typeof r.values === 'object' ? r.values : {}, sensitive: Array.isArray(r.sensitive) ? r.sensitive : [], identity: Array.isArray(r.identity) ? r.identity : [] };
}
