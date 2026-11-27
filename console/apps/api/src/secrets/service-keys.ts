// Keys of outside services in the owner's secrets provider (E50.3, #973; decision record `docs/decisions/web-search.md` §3).
//
// The secrets side of the second binding of the service credentials port: the owner's own key of a service the console calls (a
// search provider), kept in their Vault or in the built-in store next to their saved logins, by the owner's choice. A value goes
// to the CONSOLE'S OWN SERVER PROCESS only, for the call to that service; the fabric, a tool or a model never asks for one (kind
// `api_key` is not an `ItemKind`).
//
//   remote Vault   `GET /api/agent/v1/service-keys/{service}/{name}` with the owner's grant (scope `vault:service_keys_read`, asked
//                  for when the owner connects with "keys of outside services" on). Vault audits (`agent.service_key.read`),
//                  limits (120 a minute per owner and service) and applies its own switch and per-item opt-in. Read-only: the
//                  console cannot write or remove a key in the owner's Vault; the owner does that in Vault.
//   built-in store Vault's in-process `ServiceKeyReleasePort`, attached by the store's module when it is mounted. The console
//                  writes the item when the owner moves a key here.
//
// The deployment's `secrets.agentUse.enabled` off stops every release (the kill switch); the port then falls back to the next
// tier. Every release and refusal is one Activity row (event `service_key`, outcome `ok` or the refusal code): the reference,
// the provider and the run, never the value.
import { randomUUID } from 'node:crypto';
import { Injectable, Logger, Optional } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { SecretsPolicyService } from './secrets-policy.service';
import { SecretBytes, SecretsProviderError } from './secrets-provider.port';
import type { SecretsProviderId } from './secrets.settings';
import { VaultApiClient } from './vault-api.client';
import { hasServiceKeyScope } from './vault-contract';
import { VaultAccessError, VaultTokenService } from './vault-token.service';

/** The Activity event of a service key release (the column holds at most 16 characters). */
export const SERVICE_KEY_ACTIVITY_EVENT = 'service_key';
/** The audit name of a release, as the decision record calls it: an Activity row of event `service_key` with outcome `ok`. */
export const SERVICE_KEY_RELEASED = 'service_key_released';

/** The built-in store's side, attached by its module (absent while the store is not mounted). */
export interface BuiltinServiceKeyStore {
  releaseServiceKey(req: { ownerId: string; service: string; name: string; purpose: 'service_call'; runId?: string }): Promise<SecretBytes>;
  describeServiceKey(ownerId: string, service: string, name: string): Promise<Date | null>;
  saveServiceKey(ownerId: string, service: string, name: string, label: string, value: Buffer): Promise<void>;
  removeServiceKey(ownerId: string, service: string, name: string): Promise<void>;
}

export interface ServiceKeyRef {
  service: string;
  name: string;
}

/**
 * Why no value came back. `disabled`: a kill switch is off (the deployment's, Vault's, or the store is not offered). `unavailable`:
 * the provider could not answer (unreachable, rate limited, an error). The rest need the owner.
 */
export type ServiceKeyMiss = 'disabled' | 'not_found' | 'not_connected' | 'needs_reconnect' | 'needs_scope' | 'ambiguous' | 'unavailable';

export type ServiceKeyRelease = { ok: true; provider: SecretsProviderId; value: SecretBytes } | { ok: false; provider: SecretsProviderId; reason: ServiceKeyMiss };

/** Where a provider's key is and whether the console can say when it was set. */
export interface ServiceKeyDescription {
  provider: SecretsProviderId;
  /** When it was written (built-in store), or null: none, or the provider does not say (a remote Vault has no listing route). */
  setAt: Date | null;
  /** The console can write and remove a key there (the built-in store); a remote Vault is the owner's to change. */
  writable: boolean;
}

