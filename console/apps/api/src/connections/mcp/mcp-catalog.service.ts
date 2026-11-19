// The tool catalogue of an MCP connection (E39.9, #606): the snapshot taken on connect and on "Refresh tools", the owner's switch per
// tool, and the rug-pull rule. A tool is `off` until the OWNER sets it `read` or `write`; the server's hints only suggest. A later
// listing that changes an enabled tool, or adds a tool, switches it off and tells the owner. Only the owner's own act enables a tool.
import { Injectable, Logger } from '@nestjs/common';
import type { Connection, ConnectionMcpTool, Prisma } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { ConnectionError, notFound } from '../connections.errors';
import { CONNECTION_AUDIT, ConnectionEvents } from '../connections.events';
import { ConnectionTokensService } from '../connection-tokens.service';
import { McpClientError } from './mcp-client';
import { readMcpConfig, type McpConfig } from './mcp-config';
import { McpConnector, toConnectionError, disabledError } from './mcp-connector.service';
import { MCP_TOOL_MODES, type McpToolMode, type McpToolReview } from './mcp.constants';
import { sanitizeText } from './mcp-text';
import { planRefresh, suggestedMode, type McpToolDescriptor } from './mcp-tools';

export interface McpToolView {
  id: string;
  name: string;
  title: string | null;
  /** The server's description as plain text (markup and control characters removed, at most 1,000 characters): what the owner reads. */
  description: string;
  parameters: { name: string; type: string | null; required: boolean }[];
  /** The server's claims, as sent: a hint is not a guarantee. */
  hints: { readOnly: boolean | null; destructive: boolean | null; idempotent: boolean | null; openWorld: boolean | null };
  /** What the hints suggest (a tool with none is suggested `write`). The owner decides. */
  suggested: 'read' | 'write';
  mode: McpToolMode;
  /** Set while the owner has not reviewed a tool that is new or whose description or schema changed: it is off until they decide. */
  review: McpToolReview | null;
}

export interface McpCatalog {
  tools: McpToolView[];
  /** Tools that need the owner's review. */
  needsReview: number;
  fetchedAt: string | null;
}

const isRecord = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);

function parametersOf(schema: unknown): McpToolView['parameters'] {
  if (!isRecord(schema) || !isRecord(schema.properties)) return [];
  const required = new Set(Array.isArray(schema.required) ? schema.required.filter((r): r is string => typeof r === 'string') : []);
  return Object.entries(schema.properties)
    .slice(0, 25)
    .map(([name, def]) => {
      const t = isRecord(def) ? def.type : null;
      return { name: sanitizeText(name, 60), type: typeof t === 'string' ? t : Array.isArray(t) ? t.filter((x) => typeof x === 'string').join(' | ') || null : null, required: required.has(name) };
    });
}

const bool = (v: unknown): boolean | null => (typeof v === 'boolean' ? v : null);

export function toolView(row: ConnectionMcpTool): McpToolView {
  const a = isRecord(row.annotations) ? row.annotations : {};
  return {
    id: row.id,
    name: row.name,
    title: row.title,
    description: sanitizeText(row.description, 1_000),
    parameters: parametersOf(row.inputSchema),
    hints: { readOnly: bool(a.readOnlyHint), destructive: bool(a.destructiveHint), idempotent: bool(a.idempotentHint), openWorld: bool(a.openWorldHint) },
    suggested: row.suggested === 'read' ? 'read' : 'write',
    mode: (MCP_TOOL_MODES as readonly string[]).includes(row.mode) ? (row.mode as McpToolMode) : 'off',
    review: row.review === 'new' || row.review === 'changed' ? row.review : null,
  };
}

@Injectable()
export class McpCatalogService {
  private readonly log = new Logger(McpCatalogService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connector: McpConnector,
    private readonly events: ConnectionEvents,
    private readonly tokens: ConnectionTokensService,
  ) {}

  private async mine(userId: string, id: string): Promise<Connection> {
    const row = await this.connector.mine(userId, id);
    if (!row) throw notFound();
    return row;
  }

  /** The stored tools of one connection (no request is made to the server). */
  async list(userId: string, connectionId: string): Promise<McpCatalog> {
    const row = await this.mine(userId, connectionId);
    const tools = await this.prisma.connectionMcpTool.findMany({ where: { connectionId }, orderBy: { name: 'asc' } });
    return { tools: tools.map(toolView), needsReview: tools.filter((t) => t.review !== null).length, fetchedAt: readMcpConfig(row.config)?.toolsFetchedAt ?? null };
  }

  /** The counts the connection list shows, for several connections. */
  async summaries(connectionIds: readonly string[]): Promise<Map<string, { total: number; enabled: number; needsReview: number }>> {
    const out = new Map<string, { total: number; enabled: number; needsReview: number }>();
    if (connectionIds.length === 0) return out;
    const rows = await this.prisma.connectionMcpTool.findMany({ where: { connectionId: { in: [...connectionIds] } }, select: { connectionId: true, mode: true, review: true } });
    for (const r of rows) {
      const s = out.get(r.connectionId) ?? { total: 0, enabled: 0, needsReview: 0 };
      s.total += 1;
      if (r.mode !== 'off') s.enabled += 1;
      if (r.review !== null) s.needsReview += 1;
      out.set(r.connectionId, s);
    }
    return out;
  }

