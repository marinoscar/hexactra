// The app's binding of the webhooks slice's host port: the bypass client for
// system-scope endpoints and the cross-organization delivery purge.
import { Module } from '@nestjs/common';
import { WEBHOOKS_SYSTEM_PRISMA } from '@marinoscar/platform-api/webhooks';

import { PrismaSystemService } from '../../prisma/prisma-system.service';

@Module({
  providers: [{ provide: WEBHOOKS_SYSTEM_PRISMA, useExisting: PrismaSystemService }],
  exports: [WEBHOOKS_SYSTEM_PRISMA],
})
export class WebhooksHostModule {}
