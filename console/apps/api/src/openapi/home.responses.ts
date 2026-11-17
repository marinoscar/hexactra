// The response shape of the Home summary (#430), for the OpenAPI document and
// the generated SDK. `@ApiDataResponse` wraps it in the platform's `{ data }` envelope.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { RUN_STOP_REASONS } from '../runner/budget';

const iso = z.string().describe('ISO 8601 timestamp');
const tier = z.enum(['fast', 'standard', 'frontier']);
const trigger = z.enum(['manual', 'schedule', 'api', 'mcp', 'external']);

const homeQuestionSchema = z.object({
  questionId: z.uuid(),
  runId: z.uuid().nullable().describe('Null for a free-standing question'),
  kind: z.string().describe('Why it is asked: captcha, code, passkey, login, confirmation or other'),
  input: z.enum(['none', 'text', 'secret', 'choice', 'multi_choice', 'number', 'confirm', 'takeover']),
  prompt: z.string().describe('At most 300 characters'),
  risk: z.enum(['low', 'high']).nullable().describe('Of a `confirm` question'),
  expiresAt: iso,
  createdAt: iso,
  goal: z.string().nullable().describe('The goal of the run that asked (at most 300 characters); null for a free-standing question'),
});

const homeActivitySchema = z
  .object({
    phase: z.string().describe('starting, looking, thinking or acting'),
    action: z.string().nullable().describe("The action's name; its arguments are never here"),
    reason: z.string().nullable(),
    startedAt: iso.nullable(),
    note: z.string().nullable().describe('Why the run is on a stronger model, while it is'),
  })
  .describe('What a running run is doing right now, without arguments or coordinates');

const homeLiveRunSchema = z.object({
  id: z.uuid(),
  taskId: z.uuid().nullable(),
  taskName: z.string().nullable(),
  goal: z.string().describe('At most 300 characters'),
  status: z.enum(['queued', 'running', 'waiting_human']),
  activity: homeActivitySchema.nullable().describe('Only while `running`'),
  stepCount: z.number().int(),
  startedAt: iso.nullable(),
  hostId: z.uuid().nullable(),
  hostName: z.string().nullable().describe('Null without `fleet:read`, or when the host is not in the fleet list'),
  policyName: z.string().nullable().describe('Null until the run has started'),
  currentTier: tier.nullable(),
  startTier: tier.nullable().describe('The tier the policy starts on: the run has escalated when `currentTier` differs'),
  budgetPercent: z.number().nullable().describe("The highest percent used among the run's limited budgets; null when every budget is unlimited or the run has not started"),
  budgetWarnPercent: z.number().nullable().describe('The percent at which the policy warns; null with `budgetPercent`'),
});

const homeRecentRunSchema = z.object({
  id: z.uuid(),
  taskId: z.uuid().nullable(),
  taskName: z.string().nullable(),
  goal: z.string().describe('At most 300 characters'),
  status: z.enum(['succeeded', 'failed', 'cancelled']),
  trigger,
  createdAt: iso,
  startedAt: iso.nullable(),
  finishedAt: iso.nullable(),
  stepCount: z.number().int(),
  stopReason: z.enum(RUN_STOP_REASONS).nullable(),
  costUsd: z.number().nullable().describe('USD; null for a run that made no model call; a lower bound while `costKnown` is false'),
  costKnown: z.boolean(),
  error: z.string().nullable().describe("The first line of a failed run's error (at most 300 characters), as `GET /runs` returns it; null otherwise"),
});

export const homeSummaryResponseSchema = z.object({
  generatedAt: iso,
  timezone: z.string().describe('The zone the week is bucketed in: the profile time zone, else the `X-Time-Zone` header, else UTC'),
  needsYou: z
    .object({ count: z.number().int().describe('Every pending question, not only the listed ones'), items: z.array(homeQuestionSchema).describe('At most 3: the ones that expire first') })
    .nullable()
    .describe('Questions waiting for the user. Needs `runs:read`; null without it. Never an answer or a secret.'),
  liveRuns: z
    .object({ count: z.number().int(), running: z.number().int().describe('How many of `count` are running; the others wait for a person or a machine'), items: z.array(homeLiveRunSchema).describe('At most 6: running first, then waiting for a person, then queued; newest first within each') })
    .nullable()
    .describe('Runs that are not finished. Needs `runs:read`; null without it.'),
  upcoming: z
    .object({
      items: z
        .array(z.object({ scheduleId: z.uuid(), taskId: z.uuid(), taskName: z.string(), nextRunAt: iso, description: z.string().describe('The schedule in words, e.g. "Monday to Friday at 09:00"'), timezone: z.string() }))
        .describe('At most 5 enabled schedules, the next to fire first'),
      pausedCount: z.number().int().describe('Tasks whose schedules are all paused (`GET /tasks?filter=paused`)'),
      failingCount: z.number().int().describe('Tasks that are failing (`GET /tasks?filter=failing`)'),
    })
    .nullable()
    .describe('What runs next. Needs `tasks:read`; null without it.'),
  recentRuns: z
    .object({ items: z.array(homeRecentRunSchema).describe('At most 8 finished runs, the most recently finished first') })
    .nullable()
    .describe('Needs `runs:read`; null without it.'),
  week: z
    .object({
      totals: z.object({
        succeeded: z.number().int(),
        failed: z.number().int(),
        cancelled: z.number().int(),
        successRate: z.number().nullable().describe('succeeded / (succeeded + failed), 0 to 1; null with neither'),
        costUsd: z.number().nullable().describe('USD spent by the runs created in the period; null when none spent anything'),
        costKnown: z.boolean().describe('False when one of those runs had a call that could not be priced: show `costUsd` as "at least"'),
        budgetStops: z.number().int().describe('Runs stopped by a budget (`stopReason` `budget_*`)'),
        stalled: z.number().int().describe('Runs stopped because they stalled'),
      }),
      series: z
        .array(z.object({ date: z.string().describe('YYYY-MM-DD in `timezone`'), succeeded: z.number().int(), failed: z.number().int(), cancelled: z.number().int(), costUsd: z.number().nullable() }))
        .describe('Seven entries, oldest first, today last; a day without runs is zeros'),
    })
    .nullable()
    .describe('Runs created in the last 7 calendar days. Needs `runs:read`; null without it.'),
  fleet: z
    .object({
      total: z.number().int(),
      online: z.number().int(),
      disabled: z.number().int().describe('Hosts that are draining: they take no new run'),
      stale: z.boolean().describe('True when the fabric did not answer within 1.5 s: the hosts are the last ones read, and may be out of date'),
      hosts: z
        .array(z.object({ id: z.string(), name: z.string(), online: z.boolean(), draining: z.boolean(), mode: z.enum(['unattended', 'attended', 'container']).nullable() }))
        .describe('At most 6: online first, then by name'),
    })
    .nullable()
    .describe('The machines. Needs `fleet:read`; null without it.'),
  counts: z.object({
    tasks: z.number().int().nullable().describe('Null without `tasks:read`'),
    runs: z.number().int().nullable().describe('Null without `runs:read`'),
  }),
});
export class HomeSummaryResponseDto extends createZodDto(homeSummaryResponseSchema) {}
