import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { RequestWithHeaders } from '@marinoscar/platform-api/core';
import { JobsService } from '@marinoscar/platform-api/jobs';
import { Prisma } from '@prisma/client';
import { createZodDto } from 'nestjs-zod';
import { z } from 'zod';

import { PoliciesService } from '../policies/policies.service';
import { policyRefSchema } from '../policies/policies.schemas';
import { PrismaService } from '../prisma/prisma.service';
import { TaskRunStarter } from '../questions/task-run-starter';
import { assertScheduleInputs, scheduleInputs } from '../tasks/task-params';
import { readParameters, taskInputsField } from '../tasks/task-params.schemas';
import { FAILING_AFTER } from '../tasks/task-list.schemas';
import { TaskSchedulesService } from '../tasks/task-schedules.service';
import { nextFiring, nextFirings, scheduleProblem } from './cron';
import { describeCron } from './cron-describe';
import './schedules.errors';

export const createScheduleSchema = z.object({
  taskId: z.uuid(),
  cron: z.string().trim().min(9).max(100),
  timezone: z.string().trim().min(1).max(64).optional().describe("An IANA time zone. Omitted: the owner's profile time zone (see `GET /schedules/defaults`)."),
  enabled: z.boolean().default(true),
  concurrency: z.enum(['skip', 'queue']).default('skip'),
  policyId: policyRefSchema.nullable().optional().describe("Overrides the task's agent policy for scheduled runs; omit or null to follow the task."),
  inputs: taskInputsField.optional().describe("Preset values for the task's parameters (#552). An enabled schedule needs a value (here, a default or a memory) for every required parameter: 400 `SCHEDULE_INPUTS_MISSING`."),
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
  inputs: taskInputsField.nullable().optional().describe("Preset values for the task's parameters (#552); null clears them."),
});
export class UpdateScheduleDto extends createZodDto(updateScheduleSchema) {}

export const listSchedulesSchema = z.object({
  taskId: z.uuid().optional().describe('Only the schedules of this task.'),
});
export class ListSchedulesDto extends createZodDto(listSchedulesSchema) {}

export const previewScheduleSchema = z.object({
  // Loose on purpose: a bad expression or zone is answered with `valid: false`, never a 400.
  cron: z.string().max(200),
  timezone: z.string().trim().min(1).max(100).optional().describe("Omitted: the owner's profile time zone."),
  count: z.number().int().min(1).max(10).default(5).describe('How many firings to return.'),
});
export class PreviewScheduleDto extends createZodDto(previewScheduleSchema) {}

/** What `POST /schedules/preview` answers. */
export type SchedulePreview =
  | { valid: true; cron: string; timezone: string; description: string; next: string[]; intervalSeconds: number | null }
  | { valid: false; code: 'INVALID_CRON' | 'INVALID_TIMEZONE' | 'CRON_TOO_FREQUENT'; message: string };

/** Check a schedule and say what it means and when it fires next. Pure: never throws for bad input. */
export function previewSchedule(cron: string, timezone: string, count: number, after: Date = new Date()): SchedulePreview {
  const expr = cron.trim();
  const problem = scheduleProblem(expr, timezone);
  if (problem) return { valid: false, ...problem };
  // A few more than asked for, so "evenly spaced" is judged on more than one gap.
  const firings = nextFirings(expr, timezone, Math.max(count, 6), after);
  const gaps = firings.slice(1).map((d, i) => d.getTime() - firings[i]!.getTime());
  const even = gaps.length > 0 && gaps.every((g) => g === gaps[0]);
  return {
    valid: true,
    cron: expr,
    timezone,
    description: describeCron(expr),
    next: firings.slice(0, count).map((d) => d.toISOString()),
    intervalSeconds: even ? Math.round(gaps[0]! / 1000) : null,
  };
}

/** A schedule row as the API returns it: the policy reference is `policyId`, and `description` says the expression in words. */
export function scheduleView<T extends { policyRef: string | null; cron: string }>(schedule: T): Omit<T, 'policyRef'> & { policyId: string | null; description: string } {
  const { policyRef, ...rest } = schedule;
  return { ...rest, policyId: policyRef, description: describeCron(schedule.cron) };
}

/** Failed runs in a row after which the owner is told the schedule is failing. */
export { FAILING_AFTER };

@Injectable()
export class SchedulesService {
  private readonly log = new Logger(SchedulesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly jobs: JobsService,
    private readonly policies: PoliciesService,
    private readonly taskSchedules: TaskSchedulesService,
    private readonly starter: TaskRunStarter,
  ) {}

  private db(userId: string) {
    return this.prisma.forUser({ userId });
  }

  private check(cron: string, tz: string): Date {
    const problem = scheduleProblem(cron, tz);
    if (problem) throw new BadRequestException(problem);
    return nextFiring(cron, tz)!;
  }

  async list(userId: string, taskId?: string) {
    return (await this.db(userId).taskSchedule.findMany({ where: taskId ? { taskId } : {}, orderBy: { createdAt: 'asc' } })).map(scheduleView);
  }

  /** The zone a schedule gets when its request names none (the profile's; see `TaskSchedulesService.defaultTimezone`). */
  defaults(userId: string, request?: RequestWithHeaders) {
    return this.taskSchedules.defaultTimezone(userId, request);
  }

