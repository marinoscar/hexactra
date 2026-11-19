// The poller of mail triggers (E39.8, #605): for every enabled trigger that is due, one search through the capability interfaces,
// the server's own re-check of every candidate, and one run per message that passes. Nothing here knows a provider: it asks
// `ConnectionCapabilities.mail(...)`.
//
// The guarantees (each has a test, test/mail-triggers.db.spec.ts):
//   * A message acts at most once per trigger: its id is inserted into `mail_trigger_events` (unique per trigger) BEFORE the run is
//     started, so a retry, a second job or a restart finds it and skips it. A crash between the two leaves the row `failed`, never a
//     second run.
//   * Old mail never fires: only messages that arrived after the trigger was created or last enabled count, and a gap (the console
//     down, the account paused) is caught up for at most a day.
//   * The cursor moves only after every candidate of the poll was recorded; a poll that fails midway repeats from the old cursor and
//     the event table makes the repeat harmless.
//   * A message from the connection's own address never starts a run (a run's own mail cannot re-trigger it), a message that fails
//     the provider's sender check starts nothing, and the per-trigger and per-user daily caps stop a flood.
//   * What is logged or recorded is ids, codes and counts: never a subject, an address, a snippet or a body.
import { Injectable, Logger } from '@nestjs/common';
import type { MailTrigger, Prisma } from '@prisma/client';

import { CapabilityError, isCapabilityError, type MailMessage, type MailSummary } from '../connections/capabilities';
import { ConnectionCapabilities } from '../connections/connection-capabilities.service';
import { PrismaService } from '../prisma/prisma.service';
import { TaskRunStarter } from '../questions/task-run-starter';
import { GOAL_RUN_REASONS } from '../runner/goal-run.enqueue';
import { MailTriggerEvents, MAIL_TRIGGER_AUDIT, type AttentionKind } from './mail-triggers.events';
import { mapInputs, needsBody, mailInputsSchema, type MailInputs } from './mail-inputs';
import { isOwnMessage, matchMessage, readMatch, toMailQuery, type MailMatch } from './mail-match';
import {
  CURSOR_PREFIX,
  FAILING_AFTER_ERRORS,
  MAX_CATCHUP_MS,
  MAX_POLL_PAGES,
  POLL_BATCH,
  POLL_OVERLAP_MS,
  RATE_LIMIT_BACKOFF_MS,
  type MailTriggerOutcome,
  type MailTriggerReason,
  type MailTriggerStatus,
} from './mail-triggers.constants';
import { MailTriggerLimitsService } from './mail-triggers.limits';

const utcDay = (d: Date): string => d.toISOString().slice(0, 10);
const startOfUtcDay = (d: Date): Date => new Date(`${utcDay(d)}T00:00:00.000Z`);

export const readCursor = (cursor: string | null | undefined): Date | null => {
  if (!cursor?.startsWith(CURSOR_PREFIX)) return null;
  const t = new Date(cursor.slice(CURSOR_PREFIX.length));
  return Number.isNaN(t.getTime()) ? null : t;
};
export const writeCursor = (d: Date): string => `${CURSOR_PREFIX}${d.toISOString()}`;

/** When a trigger is next due: its interval, plus a fixed offset per trigger so many triggers do not all poll in the same second. */
export function nextPollAfter(now: Date, trigger: Pick<MailTrigger, 'id' | 'pollSeconds'>, extraMs = 0): Date {
  const spread = Number.parseInt(trigger.id.slice(0, 6), 16) % Math.max(1, Math.min(30_000, trigger.pollSeconds * 500));
  return new Date(now.getTime() + trigger.pollSeconds * 1000 + spread + extraMs);
}

export interface PollSummary {
  polled: number;
  started: number;
  skipped: number;
  failed: number;
}

@Injectable()
export class MailTriggerPoller {
  private readonly log = new Logger(MailTriggerPoller.name);
  /** Tests replace the clock. */
  clock: () => Date = () => new Date();

  constructor(
    private readonly prisma: PrismaService,
    private readonly capabilities: ConnectionCapabilities,
    private readonly starter: TaskRunStarter,
    private readonly events: MailTriggerEvents,
    private readonly limits: MailTriggerLimitsService,
  ) {}

