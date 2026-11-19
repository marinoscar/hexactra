// The audit trail and the notification of the secrets connection (E37.2, #591). An audit event names the owner,
// the provider, the host of the Vault and the scopes: never a token, a client secret, a URL path or a message from
// the provider. `notify()` runs after the write that triggered it has committed.
import { Injectable, Logger, Optional } from '@nestjs/common';
import { NotificationsService } from '@marinoscar/platform-api/notifications';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { SECRETS_NEEDS_RECONNECT_EVENT } from '../platform/notifications/hexactra.notifications';

/** The audit actions of the Vault connection. */
export const SECRETS_AUDIT = {
  clientSaved: 'secrets.vault.client_saved',
  connectStarted: 'secrets.vault.connect_started',
  connected: 'secrets.vault.connected',
  connectFailed: 'secrets.vault.connect_failed',
  disconnected: 'secrets.vault.disconnected',
  needsReconnect: 'secrets.vault.needs_reconnect',
  defaultClientSaved: 'secrets.vault.default_client_saved',
  defaultClientRemoved: 'secrets.vault.default_client_removed',
  // "Save this login?" (E37.4b): the offer, the save (the fabric sent the password to the provider) and "Never for this site". Never a value.
  loginOffered: 'secrets.login.offered',
  loginSaved: 'secrets.login.saved',
  loginSaveFailed: 'secrets.login.save_failed',
  loginNeverForSite: 'secrets.login.never_for_site',
} as const;

/** The host (and port) of an address, for a log or an audit line: never the path, query or userinfo. */
export function hostOf(raw: string | null | undefined): string | null {
  if (!raw) return null;
  try {
    return new URL(raw).host || null;
  } catch {
    return null;
  }
}

@Injectable()
export class SecretsEvents {
  private readonly log = new Logger(SecretsEvents.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  /** One audit event. A failure to record it never fails the operation. */
  async audit(userId: string | null, action: string, targetId: string, meta: Record<string, unknown>, orgId: string | null = null, targetType = 'secrets_connection'): Promise<void> {
    try {
      await this.prisma.auditEvent.create({ data: { actorUserId: userId, action, targetType, targetId, orgId, meta: meta as Prisma.InputJsonValue } });
    } catch (e) {
      this.log.warn(`secrets: the audit record ${action} could not be written: ${e instanceof Error ? e.name : 'error'}`);
    }
  }

  /** Tells the owner their Vault must be connected again. The caller decides "once" (`reconnectNotifiedAt`). */
  async needsReconnect(userId: string): Promise<void> {
    if (!this.notifications) return;
    try {
      await this.notifications.notify(SECRETS_NEEDS_RECONNECT_EVENT, userId, {});
    } catch (e) {
      this.log.warn(`notify ${SECRETS_NEEDS_RECONNECT_EVENT} failed: ${e instanceof Error ? e.name : 'error'}`);
    }
  }
}
