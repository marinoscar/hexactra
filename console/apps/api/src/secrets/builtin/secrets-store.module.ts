// The built-in secrets store (E37.5, #594): the Vault domain packages embedded in the console.
//
// LOADED ONLY WHEN THE SLICE IS ON (`SECRETS_STORE_ENABLED=true`): app.module.ts reaches this file through
// `loadSecretsStoreModule()` (secrets-store.loader.ts), which `require`s it lazily, so with the slice off no
// `@marinoscar/vault-*` code is loaded (asserted by test/secrets-store.spec.ts).
//
// WHY NOT `VaultApiModule.forRoot`. It mounts every slice at once (media, backups, card scanning, card expiry, the
// MCP endpoint, the agent HTTP API) and offers no way to pick; its MCP controller serves `POST /api/mcp`, which is the
// console's own MCP endpoint (a duplicate route stops Fastify at boot), and its agent HTTP API would be one more way
// to read a value. The console needs three slices: `secrets`, `secret-types` and the in-process `agent` release rules.
// This module therefore provides the packages' own services (all exported from their subpaths) over the console's
// bindings of the ports they ask for, and mounts only the two controllers the web page needs. Filed upstream as a
// request for a slice selection on `forRoot` (docs/decisions/secrets-embedding.md).
//
// What is mounted: `/api/secrets` and `/api/secret-types` (Vault's controllers, restricted by the interceptor to the
// Credential type and without export, renewal or attachments), the console's `/api/secrets/store/status` and
// `/api/admin/secrets-store/rewrap`, and the internal release route the fabric calls. NOT mounted: media, backups,
// card scanning, card expiry, MCP, the agent HTTP API, the owner's card grant routes.
import { Module } from '@nestjs/common';
import { APP_INTERCEPTOR } from '@nestjs/core';
import { AgentCallPipeline, AgentCardsService, AgentCredentialsService, AgentIdentityService, AgentNotifier, AgentRateLimiter, AgentReleaseService, AGENT_RELEASE_PORT, CardGrantStore, InMemoryAgentRateLimiter, PrismaCardGrantStore } from '@marinoscar/vault-api/agent';
import { SecretTypesController, SecretTypesService } from '@marinoscar/vault-api/secret-types';
import { CardSummaryService, DocumentSummaryService, SecretsController, SecretsExportService, SecretsService } from '@marinoscar/vault-api/secrets';
import { VAULT_AUDIT, VAULT_CRYPTO, VAULT_NOTIFY, VAULT_OBJECT_STORE, VAULT_PRISMA, VAULT_SETTINGS } from '@marinoscar/vault-api/ports';

import { PrismaService } from '../../prisma/prisma.service';
import { SecretsModule } from '../secrets.module';
import { StoreCallbackController, StoreCallbackGuard } from './store.callback.controller';
import { SecretsStoreCallbackTokens } from './store.callback-tokens';
import { SecretsStoreCrypto } from './store.crypto';
import { SecretsStoreKeys, STORE_KEY_RING } from './store.data-keys';
import { StoreKeyCheck } from './store.doctor';
import { SecretsStoreController } from './store.controller';
import { SecretsStoreInterceptor } from './store.interceptor';
import { SecretsStoreMaintainHandler, SecretsStoreMaintainTask, SecretsStoreMaintenance } from './store.maintenance';
import { REFUSING_OBJECT_STORE, StoreAudit, StoreNotify, StoreSettings } from './store.ports';
import { BuiltinSecretsProvider } from './store.provider';
import { SecretsStoreRegistration } from './store.registration';
import { StoreKeyRing } from './store.keys';
import { SecretsStoreBootstrap } from './store.bootstrap';

@Module({
  imports: [SecretsModule],
  controllers: [SecretsController, SecretTypesController, SecretsStoreController, StoreCallbackController],
  providers: [
    // Keys and the envelope.
    { provide: STORE_KEY_RING, useFactory: () => StoreKeyRing.fromEnv() },
    SecretsStoreKeys,
    SecretsStoreCrypto,
    SecretsStoreCallbackTokens,
    // The ports of Vault's slices that are mounted.
    { provide: VAULT_PRISMA, useExisting: PrismaService },
    { provide: VAULT_CRYPTO, useExisting: SecretsStoreCrypto },
    { provide: VAULT_AUDIT, useClass: StoreAudit },
    { provide: VAULT_SETTINGS, useClass: StoreSettings },
    { provide: VAULT_NOTIFY, useClass: StoreNotify },
    { provide: VAULT_OBJECT_STORE, useValue: REFUSING_OBJECT_STORE },
    // Vault's services of the three mounted slices.
    SecretTypesService,
    SecretsService,
    SecretsExportService,
    CardSummaryService,
    // Vault 0.1.0-next.6's SecretsController needs it; its route (documents/summary) is refused by the interceptor.
    DocumentSummaryService,
    AgentCallPipeline,
    AgentCredentialsService,
    AgentCardsService,
    AgentIdentityService,
    AgentNotifier,
    AgentReleaseService,
    { provide: AGENT_RELEASE_PORT, useExisting: AgentReleaseService },
    { provide: CardGrantStore, useClass: PrismaCardGrantStore },
    // Single API instance today: in-process counters (the same default as Vault).
    { provide: AgentRateLimiter, useClass: InMemoryAgentRateLimiter },
    // The console's own parts.
    BuiltinSecretsProvider,
    StoreCallbackGuard,
    SecretsStoreInterceptor,
    { provide: APP_INTERCEPTOR, useExisting: SecretsStoreInterceptor },
    SecretsStoreRegistration,
    SecretsStoreMaintenance,
    SecretsStoreMaintainHandler,
    SecretsStoreMaintainTask,
    StoreKeyCheck,
    SecretsStoreBootstrap,
  ],
  exports: [BuiltinSecretsProvider, SecretsStoreKeys, AGENT_RELEASE_PORT],
})
export class SecretsStoreModule {}
