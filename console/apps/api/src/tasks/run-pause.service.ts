import { ConflictException, Injectable, Logger, Optional } from '@nestjs/common';
import { JobsService } from '@marinoscar/platform-api/jobs';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { FabricClient } from '../fabric/fabric.client';
import { PrismaService } from '../prisma/prisma.service';
import { enqueueGoalRun } from '../runner/goal-run.enqueue';
import { DEFAULT_MAX_PAUSED_HOURS } from './run-retention.schemas';
import { RunNotifier } from './run-notifier';
import { isTerminal, type RunStatus } from './run-status';
import { TasksService } from './tasks.service';
import './runs.settings';

/** A paused run is reported once it has been paused this long (E38.2). Nothing is sent before. */
export const STILL_PAUSED_AFTER_MS = 60 * 60_000;
/** The reason on a run cancelled for being paused too long. */
export const PAUSED_TOO_LONG = 'Paused too long';

/**
 * Pause and Resume (E38.2, #583): the owner freezes a run and continues it later. Pause is a request: the runner that holds
 * the run ends its chunk before the next action and moves it to `paused` (nothing is aborted that has started on the browser);
 * a run waiting for a person pauses once the question is answered, before the agent acts on the answer. Resume moves a paused
 * run to `queued` and starts a job with the reason `resumed`. There is no automatic resume: a paused run waits for its owner
 * (the nightly-style sweep in `run-paused.job.ts` only cancels one paused longer than the deployment's limit).
 */
@Injectable()
export class RunPauseService {
  private readonly log = new Logger(RunPauseService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tasks: TasksService,
    private readonly jobs: JobsService,
    @Optional() private readonly notifier?: RunNotifier,
    @Optional() private readonly fabric?: FabricClient,
    @Optional() private readonly systemSettings?: SystemSettingsService,
  ) {}

  /** `runs.maxPausedHours` of the system settings: the most hours a run may stay paused; null: no limit. Default 72. */
  async maxPausedHours(): Promise<number | null> {
    try {
      const v = (await this.systemSettings?.getNamespace('runs'))?.maxPausedHours;
      return v === undefined ? DEFAULT_MAX_PAUSED_HOURS : v;
    } catch (e) {
      this.log.warn(`runs.maxPausedHours could not be read (${e instanceof Error ? e.name : 'error'}); the default applies`);
      return DEFAULT_MAX_PAUSED_HOURS;
    }
  }

  /** Whether any paused run is due for a notice or for its limit (the cron asks before it enqueues the job). */
  async anyDue(now = new Date()): Promise<boolean> {
    return (await this.prisma.run.findFirst({ where: { status: 'paused', pausedAt: { lte: new Date(now.getTime() - STILL_PAUSED_AFTER_MS) } }, select: { id: true } })) !== null;
  }

