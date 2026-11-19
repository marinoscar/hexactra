// Task output definitions (E39.5, #600): the zod shape of `tasks.outputs` (what a task asks its runs to return), and the
// readers of what a run keeps (`runs.outputs_spec`, `runs.outputs`). The types and the value rules are the shared ones
// (`@app/shared/task-fields`), so the web form, the CLI and the API read an output the same way.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';
import { MAX_OUTPUTS, MAX_OUTPUT_HELP_LENGTH, MAX_OUTPUT_KEY_LENGTH, MAX_OUTPUT_LABEL_LENGTH, OUTPUT_TYPES, type OutputValue, type StoredOutput, type TaskOutput } from '@app/shared/task-fields';

export type { OutputValue, StoredOutput, TaskOutput } from '@app/shared/task-fields';

export const taskOutputSchema = z
  .object({
    key: z
      .string()
      .trim()
      .min(1)
      .max(MAX_OUTPUT_KEY_LENGTH)
      .optional()
      .describe('snake_case, unique in the task, 1 to 40 characters (lower-case letters, digits, `_`). Derived from the label when omitted.'),
    label: z.string().trim().min(1).max(MAX_OUTPUT_LABEL_LENGTH).describe('What a person reads: "Confirmation number".'),
    type: z.enum(['text', 'number', 'money', 'date', 'datetime', 'boolean', 'url', 'choice'] satisfies typeof OUTPUT_TYPES).default('text').describe('text, number, money, date, datetime, boolean, url or choice.'),
    required: z.boolean().default(true).describe('The agent must give a value; if it cannot find one it is asked again, twice at most, and then the run ends with the output marked "not found".'),
    options: z.array(z.string().trim().min(1).max(100)).max(50).optional().describe('choice: 2 to 50 options.'),
    help: z.string().trim().max(MAX_OUTPUT_HELP_LENGTH).optional().describe('What to look for, one line. The agent reads it.'),
    sensitive: z.boolean().optional().describe('Masked wherever a person or an export sees it, and never sent to an AI app. The value is still stored.'),
  })
  .strict();

export const taskOutputsField = z
  .array(taskOutputSchema)
  .max(MAX_OUTPUTS)
  .describe(
    'The values the agent must return when it finishes, by name. Stored on each run (`GET /runs/{id}` `outputs`) and listed per task (`GET /tasks/{id}/outputs`). Runs started from the task use these definitions; a schedule, the API and MCP cannot redefine them. An empty list removes them.',
  );

/** A task's outputs as stored (an empty list for none). */
export function readOutputs(raw: unknown): TaskOutput[] {
  return Array.isArray(raw) ? (raw as TaskOutput[]) : [];
}

/** What a run stored: `{ [key]: { value, ok, note? } }`, or an empty object. */
export function readStoredOutputs(raw: unknown): Record<string, StoredOutput> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
  return raw as Record<string, StoredOutput>;
}

/** One output of a run as an API shows it: the definition as of the run's start joined with the value, masked. */
export interface OutputView {
  key: string;
  label: string;
  type: TaskOutput['type'];
  required: boolean;
  sensitive: boolean;
  value: OutputValue;
  ok: boolean;
  note: string | null;
}

/** `GET /tasks/{id}/outputs` query. */
export const taskOutputsQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(20).describe('Runs to return, 1 to 100. Default 20.'),
  cursor: z.string().min(1).max(400).optional().describe("The previous page's `nextCursor`. Opaque: do not parse or build it."),
});
export class TaskOutputsQueryDto extends createZodDto(taskOutputsQuerySchema) {}
