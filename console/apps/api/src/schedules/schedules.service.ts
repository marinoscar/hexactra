import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { JobsService } from '@marinoscar/platform-api/jobs';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { PoliciesService } from '../policies/policies.service';
import { policyRefSchema } from '../policies/policies.schemas';
import { PrismaService } from '../prisma/prisma.service';
import { enqueueGoalRun } from '../runner/goal-runner.jobs';
import { nextFiring, tooFrequent, validTimezone } from './cron';

export const createScheduleSchema = z.object({
  taskId: z.uuid(),
  cron: z.string().trim().min(9).max(100),
  timezone: z.string().trim().min(1).max(64).default('UTC'),
  enabled: z.boolean().default(true),
  concurrency: z.enum(['skip', 'queue']).default('skip'),
  policyId: policyRefSchema.nullable().optional().describe("Overrides the task's agent policy for scheduled runs; omit or null to follow the task."),
});
export class CreateScheduleDto extends createZodDto(createScheduleSchema) {}
// No defaults here: zod 4 applies `.default()` inside `.partial()`, which
// would reset unsent fields (a pause would move the schedule to UTC).
export const updateScheduleSchema = z.object({
  cron: z.string().trim().min(9).max(100).optional(),
  timezone: z.string().trim().min(1).max(64).optional(),
  enabled: z.boolean().optional(),
  concurrency: z.enum(['skip', 'queue']).optional(),
  policyId: policyRefSchema.nullable().optional().describe("Overrides the task's agent policy for scheduled runs; null follows the task."),
});
export class UpdateScheduleDto extends createZodDto(updateScheduleSchema) {}

/** A schedule row as the API returns it: the policy reference is `policyId`. */
export function scheduleView<T extends { policyRef: string | null }>(schedule: T): Omit<T, 'policyRef'> & { policyId: string | null } {
  const { policyRef, ...rest } = schedule;
  return { ...rest, policyId: policyRef };
}

/** Failed runs in a row after which the owner is told the schedule is failing. */
export const FAILING_AFTER = 3;

@Injectable()
export class SchedulesService {
  private readonly log = new Logger(SchedulesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly policies: PoliciesService,
  ) {}

  private db(userId: string) {
    return this.prisma.forUser({ userId });
  }

  private check(cron: string, tz: string): Date {
    if (!validTimezone(tz)) throw new BadRequestException({ code: 'INVALID_TIMEZONE', message: `Unknown time zone "${tz}"` });
    const next = nextFiring(cron, tz);
    if (!next) throw new BadRequestException({ code: 'INVALID_CRON', message: 'Use a 5-field cron expression, e.g. "0 9 * * 1-5"' });
    if (tooFrequent(cron, tz)) throw new BadRequestException({ code: 'CRON_TOO_FREQUENT', message: 'A schedule may fire at most every 5 minutes' });
    return next;
  }

  async list(userId: string, taskId?: string) {
    return (await this.db(userId).taskSchedule.findMany({ where: taskId ? { taskId } : {}, orderBy: { createdAt: 'asc' } })).map(scheduleView);
  }

  async create(userId: string, input: CreateScheduleDto) {
    const task = await this.db(userId).task.findFirst({ where: { id: input.taskId }, select: { id: true } });
    if (!task) throw new NotFoundException({ code: 'TASK_NOT_FOUND', message: 'Task not found' });
    const next = this.check(input.cron, input.timezone);
    const { policyId, ...fields } = input;
    await this.policies.assertAssignable(userId, policyId);
    return scheduleView(await this.db(userId).taskSchedule.create({ data: { ...fields, userId, policyRef: policyId ?? null, nextRunAt: input.enabled ? next : null } }));
  }

