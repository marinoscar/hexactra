// The first binding of the service credentials port (E50.2, #972): the platform's encrypted credential store, all three tiers.
//
//   user          UserCredentialsService, purpose `service_credential`, name `<service>.<name>`, owner-bound sub-key.
//   organization  OrgCredentialsService, same purpose and name, org-bound sub-key, row-level security on the organization.
//   system        CredentialsService, same purpose and name (the deployment's).
//
// The value is stored inside a small JSON envelope (`{"value":"…","v":1}`). The store derives a masked hint from the last characters
// of what it is given; with the envelope those characters are the envelope's own (`":1}`), so no character of the key is kept in a
// plaintext column. This module never reads or returns the hint anyway: `status` reports the row time only.
//
// Plaintext leaves `resolve` only as `SecretBytes`, for server code at the moment of a request to the service.
import { Injectable, Logger, Optional } from '@nestjs/common';
import { CredentialsService, OrgCredentialsService, UserCredentialsService } from '@marinoscar/platform-api/credentials';
import { AppMetricsService } from '@marinoscar/platform-api/host';
import { registerAppMetrics, type AppMetricDef } from '@marinoscar/platform-api/otel-core';

import { SecretBytes } from '../secrets/secrets-provider.port';
import { CREDENTIAL_TIERS, storedName, type CredentialTier, type ServiceCredentialPort, type ServiceCredentialRef, type ServiceCredentialResolution, type ServiceCredentialResolveOptions, type ServiceCredentialStatus, type Who } from './service-credential.port';
import { ServiceCredentialRegistry, type ServiceCredentialRegistration } from './service-credential.registry';
import { SERVICE_CREDENTIAL_PURPOSE } from './service-credentials.credentials';
import { ServiceCredentialError } from './service-credentials.errors';

/** Names are permanent once dashboards read them. `service` is bounded by the registry (only a registered service is counted); `tier` is an enum. */
export const SERVICE_CREDENTIAL_METRICS: readonly AppMetricDef[] = [
  {
    key: 'serviceCredentialsResolved',
    name: 'app.service_credentials.resolved',
    kind: 'counter',
    unit: '{resolution}',
    description: 'Service credential lookups, by service and the tier that answered (`none` when no tier held a key).',
    attributes: { service: { kind: 'free' }, tier: { kind: 'enum', values: [...CREDENTIAL_TIERS, 'none'] } },
  },
];
registerAppMetrics(SERVICE_CREDENTIAL_METRICS);

const ENVELOPE_VERSION = 1;

export function seal(value: string): string {
  return JSON.stringify({ value, v: ENVELOPE_VERSION });
}

export function unseal(stored: string): string | null {
  try {
    const parsed = JSON.parse(stored) as unknown;
    if (parsed && typeof parsed === 'object' && (parsed as { v?: unknown }).v === ENVELOPE_VERSION && typeof (parsed as { value?: unknown }).value === 'string') return (parsed as { value: string }).value;
  } catch {
    // not an envelope
  }
  return null;
}

@Injectable()
export class CredentialStoreServiceCredentials implements ServiceCredentialPort {
  private readonly log = new Logger('ServiceCredentials');

  constructor(
    private readonly registry: ServiceCredentialRegistry,
    private readonly users: UserCredentialsService,
    private readonly orgs: OrgCredentialsService,
    private readonly system: CredentialsService,
    @Optional() private readonly metrics?: AppMetricsService,
  ) {}

  async resolve(ref: ServiceCredentialRef, who: Who, opts: ServiceCredentialResolveOptions = {}): Promise<{ tier: CredentialTier; value: SecretBytes } | null> {
    const reg = this.registry.get(ref);
    if (!reg) return null;
    for (const tier of this.order(reg, who, opts)) {
      const value = await this.readTier(ref, tier, who);
      if (!value) continue;
      this.count(ref.service, tier);
      return { tier, value };
    }
    this.count(ref.service, 'none');
    return null;
  }

  async resolveDetailed(ref: ServiceCredentialRef, who: Who, opts: ServiceCredentialResolveOptions = {}): Promise<ServiceCredentialResolution> {
    const found = await this.resolve(ref, who, opts);
    return found ? { found } : { found: null, reason: 'NONE' };
  }

  /** The key stored in `tier` here, unsealed, or null. Server-side only; the caller wipes it. Not counted. */
  async readTier(ref: ServiceCredentialRef, tier: CredentialTier, who: Who): Promise<SecretBytes | null> {
    const stored = await this.read(tier, ref, who);
    if (stored === null) return null;
    const value = unseal(stored);
    if (value === null) {
      this.log.warn(`service credential ${storedName(ref)}: the ${tier} key is not in the expected envelope; skipped`);
      return null;
    }
    return SecretBytes.from(value);
  }

  /** When the key in `tier` here was stored, or null. */
  setTime(ref: ServiceCredentialRef, tier: CredentialTier, who: Who): Promise<Date | null> {
    return this.describe(tier, ref, who);
  }

