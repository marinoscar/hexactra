import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobHandlerRegistry, JobsService, enqueueHousekeepingJob, type Job, type JobHandler } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../prisma/prisma.service';
import { ProfileSigninService } from './profile-signin.service';

/** The job type. Permanent once jobs of this type exist: never rename it. */
export const PROFILE_SIGNIN_EXPIRE_JOB = 'fleet.profile-signin.expire';

/**
 * `fleet.profile-signin.expire`: ends every guided sign-in (E48.4) still open 15 minutes after it started, as `abandoned`, and
 * gives its host's desktop back (the takeover lease and the desktop session), without closing the browser. Housekeeping (a
 * system job); server-only.
 */
@Injectable()
export class ProfileSigninExpireHandler implements JobHandler, OnModuleInit {
  readonly type = PROFILE_SIGNIN_EXPIRE_JOB;
  readonly label = 'End unfinished profile sign-ins';
  readonly profile = { maxRuntimeMs: 120_000, maxAttempts: 2 };
  private readonly logger = new Logger(ProfileSigninExpireHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly signins: ProfileSigninService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const n = await this.signins.expireDue();
    if (n > 0) this.logger.log(`job ${job.id}: ended ${n} unfinished profile sign-in(s)`);
  }
}

/** Every minute: enqueue the expire job when a sign-in is past its time limit (the cron does no work itself). */
@Injectable()
export class ProfileSigninExpireTask {
  private readonly logger = new Logger(ProfileSigninExpireTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
    private readonly signins: ProfileSigninService,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleCron(): Promise<void> {
    try {
      if ((await this.signins.countDue()) === 0) return;
    } catch {
      return;
    }
    await enqueueHousekeepingJob({ jobs: this.jobs, prisma: this.prisma, logger: this.logger, type: PROFILE_SIGNIN_EXPIRE_JOB, what: 'profile sign-in expiry' });
  }
}
