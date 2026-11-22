// One pass over a benchmark (E44.3, #741): what the `benchmark.advance` job does. One trial runs at a time. A pass:
//
//   1. looks after the running trial: grades it when its run has ended, stops it when it timed out, lets the scripted owner answer the
//      question it waits on, and ends it as "asked a person" when no rule fits;
//   2. when no trial is running: checks the spend cap and three errors in a row, then starts the next trial or finishes the benchmark.
//
// It reads the rows every time and every write is conditional on what it read, so a pass may run twice, late, or after a crash. Passes
// of one benchmark are serialised with a transaction-scoped advisory lock: two cannot both start a trial.
import { Injectable, Logger } from '@nestjs/common';
import { JobsService } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../prisma/prisma.service';
import { isTerminal, type RunStatus } from '../tasks/run-status';
import { TasksService } from '../tasks/tasks.service';
import { inRunOrder, readBenchmarkConfig, type StoredBenchmarkConfig } from './benchmark-config';
import { LIVE_BENCHMARK_STATUSES, type BenchmarkStatus, type TrialFailureReason } from './benchmark.constants';
import { BenchmarkGrader } from './benchmark-grader';
import { enqueueBenchmarkAdvance } from './benchmark.jobs.enqueue';
import { BenchmarkMetrics } from './benchmark.metrics';
import { BenchmarkOwner } from './benchmark-owner';
import { BenchmarkRunStarter } from './benchmark-run-starter';
import { ScorecardService } from './scorecard.service';

/** A pass's result, for the job log. */
export type AdvanceOutcome = 'gone' | 'ended' | 'waiting' | 'started' | 'completed' | 'failed';

/** Trials that ended as `error` one after the other before the benchmark gives up: the node or the provider is down. */
export const ERRORS_IN_A_ROW = 3;
/** How long after Stop a run may take to end by itself before the benchmark ends it. */
export const STOP_GRACE_MS = 60_000;
/** How soon a pass looks again at a trial it has just stopped. */
const RECHECK_MS = 15_000;
/** How soon a pass looks again at a question whose run is not waiting on it yet. */
const QUESTION_RECHECK_MS = 3_000;

const isLive = (status: string): boolean => (LIVE_BENCHMARK_STATUSES as readonly string[]).includes(status);

interface RunningTrial {
  id: string;
  benchmarkId: string;
  challengeId: string;
  policyRef: string;
  seed: string;
  status: string;
  runId: string | null;
  failureReason: string | null;
  startedAt: Date | null;
}

@Injectable()
export class BenchmarkRunner {
  private readonly log = new Logger(BenchmarkRunner.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly tasks: TasksService,
    private readonly starter: BenchmarkRunStarter,
    private readonly owner: BenchmarkOwner,
    private readonly grader: BenchmarkGrader,
    private readonly metrics: BenchmarkMetrics,
    private readonly scorecard: ScorecardService,
  ) {}