  /** How many enabled triggers are due (the cron's only question). */
  due(now = this.clock()): Promise<number> {
    return this.prisma.mailTrigger.count({ where: { enabled: true, OR: [{ nextPollAt: null }, { nextPollAt: { lte: now } }] } });
  }

  /** The `connections.mail-triggers.poll` job: poll every due trigger (at most {@link POLL_BATCH}). */
  async pollDue(now = this.clock()): Promise<PollSummary> {
    const due = await this.prisma.mailTrigger.findMany({
      where: { enabled: true, OR: [{ nextPollAt: null }, { nextPollAt: { lte: now } }] },
      orderBy: { nextPollAt: { sort: 'asc', nulls: 'first' } },
      take: POLL_BATCH,
    });
    const sum: PollSummary = { polled: 0, started: 0, skipped: 0, failed: 0 };
    for (const t of due) {
      // Claim the poll (compare-and-set on nextPollAt) before doing anything: a second job, or a retry, finds it taken.
      const claimed = await this.prisma.mailTrigger.updateMany({ where: { id: t.id, enabled: true, nextPollAt: t.nextPollAt }, data: { nextPollAt: nextPollAfter(now, t) } });
      if (claimed.count === 0) continue;
      try {
        const r = await this.pollOne(t, now);
        sum.polled += 1;
        sum.started += r.started;
        sum.skipped += r.skipped;
        sum.failed += r.failed;
      } catch (e) {
        // A bug in one trigger must not stop the others; the cursor did not move, so the next poll repeats it.
        this.log.warn(`mail trigger ${t.id}: the poll failed unexpectedly (${e instanceof Error ? e.name : 'error'})`);
        await this.fail(t, 'PROVIDER_ERROR', now);
      }
    }
    return sum;
  }

  /** One trigger's poll. Never throws for a provider failure: it is recorded on the trigger. */
  async pollOne(t: MailTrigger, now = this.clock()): Promise<{ started: number; skipped: number; failed: number }> {
    const result = { started: 0, skipped: 0, failed: 0 };
    const match = readMatch(t.match);
    const inputs = t.inputs ? mailInputsSchema.safeParse(t.inputs).data ?? null : null;
    const task = await this.prisma.task.findFirst({ where: { id: t.taskId, userId: t.userId } });
    if (!match || !task) {
      await this.setStatus(t, 'failing', 'INVALID_TRIGGER', now, { enabled: false });
      return result;
    }
    const conn = await this.prisma.connection.findFirst({ where: { id: t.connectionId, userId: t.userId } });
    if (!conn) {
      await this.setStatus(t, 'connection_removed', 'CONNECTION_NOT_FOUND', now, { enabled: false }, { kind: 'connection_removed', taskName: task.name });
      return result;
    }
    if (conn.status === 'needs_reconnect' || conn.status === 'revoked') {
      this.events.poll(conn.provider, 'needs_reconnect');
      await this.setStatus(t, 'needs_reconnect', conn.statusReason ?? 'CONNECTION_NEEDS_RECONNECT', now, {}, { kind: 'needs_reconnect', taskName: task.name }, 15 * 60_000);
      return result;
    }
    if (conn.status === 'paused') {
      await this.setStatus(t, 'connection_paused', 'CONNECTION_PAUSED', now, {}, { kind: 'connection_paused', taskName: task.name }, 5 * 60_000);
      return result;
    }

    const cursorAt = readCursor(t.cursor);
    const after = new Date(Math.max(t.activeSince.getTime(), now.getTime() - MAX_CATCHUP_MS, cursorAt ? cursorAt.getTime() - POLL_OVERLAP_MS : 0));
    const mail = this.capabilities.mail({ connectionId: conn.id, userId: t.userId });

    // 1. Candidates: the provider's search, read page by page.
    let candidates: MailSummary[] = [];
    try {
      let pageToken: string | undefined;
      for (let page = 0; page < MAX_POLL_PAGES; page++) {
        const res = await mail.search({ ...toMailQuery(match, after.toISOString()), ...(pageToken ? { pageToken } : {}) });
        candidates = candidates.concat(res.items);
        if (!res.nextPageToken) break;
        pageToken = res.nextPageToken;
      }
    } catch (e) {
      await this.pollFailed(t, task.name, conn.provider, e, now);
      return result;
    }
    this.events.poll(conn.provider, 'ok');

    // 2. The ones not seen before, oldest first.
    const seen = new Set((await this.prisma.mailTriggerEvent.findMany({ where: { triggerId: t.id, messageId: { in: candidates.map((c) => c.id) } }, select: { messageId: true } })).map((r) => r.messageId));
    const fresh = candidates.filter((c) => !seen.has(c.id)).sort((a, b) => (a.date ?? '').localeCompare(b.date ?? ''));

    // 3. Each one: re-check, then record, then start.
    let newest = cursorAt;
    try {
      for (const summary of fresh) {
        const outcome = await this.handle(t, task, conn, match, inputs, summary, mail, now);
        if (outcome === 'started') result.started += 1;
        else if (outcome === 'failed') result.failed += 1;
        else if (outcome) result.skipped += 1;
      }
    } catch (e) {
      // A provider failure while reading a message: the cursor stays, the event table makes the repeat harmless.
      await this.pollFailed(t, task.name, conn.provider, e, now);
      return result;
    }
    for (const c of candidates) {
      const d = c.date ? new Date(c.date) : null;
      if (d && (!newest || d > newest)) newest = d;
    }

    // 4. Only now does the cursor move.
    await this.prisma.mailTrigger.updateMany({
      where: { id: t.id },
      data: {
        ...(newest ? { cursor: writeCursor(newest) } : {}),
        lastCheckedAt: now,
        consecutiveErrors: 0,
        ...(t.status !== 'ok' ? { status: 'ok', statusReason: null, statusNotifiedAt: null } : {}),
      },
    });
    return result;
  }

