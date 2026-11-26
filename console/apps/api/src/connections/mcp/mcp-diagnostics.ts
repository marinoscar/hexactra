// The staged diagnostics of an MCP server connection (E50.12, #982), registered with the `DiagnosticsRegistry` for `connection:mcp`. The
// generic stages (`status`, `provider_installed`, `latency`) are the connection report's own (connection-diagnostics.service.ts); these
// come between them, in order:
//
//   switch         `connections.mcp.enabled` is on                                    MCP_OFF
//   address        the URL's shape and the administrator's host lists                 INVALID_URL, HOST_NOT_ALLOWED, HOST_BLOCKED, ...
//   network        the name resolves to a public address, and a connection is made    UNRESOLVABLE, PRIVATE_TARGET, TLS_FAILED, TIMEOUT, NETWORK
//   initialize     the server answers `initialize`: `data.revision`, `data.server_name` NOT_AN_MCP_SERVER, REVISION_NOT_SPOKEN (`data.offered`), UNAVAILABLE
//   sign_in        the sign-in kept for it is accepted (an OAuth token refreshed when due) AUTH_REFUSED, GRANT_REVOKED, SECRET_MISSING, OAUTH_DISCOVERY_FAILED
//   tool_list      `tools/list` answers: `data.count`, `data.pages`                    TOOL_LIST_FAILED, TOO_MANY_TOOLS (warn)
//   tool_changes   the listing against the stored hashes, STORING NOTHING              TOOLS_CHANGED (warn)
//   enabled_tools  how many tools the owner switched on                                NO_TOOL_ENABLED (warn)
//   offered_cap    the owner's enabled tools of every server against one run's cap     TOOLS_NOT_OFFERED (warn)
//
// `offered_cap` (decision, recorded in docs/connections.md): E50.17 offers every enabled tool, behind `open_toolbox` over the cap, so there is
// no `OVER_RUN_CAP`: the stage passes and says whether the tools open on demand (`data.toolbox`). What can still keep an enabled tool from a
// run is a schema the runner cannot offer; the stage names how many (`data.not_offered`) instead of letting them drop silently.
//
// A diagnostic is read-only for the catalogue: it never changes a tool's mode, hash or review flag (only "Refresh tools" does). Like the
// connection test, a sign-in the server refuses sets `statusReason` (`AUTH_REFUSED`), and a due OAuth token is refreshed through the normal
// path. `data` holds counts, the revision, a host name and the cleaned server name; never a tool name, a description or a server's message.
import { Injectable, type OnModuleInit } from '@nestjs/common';

import { DiagnosticsRegistry } from '../../diagnostics/diagnostics.registry';
import type { Diagnosable, DiagnoseContext, DiagnosticStage, StageData } from '../../diagnostics/diagnostic-report';
import { runStages, type StageOutcome, type StageStep } from '../../diagnostics/stages';
import { OutboundHttp, OutboundHttpError } from '../../oauth-client';
import { PrismaService } from '../../prisma/prisma.service';
import { ConnectionApps } from '../connection-apps.service';
import type { ConnectionDiagnosticTarget } from '../connection-diagnostics.service';
import { ConnectionError } from '../connections.errors';
import { McpClientError, type McpClient } from './mcp-client';
import { readMcpConfig, type McpConfig } from './mcp-config';
import { McpConnector } from './mcp-connector.service';
import { sanitizeServerMessage } from './mcp-text';
import { planRefresh, type McpToolDescriptor } from './mcp-tools';
import { checkHostLists, McpUrlError, normalizeMcpUrl } from './mcp-url';
import { offeredParameters } from './mcp-validate';
import { MCP_MAX_TOOLS, MCP_MAX_TOOLS_PER_RUN, type McpToolMode, type McpToolReview } from './mcp.constants';

export const MCP_STAGE_IDS = ['switch', 'address', 'network', 'initialize', 'sign_in', 'tool_list', 'tool_changes', 'enabled_tools', 'offered_cap'] as const;
export type McpStageId = (typeof MCP_STAGE_IDS)[number];

