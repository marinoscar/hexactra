import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DoctorCheckRegistry, type DoctorCheck, type DoctorCheckOutcome } from '@marinoscar/platform-api/doctor';

import { PrismaService } from '../prisma/prisma.service';
import { RUNS_RETENTION_AUDIT_ACTION, RUNS_RETENTION_JOB } from './run-retention.service';

/** The nightly job is late when it has not succeeded for this long. */
export const RETENTION_STALE_HOURS = 48;

/**
 * `runs.retention` in the admin Doctor (`GET /api/admin/doctor`): when the
 * nightly retention job last succeeded and how many runs it deleted. Warns
 * when it has not succeeded in 48 hours. Read-only, like every check: two
 * reads, never a write and never an enqueue.
 */
@Injectable()
export class RunRetentionDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'runs.retention';
  readonly category = 'runs';
  readonly label = 'Run retention';

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    const last = await this.prisma.job.findFirst({ where: { type: RUNS_RETENTION_JOB, status: 'succeeded' }, orderBy: { finishedAt: 'desc' }, select: { id: true, finishedAt: true } });
    if (!last?.finishedAt) {
      const any = await this.prisma.job.findFirst({ where: { type: RUNS_RETENTION_JOB }, select: { id: true } });
      return any
        ? { status: 'warn', detail: 'The run retention job has never succeeded. Look at it under Administration → Jobs.' }
        : { status: 'skip', detail: 'The run retention job has not run yet (it runs nightly at 03:20 server time).' };
    }
    const totals = await this.prisma.auditEvent.findFirst({ where: { action: RUNS_RETENTION_AUDIT_ACTION, targetType: 'job', targetId: last.id }, select: { meta: true } });
    const meta = (totals?.meta ?? {}) as { deleted?: unknown; users?: unknown; failed?: unknown };
    const num = (v: unknown) => (typeof v === 'number' ? v : null);
    const deleted = num(meta.deleted);
    const hours = (Date.now() - last.finishedAt.getTime()) / 3_600_000;
    const data = { lastSucceededAt: last.finishedAt.toISOString(), deleted, users: num(meta.users), failedUsers: num(meta.failed) };
    const what = `Last succeeded ${last.finishedAt.toISOString()}${deleted === null ? '' : `, deleting ${deleted} run(s)`}.`;
    if (hours > RETENTION_STALE_HOURS) return { status: 'warn', detail: `The run retention job has not succeeded in ${Math.floor(hours)} hours. ${what}`, data };
    return { status: 'pass', detail: what, data };
  }
}
