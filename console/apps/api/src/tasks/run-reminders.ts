import { ConflictException, Injectable, Logger, NotFoundException, Optional, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobHandlerRegistry, JobsService, enqueueHousekeepingJob, type JobHandler } from '@marinoscar/platform-api/jobs';

import { FabricClient, FabricError } from '../fabric/fabric.client';
import { PrismaService } from '../prisma/prisma.service';
import { RunNotifier } from './run-notifier';
import { SNOOZE_MS, canSnooze, nextReminderAt, reminderDue, type ReminderState } from './reminder-schedule';

export * from './reminder-schedule';

/** When the fabric cannot be reached, look again after this long. */
const RETRY_MS = 60_000;

/**
 * Reminders while a run waits for its person (#298): if a request (a code, a
 * CAPTCHA, a sign-in, a confirmation) is not answered, the person is reminded
 * on every device before it expires, and can push a reminder back 15 min from
 * the notification ("Remind me in 15 min").
 *
 * The schedule is computed from the request's own window (`waitingSince` to
 * the fabric handoff's `expires_at`): an early nudge, a midpoint for long
 * windows, and a final "expires soon" one. State lives on the run
 * (`remindAt` is when the job next looks at it); a 30 s cron only enqueues
 * `browser.runs.remind` when one is due, and the job re-reads the handoff on
 * the fabric, so an answered or expired request is never reminded about.
 */

interface FabricHandoffStatus {
  status: string;
  expires_at?: string;
  kind?: string;
  prompt?: string;
  input?: string;
}

/** Sends due reminders and records snoozes. */
@Injectable()
export class RunReminders {
  private readonly log = new Logger(RunReminders.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly notifier: RunNotifier,
    @Optional() private readonly fabric?: FabricClient,
  ) {}

  /** Look at every run whose `remindAt` passed; returns how many reminders went out. */
  async sendDue(now = new Date()): Promise<number> {
    const due = await this.prisma.run.findMany({
      where: { status: 'waiting_human', remindAt: { lte: now }, handoffId: { not: null } },
      select: { id: true },
      orderBy: { remindAt: 'asc' },
      take: 200,
    });
    let sent = 0;
    for (const { id } of due) {
      try {
        if (await this.one(id, now)) sent++;
      } catch (e) {
        this.log.warn(`run ${id}: reminder failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    return sent;
  }

  private async one(id: string, now: Date): Promise<boolean> {
    const run = await this.prisma.run.findFirst({
      where: { id, status: 'waiting_human' },
      select: {
        id: true, userId: true, goal: true, taskId: true, trigger: true, handoffId: true, remindAt: true,
        waitingSince: true, handoffExpiresAt: true, remindedAt: true, reminderCount: true, snoozedUntil: true,
      },
    });
    if (!run?.handoffId || !run.remindAt) return false;

    // The fabric is the truth about the request: answered, cancelled or expired → stop.
    let handoff: FabricHandoffStatus | null = null;
    let gone = !this.fabric;
    try {
      handoff = this.fabric ? await this.fabric.request<FabricHandoffStatus>('GET', `/v1/handoffs/${run.handoffId}`) : null;
    } catch (e) {
      gone = e instanceof FabricError && e.status === 404;
    }
    if (!handoff || handoff.status !== 'pending') {
      // Resolved or gone: nothing more to remind about. Unreachable: look again shortly.
      await this.claim(run.id, run.remindAt, { remindAt: handoff || gone ? null : new Date(now.getTime() + RETRY_MS) });
      return false;
    }

    const expiresAt = handoff.expires_at ? new Date(handoff.expires_at) : run.handoffExpiresAt;
    const state: ReminderState = {
      waitingSince: run.waitingSince ?? run.remindAt,
      expiresAt,
      remindedAt: run.remindedAt,
      reminderCount: run.reminderCount,
      snoozedUntil: run.snoozedUntil,
    };
    const due = reminderDue(state, now);
    const after: ReminderState = due ? { ...state, remindedAt: now, reminderCount: state.reminderCount + 1, snoozedUntil: null } : state;
    // Compare-and-set on remindAt: two API instances never send the same reminder.
    const won = await this.claim(run.id, run.remindAt, {
      handoffExpiresAt: expiresAt,
      remindAt: nextReminderAt(after, now),
      ...(due ? { remindedAt: now, reminderCount: after.reminderCount, snoozedUntil: null } : {}),
    });
    if (!won || !due) return false;
    await this.notifier.reminder(
      run.userId,
      { id: run.id, goal: run.goal, taskId: run.taskId, trigger: run.trigger, handoffId: run.handoffId },
      { prompt: handoff.prompt ?? '', kind: handoff.kind ?? 'other', input: handoff.input ?? 'none' },
      { expiresAt, reminderCount: after.reminderCount, now },
    );
    return true;
  }

  private async claim(id: string, seen: Date, data: Record<string, unknown>): Promise<boolean> {
    const { count } = await this.prisma.run.updateMany({ where: { id, status: 'waiting_human', remindAt: seen }, data });
    return count === 1;
  }

  /**
   * "Remind me in 15 min" for a run of `userId` still waiting for them.
   * Refused when too little time is left (the final reminder is close) or
   * the reminders ran out.
   */
  async snooze(userId: string, runId: string, now = new Date()): Promise<Date> {
    const db = this.prisma.forUser({ userId });
    const run = await db.run.findFirst({ where: { id: runId }, select: { status: true, handoffExpiresAt: true, reminderCount: true } });
    if (!run) throw new NotFoundException({ code: 'RUN_NOT_FOUND', message: 'Run not found' });
    if (run.status !== 'waiting_human') throw new ConflictException({ code: 'NOT_WAITING', message: 'This run is not waiting for you' });
    if (!canSnooze(run.handoffExpiresAt, now, run.reminderCount)) {
      throw new ConflictException({ code: 'TOO_LATE_TO_SNOOZE', message: 'This request expires soon: answer it now' });
    }
    const until = new Date(now.getTime() + SNOOZE_MS);
    const { count } = await db.run.updateMany({ where: { id: runId, status: 'waiting_human' }, data: { snoozedUntil: until, remindAt: until } });
    if (count !== 1) throw new ConflictException({ code: 'NOT_WAITING', message: 'This run is not waiting for you' });
    return until;
  }
}

export const RUN_REMIND_JOB = 'browser.runs.remind';

/** `browser.runs.remind`: send the reminders that are due. Housekeeping (system job). */
@Injectable()
export class RunRemindHandler implements JobHandler, OnModuleInit {
  readonly type = RUN_REMIND_JOB;
  readonly label = 'Remind people about requests waiting for them';
  readonly profile = { maxRuntimeMs: 2 * 60_000, maxAttempts: 1 };
  private readonly log = new Logger(RunRemindHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly reminders: RunReminders,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(): Promise<void> {
    const sent = await this.reminders.sendDue();
    if (sent) this.log.log(`sent ${sent} reminder(s)`);
  }
}

/** Every 30 s: if a reminder is due, enqueue the job (no work here). */
@Injectable()
export class RunRemindTask {
  private readonly logger = new Logger(RunRemindTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async handleCron(): Promise<void> {
    const due = await this.prisma.run.count({ where: { status: 'waiting_human', remindAt: { lte: new Date() } } });
    if (due === 0) return;
    await enqueueHousekeepingJob({ jobs: this.jobs, prisma: this.prisma, logger: this.logger, type: RUN_REMIND_JOB, what: 'run reminders' });
  }
}
