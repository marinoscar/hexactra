import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { Cron, CronExpression } from '@nestjs/schedule';
import { DoctorCheckRegistry, type DoctorCheck, type DoctorCheckOutcome } from '@marinoscar/platform-api/doctor';
import { enqueueHousekeepingJob, JobHandlerRegistry, JobsService, registerJobReason, type Job, type JobHandler } from '@marinoscar/platform-api/jobs';

import { PrismaService } from '../prisma/prisma.service';
import { KgraphEnabledService } from './kgraph-enabled.service';
import { KgraphUpkeepService } from './upkeep.service';

/** The daily upkeep job (E46.24). Permanent once jobs of this type exist: never rename it. */
export const KGRAPH_UPKEEP_JOB = 'kgraph.upkeep';
registerJobReason({ id: 'kgraph_upkeep', label: 'Knowledge Graph: library upkeep' });

@Injectable()
export class KgraphUpkeepHandler implements JobHandler, OnModuleInit {
  readonly type = KGRAPH_UPKEEP_JOB;
  readonly label = 'Knowledge Graph upkeep';
  readonly profile = { maxRuntimeMs: 15 * 60_000, maxAttempts: 2 };
  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly upkeep: KgraphUpkeepService,
  ) {}
  onModuleInit(): void {
    this.registry.register(this);
  }
  async process(_job: Job): Promise<void> {
    await this.upkeep.runAll();
  }
}

/** Daily: only decides whether the feature is on and enqueues the job (no work here). */
@Injectable()
export class KgraphUpkeepTask {
  private readonly logger = new Logger(KgraphUpkeepTask.name);
  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
    private readonly enabled: KgraphEnabledService,
  ) {}
  @Cron(CronExpression.EVERY_DAY_AT_3AM)
  async handleCron(): Promise<void> {
    if (!(await this.enabled.systemSettingsOf().catch(() => null))?.enabled) return;
    await enqueueHousekeepingJob({ jobs: this.jobs, prisma: this.prisma, logger: this.logger, type: KGRAPH_UPKEEP_JOB, what: 'kgraph upkeep' });
  }
}

/** `kgraph.upkeep` in the admin Doctor: the job ran in the last 2 days while the feature is on. */
@Injectable()
export class KgraphUpkeepDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'kgraph.upkeep';
  readonly category = 'kgraph';
  readonly label = 'Knowledge Graph upkeep';
  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly prisma: PrismaService,
    private readonly enabled: KgraphEnabledService,
  ) {}
  onModuleInit(): void {
    this.registry.register(this);
  }
  async run(): Promise<DoctorCheckOutcome> {
    if (!(await this.enabled.systemSettingsOf()).enabled) return { status: 'skip', detail: 'The Knowledge Graph is off on this deployment.' };
    const last = await this.prisma.job.findFirst({ where: { type: KGRAPH_UPKEEP_JOB, status: 'succeeded' }, orderBy: { createdAt: 'desc' }, select: { finishedAt: true, createdAt: true } });
    const at = last ? (last.finishedAt ?? last.createdAt) : null;
    const fresh = at !== null && Date.now() - at.getTime() < 2 * 86_400_000;
    return fresh ? { status: 'pass', detail: `Upkeep last ran ${at!.toISOString()}.` } : { status: 'warn', detail: 'Knowledge Graph upkeep has not run in the last 2 days: check the job queue.' };
  }
}
