// Diagnostics of a connection (E50.10, #980): one staged report for every connection, stored in the history.
//
//   1. `status`              the row's status: paused warns, needs a reconnect or revoked fails (with its reason as the remedy);
//   2. `provider_installed`  the adapter (or the MCP module) is installed here and its deployment switch is on;
//   3. the provider's own stages, from the `DiagnosticsRegistry` or the adapter's `diagnose`; a provider with neither falls back to
//      today's test: `sign_in` then one `capability:<name>` probe per capability that is on (Google, Microsoft), or `server` (an MCP
//      server answers `initialize` and lists its tools);
//   4. `latency`             the total time, a warning over 5 s.
//
// It runs inline, bounded: 20 s for the report and 8 s per stage; the request's abort stops it. It changes nothing a test would not
// change (a refused sign-in may set `statusReason`; a due token is refreshed through the normal path, as the health job does for a
// paused connection): read calls only. A report holds codes, counts and timings, never content, a provider message, an address or a token.
import { Injectable, Logger } from '@nestjs/common';
import type { Connection } from '@prisma/client';

import { DiagnosticsHistory, type DiagnosticSummary, type StoredDiagnosticReport } from '../diagnostics/diagnostics-history.service';
import { DiagnosticsMetrics } from '../diagnostics/diagnostics.metrics';
import { DiagnosticsRegistry } from '../diagnostics/diagnostics.registry';
import { closedCode, overall, sanitizeStages, type Diagnosable, type DiagnosticStage, type DiagnosticTrigger } from '../diagnostics/diagnostic-report';
import { REMEDY_CODES } from '../diagnostics/remedies';
import { runStages, type StageOutcome, type StageStep } from '../diagnostics/stages';
import { PrismaService } from '../prisma/prisma.service';
import { isProviderId } from './connections.constants';
import { ConnectionError, notFound } from './connections.errors';
import { ConnectionApps } from './connection-apps.service';
import { ConnectionProviderRegistry } from './connection-provider.registry';
import { ConnectionTokensService } from './connection-tokens.service';
import { capabilitiesOf } from './connection-view';
import { McpConnectionsService } from './mcp/mcp-connections.service';
import { McpConnector } from './mcp/mcp-connector.service';

export const REPORT_DEADLINE_MS = 20_000;
export const STAGE_DEADLINE_MS = 8_000;
export const SLOW_AFTER_MS = 5_000;

/** The reasons a connection needs a reconnect (`statusReason`), each a remedy of its own. */
export const RECONNECT_REASONS = ['GRANT_REVOKED', 'NO_REFRESH_TOKEN', 'TOKEN_STORE_FAILED', 'AUTH_REFUSED', 'NO_SECRET'] as const;
/** What a refresh records on an active connection that it could not renew (connection-tokens.service.ts, `refreshFailed`). */
const REFRESH_ERRORS = ['UNAVAILABLE', 'APP_REFUSED', 'REFUSED', 'APP_NOT_CONFIGURED', 'NOT_INSTALLED', 'TOKEN_STORE_FAILED', 'AUTH_REFUSED'] as const;
/** The address and transport refusals of `OutboundHttp` and the MCP address rules, in upper case. */
const TRANSPORT_CODES = ['INVALID_URL', 'SCHEME_NOT_ALLOWED', 'USERINFO_NOT_ALLOWED', 'QUERY_NOT_ALLOWED', 'PORT_NOT_ALLOWED', 'PRIVATE_TARGET', 'UNRESOLVABLE', 'HOST_NOT_ALLOWED', 'HOST_BLOCKED', 'TIMEOUT', 'TOO_LARGE', 'NETWORK', 'ABORTED', 'REDIRECT', 'RPC'] as const;
/** What a capability probe answers (the adapters' `probe`), plus what a capability check may say. */
const PROBE_CODES = ['UNAUTHORIZED', 'FORBIDDEN', 'UNAVAILABLE', 'API_DISABLED', 'RATE_LIMITED', 'QUOTA_EXCEEDED', 'PERMISSION_MISSING', 'CAPABILITY_OFF', 'NO_MAILBOX', 'NOT_FOUND', 'FAILED'] as const;

