// Fixtures for the Tasks list (#426): a task with its summary, as
// `GET /api/tasks?envelope=1&include=summary` serves it.
import type { TaskPage, TaskSummary, TaskSummarySchedule, TaskWithSummary } from '../types/tasks';

export const TASK_ID = '11111111-1111-4111-8111-111111111111';
export const OTHER_ID = '22222222-2222-4222-8222-222222222222';
export const RUN_ID = '33333333-3333-4333-8333-333333333333';

export function schedule(extra: Partial<TaskSummarySchedule> = {}): TaskSummarySchedule {
  return {
    id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
    cron: '0 9 * * 1-5',
    timezone: 'UTC',
    enabled: true,
    concurrency: 'skip',
    nextRunAt: '2099-01-05T09:00:00Z',
    lastRunAt: null,
    consecutiveFailures: 0,
    description: 'Monday to Friday at 09:00',
    policyId: null,
    ...extra,
  };
}

export function summary(extra: Partial<TaskSummary> = {}): TaskSummary {
  return {
    schedules: [],
    scheduleState: 'none',
    nextRunAt: null,
    lastRun: null,
    liveRunId: null,
    runCounts: { total: 0, last7d: { succeeded: 0, failed: 0, cancelled: 0 } },
    policy: { id: 'builtin:balanced', name: 'Balanced', builtin: true, isDefault: true },
    ...extra,
  };
}

/** A task with a summary; `extra.summary` is merged over an unscheduled, never-run one. */
export function taskRow(extra: Partial<Omit<TaskWithSummary, 'summary'>> & { summary?: Partial<TaskSummary> } = {}): TaskWithSummary {
  const { summary: s, ...task } = extra;
  return {
    id: TASK_ID,
    name: 'Check fare',
    goal: 'Find the cheapest fare',
    profile: 'travel',
    hostId: null,
    hostFallback: true,
    allowedDomains: ['flights.example.test'],
    confirmRiskyActions: false,
    policyId: null,
    ...task,
    summary: summary(s),
  };
}

/** A scheduled task: one active weekday schedule. */
export function scheduledRow(extra: Parameters<typeof taskRow>[0] = {}): TaskWithSummary {
  const { summary: s, ...task } = extra;
  return taskRow({ ...task, summary: { schedules: [schedule()], scheduleState: 'active', nextRunAt: '2099-01-05T09:00:00Z', ...s } });
}

export function page(items: TaskWithSummary[], extra: Partial<TaskPage> = {}): TaskPage {
  return { items, nextCursor: null, total: items.length, ...extra };
}
