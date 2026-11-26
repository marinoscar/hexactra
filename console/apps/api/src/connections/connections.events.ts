// The audit trail, the counters and the notification of Connections (E39.2, #599). An audit event names the owner, the
// connection id, the provider and the capabilities: never an email address, a message body or a token.
// `notify()` runs after the write that triggered it has committed.
import { Injectable, Logger, Optional } from '@nestjs/common';
import { AppMetricsService } from '@marinoscar/platform-api/host';
import { registerAppMetrics, type AppMetricDef } from '@marinoscar/platform-api/otel-core';
import { NotificationsService } from '@marinoscar/platform-api/notifications';
import type { Prisma } from '@prisma/client';

import { PrismaService } from '../prisma/prisma.service';
import { CONNECTION_MCP_TOOLS_CHANGED_EVENT, CONNECTION_NEEDS_RECONNECT_EVENT } from '../platform/notifications/hexactra.notifications';
import { CONNECTION_PROVIDER_IDS } from './connections.constants';

/** The audit actions of Connections. */
export const CONNECTION_AUDIT = {
  created: 'connection.created',
  updated: 'connection.updated',
  paused: 'connection.paused',
  resumed: 'connection.resumed',
  needsReconnect: 'connection.needs_reconnect',
  removed: 'connection.removed',
  connectStarted: 'connection.connect_started',
  connectFailed: 'connection.connect_failed',
  appSaved: 'connection.app_saved',
  appRemoved: 'connection.app_removed',
  folderCreated: 'connection.folder_created',
  filePicked: 'connection.file_picked',
  pickerOpened: 'connection.picker_opened',
  // MCP servers (E39.9): no tool name, argument or result is ever in these; a tool is named by its id and its name.
  mcpAdded: 'connection.mcp_added',
  mcpToolsRefreshed: 'connection.mcp_tools_refreshed',
  mcpToolMode: 'connection.mcp_tool_mode',
  mcpToolsQuarantined: 'connection.mcp_tools_quarantined',
  // E50.12: the owner tried a read tool. The connection and the tool; never an argument's value or the result.
  mcpToolTried: 'connection.mcp_tool_tried',
} as const;

export const CONNECTION_OUTCOMES = ['connected', 'reconnected', 'consent_added', 'denied', 'failed', 'refreshed', 'needs_reconnect', 'unavailable', 'removed', 'paused', 'resumed', 'tested', 'tools_listed', 'tools_changed'] as const;
export type ConnectionOutcome = (typeof CONNECTION_OUTCOMES)[number];

/** Names are permanent once dashboards read them. Labels are bounded enums: never a user, an account or a label. */
export const CONNECTION_METRICS: readonly AppMetricDef[] = [
  {
    key: 'connectionEvents',
    name: 'app.connections.events',
    kind: 'counter',
    unit: '{event}',
    description: 'Connection events (connect, refresh, needs reconnect, pause, remove, test), by provider and outcome.',
    attributes: { provider: { kind: 'enum', values: [...CONNECTION_PROVIDER_IDS, 'mcp'] }, outcome: { kind: 'enum', values: CONNECTION_OUTCOMES } },
  },
];
registerAppMetrics(CONNECTION_METRICS);

@Injectable()
export class ConnectionEvents {
  private readonly log = new Logger(ConnectionEvents.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly notifications?: NotificationsService,
    @Optional() private readonly metrics?: AppMetricsService,
  ) {}

  /** One audit event. A failure to record it never fails the operation. */
  async audit(userId: string | null, action: string, targetId: string, meta: Record<string, unknown>, targetType = 'connection'): Promise<void> {
    try {
      await this.prisma.auditEvent.create({ data: { actorUserId: userId, action, targetType, targetId, orgId: null, meta: meta as Prisma.InputJsonValue } });
    } catch (e) {
      this.log.warn(`connections: the audit record ${action} could not be written: ${e instanceof Error ? e.name : 'error'}`);
    }
  }

  /** Tells the owner an MCP server changed tools they enabled (or added new ones): they are off until reviewed. After the write commits. */
  async mcpToolsChanged(userId: string, data: { connectionId: string; label: string; count: number }): Promise<void> {
    if (!this.notifications) return;
    try {
      await this.notifications.notify(CONNECTION_MCP_TOOLS_CHANGED_EVENT, userId, data);
    } catch (e) {
      this.log.warn(`notify ${CONNECTION_MCP_TOOLS_CHANGED_EVENT} failed: ${e instanceof Error ? e.name : 'error'}`);
    }
  }

  count(provider: string, outcome: ConnectionOutcome): void {
    if (provider === 'mcp' || (CONNECTION_PROVIDER_IDS as readonly string[]).includes(provider)) this.metrics?.add('connectionEvents', 1, { provider, outcome });
  }

  /** Tells the owner an account must be connected again. The caller decides "once" (`reconnectNotifiedAt`). */
  async needsReconnect(userId: string, data: { connectionId: string; provider: string; label: string }): Promise<void> {
    if (!this.notifications) return;
    try {
      await this.notifications.notify(CONNECTION_NEEDS_RECONNECT_EVENT, userId, data);
    } catch (e) {
      this.log.warn(`notify ${CONNECTION_NEEDS_RECONNECT_EVENT} failed: ${e instanceof Error ? e.name : 'error'}`);
    }
  }
}