/** Every code these stages can return. Each has an entry in the remedy table (test/diagnostics.spec.ts). */
export const MCP_DIAGNOSTIC_CODES: readonly string[] = [
  'MCP_OFF',
  'INVALID_URL',
  'SCHEME_NOT_ALLOWED',
  'USERINFO_NOT_ALLOWED',
  'QUERY_NOT_ALLOWED',
  'PORT_NOT_ALLOWED',
  'HOST_NOT_ALLOWED',
  'HOST_BLOCKED',
  'UNRESOLVABLE',
  'PRIVATE_TARGET',
  'TLS_FAILED',
  'TIMEOUT',
  'NETWORK',
  'TOO_LARGE',
  'ABORTED',
  'REDIRECT',
  'NOT_AN_MCP_SERVER',
  'REVISION_NOT_SPOKEN',
  'UNAVAILABLE',
  'RPC',
  'AUTH_REFUSED',
  'GRANT_REVOKED',
  'SECRET_MISSING',
  'OAUTH_DISCOVERY_FAILED',
  'NO_REFRESH_TOKEN',
  'TOKEN_STORE_FAILED',
  'CONNECTION_PAUSED',
  'CONNECTION_NEEDS_RECONNECT',
  'TOOL_LIST_FAILED',
  'TOO_MANY_TOOLS',
  'TOOLS_CHANGED',
  'NO_TOOL_ENABLED',
  'TOOLS_NOT_OFFERED',
  'DEADLINE_EXCEEDED',
  'UNKNOWN',
];

/** A system error code of a failed TLS handshake or certificate check (Node's `ERR_TLS_*`, OpenSSL's `CERT_*`, `EPROTO`, ...). */
const TLS_NET_CODE = /^(EPROTO|ERR_SSL_|ERR_TLS_|CERT_|UNABLE_TO_|DEPTH_ZERO_|SELF_SIGNED_|HOSTNAME_MISMATCH|ERR_OSSL_)|_CERT/;

/** Where an error of the exchange belongs, and its code. */
export interface McpFailure {
  stage: 'address' | 'network' | 'initialize' | 'sign_in' | 'tool_list';
  code: string;
  data?: StageData;
}

/**
 * THE mapping of a failure to a stage and a code (a table test covers every `McpClientError` kind). `during` is the request that failed:
 * a JSON-RPC error or a reply outside the protocol to `tools/list` is `TOOL_LIST_FAILED`, to `initialize` it is the server's.
 */
export function mcpFailure(e: unknown, during: 'initialize' | 'tool_list'): McpFailure {
  if (e instanceof McpUrlError) return urlFailure(e.code);
  if (e instanceof OutboundHttpError) return urlFailure(e.code);
  if (e instanceof ConnectionError) return { stage: 'sign_in', code: signInCode(e) };
  if (!(e instanceof McpClientError)) return { stage: during, code: 'UNKNOWN' };
  switch (e.kind) {
    case 'url_refused':
      return urlFailure(e.extra.urlCode ?? 'invalid_url');
    case 'auth':
    case 'forbidden':
      return { stage: 'sign_in', code: 'AUTH_REFUSED' };
    case 'timeout':
      return { stage: during === 'initialize' ? 'network' : 'tool_list', code: 'TIMEOUT' };
    case 'aborted':
      return { stage: during, code: 'ABORTED' };
    case 'too_large':
      return { stage: during, code: 'TOO_LARGE' };
    case 'redirect':
      return { stage: during, code: 'REDIRECT' };
    case 'unavailable':
      // An HTTP answer (429, 5xx) is the server's; no answer at all is the network's.
      if (e.extra.status !== undefined) return { stage: during, code: during === 'initialize' ? 'UNAVAILABLE' : 'TOOL_LIST_FAILED' };
      return { stage: 'network', code: e.extra.netCode && TLS_NET_CODE.test(e.extra.netCode) ? 'TLS_FAILED' : 'NETWORK' };
    case 'protocol':
      if (during === 'tool_list') return { stage: 'tool_list', code: 'TOOL_LIST_FAILED' };
      if (e.extra.protocolReason === 'revision') return { stage: 'initialize', code: 'REVISION_NOT_SPOKEN', ...(e.extra.offered ? { data: { offered: e.extra.offered } } : {}) };
      return { stage: 'initialize', code: 'NOT_AN_MCP_SERVER' };
    case 'rpc':
      return { stage: during, code: during === 'initialize' ? 'RPC' : 'TOOL_LIST_FAILED' };
    default:
      return { stage: during, code: 'UNKNOWN' };
  }
}