/** The Activity outcome of a miss (a closed code of `ACTIVITY_OUTCOMES`). */
const OUTCOME: Record<ServiceKeyMiss, string> = {
  disabled: 'disabled',
  not_found: 'not_found',
  not_connected: 'no_provider',
  needs_reconnect: 'unauthorized',
  needs_scope: 'unauthorized',
  ambiguous: 'refused',
  unavailable: 'unavailable',
};

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

@Injectable()
export class SecretsServiceKeys {
  private readonly log = new Logger('SecretsServiceKeys');
  private builtin: BuiltinServiceKeyStore | null = null;

  constructor(
    private readonly policy: SecretsPolicyService,
    private readonly prisma: PrismaService,
    @Optional() private readonly tokens?: VaultTokenService,
    @Optional() private readonly api?: VaultApiClient,
  ) {}

  /** Called once by the built-in store's module. */
  attachBuiltin(store: BuiltinServiceKeyStore): void {
    this.builtin = store;
  }

  /** The owner's active provider: where their keys of outside services are when they chose "in my secrets provider". */
  activeProvider(userId: string): Promise<SecretsProviderId> {
    return this.policy.activeProvider(userId);
  }

  /** Whether the deployment's kill switch lets any service key be released. */
  async releasesEnabled(): Promise<boolean> {
    return (await this.policy.system()).agentUse.enabled;
  }

  /** SERVER-SIDE ONLY: the owner's key `ref` from their active provider. Never throws for a provider's failure. */
  async release(userId: string, ref: ServiceKeyRef, ctx: { runId?: string; tier?: string } = {}): Promise<ServiceKeyRelease> {
    const provider = await this.policy.activeProvider(userId);
    const r = await this.releaseFrom(provider, userId, ref, ctx.runId);
    await this.record(userId, provider, ref, r.ok ? 'ok' : OUTCOME[r.reason], r.ok, ctx.runId);
    return r;
  }

  private async releaseFrom(provider: SecretsProviderId, userId: string, ref: ServiceKeyRef, runId?: string): Promise<ServiceKeyRelease> {
    const miss = (reason: ServiceKeyMiss): ServiceKeyRelease => ({ ok: false, provider, reason });
    if (!(await this.releasesEnabled())) return miss('disabled');
    if (provider === 'builtin') {
      if (!this.builtin) return miss('disabled');
      try {
        return { ok: true, provider, value: await this.builtin.releaseServiceKey({ ownerId: userId, service: ref.service, name: ref.name, purpose: 'service_call', ...(runId ? { runId } : {}) }) };
      } catch (e) {
        const code = e instanceof SecretsProviderError ? e.code : 'unavailable';
        if (code === 'not_found') return miss('not_found');
        if (code === 'disabled') return miss('disabled');
        if (code === 'refused') return miss('ambiguous');
        return miss('unavailable');
      }
    }
    if (!this.tokens || !this.api) return miss('not_connected');
    let access;
    try {
      access = await this.tokens.getAccess(userId);
    } catch (e) {
      if (e instanceof VaultAccessError) return miss(e.kind === 'not_connected' ? 'not_connected' : e.kind === 'needs_reconnect' ? 'needs_reconnect' : 'unavailable');
      this.log.warn(`service key: the Vault token could not be had (${e instanceof Error ? e.name : 'error'})`);
      return miss('unavailable');
    }
    const allowedHosts = (await this.policy.system()).vault.allowedHosts;
    const r = await this.api.serviceKey(access.baseUrl, access.accessToken, ref.service, ref.name, allowedHosts);
    switch (r.status) {
      case 'ok':
        return { ok: true, provider, value: r.value };
      case 'not_found':
        return miss('not_found');
      case 'agent_access_disabled':
        return miss('disabled');
      case 'unauthorized':
        // The grant is gone: exactly as a refused refresh (the connection needs the owner, once).
        await this.tokens.markNeedsReconnect(userId, 'UNAUTHORIZED').catch(() => false);
        return miss('needs_reconnect');
      case 'needs_scope':
        return miss('needs_scope');
      case 'ambiguous':
        return miss('ambiguous');
      default:
        if (r.status === 'unavailable') this.log.warn(`service key: the Vault did not answer (${r.code})`);
        return miss('unavailable');
    }
  }

