import { ConflictException, Injectable, NotFoundException, Optional } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { assertTransition, isTerminal, type RunStatus } from './run-status';
import type { CreateTaskDto, ListRunsDto, UpdateTaskDto } from './tasks.schemas';
import { FabricClient } from '../fabric/fabric.client';
import { RunMetrics } from './run-metrics';

/** Fields a status change may set. */
export interface RunPatch {
  result?: string | null;
  error?: string | null;
  sessionId?: string | null;
  handoffId?: string | null;
  transcript?: Prisma.InputJsonValue;
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

  listTasks(userId: string) {
    return this.db(userId).task.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async getTask(userId: string, id: string) {
    const t = await this.db(userId).task.findFirst({ where: { id } });
    if (!t) throw new NotFoundException({ code: 'TASK_NOT_FOUND', message: 'Task not found' });
    return t;
  }

  createTask(userId: string, input: CreateTaskDto) {
    return this.db(userId).task.create({ data: { ...input, userId, hostId: input.hostId ?? null, model: input.model ?? null } });
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

  listRuns(userId: string, q: ListRunsDto) {
    return this.db(userId).run.findMany({
      where: { ...(q.taskId ? { taskId: q.taskId } : {}), ...(q.status ? { status: q.status } : {}) },
      orderBy: { createdAt: 'desc' },
      take: q.limit,
      omit: { transcript: true },
    });
  }

  async getRun(userId: string, id: string) {
    const r = await this.db(userId).run.findFirst({
      where: { id },
      omit: { transcript: true },
      include: { steps: { orderBy: { seq: 'asc' } } },
    });
    if (!r) throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: 'Run not found' });
    return r;
  }

  /**
   * Move a run to `to`, enforcing the state machine. Sets `startedAt` on the
   * first `running` and `finishedAt` on a terminal state.
   */
  async transition(userId: string, id: string, to: RunStatus, patch: RunPatch = {}) {
    const db = this.db(userId);
    for (let attempt = 0; attempt < 5; attempt++) {
      const run = await db.run.findFirst({ where: { id }, select: { status: true, startedAt: true, createdAt: true, trigger: true } });
      if (!run) throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: 'Run not found' });
      assertTransition(run.status as RunStatus, to);
      const now = new Date();
      // Compare-and-set on the old status, so two writers cannot both win.
      const { count } = await db.run.updateMany({
        where: { id, status: run.status },
        data: {
          status: to,
          ...patch,
          ...(to === 'running' && !run.startedAt ? { startedAt: now } : {}),
          ...(isTerminal(to) ? { finishedAt: now } : {}),
        },
      });
      if (count === 1) {
        if (to === 'running' && !run.startedAt) this.metrics.started(run.trigger);
        if (to === 'waiting_human') this.metrics.handoff();
        if (isTerminal(to)) this.metrics.finished(to, run.trigger, (now.getTime() - (run.startedAt ?? run.createdAt).getTime()) / 1000);
        return db.run.findFirstOrThrow({ where: { id }, omit: { transcript: true } });
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
