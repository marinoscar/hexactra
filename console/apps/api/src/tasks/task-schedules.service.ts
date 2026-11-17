import { BadRequestException, ConflictException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import type { RequestWithHeaders } from '@marinoscar/platform-api/core';
import { SettingsResolver } from '@marinoscar/platform-api/settings';
import type { Prisma } from '@prisma/client';

import '../schedules/schedules.errors';
import { PoliciesService } from '../policies/policies.service';
import { PrismaService } from '../prisma/prisma.service';
import { nextFiring, scheduleProblem, validTimezone } from '../schedules/cron';
import { SCHEDULE_LIMIT, type ReplaceTaskScheduleItem, type TaskScheduleItem } from './task-list.schemas';

/** The header a client sends with the device's zone, for a user whose profile follows the device. */
const TIME_ZONE_HEADER = 'x-time-zone';

/** Where a default time zone came from. */
export type TimezoneSource = 'profile' | 'device' | 'default';

/** A schedule of a task request after every check, ready to be written. */
export interface PreparedSchedule {
  /** The existing schedule to update; absent for a new one. */
  id?: string;
  cron: string;
  timezone: string;
  enabled: boolean;
  concurrency: 'skip' | 'queue';
  policyRef: string | null;
  nextRunAt: Date | null;
  /** The schedule goes from disabled to enabled: its failure count starts again. */
  resetFailures: boolean;
}

/** What an existing schedule contributes to an update that leaves a field out. */
interface ExistingSchedule {
  id: string;
  timezone: string;
  enabled: boolean;
  concurrency: 'skip' | 'queue';
  policyRef: string | null;
}

/**
 * A task's schedules as a set (#424): the checks every schedule goes through,
 * the default time zone, creating them with their task, replacing the set, and
 * pausing or resuming all of them. Lives with the tasks (not in `schedules/`)
 * because `POST /tasks` needs it and the schedules module already imports the
 * tasks module. The single-schedule routes (`SchedulesService`) use the same
 * checks.
 */
@Injectable()
export class TaskSchedulesService {
  private readonly log = new Logger(TaskSchedulesService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly policies: PoliciesService,
    @Optional() private readonly settings?: SettingsResolver,
  ) {}

  private db(userId: string) {
    return this.prisma.forUser({ userId });
  }

  /**
   * The zone a schedule gets when the request names none (epic #418, decision 4):
   * the owner's profile time zone; for a profile that follows the device
   * ("Automatic"), the device zone the client sent in `X-Time-Zone`; else UTC.
   * A client that sends no header (MCP, a script) therefore gets the profile zone or UTC.
   */
  async defaultTimezone(userId: string, request?: RequestWithHeaders): Promise<{ timezone: string; source: TimezoneSource }> {
    const stored = await this.settings?.resolveUserTimeZone(userId).catch(() => null);
    if (stored && validTimezone(stored)) return { timezone: stored, source: 'profile' };
    const raw = request?.headers?.[TIME_ZONE_HEADER];
    const header = Array.isArray(raw) ? raw[0] : raw;
    if (typeof header === 'string' && header.trim() !== '' && validTimezone(header.trim())) return { timezone: header.trim(), source: 'device' };
    return { timezone: 'UTC', source: 'default' };
  }

  /** 404 `TASK_NOT_FOUND` unless the task is the user's. */
  async requireTask(userId: string, taskId: string): Promise<void> {
    const task = await this.db(userId).task.findFirst({ where: { id: taskId }, select: { id: true } });
    if (!task) throw new NotFoundException({ code: 'TASK_NOT_FOUND', message: 'Task not found' });
  }

  /** 409 `SCHEDULE_LIMIT` when the task already has its 10 schedules. */
  async assertRoom(userId: string, taskId: string): Promise<void> {
    const count = await this.db(userId).taskSchedule.count({ where: { taskId } });
    if (count >= SCHEDULE_LIMIT) throw new ConflictException({ code: 'SCHEDULE_LIMIT', message: `A task has at most ${SCHEDULE_LIMIT} schedules` });
  }

  /** A 400 for one item of a `schedules[]` body: `details.path` names it (`schedules[1].cron`). */
  private refuse(index: number, field: string, code: string, message: string): never {
    const path = `schedules[${index}].${field}`;
    throw new BadRequestException({ code, message: `${path}: ${message}`, details: { path, issues: [{ path, message }] } });
  }

  /**
   * Check every schedule of a task request and work out what to store. Throws
   * the first problem with its index; nothing is written here. `existing` holds
   * the task's current schedules for a replace (an item with an `id` keeps the
   * fields it leaves out).
   */
  async prepare(userId: string, items: readonly (TaskScheduleItem & { id?: string })[], opts: { request?: RequestWithHeaders; existing?: Map<string, ExistingSchedule> } = {}): Promise<PreparedSchedule[]> {
    if (items.length > SCHEDULE_LIMIT) throw new ConflictException({ code: 'SCHEDULE_LIMIT', message: `A task has at most ${SCHEDULE_LIMIT} schedules` });
    const seen = new Set<string>();
    items.forEach((item, i) => {
      if (item.id === undefined) return;
      if (!opts.existing?.has(item.id)) this.refuse(i, 'id', 'SCHEDULE_NOT_IN_TASK', "Not one of this task's schedules");
      if (seen.has(item.id)) this.refuse(i, 'id', 'SCHEDULE_NOT_IN_TASK', 'This schedule is listed twice');
      seen.add(item.id);
    });

    // The default zone is read once, and only when an item needs it.
    let fallbackZone: string | undefined;
    const refs = new Set<string>();
    for (const item of items) if (typeof item.policyId === 'string') refs.add(item.policyId);
    const known = refs.size > 0 ? await this.policies.findMany(userId, refs) : new Map<string, unknown>();

    const out: PreparedSchedule[] = [];
    for (const [i, item] of items.entries()) {
      const before = item.id !== undefined ? opts.existing!.get(item.id)! : undefined;
      let timezone = item.timezone ?? before?.timezone;
      if (timezone === undefined) {
        fallbackZone ??= (await this.defaultTimezone(userId, opts.request)).timezone;
        timezone = fallbackZone;
      }
      const problem = scheduleProblem(item.cron, timezone);
      if (problem) this.refuse(i, problem.code === 'INVALID_TIMEZONE' ? 'timezone' : 'cron', problem.code, problem.message);
      if (typeof item.policyId === 'string' && !known.has(item.policyId)) {
        this.refuse(i, 'policyId', 'POLICY_REF_INVALID', 'policyId does not name a built-in policy or one of yours');
      }
      const enabled = item.enabled ?? before?.enabled ?? true;
      out.push({
        ...(item.id !== undefined ? { id: item.id } : {}),
        cron: item.cron,
        timezone,
        enabled,
        concurrency: item.concurrency ?? before?.concurrency ?? 'skip',
        policyRef: item.policyId !== undefined ? item.policyId : (before?.policyRef ?? null),
        nextRunAt: enabled ? nextFiring(item.cron, timezone) : null,
        resetFailures: enabled && before !== undefined && !before.enabled,
      });
    }
    return out;
  }

  /** The rows of a task's new schedules, for a `createMany` inside the caller's transaction. */
  rows(userId: string, taskId: string, schedules: readonly PreparedSchedule[]): Prisma.TaskScheduleCreateManyInput[] {
    // `createdAt` is spread a millisecond apart so the schedules keep the order they were sent in.
    const base = Date.now();
    return schedules.map((s, i) => ({
      userId,
      taskId,
      cron: s.cron,
      timezone: s.timezone,
      enabled: s.enabled,
      concurrency: s.concurrency,
      policyRef: s.policyRef,
      nextRunAt: s.nextRunAt,
      createdAt: new Date(base + i),
    }));
  }

  /**
   * Replace the task's schedule set in one transaction: items with an `id` are
   * updated (their `lastRunAt`, `lastRunId` and `consecutiveFailures` stay),
   * items without are created, schedules that are not listed are deleted.
   * `nextRunAt` is recomputed for each.
   */
  async replace(userId: string, taskId: string, items: readonly ReplaceTaskScheduleItem[], request?: RequestWithHeaders): Promise<void> {
    await this.requireTask(userId, taskId);
    const current = await this.db(userId).taskSchedule.findMany({ where: { taskId }, select: { id: true, timezone: true, enabled: true, concurrency: true, policyRef: true } });
    const prepared = await this.prepare(userId, items, { request, existing: new Map(current.map((s) => [s.id, s])) });
    const keep = prepared.flatMap((s) => (s.id !== undefined ? [s.id] : []));
    const created = prepared.filter((s) => s.id === undefined);
    await this.prisma.$transaction(async (tx) => {
      await tx.taskSchedule.deleteMany({ where: { userId, taskId, id: { notIn: keep } } });
      for (const s of prepared) {
        if (s.id === undefined) continue;
        await tx.taskSchedule.updateMany({
          where: { id: s.id, userId, taskId },
          data: { cron: s.cron, timezone: s.timezone, enabled: s.enabled, concurrency: s.concurrency, policyRef: s.policyRef, nextRunAt: s.nextRunAt, ...(s.resetFailures ? { consecutiveFailures: 0 } : {}) },
        });
      }
      if (created.length > 0) await tx.taskSchedule.createMany({ data: this.rows(userId, taskId, created) });
    });
    this.log.log(`schedules replaced: user ${userId}, task ${taskId}: ${keep.length} updated, ${created.length} created, ${current.length - keep.length} deleted`);
  }

  /** Pause every schedule of the task: `enabled = false`, `nextRunAt = null`. A live run is not touched. */
  async pause(userId: string, taskId: string): Promise<{ changed: number; skipped: string[] }> {
    await this.requireTask(userId, taskId);
    const { count } = await this.prisma.taskSchedule.updateMany({ where: { userId, taskId }, data: { enabled: false, nextRunAt: null } });
    if (count === 0) throw new ConflictException({ code: 'NO_SCHEDULES', message: 'This task has no schedule' });
    this.log.log(`schedules paused: user ${userId}, task ${taskId}, ${count} schedule(s)`);
    return { changed: count, skipped: [] };
  }

  /**
   * Resume every schedule of the task in one transaction: `enabled = true`, a
   * fresh `nextRunAt`, `consecutiveFailures = 0`. A schedule whose stored
   * expression no longer computes a firing is left as it is and returned in `skipped`.
   */
  async resume(userId: string, taskId: string): Promise<{ changed: number; skipped: string[] }> {
    await this.requireTask(userId, taskId);
    const schedules = await this.db(userId).taskSchedule.findMany({ where: { taskId }, select: { id: true, cron: true, timezone: true } });
    if (schedules.length === 0) throw new ConflictException({ code: 'NO_SCHEDULES', message: 'This task has no schedule' });
    const skipped: string[] = [];
    const updates: Prisma.PrismaPromise<unknown>[] = [];
    for (const s of schedules) {
      const next = nextFiring(s.cron, s.timezone);
      if (!next) {
        skipped.push(s.id);
        continue;
      }
      updates.push(this.prisma.taskSchedule.updateMany({ where: { id: s.id, userId, taskId }, data: { enabled: true, nextRunAt: next, consecutiveFailures: 0 } }));
    }
    if (updates.length > 0) await this.prisma.$transaction(updates);
    if (skipped.length > 0) this.log.warn(`schedules resumed: user ${userId}, task ${taskId}: skipped ${skipped.join(', ')} (the stored expression is no longer valid)`);
    this.log.log(`schedules resumed: user ${userId}, task ${taskId}, ${updates.length} schedule(s)`);
    return { changed: updates.length, skipped };
  }
}
