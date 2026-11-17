// =============================================================================
// The AI slice's host ports, bound to this app
// =============================================================================
//
// `@marinoscar/platform-api/ai` injects these and never an app service:
//
//   AI_SYSTEM_PRISMA  the bypass client (retention purges, the deployment-wide
//                     usage report, the catalogue sync's organization-less row)
//   AI_OBJECT_STORE   object storage (`AiObjectStoreAdapter`, over the storage slice)
//   AI_METRICS        the `app.ai.*` instruments (`AppMetricsService`)
//   AI_TARGET_RESOLVER  which (provider, model) a call goes to (`BrowserAgentTargetResolver`, model tiers #403)
//
// Global, because every AI sub-module injects them.
// =============================================================================

import { Global, Module } from '@nestjs/common';
import { AI_METRICS, AI_OBJECT_STORE, AI_SYSTEM_PRISMA, AI_TARGET_RESOLVER } from '@marinoscar/platform-api/ai';
import { AppMetricsService } from '@marinoscar/platform-api/host';
import { StorageProvidersModule } from '@marinoscar/platform-api/storage';

import { PrismaSystemService } from '../../prisma/prisma-system.service';
import { AiObjectStoreAdapter } from './ai-object-store.adapter';
import { BrowserAgentTargetResolver } from './browser-agent-target.resolver';

const BINDINGS = [
  { provide: AI_SYSTEM_PRISMA, useExisting: PrismaSystemService },
  { provide: AI_OBJECT_STORE, useClass: AiObjectStoreAdapter },
  { provide: AI_METRICS, useExisting: AppMetricsService },
  { provide: AI_TARGET_RESOLVER, useClass: BrowserAgentTargetResolver },
];

@Global()
@Module({
  imports: [StorageProvidersModule],
  providers: BINDINGS,
  exports: BINDINGS.map((binding) => binding.provide),
})
export class AiHostModule {}
