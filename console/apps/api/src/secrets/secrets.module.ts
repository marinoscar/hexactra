import { Module } from '@nestjs/common';
import { CredentialsModule, UserCredentialsModule } from '@marinoscar/platform-api/credentials';

import { OAuthClientModule } from '../oauth-client';
import { FABRIC_SECRETS_REGISTRY, UnwiredFabricSecretsRegistry } from './fabric-secrets-registry';
import { SecretsPolicyService } from './secrets-policy.service';
import { SecretsProviderRegistrar } from './secrets-provider.registrar';
import { SecretsController } from './secrets.controller';
import { VaultConnectionsCheck, VaultEgressContributor } from './secrets.doctor';
import { SecretsEvents } from './secrets.events';
import { VaultKeepFresh, VaultKeepFreshHandler, VaultKeepFreshTask } from './secrets.jobs';
import { VaultApiClient } from './vault-api.client';
import { VaultClientConfigs } from './vault-client.config';
import { VaultConnectionService } from './vault-connection.service';
import { VaultDefaultClientService } from './vault-default-client.service';
import { VaultGrantStore } from './vault-grant.store';
import { VaultTokenService } from './vault-token.service';

/**
 * Secrets providers (E37.2, #591): the owner's Vault, connected with OAuth 2.1 + PKCE, its refresh token rotated
 * by the console, a short-lived access token handed to the fabric through `FABRIC_SECRETS_REGISTRY`, the two kill
 * switches (`secrets.agentUse.enabled`, the deployment's and the owner's), `GET /api/secrets/status` and a Doctor
 * line. Mounted only with the credentials and notifications slices (app.module.ts).
 *
 * `FABRIC_SECRETS_REGISTRY` is bound to `UnwiredFabricSecretsRegistry` until the fabric's secrets-provider resource
 * (E37.1, #590) exists on `main`: replace the `useClass` here with the adapter over the fabric client.
 */
@Module({
  imports: [CredentialsModule, UserCredentialsModule, OAuthClientModule],
  controllers: [SecretsController],
  providers: [
    { provide: FABRIC_SECRETS_REGISTRY, useClass: UnwiredFabricSecretsRegistry },
    SecretsPolicyService,
    SecretsEvents,
    VaultApiClient,
    VaultGrantStore,
    VaultClientConfigs,
    VaultTokenService,
    VaultConnectionService,
    VaultDefaultClientService,
    SecretsProviderRegistrar,
    VaultKeepFresh,
    VaultKeepFreshHandler,
    VaultKeepFreshTask,
    VaultConnectionsCheck,
    VaultEgressContributor,
  ],
  exports: [FABRIC_SECRETS_REGISTRY, SecretsPolicyService, SecretsProviderRegistrar, VaultConnectionService, VaultTokenService],
})
export class SecretsModule {}
