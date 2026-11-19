// What a RUN may do with the owner's MCP connections (E39.9, #606): which tools it may be offered, and calling one. The runner (src/runner/
// host/tools/connections/mcp.ts) builds the model's tools from `toolsFor` at the start of a job and calls through `call`; every rule that
// can be decided here is decided here, from the server's own records and never from the model's words:
//   * nothing at all while the deployment switch is off;
//   * a tool is offered only when the owner enabled it (`read` or `write`), nothing is waiting for their review, the connection is theirs
//     and active, and the task's access allows it (`read` access offers only `read` tools);
//   * at the moment of a call the tool is checked AGAIN against the stored snapshot: the same tool, the same hash, the same mode. A tool the
//     owner switched off, or that a refresh changed, since the run started is refused, not called;
//   * arguments are redacted of every credential before they leave; the result is redacted, cleaned and capped before a model reads it.
import { Injectable, Logger } from '@nestjs/common';
import type { Connection, ConnectionMcpTool } from '@prisma/client';

import { PrismaService } from '../../prisma/prisma.service';
import { ConnectionTokensService } from '../connection-tokens.service';
import { ConnectionTokenStore } from '../connection-token.store';
import { McpClientError } from './mcp-client';
import { McpConnector } from './mcp-connector.service';
import { readMcpConfig } from './mcp-config';
import { redactArgs, redactSecrets, wasRedacted } from './mcp-redact';
import { normalizeResult } from './mcp-result';
import { McpSecretStore } from './mcp-secrets';
import { sanitizeDescription, sanitizeServerMessage, sanitizeTitle } from './mcp-text';
import { MCP_CALL_TIMEOUT_MS, MCP_MAX_TOOLS_PER_RUN, type McpToolMode } from './mcp.constants';

export interface McpRunTool {
  connectionId: string;
  connectionLabel: string;
  /** The server's own name for the tool: the only name a request to the server carries. */
  name: string;
  title: string | null;
  /** Sanitised and capped: what the model reads. */
  description: string;
  inputSchema: Record<string, unknown>;
  hash: string;
  mode: Exclude<McpToolMode, 'off'>;
}

export type McpCallOutcome =
  | { kind: 'ok'; text: string; isError: boolean; truncated: boolean; dropped: string; redacted: boolean }
  /** Nothing was sent: the call was not allowed (switch off, tool changed or switched off, connection unusable). */
  | { kind: 'refused'; text: string }
  /** The server could not do it. `unknown`: the request may have been carried out (a timeout, a broken connection): never retried blindly. */
  | { kind: 'failed'; text: string; unknown: boolean; code: string };

export interface CallOptions {
  /** What the run registered: the call is refused if the stored tool is no longer this one. */
  expect: { hash: string; mode: Exclude<McpToolMode, 'off'> };
  signal?: AbortSignal;
  /** The most characters of the result the model may read. */
  maxChars: number;
  timeoutMs?: number;
}

const FAILURE_TEXT: Record<string, string> = {
  url_refused: 'The address of this connection is no longer allowed. Tell the owner.',
  auth: 'The server no longer accepts this connection\'s sign-in. Tell the owner: they can sign in again in Settings → Connections.',
  forbidden: 'The server refused this call.',
  unavailable: 'The server could not be reached.',
  timeout: 'The server did not answer in time.',
  protocol: 'The server did not answer in the protocol.',
  too_large: 'The server answered with more than the size limit.',
  aborted: 'The call was cancelled.',
  redirect: 'The server redirected, which is not followed.',
  rpc: 'The server refused the call.',
};

@Injectable()
export class McpRunService {
  private readonly log = new Logger(McpRunService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly connector: McpConnector,
    private readonly secrets: McpSecretStore,
    private readonly store: ConnectionTokenStore,
    private readonly tokens: ConnectionTokensService,
  ) {}

  enabled(): Promise<boolean> {
    return this.connector.enabled();
  }

  /**
   * The tools a run may be offered from the connections it lists, in the order of the list and then by name, at most 40 in all. `access`
   * is the task's or chat's: `read` offers only the tools the owner marked read.
   */
  async toolsFor(userId: string, selections: readonly { connectionId: string; access: 'read' | 'read_write' }[]): Promise<McpRunTool[]> {
    if (selections.length === 0 || !(await this.enabled())) return [];
    const rows = await this.prisma.connection.findMany({ where: { userId, provider: 'mcp', status: 'active', id: { in: selections.map((s) => s.connectionId) } }, include: { mcpTools: { where: { mode: { not: 'off' }, review: null }, orderBy: { name: 'asc' } } } });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const out: McpRunTool[] = [];
    for (const sel of selections) {
      const row = byId.get(sel.connectionId);
      if (!row) continue;
      for (const t of row.mcpTools) {
        const mode = t.mode === 'read' ? 'read' : t.mode === 'write' ? 'write' : null;
        if (!mode || (mode === 'write' && sel.access !== 'read_write')) continue;
        out.push({ connectionId: row.id, connectionLabel: row.label, name: t.name, title: t.title ? sanitizeTitle(t.title) || null : null, description: sanitizeDescription(t.description), inputSchema: t.inputSchema as Record<string, unknown>, hash: t.hash, mode });
        if (out.length >= MCP_MAX_TOOLS_PER_RUN) return out;
      }
    }
    return out;
  }

