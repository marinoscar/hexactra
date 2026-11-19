// Upkeep of the built-in store (E37.5, #594): key rotation, expired credentials, ownerless rows.
//
// A queue job (`secrets.store.maintain`), as every long-running activity is: the hourly `@Cron` and the
// administrator's "rotate" route only DECIDE and enqueue; the handler works. Server-only: it implements neither
// `nodeResultSchema` nor `persistNodeResult`, so no key ever goes to a worker node.
//
// Key rotation (docs/secrets.md, "Rotating the store key"): put the new key in `SECRETS_STORE_KEY` and the old one
// in `SECRETS_STORE_KEY_PREVIOUS`, restart the API, run this job (it re-wraps every data key under the new key,
// `SecretsStoreKeys.rewrapStale`), and remove `SECRETS_STORE_KEY_PREVIOUS` once the Doctor shows nothing wrapped
// under it. The VALUES are never re-encrypted: only the small data keys are re-wrapped.
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobHandlerRegistry, JobsService, enqueueHousekeepingJob, type JobHandler } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../../prisma/prisma.service';
import { SecretsStoreCallbackTokens } from './store.callback-tokens';
import { SecretsStoreKeys } from './store.data-keys';

export const STORE_MAINTAIN_JOB = 'secrets.store.maintain';

@Injectable()
export class SecretsStoreMaintenance {
  private readonly log = new Logger(SecretsStoreMaintenance.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly keys: SecretsStoreKeys,
    private readonly tokens: SecretsStoreCallbackTokens,
  ) {}

  /** Is there anything for the job to do? */
  async due(): Promise<boolean> {
    if ((await this.keys.countStale()) > 0) return true;
    // An ownerless secret has no data key any more (its owner was removed by a path that skipped the user-data purge).
    if ((await this.prisma.secret.count({ where: { createdById: null } })) > 0) return true;
    return (await this.prisma.secretsStoreCallbackToken.count({ where: { expiresAt: { lt: new Date(Date.now() - 24 * 60 * 60_000) } } })) > 0;
  }

  async run(): Promise<{ rewrapped: number; unreadable: number; orphans: number; tokens: number }> {
    let rewrapped = 0;
    let unreadable = 0;
    // Bounded batches: a large backlog finishes over a few runs.
    for (let i = 0; i < 10; i += 1) {
      const r = await this.keys.rewrapStale(200);
      rewrapped += r.rewrapped;
      unreadable += r.unreadable;
      if (r.rewrapped + r.unreadable < 200) break;
    }
    // Rows are removed with their versions (cascade); nothing of theirs is readable without the owner's key anyway.
    const { count: orphans } = await this.prisma.secret.deleteMany({ where: { createdById: null } });
    const tokens = await this.tokens.sweep();
    this.log.log(`store maintenance: ${rewrapped} data key(s) re-wrapped, ${unreadable} unreadable, ${orphans} ownerless secret(s) removed, ${tokens} expired credential(s) removed`);
    return { rewrapped, unreadable, orphans, tokens };
  }
}

@Injectable()
export class SecretsStoreMaintainHandler implements JobHandler, OnModuleInit {
  readonly type = STORE_MAINTAIN_JOB;
  readonly label = "Upkeep of the built-in secrets store (re-wrap data keys, sweep)";
  readonly profile = { maxRuntimeMs: 10 * 60_000, maxAttempts: 2 };

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly maintenance: SecretsStoreMaintenance,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(): Promise<void> {
    await this.maintenance.run();
  }
}

/** Hourly: if there is upkeep to do, enqueue the job (no work here). */
@Injectable()
export class SecretsStoreMaintainTask {
  private readonly logger = new Logger(SecretsStoreMaintainTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
    private readonly maintenance: SecretsStoreMaintenance,
  ) {}

  @Cron(CronExpression.EVERY_HOUR)
  async handleCron(): Promise<void> {
    if (!(await this.maintenance.due())) return;
    await this.enqueue();
  }

  /** Also used by the administrator's route. */
  async enqueue(): Promise<void> {
    await enqueueHousekeepingJob({ jobs: this.jobs, prisma: this.prisma, logger: this.logger, type: STORE_MAINTAIN_JOB, what: 'built-in secrets store upkeep' });
  }
}
