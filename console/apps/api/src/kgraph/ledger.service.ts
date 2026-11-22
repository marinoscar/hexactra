// The savings ledger (E46.6, #780; docs/runbooks/kgraph-measurement.md): what each run of a task with the Knowledge Graph on cost and how it
// ran, so a saving is measured and never assumed.
//   1. `onRunEnd` (a `RunEndHooks` hook, after the run's final transition committed): a run with a `kg_runs` row whose mode is not `off`
//      gets one `kgraph.ledger.write` job. With the feature off there is no such row: no job and nothing written.
//   2. `write` (the job): copies the run's own counters (model calls from the usage the runner records, tokens, cost, active time) into
//      `kg_ledger`, never inside the run's transaction and never writing to the run. Its failure fails the job only.
//   3. The reads (`GET /api/kgraph/ledger`, `GET /api/kgraph/summary`): the owner's rows against the task's AI-only baseline.
import { Injectable, Logger, NotFoundException, Optional, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { JobsService } from '@marinoscar/platform-api/jobs';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { RunEndHooks } from '../tasks/run-end-hooks';
import { TERMINAL_RUN_STATUSES } from '../tasks/run-status';
import { KgraphMetrics } from './kgraph-metrics';
import { baselineOf, ledgerOutcome, modelCallsSaved, summarize, type Figures, type LedgerOutcome, type LedgerRunFigures, type RunFigures } from './ledger';
import { enqueueLedgerWrite } from './ledger.enqueue';

/** A task's summary reads at most this many of its newest ledger rows, and at most this many tasks. */
const SUMMARY_ROWS = 100;
const SUMMARY_TASKS = 100;
const LEDGER_ROWS = 200;

type LedgerRow = {
  runId: string;
  taskId: string | null;
  mode: string;
  procedureVersionId: string | null;
  runStatus: string;
  stepsReplayed: number;
  stepsRecovered: number;
  stepsJudge: number;
  stepsAgent: number;
  modelCalls: number;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  costUsd: unknown;
  costKnown: boolean;
  activeMs: number;
  outcome: string;
  checksPassed: boolean | null;
  finishedAt: Date;
};

const figures = (r: { modelCalls: number; costUsd: unknown; costKnown: boolean; activeMs: number; finishedAt: Date | null }): RunFigures => ({
  modelCalls: r.modelCalls,
  costUsd: Number(r.costUsd),
  costKnown: r.costKnown,
  activeMs: r.activeMs,
  finishedAt: r.finishedAt ?? new Date(0),
});

@Injectable()
export class LedgerService implements OnModuleInit, OnModuleDestroy {
  private readonly log = new Logger(LedgerService.name);
  private unregister?: () => void;

  constructor(
    private readonly prisma: PrismaService,
    private readonly metrics: KgraphMetrics,
    private readonly modules: ModuleRef,
    @Optional() private readonly jobs?: JobsService,
  ) {}

  /** The run-end hooks are found app-wide (not by importing TasksModule, which would reorder the app's modules and its OpenAPI document). */
  onModuleInit(): void {
    let hooks: RunEndHooks | undefined;
    try {
      hooks = this.modules.get(RunEndHooks, { strict: false });
    } catch {
      hooks = undefined;
    }
    this.unregister = hooks?.register(async (userId, runId) => void (await this.onRunEnd(userId, runId)));
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }

  /** Queue the ledger row of a run that ended with the Knowledge Graph on; nothing for any other run. Never throws. */
  async onRunEnd(userId: string, runId: string): Promise<boolean> {
    try {
      const kg = await this.prisma.forUser({ userId }).kgRun.findFirst({ where: { runId }, select: { mode: true } });
      if (!kg || kg.mode === 'off' || !this.jobs) return false;
      await enqueueLedgerWrite(this.jobs, { runId, userId });
      return true;
    } catch (e) {
      this.log.warn(`run ${runId}: the ledger job could not be queued: ${e instanceof Error ? e.name : 'error'}`);
      return false;
    }
  }

  /** Write (or rewrite) the run's ledger row from its own counters. `skipped` for a run without the feature or not ended. */
  async write(userId: string, runId: string): Promise<'written' | 'skipped'> {
    const db = this.prisma.forUser({ userId });
    const kg = await db.kgRun.findFirst({ where: { runId } });
    if (kg?.mode === 'everyday') return this.writeEveryday(userId, runId, kg);
    if (!kg || (kg.mode !== 'learn' && kg.mode !== 'reuse')) return 'skipped';
    const run = await db.run.findFirst({
      where: { id: runId },
      select: { taskId: true, status: true, stepCount: true, modelCalls: true, inputTokens: true, outputTokens: true, cachedInputTokens: true, costUsd: true, costKnown: true, activeMs: true, outputsComplete: true, finishedAt: true },
    });
    if (!run?.taskId || !(TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status)) return 'skipped';
    // How each step ran. Nothing replays before E46.8: every step of a run is the agent's.
    const counts = { replayed: 0, recovered: 0, judge: 0, agent: run.stepCount };
    const outcome = ledgerOutcome({ procedureVersionId: kg.procedureVersionId, counts, repaired: kg.outcome === 'repaired' });
    const data = {
      taskId: run.taskId,
      mode: kg.mode,
      procedureVersionId: kg.procedureVersionId,
      runStatus: run.status,
      stepsReplayed: counts.replayed,
      stepsRecovered: counts.recovered,
      stepsJudge: counts.judge,
      stepsAgent: counts.agent,
      modelCalls: run.modelCalls,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      cachedInputTokens: run.cachedInputTokens,
      costUsd: run.costUsd,
      costKnown: run.costKnown,
      activeMs: run.activeMs,
      outcome,
      checksPassed: kg.procedureVersionId ? run.status === 'succeeded' && run.outputsComplete !== false : null,
      finishedAt: run.finishedAt ?? new Date(),
    };
    // Create, or rewrite the row a repeat (or a concurrent attempt) already wrote; the metrics count the first write only.
    let created = false;
    try {
      await db.kgLedger.create({ data: { runId, userId, ...data } });
      created = true;
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      await db.kgLedger.update({ where: { runId }, data });
    }
    if (created) {
      this.metrics.run(kg.mode as 'learn' | 'reuse', outcome);
      try {
        this.metrics.modelCallsSaved(modelCallsSaved(outcome, run.modelCalls, await this.baseline(userId, run.taskId)));
      } catch (e) {
        this.log.warn(`run ${runId}: the saved-calls metric was not recorded: ${e instanceof Error ? e.name : 'error'}`);
      }
    }
    return 'written';
  }

  /**
   * The row of an `everyday` run (E46.28): a chat or one-off run in which the agent chose `run_procedure`. It has no task, so it never enters
   * a task's baseline and no saving is computed for it. Steps: those the procedures replayed (counted when they ran) and the rest the agent's.
   * Outcome: `replayed_clean` while every procedure it ran finished, `fell_back` once one stopped and the agent went on.
   */
  private async writeEveryday(userId: string, runId: string, kg: { procedureVersionId: string | null; outcome: string | null; stepsReplayed: number }): Promise<'written' | 'skipped'> {
    if (!kg.procedureVersionId) return 'skipped';
    const db = this.prisma.forUser({ userId });
    const run = await db.run.findFirst({
      where: { id: runId },
      select: { status: true, stepCount: true, modelCalls: true, inputTokens: true, outputTokens: true, cachedInputTokens: true, costUsd: true, costKnown: true, activeMs: true, finishedAt: true },
    });
    if (!run || !(TERMINAL_RUN_STATUSES as readonly string[]).includes(run.status)) return 'skipped';
    const replayed = Math.max(0, kg.stepsReplayed);
    const outcome: LedgerOutcome = kg.outcome === 'procedure_done' ? 'replayed_clean' : 'fell_back';
    const data = {
      taskId: null,
      mode: 'everyday',
      procedureVersionId: kg.procedureVersionId,
      runStatus: run.status,
      stepsReplayed: replayed,
      stepsRecovered: 0,
      stepsJudge: 0,
      stepsAgent: Math.max(0, run.stepCount - replayed),
      modelCalls: run.modelCalls,
      inputTokens: run.inputTokens,
      outputTokens: run.outputTokens,
      cachedInputTokens: run.cachedInputTokens,
      costUsd: run.costUsd,
      costKnown: run.costKnown,
      activeMs: run.activeMs,
      outcome,
      checksPassed: null,
      finishedAt: run.finishedAt ?? new Date(),
    };
    let created = false;
    try {
      await db.kgLedger.create({ data: { runId, userId, ...data } });
      created = true;
    } catch (e) {
      if (!(e instanceof Prisma.PrismaClientKnownRequestError && e.code === 'P2002')) throw e;
      await db.kgLedger.update({ where: { runId }, data });
    }
    if (created) this.metrics.run('everyday', outcome);
    return 'written';
  }

  /**
   * The task's AI-only baseline: the median of its newest ≤ 10 AI-only runs that succeeded, from the ledger's `ai_only` rows and the task's
   * runs that finished before its first ledger row (the runs from before the feature was on). Null with none.
   */
  async baseline(userId: string, taskId: string): Promise<Figures | null> {
    const db = this.prisma.forUser({ userId });
    const fields = { modelCalls: true, costUsd: true, costKnown: true, activeMs: true, finishedAt: true } as const;
    const [aiOnly, first] = await Promise.all([
      db.kgLedger.findMany({ where: { taskId, mode: { not: 'everyday' }, outcome: 'ai_only', runStatus: 'succeeded' }, orderBy: { finishedAt: 'desc' }, take: 10, select: fields }),
      db.kgLedger.findFirst({ where: { taskId, mode: { not: 'everyday' } }, orderBy: { finishedAt: 'asc' }, select: { finishedAt: true } }),
    ]);
    const before = await db.run.findMany({
      where: { taskId, status: 'succeeded', finishedAt: first ? { lt: first.finishedAt } : { not: null } },
      orderBy: { finishedAt: 'desc' },
      take: 10,
      select: fields,
    });
    return baselineOf([...aiOnly, ...before].map(figures));
  }

  private async ownTask(userId: string, taskId: string): Promise<{ id: string; name: string }> {
    const task = await this.prisma.forUser({ userId }).task.findFirst({ where: { id: taskId, userId }, select: { id: true, name: true } });
    if (!task) throw new NotFoundException({ code: 'KGRAPH_TASK_NOT_FOUND', message: 'Task not found' });
    return task;
  }

  /** `GET /api/kgraph/ledger?taskId=`: the task's newest rows and its baseline. */
  async ledger(userId: string, taskId: string) {
    await this.ownTask(userId, taskId);
    const rows = (await this.prisma.forUser({ userId }).kgLedger.findMany({ where: { taskId, mode: { not: 'everyday' } }, orderBy: { finishedAt: 'desc' }, take: LEDGER_ROWS })) as LedgerRow[];
    const baseline = await this.baseline(userId, taskId);
    return { taskId, baseline, note: baseline ? null : 'no baseline yet', rows: rows.map(rowView) };
  }

  /**
   * `GET /api/kgraph/summary`: per task with ledger rows, its runs, clean-replay rate and figures against the baseline; and the number of
   * procedure runs inside chats and one-off runs (`everyday` rows, E46.28), which belong to no task.
   */
  async summary(userId: string) {
    const db = this.prisma.forUser({ userId });
    const groups = await db.kgLedger.groupBy({ by: ['taskId'], where: { userId, taskId: { not: null }, mode: { not: 'everyday' } }, _max: { finishedAt: true }, orderBy: { _max: { finishedAt: 'desc' } }, take: SUMMARY_TASKS });
    const ids = groups.flatMap((g) => (g.taskId ? [g.taskId] : []));
    const names = new Map((await db.task.findMany({ where: { id: { in: ids }, userId }, select: { id: true, name: true } })).map((t) => [t.id, t.name]));
    const tasks = [];
    for (const taskId of ids) {
      if (!names.has(taskId)) continue;
      const rows = (await db.kgLedger.findMany({ where: { taskId, mode: { not: 'everyday' } }, orderBy: { finishedAt: 'desc' }, take: SUMMARY_ROWS })) as LedgerRow[];
      const runs: LedgerRunFigures[] = rows.map((r) => ({ ...figures(r), outcome: r.outcome as LedgerOutcome }));
      tasks.push({ taskId, taskName: names.get(taskId)!, ...summarize(runs, await this.baseline(userId, taskId)) });
    }
    const everydayProcedureRuns = await db.kgLedger.count({ where: { userId, mode: 'everyday' } });
    return { tasks, everydayProcedureRuns };
  }
}

function rowView(r: LedgerRow) {
  return {
    runId: r.runId,
    mode: r.mode,
    procedureVersionId: r.procedureVersionId,
    runStatus: r.runStatus,
    steps: { replayed: r.stepsReplayed, recovered: r.stepsRecovered, judge: r.stepsJudge, agent: r.stepsAgent },
    modelCalls: r.modelCalls,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    cachedInputTokens: r.cachedInputTokens,
    costUsd: Number(r.costUsd),
    costKnown: r.costKnown,
    activeMs: r.activeMs,
    outcome: r.outcome,
    checksPassed: r.checksPassed,
    finishedAt: r.finishedAt.toISOString(),
  };
}
