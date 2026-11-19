// Keeps the fabric's short-lived Vault access token fresh while a run is live (E37.2, #591). A queue job, as every
// long-running activity is: the per-minute `@Cron` only decides whether a connection is due and enqueues; the
// handler refreshes (through `VaultTokenService`, one refresh at a time) and hands the fabric the new token
// (`SecretsProviderRegistrar`). Server-only: the job carries nothing and no credential goes to a worker node (it
// implements neither `nodeResultSchema` nor `persistNodeResult`).
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { JobHandlerRegistry, JobsService, enqueueHousekeepingJob, type JobHandler } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../prisma/prisma.service';
import { REGISTRATION_MIN_REMAINING_MS, SecretsProviderRegistrar } from './secrets-provider.registrar';

export const VAULT_KEEP_FRESH_JOB = 'secrets.vault.keep_fresh';

/** Runs that can use a stored secret are live in these states. */
const LIVE_RUN_STATUSES = ['queued', 'running', 'waiting_human', 'paused'] as const;
/** A token is due for renewal when it has less than this left (the registrar replaces it at 90 s; the tick is a minute). */
const DUE_WITHIN_MS = REGISTRATION_MIN_REMAINING_MS + 60_000;

@Injectable()
export class VaultKeepFresh {
  constructor(private readonly prisma: PrismaService) {}

  /** Owners with a live run and a Vault connection whose access token is missing or about to expire. */
  async dueUserIds(now = new Date(), limit = 100): Promise<string[]> {
    const live = await this.prisma.run.findMany({ where: { status: { in: [...LIVE_RUN_STATUSES] } }, select: { userId: true }, distinct: ['userId'], take: 500 });
    if (live.length === 0) return [];
    const rows = await this.prisma.secretsConnection.findMany({
      where: {
        provider: 'vault',
        status: 'connected',
        userId: { in: live.map((r) => r.userId) },
        OR: [{ accessExpiresAt: null }, { accessExpiresAt: { lt: new Date(now.getTime() + DUE_WITHIN_MS) } }],
      },
      select: { userId: true },
      take: limit,
    });
    return rows.map((r) => r.userId);
  }
}

/** `secrets.vault.keep_fresh`: renew the access token the fabric holds, for every owner with a live run. */
@Injectable()
export class VaultKeepFreshHandler implements JobHandler, OnModuleInit {
  readonly type = VAULT_KEEP_FRESH_JOB;
  readonly label = 'Keep the Vault access token fresh for live runs';
  readonly profile = { maxRuntimeMs: 2 * 60_000, maxAttempts: 1 };
  private readonly log = new Logger(VaultKeepFreshHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly due: VaultKeepFresh,
    private readonly registrar: SecretsProviderRegistrar,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(): Promise<void> {
    for (const userId of await this.due.dueUserIds()) {
      try {
        await this.registrar.ensureRegistered(userId);
      } catch (e) {
        this.log.warn(`vault token renewal failed for an owner (${e instanceof Error ? e.name : 'error'})`);
      }
    }
  }
}

/** Every minute: if a live run's Vault token is due, enqueue the job (no work here). */
@Injectable()
export class VaultKeepFreshTask {
  private readonly logger = new Logger(VaultKeepFreshTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
    private readonly due: VaultKeepFresh,
  ) {}

  @Cron(CronExpression.EVERY_MINUTE)
  async handleCron(): Promise<void> {
    if ((await this.due.dueUserIds(new Date(), 1)).length === 0) return;
    await enqueueHousekeepingJob({ jobs: this.jobs, prisma: this.prisma, logger: this.logger, type: VAULT_KEEP_FRESH_JOB, what: 'vault token renewal' });
  }
}
