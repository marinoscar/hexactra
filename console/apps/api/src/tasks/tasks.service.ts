import { ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { assertTransition, isTerminal, type RunStatus } from './run-status';
import type { CreateTaskDto, UpdateTaskDto } from './tasks.schemas';
import { FabricClient } from '../fabric/fabric.client';
import { activeElapsedMs } from '../runner/active-time';
import { RunEndHooks } from './run-end-hooks';
import { RunEvents } from './run-events';
import { RunMetrics } from './run-metrics';
import { PoliciesService } from '../policies/policies.service';
import type { RunStopReason } from '../runner/budget';
import { isDefaultLimits } from '../policies/legacy-task-policy';
import { STOP_WAITING, startWaiting } from './reminder-schedule';
import { averageUsd, NO_SPEND, SPEND_WINDOW_DAYS, withCost, type TaskSpend } from './run-cost';
import type { RequestWithHeaders } from '@marinoscar/platform-api/core';
import { TaskSchedulesService } from './task-schedules.service';

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
  /** With a terminal status: why the run stopped (#404). */
  stopReason?: RunStopReason | null;
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
    @Optional() private readonly policies?: PoliciesService,
    @Optional() private readonly taskSchedules?: TaskSchedulesService,
    @Optional() readonly events?: RunEvents,
    @Optional() readonly endHooks?: RunEndHooks,
  ) {}

  /** Tell waiters (MCP `run_wait`) that a run recorded a step; after the write. Never fails. */
  async stepRecorded(ownerUserId: string, runId: string, stepCount: number): Promise<void> {
    await this.events?.publish({ type: 'run.step', runId, ownerUserId, stepCount });
  }

  private db(userId: string) {
    return this.prisma.forUser({ userId });
  }

  /** What each task spent in the last 30 days (runs created in the window), by task id. */
  async spendByTask(userId: string, taskIds: string[]): Promise<Map<string, TaskSpend>> {
    const out = new Map<string, TaskSpend>();
    if (taskIds.length === 0) return out;
    const db = this.db(userId);
    const where = { taskId: { in: taskIds }, createdAt: { gte: new Date(Date.now() - SPEND_WINDOW_DAYS * 86_400_000) } };
    const [sums, unknown, successes] = await Promise.all([
      db.run.groupBy({ by: ['taskId'], where, _count: { _all: true }, _sum: { costUsd: true, inputTokens: true, outputTokens: true } }),
      db.run.groupBy({ by: ['taskId'], where: { ...where, costKnown: false }, _count: { _all: true } }),
      db.run.groupBy({ by: ['taskId'], where: { ...where, status: 'succeeded' }, _count: { _all: true }, _sum: { costUsd: true } }),
    ]);
    const unpriced = new Set(unknown.map((g) => g.taskId));
    const won = new Map(successes.map((g) => [g.taskId, { count: g._count._all, costUsd: Number(g._sum.costUsd ?? 0) }]));
    for (const g of sums) {
      if (!g.taskId) continue;
      const ok = won.get(g.taskId);
      out.set(g.taskId, {
        runs: g._count._all,
        costUsd: Number(g._sum.costUsd ?? 0),
        costKnown: !unpriced.has(g.taskId),
        tokens: (g._sum.inputTokens ?? 0) + (g._sum.outputTokens ?? 0),
        succeeded: ok?.count ?? 0,
        avgSuccessCostUsd: ok ? averageUsd(ok.costUsd, ok.count) : null,
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

  /**
   * Create a task. `policyId` names its agent policy (null follows the user's
   * default). The deprecated `maxSteps` / `maxMinutes` / `model` still work: when
   * no `policyId` is given and they are not the defaults they map to a derived
   * personal policy named "Task: <name>" (#401).
   *
   * `schedules` are created with the task in one transaction (#424): they are
   * all checked first, so one invalid schedule fails the request with its place
   * in the list (`details.path`, e.g. `schedules[1].cron`) and nothing is created.
   * `request` supplies the device time zone for a schedule that names none.
   */
  async createTask(userId: string, input: CreateTaskDto, request?: RequestWithHeaders) {
    const { policyId, schedules, ...fields } = input;
    await this.policies?.assertAssignable(userId, policyId);
    const prepared = schedules?.length && this.taskSchedules ? await this.taskSchedules.prepare(userId, schedules, { request }) : [];
    const limits = { maxSteps: fields.maxSteps, maxMinutes: fields.maxMinutes, model: fields.model ?? null };
    const policyRef = policyId !== undefined ? policyId : this.policies && !isDefaultLimits(limits) ? await this.policies.ensureLegacyPolicy(userId, fields.name, limits) : null;
    const data = { ...fields, userId, hostId: fields.hostId ?? null, model: fields.model ?? null, policyRef };
    if (prepared.length === 0) return { ...(await this.db(userId).task.create({ data })), spend30d: NO_SPEND };
    const t = await this.prisma.$transaction(async (tx) => {
      const task = await tx.task.create({ data });
      await tx.taskSchedule.createMany({ data: this.taskSchedules!.rows(userId, task.id, prepared) });
      return task;
    });
    return { ...t, spend30d: NO_SPEND };
  }

  /** Update a task. A legacy limit in the patch re-derives the task's policy unless `policyId` is also given. */
  async updateTask(userId: string, id: string, patch: UpdateTaskDto) {
    const { policyId, ...fields } = patch;
    await this.policies?.assertAssignable(userId, policyId);
    const data: Prisma.TaskUpdateManyMutationInput = { ...fields };
    if (policyId !== undefined) {
      data.policyRef = policyId;
    } else if (this.policies && (fields.maxSteps !== undefined || fields.maxMinutes !== undefined || fields.model !== undefined)) {
      const task = await this.getTask(userId, id);
      const limits = {
        maxSteps: fields.maxSteps ?? task.maxSteps,
        maxMinutes: fields.maxMinutes ?? task.maxMinutes,
        model: fields.model !== undefined ? fields.model : task.model,
      };
      // Back at the defaults with no pinned model: follow the user's default again.
      data.policyRef = isDefaultLimits(limits) ? null : await this.policies.ensureLegacyPolicy(userId, fields.name ?? task.name, limits);
    }
    const { count } = await this.db(userId).task.updateMany({ where: { id }, data });
    if (count === 0) throw new NotFoundException({ code: 'TASK_NOT_FOUND', message: 'Task not found' });
    return this.getTask(userId, id);
  }

  async deleteTask(userId: string, id: string): Promise<void> {
    const { count } = await this.db(userId).task.deleteMany({ where: { id } });
    if (count === 0) throw new NotFoundException({ code: 'TASK_NOT_FOUND', message: 'Task not found' });
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
        // After the write: wake anyone following the run (MCP run_wait).
        await this.events?.publish({ type: 'run.status', runId: id, ownerUserId: userId, status: to });
        if (isTerminal(to)) {
          this.metrics.finished(to, run.trigger, (now.getTime() - (run.startedAt ?? run.createdAt).getTime()) / 1000);
          if (saved.modelCalls > 0 && saved.costKnown) this.metrics.cost(to, Number(saved.costUsd));
          // After the write: whoever follows the run's end (a chat writes the result into its thread).
          await this.endHooks?.fire(userId, id);
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
    if (run.status === 'queued') return this.transition(userId, id, 'cancelled', { error: 'Cancelled before it started', stopReason: 'cancelled' });
    // Waiting for a person, nothing is running to see the flag: withdraw the
    // request, end the browser session and cancel now (best effort on the fabric).
    if (run.status === 'waiting_human') {
      if (this.fabric && run.handoffId) await this.fabric.request('POST', `/v1/handoffs/${run.handoffId}/cancel`).catch(() => undefined);
      if (this.fabric && run.sessionId) await this.fabric.request('DELETE', `/v1/sessions/${run.sessionId}`).catch(() => undefined);
      return this.transition(userId, id, 'cancelled', { error: 'Cancelled by the user', stopReason: 'cancelled' });
    }
    await this.db(userId).run.updateMany({ where: { id }, data: { cancelRequested: true } });
    return this.getRun(userId, id);
  }
}