  async update(userId: string, id: string, patch: UpdateScheduleDto) {
    const db = this.db(userId);
    const s = await db.taskSchedule.findFirst({ where: { id } });
    if (!s) throw new NotFoundException({ code: 'SCHEDULE_NOT_FOUND', message: 'Schedule not found' });
    const cron = patch.cron ?? s.cron;
    const timezone = patch.timezone ?? s.timezone;
    const enabled = patch.enabled ?? s.enabled;
    const next = this.check(cron, timezone);
    const { policyId, ...fields } = patch;
    await this.policies.assertAssignable(userId, policyId);
    await db.taskSchedule.updateMany({
      where: { id },
      data: { ...fields, ...(policyId !== undefined ? { policyRef: policyId } : {}), nextRunAt: enabled ? next : null, ...(patch.enabled ? { consecutiveFailures: 0 } : {}) },
    });
    return scheduleView(await db.taskSchedule.findFirstOrThrow({ where: { id } }));
  }

  async remove(userId: string, id: string): Promise<void> {
    const { count } = await this.db(userId).taskSchedule.deleteMany({ where: { id } });
    if (count === 0) throw new NotFoundException({ code: 'SCHEDULE_NOT_FOUND', message: 'Schedule not found' });
  }

  /**
   * Start every due schedule's run (the `browser.schedules.tick` job). Each
   * schedule moves to its next firing first, so a crash never fires twice;
   * missed firings while the console was down are not replayed (only the
   * latest one runs). Returns the schedules that just became "failing".
   */
  async tick(now = new Date()): Promise<{ started: number; skipped: number; failing: { userId: string; scheduleId: string; taskName: string; failures: number }[] }> {
    const due = await this.prisma.taskSchedule.findMany({
      where: { enabled: true, nextRunAt: { lte: now } },
      include: { task: true },
      take: 200,
    });
    let started = 0;
    let skipped = 0;
    const failing: { userId: string; scheduleId: string; taskName: string; failures: number }[] = [];
    for (const s of due) {
      const next = nextFiring(s.cron, s.timezone, now);
      // Claim the firing (compare-and-set on nextRunAt) before doing anything.
      const claimed = await this.prisma.taskSchedule.updateMany({ where: { id: s.id, nextRunAt: s.nextRunAt }, data: { nextRunAt: next } });
      if (claimed.count === 0) continue;

      // Track the previous run's outcome.
      let failures = s.consecutiveFailures;
      if (s.lastRunId) {
        const last = await this.prisma.run.findFirst({ where: { id: s.lastRunId }, select: { status: true } });
        if (last?.status === 'failed') failures += 1;
        else if (last?.status === 'succeeded') failures = 0;
      }
      if (failures !== s.consecutiveFailures) {
        await this.prisma.taskSchedule.updateMany({ where: { id: s.id }, data: { consecutiveFailures: failures } });
        if (failures === FAILING_AFTER) failing.push({ userId: s.userId, scheduleId: s.id, taskName: s.task.name, failures });
      }

      if (s.concurrency === 'skip') {
        const live = await this.prisma.run.count({ where: { taskId: s.taskId, status: { in: ['queued', 'running', 'waiting_human'] } } });
        if (live > 0) {
          skipped += 1;
          continue;
        }
      }
      const run = await this.db(s.userId).run.create({
        data: { userId: s.userId, taskId: s.taskId, goal: s.task.goal, profile: s.task.profile, hostId: s.task.hostId, hostFallback: s.task.hostFallback, trigger: 'schedule', ...(s.policyRef ? { policyRef: s.policyRef, policySource: 'schedule' as const } : {}) },
        select: { id: true },
      });
      await this.prisma.taskSchedule.updateMany({ where: { id: s.id }, data: { lastRunAt: now, lastRunId: run.id } });
      await enqueueGoalRun(this.jobs, { runId: run.id, userId: s.userId, orgId: null }, 'schedule');
      started += 1;
    }
    if (started || skipped) this.log.log(`schedules: ${started} started, ${skipped} skipped (a run was still live)`);
    return { started, skipped, failing };
  }
}
