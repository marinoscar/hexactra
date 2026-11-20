import { Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { JobHandlerRegistry, JobsService, enqueueHousekeepingJob, type Job, type JobHandler } from '@marinoscar/platform-api/jobs';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { readQuestionsSettings, type QuestionsSettings } from './questions.settings';

/** The job type. Permanent once jobs of this type exist: never rename it. */
export const REQUEST_HISTORY_RETENTION_JOB = 'questions.history.retention';
/** The audit action of one pass, with its totals. */
export const REQUEST_HISTORY_AUDIT_ACTION = 'questions.history.purged';
/** Questions deleted per batch, and the most per pass (the rest goes the next night). */
const BATCH = 500;
const PASS_CAP = 50_000;

/** The `questions` system settings, salvaged; the defaults when the namespace cannot be read. */
export async function questionsSettings(systemSettings: SystemSettingsService | undefined, log?: Pick<Logger, 'warn'>): Promise<QuestionsSettings> {
  try {
    return readQuestionsSettings(await systemSettings?.getNamespace('questions'));
  } catch (e) {
    log?.warn(`questions settings could not be read (${e instanceof Error ? e.name : 'error'}); the defaults apply`);
    return readQuestionsSettings(undefined);
  }
}

/** The questions a pass may delete: over (answered, declined or expired) and ended before `cutoff`. Never a pending one. */
export function settledBefore(cutoff: Date): Prisma.QuestionWhereInput {
  return {
    status: { in: ['answered', 'cancelled', 'expired'] },
    OR: [{ answeredAt: { lt: cutoff } }, { answeredAt: null, expiresAt: { lt: cutoff } }],
  };
}

/**
 * `questions.history.retention` (E40.4, #688): the nightly pass that deletes
 * request history older than the administrator's `questions.historyKeepDays`
 * (default 7): answered, declined and expired questions and their `request`
 * messages in a chat. A question still waiting is never deleted. A run keeps
 * its steps: the answer step's summary ("The owner provided it") stays until
 * the run's own retention removes it; its link to the question is cleared.
 * Server-only (it writes as it goes); safe to repeat.
 */
@Injectable()
export class RequestHistoryRetentionHandler implements JobHandler, OnModuleInit {
  readonly type = REQUEST_HISTORY_RETENTION_JOB;
  readonly label = 'Delete request history past its retention';
  readonly profile = { maxRuntimeMs: 10 * 60_000, maxAttempts: 2 };
  private readonly log = new Logger(RequestHistoryRetentionHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    @Optional() private readonly systemSettings?: SystemSettingsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    await this.purge(job.id);
  }

  /** One pass: what it deleted. */
  async purge(jobId: string): Promise<{ deleted: number; messages: number; keepDays: number }> {
    const started = Date.now();
    const { historyKeepDays } = await questionsSettings(this.systemSettings, this.log);
    const cutoff = new Date(started - historyKeepDays * 24 * 3600_000);
    let deleted = 0;
    let messages = 0;
    while (deleted < PASS_CAP) {
      const ids = (await this.prisma.question.findMany({ where: settledBefore(cutoff), select: { id: true }, orderBy: { createdAt: 'asc' }, take: BATCH })).map((q) => q.id);
      if (ids.length === 0) break;
      const [m, q] = await this.prisma.$transaction([
        this.prisma.chatMessage.deleteMany({ where: { kind: 'request', OR: ids.map((id) => ({ meta: { path: ['questionId'], equals: id } })) } }),
        this.prisma.question.deleteMany({ where: { id: { in: ids }, ...settledBefore(cutoff) } }),
      ]);
      messages += m.count;
      deleted += q.count;
      if (ids.length < BATCH) break;
    }
    const totals = { deleted, messages, keepDays: historyKeepDays };
    this.log.log(`job ${jobId}: questions.history.retention keepDays=${historyKeepDays} deleted=${deleted} messages=${messages} ms=${Date.now() - started}`);
    try {
      await this.prisma.auditEvent.create({ data: { action: REQUEST_HISTORY_AUDIT_ACTION, targetType: 'job', targetId: jobId, meta: { ...totals, ms: Date.now() - started } } });
    } catch (e) {
      this.log.warn(`job ${jobId}: the totals could not be recorded: ${e instanceof Error ? e.name : 'error'}`);
    }
    return totals;
  }
}

/**
 * The nightly trigger, 03:50 server time. A `@Cron` only decides that work is
 * due and ENQUEUES it (queue rule 1; the `cron-enqueue-only` suite checks it).
 */
@Injectable()
export class RequestHistoryRetentionTask {
  private readonly logger = new Logger(RequestHistoryRetentionTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron('50 3 * * *')
  async handleCron(): Promise<void> {
    await enqueueHousekeepingJob({ jobs: this.jobs, prisma: this.prisma, logger: this.logger, type: REQUEST_HISTORY_RETENTION_JOB, what: 'request history retention' });
  }
}