  async status(ref: ServiceCredentialRef, who: Who, opts: ServiceCredentialResolveOptions = {}): Promise<ServiceCredentialStatus> {
    const reg = this.registry.get(ref);
    const tiers: Record<CredentialTier, boolean> = { user: false, organization: false, system: false };
    const setAt: Record<CredentialTier, Date | null> = { user: null, organization: null, system: null };
    if (reg) {
      for (const tier of reg.tiers) {
        const at = await this.describe(tier, ref, who);
        tiers[tier] = at !== null;
        setAt[tier] = at;
      }
    }
    const answering = reg ? (this.order(reg, who, opts).find((t) => tiers[t]) ?? null) : null;
    return { tier: answering, binding: 'credential_store', setAt: answering ? setAt[answering]!.toISOString() : null, tiers };
  }

  /** When each tier's key was stored (`null`: none), for the list route. Never a value. */
  async setTimes(ref: ServiceCredentialRef, who: Who): Promise<Record<CredentialTier, string | null>> {
    const reg = this.registry.get(ref);
    const out: Record<CredentialTier, string | null> = { user: null, organization: null, system: null };
    for (const tier of reg?.tiers ?? []) out[tier] = (await this.describe(tier, ref, who))?.toISOString() ?? null;
    return out;
  }

  async set(ref: ServiceCredentialRef, tier: CredentialTier, who: Who, value: SecretBytes): Promise<void> {
    const reg = this.writable(ref, tier, who);
    const plain = value.expose((b) => b.toString('utf8'));
    const problem = reg.validate(plain);
    if (problem !== null) throw new ServiceCredentialError('SERVICE_CREDENTIAL_INVALID', 'The value does not have the shape this key has.', { reason: /^[a-z][a-z_]{0,39}$/.test(problem) ? problem : 'invalid' });
    const sealed = seal(plain);
    const name = storedName(ref);
    if (tier === 'user') await this.users.setSecret(who.userId, SERVICE_CREDENTIAL_PURPOSE, name, sealed, { label: reg.label });
    else if (tier === 'organization') await this.orgs.setSecret(who.orgId!, SERVICE_CREDENTIAL_PURPOSE, name, sealed, { label: reg.label, updatedByUserId: who.userId });
    else await this.system.setSecret(SERVICE_CREDENTIAL_PURPOSE, name, sealed, { label: reg.label, updatedByUserId: who.userId });
  }

  async delete(ref: ServiceCredentialRef, tier: CredentialTier, who: Who): Promise<void> {
    this.writable(ref, tier, who);
    const name = storedName(ref);
    if (tier === 'user') await this.users.deleteSecret(who.userId, SERVICE_CREDENTIAL_PURPOSE, name);
    else if (tier === 'organization') await this.orgs.deleteSecret(who.orgId!, SERVICE_CREDENTIAL_PURPOSE, name);
    else await this.system.deleteSecret(SERVICE_CREDENTIAL_PURPOSE, name);
  }

  /** The tiers consulted, in order: the registration's, narrowed by `allowTiers`, without the organization when there is none. */
  order(reg: ServiceCredentialRegistration, who: Who, opts: ServiceCredentialResolveOptions): CredentialTier[] {
    return CREDENTIAL_TIERS.filter((t) => reg.tiers.includes(t) && (!opts.allowTiers || opts.allowTiers.includes(t)) && (t !== 'organization' || who.orgId !== null));
  }

  private writable(ref: ServiceCredentialRef, tier: CredentialTier, who: Who): ServiceCredentialRegistration {
    const reg = this.registry.get(ref);
    if (!reg) throw new ServiceCredentialError('SERVICE_CREDENTIAL_UNKNOWN', 'No service credential is registered under this service and name.');
    if (!reg.tiers.includes(tier)) throw new ServiceCredentialError('SERVICE_CREDENTIAL_TIER_NOT_ALLOWED', 'This key cannot be stored at this tier.', { tier });
    if (tier === 'organization' && !who.orgId) throw new ServiceCredentialError('SERVICE_CREDENTIAL_NO_ORGANIZATION', 'There is no active organization.');
    return reg;
  }

  private read(tier: CredentialTier, ref: ServiceCredentialRef, who: Who): Promise<string | null> {
    const name = storedName(ref);
    if (tier === 'user') return this.users.getSecret(who.userId, SERVICE_CREDENTIAL_PURPOSE, name);
    if (tier === 'organization') return who.orgId ? this.orgs.getSecret(who.orgId, SERVICE_CREDENTIAL_PURPOSE, name) : Promise.resolve(null);
    return this.system.getSecret(SERVICE_CREDENTIAL_PURPOSE, name);
  }

  private async describe(tier: CredentialTier, ref: ServiceCredentialRef, who: Who): Promise<Date | null> {
    const name = storedName(ref);
    if (tier === 'user') return (await this.users.describe(who.userId, SERVICE_CREDENTIAL_PURPOSE, name))?.updatedAt ?? null;
    if (tier === 'organization') return who.orgId ? ((await this.orgs.describe(who.orgId, SERVICE_CREDENTIAL_PURPOSE, name))?.updatedAt ?? null) : null;
    return (await this.system.describe(SERVICE_CREDENTIAL_PURPOSE, name))?.updatedAt ?? null;
  }

  count(service: string, tier: CredentialTier | 'none'): void {
    if (this.registry.services().has(service)) this.metrics?.add('serviceCredentialsResolved', 1, { service, tier });
  }
}
