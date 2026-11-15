import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AiError } from '@marinoscar/platform-api/ai';
import { JobHandlerRegistry, JobsService, enqueueHousekeepingJob, type Job, type JobHandler } from '@marinoscar/platform-api/jobs';

import { FabricClient } from '../fabric/fabric.client';
import { PrismaService } from '../prisma/prisma.service';
import { FabricSession } from './fabric-session';
import { GoalRunnerService } from './goal-runner.service';

/** Permanent job types (never rename once jobs exist). */
export const GOAL_RUN_JOB = 'browser.goal.run';
export const HANDOFF_CHECK_JOB = 'browser.handoffs.check';

export interface GoalRunPayload {
  runId: string;
  userId: string;
  orgId: string | null;
}

/** Queue one advance of a run (start, or resume after a handoff). */
export async function enqueueGoalRun(jobs: JobsService, payload: GoalRunPayload, reason: string): Promise<void> {
  await jobs.enqueue({
    type: GOAL_RUN_JOB,
    reason,
    subjectType: 'browser_run',
    subjectId: payload.runId,
    orgId: payload.orgId,
    payload: { ...payload },
  });
}

/**
 * `browser.goal.run`: drives one run until it finishes or waits for a
 * person. Server-only (no node result schema): it holds the user's AI key
 * path and the fabric service token. One attempt: a run is not idempotent
 * (it clicks things), so a failure is recorded on the run, not retried.
 */
@Injectable()
export class GoalRunHandler implements JobHandler, OnModuleInit {
  readonly type = GOAL_RUN_JOB;
  readonly label = 'Run a browser goal';
  readonly profile = { maxRuntimeMs: 30 * 60_000, maxAttempts: 1 };
  private readonly log = new Logger(GoalRunHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly runner: GoalRunnerService,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const p = job.payload as unknown as GoalRunPayload;
    try {
      const outcome = await this.runner.advance(p.runId, p.userId, p.orgId ?? job.orgId ?? null);
      this.log.log(`job ${job.id}: run ${p.runId} ${outcome}`);
    } catch (e) {
      // Record the failure on the run so the user sees why; never retried.
      const message = e instanceof AiError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
      await this.prisma.forUser({ userId: p.userId }).run.updateMany({
        where: { id: p.runId, status: { in: ['queued', 'running', 'waiting_human'] } },
        data: { status: 'failed', error: message.slice(0, 1_900), finishedAt: new Date() },
      });
      if (e instanceof AiError) throw e.toRateLimitError() ?? e;
      throw e;
    }
  }
}

/**
 * `browser.handoffs.check`: resumes runs whose handoff was answered,
 * cancelled or expired. Housekeeping (system job): reads the waiting runs and
 * enqueues their `browser.goal.run`.
 */
@Injectable()
export class HandoffCheckHandler implements JobHandler, OnModuleInit {
  readonly type = HANDOFF_CHECK_JOB;
  readonly label = 'Resume runs whose handoff was answered';
  readonly profile = { maxRuntimeMs: 2 * 60_000, maxAttempts: 1 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    private readonly fabric: FabricClient,
    private readonly jobs: JobsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(): Promise<void> {
    if (!(await this.fabric.config())) return;
    const waiting = await this.prisma.run.findMany({
      where: { status: 'waiting_human', handoffId: { not: null } },
      select: { id: true, userId: true, handoffId: true },
      take: 200,
    });
    const session = new FabricSession(this.fabric);
    for (const r of waiting) {
      const h = await session.getHandoff(r.handoffId!).catch(() => null);
      if (!h || h.status !== 'pending') {
        await enqueueGoalRun(this.jobs, { runId: r.id, userId: r.userId, orgId: null }, 'handoff resolved');
      }
    }
  }
}

/** Every 30 s: enqueue the handoff check (the cron does no work itself). */
@Injectable()
export class HandoffCheckTask {
  private readonly logger = new Logger(HandoffCheckTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(CronExpression.EVERY_30_SECONDS)
  async handleCron(): Promise<void> {
    const waiting = await this.prisma.run.count({ where: { status: 'waiting_human' } });
    if (waiting === 0) return;
    await enqueueHousekeepingJob({ jobs: this.jobs, prisma: this.prisma, logger: this.logger, type: HANDOFF_CHECK_JOB, what: 'handoff check' });
  }
}
