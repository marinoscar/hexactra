// The audit trail, the counters and the notification of deliveries (E39.6, #603). An audit event names the owner, a delivery or run id,
// the kind and a count: never an address list, a subject, a body, a cell or a file name. `notify()` runs after the write that triggered
// it has committed. Counters are bounded enums: never a user, a task, a connection or a destination.
import { Injectable, Logger, Optional } from '@nestjs/common';
import { AppMetricsService } from '@marinoscar/platform-api/host';
import { registerAppMetrics, type AppMetricDef } from '@marinoscar/platform-api/otel-core';
import { NotificationsService } from '@marinoscar/platform-api/notifications';
import type { Prisma } from '@prisma/client';

import { DELIVERY_FAILED_EVENT } from '../platform/notifications/hexactra.notifications';
import { PrismaService } from '../prisma/prisma.service';
import { DELIVERY_ERROR_TEXT, DELIVERY_KINDS, RUN_DELIVERY_STATUSES, type DeliveryErrorCode, type DeliveryKind } from './deliveries.constants';

/** Names are permanent once dashboards read them. */
export const DELIVERY_METRICS: readonly AppMetricDef[] = [
  {
    key: 'deliveries',
    name: 'app.deliveries',
    kind: 'counter',
    unit: '{delivery}',
    description: 'Deliveries after a run, by kind and how an attempt ended (sent, failed, skipped, retry).',
    attributes: { kind: { kind: 'enum', values: DELIVERY_KINDS }, status: { kind: 'enum', values: [...RUN_DELIVERY_STATUSES, 'retry', 'test'] } },
  },
  {
    key: 'deliveryDuration',
    name: 'app.deliveries.duration',
    kind: 'histogram',
    unit: 's',
    description: 'How long one delivery attempt took, by kind.',
    buckets: [0.1, 0.5, 1, 2, 5, 10, 30, 60, 120],
    attributes: { kind: { kind: 'enum', values: DELIVERY_KINDS } },
  },
];
registerAppMetrics(DELIVERY_METRICS);

export type DeliveryOutcome = (typeof RUN_DELIVERY_STATUSES)[number] | 'retry' | 'test';

/** The sentence a notification carries for a failed delivery: the kind and the reason, nothing from the run. */
export function failureLine(kind: DeliveryKind, code: DeliveryErrorCode): string {
  const what = kind === 'sheet_row' ? 'add the row' : kind === 'folder' ? 'save the file' : kind === 'email' ? 'send the email' : 'call the webhook';
  const why = DELIVERY_ERROR_TEXT[code];
  return `Could not ${what}: ${why}.`;
}

@Injectable()
export class DeliveryEvents {
  private readonly log = new Logger(DeliveryEvents.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly metrics?: AppMetricsService,
  ) {}

  /** One audit event. A failure to record it never fails the operation. */
  async audit(userId: string | null, action: string, targetId: string, meta: Record<string, unknown>, targetType = 'delivery'): Promise<void> {
    try {
      await this.prisma.auditEvent.create({ data: { actorUserId: userId, action, targetType, targetId, orgId: null, meta: meta as Prisma.InputJsonValue } });
    } catch (e) {
      this.log.warn(`deliveries: the audit record ${action} could not be written (${e instanceof Error ? e.name : 'error'})`);
    }
  }

  count(kind: DeliveryKind, status: DeliveryOutcome): void {
    this.metrics?.add('deliveries', 1, { kind, status });
  }

  duration(kind: DeliveryKind, ms: number): void {
    if (Number.isFinite(ms) && ms >= 0) this.metrics?.record('deliveryDuration', ms / 1000, { kind });
  }

  /** Tells the owner a delivery failed for good. The caller decides "once per task per day". */
  async failed(userId: string, data: { taskId: string | null; runId: string; kind: DeliveryKind; code: DeliveryErrorCode }): Promise<void> {
    if (!this.notifications) return;
    try {
      await this.notifications.notify(DELIVERY_FAILED_EVENT, userId, { taskId: data.taskId, runId: data.runId, kind: data.kind, code: data.code, line: failureLine(data.kind, data.code) });
    } catch (e) {
      this.log.warn(`notify ${DELIVERY_FAILED_EVENT} failed (${e instanceof Error ? e.name : 'error'})`);
    }
  }
}