/** Every code the generic stages and the fallback can return. Each has an entry in the remedy table (test/diagnostics.spec.ts). */
export const CONNECTION_DIAGNOSTIC_CODES: readonly string[] = [
  ...new Set([
    'CONNECTION_PAUSED',
    'CONNECTION_NEEDS_RECONNECT',
    ...RECONNECT_REASONS,
    ...REFRESH_ERRORS,
    'PROVIDER_DISABLED',
    'MCP_PROTOCOL',
    ...TRANSPORT_CODES,
    ...PROBE_CODES,
    'SLOW',
    'DEADLINE_EXCEEDED',
    'UNKNOWN',
  ]),
];
const GENERIC = new Set(CONNECTION_DIAGNOSTIC_CODES);
const PROBE = new Set<string>(PROBE_CODES);

/** What a registered `Diagnosable` of a connection gets (Google and Microsoft: E50.11; MCP: E50.12). */
export interface ConnectionDiagnosticTarget {
  connection: Connection;
  /** The access token through the normal path (refreshed when due). Throws `ConnectionError`. */
  accessToken(): Promise<string>;
}

export interface DiagnoseOptions {
  /** The request's abort (Stop). */
  signal?: AbortSignal;
  /** The health job already knows why the sign-in failed: the report says so without asking the provider again. */
  signInFailure?: unknown;
}

/** A thrown error as a closed code, with its reason as the remedy key. Never the error's message. */
export function outcomeOfError(e: unknown): StageOutcome {
  if (!(e instanceof ConnectionError)) return { status: 'fail', code: 'UNAVAILABLE' };
  const reason = typeof e.details?.reason === 'string' ? e.details.reason.toUpperCase() : '';
  switch (e.code) {
    case 'CONNECTION_PAUSED':
      return { status: 'fail', code: 'CONNECTION_PAUSED' };
    case 'CONNECTION_NEEDS_RECONNECT':
      return { status: 'fail', code: 'CONNECTION_NEEDS_RECONNECT', remedy: (RECONNECT_REASONS as readonly string[]).includes(reason) ? reason : 'CONNECTION_NEEDS_RECONNECT' };
    case 'CONNECTION_MCP_AUTH_REQUIRED':
      return { status: 'fail', code: 'AUTH_REFUSED' };
    case 'CONNECTION_MCP_PROTOCOL':
      return { status: 'fail', code: 'MCP_PROTOCOL' };
    case 'CONNECTION_MCP_URL_REFUSED':
      return { status: 'fail', code: closedCode(reason, GENERIC) };
    case 'CONNECTION_PROVIDER_UNAVAILABLE':
      return { status: 'fail', code: reason === 'DISABLED' ? 'PROVIDER_DISABLED' : reason === 'NOT_CONFIGURED' ? 'APP_NOT_CONFIGURED' : 'NOT_INSTALLED' };
    case 'CONNECTION_UNAVAILABLE': {
      const mapped: Record<string, string> = { NOT_CONFIGURED: 'APP_NOT_CONFIGURED', REFRESH_WAIT_TIMEOUT: 'TIMEOUT', ERROR: 'UNAVAILABLE', CONFIG: 'UNKNOWN' };
      const code = mapped[reason] ?? reason;
      return { status: 'fail', code: code && GENERIC.has(code) ? code : 'UNAVAILABLE' };
    }
    default:
      return { status: 'fail', code: 'UNKNOWN' };
  }
}

async function attempt(fn: () => Promise<StageOutcome>): Promise<StageOutcome> {
  try {
    return await fn();
  } catch (e) {
    return outcomeOfError(e);
  }
}

@Injectable()
export class ConnectionDiagnosticsService {
  private readonly log = new Logger(ConnectionDiagnosticsService.name);
  /** Tests shorten them. */
  reportDeadlineMs = REPORT_DEADLINE_MS;
  stageDeadlineMs = STAGE_DEADLINE_MS;
  clock: () => number = Date.now;

