import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_PIPE } from '@nestjs/core';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { ScheduleModule } from '@nestjs/schedule';
import { ZodValidationPipe } from 'nestjs-zod';
import { RegistryFreezeService } from '@marinoscar/platform-api/core';

import configuration from './config/configuration';
import { BrowserModule } from './browser/browser.module';
import { FabricModule } from './fabric/fabric.module';
import { McpModule } from './mcp/mcp.module';
import { McpSecurityModule } from './mcp/mcp-security.module';
import { FleetModule } from './fleet/fleet.module';
import { HomeModule } from './home/home.module';
import { webhooksModule } from './platform/webhooks/webhooks.config';
import { HexactraAlertsModule } from './alerts/alerts.module';
import { alertsModule } from './platform/alerts/alerts.config';
import { alertsMounted } from './platform/alerts/alerts.enabled';
import { ChatModule } from './chat/chat.module';
import { ConnectedAppsModule } from './connected-apps/connected-apps.module';
import { QuestionsModule } from './questions/questions.module';
import { RunnerModule } from './runner/runner.module';
import { SchedulesModule } from './schedules/schedules.module';
import { PoliciesModule } from './policies/policies.module';
import { ApprovalsModule } from './approvals/approvals.module';
import { SecretsModule } from './secrets/secrets.module';
import { loadSecretsStoreModule, secretsStoreEnabled } from './secrets/builtin/secrets-store.loader';
import { TasksModule } from './tasks/tasks.module';
import { MemoriesModule } from './memories/memories.module';
import { NotesModule } from './notes/notes.module';
import { PLATFORM_MODULES } from './platform/platform';
import { isSliceEnabled } from './platform/slices/manifest';
import { PrismaModule } from './prisma/prisma.service';

/**
 * The root module: framework modules, the platform (src/platform/platform.ts)
 * and the app's own feature modules. Never edit platform behaviour here;
 * configure it through the slices' `forRoot()` options and host ports.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true, load: [configuration] }),
    ScheduleModule.forRoot(),
    EventEmitterModule.forRoot(),
    PrismaModule,
    ...PLATFORM_MODULES,
    // The app's features.
    NotesModule,
    FabricModule,
    FleetModule,
    PoliciesModule,
    // Memories (#551): the owner's saved facts.
    MemoriesModule,
    // Saved approvals (#554): rules the owner can see, narrow, pause and revoke.
    ApprovalsModule,
    // Secrets providers (E37.2): the owner's Vault, connected with OAuth. Needs the credential store and notifications.
    ...(isSliceEnabled('credentials') && isSliceEnabled('notifications') ? [SecretsModule] : []),
    // The built-in secrets store (E37.5): the Vault packages embedded, OFF by default. With SECRETS_STORE_ENABLED unset no
    // Vault package is loaded; with it on and no valid SECRETS_STORE_KEY the API refuses to start (one clear error).
    ...(secretsStoreEnabled() ? [loadSecretsStoreModule()] : []),
    // Connected AI apps (#464): the request's client context and the per-app limits (global).
    ConnectedAppsModule,
    TasksModule,
    QuestionsModule,
    BrowserModule,
    McpSecurityModule,
    McpModule,
    HomeModule,
    // The goal runner needs the AI slice (packages/shared/slices.json).
    ...(isSliceEnabled('ai') ? [RunnerModule, SchedulesModule] : []),
    // Chat (#482): a thread whose jobs are runs, so it needs the goal runner's slice too.
    ...(isSliceEnabled('ai') ? [ChatModule] : []),
    // Outbound webhooks need the credential store (signing secrets) and notifications.
    ...(isSliceEnabled('credentials') && isSliceEnabled('notifications') ? [webhooksModule] : []),
    // Alerts (Administration → Alerts): the platform slice plus the console's rule kinds.
    ...(alertsMounted() ? [alertsModule, HexactraAlertsModule] : []),
  ],
  providers: [
    { provide: APP_PIPE, useClass: ZodValidationPipe },
    // No APP_GUARD, APP_FILTER or APP_INTERCEPTOR here: the host core
    // (PlatformHostCoreModule) registers the maintenance guard (the only
    // global guard; a route without @Auth() is public), the exception filter
    // and the `{ data }` envelope.
    // Freezes every platform registry once the graph is built.
    RegistryFreezeService,
  ],
})
export class AppModule {}