  /** `POST /schedules/preview`: the zone defaults like a new schedule's. */
  async preview(userId: string, input: PreviewScheduleDto, request?: RequestWithHeaders): Promise<SchedulePreview> {
    const timezone = input.timezone ?? (await this.defaults(userId, request)).timezone;
    return previewSchedule(input.cron, timezone, input.count);
  }

  /** Create a schedule. Without `timezone` it gets the owner's profile time zone (#424). */
  async create(userId: string, input: CreateScheduleDto, request?: RequestWithHeaders) {
    const task = await this.db(userId).task.findFirst({ where: { id: input.taskId }, select: { id: true, parameters: true } });
    if (!task) throw new NotFoundException({ code: 'TASK_NOT_FOUND', message: 'Task not found' });
    const timezone = input.timezone ?? (await this.defaults(userId, request)).timezone;
    const next = this.check(input.cron, timezone);
    const { policyId, inputs: rawInputs, ...fields } = input;
    // Preset parameter values (#552): checked, and an enabled schedule needs every required one.
    const params = readParameters(task.parameters);
    const presets = rawInputs ? scheduleInputs(params, rawInputs) : null;
    if (input.enabled) assertScheduleInputs(params, presets);
    await this.policies.assertAssignable(userId, policyId);
    await this.taskSchedules.assertRoom(userId, input.taskId);
    return scheduleView(await this.db(userId).taskSchedule.create({ data: { ...fields, timezone, userId, policyRef: policyId ?? null, nextRunAt: input.enabled ? next : null, ...(presets && Object.keys(presets).length ? { inputs: presets } : {}) } }));
  }

  async update(userId: string, id: string, patch: UpdateScheduleDto) {
    const db = this.db(userId);
    const s = await db.taskSchedule.findFirst({ where: { id } });
    if (!s) throw new NotFoundException({ code: 'SCHEDULE_NOT_FOUND', message: 'Schedule not found' });
    const cron = patch.cron ?? s.cron;
    const timezone = patch.timezone ?? s.timezone;
    const enabled = patch.enabled ?? s.enabled;
    const next = this.check(cron, timezone);
    const { policyId, inputs: rawInputs, ...fields } = patch;
    await this.policies.assertAssignable(userId, policyId);
    // Preset parameter values (#552): an enabled schedule needs a value for every required parameter.
    const task = await db.task.findFirst({ where: { id: s.taskId }, select: { parameters: true } });
    const params = readParameters(task?.parameters);
    const presets = rawInputs === undefined ? ((s.inputs as Record<string, string> | null) ?? null) : rawInputs === null ? null : scheduleInputs(params, rawInputs);
    if (enabled) assertScheduleInputs(params, presets);
    await db.taskSchedule.updateMany({
      where: { id },
      data: { ...fields, ...(rawInputs !== undefined ? { inputs: presets && Object.keys(presets).length ? presets : Prisma.DbNull } : {}), ...(policyId !== undefined ? { policyRef: policyId } : {}), nextRunAt: enabled ? next : null, ...(patch.enabled ? { consecutiveFailures: 0 } : {}) },
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
  async tick(now = new Date()): Promise<{ started: number; skipped: number; failing: { userId: string; scheduleId: string; taskId: string; taskName: string; failures: number }[] }> {
    const due = await this.prisma.taskSchedule.findMany({
      where: { enabled: true, nextRunAt: { lte: now } },
      include: { task: true },
      take: 200,
    });
    let started = 0;
    let skipped = 0;
    const failing: { userId: string; scheduleId: string; taskId: string; taskName: string; failures: number }[] = [];
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
        if (failures === FAILING_AFTER) failing.push({ userId: s.userId, scheduleId: s.id, taskId: s.taskId, taskName: s.task.name, failures });
      }

      if (s.concurrency === 'skip') {
        const live = await this.prisma.run.count({ where: { taskId: s.taskId, status: { in: ['queued', 'running', 'waiting_human', 'paused'] } } });
        if (live > 0) {
          skipped += 1;
          continue;
        }
      }
      // The task's parameters are filled from the schedule's presets, the defaults and the owner's memories;
      // a value still missing makes the run wait on one form, and the owner is notified (#552).
      let run: { id: string };
      try {
        ({ run } = await this.starter.start({ id: s.userId, activeOrgId: null }, s.task, {
          presets: (s.inputs as Record<string, string> | null) ?? null,
          timeZone: s.timezone,
          reason: 'schedule',
          data: { trigger: 'schedule', origin: 'schedule', ...(s.policyRef ? { policyRef: s.policyRef, policySource: 'schedule' as const } : {}) },
        }));
      } catch (e) {
        this.log.warn(`schedule ${s.id}: could not start its run: ${e instanceof Error ? e.message : String(e)}`);
        continue;
      }
      await this.prisma.taskSchedule.updateMany({ where: { id: s.id }, data: { lastRunAt: now, lastRunId: run.id } });
      started += 1;
    }
    if (started || skipped) this.log.log(`schedules: ${started} started, ${skipped} skipped (a run was still live)`);
    return { started, skipped, failing };
  }
}
