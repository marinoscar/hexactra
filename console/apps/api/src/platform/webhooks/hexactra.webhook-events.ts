import { WEBHOOKS_PERMISSIONS, registerWebhookEvent } from '@marinoscar/platform-api/webhooks';
import { z } from 'zod';

/** Event keys. PERMANENT. */
export const RUN_STARTED_WEBHOOK = 'runs.run.started';
export const RUN_WAITING_WEBHOOK = 'runs.run.waiting';
export const RUN_FINISHED_WEBHOOK = 'runs.run.finished';
export const SCHEDULE_FAILING_WEBHOOK = 'schedules.schedule.failing';

const run = z.object({
  runId: z.uuid(),
  taskId: z.uuid().nullable(),
  goal: z.string(),
  trigger: z.string(),
  status: z.string(),
});
export const runWebhookSchema = run.extend({
  result: z.string().nullable().optional(),
  error: z.string().nullable().optional(),
  /** What the agent asked the person (runs.run.waiting). Never an answer. */
  prompt: z.string().optional(),
  kind: z.string().optional(),
});
export const scheduleFailingWebhookSchema = z.object({ scheduleId: z.uuid(), taskName: z.string(), failures: z.number().int() });

const example = {
  runId: '00000000-0000-4000-8000-000000000001',
  taskId: '00000000-0000-4000-8000-000000000002',
  goal: 'Find the cheapest fare to the example city',
  trigger: 'manual',
  status: 'succeeded',
  result: 'Found a fare for 120.',
};

let done = false;
/** Adds the console's events to the webhook catalog (once, before bootstrap). */
export function registerHexactraWebhookEvents(): void {
  if (done) return;
  done = true;
  const base = { group: 'Browser runs', audience: 'user' as const, permission: WEBHOOKS_PERMISSIONS.WEBHOOKS_READ.id, source: 'hexactra' };
  registerWebhookEvent({ ...base, key: RUN_STARTED_WEBHOOK, label: 'Run started', description: 'A run of yours started.', payloadSchema: runWebhookSchema, example: { ...example, status: 'running', result: undefined } });
  registerWebhookEvent({
    ...base,
    key: RUN_WAITING_WEBHOOK,
    label: 'Run waiting for you',
    description: 'A run needs a person: a CAPTCHA, a code, a sign-in or a confirmation.',
    payloadSchema: runWebhookSchema,
    example: { ...example, status: 'waiting_human', result: undefined, prompt: 'Enter the code sent to your phone', kind: 'code' },
  });
  registerWebhookEvent({ ...base, key: RUN_FINISHED_WEBHOOK, label: 'Run finished', description: 'A run of yours succeeded, failed or was cancelled.', payloadSchema: runWebhookSchema, example });
  registerWebhookEvent({
    ...base,
    group: 'Schedules',
    key: SCHEDULE_FAILING_WEBHOOK,
    label: 'Schedule failing',
    description: 'A scheduled task failed three times in a row.',
    payloadSchema: scheduleFailingWebhookSchema,
    example: { scheduleId: '00000000-0000-4000-8000-000000000003', taskName: 'Daily fare check', failures: 3 },
  });
}