  /** One candidate. Returns the outcome it was recorded with, or null when it did not match (nothing is recorded for those). */
  private async handle(
    t: MailTrigger,
    task: NonNullable<Awaited<ReturnType<PrismaService['task']['findFirst']>>>,
    conn: { id: string; accountEmail: string; capabilities: string[] },
    match: MailMatch,
    inputs: MailInputs | null,
    summary: MailSummary,
    mail: ReturnType<ConnectionCapabilities['mail']>,
    now: Date,
  ): Promise<MailTriggerOutcome | null> {
    // The summary's own headers first (cheap): sender, date, subject, attachment, label. A body match needs the body, so it waits.
    const { textContains, ...cheap } = match;
    if (!matchMessage(cheap as MailMatch, summary, { activeSince: t.activeSince }).ok) return null;
    const messageAt = summary.date ? new Date(summary.date) : null;
    this.events.matched();

    // A run's own mail, or the owner writing to themselves, never starts a run.
    if (isOwnMessage(summary, conn.accountEmail)) return this.record(t, summary.id, 'skipped_loop', 'OWN_MESSAGE', messageAt);

    // The message itself: sender authentication, and the text when the match or a capture needs it.
    let full: MailMessage;
    try {
      full = await mail.get(summary.id, { body: textContains || needsBody(inputs) ? 'text' : 'none' });
    } catch (e) {
      if (isCapabilityError(e) && e.code === 'NOT_FOUND') return null; // deleted between the search and the read
      throw e;
    }
    if (!matchMessage(match, full, { activeSince: t.activeSince, text: full.text }).ok) return null;
    if (full.senderAuth === 'fail') {
      this.events.skipped('unverified');
      const outcome = await this.record(t, summary.id, 'skipped_unverified', 'SENDER_NOT_VERIFIED', messageAt);
      await this.notifyDaily(t, 'unverifiedNotifiedOn', 'unverified', now, task.name);
      return outcome;
    }

    // The caps: this trigger's, then the owner's.
    const dayStart = startOfUtcDay(now);
    const limits = await this.limits.get();
    const mine = await this.prisma.mailTriggerEvent.count({ where: { triggerId: t.id, outcome: 'started', createdAt: { gte: dayStart } } });
    if (mine >= t.maxRunsPerDay) {
      this.events.skipped('limit');
      const outcome = await this.record(t, summary.id, 'skipped_limit', 'TRIGGER_DAILY_LIMIT', messageAt);
      await this.notifyDaily(t, 'limitNotifiedOn', 'limit', now, task.name);
      return outcome;
    }
    const all = await this.prisma.mailTriggerEvent.count({ where: { userId: t.userId, outcome: 'started', createdAt: { gte: dayStart } } });
    if (all >= limits.maxRunsPerUserPerDay) {
      this.events.skipped('limit');
      const outcome = await this.record(t, summary.id, 'skipped_limit', 'USER_DAILY_LIMIT', messageAt);
      await this.notifyDaily(t, 'limitNotifiedOn', 'limit', now, task.name);
      return outcome;
    }

    // Record first (the dedupe), start second. A row that is not updated afterwards stays `failed`: the message is never started twice.
    const eventId = await this.claim(t, summary.id, messageAt);
    if (!eventId) return null; // another job got it first
    try {
      const facts = { subject: full.subject, from: full.from?.address ?? null, date: full.date, text: full.text };
      const { run } = await this.starter.start({ id: t.userId, activeOrgId: null }, task, {
        presets: mapInputs(inputs, facts),
        presetSource: 'email',
        reason: GOAL_RUN_REASONS.mailTrigger.id,
        data: { trigger: 'email', origin: 'system', mailTriggerId: t.id, context: { mail: { connectionId: conn.id, messageId: summary.id } } as unknown as Prisma.InputJsonValue },
      });
      await this.prisma.mailTriggerEvent.updateMany({ where: { id: eventId }, data: { outcome: 'started', reason: null, runId: run.id } });
      await this.prisma.mailTrigger.updateMany({ where: { id: t.id }, data: { lastMatchedAt: now } });
      this.events.runStarted(messageAt ? (now.getTime() - messageAt.getTime()) / 1000 : null);
      await this.events.audit(t.userId, MAIL_TRIGGER_AUDIT.started, t.id, { taskId: t.taskId, runId: run.id });
      await this.afterStart(t, conn, summary.id, mail);
      return 'started';
    } catch (e) {
      this.log.warn(`mail trigger ${t.id}: its run could not be started (${e instanceof Error ? e.name : 'error'})`);
      return 'failed';
    }
  }

