// How the console hands the fabric a secrets provider for an owner (E37.1 #590 defines the fabric side; E37.2 #591
// the console side).
//
// THE REFRESH TOKEN NEVER GOES HERE. The fabric is given only what it needs to call the owner's Vault: its base URL
// and a short-lived ACCESS token with its expiry. It holds them in memory (never in its state database) and the
// console replaces the token before it expires while a run is live (`SecretsProviderRegistrar`).
//
// This is a port. `FabricSecretsRegistry` is implemented against the fabric's "secrets providers" resource (the
// `registerSecretsProvider(ownerId, { kind: 'vault', baseUrl, accessToken, expiresAt })` call E37.1 adds to the
// fabric client). Until that call exists on `main`, the module binds `UnwiredFabricSecretsRegistry`, which says so
// instead of pretending: TODO(#590, E37.1): bind `FABRIC_SECRETS_REGISTRY` to the real fabric client method.
import { Injectable } from '@nestjs/common';

/** What the fabric is told about a provider. `expiresAt` is ISO 8601. */
export interface SecretsProviderRegistration {
  kind: 'vault';
  /** The Vault's `APP_URL` (the fabric appends `/api/agent/v1`). */
  baseUrl: string;
  /** The `oat_` access token. Secret Material: memory only, never logged. */
  accessToken: string;
  expiresAt: string;
}

export interface FabricSecretsRegistry {
  /** Registers, or replaces the access token of, the owner's provider. */
  registerSecretsProvider(ownerId: string, registration: SecretsProviderRegistration): Promise<void>;
  /** Forgets the owner's provider (disconnect, a switch turned off, a grant that is gone). Idempotent. */
  unregisterSecretsProvider(ownerId: string, kind: SecretsProviderRegistration['kind']): Promise<void>;
}

/** Injection token of the fabric-side registry. */
export const FABRIC_SECRETS_REGISTRY = Symbol('FABRIC_SECRETS_REGISTRY');

/** The fabric could not be given the provider: not wired yet, not configured, or not answering. Never carries a token. */
export class FabricSecretsUnavailable extends Error {
  constructor(readonly reason: 'not_wired' | 'unreachable' | 'refused') {
    super(`The fabric cannot take a secrets provider (${reason}).`);
    this.name = 'FabricSecretsUnavailable';
  }
}

/** The binding until E37.1's fabric method lands: refuses honestly, so nothing reports a provider the fabric does not hold. */
@Injectable()
export class UnwiredFabricSecretsRegistry implements FabricSecretsRegistry {
  registerSecretsProvider(): Promise<void> {
    return Promise.reject(new FabricSecretsUnavailable('not_wired'));
  }

  unregisterSecretsProvider(): Promise<void> {
    return Promise.resolve();
  }
}

/** A registry that records what it was given, for tests (and for a dev run without a fabric). Holds tokens in memory only. */
@Injectable()
export class InMemoryFabricSecretsRegistry implements FabricSecretsRegistry {
  readonly registered = new Map<string, SecretsProviderRegistration>();
  /** Every call in order: `register` or `unregister` with the owner, never a token. */
  readonly calls: { op: 'register' | 'unregister'; ownerId: string }[] = [];

  registerSecretsProvider(ownerId: string, registration: SecretsProviderRegistration): Promise<void> {
    this.calls.push({ op: 'register', ownerId });
    this.registered.set(`${ownerId}:${registration.kind}`, { ...registration });
    return Promise.resolve();
  }

  unregisterSecretsProvider(ownerId: string, kind: SecretsProviderRegistration['kind']): Promise<void> {
    this.calls.push({ op: 'unregister', ownerId });
    this.registered.delete(`${ownerId}:${kind}`);
    return Promise.resolve();
  }
}
