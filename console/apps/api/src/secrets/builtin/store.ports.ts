// The console's bindings of the Vault ports the built-in store mounts (E37.5, #594).
//
//   VAULT_PRISMA        PrismaService (the console's client; Vault's services filter by owner themselves)
//   VAULT_CRYPTO        SecretsStoreCrypto (the envelope, store.crypto.ts)
//   VAULT_AUDIT         `audit_events`; a failed audit write FAILS the operation (it is not swallowed)
//   VAULT_SETTINGS      the console's settings: the `agentAccess` kill switch IS the deployment's `secrets.agentUse`
//   VAULT_NOTIFY        no-op: the owner-facing notices of Vault's agent slice need templates the console does not
//                       have; every use is audited and shown on the run, which is the console's equivalent
//   VAULT_OBJECT_STORE  refuses: attachments are not part of the built-in store (logins only)
//
// Ports of slices that are not mounted (`jobs`, `objects`, `ai`, `aiConfig`, `aiKeyPresence`, `metrics`, `host`,
// `mcp`) are not bound: nothing that is mounted asks for them.
import { Injectable, NotImplementedException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { AGENT_ACCESS_SETTINGS_DEFAULTS } from '@marinoscar/vault-contract/agent';
import { VAULT_BACKUPS_SETTINGS_DEFAULTS, VAULT_CARDS_SETTINGS_DEFAULTS } from '@marinoscar/vault-api/core';
import type { VaultAuditEvent, VaultAuditPort, VaultSettingsPort } from '@marinoscar/vault-api/ports';

import { PrismaService } from '../../prisma/prisma.service';
import { SecretsPolicyService } from '../secrets-policy.service';

@Injectable()
export class StoreAudit implements VaultAuditPort {
  constructor(private readonly prisma: PrismaService) {}

  /** One `audit_events` row. A failure propagates: the operation that could not be recorded does not happen. */
  async record(event: VaultAuditEvent): Promise<void> {
    await this.prisma.auditEvent.create({
      data: {
        actorUserId: event.actorUserId ?? null,
        action: event.action,
        targetType: event.targetType,
        targetId: event.targetId,
        ...(event.meta === undefined ? {} : { meta: event.meta as Prisma.InputJsonValue }),
      },
    });
  }
}

@Injectable()
export class StoreSettings implements VaultSettingsPort {
  constructor(private readonly policy: SecretsPolicyService) {}

  async getNamespace<T = Record<string, unknown>>(name: string): Promise<T> {
    switch (name) {
      case 'agentAccess': {
        const system = await this.policy.system();
        // The deployment's switch closes everything for the built-in store too. Cards and identity are not part of it.
        return { ...AGENT_ACCESS_SETTINGS_DEFAULTS, enabled: system.agentUse.enabled, cards: { ...AGENT_ACCESS_SETTINGS_DEFAULTS.cards, enabled: false }, identity: { ...AGENT_ACCESS_SETTINGS_DEFAULTS.identity, enabled: false } } as T;
      }
      case 'vaultCards':
        return { ...VAULT_CARDS_SETTINGS_DEFAULTS } as T;
      case 'vaultBackups':
        return { ...VAULT_BACKUPS_SETTINGS_DEFAULTS } as T;
      default:
        return {} as T;
    }
  }

  async getSettings(): Promise<unknown> {
    return { agentAccess: await this.getNamespace('agentAccess'), vaultCards: await this.getNamespace('vaultCards') };
  }
}

/** Vault's owner notices (first use by a new app, a credential changed) are not part of the console: no-ops. */
@Injectable()
export class StoreNotify {
  notify(): Promise<void> {
    return Promise.resolve();
  }
  notifyNow(): Promise<void> {
    return Promise.resolve();
  }
  notifyPermissionHolders(): Promise<void> {
    return Promise.resolve();
  }
  notifyCounted(): Promise<void> {
    return Promise.resolve();
  }
}

const refuse = (): never => {
  throw new NotImplementedException('Attachments are not part of the built-in secrets store.');
};

/** Attachments are out of scope: any use of the object store is refused, never silently stored. */
export const REFUSING_OBJECT_STORE = {
  upload: refuse,
  download: refuse,
  delete: refuse,
  exists: refuse,
  getBucket: () => 'unsupported',
  getSignedDownloadUrl: refuse,
};
