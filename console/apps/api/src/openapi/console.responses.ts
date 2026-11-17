// Response shapes of the console's own routes, for the OpenAPI document (and
// so for the generated SDK in packages/sdk). `@ApiDataResponse` wraps each in
// the platform's `{ data }` envelope. They describe what the services return;
// the tests in test/sdk.db.spec.ts exercise them through the SDK.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

const iso = z.string().describe('ISO 8601 timestamp');
const runStatus = z.enum(['queued', 'running', 'waiting_human', 'succeeded', 'failed', 'cancelled']);

export const taskResponseSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  name: z.string(),
  goal: z.string(),
  profile: z.string(),
  hostId: z.uuid().nullable(),
  hostFallback: z.boolean().describe('When the chosen host cannot take a run, run on another available one'),
  allowedDomains: z.array(z.string()),
  maxSteps: z.number().int(),
  maxMinutes: z.number().int(),
  confirmRiskyActions: z.boolean(),
  model: z.string().nullable(),
  spend30d: z
    .object({
      runs: z.number().int().describe('Runs created in the last 30 days'),
      costUsd: z.number().describe('USD spent on model calls by those runs; a lower bound while costKnown is false'),
      costKnown: z.boolean().describe('False when a call of those runs could not be priced (its model has no price)'),
      tokens: z.number().int().describe('Input plus output tokens'),
    })
    .describe("What the task's runs spent in the last 30 days"),
  createdAt: iso,
  updatedAt: iso,
});
export class TaskResponseDto extends createZodDto(taskResponseSchema) {}

export const runActivitySchema = z
  .object({
    phase: z.enum(['starting', 'looking', 'thinking', 'acting']),
    action: z.string().optional().describe('The fabric action being run (acting only)'),
    args: z.record(z.string(), z.unknown()).optional().describe('Redacted like step args'),
    reason: z.string().optional().describe('Why the model chose the action'),
    startedAt: iso,
    timeoutMs: z.number().int().optional().describe('How long the host has before the action times out'),
    target: z
      .object({ x: z.number(), y: z.number(), w: z.number().optional(), h: z.number().optional() })
      .optional()
      .describe('Where on the page it acts, in page screenshot (CSS viewport) pixels: a point, or a box with w and h'),
  })
  .describe('What a running run is doing right now; null when it is not running');

export const runResponseSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  taskId: z.uuid().nullable(),
  status: runStatus,
  trigger: z.enum(['manual', 'schedule', 'api', 'mcp', 'external']),
  goal: z.string(),
  profile: z.string(),
  hostId: z.uuid().nullable(),
  hostFallback: z.boolean(),
  sessionId: z.uuid().nullable(),
  handoffId: z.uuid().nullable(),
  actor: z.string().nullable().describe('Who drove an external run'),
  result: z.string().nullable(),
  error: z.string().nullable(),
  cancelRequested: z.boolean(),
  stepCount: z.number().int(),
  activity: runActivitySchema.nullable(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cachedInputTokens: z.number().int().describe('Input tokens the provider served from its cache (part of inputTokens)'),
  modelCalls: z.number().int().describe('Model calls (provider round trips) made so far'),
  costUsd: z.number().describe('USD spent on model calls, from the admin price table (agentPricing); a lower bound while costKnown is false'),
  costKnown: z.boolean().describe('False once a call could not be priced because its model has no price: show costUsd as "at least"'),
  createdAt: iso,
  startedAt: iso.nullable(),
  finishedAt: iso.nullable(),
});
export class RunResponseDto extends createZodDto(runResponseSchema) {}

export const runStepResponseSchema = z.object({
  id: z.uuid(),
  runId: z.uuid(),
  seq: z.number().int(),
  kind: z.string().describe('action | handoff | finish | error | note'),
  action: z.string().nullable(),
  args: z.record(z.string(), z.unknown()).nullable().describe('Redacted: typed text is its length, URLs lose their query'),
  ok: z.boolean(),
  summary: z.string(),
  reasoning: z.string().nullable(),
  screenshotKey: z.string().nullable(),
  durationMs: z.number().int().nullable(),
  createdAt: iso,
});
export class RunDetailResponseDto extends createZodDto(runResponseSchema.extend({ steps: z.array(runStepResponseSchema) })) {}

