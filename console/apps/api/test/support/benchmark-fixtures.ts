// A finished benchmark with graded trials, written straight into the database (E44.3, #741): what a spec of the scorecard, the export
// or a page's API needs without running anything. The rows have the shape `BenchmarkGrader` writes; no run is created unless asked.
import { randomUUID } from 'node:crypto';

import type { Prisma } from '@prisma/client';

import type { StoredBenchmarkConfig } from '../../src/benchmark/benchmark-config';
import type { TrialFailureReason, TrialVerdict } from '../../src/benchmark/benchmark.constants';
import { SUITE, seedFrom } from '../../src/benchmark/suite/registry';
import type { Check } from '../../src/benchmark/suite/types';
import type { PrismaService } from '../../src/prisma/prisma.service';

/** One trial's result. Everything has a default: a pass that took 20 s, 6 steps and one cent. */
export interface FixtureTrial {
  verdict?: TrialVerdict;
  failureReason?: TrialFailureReason | null;
  claimedSuccess?: boolean;
  checks?: Check[];
  activeMs?: number;
  durationMs?: number;
  steps?: number;
  modelCalls?: number;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  costUsd?: number;
  costKnown?: boolean;
  stopReason?: string | null;
  questions?: number;
  escalations?: number;
  runId?: string | null;
  /** The start tier's model, `provider:modelId` (default: one per policy, `fixture:<policy ref>`). */
  model?: string;
}

export interface FixtureBenchmark {
  name?: string;
  challengeIds?: string[];
  policies?: { ref: string; label: string }[];
  trials?: number;
  status?: 'completed' | 'cancelled' | 'failed' | 'running';
  suiteVersion?: number;
  appVersion?: string;
  commit?: string | null;
  /** The result of one trial; return nothing for the default pass. */
  result?: (cell: { challengeId: string; policyRef: string; trialIndex: number }) => FixtureTrial | undefined;
}

/**
 * Creates a benchmark of `userId` with every trial ended, and returns its id and trial rows. `result` decides each cell:
 * `createGradedBenchmark(prisma, userId, { result: (c) => (c.policyRef === 'builtin:economy' && c.trialIndex === 0 ? { verdict: 'fail', failureReason: 'wrong_result' } : undefined) })`.
 */
export async function createGradedBenchmark(prisma: PrismaService, userId: string, opts: FixtureBenchmark = {}) {
  const id = randomUUID();
  const config: StoredBenchmarkConfig = {
    challengeIds: opts.challengeIds ?? ['nav-lookup', 'form-multistep'],
    policies: (opts.policies ?? [{ ref: 'builtin:economy', label: 'Economy' }, { ref: 'builtin:balanced', label: 'Balanced' }]).map((p) => ({ recordVideo: false, ...p })),
    trials: opts.trials ?? 3,
    hostId: null,
    profile: 'default',
    capUsd: 5,
    trialTimeoutMinutes: 15,
    recordVideo: false,
    orgId: null,
  };
  const started = new Date(Date.now() - 3_600_000);
  const rows: Prisma.BenchmarkTrialCreateManyInput[] = [];
  let at = started.getTime();
  for (let trialIndex = 0; trialIndex < config.trials; trialIndex++) {
    for (const challengeId of config.challengeIds) {
      for (const p of config.policies) {
        const r = opts.result?.({ challengeId, policyRef: p.ref, trialIndex }) ?? {};
        const verdict = r.verdict ?? 'pass';
        const ran = verdict === 'pass' || verdict === 'fail' || verdict === 'error';
        const durationMs = r.durationMs ?? 25_000;
        rows.push({
          benchmarkId: id,
          challengeId,
          policyRef: p.ref,
          policyLabel: p.label,
          trialIndex,
          seed: seedFrom(id, challengeId, p.ref, trialIndex),
          status: ran ? 'graded' : 'skipped',
          verdict,
          failureReason: r.failureReason !== undefined ? r.failureReason : verdict === 'fail' ? 'wrong_result' : verdict === 'pass' ? null : verdict === 'error' ? 'error' : verdict === 'unsupported' ? 'unsupported' : 'cancelled',
          ...(ran
            ? {
                checks: (r.checks ?? [{ name: 'graded', pass: verdict === 'pass' }]) as unknown as Prisma.InputJsonValue,
                claimedSuccess: r.claimedSuccess ?? verdict === 'pass',
                durationMs,
                activeMs: r.activeMs ?? 20_000,
                steps: r.steps ?? 6,
                modelCalls: r.modelCalls ?? 4,
                inputTokens: r.inputTokens ?? 12_000,
                outputTokens: r.outputTokens ?? 600,
                cachedInputTokens: r.cachedInputTokens ?? 4_000,
                costUsd: r.costUsd ?? 0.01,
                costKnown: r.costKnown ?? true,
                stopReason: r.stopReason !== undefined ? r.stopReason : 'finished',
                questions: r.questions ?? 0,
                escalations: r.escalations ?? 0,
                runId: r.runId ?? null,
                models: { startTier: 'standard', maxTier: 'standard', finalTier: 'standard', model: r.model ?? `fixture:${p.ref}`, tiers: [{ tier: 'standard', model: r.model ?? `fixture:${p.ref}`, fallbackModel: null }] } as unknown as Prisma.InputJsonValue,
                startedAt: new Date(at),
              }
            : {}),
          finishedAt: new Date((at += ran ? durationMs : 0)),
        });
      }
    }
  }
  const status = opts.status ?? 'completed';
  const spentUsd = rows.reduce((sum, r) => sum + Number(r.costUsd ?? 0), 0);
  await prisma.benchmark.create({
    data: {
      id,
      userId,
      name: opts.name ?? 'Fixture benchmark',
      suiteKey: SUITE.key,
      suiteVersion: opts.suiteVersion ?? SUITE.version,
      status,
      config: config as unknown as Prisma.InputJsonValue,
      appVersion: opts.appVersion ?? '0.0.0-test',
      commit: opts.commit ?? null,
      spentUsd,
      startedAt: started,
      finishedAt: status === 'running' ? null : new Date(at),
    },
  });
  await prisma.benchmarkTrial.createMany({ data: rows });
  return { id, config, trials: await prisma.benchmarkTrial.findMany({ where: { benchmarkId: id } }) };
}
