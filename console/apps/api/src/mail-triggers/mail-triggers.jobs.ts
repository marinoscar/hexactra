// `connections.mail-triggers.poll` (E39.8, #605): look for new mail for every trigger that is due. A queue job, as every
// long-running activity is: the per-minute `@Cron` only decides whether a trigger is due and enqueues; the handler does the work
// (one search per due trigger, spread by each trigger's own offset). Server-only: it reads mailboxes with a connection's token and
// starts runs, so it implements neither `nodeResultSchema` nor `persistNodeResult`.
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobHandlerRegistry, JobsService, enqueueHousekeepingJob, type JobHandler } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../prisma/prisma.service';
import { MailTriggerPoller } from './mail-trigger.poller';

export const MAIL_TRIGGERS_POLL_JOB = 'connections.mail-triggers.poll';

@Injectable()
export class MailTriggersPollHandler implements JobHandler, OnModuleInit {
  readonly type = MAIL_TRIGGERS_POLL_JOB;
  readonly label = 'Look for mail that starts tasks';
  readonly profile = { maxRuntimeMs: 5 * 60_000, maxAttempts: 1 };
  private readonly log = new Logger(MailTriggersPollHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly poller: MailTriggerPoller,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(): Promise<void> {
    const r = await this.poller.pollDue();
    if (r.polled) this.log.log(`mail triggers: ${r.polled} polled, ${r.started} runs started, ${r.skipped} skipped, ${r.failed} failed`);
  }
}

/** Every minute: if a trigger is due, enqueue the poll (no work here). */
@Injectable()
export class MailTriggersPollTask {
  private readonly logger = new Logger(MailTriggersPollTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
    private readonly poller: MailTriggerPoller,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleCron(): Promise<void> {
    if ((await this.poller.due()) === 0) return;
    await enqueueHousekeepingJob({ jobs: this.jobs, prisma: this.prisma, logger: this.logger, type: MAIL_TRIGGERS_POLL_JOB, what: 'mail triggers poll' });
  }
}
