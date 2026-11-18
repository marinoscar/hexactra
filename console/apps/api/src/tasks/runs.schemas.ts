// The runs list (#420): the shared run filter, the list and counts queries.
// `runFilterSchema` is what "which runs" means everywhere: the list, the counts,
// delete by filter (#421) and retention (#422) all build their WHERE from it with
// `runWhere` (runs.query.ts), so what a list shows and what an action touches
// cannot differ.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { policyRefSchema } from '../policies/policies.schemas';
import { RUN_STOP_REASONS } from '../runner/budget';
import { RUN_ORIGINS } from '../connected-apps/request-client';
import { TERMINAL_RUN_STATUSES, type RunStatus } from './run-status';

export const RUN_STATUSES = ['queued', 'running', 'waiting_human', 'succeeded', 'failed', 'cancelled'] as const satisfies readonly RunStatus[];
export const RUN_TRIGGERS = ['manual', 'schedule', 'api', 'mcp', 'external', 'chat'] as const;
export type RunTrigger = (typeof RUN_TRIGGERS)[number];

/** A run that is not finished: it can still change, and is never deleted (#418). */
export const LIVE_RUN_STATUSES = ['queued', 'running', 'waiting_human'] as const satisfies readonly RunStatus[];
/** `state=live|finished`: shorthand for the two status groups. */
export const RUN_STATES = { live: LIVE_RUN_STATUSES, finished: TERMINAL_RUN_STATUSES } as const satisfies Record<string, readonly RunStatus[]>;

/** `stopReason=budget`: every `budget_*` stop reason. */
export const BUDGET_STOP_REASONS = RUN_STOP_REASONS.filter((r) => r.startsWith('budget_'));
/** What `stopReason` filters by: a stop reason, or `budget` for every `budget_*` one. */
export const STOP_REASON_FILTERS = [...RUN_STOP_REASONS, 'budget'] as const;

/**
 * A list parameter: repeated (`?status=a&status=b`), comma-separated
 * (`?status=a,b`), a JSON array in a body, or one value. Empty means absent.
 */
function listOf<const T extends readonly [string, ...string[]]>(values: T, what: string) {
  return z
    .union([z.string(), z.array(z.string())])
    .transform((v) => [...new Set((Array.isArray(v) ? v : [v]).flatMap((s) => s.split(',')).map((s) => s.trim()).filter(Boolean))])
    .pipe(z.array(z.enum(values)))
    .transform((v) => (v.length > 0 ? v : undefined))
    .optional()
    .describe(`${what} Any of: ${values.join(', ')}. Repeat the parameter or separate the values with commas.`);
}

/**
 * Which runs: every list parameter except the paging ones (`envelope`,
 * `cursor`, `limit`, `order`). `status` and `state` are mutually exclusive and
 * `from` must not be after `to`: `runWhere` rejects both with `INVALID_FILTER`.
 */
export const runFilterSchema = z.object({
  status: listOf(RUN_STATUSES, 'Run status.'),
  state: z.enum(['live', 'finished']).optional().describe('Shorthand for a status group: `live` = queued, running, waiting_human; `finished` = succeeded, failed, cancelled. Not together with `status`.'),
  taskId: z.union([z.literal('none'), z.uuid()]).optional().describe("A task's id, or `none` for runs without a task (ad-hoc and external runs)."),
  trigger: listOf(RUN_TRIGGERS, 'What started the run.'),
  from: z.iso.datetime({ offset: true }).optional().describe('Runs created at or after this ISO 8601 date-time (inclusive).'),
  to: z.iso.datetime({ offset: true }).optional().describe('Runs created before this ISO 8601 date-time (exclusive).'),
  q: z
    .string()
    .trim()
    .max(200)
    .transform((v) => v || undefined)
    .optional()
    .describe('Case-insensitive substring of the goal (1 to 200 characters).'),
  stopReason: listOf(STOP_REASON_FILTERS, 'Why the run stopped; `budget` is every `budget_*` reason.'),
  policyId: policyRefSchema.optional().describe("Runs that ran under this agent policy: an own policy's UUID or `builtin:<key>`."),
  origin: listOf(RUN_ORIGINS, 'Where the run was started from (#464).'),
  clientId: z.uuid().optional().describe('Runs started by this AI app: its OAuth client id (`client.id` of a run, `clientId` of `GET /connected-apps`).'),
});
export type RunFilter = z.infer<typeof runFilterSchema>;

/** The largest page of the envelope form; the plain array keeps its earlier maximum. */
export const RUNS_PAGE_MAX = 100;
export const RUNS_ARRAY_MAX = 200;

export const listRunsSchema = runFilterSchema
  .extend({
    envelope: z
      .enum(['1', 'true'])
      .transform(() => true)
      .optional()
      .describe('`1` returns `{ items, nextCursor }` instead of an array.'),
    cursor: z.string().min(1).max(400).optional().describe("The previous page's `nextCursor`. Opaque: do not parse or build it."),
    limit: z.coerce.number().int().min(1).max(RUNS_ARRAY_MAX).default(50).describe(`Rows to return: 1 to ${RUNS_PAGE_MAX} with \`envelope\`, 1 to ${RUNS_ARRAY_MAX} without. Default 50.`),
    order: z.enum(['desc', 'asc']).default('desc').describe('By creation time, then id: `desc` is newest first.'),
  })
  .superRefine((q, ctx) => {
    if (q.envelope && q.limit > RUNS_PAGE_MAX) ctx.addIssue({ code: 'custom', path: ['limit'], message: `At most ${RUNS_PAGE_MAX} with envelope` });
  });
export class ListRunsDto extends createZodDto(listRunsSchema) {}

/** `GET /runs/counts`: the filter without `status` and `state` (the counts are per status). */
export const runCountsQuerySchema = runFilterSchema.omit({ status: true, state: true });
export class RunCountsQueryDto extends createZodDto(runCountsQuerySchema) {}