  /** One pass, alone on its benchmark. */
  async advance(benchmarkId: string): Promise<AdvanceOutcome> {
    return this.prisma.$transaction(
      async (tx) => {
        // Held until this transaction ends. The pass itself writes through other connections, so every step is committed as it happens.
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`benchmark:${benchmarkId}`}, 0))`;
        return this.pass(benchmarkId);
      },
      { timeout: 4 * 60_000, maxWait: 30_000 },
    );
  }

  private async pass(benchmarkId: string): Promise<AdvanceOutcome> {
    const found = await this.prisma.benchmark.findUnique({ where: { id: benchmarkId }, select: { id: true, userId: true, status: true, config: true, finishedAt: true } });
    if (!found) return 'gone';
    const config = readBenchmarkConfig(found.config);
    const owner = { userId: found.userId, orgId: config.orgId };
    const live = isLive(found.status);

    let busy = false;
    for (const trial of await this.prisma.benchmarkTrial.findMany({ where: { benchmarkId, status: 'running' } })) {
      busy = (await this.tend(owner, config, trial, live ? null : (found.finishedAt ?? new Date()))) || busy;
    }
    if (!live) {
      // A cancelled benchmark's last trial was just graded: its scorecard is final now.
      if (!busy) await this.scorecard.cacheIfEnded(benchmarkId);
      return 'ended';
    }
    if (busy) return 'waiting';

    if (found.status === 'queued') await this.prisma.benchmark.updateMany({ where: { id: benchmarkId, status: 'queued' }, data: { status: 'running', startedAt: new Date() } });
    for (;;) {
      // Read again each time round: a trial that just ended added its cost, and Cancel may have come in.
      const now = await this.prisma.benchmark.findUnique({ where: { id: benchmarkId }, select: { status: true, spentUsd: true } });
      if (!now || !isLive(now.status)) return 'ended';
      // No cap (`null`, #840): only each run's own policy budget limits spend.
      if (config.capUsd !== null && Number(now.spentUsd) >= config.capUsd) {
        await this.skipRest(benchmarkId, 'cap');
        return this.finish(benchmarkId, 'completed');
      }
      const last = await this.prisma.benchmarkTrial.findMany({ where: { benchmarkId, status: 'graded' }, orderBy: [{ finishedAt: 'desc' }, { id: 'desc' }], take: ERRORS_IN_A_ROW, select: { verdict: true } });
      if (last.length === ERRORS_IN_A_ROW && last.every((t) => t.verdict === 'error')) {
        await this.skipRest(benchmarkId, 'error');
        return this.finish(benchmarkId, 'failed');
      }
      const [next] = inRunOrder(config, await this.prisma.benchmarkTrial.findMany({ where: { benchmarkId, status: 'pending' } }));
      if (!next) return this.finish(benchmarkId, 'completed');
      if (await this.starter.start(owner, config, next)) {
        // The pass that closes the trial if nothing else ends it first.
        await enqueueBenchmarkAdvance(this.jobs, benchmarkId, config.orgId, 'benchmark_recheck', config.trialTimeoutMinutes * 60_000 + 1_000);
        return 'started';
      }
    }
  }

  /**
   * Looks after one running trial. True: its run is still going. `endedAt` is when the benchmark itself ended (cancelled), or null
   * while it is live.
   */
  private async tend(owner: { userId: string; orgId: string | null }, config: StoredBenchmarkConfig, trial: RunningTrial, endedAt: Date | null): Promise<boolean> {
    if (!trial.runId) {
      // The process died between claiming the trial and creating its run.
      if (endedAt) {
        await this.prisma.benchmarkTrial.updateMany({ where: { id: trial.id, status: 'running', runId: null }, data: { status: 'skipped', verdict: 'skipped', failureReason: 'cancelled', finishedAt: new Date() } });
        return false;
      }
      return this.starter.start(owner, config, trial);
    }
    const run = await this.prisma.run.findFirst({ where: { id: trial.runId, userId: owner.userId }, select: { id: true, status: true, handoffId: true } });
    if (!run) {
      await this.grader.close(trial.id, 'run', 'The run was deleted before it ended');
      return false;
    }
    if (isTerminal(run.status as RunStatus)) {
      await this.grader.gradeTrial(trial.id);
      return false;
    }
    const deadline = (trial.startedAt ?? new Date()).getTime() + config.trialTimeoutMinutes * 60_000;
    const stopFrom = endedAt ? endedAt.getTime() : Date.now() >= deadline ? deadline : null;
    if (stopFrom !== null) return this.stop(owner, config, trial, endedAt ? 'cancelled' : 'timeout', Date.now() >= stopFrom + STOP_GRACE_MS);
    if (run.status === 'waiting_human') {
      const turn = await this.owner.answer(owner, trial, run);
      if (turn === 'unscripted') return this.stop(owner, config, trial, 'asked_person', false);
    } else if ((await this.prisma.question.count({ where: { runId: run.id, status: 'pending', blocking: true, createdAt: { gt: new Date(Date.now() - 60_000) } } })) > 0) {
      // The question is recorded a moment before the run starts waiting on it: look again once it does (for a minute, no longer).
      await enqueueBenchmarkAdvance(this.jobs, trial.benchmarkId, config.orgId, 'benchmark_recheck', QUESTION_RECHECK_MS);
    }
    return true;
  }

  /**
   * Stops a trial's run through the ordinary cancel path, with the reason written on the trial first so the grader knows why the run
   * was cancelled. `force`: the run did not end by itself in time (no job holds it), so it is ended here. True: still going.
   */
  private async stop(owner: { userId: string; orgId: string | null }, config: StoredBenchmarkConfig, trial: RunningTrial, reason: Extract<TrialFailureReason, 'timeout' | 'asked_person' | 'cancelled'>, force: boolean): Promise<boolean> {
    await this.prisma.benchmarkTrial.updateMany({ where: { id: trial.id, status: 'running', failureReason: null }, data: { failureReason: reason } });
    const runId = trial.runId!;
    try {
      let run = await this.tasks.cancel(owner.userId, runId);
      if (force && !isTerminal(run.status as RunStatus)) run = await this.tasks.transition(owner.userId, runId, 'cancelled', { error: 'Stopped by the benchmark', stopReason: 'cancelled' });
      if (isTerminal(run.status as RunStatus)) {
        // The run-end hook graded it; this covers a hook that failed.
        await this.grader.gradeTrial(trial.id);
        return false;
      }
    } catch (e) {
      this.log.warn(`trial ${trial.id}: could not stop run ${runId}: ${e instanceof Error ? e.message : String(e)}`);
    }
    await enqueueBenchmarkAdvance(this.jobs, trial.benchmarkId, config.orgId, 'benchmark_recheck', force ? STOP_GRACE_MS : RECHECK_MS);
    return true;
  }

  /** Marks every trial that has not started as skipped, with the reason. */
  async skipRest(benchmarkId: string, reason: Extract<TrialFailureReason, 'cap' | 'cancelled' | 'error'>): Promise<number> {
    const { count } = await this.prisma.benchmarkTrial.updateMany({ where: { benchmarkId, status: 'pending' }, data: { status: 'skipped', verdict: 'skipped', failureReason: reason, finishedAt: new Date() } });
    this.metrics.trials('skipped', count);
    return count;
  }

  /** Ends a live benchmark and caches its scorecard (#742) in `Benchmark.summary`. */
  private async finish(benchmarkId: string, status: Extract<BenchmarkStatus, 'completed' | 'failed'>): Promise<AdvanceOutcome> {
    const { count } = await this.prisma.benchmark.updateMany({ where: { id: benchmarkId, status: { in: [...LIVE_BENCHMARK_STATUSES] } }, data: { status, finishedAt: new Date() } });
    if (count === 1) {
      this.log.log(`benchmark ${benchmarkId}: ${status}`);
      await this.scorecard.cacheIfEnded(benchmarkId);
    }
    return count === 1 ? status : 'ended';
  }
}
