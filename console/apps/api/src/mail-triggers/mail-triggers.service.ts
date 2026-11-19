// Mail triggers: create, change, delete, preview and list their events (E39.8, #605). Every method is the caller's own: another
// user's trigger, task or connection is a 404/400 like a missing one. Nothing here starts a run or touches a mailbox except the
// preview (`test`), which only reads and starts nothing.
import { BadRequestException, ConflictException, Injectable, NotFoundException } from '@nestjs/common';
import { Prisma, type MailTrigger } from '@prisma/client';

import { CapabilityError, isCapabilityError, type MailMessage, type MailSummary } from '../connections/capabilities';
import { ConnectionCapabilities } from '../connections/connection-capabilities.service';
import { capabilitiesOf } from '../connections/connection-view';
import { PrismaService } from '../prisma/prisma.service';
import { checkMailInputs, type MailInputs } from './mail-inputs';
import { isOwnMessage, matchMessage, normalizeMatch, readMatch, toMailQuery, type MailMatch } from './mail-match';
import { DEFAULT_MAX_RUNS_PER_DAY, DEFAULT_POLL_SECONDS, TEST_PREVIEW_COUNT, TEST_SUBJECT_CHARS } from './mail-triggers.constants';
import './mail-triggers.errors';
import { MailTriggerEvents, MAIL_TRIGGER_AUDIT } from './mail-triggers.events';
import { MailTriggerLimitsService } from './mail-triggers.limits';
import type { CreateMailTriggerDto, MailTriggerEventsQueryDto, MailTriggerTestResult, UpdateMailTriggerDto } from './mail-triggers.schemas';
import { readParameters } from '../tasks/task-params.schemas';
import { nextPollAfter } from './mail-trigger.poller';

const utcDayStart = (d = new Date()): Date => new Date(`${d.toISOString().slice(0, 10)}T00:00:00.000Z`);

