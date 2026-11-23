// Grading a trial when its run ends (E44.3, #741). Registered as a run-end hook (`tasks/run-end-hooks.ts`), and called by the advance
// pass for a trial whose run ended while nobody was listening. It closes the trial's site, runs the challenge's grader over the site's
// stored state, and copies the run's metrics onto the trial, so a scorecard outlives the run. The verdict is `trial-verdict.ts`.
//
// Idempotent: one conditional write moves the trial out of `running`, and only the writer that made it adds the cost and queues the
// next pass. Grading twice changes nothing.
import { Injectable, Logger, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { JobsService } from '@marinoscar/platform-api/jobs';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { maskSensitive } from '../tasks/mask';
import { RunEndHooks } from '../tasks/run-end-hooks';
import { isTerminal, type RunStatus } from '../tasks/run-status';
import { readBenchmarkConfig } from './benchmark-config';
import { enqueueBenchmarkAdvance } from './benchmark.jobs.enqueue';
import { BenchmarkMetrics } from './benchmark.metrics';
import { BenchmarkOwner } from './benchmark-owner';
import { OWNER_CARD_INPUTS, askedQuestions } from './owner-script';
import { withAskedQuestion } from './trial-verdict';
import { TrialStateService } from './site/trial-state.service';
import { challengeById } from './suite/registry';
import type { Check } from './suite/types';
import { trialModels } from './trial-models';
import { trialOutcome, type TrialOutcomeInput } from './trial-verdict';

@Injectable()
export class BenchmarkGrader implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(BenchmarkGrader.name);
  private off: (() => void) | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly endHooks: RunEndHooks,
    private readonly trials: TrialStateService,
    private readonly owner: BenchmarkOwner,
    private readonly metrics: BenchmarkMetrics,
  ) {}

  onModuleInit(): void {
    this.off = this.endHooks.register((_userId, runId) => this.onRunEnd(runId));
  }

  onModuleDestroy(): void {
    this.off?.();
  }

  /** A run ended: grade its trial, when it is one. One indexed read for any other run. */
  async onRunEnd(runId: string): Promise<void> {
    const trial = await this.prisma.benchmarkTrial.findFirst({ where: { runId, status: 'running' }, select: { id: true } });
    if (trial) await this.gradeTrial(trial.id);
  }

  /** Grades a `running` trial whose run has ended. False: nothing to grade (already graded, or the run is still going). */
  async gradeTrial(trialId: string): Promise<boolean> {
    const trial = await this.prisma.benchmarkTrial.findUnique({ where: { id: trialId }, include: { benchmark: { select: { id: true, userId: true, config: true } } } });
    if (!trial || trial.status !== 'running' || !trial.runId) return false;
    const userId = trial.benchmark.userId;
    const run = await this.prisma.run.findFirst({ where: { id: trial.runId, userId }, omit: { transcript: true } });
    if (!run) return this.close(trialId, 'run', 'The run was deleted before it ended');
    if (!isTerminal(run.status as RunStatus)) return false;

    // The site closes first: nothing a late request does can change what is graded.
    await this.trials.closeToken(trialId);
    const questions = await this.owner.questionsOf(userId, run.id);
    // A card the run left for its owner (a suggested memory) is withdrawn unanswered: nobody is there to read it.
    await this.prisma.question.updateMany({ where: { runId: run.id, status: 'pending' }, data: { status: 'cancelled' } });

    const challenge = challengeById(trial.challengeId);
    // Every question the run asked, masked, with what the scripted owner answered (`none`: nobody did).
    const asked = askedQuestions(challenge?.owner?.(trial.seed) ?? [], questions, (text) => maskSensitive(text).text);
    let grade: TrialOutcomeInput['grade'];
    if (!challenge) grade = { error: `The suite has no challenge ${trial.challengeId}` };
    else {
      try {
        const stored = await this.trials.read(trialId);
        const checks: Check[] = challenge.grade({ seed: trial.seed, state: stored?.state ?? {}, result: run.result ?? '', outputs: run.outputs ?? null, asked, claimedSuccess: run.status === 'succeeded' });
        grade = { checks: Array.isArray(checks) ? checks : [] };
      } catch (e) {
        grade = { error: e instanceof Error ? e.message : String(e) };
      }
    }
    const outcome = withAskedQuestion(trialOutcome({ preset: trial.failureReason, run: { status: run.status, stopReason: run.stopReason, error: run.error }, grade }), asked, trial.failureReason);
    const finishedAt = run.finishedAt ?? new Date();
    const models = trialModels(run.policySnapshot, run.currentTier);
    const { count } = await this.prisma.benchmarkTrial.updateMany({
      where: { id: trialId, status: 'running' },
      data: {
        status: outcome.status,
        verdict: outcome.verdict,
        failureReason: outcome.failureReason,
        checks: outcome.checks ? (outcome.checks as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        claimedSuccess: outcome.claimedSuccess,
        durationMs: Math.min(2_147_483_647, Math.max(0, finishedAt.getTime() - (run.startedAt ?? run.createdAt).getTime())),
        activeMs: run.activeMs,
        steps: run.stepCount,
        modelCalls: run.modelCalls,
        inputTokens: run.inputTokens,
        outputTokens: run.outputTokens,
        cachedInputTokens: run.cachedInputTokens,
        costUsd: run.costUsd,
        costKnown: run.costKnown,
        stopReason: run.stopReason,
        questions: questions.filter((q) => !OWNER_CARD_INPUTS.includes(q.input)).length,
        escalations: run.escalations,
        policySnapshot: run.policySnapshot === null ? Prisma.DbNull : (run.policySnapshot as Prisma.InputJsonValue),
        models: models ? (models as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
        finishedAt,
      },
    });
    if (count !== 1) return false;
    // Only the writer that graded the trial counts its cost: the cap is checked against this sum before the next trial.
    await this.prisma.benchmark.update({ where: { id: trial.benchmarkId }, data: { spentUsd: { increment: run.costUsd } } });
    this.metrics.trials(outcome.verdict);
    this.log.log(`benchmark ${trial.benchmarkId}: trial ${trialId} ${outcome.verdict}${outcome.failureReason ? ` (${outcome.failureReason})` : ''}`);
    await enqueueBenchmarkAdvance(this.jobs, trial.benchmarkId, readBenchmarkConfig(trial.benchmark.config).orgId, 'benchmark_trial_ended');
    return true;
  }

  /**
   * Ends a trial that has no run to grade (the node is down, the run was deleted) as `error`, with one failed check that says why.
   * Not the agent's failure. Idempotent; queues nothing (the pass that calls it carries on).
   */
  async close(trialId: string, check: string, detail: string): Promise<boolean> {
    await this.trials.closeToken(trialId);
    const { count } = await this.prisma.benchmarkTrial.updateMany({
      where: { id: trialId, status: { in: ['pending', 'running'] } },
      data: { status: 'graded', verdict: 'error', failureReason: 'error', checks: [{ name: check, pass: false, detail: detail.slice(0, 500) }], finishedAt: new Date() },
    });
    if (count !== 1) return false;
    this.metrics.trials('error');
    this.log.warn(`trial ${trialId}: error (${check})`);
    return true;
  }
}
