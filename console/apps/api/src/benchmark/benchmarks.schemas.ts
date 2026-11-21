// The benchmarks API (E44.3, #741): what a client sends to start one, and what it reads back. The scorecard (#742), the pages (#743),
// the exports (#744) and the CLI (#746) read these shapes.
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { profileNameSchema } from '../fleet/fleet.schemas';
import { policyRefSchema } from '../policies/policies.schemas';
import { BENCHMARK_STATUSES, TRIAL_FAILURE_REASONS, TRIAL_STATUSES, TRIAL_VERDICTS } from './benchmark.constants';
import { BENCHMARK_LIMITS } from './benchmark.settings';
import { CAPABILITIES, CATEGORIES } from './suite/types';

/** How many policies one benchmark compares. */
export const BENCHMARK_MAX_POLICIES = 8;

const challengeIdSchema = z.string().trim().min(1).max(64);

const policyChoiceSchema = z.object({
  ref: policyRefSchema.describe('An agent policy: `builtin:<key>` or the id of one of your own.'),
  label: z.string().trim().min(1).max(200).optional().describe("The column's name in the scorecard. Absent: the policy's name."),
});

/** `POST /api/benchmarks`. */
export const createBenchmarkSchema = z
  .object({
    name: z.string().trim().min(1).max(200).optional().describe('Absent: "Benchmark" and the date.'),
    challengeIds: z.array(challengeIdSchema).min(1).max(200).optional().describe('The challenges to run, by id (`GET /api/benchmarks/suite`). Absent: every challenge of the suite.'),
    policies: z.array(policyChoiceSchema).min(1).max(BENCHMARK_MAX_POLICIES).describe('The agent policies to compare, 1 to 8. Each challenge runs under each of them.'),
    trials: z.number().int().min(1).max(BENCHMARK_LIMITS.maxTrials).optional().describe('Attempts per challenge and policy. Absent: the deployment default (`benchmark.defaultTrials`).'),
    hostId: z.uuid().nullable().optional().describe('The node every trial runs on. Absent: the fabric picks an available one for each trial.'),
    profile: profileNameSchema.default('default').describe('The browser profile on the node.'),
    capUsd: z.number().positive().max(BENCHMARK_LIMITS.maxCapUsd).optional().describe('No new trial starts once the benchmark has spent this much on model calls. Absent: `benchmark.defaultCapUsd`.'),
    trialTimeoutMinutes: z.number().int().min(1).max(BENCHMARK_LIMITS.maxTrialTimeoutMinutes).optional().describe('How long one trial may take before it is stopped as timed out. Absent: `benchmark.trialTimeoutMinutes`.'),
  })
  .strict();
export class CreateBenchmarkDto extends createZodDto(createBenchmarkSchema) {}
export type CreateBenchmarkInput = z.infer<typeof createBenchmarkSchema>;

/** What was asked for, as stored in `Benchmark.config`: every value resolved. */
export const benchmarkConfigSchema = z.object({
  challengeIds: z.array(z.string()),
  policies: z.array(z.object({ ref: z.string(), label: z.string() })),
  trials: z.number().int(),
  hostId: z.string().nullable(),
  profile: z.string(),
  capUsd: z.number(),
  trialTimeoutMinutes: z.number().int(),
});
export type BenchmarkConfig = z.infer<typeof benchmarkConfigSchema>;

/** How many trials are in each state, and how the judged ones came out. */
export const benchmarkProgressSchema = z.object({
  total: z.number().int(),
  pending: z.number().int(),
  running: z.number().int(),
  graded: z.number().int().describe('Trials that ran and were judged: `pass` + `fail` + `error`.'),
  skipped: z.number().int().describe('Trials that never ran, or were stopped: cancelled, the spend cap, an unsupported challenge.'),
  pass: z.number().int(),
  fail: z.number().int(),
  error: z.number().int(),
  unsupported: z.number().int(),
});
export type BenchmarkProgress = z.infer<typeof benchmarkProgressSchema>;

/** What the trials that ended used, summed. */
export const benchmarkTotalsSchema = z.object({
  inputTokens: z.number().int(),
  outputTokens: z.number().int(),
  cachedInputTokens: z.number().int().describe('Input tokens served from the provider cache: a subset of `inputTokens`.'),
  modelCalls: z.number().int(),
  costUsd: z.number().describe('USD on model calls. The same sum as `spentUsd`.'),
  costKnown: z.boolean().describe('False when a model call of any trial could not be priced: `costUsd` is then a lower bound.'),
});
export type BenchmarkTotals = z.infer<typeof benchmarkTotalsSchema>;

/** The models a trial's run could call, from its policy snapshot. */
export const trialModelsSchema = z.object({
  startTier: z.string(),
  maxTier: z.string(),
  finalTier: z.string().describe('The tier the run was on when it ended.'),
  model: z.string().nullable().describe("The start tier's model, `provider:modelId`."),
  tiers: z.array(z.object({ tier: z.string(), model: z.string().nullable(), fallbackModel: z.string().nullable() })).describe('The tiers from start to max: the only ones the run may use.'),
});

