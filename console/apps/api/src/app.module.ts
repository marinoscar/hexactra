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
import { TaskBuilderModule } from './task-builder/task-builder.module';
import { ConnectedAppsModule } from './connected-apps/connected-apps.module';
import { QuestionsModule } from './questions/questions.module';
import { RecordingsModule } from './recordings/recordings.module';
import { RunnerModule } from './runner/runner.module';
import { SchedulesModule } from './schedules/schedules.module';
import { PoliciesModule } from './policies/policies.module';
import { ApprovalsModule } from './approvals/approvals.module';
import { SecretsModule } from './secrets/secrets.module';
import { ConnectionsModule } from './connections/connections.module';
import { DiagnosticsModule } from './diagnostics/diagnostics.module';
import { ServiceCredentialsModule } from './service-credentials/service-credentials.module';
import { WebSearchModule } from './web-search/web-search.module';
import { GoogleConnectionsModule } from './connections/google/google.module';
import { DeliveriesModule } from './deliveries/deliveries.module';
import { MicrosoftConnectionsModule } from './connections/microsoft/microsoft.module';
import { MailTriggersModule } from './mail-triggers/mail-triggers.module';
import { loadSecretsStoreModule, secretsStoreMountable } from './secrets/builtin/secrets-store.loader';
import { TasksModule } from './tasks/tasks.module';
import { UsageModule } from './usage/usage.module';
import { KgraphModule } from './kgraph/kgraph.module';
import { KgraphLedgerModule } from './kgraph/ledger.module';
import { MemoriesModule } from './memories/memories.module';
import { SkillsModule } from './skills/skills.module';
import { NotesModule } from './notes/notes.module';
import { PLATFORM_MODULES } from './platform/platform';
import { isSliceEnabled } from './platform/slices/manifest';
import { PrismaModule } from './prisma/prisma.service';
// Last, so the MCP connection routes and schemas follow everything else in the generated OpenAPI document (E39.9).
import { McpConnectionsModule } from './connections/mcp/mcp.module';
// After everything else, so the benchmark routes (E44) follow the others in the generated OpenAPI document.
import { BenchmarkModule } from './benchmark/benchmark.module';

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
    // The Knowledge Graph (epic E46): learned procedures, off by default at every level.
    KgraphModule,
    KgraphLedgerModule,
    // Saved approvals (#554): rules the owner can see, narrow, pause and revoke.
    ApprovalsModule,
    // Secrets providers (E37.2): the owner's Vault, connected with OAuth. Needs the credential store and notifications.
    ...(isSliceEnabled('credentials') && isSliceEnabled('notifications') ? [SecretsModule] : []),
    // Diagnostics (E50.10): the report shape, the providers' registry and the history (global; the routes are the connections').
    DiagnosticsModule,
    // Connections (E39.2): the owner's Google and Microsoft accounts, several per service. Needs the credential store and notifications.
    ...(isSliceEnabled('credentials') && isSliceEnabled('notifications') ? [ConnectionsModule, GoogleConnectionsModule, MicrosoftConnectionsModule, MailTriggersModule] : []),
    // Service credentials (E50.2): the keys of outside services the console calls (a search provider), user, organization and deployment.
    ...(isSliceEnabled('credentials') ? [ServiceCredentialsModule] : []),
    // Web search (E50.5): the search providers, their tiered keys (service credentials), the limits and the usage.
    ...(isSliceEnabled('credentials') ? [WebSearchModule] : []),
    // The built-in secrets store (E37.5): the Vault packages embedded. Mounted when the deployment has a store key (the
    // installer generates SECRETS_STORE_KEY, #711); OFFERED only while the administrator's switch is on (Administration →
    // Secrets, `secrets.store.enabled`). A malformed key stops the API at boot with one clear error.
    ...(secretsStoreMountable() ? [loadSecretsStoreModule()] : []),
    // Connected AI apps (#464): the request's client context and the per-app limits (global).
    ConnectedAppsModule,
    TasksModule,
    UsageModule,
    QuestionsModule,
    RecordingsModule,
    BrowserModule,
    McpSecurityModule,
    McpModule,
    HomeModule,
    // The goal runner needs the AI slice (packages/shared/slices.json).
    ...(isSliceEnabled('ai') ? [RunnerModule, SchedulesModule] : []),
    // Chat (#482): a thread whose jobs are runs, so it needs the goal runner's slice too.
    ...(isSliceEnabled('ai') ? [ChatModule, TaskBuilderModule] : []),
    // Outbound webhooks need the credential store (signing secrets) and notifications.
    ...(isSliceEnabled('credentials') && isSliceEnabled('notifications') ? [webhooksModule] : []),
    // Alerts (Administration → Alerts): the platform slice plus the console's rule kinds.
    ...(alertsMounted() ? [alertsModule, HexactraAlertsModule] : []),
    // Deliveries after a run (E39.6): an email with the report, a signed webhook, a spreadsheet row, files in a folder. Mounted with Connections; last, so its routes follow the others in the OpenAPI document.
    ...(isSliceEnabled('credentials') && isSliceEnabled('notifications') ? [DeliveriesModule, McpConnectionsModule] : []),
    // Benchmarks (E44, #738): the same challenges under several agent policies, graded from the challenge site's state.
    BenchmarkModule,
    // Skills (#1008): the owner's playbooks for the agent. Last, so its routes follow the others in the OpenAPI document.
    SkillsModule,
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
