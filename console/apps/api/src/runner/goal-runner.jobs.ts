import { Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { AiError } from '@marinoscar/platform-api/ai';
import { JobHandlerRegistry, JobsService, enqueueHousekeepingJob, type Job, type JobHandler } from '@marinoscar/platform-api/jobs';

import { FabricClient } from '../fabric/fabric.client';
import { PrismaService } from '../prisma/prisma.service';
import { QuestionsService } from '../questions/questions.service';
import { RunEndHooks } from '../tasks/run-end-hooks';
import { RunEvents } from '../tasks/run-events';
import { FabricSession } from './fabric-session';
import { GOAL_RUN_JOB, GOAL_RUN_MAX_RUNTIME_MS, HANDOFF_CHECK_JOB, enqueueGoalRun, enqueueGoalRunContinuation, type GoalRunPayload } from './goal-run.enqueue';
import { GoalRunnerService } from './goal-runner.service';

export { GOAL_RUN_JOB, GOAL_RUN_REASONS, HANDOFF_CHECK_JOB, enqueueGoalRun, type GoalRunPayload, type GoalRunReason } from './goal-run.enqueue';

/**
 * `browser.goal.run`: drives one run until it finishes or waits for a
 * person. Server-only (no node result schema): it holds the user's AI key
 * path and the fabric service token. A failure the job reports is recorded on
 * the run and never retried. A job whose worker DIES (a crash, a deploy, a lost
 * lease) is retried by the queue (E38.3): the run keeps its progress after every
 * action, the retried job reconciles from the step rows (`reconcile.ts`), a step
 * that may have happened is never repeated, and a job that finds another job
 * holding the run stops without writing (`lease.ts`).
 */
@Injectable()
export class GoalRunHandler implements JobHandler, OnModuleInit {
  readonly type = GOAL_RUN_JOB;
  readonly label = 'Run a browser goal';
  readonly profile = { maxRuntimeMs: GOAL_RUN_MAX_RUNTIME_MS, maxAttempts: 3 };
  private readonly log = new Logger(GoalRunHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly runner: GoalRunnerService,
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    @Optional() private readonly events?: RunEvents,
    @Optional() private readonly endHooks?: RunEndHooks,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const p = job.payload as unknown as GoalRunPayload;
    try {
      const outcome = await this.runner.advance(p.runId, p.userId, p.orgId ?? job.orgId ?? null);
      this.log.log(`job ${job.id}: run ${p.runId} ${outcome}`);
      // Near this job's runtime limit: carry on in a new job (the run stays `running`).
      if (outcome === 'continue') await enqueueGoalRunContinuation(this.jobs, { runId: p.runId, userId: p.userId, orgId: p.orgId ?? job.orgId ?? null });
    } catch (e) {
      // Record the failure on the run so the user sees why; never retried.
      const message = e instanceof AiError ? `${e.code}: ${e.message}` : e instanceof Error ? e.message : String(e);
      await this.prisma.forUser({ userId: p.userId }).run.updateMany({
        where: { id: p.runId, status: { in: ['queued', 'running', 'waiting_human'] } },
        data: { status: 'failed', error: message.slice(0, 1_900), stopReason: e instanceof AiError && /^No model selected/.test(e.message) ? 'no_model' : 'error', finishedAt: new Date() },
      });
      await this.events?.publish({ type: 'run.status', runId: p.runId, ownerUserId: p.userId, status: 'failed' });
      await this.endHooks?.fire(p.userId, p.runId);
      if (e instanceof AiError) throw e.toRateLimitError() ?? e;
      throw e;
    }
  }
}

/**
 * `browser.handoffs.check`: resumes runs whose handoff was answered,
 * cancelled or expired, and settles their mirrored questions. Housekeeping (system job): reads the waiting runs and
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
    private readonly questions: QuestionsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(): Promise<void> {
    await this.resumeFreeQuestions();
    if (!(await this.fabric.config())) return;
    const waiting = await this.prisma.run.findMany({
      // External runs are resumed by their own agent, never by the AI runner.
      where: { status: 'waiting_human', handoffId: { not: null }, trigger: { not: 'external' } },
      select: { id: true, userId: true, handoffId: true },
      take: 200,
    });
    const session = new FabricSession(this.fabric);
    for (const r of waiting) {
      const h = await session.getHandoff(r.handoffId!).catch(() => null);
      // Settle the mirrored question too (expired or cancelled on the fabric, or answered by another channel there).
      if (h && h.status !== 'pending') await this.questions.reconcileHandoff(h);
      if (!h || h.status !== 'pending') {
        await enqueueGoalRun(this.jobs, { runId: r.id, userId: r.userId, orgId: null }, 'handoff_resolved');
      }
    }
  }

  /**
   * A run that waits on a question that needs no browser (E39.7) is resumed by the answer. This is the safety net for an answer whose resume was
   * lost and for a question that expired unanswered (the run is told the owner did not help). Only the run's newest such question counts.
   */
  private async resumeFreeQuestions(): Promise<void> {
    const waiting = await this.prisma.run.findMany({ where: { status: 'waiting_human', handoffId: null, trigger: { not: 'external' } }, select: { id: true, userId: true }, take: 200 });
    for (const r of waiting) {
      const q = await this.prisma.question.findFirst({ where: { runId: r.id, blocking: true, handoffId: null, input: { notIn: ['form', 'memory', 'save_login'] } }, orderBy: { createdAt: 'desc' }, select: { status: true, expiresAt: true } });
      if (!q) continue;
      const lapsed = q.status === 'pending' && q.expiresAt.getTime() <= Date.now();
      if (q.status !== 'pending' || lapsed) {
        if (lapsed) await this.questions.expireDue({ ownerUserId: r.userId });
        await enqueueGoalRun(this.jobs, { runId: r.id, userId: r.userId, orgId: null }, 'handoff_resolved');
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
    const waiting = await this.prisma.run.count({ where: { status: 'waiting_human', trigger: { not: 'external' } } });
    if (waiting === 0) return;
    await enqueueHousekeepingJob({ jobs: this.jobs, prisma: this.prisma, logger: this.logger, type: HANDOFF_CHECK_JOB, what: 'handoff check' });
  }
}
