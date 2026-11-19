// The audit trail, the counters and the notification of mail triggers (E39.8, #605). Nothing recorded here carries a subject, an
// address, a snippet or a body: an audit event names the owner, the trigger and the task; a metric label is a bounded enum.
// `notify()` runs after the write that triggered it has committed.
import { Injectable, Logger, Optional } from '@nestjs/common';
import { AppMetricsService } from '@marinoscar/platform-api/host';
import { registerAppMetrics, type AppMetricDef } from '@marinoscar/platform-api/otel-core';
import { NotificationsService } from '@marinoscar/platform-api/notifications';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { MAIL_TRIGGER_ATTENTION_EVENT } from '../platform/notifications/hexactra.notifications';
import { CONNECTION_PROVIDER_IDS } from '../connections/connections.constants';

export const MAIL_TRIGGER_AUDIT = {
  created: 'mail_trigger.created',
  updated: 'mail_trigger.updated',
  deleted: 'mail_trigger.deleted',
  started: 'mail_trigger.run_started',
  statusChanged: 'mail_trigger.status_changed',
} as const;

export const ATTENTION_KINDS = ['needs_reconnect', 'failing', 'unverified', 'limit', 'connection_paused', 'connection_removed'] as const;
export type AttentionKind = (typeof ATTENTION_KINDS)[number];

export const POLL_RESULTS = ['ok', 'rate_limited', 'needs_reconnect', 'error'] as const;
export const SKIP_REASONS = ['limit', 'unverified', 'loop'] as const;

/** Names are permanent once dashboards read them. Labels are bounded enums: never a user, a trigger, an account or an address. */
export const MAIL_TRIGGER_METRICS: readonly AppMetricDef[] = [
  { key: 'mailTriggerPolls', name: 'app.mail_triggers.polls', kind: 'counter', unit: '{poll}', description: 'Mail trigger polls, by provider and result.', attributes: { provider: { kind: 'enum', values: CONNECTION_PROVIDER_IDS }, result: { kind: 'enum', values: POLL_RESULTS } } },
  { key: 'mailTriggerMatches', name: 'app.mail_triggers.matches', kind: 'counter', unit: '{message}', description: 'Messages that matched a mail trigger.' },
  { key: 'mailTriggerRuns', name: 'app.mail_triggers.runs_started', kind: 'counter', unit: '{run}', description: 'Runs an email started.' },
  { key: 'mailTriggerSkips', name: 'app.mail_triggers.skips', kind: 'counter', unit: '{message}', description: 'Matching messages that started nothing, by reason.', attributes: { reason: { kind: 'enum', values: SKIP_REASONS } } },
  {
    key: 'mailTriggerLag',
    name: 'app.mail_triggers.lag',
    kind: 'histogram',
    unit: 's',
    description: "Seconds from a message's arrival to the start of the run it caused.",
    buckets: [15, 30, 60, 120, 300, 600, 1800, 3600],
  },
];
registerAppMetrics(MAIL_TRIGGER_METRICS);

@Injectable()
export class MailTriggerEvents {
  private readonly log = new Logger(MailTriggerEvents.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly metrics?: AppMetricsService,
  ) {}

  /** One audit event. A failure to record it never fails the operation. */
  async audit(userId: string | null, action: string, triggerId: string, meta: Record<string, unknown>): Promise<void> {
    try {
      await this.prisma.auditEvent.create({ data: { actorUserId: userId, action, targetType: 'mail_trigger', targetId: triggerId, orgId: null, meta: meta as Prisma.InputJsonValue } });
    } catch (e) {
      this.log.warn(`mail triggers: the audit record ${action} could not be written: ${e instanceof Error ? e.name : 'error'}`);
    }
  }

  poll(provider: string, result: (typeof POLL_RESULTS)[number]): void {
    if ((CONNECTION_PROVIDER_IDS as readonly string[]).includes(provider)) this.metrics?.add('mailTriggerPolls', 1, { provider, result });
  }
  matched(): void {
    this.metrics?.add('mailTriggerMatches', 1);
  }
  runStarted(lagSeconds: number | null): void {
    this.metrics?.add('mailTriggerRuns', 1);
    if (lagSeconds !== null && lagSeconds >= 0) this.metrics?.record('mailTriggerLag', lagSeconds);
  }
  skipped(reason: (typeof SKIP_REASONS)[number]): void {
    this.metrics?.add('mailTriggerSkips', 1, { reason });
  }

  /** Tells the owner a trigger needs attention. The caller decides "once" (the `*NotifiedAt/On` columns). */
  async attention(userId: string, data: { kind: AttentionKind; triggerId: string; taskId: string; taskName: string }): Promise<void> {
    if (!this.notifications) return;
    try {
      await this.notifications.notify(MAIL_TRIGGER_ATTENTION_EVENT, userId, data);
    } catch (e) {
      this.log.warn(`notify ${MAIL_TRIGGER_ATTENTION_EVENT} failed: ${e instanceof Error ? e.name : 'error'}`);
    }
  }
}