const questionInput = z.enum(['none', 'text', 'secret', 'choice', 'multi_choice', 'number', 'confirm', 'takeover']);
const questionOption = z.object({ id: z.string(), label: z.string(), description: z.string().optional() });
const questionConstraints = z.object({
  maxLength: z.number().int().optional(),
  pattern: z.string().optional(),
  multiline: z.boolean().optional(),
  min: z.number().optional(),
  max: z.number().optional(),
  step: z.number().optional(),
  unit: z.string().optional(),
  minSelections: z.number().int().optional(),
  maxSelections: z.number().int().optional(),
});
export const questionAnswerResponseSchema = z.object({
  outcome: z.enum(['completed', 'cancelled']),
  value: z.string().optional().describe('Never present for a secret'),
  values: z.array(z.string()).optional(),
  valueWithheld: z.boolean().describe('True for a secret: the value went to the browser, single use, and is never returned'),
  channel: z.string().optional(),
  by: z.string().optional().describe('Who answered, e.g. user:<id>'),
  answeredAt: iso,
});

export const questionResponseSchema = z.object({
  id: z.uuid(),
  askedBy: z.string().describe('run:<id>, agent:<name> or user:<id>'),
  runId: z.uuid().nullable(),
  handoffId: z.uuid().nullable(),
  browserBound: z.boolean(),
  input: questionInput,
  kind: z.string(),
  prompt: z.string(),
  options: z.array(questionOption).nullable(),
  constraints: questionConstraints.nullable(),
  confirmLabel: z.string().nullable(),
  denyLabel: z.string().nullable(),
  risk: z.enum(['low', 'high']).nullable(),
  status: z.enum(['pending', 'answered', 'cancelled', 'expired']),
  response: questionAnswerResponseSchema.nullable(),
  pageTitle: z.string().nullable(),
  viewerUrl: z.string().nullable(),
  createdAt: iso,
  expiresAt: iso,
  answeredAt: iso.nullable(),
});
export class QuestionResponseDto extends createZodDto(questionResponseSchema) {}

export const inboxItemResponseSchema = z.object({
  questionId: z.uuid(),
  /** Null for a free-standing question (answer it with POST /api/questions/{id}/answer). */
  runId: z.uuid().nullable(),
  goal: z.string(),
  handoffId: z.uuid().nullable(),
  askedBy: z.string(),
  kind: z.string(),
  prompt: z.string(),
  input: questionInput,
  /** The option ids (each bare-string option is its own id); `options` has the labels. */
  choices: z.array(z.string()),
  options: z.array(questionOption).nullable(),
  constraints: questionConstraints.nullable(),
  confirmLabel: z.string().nullable(),
  denyLabel: z.string().nullable(),
  risk: z.enum(['low', 'high']).nullable(),
  pageTitle: z.string().nullable(),
  viewerUrl: z.string().nullable(),
  createdAt: iso,
  expiresAt: iso,
});
export class InboxItemResponseDto extends createZodDto(inboxItemResponseSchema) {}

export const scheduleResponseSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  taskId: z.uuid(),
  cron: z.string(),
  timezone: z.string(),
  enabled: z.boolean(),
  concurrency: z.enum(['skip', 'queue']),
  nextRunAt: iso.nullable(),
  lastRunAt: iso.nullable(),
  lastRunId: z.uuid().nullable(),
  consecutiveFailures: z.number().int(),
  createdAt: iso,
  updatedAt: iso,
});
export class ScheduleResponseDto extends createZodDto(scheduleResponseSchema) {}

export const fleetHostResponseSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  online: z.boolean(),
  browserConnected: z.boolean(),
  onDemand: z.boolean(),
  mode: z.enum(['unattended', 'attended', 'container']).nullable().describe('How the host runs its browsers; null for older agents'),
  desktop: z.boolean().describe('The host can share its desktop through the fabric'),
  draining: z.boolean(),
  viewerUrl: z.string().nullable(),
  profiles: z.array(z.object({ name: z.string(), running: z.boolean() })),
  lastSeen: iso,
});
export class FleetHostResponseDto extends createZodDto(fleetHostResponseSchema) {}

export class OkResponseDto extends createZodDto(z.object({ ok: z.literal(true) })) {}
