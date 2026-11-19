// The fabric side of `FABRIC_SECRETS_REGISTRY` (E37.1 #590 defined the resource, E37.2 #591 the port): the owner's
// provider is registered with `PUT /v1/secrets-providers/{owner}/{provider}` through the fabric client, and forgotten
// with `DELETE`. The access token goes to the fabric's memory only and never comes back.
import { Injectable } from '@nestjs/common';

import { FabricClient, FabricError } from '../fabric/fabric.client';
import { FabricSession } from '../runner/fabric-session';
import { FabricSecretsUnavailable, type FabricSecretsRegistry, type SecretsProviderRegistration } from './fabric-secrets-registry';

@Injectable()
export class FabricClientSecretsRegistry implements FabricSecretsRegistry {
  constructor(private readonly fabric: FabricClient) {}

  async registerSecretsProvider(ownerId: string, registration: SecretsProviderRegistration): Promise<void> {
    const expires = new Date(registration.expiresAt);
    try {
      await new FabricSession(this.fabric).registerSecretsProvider(ownerId, {
        provider: registration.kind,
        kind: registration.kind,
        baseUrl: registration.baseUrl,
        accessToken: registration.accessToken,
        ...(Number.isNaN(expires.getTime()) ? {} : { expiresAt: expires }),
      });
    } catch (e) {
      // 501 `provider_kind_unsupported`: this fabric does not implement the kind yet. Never carries the token.
      throw new FabricSecretsUnavailable(e instanceof FabricError && e.status !== undefined && e.status >= 400 && e.status < 500 ? 'refused' : 'unreachable');
    }
  }

  async unregisterSecretsProvider(ownerId: string, kind: SecretsProviderRegistration['kind']): Promise<void> {
    try {
      await new FabricSession(this.fabric).unregisterSecretsProvider(ownerId, kind);
    } catch (e) {
      // Already gone is gone.
      if (e instanceof FabricError && e.status === 404) return;
      throw e;
    }
  }
}
