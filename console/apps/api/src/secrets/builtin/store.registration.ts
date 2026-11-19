// Registers the built-in store with the fabric (E37.5, #594): the fabric cannot call a store that has no address, so
// the console hands it a CALLBACK address and an owner-bound credential (store.callback-tokens.ts) instead of a Vault's
// base URL and token. Same port as the Vault registration (`FABRIC_SECRETS_REGISTRY`, kind `console`).
//
// Where the fabric calls back: `SECRETS_STORE_CALLBACK_URL` (deployment configuration: the address of THIS API as the
// fabric reaches it, `http://api:3000` on the bundled compose network, an https address across the Internet). It is
// not `APP_URL`: that is the public address, and the internal route is not served on the public side.
import { Inject, Injectable, Logger, type OnModuleInit } from '@nestjs/common';

import { FABRIC_SECRETS_REGISTRY, FabricSecretsUnavailable, type FabricSecretsRegistry } from '../fabric-secrets-registry';
import { SecretsProviderRegistrar, type BuiltinRegistration } from '../secrets-provider.registrar';
import { SecretsStoreCallbackTokens } from './store.callback-tokens';
import { STORE_CALLBACK_PATH } from './store.callback.controller';

export const DEFAULT_CALLBACK_BASE = 'http://api:3000';

/** The address the fabric calls back, without a trailing slash and without the route. */
export function callbackBase(env: Record<string, string | undefined> = process.env): string {
  return (env.SECRETS_STORE_CALLBACK_URL ?? '').trim().replace(/\/+$/, '') || DEFAULT_CALLBACK_BASE;
}

@Injectable()
export class SecretsStoreRegistration implements BuiltinRegistration, OnModuleInit {
  private readonly log = new Logger(SecretsStoreRegistration.name);

  constructor(
    private readonly tokens: SecretsStoreCallbackTokens,
    private readonly registrar: SecretsProviderRegistrar,
    @Inject(FABRIC_SECRETS_REGISTRY) private readonly fabric: FabricSecretsRegistry,
  ) {}

  onModuleInit(): void {
    this.registrar.attachBuiltin(this);
  }

  async register(userId: string): Promise<'registered' | 'unavailable'> {
    const { token, expiresAt } = await this.tokens.mint(userId);
    try {
      await this.fabric.registerSecretsProvider(userId, { kind: 'console', baseUrl: `${callbackBase()}/api/${STORE_CALLBACK_PATH}`, accessToken: token, expiresAt: expiresAt.toISOString() });
      return 'registered';
    } catch (e) {
      // The fabric did not take it: the credential is useless, do not leave it valid.
      await this.tokens.revokeFor(userId).catch(() => undefined);
      this.log.warn(`the fabric did not take the built-in store (${e instanceof FabricSecretsUnavailable ? e.reason : e instanceof Error ? e.name : 'error'})`);
      return 'unavailable';
    }
  }

  async revoke(userId: string): Promise<void> {
    await this.tokens.revokeFor(userId);
    await this.fabric.unregisterSecretsProvider(userId, 'console').catch(() => undefined);
  }
}
