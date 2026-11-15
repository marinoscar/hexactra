// The alerts slice (`@marinoscar/platform-api/alerts`): rules, incidents and
// their notifications under `/api/admin/alerts` (Administration → Alerts),
// evaluated every minute. The console adds its own rule kinds (browser host
// offline, schedule failing, run budget exceeded: src/alerts/). Telemetry is
// not imported, so the platform's metric and verdict kinds report the store
// unavailable; its node kinds and the console's work without it.
//
// Mounted only with the notifications and email slices (alertsMounted()): an
// incident notifies the holders of `alerts:read`. The webhook port is bound
// when the webhooks slice is mounted too, so `alerts.alert.fired|resolved`
// reach the deployment's endpoints.
import { Module } from '@nestjs/common';
import { ALERTS_WEBHOOK_EMITTER, AlertsModule } from '@marinoscar/platform-api/alerts';

import { jobsModule } from '../platform';
import { isSliceEnabled } from '../slices/manifest';
import { webhooksModule } from '../webhooks/webhooks.config';
import { alertsMounted } from './alerts.enabled';
import { AlertsWebhookAdapter, registerAlertWebhookEvents } from './alerts-webhooks.adapter';
const webhooks = isSliceEnabled('credentials') && isSliceEnabled('notifications');

if (alertsMounted() && webhooks) registerAlertWebhookEvents();

/** Binds the alerts webhook port to `WebhooksService.emit`. */
@Module({
  imports: [webhooksModule],
  providers: [AlertsWebhookAdapter, { provide: ALERTS_WEBHOOK_EMITTER, useExisting: AlertsWebhookAdapter }],
  exports: [ALERTS_WEBHOOK_EMITTER],
})
export class AlertsWebhooksHostModule {}

export const alertsModule = AlertsModule.forRoot({ imports: [jobsModule, ...(webhooks ? [AlertsWebhooksHostModule] : [])] });