  /**
   * "Refresh tools": lists the server's tools again and stores the snapshot. Changed or new tools are switched off pending review.
   * A refused sign-in marks the connection `needs_reconnect`; an unreachable server changes nothing.
   */
  async refresh(userId: string, connectionId: string, opts: { signal?: AbortSignal } = {}): Promise<McpCatalog> {
    const row = await this.mine(userId, connectionId);
    if (!(await this.connector.enabled())) throw disabledError();
    if (row.status === 'paused') throw new ConnectionError('CONNECTION_PAUSED', 'This connection is paused.', { label: row.label });
    if (row.status !== 'active') throw new ConnectionError('CONNECTION_NEEDS_RECONNECT', 'This connection must be connected again.', { label: row.label, reason: row.statusReason ?? 'NEEDS_RECONNECT' });
    const { client, config } = await this.connector.open(row, { signal: opts.signal }).catch(async (e: unknown) => {
      throw await this.failed(row, e);
    });
    let listed;
    try {
      listed = await client.listTools();
    } catch (e) {
      throw await this.failed(row, e);
    } finally {
      await client.close();
    }
    await this.store(row, config, listed.tools, { name: client.serverInfo.name, version: client.serverInfo.version, protocolVersion: client.protocolVersion, skipped: listed.skipped });
    return this.list(userId, connectionId);
  }

  /** Stores a first listing for a connection that has just been created (no review flags: everything is new to the owner). */
  async storeFirst(row: Connection, config: McpConfig, tools: McpToolDescriptor[], server: { name: string | null; version: string | null; protocolVersion: string | null }): Promise<void> {
    await this.store(row, config, tools, { ...server, skipped: 0 });
  }

  private async failed(row: Connection, e: unknown): Promise<ConnectionError> {
    if (e instanceof McpClientError && e.kind === 'auth') await this.tokens.markNeedsReconnect(row.userId, row.id, 'AUTH_REFUSED').catch(() => false);
    else if (e instanceof McpClientError && e.kind !== 'aborted') await this.prisma.connection.updateMany({ where: { id: row.id, status: 'active' }, data: { statusReason: 'UNAVAILABLE' } }).catch(() => undefined);
    return toConnectionError(e, row.label);
  }

  private async store(row: Connection, config: McpConfig, fetched: McpToolDescriptor[], server: { name: string | null; version: string | null; protocolVersion: string | null; skipped: number }): Promise<void> {
    const firstListing = !config.toolsFetchedAt;
    const current = await this.prisma.connectionMcpTool.findMany({ where: { connectionId: row.id } });
    const plan = planRefresh(
      current.map((t) => ({ name: t.name, hash: t.hash, mode: t.mode as McpToolMode, review: (t.review as McpToolReview | null) ?? null, approvedHash: t.approvedHash })),
      fetched,
      firstListing,
    );
    const fields = (t: McpToolDescriptor) => ({ title: t.title, description: t.description, inputSchema: t.inputSchema as Prisma.InputJsonValue, annotations: t.annotations as Prisma.InputJsonValue, hash: t.hash, suggested: suggestedMode(t.annotations) });
    const next: McpConfig = { ...config, server: { name: server.name, version: server.version }, protocolVersion: server.protocolVersion, toolsFetchedAt: new Date().toISOString() };
    await this.prisma.$transaction(async (tx) => {
      for (const c of plan.create) await tx.connectionMcpTool.create({ data: { connectionId: row.id, name: c.tool.name, ...fields(c.tool), mode: 'off', review: c.review } });
      for (const u of plan.update) await tx.connectionMcpTool.update({ where: { connectionId_name: { connectionId: row.id, name: u.tool.name } }, data: { ...fields(u.tool), ...(u.disable ? { mode: 'off' } : {}), review: u.review } });
      if (plan.remove.length > 0) await tx.connectionMcpTool.deleteMany({ where: { connectionId: row.id, name: { in: plan.remove } } });
      await tx.connection.update({ where: { id: row.id }, data: { config: next as Prisma.InputJsonValue, ...(row.statusReason === 'UNAVAILABLE' ? { statusReason: null } : {}) } });
    });
    await this.events.audit(row.userId, CONNECTION_AUDIT.mcpToolsRefreshed, row.id, { provider: 'mcp', tools: fetched.length, created: plan.create.length, changed: plan.update.length, removed: plan.remove.length, skipped: server.skipped });
    this.events.count('mcp', 'tools_listed');
    if (plan.needReview > 0) {
      await this.events.audit(row.userId, CONNECTION_AUDIT.mcpToolsQuarantined, row.id, { provider: 'mcp', count: plan.needReview, switchedOff: plan.update.filter((u) => u.disable).map((u) => u.tool.name).slice(0, 50), added: plan.create.filter((c) => c.review).map((c) => c.tool.name).slice(0, 50) });
      this.events.count('mcp', 'tools_changed');
      // After the write committed, outside the transaction.
      await this.events.mcpToolsChanged(row.userId, { connectionId: row.id, label: row.label, count: plan.needReview });
    }
  }

  /**
   * The owner's decision about one tool: `off`, `read` or `write`. The only way a tool is enabled. Deciding also clears the review flag and
   * records which version of the tool (its hash) the owner decided about.
   */
  async setMode(userId: string, connectionId: string, toolId: string, mode: McpToolMode): Promise<McpToolView> {
    await this.mine(userId, connectionId);
    const tool = await this.prisma.connectionMcpTool.findFirst({ where: { id: toolId, connectionId } });
    if (!tool) throw notFound();
    const updated = await this.prisma.connectionMcpTool.update({ where: { id: tool.id }, data: { mode, review: null, approvedHash: tool.hash } });
    await this.events.audit(userId, CONNECTION_AUDIT.mcpToolMode, connectionId, { provider: 'mcp', tool: tool.name, from: tool.mode, to: mode, suggested: tool.suggested, afterReview: tool.review });
    return toolView(updated);
  }
}