function urlFailure(code: string): McpFailure {
  const upper = code.toUpperCase();
  const network = ['PRIVATE_TARGET', 'UNRESOLVABLE', 'TIMEOUT', 'NETWORK', 'TOO_LARGE', 'ABORTED'];
  if (network.includes(upper)) return { stage: 'network', code: upper };
  return { stage: 'address', code: MCP_DIAGNOSTIC_CODES.includes(upper) ? upper : 'INVALID_URL' };
}

/** A sign-in the console could not produce (no secret, a refused grant, OAuth metadata it no longer has). */
export function signInCode(e: ConnectionError): string {
  const reason = typeof e.details?.reason === 'string' ? e.details.reason.toUpperCase() : '';
  switch (e.code) {
    case 'CONNECTION_NEEDS_RECONNECT':
      if (reason === 'NO_SECRET') return 'SECRET_MISSING';
      return ['GRANT_REVOKED', 'NO_REFRESH_TOKEN', 'TOKEN_STORE_FAILED', 'AUTH_REFUSED'].includes(reason) ? reason : 'CONNECTION_NEEDS_RECONNECT';
    case 'CONNECTION_PAUSED':
      return 'CONNECTION_PAUSED';
    case 'CONNECTION_MCP_AUTH_REQUIRED':
      return 'AUTH_REFUSED';
    case 'CONNECTION_UNAVAILABLE':
      // The refresher could not use the server's authorization server: its metadata or registered client is missing or refused.
      if (reason === 'APP_REFUSED' || reason === 'INVALID_CLIENT' || reason === 'DISCOVERY') return 'OAUTH_DISCOVERY_FAILED';
      if (reason === 'TIMEOUT' || reason === 'REFRESH_WAIT_TIMEOUT') return 'TIMEOUT';
      return 'UNAVAILABLE';
    default:
      return 'UNKNOWN';
  }
}

/** The server's name as a `data` value: plain, capped, letters, digits and `. _ : -` only (spaces become `-`); null when nothing is left. */
export function serverNameData(raw: string | null): string | null {
  if (!raw) return null;
  const v = sanitizeServerMessage(raw)
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[^A-Za-z0-9._:-]+/g, '-')
    .replace(/^[^A-Za-z0-9]+|-+$/g, '')
    .slice(0, 60);
  return v || null;
}

const pass = (data?: StageData): StageOutcome => ({ status: 'pass', ...(data ? { data } : {}) });
const fail = (f: McpFailure | { code: string; data?: StageData }): StageOutcome => ({ status: 'fail', code: f.code, ...(f.data ? { data: f.data } : {}) });

interface Session {
  /** The console could not produce the sign-in (no request carried one). */
  signInError: unknown;
  /** The health job already knows the sign-in failed: the server is not contacted. */
  contactSkipped: boolean;
  client: McpClient | null;
  connectError: unknown;
}

@Injectable()
export class McpDiagnostics implements Diagnosable<ConnectionDiagnosticTarget>, OnModuleInit {
  readonly codes = MCP_DIAGNOSTIC_CODES;
  /** The deadline of the whole exchange with the server (each stage has its own, shorter one). */
  exchangeTimeoutMs = 15_000;

