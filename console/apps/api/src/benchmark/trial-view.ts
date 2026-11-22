// A trial as the API returns it (E44.3, #741), shared by the benchmarks service and the scorecard (#742).
import type { BenchmarkTrial } from '@prisma/client';

import { TRIAL_FAILURE_REASONS, TRIAL_STATUSES, TRIAL_VERDICTS } from './benchmark.constants';
import type { BenchmarkTrialView } from './benchmarks.schemas';
import { challengeById } from './suite/registry';
import type { Check } from './suite/types';
import { readTrialModels } from './trial-models';

export const oneOf = <T extends string>(list: readonly T[], value: unknown): T | null => (list.includes(value as T) ? (value as T) : null);
export const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** The columns of a trial row a view reads: never its seed, token, site state or policy snapshot. */
export const TRIAL_VIEW_OMIT = { siteState: true, policySnapshot: true, tokenHash: true, seed: true } as const;

export type TrialRow = Omit<BenchmarkTrial, 'siteState' | 'policySnapshot' | 'tokenHash' | 'seed'>;

const readChecks = (value: unknown): Check[] | null =>
  Array.isArray(value)
    ? value.flatMap((c): Check[] => {
        const v = c as Partial<Check> | null;
        return v && typeof v.name === 'string' ? [{ name: v.name, pass: v.pass === true, ...(typeof v.detail === 'string' ? { detail: v.detail } : {}) }] : [];
      })
    : null;

/** A trial as the API returns it: never its seed, its token, its site state or the expected answer. */
export function trialView(t: TrialRow): BenchmarkTrialView {
  const challenge = challengeById(t.challengeId);
  return {
    id: t.id,
    challengeId: t.challengeId,
    challengeTitle: challenge?.title ?? t.challengeId,
    category: challenge?.category ?? null,
    policyRef: t.policyRef,
    policyLabel: t.policyLabel,
    trialIndex: t.trialIndex,
    status: oneOf(TRIAL_STATUSES, t.status) ?? 'skipped',
    verdict: oneOf(TRIAL_VERDICTS, t.verdict),
    failureReason: oneOf(TRIAL_FAILURE_REASONS, t.failureReason),
    checks: readChecks(t.checks),
    claimedSuccess: t.claimedSuccess,
    runId: t.runId,
    durationMs: t.durationMs,
    activeMs: t.activeMs,
    steps: t.steps,
    modelCalls: t.modelCalls,
    inputTokens: t.inputTokens,
    outputTokens: t.outputTokens,
    cachedInputTokens: t.cachedInputTokens,
    model: readTrialModels(t.models)?.model ?? null,
    models: readTrialModels(t.models),
    costUsd: t.costUsd === null ? null : Number(t.costUsd),
    costKnown: t.costKnown,
    stopReason: t.stopReason,
    questions: t.questions,
    escalations: t.escalations,
    startedAt: iso(t.startedAt),
    finishedAt: iso(t.finishedAt),
  };
}
