// Request shapes of the task list, the task's schedule set and the task
// statistics (#424). The task create and update bodies are in tasks.schemas.ts.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { policyRefSchema } from '../policies/policies.schemas';
import { taskInputsField } from './task-params.schemas';

/** Failed scheduled runs in a row after which a schedule is "failing": the owner is told, and the task list's `failing` filter matches. */
export const FAILING_AFTER = 3;

/** A task has at most this many schedules, on every path (409 `SCHEDULE_LIMIT`). */
export const SCHEDULE_LIMIT = 10;

/**
 * One schedule inside a task request (`POST /tasks`, `PUT /tasks/:id/schedules`).
 * `cron` and `timezone` are checked by the service, not here, so an invalid one
 * is reported with its typed code and its place in the list (`schedules[1].cron`).
 */
export const taskScheduleItemSchema = z.object({
  cron: z.string().trim().min(1).max(100).describe('A 5-field cron expression that fires at most every 5 minutes, e.g. `0 9 * * 1-5`.'),
  timezone: z.string().trim().min(1).max(64).optional().describe("An IANA time zone. Omitted: the owner's profile time zone (see `GET /schedules/defaults`); on an existing schedule, the zone it has."),
  enabled: z.boolean().optional().describe('Omitted: `true` for a new schedule, unchanged for an existing one.'),
  concurrency: z.enum(['skip', 'queue']).optional().describe('`skip` (default) skips a firing while an earlier run of the task is live; `queue` starts it anyway.'),
  policyId: policyRefSchema.nullable().optional().describe("Overrides the task's agent policy for this schedule's runs; `null` follows the task. Omitted on an existing schedule: unchanged."),
  inputs: taskInputsField
    .nullable()
    .optional()
    .describe("Preset values for the task's parameters (#552), by key or name. An enabled schedule needs a value (here, a default or a memory) for every required parameter: 400 `SCHEDULE_INPUTS_MISSING`. Omitted on an existing schedule: unchanged."),
});
export type TaskScheduleItem = z.infer<typeof taskScheduleItemSchema>;

/** The schedules of a new task. */
export const taskSchedulesField = z
  .array(taskScheduleItemSchema)
  .max(SCHEDULE_LIMIT)
  .describe('Schedules created with the task, in the same transaction: one invalid schedule and nothing is created.');

export const replaceTaskSchedulesSchema = z.object({
  schedules: z
    .array(taskScheduleItemSchema.extend({ id: z.uuid().optional().describe("An existing schedule of this task to update. Omitted: a new schedule. This task's schedules that are not listed are deleted.") }))
    .max(SCHEDULE_LIMIT),
});
export class ReplaceTaskSchedulesDto extends createZodDto(replaceTaskSchedulesSchema) {}
export type ReplaceTaskScheduleItem = z.infer<typeof replaceTaskSchedulesSchema>['schedules'][number];

export const TASK_FILTERS = ['scheduled', 'paused', 'unscheduled', 'failing', 'never_run'] as const;
export const TASK_SORTS = ['created_desc', 'name_asc', 'last_run_desc', 'next_run_asc', 'spend_desc'] as const;
export type TaskSort = (typeof TASK_SORTS)[number];

/** An empty query value (`?q=`) is the parameter left out. */
const blank = (v: unknown) => (typeof v === 'string' && v.trim() === '' ? undefined : v);

const includeSummary = z.preprocess(blank, z.literal('summary').optional()).describe('`summary` adds a `summary` object to each task: its schedules, next run, last run, live run, run counts and the policy that applies.');

export const listTasksSchema = z.object({
  envelope: z
    .preprocess(blank, z.enum(['1', 'true']).optional())
    .describe('`1` returns `{ items, nextCursor, total }` instead of an array.'),
  include: includeSummary,
  q: z.preprocess(blank, z.string().trim().min(1).max(200).optional()).describe('Case-insensitive substring of the name or the goal.'),
  filter: z
    .preprocess(blank, z.enum(TASK_FILTERS).optional())
    .describe('`scheduled`: at least one enabled schedule. `paused`: has schedules, none enabled. `unscheduled`: no schedule. `failing`: a schedule failed 3 times in a row, or the last run failed. `never_run`: no run.'),
  policyId: z
    .preprocess(blank, z.union([z.literal('default'), policyRefSchema]).optional())
    .describe("Tasks whose own policy is this one (a UUID or `builtin:<key>`); `default` is the tasks that follow the user's default policy."),
  sort: z
    .preprocess(blank, z.enum(TASK_SORTS).default('created_desc'))
    .describe('`created_desc` (default), `name_asc`, `last_run_desc`, `next_run_asc` (tasks with no next run last), `spend_desc` (cost of the last 30 days).'),
  limit: z.preprocess(blank, z.coerce.number().int().min(1).max(100).optional()).describe('Page size, 1 to 100. Default 50 with `envelope`; without `envelope` and without `limit` every task is returned, as before.'),
  cursor: z.preprocess(blank, z.string().max(600).optional()).describe('The `nextCursor` of the previous page (with the same `sort`). Opaque: do not parse it.'),
});
export class ListTasksDto extends createZodDto(listTasksSchema) {}

export const getTaskQuerySchema = z.object({ include: includeSummary });
export class GetTaskQueryDto extends createZodDto(getTaskQuerySchema) {}

export const taskStatsQuerySchema = z.object({
  days: z.preprocess(blank, z.coerce.number().int().min(7).max(90).default(30)).describe('How many calendar days back, today included (7 to 90).'),
});
export class TaskStatsQueryDto extends createZodDto(taskStatsQuerySchema) {}