  constructor(
    private readonly prisma: PrismaService,
    private readonly adapters: ConnectionProviderRegistry,
    private readonly apps: ConnectionApps,
    private readonly tokens: ConnectionTokensService,
    private readonly mcp: McpConnectionsService,
    private readonly mcpConnector: McpConnector,
    private readonly registry: DiagnosticsRegistry,
    private readonly history: DiagnosticsHistory,
    private readonly metrics: DiagnosticsMetrics,
  ) {}

  private async mine(userId: string, id: string): Promise<Connection> {
    const row = await this.prisma.forUser({ userId }).connection.findFirst({ where: { id } });
    if (!row) throw notFound();
    return row;
  }

  /** `POST /connections/{id}/diagnose`: runs the report for the caller's own connection, stores it and returns it. */
  async diagnose(userId: string, id: string, trigger: DiagnosticTrigger, opts: DiagnoseOptions = {}): Promise<StoredDiagnosticReport> {
    return this.diagnoseRow(await this.mine(userId, id), trigger, opts);
  }

  /** The caller's last reports of one of their connections, newest first. */
  async historyOf(userId: string, id: string, limit?: number): Promise<StoredDiagnosticReport[]> {
    await this.mine(userId, id);
    return this.history.list(userId, 'connection', id, limit);
  }

  /** For each of the caller's connections with a report: the last overall status and time. */
  summary(userId: string): Promise<DiagnosticSummary[]> {
    return this.history.summary(userId, 'connection');
  }

  /** Runs, stores and counts a report of a connection row (the caller has checked it is theirs, or is the health job). */
  async diagnoseRow(row: Connection, trigger: DiagnosticTrigger, opts: DiagnoseOptions = {}): Promise<StoredDiagnosticReport> {
    const started = this.clock();
    const startedAt = new Date(started).toISOString();
    const deadline = AbortSignal.timeout(this.reportDeadlineMs);
    const signal = opts.signal ? AbortSignal.any([deadline, opts.signal]) : deadline;
    const base = { signal, stageTimeoutMs: this.stageDeadlineMs, abortCode: () => (opts.signal?.aborted ? 'ABORTED' : 'DEADLINE_EXCEEDED'), errorCode: (e: unknown) => outcomeOfError(e).code ?? 'UNAVAILABLE', clock: this.clock };

    const generic = await runStages([{ id: 'status', run: () => this.statusOutcome(row) }, { id: 'provider_installed', run: () => this.installedOutcome(row) }], base);
    const failedBefore = generic.some((s) => s.status === 'fail');
    const { stages: providerStages, codes } = await this.providerStages(row, trigger, opts, base, failedBefore);
    const all = [...generic, ...providerStages];
    const total = this.clock() - started;
    all.push({ id: 'latency', status: total > SLOW_AFTER_MS ? 'warn' : 'pass', code: total > SLOW_AFTER_MS ? 'SLOW' : null, remedy: total > SLOW_AFTER_MS ? 'SLOW' : null, ms: total });

    const { stages, dropped } = sanitizeStages(all, new Set([...GENERIC, ...codes]), REMEDY_CODES);
    if (dropped > 0) this.log.warn(`diagnostic: ${dropped} data value(s) refused and dropped (provider ${row.provider})`);
    const report = { target: { kind: 'connection' as const, id: row.id }, trigger, overall: overall(stages), startedAt, finishedAt: new Date(this.clock()).toISOString(), stages };
    const stored = await this.history.record(report, row.userId);
    this.metrics.run('connection', row.provider, report.overall);
    return stored;
  }

  private statusOutcome(row: Connection): StageOutcome {
    switch (row.status) {
      case 'active':
        // A refresh that failed on an active connection leaves its code: worth a warning, the provider may be down.
        return row.statusReason ? { status: 'warn', code: closedCode(row.statusReason, GENERIC) } : { status: 'pass' };
      case 'paused':
        return { status: 'warn', code: 'CONNECTION_PAUSED' };
      case 'needs_reconnect': {
        const reason = row.statusReason ?? '';
        return { status: 'fail', code: 'CONNECTION_NEEDS_RECONNECT', remedy: (RECONNECT_REASONS as readonly string[]).includes(reason) ? reason : 'CONNECTION_NEEDS_RECONNECT' };
      }
      default:
        return { status: 'fail', code: 'CONNECTION_NEEDS_RECONNECT' };
    }
  }

