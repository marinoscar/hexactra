// The platform tells the app that a user approved an OAuth client
// (`identity.oauth.grant.created`, after the commit; reason `created` for a new
// grant, `updated` for a widened one). The listener only enqueues a job (no
// I/O in an `@OnEvent`: conformance `on-event-no-io`); the job reads the grant
// and notifies the owner (`app.connected`, `app.scope_added`).
import { Injectable, Logger, Optional, type OnModuleInit } from '@nestjs/common';
import { OnEvent } from '@nestjs/event-emitter';
import { IDENTITY_EVENTS, type IdentityOAuthGrantEvent } from '@marinoscar/platform-api/identity';
import { JobHandlerRegistry, JobsService, registerJobReason, type Job, type JobHandler } from '@marinoscar/platform-api/jobs';
import { NotificationsService } from '@marinoscar/platform-api/notifications';
import { z } from 'zod';

import { MCP_OAUTH_RESOURCE_ID } from '../mcp/mcp.scopes';
import { PrismaService } from '../prisma/prisma.service';
import { APP_CONNECTED_EVENT, APP_SCOPE_ADDED_EVENT } from './connected-apps.notifications';
import { HIGH_RISK_SCOPES, scopesInWords } from './connected-apps.service';
import { clientLabel, friendlyAppName } from './request-client';

/** Permanent job type. */
export const APP_GRANT_NOTIFY_JOB = 'connected_apps.grant.notify';
export const APP_GRANT_REASONS = {
  created: { id: 'app_connected', label: 'AI app connected' },
  updated: { id: 'app_scopes_changed', label: 'AI app permissions changed' },
} as const;
for (const r of Object.values(APP_GRANT_REASONS)) registerJobReason(r);

const payloadSchema = z.object({
  userId: z.uuid(),
  grantId: z.uuid(),
  clientId: z.uuid(),
  reason: z.string().max(40),
});
export type AppGrantPayload = z.infer<typeof payloadSchema>;

/** The listener: enqueue only. */
@Injectable()
export class ConnectedAppsGrantListener {
  private readonly log = new Logger(ConnectedAppsGrantListener.name);

  constructor(@Optional() private readonly jobs?: JobsService) {}

  @OnEvent(IDENTITY_EVENTS.OAUTH_GRANT_CREATED)
  onGrant(event: IdentityOAuthGrantEvent): void {
    if (!this.jobs || event.resourceId !== MCP_OAUTH_RESOURCE_ID) return;
    const reason = event.reason === 'updated' ? APP_GRANT_REASONS.updated.id : APP_GRANT_REASONS.created.id;
    this.jobs
      .enqueue({
        type: APP_GRANT_NOTIFY_JOB,
        reason,
        subjectType: 'oauth_grant',
        subjectId: event.grantId,
        orgId: null,
        // Two events for one grant in a row (connect, then step-up) each get their job.
        skipDedup: true,
        payload: { userId: event.userId, grantId: event.grantId, clientId: event.clientId, reason: event.reason === 'updated' ? 'updated' : 'created' },
      })
      .catch((e: unknown) => this.log.warn(`could not queue the notice of grant ${event.grantId}: ${e instanceof Error ? e.message : String(e)}`));
  }
}

/** `connected_apps.grant.notify`: tells the owner an app connected, or gained a high-risk scope. Server-only (reads and writes the user's rows). */
@Injectable()
export class AppGrantNotifyHandler implements JobHandler, OnModuleInit {
  readonly type = APP_GRANT_NOTIFY_JOB;
  readonly label = 'Notify: AI app connected';
  readonly profile = { maxRuntimeMs: 60_000, maxAttempts: 3 };
  private readonly log = new Logger(AppGrantNotifyHandler.name);

  constructor(
    private readonly registry: JobHandlerRegistry,
    private readonly prisma: PrismaService,
    @Optional() private readonly notifications?: NotificationsService,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async process(job: Job): Promise<void> {
    await this.handle(payloadSchema.parse(job.payload));
  }

  /** What the job does; returns the event it sent, if any. */
  async handle(p: AppGrantPayload): Promise<{ event: string; data: Record<string, unknown> } | null> {
    const grant = await this.prisma.oAuthGrant.findUnique({ where: { id: p.grantId }, include: { client: { select: { name: true, host: true } } } });
    if (!grant || grant.userId !== p.userId || grant.revokedAt) return null;
    const db = this.prisma.forUser({ userId: p.userId });
    const row = await db.connectedAppSettings.findFirst({ where: { clientId: grant.clientId } });
    const appName = friendlyAppName(clientLabel(grant.client));
    let sent: { event: string; data: Record<string, unknown> } | null = null;
    if (p.reason === 'created' || !row) {
      // A connection (a new grant, or one this console never saw): every scope is new. Its first run is announced again.
      const data = { userId: p.userId, notifiedScopes: [...grant.scopes], firstRunAt: null };
      if (row) await db.connectedAppSettings.update({ where: { id: row.id }, data });
      else await db.connectedAppSettings.create({ data: { ...data, clientId: grant.clientId } }).catch(() => undefined);
      sent = { event: APP_CONNECTED_EVENT, data: { clientId: grant.clientId, grantId: grant.id, appName, scopes: scopesInWords(grant.scopes), scopeIds: [...grant.scopes] } };
    } else {
      const added = grant.scopes.filter((s) => !row.notifiedScopes.includes(s));
      if (added.length === 0) return null;
      // Compare-and-set: two jobs of one step-up announce it once.
      const { count } = await db.connectedAppSettings.updateMany({ where: { id: row.id, notifiedScopes: { equals: row.notifiedScopes } }, data: { notifiedScopes: [...new Set([...row.notifiedScopes, ...grant.scopes])] } });
      const high = added.filter((s) => (HIGH_RISK_SCOPES as readonly string[]).includes(s));
      if (count === 0 || high.length === 0) return null;
      sent = { event: APP_SCOPE_ADDED_EVENT, data: { clientId: grant.clientId, grantId: grant.id, appName, added: scopesInWords(high), scopeIds: high } };
    }
    try {
      await this.notifications?.notify(sent.event, p.userId, sent.data);
    } catch (e) {
      this.log.warn(`${sent.event} for grant ${grant.id} failed: ${e instanceof Error ? e.message : String(e)}`);
    }
    return sent;
  }
}
