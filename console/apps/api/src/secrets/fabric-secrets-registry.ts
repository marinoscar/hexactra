// How the console hands the fabric a secrets provider for an owner (E37.1 #590 defines the fabric side; E37.2 #591
// the console side).
//
// THE REFRESH TOKEN NEVER GOES HERE. The fabric is given only what it needs to call the owner's Vault: its base URL
// and a short-lived ACCESS token with its expiry. It holds them in memory (never in its state database) and the
// console replaces the token before it expires while a run is live (`SecretsProviderRegistrar`).
//
// `FabricSecretsRegistry` is the port; `FabricSessionSecretsRegistry` implements it over the fabric's "secrets
// providers" resource (`FabricSession.registerSecretsProvider`, `PUT /v1/secrets-providers/{owner}/{provider}`).
import { Injectable } from '@nestjs/common';

import { FabricClient, FabricError } from '../fabric/fabric.client';
import { FabricSession } from '../runner/fabric-session';

/** What the fabric is told about a provider. `expiresAt` is ISO 8601. */
export interface SecretsProviderRegistration {
  /** `vault`: the fabric calls the owner's Vault itself. `console`: the built-in store (E37.5): the fabric calls back into the console. */
  kind: 'vault' | 'console';
  /** `vault`: the Vault's `APP_URL` (the fabric appends `/api/agent/v1`). `console`: the console's internal address the fabric calls back (`/api/internal/secrets-store/v1`). */
  baseUrl: string;
  /** `vault`: the `oat_` access token. `console`: the owner's `sct_` callback credential. Secret Material: memory only, never logged. */
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

/** The id actions name for a registration kind. */
export const providerIdOf = (kind: SecretsProviderRegistration['kind']): string => (kind === 'console' ? 'builtin' : kind);

/** The fabric could not be given the provider: no fabric connection is configured, it is not answering, or it refused. Never carries a token. */
export class FabricSecretsUnavailable extends Error {
  constructor(readonly reason: 'not_wired' | 'unreachable' | 'refused') {
    super(`The fabric cannot take a secrets provider (${reason}).`);
    this.name = 'FabricSecretsUnavailable';
  }
}

/**
 * The real binding: registers and removes the owner's Vault through the fabric's secrets-provider resource. The
 * token travels in the request body of the `PUT` only; every failure is turned into a {@link FabricSecretsUnavailable}
 * that carries a reason and nothing else (the original error is dropped, so no token or URL can ride along).
 */
@Injectable()
export class FabricSessionSecretsRegistry implements FabricSecretsRegistry {
  private readonly session: FabricSession;

  constructor(fabric: FabricClient) {
    this.session = new FabricSession(fabric);
  }

  async registerSecretsProvider(ownerId: string, registration: SecretsProviderRegistration): Promise<void> {
    const expiresAt = new Date(registration.expiresAt);
    if (Number.isNaN(expiresAt.getTime())) throw new FabricSecretsUnavailable('refused');
    try {
      // The provider id actions name: `vault`, or `builtin` for the built-in store (kind `console`).
      await this.session.registerSecretsProvider(ownerId, {
        provider: providerIdOf(registration.kind),
        kind: registration.kind,
        baseUrl: registration.baseUrl,
        accessToken: registration.accessToken,
        expiresAt,
      });
    } catch (e) {
      throw unavailableOf(e);
    }
  }

  async unregisterSecretsProvider(ownerId: string, kind: SecretsProviderRegistration['kind']): Promise<void> {
    try {
      await this.session.unregisterSecretsProvider(ownerId, providerIdOf(kind));
    } catch (e) {
      throw unavailableOf(e);
    }
  }
}

/** Why the fabric did not take the call: no fabric connection, not reachable, or it refused (a 4xx or 5xx, `501 provider_kind_unsupported` among them). */
function unavailableOf(e: unknown): FabricSecretsUnavailable {
  if (e instanceof FabricError) {
    if (e.kind === 'not_configured') return new FabricSecretsUnavailable('not_wired');
    if (e.kind === 'unreachable') return new FabricSecretsUnavailable('unreachable');
  }
  return new FabricSecretsUnavailable('refused');
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
