import { ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { ownerDefaultUseSavedLogins } from '../secrets/saved-logins-default';
import { readConfirmedActions, withConfirmedLead } from '../runner/confirmed-actions';
import { STEP_QUESTION_SELECT, stepView } from './run-trace.view';
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
import { prepareParameters } from './task-params';
import { readParameters } from './task-params.schemas';
import { prepareOutputs } from './task-outputs';

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
  /** With a terminal status: what the agent returned (E39.5), `{ [key]: { value, ok, note? } }`, already validated. */
  outputs?: Prisma.InputJsonValue;
  /** With `outputs`: whether every output was returned and valid. */
  outputsComplete?: boolean | null;
}

/**
 * Tasks and runs, always through `forUser()`: a user only sees and changes
 * their own. Status changes go through `transition`, which enforces the run
 * state machine (run-status.ts).
 */
@Injectable()
export class TasksService {
  private readonly log = new Logger(TasksService.name);

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
    const { policyId, schedules, parameters: defs, outputs: outputDefs, useSavedLogins, ...fields } = input;
    // The goal's `{{Name}}` parameters (#552): inferred where not defined, checked (400 names the problem).
    const parameters = prepareParameters(fields.goal, defs);
    // The values a run must return (E39.5, #600): keys derived, checked; none stored as null.
    const outputs = prepareOutputs(outputDefs);
    await this.policies?.assertAssignable(userId, policyId);
    const prepared = schedules?.length && this.taskSchedules ? await this.taskSchedules.prepare(userId, schedules, { request, parameters }) : [];
    const limits = { maxSteps: fields.maxSteps, maxMinutes: fields.maxMinutes, model: fields.model ?? null };
    const policyRef = policyId !== undefined ? policyId : this.policies && !isDefaultLimits(limits) ? await this.policies.ensureLegacyPolicy(userId, fields.name, limits) : null;
    // Absent: the owner's `secrets.defaultUseSavedLogins` (E37.3), off unless they turned it on.
    const data = {
      ...fields,
      userId,
      hostId: fields.hostId ?? null,
      model: fields.model ?? null,
      policyRef,
      parameters: parameters as unknown as Prisma.InputJsonValue,
      outputs: outputs.length ? (outputs as unknown as Prisma.InputJsonValue) : Prisma.DbNull,
      useSavedLogins: useSavedLogins ?? (await ownerDefaultUseSavedLogins(this.prisma, userId)),
    };
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
    const { policyId, parameters: defs, outputs: outputDefs, ...fields } = patch;
    await this.policies?.assertAssignable(userId, policyId);
    const data: Prisma.TaskUpdateManyMutationInput = { ...fields };
    // A new goal or new definitions: the parameters are reconciled with the goal again (#552).
    if (fields.goal !== undefined || defs !== undefined) {
      const task = await this.getTask(userId, id);
      data.parameters = prepareParameters(fields.goal ?? task.goal, defs ?? readParameters(task.parameters)) as unknown as Prisma.InputJsonValue;
    }
    // New output definitions replace the task's (E39.5): an empty list removes them. Runs already started keep theirs.
    if (outputDefs !== undefined) {
      const outputs = prepareOutputs(outputDefs);
      data.outputs = outputs.length ? (outputs as unknown as Prisma.InputJsonValue) : Prisma.DbNull;
    }
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
      omit: { transcript: true, spanId: true, traceIds: true },
      include: { steps: { orderBy: { seq: 'asc' }, include: { question: { select: STEP_QUESTION_SELECT } } } },
    });
    if (!r) throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: 'Run not found' });
    // The memories it used (#553), by label: the ones that still exist.
    const memories = r.memoryIds.length ? await this.db(userId).memory.findMany({ where: { id: { in: r.memoryIds } }, select: { id: true, label: true, status: true }, orderBy: { label: 'asc' } }) : [];
    // Steps carry the masked question and whether they have a trace picture, never its object key (#541).
    return withCost({ ...r, steps: r.steps.map(stepView), confirmedActions: readConfirmedActions(r.confirmedActions), memories });
  }

  /**
   * Move a run to `to`, enforcing the state machine. Sets `startedAt` on the
   * first `running` and `finishedAt` on a terminal state.
   */
  async transition(userId: string, id: string, to: RunStatus, patch: RunPatch = {}) {
    const db = this.db(userId);
    for (let attempt = 0; attempt < 5; attempt++) {
      const run = await db.run.findFirst({ where: { id }, select: { status: true, startedAt: true, createdAt: true, trigger: true, activeMs: true, activeSince: true, result: true, confirmedActions: true, cancelRequestedAt: true, outputsSpec: true, outputsComplete: true } });
      if (!run) throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: 'Run not found' });
      assertTransition(run.status as RunStatus, to);
      const now = new Date();
      const { handoffExpiresAt, ...fields } = patch;
      // A run that carried out a step its owner confirmed and then did not succeed says so first (#540),
      // whatever ended it (a budget, a stall, Stop, a lost node, an error).
      if (isTerminal(to) && to !== 'succeeded') {
        const confirmed = readConfirmedActions(run.confirmedActions);
        if (confirmed.length) fields.result = withConfirmedLead(fields.result ?? run.result ?? '', confirmed, to).slice(0, 8000);
      }
      // A run with outputs that ends without having returned them (Stop, an error, a lost node) has not got them all (E39.5).
      if (isTerminal(to) && run.outputsSpec !== null && run.outputsComplete === null && fields.outputsComplete === undefined) fields.outputsComplete = false;
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
          ...(to === 'running' ? { activeSince: now, pausedAt: null } : {}),
          // Paused (E38.2): the moment, for "paused for N minutes" and the one-hour notice; a pause is a fresh start of that notice.
          ...(to === 'paused' ? { pausedAt: now, pauseNotifiedAt: null } : {}),
          ...(run.status === 'running' && to !== 'running' ? { activeMs: activeElapsedMs(run, now.getTime()), activeSince: null } : {}),
          ...(isTerminal(to) ? { finishedAt: now } : {}),
        },
      });
      if (count === 1) {
        // A finished run asks nothing any more: withdraw its pending questions.
        // A memory proposal (#553) is not a request of the run: it stays for its owner to answer.
        if (isTerminal(to)) await this.prisma.question.updateMany({ where: { runId: id, status: 'pending', blocking: true }, data: { status: 'cancelled' } });
        if (to === 'running' && !run.startedAt) this.metrics.started(run.trigger);
        if (to === 'waiting_human') this.metrics.handoff();
        const saved = await db.run.findFirstOrThrow({ where: { id }, omit: { transcript: true, spanId: true, traceIds: true } });
        // After the write: wake anyone following the run (MCP run_wait).
        await this.events?.publish({ type: 'run.status', runId: id, ownerUserId: userId, status: to });
        if (isTerminal(to)) {
          this.metrics.finished(to, run.trigger, (now.getTime() - (run.startedAt ?? run.createdAt).getTime()) / 1000);
          if (saved.modelCalls > 0 && saved.costKnown) this.metrics.cost(to, Number(saved.costUsd));
          // Stop was pressed (E38.1): how long it took from the request to the end. A metric and one log line; no goal, page text or user.
          if (run.cancelRequestedAt) {
            const ms = Math.max(0, now.getTime() - run.cancelRequestedAt.getTime());
            this.metrics.stopLatency(to, ms);
            this.log.log(`run ${id}: Stop took ${ms} ms (${to})`);
          }
          // After the write: whoever follows the run's end (a chat writes the result into its thread).
          await this.endHooks?.fire(userId, id);
        }
        return withCost(saved);
      }
    }
    throw new ConflictException({ code: 'RUN_BUSY', message: 'The run changed while it was being updated; try again' });
  }

  /**
   * Cancel: at once while queued or waiting for a person; otherwise flag it for the runner and tell it now (`run.cancel`,
   * E38.1): the runner stops before its next action and aborts the model call or wait in flight, within about two seconds.
   * The first press stamps `cancelRequestedAt`, the start of the stop-latency measure; a second press changes nothing.
   */
  async cancel(userId: string, id: string) {
    const run = await this.getRun(userId, id);
    if (isTerminal(run.status as RunStatus)) return run;
    await this.db(userId).run.updateMany({ where: { id, cancelRequestedAt: null }, data: { cancelRequestedAt: new Date() } });
    if (run.status === 'queued') return this.transition(userId, id, 'cancelled', { error: 'Cancelled before it started', stopReason: 'cancelled' });
    // Paused (E38.2): no job holds it. End the browser session and cancel now.
    if (run.status === 'paused') {
      if (this.fabric && run.sessionId) await this.fabric.request('DELETE', `/v1/sessions/${run.sessionId}`).catch(() => undefined);
      return this.transition(userId, id, 'cancelled', { error: 'Cancelled by the user', stopReason: 'cancelled' });
    }
    // Waiting for a person, nothing is running to see the flag: withdraw the
    // request, end the browser session and cancel now (best effort on the fabric).
    if (run.status === 'waiting_human') {
      if (this.fabric && run.handoffId) await this.fabric.request('POST', `/v1/handoffs/${run.handoffId}/cancel`).catch(() => undefined);
      if (this.fabric && run.sessionId) await this.fabric.request('DELETE', `/v1/sessions/${run.sessionId}`).catch(() => undefined);
      return this.transition(userId, id, 'cancelled', { error: 'Cancelled by the user', stopReason: 'cancelled' });
    }
    await this.db(userId).run.updateMany({ where: { id }, data: { cancelRequested: true } });
    // After the write, so the worker that hears it finds the flag set; the poll covers a lost event.
    await this.events?.publish({ type: 'run.cancel', runId: id, ownerUserId: userId });
    return this.getRun(userId, id);
  }
}
