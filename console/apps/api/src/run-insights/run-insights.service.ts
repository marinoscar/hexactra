import { Injectable, Logger, NotFoundException } from '@nestjs/common';

import { snapshotBudgetView } from '../policies/policy-snapshot';
import { PrismaService } from '../prisma/prisma.service';
import { maskSensitive } from '../tasks/mask';
import { diagnoseRun, type DiagnosticStep, type RunFinding } from './run-diagnostics';
import { TERMINAL_RUN_STATUSES } from '../tasks/run-status';
import { consistencyOf, type TaskConsistency } from './task-consistency';

/** The newest runs of a consistency view whose findings are read (E52.7): bounds the step reads. */
export const CONSISTENCY_FINDINGS_RUNS = 10;

/** Most steps one diagnosis reads (E52.6): a longer run is diagnosed on its first ones and says so. */
export const DIAGNOSTICS_MAX_STEPS = 2_000;

export interface RunDiagnostics {
  runId: string;
  computedAt: string;
  stepsRead: number;
  truncated: boolean;
  findings: RunFinding[];
}

/** Masks every string a finding holds: its title, detail and the strings of its evidence. */
export function maskFinding(f: RunFinding): RunFinding {
  const m = (s: string) => maskSensitive(s).text;
  const evidence: RunFinding['evidence'] = {};
  for (const [k, v] of Object.entries(f.evidence)) evidence[k] = typeof v === 'string' ? m(v) : v;
  return { ...f, title: m(f.title), detail: m(f.detail), evidence };
}

/**
 * Run findings (E52.6, #1021): where a run spent effort it did not need, computed on read from its own step rows. No table, no cache,
 * no model. The owner's runs only (another user's run is a 404). A failure of the diagnosis answers no findings; it never fails the page.
 */
@Injectable()
export class RunInsightsService {
  private readonly log = new Logger(RunInsightsService.name);

  constructor(private readonly prisma: PrismaService) {}

  async diagnostics(userId: string, runId: string, now = new Date()): Promise<RunDiagnostics> {
    const db = this.prisma.forUser({ userId });
    const run = await db.run.findFirst({
      where: { id: runId },
      select: { id: true, startedAt: true, policySnapshot: true, stepCount: true, modelCalls: true, inputTokens: true, outputTokens: true, costUsd: true, costKnown: true, activeMs: true, activeSince: true },
    });
    if (!run) throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: 'Run not found' });
    // Steps are read by run id once the run is known to be the owner's (as the run page reads them).
    const rows = await this.prisma.runStep.findMany({
      where: { runId },
      orderBy: { seq: 'asc' },
      take: DIAGNOSTICS_MAX_STEPS + 1,
      // Never `reasoning`: the model's own words are not facts.
      select: { seq: true, kind: true, action: true, args: true, ok: true, summary: true, phase: true, createdAt: true },
    });
    const truncated = rows.length > DIAGNOSTICS_MAX_STEPS;
    const steps: DiagnosticStep[] = rows.slice(0, DIAGNOSTICS_MAX_STEPS);
    let findings: RunFinding[] = [];
    try {
      const budget = snapshotBudgetView(run.policySnapshot as never, { ...run, costUsd: Number(run.costUsd) } as never, now.getTime());
      findings = diagnoseRun({ startedAt: run.startedAt, budget }, steps).map(maskFinding);
    } catch (e) {
      this.log.warn(`run ${runId}: the diagnosis failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return { runId, computedAt: now.toISOString(), stepsRead: steps.length, truncated, findings };
  }

  /**
   * How consistent a task's runs are (E52.7, #1022): the spread of steps, model calls, working time and cost over its last `last` runs
   * that ended (succeeded, failed or cancelled), since `since` when given. Benchmark runs are left out. The findings of the 10 newest only.
   */
  async consistency(userId: string, taskId: string, last: number, since: Date | null): Promise<TaskConsistency> {
    const db = this.prisma.forUser({ userId });
    const task = await db.task.findFirst({ where: { id: taskId }, select: { id: true } });
    if (!task) throw new NotFoundException({ code: 'TASK_NOT_FOUND', message: 'Task not found' });
    const rows = await db.run.findMany({
      where: { taskId, status: { in: [...TERMINAL_RUN_STATUSES] }, trigger: { not: 'benchmark' }, ...(since ? { createdAt: { gte: since } } : {}) },
      orderBy: { createdAt: 'desc' },
      take: last,
      select: { id: true, status: true, createdAt: true, stepCount: true, modelCalls: true, activeMs: true, costUsd: true, costKnown: true },
    });
    const findings = new Map<string, { code: string; severity: string }[]>();
    for (const r of rows.slice(0, CONSISTENCY_FINDINGS_RUNS)) {
      try {
        findings.set(r.id, (await this.diagnostics(userId, r.id)).findings.map((f) => ({ code: f.code, severity: f.severity })));
      } catch {
        findings.set(r.id, []);
      }
    }
    return consistencyOf(
      taskId,
      rows.map((r) => ({ runId: r.id, status: r.status, createdAt: r.createdAt, stepCount: r.stepCount, modelCalls: r.modelCalls, activeMs: r.activeMs, costUsd: Number(r.costUsd), costKnown: r.costKnown })),
      since,
      findings,
    );
  }
}