@Injectable()
export class MailTriggersService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilities: ConnectionCapabilities,
    private readonly events: MailTriggerEvents,
    private readonly limits: MailTriggerLimitsService,
  ) {}

  private db(userId: string) {
    return this.prisma.forUser({ userId });
  }

  private async task(userId: string, taskId: string) {
    const task = await this.db(userId).task.findFirst({ where: { id: taskId } });
    if (!task) throw new NotFoundException({ code: 'TASK_NOT_FOUND', message: 'Task not found' });
    return task;
  }

  private async trigger(userId: string, id: string): Promise<MailTrigger> {
    const t = await this.db(userId).mailTrigger.findFirst({ where: { id } });
    if (!t) throw new NotFoundException({ code: 'MAIL_TRIGGER_NOT_FOUND', message: 'Mail trigger not found' });
    return t;
  }

  /** The connection must be the caller's, a mail provider, and have `mail_read` (and `mail_modify` for an after-start action). */
  private async checkConnection(userId: string, connectionId: string, afterStart: string) {
    const c = await this.db(userId).connection.findFirst({ where: { id: connectionId } });
    if (!c || c.provider === 'mcp') throw new BadRequestException({ code: 'MAIL_TRIGGER_CONNECTION_INVALID', message: 'Choose one of your connected Google or Microsoft accounts', details: { reason: 'not_found' } });
    const on = capabilitiesOf(c);
    if (!on.includes('mail_read')) throw new BadRequestException({ code: 'MAIL_TRIGGER_CONNECTION_INVALID', message: 'Switch on reading mail for this account first (Settings, Connections)', details: { reason: 'no_mail_read' } });
    if (afterStart !== 'none' && !on.includes('mail_modify')) {
      throw new BadRequestException({ code: 'MAIL_TRIGGER_CONNECTION_INVALID', message: 'Marking or labelling mail needs the account\'s "change mail" switch', details: { reason: 'no_mail_modify' } });
    }
    return c;
  }

  private checkInputs(task: { parameters: unknown }, inputs: MailInputs | null | undefined): MailInputs | null {
    const { inputs: clean, issues } = checkMailInputs(readParameters(task.parameters), inputs);
    if (issues.length) {
      throw new BadRequestException({ code: 'MAIL_TRIGGER_INPUTS_INVALID', message: issues.map((i) => `${i.key}: ${i.message}`).join('; '), details: { issues } });
    }
    return clean;
  }

  private async checkPoll(pollSeconds: number): Promise<void> {
    const { minPollSeconds } = await this.limits.get();
    if (pollSeconds < minPollSeconds) throw new BadRequestException({ code: 'MAIL_TRIGGER_POLL_TOO_FAST', message: `Look for mail at most every ${minPollSeconds} seconds`, details: { minPollSeconds } });
  }

  private async view(userId: string, rows: MailTrigger[]) {
    if (rows.length === 0) return [];
    const labels = new Map((await this.db(userId).connection.findMany({ where: { id: { in: [...new Set(rows.map((r) => r.connectionId))] } }, select: { id: true, label: true } })).map((c) => [c.id, c.label]));
    const today = await this.prisma.mailTriggerEvent.groupBy({ by: ['triggerId'], where: { triggerId: { in: rows.map((r) => r.id) }, outcome: 'started', createdAt: { gte: utcDayStart() } }, _count: { _all: true } });
    const counts = new Map(today.map((g) => [g.triggerId, g._count._all]));
    return rows.map((t) => ({
      id: t.id,
      taskId: t.taskId,
      connectionId: t.connectionId,
      connectionLabel: labels.get(t.connectionId) ?? null,
      name: t.name,
      enabled: t.enabled,
      match: readMatch(t.match) ?? { from: [] },
      inputs: (t.inputs as Record<string, unknown> | null) ?? null,
      afterStart: t.afterStart,
      pollSeconds: t.pollSeconds,
      maxRunsPerDay: t.maxRunsPerDay,
      acceptUnverified: t.acceptUnverified,
      status: t.status as (typeof import('./mail-triggers.constants').MAIL_TRIGGER_STATUSES)[number],
      statusReason: t.statusReason,
      lastCheckedAt: t.lastCheckedAt?.toISOString() ?? null,
      lastMatchedAt: t.lastMatchedAt?.toISOString() ?? null,
      runsToday: counts.get(t.id) ?? 0,
      createdAt: t.createdAt.toISOString(),
      updatedAt: t.updatedAt.toISOString(),
    }));
  }

  async list(userId: string, taskId: string) {
    await this.task(userId, taskId);
    return this.view(userId, await this.db(userId).mailTrigger.findMany({ where: { taskId }, orderBy: { createdAt: 'asc' } }));
  }

  async create(userId: string, taskId: string, input: CreateMailTriggerDto) {
    const task = await this.task(userId, taskId);
    const match = normalizeMatch(input.match);
    const afterStart = input.afterStart ?? 'none';
    await this.checkConnection(userId, input.connectionId, afterStart);
    const inputs = this.checkInputs(task, input.inputs);
    const pollSeconds = input.pollSeconds ?? Math.max(DEFAULT_POLL_SECONDS, (await this.limits.get()).minPollSeconds);
    await this.checkPoll(pollSeconds);
    const { maxTriggersPerUser } = await this.limits.get();
    if ((await this.db(userId).mailTrigger.count()) >= maxTriggersPerUser) {
      throw new ConflictException({ code: 'MAIL_TRIGGER_LIMIT', message: `You already have ${maxTriggersPerUser} email triggers: delete one first`, details: { limit: maxTriggersPerUser } });
    }
    const now = new Date();
    const row = await this.db(userId).mailTrigger.create({
      data: {
        userId,
        taskId,
        connectionId: input.connectionId,
        name: (input.name ?? match.from[0] ?? 'Email trigger').slice(0, 120),
        enabled: input.enabled ?? true,
        match: match as unknown as Prisma.InputJsonValue,
        ...(inputs ? { inputs: inputs as unknown as Prisma.InputJsonValue } : {}),
        afterStart,
        pollSeconds,
        maxRunsPerDay: input.maxRunsPerDay ?? DEFAULT_MAX_RUNS_PER_DAY,
        acceptUnverified: input.acceptUnverified ?? false,
        activeSince: now,
        nextPollAt: now,
      },
    });
    await this.events.audit(userId, MAIL_TRIGGER_AUDIT.created, row.id, { taskId, connectionId: input.connectionId });
    return (await this.view(userId, [row]))[0]!;
  }

  async update(userId: string, id: string, patch: UpdateMailTriggerDto) {
    const t = await this.trigger(userId, id);
    const task = await this.task(userId, t.taskId);
    const afterStart = patch.afterStart ?? t.afterStart;
    const connectionId = patch.connectionId ?? t.connectionId;
    // The connection is checked whenever it, the after-start action or the enabled switch changes (a removed account cannot be enabled).
    const enabling = patch.enabled === true && !t.enabled;
    if (patch.connectionId !== undefined || patch.afterStart !== undefined || enabling) await this.checkConnection(userId, connectionId, afterStart);
    const inputs = patch.inputs === undefined ? undefined : this.checkInputs(task, patch.inputs);
    if (patch.pollSeconds !== undefined) await this.checkPoll(patch.pollSeconds);
    const now = new Date();
    const data: Prisma.MailTriggerUncheckedUpdateManyInput = {};
    if (patch.name !== undefined) data.name = patch.name;
    if (patch.match !== undefined) data.match = normalizeMatch(patch.match) as unknown as Prisma.InputJsonValue;
    if (inputs !== undefined) data.inputs = inputs ? (inputs as unknown as Prisma.InputJsonValue) : Prisma.DbNull;
    if (patch.afterStart !== undefined) data.afterStart = patch.afterStart;
    if (patch.pollSeconds !== undefined) data.pollSeconds = patch.pollSeconds;
    if (patch.maxRunsPerDay !== undefined) data.maxRunsPerDay = patch.maxRunsPerDay;
    if (patch.acceptUnverified !== undefined) data.acceptUnverified = patch.acceptUnverified;
    if (patch.enabled !== undefined) data.enabled = patch.enabled;
    // A different account is a different mailbox: its own start, with no cursor.
    if (patch.connectionId !== undefined && patch.connectionId !== t.connectionId) Object.assign(data, { connectionId: patch.connectionId, cursor: null, activeSince: now, nextPollAt: now, status: 'ok', statusReason: null, statusNotifiedAt: null, consecutiveErrors: 0 });
    // Enabling again never replays old mail: the window starts now.
    if (enabling) Object.assign(data, { activeSince: now, cursor: null, nextPollAt: now, status: 'ok', statusReason: null, statusNotifiedAt: null, consecutiveErrors: 0 });
    if (patch.pollSeconds !== undefined && !enabling && patch.connectionId === undefined) data.nextPollAt = nextPollAfter(t.lastCheckedAt ?? now, { id: t.id, pollSeconds: patch.pollSeconds });
    await this.prisma.mailTrigger.updateMany({ where: { id, userId }, data });
    await this.events.audit(userId, MAIL_TRIGGER_AUDIT.updated, id, { taskId: t.taskId, fields: Object.keys(patch) });
    return (await this.view(userId, [await this.trigger(userId, id)]))[0]!;
  }

  async remove(userId: string, id: string): Promise<void> {
    const t = await this.trigger(userId, id);
    await this.prisma.mailTrigger.deleteMany({ where: { id, userId } });
    await this.events.audit(userId, MAIL_TRIGGER_AUDIT.deleted, id, { taskId: t.taskId });
  }

  async eventsOf(userId: string, id: string, q: MailTriggerEventsQueryDto) {
    await this.trigger(userId, id);
    const before = q.before && !Number.isNaN(new Date(q.before).getTime()) ? new Date(q.before) : null;
    const rows = await this.db(userId).mailTriggerEvent.findMany({ where: { triggerId: id, ...(before ? { createdAt: { lt: before } } : {}) }, orderBy: { createdAt: 'desc' }, take: q.limit });
    return rows.map((e) => ({ id: e.id, outcome: e.outcome as 'started', reason: e.reason, runId: e.runId, messageAt: e.messageAt?.toISOString() ?? null, createdAt: e.createdAt.toISOString() }));
  }

  /**
   * The last {@link TEST_PREVIEW_COUNT} messages that match the rules, subjects cut to 60 characters, and whether each WOULD start a run.
   * Reads only; starts nothing and records nothing.
   */
  async test(userId: string, id: string): Promise<MailTriggerTestResult> {
    const t = await this.trigger(userId, id);
    const match = readMatch(t.match);
    if (!match) throw new BadRequestException({ code: 'MAIL_TRIGGER_NOT_FOUND', message: 'This trigger\'s rules are not valid: edit it' });
    const conn = await this.db(userId).connection.findFirst({ where: { id: t.connectionId } });
    if (!conn) throw new BadRequestException({ code: 'MAIL_TRIGGER_CONNECTION_INVALID', message: 'The account was removed', details: { reason: 'not_found' } });
    const mail = this.capabilities.mail({ connectionId: conn.id, userId });
    const epoch = new Date(0);
    try {
      const found = await mail.search({ ...toMailQuery(match, epoch.toISOString(), 50), after: undefined });
      const hits: MailSummary[] = found.items
        .filter((m) => matchMessage({ ...match, textContains: undefined } as MailMatch, m, { activeSince: epoch }).ok)
        .sort((a, b) => (b.date ?? '').localeCompare(a.date ?? ''))
        .slice(0, TEST_PREVIEW_COUNT);
      const messages: MailTriggerTestResult['messages'] = [];
      for (const m of hits) {
        let full: MailMessage | null = null;
        try {
          full = await mail.get(m.id, { body: match.textContains ? 'text' : 'none' });
        } catch (e) {
          if (!(isCapabilityError(e) && e.code === 'NOT_FOUND')) throw e;
        }
        if (!full) continue;
        if (!matchMessage(match, full, { activeSince: epoch, text: full.text }).ok) continue;
        const auth = full.senderAuth ?? 'unknown';
        const before = !m.date || new Date(m.date) < t.activeSince;
        const own = isOwnMessage(m, conn.accountEmail);
        const reason = before ? 'before_enabled' : own ? 'own_message' : auth === 'fail' ? 'sender_not_verified' : auth === 'unknown' && !t.acceptUnverified ? 'sender_not_checked' : null;
        messages.push({ date: m.date, subject: m.subject.slice(0, TEST_SUBJECT_CHARS), from: m.from?.address ?? null, wouldStart: reason === null, reason, senderVerified: auth });
      }
      return { messages, note: messages.length === 0 ? 'No recent message matches these rules.' : null };
    } catch (e) {
      if (e instanceof BadRequestException || e instanceof NotFoundException) throw e;
      const code = e instanceof CapabilityError ? e.code : 'PROVIDER_ERROR';
      throw new ConflictException({ code: 'MAIL_TRIGGER_CONNECTION_UNAVAILABLE', message: 'The mailbox could not be read', details: { reason: code } });
    }
  }

  /** Task views carry whether a task has triggers (`tasks_list` shows it). */
  async countsByTask(userId: string, taskIds: string[]): Promise<Map<string, number>> {
    if (taskIds.length === 0) return new Map();
    const g = await this.db(userId).mailTrigger.groupBy({ by: ['taskId'], where: { taskId: { in: taskIds } }, _count: { _all: true } });
    return new Map(g.map((r) => [r.taskId, r._count._all]));
  }
}
