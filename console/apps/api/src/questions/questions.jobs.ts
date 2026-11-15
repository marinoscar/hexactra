import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobHandlerRegistry, JobsService, enqueueHousekeepingJob, type Job, type JobHandler } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../prisma/prisma.service';
import { QuestionsService } from './questions.service';

/** The job type. Permanent once jobs of this type exist: never rename it. */
export const QUESTIONS_EXPIRE_JOB = 'questions.expire';

/**
 * `questions.expire`: marks overdue pending questions expired, withdraws
 * their fabric handoffs (best effort) and emits `question.expired`.
 * Housekeeping (a system job). Server-only: it writes as it goes.
 */
@Injectable()
export class QuestionsExpireHandler implements JobHandler, OnModuleInit {
  readonly type = QUESTIONS_EXPIRE_JOB;
  readonly label = 'Expire unanswered questions';
  readonly profile = { maxRuntimeMs: 2 * 60_000, maxAttempts: 2 };
  private readonly logger = new Logger(QuestionsExpireHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly questions: QuestionsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const n = await this.questions.expireDue({}, { limit: 1_000, withdraw: true });
    if (n > 0) this.logger.log(`job ${job.id}: expired ${n} question(s)`);
  }
}

/** Every minute: enqueue the expiry when a pending question is overdue (the cron does no work itself). */
@Injectable()
export class QuestionsExpireTask {
  private readonly logger = new Logger(QuestionsExpireTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleCron(): Promise<void> {
    const due = await this.prisma.question.count({ where: { status: 'pending', expiresAt: { lte: new Date() } } });
    if (due === 0) return;
    await enqueueHousekeepingJob({ jobs: this.jobs, prisma: this.prisma, logger: this.logger, type: QUESTIONS_EXPIRE_JOB, what: 'question expiry' });
  }
}
