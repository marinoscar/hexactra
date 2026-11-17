import { ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { assertTransition, isTerminal, type RunStatus } from './run-status';
import type { CreateTaskDto, ListRunsDto, UpdateTaskDto } from './tasks.schemas';
import { FabricClient } from '../fabric/fabric.client';
import { activeElapsedMs } from '../runner/active-time';
import { RunMetrics } from './run-metrics';
import { STOP_WAITING, startWaiting } from './reminder-schedule';
import { NO_SPEND, SPEND_WINDOW_DAYS, withCost, type TaskSpend } from './run-cost';

/** Fields a status change may set. */
export interface RunPatch {
  result?: string | null;
  error?: string | null;
  sessionId?: string | null;
  handoffId?: string | null;
  transcript?: Prisma.InputJsonValue;
  /** With `waiting_human`: when the fabric handoff expires (schedules the reminders). */
  handoffExpiresAt?: Date | null;
  /** With `running`: what the runner is doing now (#379). Any other status clears it. */
  activity?: Prisma.InputJsonValue;
}

/**
 * Tasks and runs, always through `forUser()`: a user only sees and changes
 * their own. Status changes go through `transition`, which enforces the run
 * state machine (run-status.ts).
 */
@Injectable()
export class TasksService {
  constructor(
    private readonly prisma: PrismaService,
    @Optional() readonly metrics: RunMetrics = new RunMetrics(),
    @Optional() private readonly fabric?: FabricClient,
  ) {}

  private db(userId: string) {
    return this.prisma.forUser({ userId });
  }

  /** What each task spent in the last 30 days (runs created in the window), by task id. */
  async spendByTask(userId: string, taskIds: string[]): Promise<Map<string, TaskSpend>> {
    const out = new Map<string, TaskSpend>();
    if (taskIds.length === 0) return out;
    const db = this.db(userId);
    const where = { taskId: { in: taskIds }, createdAt: { gte: new Date(Date.now() - SPEND_WINDOW_DAYS * 86_400_000) } };
    const [sums, unknown] = await Promise.all([
      db.run.groupBy({ by: ['taskId'], where, _count: { _all: true }, _sum: { costUsd: true, inputTokens: true, outputTokens: true } }),
      db.run.groupBy({ by: ['taskId'], where: { ...where, costKnown: false }, _count: { _all: true } }),
    ]);
    const unpriced = new Set(unknown.map((g) => g.taskId));
    for (const g of sums) {
      if (!g.taskId) continue;
      out.set(g.taskId, {
        runs: g._count._all,
        costUsd: Number(g._sum.costUsd ?? 0),
        costKnown: !unpriced.has(g.taskId),
        tokens: (g._sum.inputTokens ?? 0) + (g._sum.outputTokens ?? 0),
      });
    }
    return out;
  }

  private async withSpend<T extends { id: string }>(userId: string, tasks: T[]): Promise<(T & { spend30d: TaskSpend })[]> {
    const spend = await this.spendByTask(userId, tasks.map((t) => t.id));
    return tasks.map((t) => ({ ...t, spend30d: spend.get(t.id) ?? NO_SPEND }));
  }

  async listTasks(userId: string) {
    return this.withSpend(userId, await this.db(userId).task.findMany({ orderBy: { createdAt: 'desc' } }));
  }

  async getTask(userId: string, id: string) {
    const t = await this.db(userId).task.findFirst({ where: { id } });
    if (!t) throw new NotFoundException({ code: 'TASK_NOT_FOUND', message: 'Task not found' });
    return (await this.withSpend(userId, [t]))[0]!;
  }

  async createTask(userId: string, input: CreateTaskDto) {
    const t = await this.db(userId).task.create({ data: { ...input, userId, hostId: input.hostId ?? null, model: input.model ?? null } });
    return { ...t, spend30d: NO_SPEND };
  }

  async updateTask(userId: string, id: string, patch: UpdateTaskDto) {
    const { count } = await this.db(userId).task.updateMany({ where: { id }, data: patch });
    if (count === 0) throw new NotFoundException({ code: 'TASK_NOT_FOUND', message: 'Task not found' });
    return this.getTask(userId, id);
  }

  async deleteTask(userId: string, id: string): Promise<void> {
    const { count } = await this.db(userId).task.deleteMany({ where: { id } });
    if (count === 0) throw new NotFoundException({ code: 'TASK_NOT_FOUND', message: 'Task not found' });
  }

  async listRuns(userId: string, q: ListRunsDto) {
    const runs = await this.db(userId).run.findMany({
      where: { ...(q.taskId ? { taskId: q.taskId } : {}), ...(q.status ? { status: q.status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
      omit: { transcript: true },
    });
    return runs.map(withCost);
  }

  async getRun(userId: string, id: string) {
    const r = await this.db(userId).run.findFirst({
      where: { id },
      omit: { transcript: true },
      include: { steps: { orderBy: { seq: 'asc' } } },
    });
    if (!r) throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: 'Run not found' });
    return withCost(r);
  }

  /**
   * Move a run to `to`, enforcing the state machine. Sets `startedAt` on the
   * first `running` and `finishedAt` on a terminal state.
   */
  async transition(userId: string, id: string, to: RunStatus, patch: RunPatch = {}) {
    const db = this.db(userId);
    for (let attempt = 0; attempt < 5; attempt++) {
      const run = await db.run.findFirst({ where: { id }, select: { status: true, startedAt: true, createdAt: true, trigger: true, activeMs: true, activeSince: true } });
      if (!run) throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: 'Run not found' });
      assertTransition(run.status as RunStatus, to);
      const now = new Date();
      const { handoffExpiresAt, ...fields } = patch;
      // Compare-and-set on the old status, so two writers cannot both win.
      const { count } = await db.run.updateMany({
        where: { id, status: run.status },
        data: {
          status: to,
          ...fields,
          // Only a running run is doing something right now (#379).
          ...(to !== 'running' ? { activity: Prisma.DbNull } : {}),
          // Reminders while it waits for its person (run-reminders.ts).
          ...(to === 'waiting_human' ? startWaiting(now, handoffExpiresAt ?? null) : run.status === 'waiting_human' ? STOP_WAITING : {}),
          ...(to === 'running' && !run.startedAt ? { startedAt: now } : {}),
          // Active time: open a stretch on entering `running`, settle it on leaving (#399).
          ...(to === 'running' ? { activeSince: now } : {}),
          ...(run.status === 'running' && to !== 'running' ? { activeMs: activeElapsedMs(run, now.getTime()), activeSince: null } : {}),
          ...(isTerminal(to) ? { finishedAt: now } : {}),
        },
      });
      if (count === 1) {
        // A finished run asks nothing any more: withdraw its pending questions.
        if (isTerminal(to)) await this.prisma.question.updateMany({ where: { runId: id, status: 'pending' }, data: { status: 'cancelled' } });
        if (to === 'running' && !run.startedAt) this.metrics.started(run.trigger);
        if (to === 'waiting_human') this.metrics.handoff();
        const saved = await db.run.findFirstOrThrow({ where: { id }, omit: { transcript: true } });
        if (isTerminal(to)) {
          this.metrics.finished(to, run.trigger, (now.getTime() - (run.startedAt ?? run.createdAt).getTime()) / 1000);
          if (saved.modelCalls > 0 && saved.costKnown) this.metrics.cost(to, Number(saved.costUsd));
        }
        return withCost(saved);
      }
    }
    throw new ConflictException({ code: 'RUN_BUSY', message: 'The run changed while it was being updated; try again' });
  }

  /** Cancel: at once while queued; otherwise flag it for the runner, which stops between steps. */
  async cancel(userId: string, id: string) {
    const run = await this.getRun(userId, id);
    if (isTerminal(run.status as RunStatus)) return run;
    if (run.status === 'queued') return this.transition(userId, id, 'cancelled', { error: 'Cancelled before it started' });
    // Waiting for a person, nothing is running to see the flag: withdraw the
    // request, end the browser session and cancel now (best effort on the fabric).
    if (run.status === 'waiting_human') {
      if (this.fabric && run.handoffId) await this.fabric.request('POST', `/v1/handoffs/${run.handoffId}/cancel`).catch(() => undefined);
      if (this.fabric && run.sessionId) await this.fabric.request('DELETE', `/v1/sessions/${run.sessionId}`).catch(() => undefined);
      return this.transition(userId, id, 'cancelled', { error: 'Cancelled by the user' });
    }
    await this.db(userId).run.updateMany({ where: { id }, data: { cancelRequested: true } });
    return this.getRun(userId, id);
  }
}
