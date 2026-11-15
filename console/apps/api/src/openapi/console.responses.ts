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
  allowedDomains: z.array(z.string()),
  maxSteps: z.number().int(),
  maxMinutes: z.number().int(),
  confirmRiskyActions: z.boolean(),
  model: z.string().nullable(),
  createdAt: iso,
  updatedAt: iso,
});
export class TaskResponseDto extends createZodDto(taskResponseSchema) {}

export const runResponseSchema = z.object({
  id: z.uuid(),
  userId: z.uuid(),
  taskId: z.uuid().nullable(),
  status: runStatus,
  trigger: z.enum(['manual', 'schedule', 'api', 'mcp', 'external']),
  goal: z.string(),
  profile: z.string(),
  hostId: z.uuid().nullable(),
  sessionId: z.uuid().nullable(),
  handoffId: z.uuid().nullable(),
  actor: z.string().nullable().describe('Who drove an external run'),
  result: z.string().nullable(),
  error: z.string().nullable(),
  cancelRequested: z.boolean(),
  stepCount: z.number().int(),
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
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

export const inboxItemResponseSchema = z.object({
  runId: z.uuid(),
  goal: z.string(),
  handoffId: z.uuid(),
  kind: z.string(),
  prompt: z.string(),
  input: z.enum(['none', 'text', 'secret', 'choice']),
  choices: z.array(z.string()),
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
  draining: z.boolean(),
  viewerUrl: z.string().nullable(),
  profiles: z.array(z.object({ name: z.string(), running: z.boolean() })),
  lastSeen: iso,
});
export class FleetHostResponseDto extends createZodDto(fleetHostResponseSchema) {}

export class OkResponseDto extends createZodDto(z.object({ ok: z.literal(true) })) {}