  /**
   * The sweep of the paused runs (E38.2), run by a job: a run paused for an hour is told once ("Still paused: <goal>"), and a run
   * paused longer than `runs.maxPausedHours` is cancelled with the reason "Paused too long" and its owner told. A run never resumes by itself.
   */
  async sweep(now = new Date()): Promise<{ notified: number; cancelled: number }> {
    const limit = await this.maxPausedHours();
    const rows = await this.prisma.run.findMany({
      where: { status: 'paused', pausedAt: { lte: new Date(now.getTime() - STILL_PAUSED_AFTER_MS) } },
      select: { id: true, userId: true, goal: true, taskId: true, trigger: true, conversationId: true, sessionId: true, pausedAt: true, pauseNotifiedAt: true },
      orderBy: { pausedAt: 'asc' },
      take: 200,
    });
    let notified = 0;
    let cancelled = 0;
    for (const r of rows) {
      try {
        const hours = (now.getTime() - r.pausedAt!.getTime()) / 3_600_000;
        if (limit !== null && hours >= limit) {
          if (await this.expire(r, limit)) cancelled += 1;
        } else if (r.pauseNotifiedAt === null) {
          // Compare-and-set: two instances never send the same notice.
          const { count } = await this.prisma.run.updateMany({ where: { id: r.id, status: 'paused', pauseNotifiedAt: null }, data: { pauseNotifiedAt: now } });
          if (count === 1) {
            await this.notifier?.stillPaused(r.userId, r);
            notified += 1;
          }
        }
      } catch (e) {
        this.log.warn(`run ${r.id}: the paused-run sweep failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return { notified, cancelled };
  }

  /** Cancels a run paused past the limit: its browser session ends, the run is `cancelled` with the reason, and its owner is told. */
  private async expire(r: { id: string; userId: string; goal: string; taskId: string | null; trigger: string; conversationId: string | null; sessionId: string | null }, limitHours: number): Promise<boolean> {
    if (this.fabric && r.sessionId) await this.fabric.request('DELETE', `/v1/sessions/${r.sessionId}`).catch(() => undefined);
    const error = `${PAUSED_TOO_LONG}: more than ${limitHours} hour${limitHours === 1 ? '' : 's'} without being resumed`;
    try {
      const done = await this.tasks.transition(r.userId, r.id, 'cancelled', { error, stopReason: 'cancelled' });
      this.log.log(`run ${r.id}: cancelled, paused for more than ${limitHours} h`);
      await this.notifier?.finished(r.userId, r, 'cancelled', done.result ?? error);
      return true;
    } catch (e) {
      // Resumed or stopped in the meantime.
      if (e instanceof ConflictException) return false;
      throw e;
    }
  }

  /**
   * `POST /runs/:id/pause`. `queued`, `running`: sets `pause_requested` and tells the worker holding the run (`run.pause`).
   * `waiting_human`: sets it; the run pauses when the question is answered. Already paused: unchanged. Finished: 409
   * `RUN_FINISHED`. An external agent's run is driven from outside: 409 `RUN_NOT_PAUSABLE`.
   */
  async pause(userId: string, id: string) {
    const run = await this.tasks.getRun(userId, id);
    if (isTerminal(run.status as RunStatus)) throw new ConflictException({ code: 'RUN_FINISHED', message: 'The run has finished: it cannot be paused' });
    if (run.trigger === 'external') throw new ConflictException({ code: 'RUN_NOT_PAUSABLE', message: 'An external agent drives this run: the console cannot pause it' });
    if (run.status === 'paused' || run.pauseRequested) return run;
    const { count } = await this.prisma.forUser({ userId }).run.updateMany({ where: { id, status: { in: ['queued', 'running', 'waiting_human'] }, pauseRequested: false }, data: { pauseRequested: true } });
    // After the write, so the worker that hears it finds the flag set; the poll covers a lost event.
    if (count > 0) await this.tasks.events?.publish({ type: 'run.pause', runId: id, ownerUserId: userId });
    return this.tasks.getRun(userId, id);
  }

  /** `POST /runs/:id/resume`: only from `paused` (409 `RUN_NOT_PAUSED` otherwise). Clears the flag, queues the run and starts its job. */
  async resume(userId: string, id: string, orgId: string | null) {
    const run = await this.tasks.getRun(userId, id);
    if (run.status !== 'paused') throw new ConflictException({ code: 'RUN_NOT_PAUSED', message: 'The run is not paused' });
    // The flag first: a worker that wakes on the status change must not find the pause still requested.
    await this.prisma.forUser({ userId }).run.updateMany({ where: { id, status: 'paused' }, data: { pauseRequested: false } });
    try {
      await this.tasks.transition(userId, id, 'queued');
    } catch (e) {
      // Stopped or failed in the meantime: nothing to resume.
      if (e instanceof ConflictException) throw new ConflictException({ code: 'RUN_NOT_PAUSED', message: 'The run is not paused' });
      throw e;
    }
    // The job that paused the run may still be winding down: a deduplicated enqueue would be swallowed, and the lease keeps two jobs from acting.
    await enqueueGoalRun(this.jobs, { runId: id, userId, orgId }, 'resumed', { skipDedup: true });
    this.log.log(`run ${id}: resumed`);
    return this.tasks.getRun(userId, id);
  }
}