  /** The stored tool and connection a call is about, checked against what the run registered; otherwise why it may not be called. */
  async check(userId: string, connectionId: string, name: string, expect: CallOptions['expect']): Promise<{ ok: true; row: Connection; tool: ConnectionMcpTool } | { ok: false; text: string }> {
    if (!(await this.enabled())) return { ok: false, text: 'MCP connections are switched off on this deployment. Tell the owner.' };
    const row = await this.prisma.connection.findFirst({ where: { id: connectionId, userId, provider: 'mcp' } });
    if (!row) return { ok: false, text: 'This connection no longer exists. Tell the owner and continue without it, or finish.' };
    if (row.status === 'paused') return { ok: false, text: `The connection "${row.label}" is paused by the owner. Tell the owner and continue without it, or finish.` };
    if (row.status !== 'active') return { ok: false, text: `The connection "${row.label}" must be connected again by the owner. Tell the owner and continue without it, or finish.` };
    const tool = await this.prisma.connectionMcpTool.findFirst({ where: { connectionId, name } });
    if (!tool || tool.mode === 'off') return { ok: false, text: 'The owner has switched this tool off. It was not called. Tell the owner if you need it.' };
    if (tool.review !== null || tool.hash !== expect.hash) return { ok: false, text: 'This tool changed after the owner approved it, so it is off until the owner reviews it. It was not called.' };
    if (tool.mode !== expect.mode) return { ok: false, text: 'The owner changed what this tool may do while this run was working. It was not called; it is available again in a new run.' };
    return { ok: true, row, tool };
  }

  /**
   * Every credential value that must never reach an MCP server or come back to a model: the owner's access and refresh tokens for every
   * connection, and every secret stored for an MCP server. Read at the moment of the call; never logged.
   */
  async exactSecrets(userId: string): Promise<string[]> {
    const conns = await this.prisma.connection.findMany({ where: { userId }, select: { id: true, provider: true } });
    const values: (string | null)[] = [];
    for (const c of conns) {
      values.push(await this.store.accessToken(userId, c.id).catch(() => null), await this.store.refreshToken(userId, c.id).catch(() => null));
      if (c.provider === 'mcp') values.push(await this.secrets.secret(userId, c.id).catch(() => null));
    }
    return [...new Set(values.filter((v): v is string => typeof v === 'string' && v.length >= 8))];
  }

  /** Calls one tool. `args` are already validated against the tool's schema by the caller; they are redacted here, deeply, before they leave. */
  async call(userId: string, connectionId: string, name: string, args: Record<string, unknown>, opts: CallOptions): Promise<McpCallOutcome> {
    const checked = await this.check(userId, connectionId, name, opts.expect);
    if (!checked.ok) return { kind: 'refused', text: checked.text };
    const { row } = checked;
    const secrets = await this.exactSecrets(userId);
    const outgoing = redactArgs(args, secrets);
    let opened;
    try {
      opened = await this.connector.open(row, { signal: opts.signal, timeoutMs: opts.timeoutMs ?? MCP_CALL_TIMEOUT_MS });
    } catch (e) {
      return this.failed(row, e, false);
    }
    try {
      const result = await opened.client.callTool(name, outgoing);
      const normalized = normalizeResult(result, opts.maxChars, secrets);
      await this.prisma.connection.updateMany({ where: { id: row.id }, data: { lastUsedAt: new Date(), ...(row.statusReason === 'UNAVAILABLE' ? { statusReason: null } : {}) } });
      // A server's own error text is the server's words: cleaned and short, like every message that is not a result.
      const text = result.isError ? sanitizeServerMessage(redactSecrets(normalized.text, secrets)) : normalized.text;
      return { kind: 'ok', text, isError: result.isError, truncated: normalized.truncated, dropped: normalized.dropped, redacted: wasRedacted(args, outgoing) };
    } catch (e) {
      return this.failed(row, e, true);
    } finally {
      await opened.client.close();
    }
  }

  /** `sent`: the request carrying the call may have reached the server. */
  private async failed(row: Connection, e: unknown, sent: boolean): Promise<McpCallOutcome> {
    if (!(e instanceof McpClientError)) {
      // A connection-level refusal (the sign-in cannot be refreshed, the switch went off): nothing was sent.
      const code = (e as { code?: unknown }).code;
      return { kind: 'failed', text: code === 'CONNECTION_NEEDS_RECONNECT' ? `The connection "${row.label}" must be connected again by the owner. Tell the owner.` : 'The call could not be made.', unknown: false, code: typeof code === 'string' ? code : 'ERROR' };
    }
    if (e.kind === 'auth') await this.tokens.markNeedsReconnect(row.userId, row.id, 'AUTH_REFUSED').catch(() => false);
    else if (e.kind !== 'aborted') await this.prisma.connection.updateMany({ where: { id: row.id, status: 'active' }, data: { statusReason: 'UNAVAILABLE' } }).catch(() => undefined);
    const unknown = sent && (e.kind === 'timeout' || e.kind === 'unavailable' || e.kind === 'too_large' || e.kind === 'protocol' || e.kind === 'aborted');
    const detail = e.kind === 'rpc' && e.extra.serverMessage ? ` It said: ${e.extra.serverMessage}` : '';
    return { kind: 'failed', text: `${FAILURE_TEXT[e.kind] ?? 'The call could not be made.'}${detail}`, unknown, code: e.kind };
  }
}
