import { Injectable, Module, type DynamicModule, type OnModuleDestroy, type OnModuleInit } from '@nestjs/common';
import { UserCredentialsModule } from '@marinoscar/platform-api/credentials';

import { ConnectionsModule } from '../connections/connections.module';
import { isSliceEnabled } from '../platform/slices/manifest';
import { TaskDeleteHooks } from '../tasks/task-delete-hooks';
import { TasksModule } from '../tasks/tasks.module';
import { DeliveryWebhookSecrets } from './deliveries.credentials';
import { DeliveriesService } from './deliveries.service';
import { DeliveryEvents } from './deliveries.events';
import { DeliveryRecipientsController, DeliveryUnsubscribeController, RunDeliveriesController, TaskDeliveriesController } from './deliveries.controller';
import { DeliveryConnectionUsage, DeliverySendHandler } from './deliveries.jobs';
import { DeliveryLimits } from './delivery-limits.service';
import { DeliveryMaterialCache } from './delivery-material.cache';
import { DeliveryPipeline } from './delivery-pipeline.service';
import { DeliveryRecipients } from './delivery-recipients.service';
import { EmailSender } from './senders/email.sender';
import { FolderSender } from './senders/folder.sender';
import { SheetRowSender } from './senders/sheet-row.sender';
import { WebhookSender } from './senders/webhook.sender';

/** Removes what lives outside the database rows when a task is deleted: its webhook deliveries' signing secrets. */
@Injectable()
class DeliveryTaskCleanup implements OnModuleInit, OnModuleDestroy {
  private unregister?: () => void;

  constructor(
    private readonly hooks: TaskDeleteHooks,
    private readonly deliveries: DeliveriesService,
  ) {}

  onModuleInit(): void {
    this.unregister = this.hooks.register((userId, taskId) => this.deliveries.removeSecretsOfTask(userId, taskId));
  }

  onModuleDestroy(): void {
    this.unregister?.();
  }
}

/** The slices a delivery kind needs, imported only where they are mounted: a kind whose slice is off fails its sends with `KIND_UNAVAILABLE`. */
function optionalSlices(): NonNullable<DynamicModule['imports']> {
  const out: NonNullable<DynamicModule['imports']> = [];
  if (isSliceEnabled('email')) out.push((require('../platform/email/email.config') as typeof import('../platform/email/email.config')).EmailModule);
  if (isSliceEnabled('credentials') && isSliceEnabled('notifications')) out.push((require('../platform/webhooks/webhooks.config') as typeof import('../platform/webhooks/webhooks.config')).webhooksModule);
  return out;
}

/**
 * Deliveries after a run (E39.6, #603): what a task sends when a run ends: an email with the masked PDF report, a signed webhook with the
 * run's fields, a spreadsheet row, files saved to a folder. A run-end hook writes the rows and queues the `deliveries.send` jobs; a job
 * sends each once. Mounted with Connections (the credential store and notifications slices, app.module.ts).
 */
@Module({
  imports: [TasksModule, ConnectionsModule, UserCredentialsModule, ...optionalSlices()],
  controllers: [TaskDeliveriesController, RunDeliveriesController, DeliveryRecipientsController, DeliveryUnsubscribeController],
  providers: [
    DeliveryEvents,
    DeliveryLimits,
    DeliveryRecipients,
    DeliveryWebhookSecrets,
    DeliveryMaterialCache,
    EmailSender,
    WebhookSender,
    SheetRowSender,
    FolderSender,
    DeliveryPipeline,
    DeliveriesService,
    DeliverySendHandler,
    DeliveryConnectionUsage,
    DeliveryTaskCleanup,
  ],
  exports: [DeliveryPipeline, DeliveriesService, DeliveryRecipients],
})
export class DeliveriesModule {}