export const benchmarkSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.enum(BENCHMARK_STATUSES),
  suiteKey: z.string(),
  suiteVersion: z.number().int(),
  config: benchmarkConfigSchema,
  appVersion: z.string().describe('The console version when the benchmark started.'),
  commit: z.string().nullable().describe("The build's commit when it started; null on a development build."),
  spentUsd: z.number().describe('USD spent on model calls by the trials that ended. A lower bound when a trial has `costKnown: false`.'),
  progress: benchmarkProgressSchema,
  totals: benchmarkTotalsSchema,
  baselineId: z.string().nullable(),
  createdAt: z.string(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export class BenchmarkResponseDto extends createZodDto(benchmarkSchema) {}
export type BenchmarkView = z.infer<typeof benchmarkSchema>;

export const listBenchmarksQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});
export class ListBenchmarksQueryDto extends createZodDto(listBenchmarksQuerySchema) {}

export const benchmarkListSchema = z.object({ items: z.array(benchmarkSchema), total: z.number().int() });
export class BenchmarkListResponseDto extends createZodDto(benchmarkListSchema) {}

export const trialCheckSchema = z.object({ name: z.string(), pass: z.boolean(), detail: z.string().optional() });

export const benchmarkTrialSchema = z.object({
  id: z.string(),
  challengeId: z.string(),
  challengeTitle: z.string().describe("The challenge's title; its id when the suite no longer has it."),
  category: z.enum(CATEGORIES).nullable(),
  policyRef: z.string(),
  policyLabel: z.string(),
  trialIndex: z.number().int().describe('0-based attempt of this challenge under this policy.'),
  status: z.enum(TRIAL_STATUSES),
  verdict: z.enum(TRIAL_VERDICTS).nullable().describe('Null until the trial is judged or skipped.'),
  failureReason: z.enum(TRIAL_FAILURE_REASONS).nullable(),
  checks: z.array(trialCheckSchema).nullable().describe("The grader's named checks. A trial passes only when every check passes; `safety:<name>` guards an invariant."),
  claimedSuccess: z.boolean().nullable().describe('Whether the agent said it succeeded: compared with the verdict for the false-success rate.'),
  runId: z.string().nullable().describe("The trial's run (`GET /api/runs/{id}`); null before it starts and after the run is deleted."),
  durationMs: z.number().int().nullable(),
  activeMs: z.number().int().nullable(),
  steps: z.number().int().nullable(),
  modelCalls: z.number().int().nullable(),
  inputTokens: z.number().int().nullable(),
  outputTokens: z.number().int().nullable(),
  cachedInputTokens: z.number().int().nullable(),
  model: z.string().nullable().describe("The model of the run's start tier (`provider:modelId`); null before grading or when unknown."),
  models: trialModelsSchema.nullable(),
  costUsd: z.number().nullable(),
  costKnown: z.boolean().nullable().describe('False when a model call could not be priced: `costUsd` is then a lower bound.'),
  stopReason: z.string().nullable().describe("The run's stop reason (`finished`, `budget_*`, `stalled`, `cancelled`, `error`, `no_model`)."),
  questions: z.number().int().nullable().describe('Questions the agent asked a person.'),
  escalations: z.number().int().nullable(),
  startedAt: z.string().nullable(),
  finishedAt: z.string().nullable(),
});
export type BenchmarkTrialView = z.infer<typeof benchmarkTrialSchema>;

export const listTrialsQuerySchema = z.object({
  status: z.enum(TRIAL_STATUSES).optional(),
  verdict: z.enum(TRIAL_VERDICTS).optional(),
  policyRef: z.string().max(64).optional(),
  challengeId: challengeIdSchema.optional(),
});
export class ListTrialsQueryDto extends createZodDto(listTrialsQuerySchema) {}

export const benchmarkTrialListSchema = z.object({ items: z.array(benchmarkTrialSchema).describe('In the order the trials run.') });
export class BenchmarkTrialListResponseDto extends createZodDto(benchmarkTrialListSchema) {}

export const suiteChallengeSchema = z.object({
  id: z.string(),
  title: z.string(),
  category: z.enum(CATEGORIES),
  difficulty: z.number().int().min(1).max(3),
  requires: z.array(z.enum(CAPABILITIES)),
  supported: z.boolean().describe('False: the agent lacks a capability the challenge needs, so its trials are reported `unsupported` and never run.'),
  missing: z.array(z.enum(CAPABILITIES)).describe('The capabilities the agent lacks.'),
  confirmRiskyActions: z.boolean().describe('Whether the trial run asks before a risky step.'),
});

export const benchmarkSuiteSchema = z.object({
  key: z.string(),
  version: z.number().int().describe('Two benchmarks compare only within one suite key and version.'),
  categories: z.array(z.object({ id: z.enum(CATEGORIES), label: z.string() })),
  challenges: z.array(suiteChallengeSchema),
  defaults: z.object({ trials: z.number().int(), capUsd: z.number(), trialTimeoutMinutes: z.number().int() }),
  limits: z.object({ maxPolicies: z.number().int(), maxTrials: z.number().int(), maxCapUsd: z.number(), maxTrialTimeoutMinutes: z.number().int() }),
  site: z.object({
    baseUrl: z.string().describe("Where a node's browser reaches the challenge site."),
    reachable: z.boolean().describe('False: a node cannot reach that address, and a benchmark cannot start.'),
    problem: z.string().nullable(),
  }),
});
export class BenchmarkSuiteResponseDto extends createZodDto(benchmarkSuiteSchema) {}
export type BenchmarkSuiteView = z.infer<typeof benchmarkSuiteSchema>;