  constructor(
    private readonly registry: DiagnosticsRegistry,
    private readonly prisma: PrismaService,
    private readonly apps: ConnectionApps,
    private readonly connector: McpConnector,
    private readonly http: OutboundHttp,
  ) {}

  onModuleInit(): void {
    this.registry.register<ConnectionDiagnosticTarget>('connection', 'mcp', this);
  }

  async diagnose(target: ConnectionDiagnosticTarget, ctx: DiagnoseContext): Promise<DiagnosticStage[]> {
    const row = target.connection;
    const cfg = readMcpConfig(row.config);
    let session: Promise<Session> | null = null;
    let listed: { tools: McpToolDescriptor[]; pages: number; overCap: boolean } | null = null;

    const headers = async (c: McpConfig): Promise<Record<string, string>> =>
      // OAuth through the connection's own path (a paused connection is diagnosed too, and the health job's known failure is reused).
      c.auth.kind === 'oauth' ? { authorization: `Bearer ${await target.accessToken()}` } : this.connector.headers(row, c);

    const open = (c: McpConfig): Promise<Session> =>
      (session ??= (async () => {
        let signInError: unknown = null;
        let auth: Record<string, string> = {};
        try {
          auth = await headers(c);
        } catch (e) {
          signInError = e;
        }
        if (signInError !== null && ctx.trigger === 'health_job') return { signInError, contactSkipped: true, client: null, connectError: null };
        // Without a sign-in the console could produce, the server is still asked to `initialize` (nothing secret is sent): what it
        // answers says whether the address, the network and the protocol are good, so the report points at the sign-in alone.
        try {
          const client = await this.connector.openWith(c.url, async () => auth, { signal: ctx.signal, timeoutMs: this.exchangeTimeoutMs });
          return { signInError, contactSkipped: false, client, connectError: null };
        } catch (e) {
          return { signInError, contactSkipped: false, client: null, connectError: e };
        }
      })());

    const steps: StageStep[] = [
      { id: 'switch', run: async () => ((await this.connector.enabled()) ? pass() : fail({ code: 'MCP_OFF' })) },
      {
        id: 'address',
        run: async () => {
          if (!cfg) return fail({ code: 'INVALID_URL' });
          try {
            const url = normalizeMcpUrl(cfg.url);
            const host = new URL(url).hostname;
            checkHostLists(host, await this.apps.mcp());
            return pass({ host: host.slice(0, 200) });
          } catch (e) {
            return fail(e instanceof McpUrlError ? urlFailure(e.code) : { code: 'INVALID_URL' });
          }
        },
      },
      {
        id: 'network',
        run: async () => {
          try {
            await this.http.check(cfg!.url);
          } catch (e) {
            return fail(e instanceof OutboundHttpError ? urlFailure(e.code) : { code: 'NETWORK' });
          }
          const s = await open(cfg!);
          if (s.contactSkipped) return pass({ connected: false });
          if (s.connectError) {
            const f = mcpFailure(s.connectError, 'initialize');
            if (f.stage === 'network' || f.stage === 'address') return fail(f);
          }
          return pass({ connected: true });
        },
      },
      {
        id: 'initialize',
        run: async () => {
          const s = await open(cfg!);
          if (s.contactSkipped) return { status: 'skipped' };
          if (s.connectError) {
            const f = mcpFailure(s.connectError, 'initialize');
            // A server that wants a sign-in before it answers `initialize`: the sign-in stage says why.
            return f.stage === 'sign_in' ? { status: 'skipped' } : fail(f);
          }
          const name = serverNameData(s.client!.serverInfo.name);
          return pass({ revision: s.client!.protocolVersion ?? 'unknown', ...(name ? { server_name: name } : {}) });
        },
      },
      {
        id: 'sign_in',
        run: async () => {
          const s = await open(cfg!);
          if (s.signInError !== null) return fail({ code: s.signInError instanceof ConnectionError ? signInCode(s.signInError) : 'UNKNOWN' });
          if (s.connectError) {
            const f = mcpFailure(s.connectError, 'initialize');
            if (f.stage === 'sign_in') {
              await this.prisma.connection.updateMany({ where: { id: row.id, status: 'active' }, data: { statusReason: 'AUTH_REFUSED' } }).catch(() => undefined);
              return fail(f);
            }
          }
          return pass({ kind: cfg!.auth.kind });
        },
      },
      {
        id: 'tool_list',
        run: async () => {
          const s = await open(cfg!);
          try {
            listed = await s.client!.listTools();
          } catch (e) {
            const f = mcpFailure(e, 'tool_list');
            if (f.stage === 'sign_in') await this.prisma.connection.updateMany({ where: { id: row.id, status: 'active' }, data: { statusReason: 'AUTH_REFUSED' } }).catch(() => undefined);
            return fail(f.stage === 'tool_list' ? f : { code: f.code });
          }
          const data = { count: listed.tools.length, pages: listed.pages };
          return listed.overCap ? { status: 'warn', code: 'TOO_MANY_TOOLS', data: { ...data, cap: MCP_MAX_TOOLS } } : pass(data);
        },
      },
      {
        id: 'tool_changes',
        dependsOn: ['tool_list'],
        run: async () => {
          // Compared, never stored: the stored tools, their modes, hashes and review flags stay exactly as they are.
          const current = await this.prisma.connectionMcpTool.findMany({ where: { connectionId: row.id }, select: { name: true, hash: true, mode: true, review: true, approvedHash: true } });
          const plan = planRefresh(
            current.map((t) => ({ name: t.name, hash: t.hash, mode: t.mode as McpToolMode, review: (t.review as McpToolReview | null) ?? null, approvedHash: t.approvedHash })),
            listed!.tools,
            false,
          );
          const data = { changed: plan.update.length, new: plan.create.length, removed: plan.remove.length };
          return data.changed + data.new + data.removed > 0 ? { status: 'warn', code: 'TOOLS_CHANGED', data } : pass(data);
        },
      },
      {
        id: 'enabled_tools',
        independent: true,
        run: async () => {
          const rows = await this.prisma.connectionMcpTool.findMany({ where: { connectionId: row.id, mode: { not: 'off' }, review: null }, select: { mode: true } });
          const data = { read: rows.filter((t) => t.mode === 'read').length, write: rows.filter((t) => t.mode === 'write').length };
          return data.read + data.write === 0 ? { status: 'warn', code: 'NO_TOOL_ENABLED', data } : pass(data);
        },
      },
      {
        id: 'offered_cap',
        independent: true,
        run: async () => {
          // Every enabled tool of every active server of the owner is offered to every run and chat (E50.17).
          const all = await this.prisma.connectionMcpTool.findMany({
            where: { mode: { not: 'off' }, review: null, connection: { userId: row.userId, provider: 'mcp', status: 'active' } },
            select: { connectionId: true, hash: true, inputSchema: true },
          });
          const mine = all.filter((t) => t.connectionId === row.id);
          const notOffered = mine.filter((t) => !offeredParameters(t.hash, (t.inputSchema ?? {}) as Record<string, unknown>)).length;
          const data = { enabled: all.length, cap: MCP_MAX_TOOLS_PER_RUN, toolbox: all.length > MCP_MAX_TOOLS_PER_RUN, not_offered: notOffered };
          return notOffered > 0 ? { status: 'warn', code: 'TOOLS_NOT_OFFERED', data } : pass(data);
        },
      },
    ];

    try {
      return await runStages(steps, {
        signal: ctx.signal,
        stageTimeoutMs: 8_000,
        abortCode: () => 'DEADLINE_EXCEEDED',
        errorCode: (e) => mcpFailure(e, 'initialize').code,
      });
    } finally {
      const s = session ? await (session as Promise<Session>).catch(() => null) : null;
      await s?.client?.close().catch(() => undefined);
    }
  }
}