  /** The action after a run was queued, only when the connection may modify mail. A failure is logged and changes nothing. */
  private async afterStart(t: MailTrigger, conn: { id: string; capabilities: string[] }, messageId: string, mail: ReturnType<ConnectionCapabilities['mail']>): Promise<void> {
    if (t.afterStart === 'none' || !conn.capabilities.includes('mail_modify')) return;
    try {
      if (t.afterStart === 'mark_read') await mail.modify(messageId, { read: true });
      else if (t.afterStart.startsWith('add_label:')) await mail.modify(messageId, { addLabels: [t.afterStart.slice('add_label:'.length)] });
    } catch (e) {
      this.log.warn(`mail trigger ${t.id}: the after-start action did not apply (${isCapabilityError(e) ? e.code : 'error'})`);
    }
  }

  private async record(t: MailTrigger, messageId: string, outcome: MailTriggerOutcome, reason: MailTriggerReason, messageAt: Date | null): Promise<MailTriggerOutcome | null> {
    try {
      await this.prisma.mailTriggerEvent.create({ data: { triggerId: t.id, userId: t.userId, messageId, outcome, reason, messageAt } });
      return outcome;
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return null; // recorded meanwhile
      throw e;
    }
  }

  /** Inserts the dedupe row (`failed`/`START_FAILED` until the run exists); null when the message was already taken. */
  private async claim(t: MailTrigger, messageId: string, messageAt: Date | null): Promise<string | null> {
    try {
      return (await this.prisma.mailTriggerEvent.create({ data: { triggerId: t.id, userId: t.userId, messageId, outcome: 'failed', reason: 'START_FAILED', messageAt }, select: { id: true } })).id;
    } catch (e) {
      if ((e as { code?: string }).code === 'P2002') return null;
      throw e;
    }
  }