  /** Where the owner's key `ref` is in their active provider. Never releases a value. */
  async describe(userId: string, ref: ServiceKeyRef): Promise<ServiceKeyDescription> {
    const provider = await this.policy.activeProvider(userId);
    if (provider === 'builtin') {
      const setAt = this.builtin ? await this.builtin.describeServiceKey(userId, ref.service, ref.name).catch(() => null) : null;
      return { provider, setAt, writable: this.builtin !== null };
    }
    return { provider, setAt: null, writable: false };
  }

  /** Whether the built-in store is mounted and offered (`secrets.store.enabled`). */
  async builtinWritable(): Promise<boolean> {
    return this.builtin !== null && (await this.policy.storeEnabled());
  }

  /** Whether the owner's Vault grant holds the scope a service key needs (a remote Vault only; the built-in store needs none). */
  async vaultHasScope(userId: string): Promise<boolean> {
    const row = await this.prisma.secretsConnection.findUnique({ where: { userId_provider: { userId, provider: 'vault' } }, select: { scopes: true, status: true } });
    return !!row && row.status === 'connected' && hasServiceKeyScope(row.scopes ?? []);
  }

  /** Writes the owner's key into the built-in store. A remote Vault is the owner's to change: `read_only`. The caller wipes `value`. */
  async save(userId: string, ref: ServiceKeyRef, label: string, value: SecretBytes): Promise<'saved' | 'read_only' | 'disabled' | 'unavailable'> {
    const provider = await this.policy.activeProvider(userId);
    if (provider !== 'builtin') return 'read_only';
    if (!this.builtin) return 'disabled';
    try {
      await value.expose((b) => this.builtin!.saveServiceKey(userId, ref.service, ref.name, label, b));
      return 'saved';
    } catch (e) {
      if (e instanceof SecretsProviderError && e.code === 'disabled') return 'disabled';
      this.log.warn(`service key: the built-in store could not save it (${e instanceof SecretsProviderError ? e.code : e instanceof Error ? e.name : 'error'})`);
      return 'unavailable';
    }
  }

  /** Removes the owner's key from the built-in store (`read_only` for a remote Vault). Idempotent. */
  async remove(userId: string, ref: ServiceKeyRef): Promise<'removed' | 'read_only' | 'disabled' | 'unavailable'> {
    const provider = await this.policy.activeProvider(userId);
    if (provider !== 'builtin') return 'read_only';
    if (!this.builtin) return 'disabled';
    try {
      await this.builtin.removeServiceKey(userId, ref.service, ref.name);
      return 'removed';
    } catch (e) {
      if (e instanceof SecretsProviderError && e.code === 'disabled') return 'disabled';
      return 'unavailable';
    }
  }

  /** One Activity row: the reference, the provider, the outcome and the run. Never the value. A failure to record never fails the call. */
  private async record(userId: string, provider: SecretsProviderId, ref: ServiceKeyRef, outcome: string, released: boolean, runId?: string): Promise<void> {
    try {
      let run: string | null = null;
      if (runId && UUID.test(runId)) run = (await this.prisma.run.findFirst({ where: { id: runId, userId }, select: { id: true } }))?.id ?? null;
      await this.prisma.secretsActivity.create({
        data: { userId, occurredAt: new Date(), event: SERVICE_KEY_ACTIVITY_EVENT, opId: randomUUID(), runId: run, provider, itemId: `${ref.service}.${ref.name}`.slice(0, 100), field: null, site: null, purpose: 'service_call', outcome, released },
      });
    } catch (e) {
      this.log.warn(`service key: the activity row could not be written (${e instanceof Error ? e.name : 'error'})`);
    }
  }
}