  private async installedOutcome(row: Connection): Promise<StageOutcome> {
    if (row.provider === 'mcp') return (await this.mcpConnector.enabled()) ? { status: 'pass' } : { status: 'fail', code: 'PROVIDER_DISABLED' };
    if (!isProviderId(row.provider)) return { status: 'fail', code: 'NOT_INSTALLED' };
    const r = await this.apps.readiness(row.provider);
    if (r === 'ready') return { status: 'pass' };
    return { status: 'fail', code: r === 'disabled' ? 'PROVIDER_DISABLED' : r === 'not_configured' ? 'APP_NOT_CONFIGURED' : 'NOT_INSTALLED' };
  }

  private accessToken(row: Connection, opts: DiagnoseOptions): () => Promise<string> {
    return () => {
      if (opts.signInFailure !== undefined) return Promise.reject(opts.signInFailure);
      // The health job keeps a paused connection's grant alive the same way: no refresh a normal path would not make.
      return this.tokens.getAccessToken(row.id, row.userId, { allowPaused: true });
    };
  }

  /** The provider's own stages, or the fallback. Returns the codes they may carry. */
  private async providerStages(
    row: Connection,
    trigger: DiagnosticTrigger,
    opts: DiagnoseOptions,
    base: Parameters<typeof runStages>[1],
    failedBefore: boolean,
  ): Promise<{ stages: DiagnosticStage[]; codes: readonly string[] }> {
    const adapter = isProviderId(row.provider) ? this.adapters.get(row.provider) : undefined;
    const registered = this.registry.get<ConnectionDiagnosticTarget>('connection', row.provider);
    const own: Diagnosable<ConnectionDiagnosticTarget> | undefined =
      registered ??
      (adapter?.diagnose
        ? {
            codes: adapter.diagnosticCodes ?? [],
            diagnose: (t, ctx) => adapter.diagnose!({ capabilities: capabilitiesOf(t.connection), grantedScopes: t.connection.grantedScopes, accessToken: t.accessToken, signal: ctx.signal }),
          }
        : undefined);

    if (own) {
      if (failedBefore) return { stages: [{ id: 'provider', status: 'skipped', code: null, remedy: null, ms: null }], codes: own.codes };
      let collected: DiagnosticStage[] | null = null;
      const [stage] = await runStages(
        [
          {
            id: 'provider',
            run: async (signal) => {
              collected = await own.diagnose({ connection: row, accessToken: this.accessToken(row, opts) }, { signal, trigger });
              return { status: 'pass' };
            },
          },
        ],
        { ...base, stageTimeoutMs: this.reportDeadlineMs },
      );
      // A provider's diagnose that threw or ran out of time is one failed stage; otherwise its own stages.
      return { stages: stage!.status === 'pass' && collected ? collected : [stage!], codes: own.codes };
    }

    const steps: StageStep[] =
      row.provider === 'mcp'
        ? [{ id: 'server', run: (signal) => attempt(async () => ({ status: 'pass', data: { tools: (await this.mcp.test(row.userId, row, { signal })).tools } })) }]
        : [
            { id: 'sign_in', run: () => attempt(async () => (await this.accessToken(row, opts)(), { status: 'pass' })) },
            ...capabilitiesOf(row).map(
              (capability): StageStep => ({
                id: `capability:${capability}`,
                independent: true,
                dependsOn: ['sign_in'],
                run: () =>
                  attempt(async () => {
                    if (!adapter) return { status: 'fail', code: 'NOT_INSTALLED' };
                    const r = await adapter.probe({ capability, accessToken: await this.accessToken(row, opts)() });
                    return r.ok ? { status: 'pass' } : { status: 'fail', code: closedCode(r.code, PROBE) };
                  }),
              }),
            ),
          ];
    return { stages: await runStages(steps, { ...base, failedBefore }), codes: [] };
  }
}
