// Response shapes of the task list, the task summary, the schedule preview and
// the task statistics (#424), for the OpenAPI document and the generated SDK.
// `@ApiDataResponse` wraps each in the platform's `{ data }` envelope.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { RUN_STOP_REASONS } from '../runner/budget';
import { taskResponseSchema } from './console.responses';

const iso = z.string().describe('ISO 8601 timestamp');
const runStatus = z.enum(['queued', 'running', 'waiting_human', 'succeeded', 'failed', 'cancelled']);

export const taskSummaryScheduleSchema = z.object({
  id: z.uuid(),
  cron: z.string(),
  timezone: z.string(),
  enabled: z.boolean(),
  concurrency: z.enum(['skip', 'queue']),
  nextRunAt: iso.nullable(),
  lastRunAt: iso.nullable(),
  consecutiveFailures: z.number().int().describe('Failed scheduled runs in a row; 3 or more is "failing"'),
  description: z.string().describe('The expression in words (English, 24-hour), e.g. "Monday to Friday at 09:00"; "Custom schedule (<expr>)" for one the builder does not write'),
  policyId: z.string().nullable().describe("Overrides the task's agent policy for this schedule's runs; null follows the task"),
});

export const taskSummarySchema = z
  .object({
    schedules: z.array(taskSummaryScheduleSchema).describe('Oldest first'),
    scheduleState: z.enum(['none', 'active', 'paused', 'partial']).describe('`none`: no schedule. `active`: all enabled. `paused`: none enabled. `partial`: some enabled, some not.'),
    nextRunAt: iso.nullable().describe('The earliest next firing among the enabled schedules'),
    lastRun: z
      .object({ id: z.uuid(), status: runStatus, trigger: z.enum(['manual', 'schedule', 'api', 'mcp', 'external', 'chat']), createdAt: iso, finishedAt: iso.nullable() })
      .nullable()
      .describe('The newest run of the task'),
    liveRunId: z.uuid().nullable().describe('The newest run that is queued, running or waiting for a person'),
    runCounts: z.object({
      total: z.number().int().describe('Runs of the task that still exist'),
      last7d: z.object({ succeeded: z.number().int(), failed: z.number().int(), cancelled: z.number().int() }).describe('Runs created in the last 7 days, by outcome'),
    }),
    policy: z
      .object({
        id: z.string().describe('A UUID, or `builtin:<key>`'),
        name: z.string(),
        builtin: z.boolean(),
        isDefault: z.boolean().describe("True when it is the policy the user's default resolves to"),
      })
      .nullable()
      .describe("The agent policy a run started now would use: the task's, else the user's default, else `builtin:balanced` (a deleted policy falls through). Null only when it could not be resolved."),
  })
  .describe('Schedule and run facts of the task, present with `include=summary`');

export const taskWithSummarySchema = taskResponseSchema.extend({ summary: taskSummarySchema });
export class TaskWithSummaryResponseDto extends createZodDto(taskWithSummarySchema) {}

/** `GET /tasks/:id`: `summary` only with `include=summary`. */
export const taskDetailSchema = taskResponseSchema.extend({ summary: taskSummarySchema.optional() });
export class TaskDetailResponseDto extends createZodDto(taskDetailSchema) {}

export const taskPageSchema = z.object({
  items: z.array(taskDetailSchema),
  nextCursor: z.string().nullable().describe('Pass as `cursor` for the next page; null on the last page. Opaque.'),
  total: z.number().int().describe('Tasks that match `q`, `filter` and `policyId`, on every page'),
});
export class TaskPageResponseDto extends createZodDto(taskPageSchema) {}

export class TaskSchedulesChangedResponseDto extends createZodDto(
  taskWithSummarySchema.extend({ skipped: z.array(z.uuid()).describe('Resume only: schedules left as they were because their stored expression is no longer valid. Normally empty.') }),
) {}

/** One object for both answers (a class cannot extend a union): `valid` says which fields are present. */
export const schedulePreviewSchema = z.object({
  valid: z.boolean().describe('True: `cron`, `timezone`, `description`, `next` and `intervalSeconds` are present. False: `code` and `message` are.'),
  cron: z.string().optional(),
  timezone: z.string().optional().describe('The zone the firings were computed in: the one sent, or the default'),
  description: z.string().optional().describe('The expression in words (English, 24-hour), e.g. "Monday to Friday at 09:00"'),
  next: z.array(iso).optional().describe('The next `count` firings, ascending'),
  intervalSeconds: z
    .number()
    .int()
    .nullable()
    .optional()
    .describe('Seconds between firings when the next ones are evenly spaced; null for an uneven schedule (week days, days of the month, a daylight-saving change)'),
  code: z.enum(['INVALID_CRON', 'INVALID_TIMEZONE', 'CRON_TOO_FREQUENT']).optional().describe('Why the schedule would be refused'),
  message: z.string().optional(),
});
export class SchedulePreviewResponseDto extends createZodDto(schedulePreviewSchema) {}

export class ScheduleDefaultsResponseDto extends createZodDto(
  z.object({
    timezone: z.string().describe('The zone a schedule gets when its request names none'),
    source: z.enum(['profile', 'device', 'default']).describe("`profile`: the user's profile time zone. `device`: the profile follows the device and the request carried `X-Time-Zone`. `default`: neither, so UTC."),
  }),
) {}

export const taskStatsSchema = z.object({
  days: z.number().int(),
  timezone: z.string().describe('The zone the days are bucketed in'),
  totals: z.object({
    runs: z.number().int().describe('Runs created in the period, live ones included'),
    succeeded: z.number().int(),
    failed: z.number().int(),
    cancelled: z.number().int(),
    successRate: z.number().nullable().describe('succeeded / (succeeded + failed), 0 to 1; null when no run succeeded or failed'),
    costUsd: z.number().nullable().describe('USD spent by the runs of the period; null when none of them has a cost'),
    costKnown: z.boolean().describe('False when a run of the period had a call that could not be priced: `costUsd` is then "at least"'),
  }),
  avgDurationSeconds: z.number().nullable().describe('Mean of finishedAt - startedAt over the finished runs that started'),
  p95DurationSeconds: z.number().nullable(),
  avgSteps: z.number().nullable().describe('Mean step count of the finished runs'),
  avgCostPerSuccessUsd: z.number().nullable().describe('Mean cost of the succeeded runs that have a cost'),
  series: z
    .array(z.object({ date: z.string().describe('YYYY-MM-DD'), succeeded: z.number().int(), failed: z.number().int(), cancelled: z.number().int(), costUsd: z.number().nullable() }))
    .describe('One entry per calendar day, oldest first, zeros included'),
  stopReasons: z
    .array(z.object({ reason: z.union([z.enum(RUN_STOP_REASONS), z.literal('unknown')]).describe('`unknown`: a run from before stop reasons were recorded'), count: z.number().int() }))
    .describe('Finished runs of the period by why they stopped, most frequent first'),
});
export class TaskStatsResponseDto extends createZodDto(taskStatsSchema) {}
