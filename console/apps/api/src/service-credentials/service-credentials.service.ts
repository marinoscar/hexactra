// The routes' side of service credentials (E50.2, #972): the caller's view of every registered reference, and the audited writes.
// An audit row names the reference and the tier, never the value.
import { Inject, Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { SecretBytes } from '../secrets/secrets-provider.port';
import { CredentialStoreServiceCredentials } from './credential-store.binding';
import { RoutedServiceCredentials, type MoveResult } from './routed-service-credentials';
import { SecretsProviderServiceCredentials } from './secrets-provider.binding';
import type { UserBinding } from './service-credentials.settings';
import { CREDENTIAL_TIERS, SERVICE_CREDENTIAL_PORT, storedName, type CredentialTier, type ServiceCredentialPort, type ServiceCredentialRef, type Who } from './service-credential.port';
import { ServiceCredentialRegistry } from './service-credential.registry';
import { ServiceCredentialError } from './service-credentials.errors';
import type { ServiceCredentialView } from './service-credentials.schemas';

export const SERVICE_CREDENTIAL_AUDIT = { set: 'service_credential.set', removed: 'service_credential.removed', moved: 'service_credential.moved' } as const;

@Injectable()
export class ServiceCredentialsService {
  private readonly log = new Logger('ServiceCredentials');

  constructor(
    private readonly registry: ServiceCredentialRegistry,
    @Inject(SERVICE_CREDENTIAL_PORT) private readonly port: ServiceCredentialPort,
    private readonly store: CredentialStoreServiceCredentials,
    private readonly routed: RoutedServiceCredentials,
    private readonly provider: SecretsProviderServiceCredentials,
    private readonly prisma: PrismaService,
  ) {}

  /** Every registered reference and, for the caller, which tiers hold a key and when it was set. Never a value. */
  async list(who: Who): Promise<ServiceCredentialView[]> {
    const out: ServiceCredentialView[] = [];
    const secretsProvider = await this.secretsProvider(who.userId);
    for (const reg of this.registry.list()) {
      const status = await this.port.status(reg.ref, who);
      const times = await this.store.setTimes(reg.ref, who);
      const place = reg.tiers.includes('user') ? await this.routed.userPlace(reg.ref, who) : null;
      if (place) times.user = place.setAt;
      const tiers = Object.fromEntries(
        CREDENTIAL_TIERS.map((t) => [t, { available: reg.tiers.includes(t) && (t !== 'organization' || who.orgId !== null), set: status.tiers[t], setAt: times[t] }]),
      ) as ServiceCredentialView['tiers'];
      out.push({ service: reg.ref.service, name: reg.ref.name, label: reg.label, binding: status.binding, tier: status.tier, tiers, userBinding: place?.binding ?? 'credential_store', secretsProvider });
    }
    return out;
  }

  /** The owner's secrets provider as Move needs to know it; null without the secrets feature. Never a value. */
  private async secretsProvider(userId: string): Promise<ServiceCredentialView['secretsProvider']> {
    const id = await this.provider.provider(userId);
    if (!id) return null;
    const releasesEnabled = await this.provider.releasesEnabled();
    if (id === 'builtin') {
      const writable = await this.provider.builtinWritable();
      return { id, writable, releasesEnabled, ready: writable };
    }
    return { id, writable: false, releasesEnabled, ready: await this.provider.vaultHasScope(userId) };
  }

  /** Moves the owner's own key between the console and their secrets provider. Audited (`service_credential.moved`). */
  async move(ref: ServiceCredentialRef, who: Who, to: UserBinding): Promise<MoveResult> {
    if (!this.registry.get(ref)) throw new ServiceCredentialError('SERVICE_CREDENTIAL_UNKNOWN', 'No service credential is registered under this service and name.');
    const r = await this.routed.move(ref, who, to);
    await this.audit(who, SERVICE_CREDENTIAL_AUDIT.moved, ref, 'user', { to: r.binding, sourceRemoved: r.sourceRemoved });
    return r;
  }

  async set(ref: ServiceCredentialRef, tier: CredentialTier, who: Who, value: string): Promise<void> {
    if (!this.registry.get(ref)) throw new ServiceCredentialError('SERVICE_CREDENTIAL_UNKNOWN', 'No service credential is registered under this service and name.');
    const secret = SecretBytes.from(value);
    try {
      await this.port.set(ref, tier, who, secret);
    } finally {
      secret.wipe();
    }
    await this.audit(who, SERVICE_CREDENTIAL_AUDIT.set, ref, tier);
  }

  async remove(ref: ServiceCredentialRef, tier: CredentialTier, who: Who): Promise<void> {
    await this.port.delete(ref, tier, who);
    await this.audit(who, SERVICE_CREDENTIAL_AUDIT.removed, ref, tier);
  }

  /** One audit event: the reference and the tier. A failure to record it never fails the write. */
  private async audit(who: Who, action: string, ref: ServiceCredentialRef, tier: CredentialTier, extra: Record<string, string | boolean> = {}): Promise<void> {
    try {
      await this.prisma.auditEvent.create({
        data: {
          actorUserId: who.userId,
          action,
          targetType: 'service_credential',
          targetId: storedName(ref),
          orgId: tier === 'organization' ? who.orgId : null,
          meta: { service: ref.service, name: ref.name, tier, ...extra } as Prisma.InputJsonValue,
        },
      });
    } catch (e) {
      this.log.warn(`service credentials: the audit record ${action} could not be written: ${e instanceof Error ? e.name : 'error'}`);
    }
  }
}