  /** Tells the owner at most once per UTC day for this cause. The claim is a compare-and-set, so two jobs send one notice. */
  private async notifyDaily(t: MailTrigger, column: 'unverifiedNotifiedOn' | 'limitNotifiedOn', kind: AttentionKind, now: Date, taskName: string): Promise<void> {
    const today = utcDay(now);
    const claimed = await this.prisma.mailTrigger.updateMany({ where: { id: t.id, OR: [{ [column]: null }, { [column]: { not: today } }] }, data: { [column]: today } });
    if (claimed.count === 1) await this.events.attention(t.userId, { kind, triggerId: t.id, taskId: t.taskId, taskName });
  }

  private async pollFailed(t: MailTrigger, taskName: string, provider: string, e: unknown, now: Date): Promise<void> {
    const code = isCapabilityError(e) ? e.code : 'PROVIDER_ERROR';
    if (code === 'RATE_LIMITED') {
      this.events.poll(provider, 'rate_limited');
      const wait = (e as CapabilityError).retryAfterMs ?? RATE_LIMIT_BACKOFF_MS;
      await this.prisma.mailTrigger.updateMany({ where: { id: t.id }, data: { status: 'rate_limited', statusReason: 'RATE_LIMITED', lastCheckedAt: now, nextPollAt: new Date(now.getTime() + Math.max(wait, RATE_LIMIT_BACKOFF_MS / 10)) } });
      return;
    }
    if (code === 'CONNECTION_NEEDS_RECONNECT') {
      this.events.poll(provider, 'needs_reconnect');
      await this.setStatus(t, 'needs_reconnect', code, now, {}, { kind: 'needs_reconnect', taskName }, 15 * 60_000);
      return;
    }
    if (code === 'CONNECTION_PAUSED') {
      await this.setStatus(t, 'connection_paused', code, now, {}, { kind: 'connection_paused', taskName }, 5 * 60_000);
      return;
    }
    if (code === 'CONNECTION_NOT_FOUND') {
      await this.setStatus(t, 'connection_removed', code, now, { enabled: false }, { kind: 'connection_removed', taskName });
      return;
    }
    this.events.poll(provider, 'error');
    await this.fail(t, code, now, taskName);
  }

  /** One failed poll: `failing` after {@link FAILING_AFTER_ERRORS} in a row, with one notice per episode. */
  private async fail(t: MailTrigger, code: string, now: Date, taskName?: string): Promise<void> {
    const errors = t.consecutiveErrors + 1;
    const failing = errors >= FAILING_AFTER_ERRORS;
    await this.prisma.mailTrigger.updateMany({ where: { id: t.id }, data: { consecutiveErrors: errors, lastCheckedAt: now, statusReason: code.slice(0, 60), ...(failing ? { status: 'failing' } : {}) } });
    if (failing && !t.statusNotifiedAt) {
      const claimed = await this.prisma.mailTrigger.updateMany({ where: { id: t.id, statusNotifiedAt: null }, data: { statusNotifiedAt: now } });
      const name = taskName ?? (await this.prisma.task.findFirst({ where: { id: t.taskId }, select: { name: true } }))?.name ?? '';
      if (claimed.count === 1) await this.events.attention(t.userId, { kind: 'failing', triggerId: t.id, taskId: t.taskId, taskName: name });
    }
  }

  /** A status that stops polling (or waits): recorded, the owner told once per episode, and the next look scheduled. */
  private async setStatus(
    t: MailTrigger,
    status: MailTriggerStatus,
    reason: string,
    now: Date,
    extra: { enabled?: boolean } = {},
    notify?: { kind: AttentionKind; taskName: string },
    retryAfterMs?: number,
  ): Promise<void> {
    const changed = t.status !== status;
    await this.prisma.mailTrigger.updateMany({
      where: { id: t.id },
      data: { status, statusReason: reason.slice(0, 60), lastCheckedAt: now, ...extra, ...(retryAfterMs ? { nextPollAt: new Date(now.getTime() + retryAfterMs) } : {}) },
    });
    if (changed) await this.events.audit(t.userId, MAIL_TRIGGER_AUDIT.statusChanged, t.id, { status, reason });
    if (notify) {
      const claimed = await this.prisma.mailTrigger.updateMany({ where: { id: t.id, statusNotifiedAt: null }, data: { statusNotifiedAt: now } });
      if (claimed.count === 1) await this.events.attention(t.userId, { kind: notify.kind, triggerId: t.id, taskId: t.taskId, taskName: notify.taskName });
    }
  }
}
