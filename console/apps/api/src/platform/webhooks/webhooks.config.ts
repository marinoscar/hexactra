// Outbound webhooks (`@marinoscar/platform-api/webhooks`): signed deliveries
// of the console's events (runs.*, schedules.*) and every notification
// (`notification.<key>`) to endpoints people register at Settings →
// Webhooks or Administration → Webhooks. Mounted only with the credentials
// and notifications slices (app.module.ts).
import { WebhooksModule } from '@marinoscar/platform-api/webhooks';
import { APP_NAME } from '@app/shared';

import { registerHexactraWebhookEvents } from './hexactra.webhook-events';
import { WebhooksHostModule } from './webhooks-host.module';

registerHexactraWebhookEvents();

export const webhooksModule = WebhooksModule.forRoot({ appName: APP_NAME, imports: [WebhooksHostModule] });
