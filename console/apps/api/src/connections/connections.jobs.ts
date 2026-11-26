// `connections.health` (E39.2, #599): once a day, refresh the connections that nothing used lately, so a token does not die of
// inactivity, and flag the ones that fail (`needs_reconnect`, with the owner told once). Also removes flows that expired.
// A queue job, as every long-running activity is: the daily `@Cron` only decides whether work is due and enqueues; the handler
// refreshes through `ConnectionTokensService` (one refresh at a time). Server-only: no credential goes to a worker node (it
// implements neither `nodeResultSchema` nor `persistNodeResult`).
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import type { Connection } from '@prisma/client';
import { JobHandlerRegistry, JobsService, enqueueHousekeepingJob, type JobHandler } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../prisma/prisma.service';
import { ConnectionError } from './connections.errors';
import { ConnectionFlowService } from './connection-flow.service';
import { ConnectionTokensService } from './connection-tokens.service';
import { ConnectionDiagnosticsService } from './connection-diagnostics.service';

export const CONNECTIONS_HEALTH_JOB = 'connections.health';

/** A connection not used or refreshed for this long is idle: the health job refreshes it. */
export const IDLE_AFTER_MS = 20 * 60 * 60_000;
/** At most this many connections per run (the rest wait for tomorrow: a day is long enough). */
const BATCH = 200;

@Injectable()
export class ConnectionsHealth {
  constructor(private readonly prisma: PrismaService) {}

  row(id: string): Promise<Connection | null> {
    return this.prisma.connection.findUnique({ where: { id } });
  }

  /** Live connections (active or paused) that were neither used nor refreshed in the last {@link IDLE_AFTER_MS}. */
  async idle(now = new Date(), limit = BATCH): Promise<{ id: string; userId: string }[]> {
    const before = new Date(now.getTime() - IDLE_AFTER_MS);
    return this.prisma.connection.findMany({
      where: {
        status: { in: ['active', 'paused'] },
        provider: { in: ['google', 'microsoft'] },
        AND: [{ OR: [{ lastRefreshAt: null }, { lastRefreshAt: { lt: before } }] }, { OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: before } }] }],
      },
      select: { id: true, userId: true },
      orderBy: { lastRefreshAt: { sort: 'asc', nulls: 'first' } },
      take: limit,
    });
  }
}

/** `connections.health`: refresh idle connections and flag the ones that fail. */
@Injectable()
export class ConnectionsHealthHandler implements JobHandler, OnModuleInit {
  readonly type = CONNECTIONS_HEALTH_JOB;
  readonly label = 'Keep connected accounts signed in';
  readonly profile = { maxRuntimeMs: 10 * 60_000, maxAttempts: 1 };
  private readonly log = new Logger(ConnectionsHealthHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly health: ConnectionsHealth,
    private readonly tokens: ConnectionTokensService,
    private readonly flows: ConnectionFlowService,
    private readonly diagnostics: ConnectionDiagnosticsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  /** E50.10: a report (trigger `health_job`) of why the refresh failed, so the Connections page shows it. Asks the provider nothing more. */
  private async report(id: string, failure: unknown): Promise<void> {
    try {
      const row = await this.health.row(id);
      if (row) await this.diagnostics.diagnoseRow(row, 'health_job', { signInFailure: failure });
    } catch (e) {
      this.log.warn(`connection health report could not be stored (${e instanceof Error ? e.name : 'error'})`);
    }
  }

  async process(): Promise<void> {
    await this.flows.purgeExpired().catch((e: unknown) => this.log.warn(`expired connection flows could not be purged (${e instanceof Error ? e.name : 'error'})`));
    for (const c of await this.health.idle()) {
      try {
        await this.tokens.getAccessToken(c.id, c.userId, { forceRefresh: true, allowPaused: true });
      } catch (e) {
        // A failed grant is already flagged and notified by the token service; an unreachable provider changes nothing and is tried again tomorrow.
        if (!(e instanceof ConnectionError)) this.log.warn(`connection health check failed (${e instanceof Error ? e.name : 'error'})`);
        await this.report(c.id, e);
      }
    }
  }
}

/** Daily: if a connection is idle, enqueue the job (no work here). */
@Injectable()
export class ConnectionsHealthTask {
  private readonly logger = new Logger(ConnectionsHealthTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
    private readonly health: ConnectionsHealth,
  ) {}

  @Cron('17 4 * * *')
  async handleCron(): Promise<void> {
    if ((await this.health.idle(new Date(), 1)).length === 0) return;
    await enqueueHousekeepingJob({ jobs: this.jobs, prisma: this.prisma, logger: this.logger, type: CONNECTIONS_HEALTH_JOB, what: 'connections health' });
  }
}
