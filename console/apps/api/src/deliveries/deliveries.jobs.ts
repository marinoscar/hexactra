// `deliveries.send` (E39.6, #603): one attempt at one delivery of one run. A queue job, as every activity that outlives the run's end is:
// the run-end hook only writes the rows and enqueues. Server-only: it reads the run, calls a provider with the owner's token and may hold the
// run's files, so it implements neither `nodeResultSchema` nor `persistNodeResult` (no credential goes to a worker node).
//
// One attempt per job: the pipeline decides whether to try again (a retryable failure queues the next job with a delay, the row records the
// attempts), so the queue's own retry is off (`maxAttempts: 1`).
import { Injectable, Logger, type OnModuleInit } from '@nestjs/common';
import { JobHandlerRegistry, type Job, type JobHandler } from '@marinoscar/platform-api/jobs';

import { ConnectionUsageRegistry, type ConnectionUsage, type ConnectionUsageSource } from '../connections/connection-usage.registry';
import { PrismaService } from '../prisma/prisma.service';
import { DELIVERY_AUDIT, DELIVERY_JOB_MAX_RUNTIME_MS, DELIVERY_SEND_JOB } from './deliveries.constants';
import { DeliveryEvents } from './deliveries.events';
import { DeliveryPipeline } from './delivery-pipeline.service';
import type { DeliverySendPayload } from './delivery-send.enqueue';

@Injectable()
export class DeliverySendHandler implements JobHandler, OnModuleInit {
  readonly type = DELIVERY_SEND_JOB;
  readonly label = 'Send a delivery after a run';
  readonly profile = { maxRuntimeMs: DELIVERY_JOB_MAX_RUNTIME_MS, maxAttempts: 1 };
  private readonly log = new Logger(DeliverySendHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly pipeline: DeliveryPipeline,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    const p = job.payload as unknown as DeliverySendPayload;
    const outcome = await this.pipeline.attempt(p.runDeliveryId);
    this.log.log(`job ${job.id}: delivery ${p.runDeliveryId} ${outcome}`);
  }
}

/**
 * What the Disconnect dialog lists and clears (`ConnectionUsageRegistry`): the deliveries that use the connection. Clearing switches them
 * off (they cannot send without it) and marks them `connection_removed`; their configuration stays, so the owner sees what they were.
 */
@Injectable()
export class DeliveryConnectionUsage implements ConnectionUsageSource, OnModuleInit {
  readonly kind = 'delivery';

  constructor(
    private readonly registry: ConnectionUsageRegistry,
    private readonly prisma: PrismaService,
    private readonly events: DeliveryEvents,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async list(userId: string, connectionId: string): Promise<ConnectionUsage[]> {
    const rows = await this.prisma.taskDelivery.findMany({ where: { userId, connectionId }, select: { id: true, kind: true, task: { select: { name: true } } }, orderBy: { createdAt: 'asc' } });
    const label: Record<string, string> = { email: 'email', webhook: 'webhook', sheet_row: 'spreadsheet row', folder: 'folder' };
    return rows.map((r) => ({ kind: 'delivery', id: r.id, name: `${r.task.name}: ${label[r.kind] ?? r.kind} delivery` }));
  }

  async clear(userId: string, connectionId: string): Promise<void> {
    const rows = await this.prisma.taskDelivery.findMany({ where: { userId, connectionId }, select: { id: true, taskId: true, kind: true } });
    if (rows.length === 0) return;
    await this.prisma.taskDelivery.updateMany({ where: { userId, connectionId }, data: { enabled: false, disabledReason: 'connection_removed', connectionId: null } });
    for (const r of rows) await this.events.audit(userId, DELIVERY_AUDIT.cleared, r.id, { taskId: r.taskId, kind: r.kind });
  }
}
