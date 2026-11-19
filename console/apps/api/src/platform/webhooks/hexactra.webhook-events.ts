import { WEBHOOKS_PERMISSIONS, registerWebhookEvent } from '@marinoscar/platform-api/webhooks';
import { z } from 'zod';

import { runOutputResponseSchema } from '../../openapi/console.responses';

/** Event keys. PERMANENT. */
export const RUN_STARTED_WEBHOOK = 'runs.run.started';
export const RUN_WAITING_WEBHOOK = 'runs.run.waiting';
export const RUN_FINISHED_WEBHOOK = 'runs.run.finished';
export const SCHEDULE_FAILING_WEBHOOK = 'schedules.schedule.failing';
export const QUESTION_ASKED_WEBHOOK = 'questions.question.asked';
export const QUESTION_ANSWERED_WEBHOOK = 'questions.question.answered';
export const QUESTION_CANCELLED_WEBHOOK = 'questions.question.cancelled';
export const QUESTION_EXPIRED_WEBHOOK = 'questions.question.expired';

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
  /**
   * `runs.run.finished`: what the run returned (E39.5, #600), each with the label and type it started with. Additive: absent for a
   * run whose task has no outputs. A sensitive output is `[hidden]`: a webhook never carries it.
   */
  outputs: z.array(runOutputResponseSchema).optional(),
  /** `runs.run.finished` (E39.6): whether every output was returned and valid; null when the run has no outputs. Present with `outputs`. */
  outputsComplete: z.boolean().nullable().optional(),
  /** `runs.run.finished` (E39.6): a signed link to the run's masked PDF report, valid 7 days, for this run only (`GET /api/reports/{token}`, no session). */
  reportUrl: z.string().optional(),
  /** `runs.run.finished` (E39.6): where the run is read in the console. */
  runUrl: z.string().optional(),
});
export const scheduleFailingWebhookSchema = z.object({ scheduleId: z.uuid(), taskName: z.string(), failures: z.number().int() });

const option = z.object({ id: z.string(), label: z.string(), description: z.string().optional() });
/** The question as a webhook sees it. Never an answer. */
const questionSchema = z.object({
  id: z.uuid(),
  prompt: z.string(),
  input: z.string(),
  kind: z.string(),
  options: z.array(option).nullable(),
  constraints: z.record(z.string(), z.unknown()).nullable(),
  confirmLabel: z.string().nullable(),
  denyLabel: z.string().nullable(),
  risk: z.enum(['low', 'high']).nullable(),
  expiresAt: z.string(),
  runId: z.uuid().nullable(),
});
/**
 * `questions.question.asked`. `answer` is present only when the receiver may
 * answer (choice, multi_choice, text, number, a low-risk confirm): POST the
 * answer body (`{outcome?, value?, values?}`) to `url` with the token in the
 * `x-question-token` header, once, before `expiresAt`. Never for a secret,
 * a takeover, `none` or a high-risk confirm (those open the console).
 */
export const questionAskedWebhookSchema = z.object({
  question: questionSchema,
  answer: z
    .object({
      url: z.string(),
      token: z.string(),
      method: z.literal('POST'),
      tokenHeader: z.literal('x-question-token'),
      expiresAt: z.string(),
    })
    .optional(),
});
/**
 * `questions.question.answered|cancelled|expired`: how it ended. `value` /
 * `values` only for a public answer; a secret question never carries one
 * (`valueWithheld`).
 */
export const questionSettledWebhookSchema = z.object({
  question: z.object({ id: z.uuid(), input: z.string(), kind: z.string(), runId: z.uuid().nullable() }),
  status: z.enum(['answered', 'cancelled', 'expired']),
  outcome: z.enum(['completed', 'cancelled']).optional(),
  value: z.string().optional(),
  values: z.array(z.string()).optional(),
  valueWithheld: z.boolean().optional(),
  channel: z.string().nullable().optional(),
  answeredAt: z.string().nullable().optional(),
});

const questionExample = {
  id: '00000000-0000-4000-8000-000000000004',
  prompt: 'Which fare should I book?',
  input: 'choice',
  kind: 'other',
  options: [
    { id: 'early', label: '7:05 flight' },
    { id: 'late', label: '18:40 flight' },
  ],
  constraints: null,
  confirmLabel: null,
  denyLabel: null,
  risk: null,
  expiresAt: '2030-01-01T12:00:00.000Z',
  runId: null,
};

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
  const questions = { ...base, group: 'Questions' };
  registerWebhookEvent({
    ...questions,
    key: QUESTION_ASKED_WEBHOOK,
    label: 'Question asked',
    description: 'An agent asks you something; public answers can be sent back with the single-use token.',
    payloadSchema: questionAskedWebhookSchema,
    example: {
      question: questionExample,
      answer: { url: 'https://console.example.test/api/questions/00000000-0000-4000-8000-000000000004/answer-by-token', token: 'single-use-token', method: 'POST', tokenHeader: 'x-question-token', expiresAt: questionExample.expiresAt },
    },
  });
  const settled = { id: questionExample.id, input: 'choice', kind: 'other', runId: null };
  registerWebhookEvent({
    ...questions,
    key: QUESTION_ANSWERED_WEBHOOK,
    label: 'Question answered',
    description: 'A question was answered (on any channel). Carries the value of a public answer, never a secret.',
    payloadSchema: questionSettledWebhookSchema,
    example: { question: settled, status: 'answered', outcome: 'completed', value: 'early', valueWithheld: false, channel: 'web', answeredAt: '2030-01-01T11:00:00.000Z' },
  });
  registerWebhookEvent({
    ...questions,
    key: QUESTION_CANCELLED_WEBHOOK,
    label: 'Question declined',
    description: 'A question was declined or withdrawn.',
    payloadSchema: questionSettledWebhookSchema,
    example: { question: settled, status: 'cancelled', outcome: 'cancelled', valueWithheld: false, channel: 'web', answeredAt: '2030-01-01T11:00:00.000Z' },
  });
  registerWebhookEvent({
    ...questions,
    key: QUESTION_EXPIRED_WEBHOOK,
    label: 'Question expired',
    description: 'A question was not answered in time.',
    payloadSchema: questionSettledWebhookSchema,
    example: { question: settled, status: 'expired' },
  });
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
