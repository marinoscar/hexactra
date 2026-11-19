// Copies the fabric's `secrets.*` audit events into `secrets_activity` (E37.4, #593).
//
// The fabric keeps its event log only in memory (the newest 2,000), so the Activity list would vanish with a restart
// or a busy hour. A queue job reads the replay (`GET /v1/events?after=0&types=secrets.*`, a bounded read, see
// `FabricClient.secretsEvents`) and stores sanitized rows; the rows are de-duplicated by the operation id, so reading
// the same events again every minute is harmless and a restart or a gap loses nothing that was ingested before it.
// As every long-running activity is a queue job, the per-minute `@Cron` only decides whether anything can have
// happened and enqueues. Server-only: it implements neither `nodeResultSchema` nor `persistNodeResult`.
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobHandlerRegistry, JobsService, enqueueHousekeepingJob, type Job, type JobHandler } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../prisma/prisma.service';
import { SecretsActivityService } from './secrets-activity.service';
import { SecretsPolicyService } from './secrets-policy.service';

/** Permanent job type. */
export const SECRETS_ACTIVITY_INGEST_JOB = 'secrets.activity.ingest';

/** `secrets.activity.ingest`: store the fabric's secrets audit events, then drop rows past their retention. */
@Injectable()
export class SecretsActivityIngestHandler implements JobHandler, OnModuleInit {
  readonly type = SECRETS_ACTIVITY_INGEST_JOB;
  readonly label = 'Record what the agent did with saved secrets';
  readonly profile = { maxRuntimeMs: 2 * 60_000, maxAttempts: 2 };
  private readonly log = new Logger(SecretsActivityIngestHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly activity: SecretsActivityService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const { read, stored } = await this.activity.ingestFromFabric();
    const purged = await this.activity.purge();
    if (stored > 0 || purged > 0) this.log.log(`job ${job.id}: secrets.activity.ingest read=${read} stored=${stored} purged=${purged}`);
  }
}

/** Every minute: if a secrets event can exist (the deployment switch is on or an owner is connected), enqueue the job. No work here. */
@Injectable()
export class SecretsActivityIngestTask {
  private readonly logger = new Logger(SecretsActivityIngestTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
    private readonly policy: SecretsPolicyService,
  ) {}

  /** Whether a `secrets.*` event can have been written since the last tick. */
  async due(): Promise<boolean> {
    if ((await this.policy.system()).agentUse.enabled) return true;
    return (await this.prisma.secretsConnection.count({ where: { status: 'connected' } })) > 0;
  }

  @Cron(CronExpression.EVERY_MINUTE)
  async handleCron(): Promise<void> {
    if (!(await this.due())) return;
    await enqueueHousekeepingJob({ jobs: this.jobs, prisma: this.prisma, logger: this.logger, type: SECRETS_ACTIVITY_INGEST_JOB, what: 'secrets activity ingest' });
  }
}
