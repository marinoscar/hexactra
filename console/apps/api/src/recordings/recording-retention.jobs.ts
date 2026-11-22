import { Inject, Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { Cron } from '@nestjs/schedule';
import { DoctorCheckRegistry, type DoctorCheck, type DoctorCheckOutcome } from '@marinoscar/platform-api/doctor';
import { JobHandlerRegistry, JobsService, enqueueHousekeepingJob, type Job, type JobHandler } from '@marinoscar/platform-api/jobs';
import { SystemSettingsService } from '@marinoscar/platform-api/settings';

import { PrismaService } from '../prisma/prisma.service';
import { RUN_ARTIFACT_STORE, type RunArtifactStore } from '../tasks/run-delete.service';
import { recordingKeys } from './recording-keys';
import { readRecordingsSettings } from './recordings.settings';

/** The job type. Permanent once jobs of this type exist: never rename it. */
export const RECORDINGS_RETENTION_JOB = 'browser.recordings.retention';
/** The audit action of one pass, with its totals. */
export const RECORDINGS_RETENTION_AUDIT_ACTION = 'runs.recordings_purged';
/** Recordings deleted per batch, and the most per pass (the rest goes the next night). */
export const RECORDINGS_RETENTION_BATCH = 500;
export const RECORDINGS_RETENTION_PASS_CAP = 50_000;
/** The Doctor warns when the job has not succeeded for this long. */
export const RECORDINGS_RETENTION_STALE_HOURS = 48;

export interface RecordingsRetentionTotals {
  keepDays: number | null;
  deleted: number;
  bytes: number;
  objectsFailed: number;
}

/**
 * `browser.recordings.retention` (E45.6, #761): the nightly pass that enforces the administrator's `recordings.keepDays` (default 30).
 * It deletes finished recordings (`ready`, `failed`) made more than `keepDays` ago, rows first and their objects after the commit; a
 * recording that is still being made is never touched. With `keepDays: null` (keep indefinitely) it deletes nothing. The run and its
 * masked trace stay. Expiry is computed when the job runs, so a shorter period applies to recordings already stored. Safe to repeat.
 */
@Injectable()
export class RecordingsRetentionHandler implements JobHandler, OnModuleInit {
  readonly type = RECORDINGS_RETENTION_JOB;
  readonly label = 'Delete run recordings past their retention';
  readonly profile = { maxRuntimeMs: 15 * 60_000, maxAttempts: 2 };
  private readonly log = new Logger(RecordingsRetentionHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    @Optional() private readonly systemSettings?: SystemSettingsService,
    @Optional() @Inject(RUN_ARTIFACT_STORE) private readonly store?: RunArtifactStore,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    await this.purge(job.id);
  }

  async purge(jobId: string, now = Date.now()): Promise<RecordingsRetentionTotals> {
    let keepDays: number | null;
    try {
      keepDays = readRecordingsSettings(await this.systemSettings?.getNamespace('recordings')).keepDays;
    } catch (e) {
      this.log.warn(`recordings settings could not be read (${e instanceof Error ? e.name : 'error'}); the defaults apply`);
      keepDays = readRecordingsSettings(undefined).keepDays;
    }
    const totals: RecordingsRetentionTotals = { keepDays, deleted: 0, bytes: 0, objectsFailed: 0 };
    if (keepDays !== null) {
      const cutoff = new Date(now - keepDays * 86_400_000);
      const where = { status: { in: ['ready', 'failed'] }, createdAt: { lt: cutoff } };
      while (totals.deleted < RECORDINGS_RETENTION_PASS_CAP) {
        const rows = await this.prisma.runRecording.findMany({ where, orderBy: { createdAt: 'asc' }, take: RECORDINGS_RETENTION_BATCH, select: { id: true, runId: true, userId: true, partCount: true, objectKey: true, bytes: true } });
        if (rows.length === 0) break;
        // The status and the age again in the delete: a row that changed in between stays.
        const { count } = await this.prisma.runRecording.deleteMany({ where: { id: { in: rows.map((r) => r.id) }, ...where } });
        totals.deleted += count;
        totals.bytes += rows.reduce((n, r) => n + Number(r.bytes), 0);
        for (const key of rows.flatMap((r) => recordingKeys(r))) {
          await this.store?.delete(key).catch(() => totals.objectsFailed++);
        }
        if (rows.length < RECORDINGS_RETENTION_BATCH) break;
      }
    }
    // A count only: never a key (it names a user and a run).
    if (totals.objectsFailed) this.log.warn(`job ${jobId}: ${totals.objectsFailed} recording object(s) could not be deleted`);
    this.log.log(`job ${jobId}: ${RECORDINGS_RETENTION_JOB} keepDays=${keepDays ?? 'indefinitely'} deleted=${totals.deleted}`);
    try {
      await this.prisma.auditEvent.create({ data: { action: RECORDINGS_RETENTION_AUDIT_ACTION, targetType: 'job', targetId: jobId, meta: { ...totals } } });
    } catch (e) {
      this.log.warn(`job ${jobId}: the totals could not be recorded: ${e instanceof Error ? e.name : 'error'}`);
    }
    return totals;
  }
}

/** The nightly trigger, 03:30 server time. A `@Cron` only enqueues (queue rule 1). */
@Injectable()
export class RecordingsRetentionTask {
  private readonly logger = new Logger(RecordingsRetentionTask.name);

  constructor(
    private readonly jobs: JobsService,
    private readonly prisma: PrismaService,
  ) {}

  @Cron('30 3 * * *')
  async handleCron(): Promise<void> {
    await enqueueHousekeepingJob({ jobs: this.jobs, prisma: this.prisma, logger: this.logger, type: RECORDINGS_RETENTION_JOB, what: 'run recordings retention' });
  }
}

/**
 * `runs.recordings_retention` in the admin Doctor: when the nightly recordings retention job last succeeded and what it deleted. Warns
 * when it has not succeeded in 48 hours. Read-only.
 */
@Injectable()
export class RecordingsRetentionDoctorCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'runs.recordings_retention';
  readonly category = 'runs';
  readonly label = 'Run recordings retention';

  constructor(
    private readonly registry: DoctorCheckRegistry,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async run(now = Date.now()): Promise<DoctorCheckOutcome> {
    const last = await this.prisma.job.findFirst({ where: { type: RECORDINGS_RETENTION_JOB, status: 'succeeded' }, orderBy: { finishedAt: 'desc' }, select: { id: true, finishedAt: true } });
    if (!last?.finishedAt) {
      const any = await this.prisma.job.findFirst({ where: { type: RECORDINGS_RETENTION_JOB }, select: { id: true } });
      return any
        ? { status: 'warn', detail: 'The run recordings retention job has never succeeded. Look at it under Administration → Jobs.' }
        : { status: 'skip', detail: 'The run recordings retention job has not run yet (it runs nightly at 03:30 server time).' };
    }
    const totals = await this.prisma.auditEvent.findFirst({ where: { action: RECORDINGS_RETENTION_AUDIT_ACTION, targetType: 'job', targetId: last.id }, select: { meta: true } });
    const meta = (totals?.meta ?? {}) as { deleted?: unknown; keepDays?: unknown };
    const deleted = typeof meta.deleted === 'number' ? meta.deleted : null;
    const hours = (now - last.finishedAt.getTime()) / 3_600_000;
    const data = { lastSucceededAt: last.finishedAt.toISOString(), deleted, keepDays: typeof meta.keepDays === 'number' ? meta.keepDays : null };
    const what = `Last succeeded ${last.finishedAt.toISOString()}${deleted === null ? '' : `, deleting ${deleted} recording(s)`}.`;
    if (hours > RECORDINGS_RETENTION_STALE_HOURS) return { status: 'warn', detail: `The run recordings retention job has not succeeded in ${Math.floor(hours)} hours. ${what}`, data };
    return { status: 'pass', detail: what, data };
  }
}
