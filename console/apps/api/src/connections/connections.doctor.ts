// The Doctor's view of connections (E50.13, #983): the deployment's Google and Microsoft apps, the users' accounts, the daily health
// job and MCP servers, plus their egress entries. Read-only, as the Doctor requires: settings, counts, the last DEPLOYMENT report of
// a provider's app in `connection_diagnostics` (target kind `provider_app`, written by `diagnoseApp`, E50.11) and the jobs table.
// No call to a provider or a server, no write, no audit row, no job, and nothing that identifies an owner: never a user, an account
// address, a label or a server's URL path (host names only, in the egress list).
//
//   connections.google_app / connections.microsoft_app
//       pass  the switch is on and the app is configured (and its last app test passed); or the provider is off / not installed
//       warn  on, but the last app test warned, is older than 30 days, or (once app tests exist) was never run
//       fail  on and not configured, or the last app test failed
//   connections.accounts      pass: active accounts by provider; warn: accounts that need reconnecting, by provider
//   connections.health_job    pass: `connections.health` succeeded in the last 26 h (or had nothing to do); warn: it did not; fail: its last run failed
//   connections.mcp           pass: the switch and active servers; warn: servers that are unavailable or refused, or whose last stored
//                             diagnosis (E50.12) failed, and tools changed awaiting review
import { Injectable, type OnModuleInit } from '@nestjs/common';
import { DoctorCheckRegistry, EgressRegistry, egressDependency, type DoctorCheck, type DoctorCheckOutcome, type EgressContributor, type EgressDependency } from '@marinoscar/platform-api/doctor';

import { DiagnosticsHistory } from '../diagnostics/diagnostics-history.service';
import { DiagnosticsRegistry } from '../diagnostics/diagnostics.registry';
import { PrismaService } from '../prisma/prisma.service';
import { GOOGLE } from './google/google.constants';
import { GRAPH_BASE, LOGIN_BASE } from './microsoft/microsoft.constants';
import { ConnectionApps } from './connection-apps.service';
import { CONNECTION_PROVIDER_IDS, type ConnectionProviderId } from './connections.constants';
import { CONNECTIONS_HEALTH_JOB, ConnectionsHealth } from './connections.jobs';
import { PROVIDER_INFO } from './provider-info';

/** Where an administrator configures connections. */
export const CONNECTIONS_SETTINGS_PATH = '/admin/settings/connections';
/** An app report older than this warns. */
export const APP_REPORT_STALE_DAYS = 30;
/** The health job runs daily: older than this warns. */
export const HEALTH_JOB_STALE_HOURS = 26;
/** The MCP `statusReason` codes Doctor counts as a server in trouble. */
export const MCP_TROUBLE_REASONS = ['UNAVAILABLE', 'AUTH_REFUSED'] as const;
/** At most this many MCP hosts in the egress list. */
export const MCP_EGRESS_HOSTS = 20;

const DAY_MS = 86_400_000;
const FAILED = { status: 'fail', detail: 'The check could not run.', remedy: 'Look at the API log for the connections check.' } as const;
const plural = (n: number, one: string, many = `${one}s`) => `${n} ${n === 1 ? one : many}`;

/** The hosts each provider's adapter calls (from its constants: the adapter talks to these and nothing else). */
export const PROVIDER_HOSTS: Record<ConnectionProviderId, readonly string[]> = {
  google: [...new Set(Object.values(GOOGLE).map((u) => new URL(u).hostname))],
  microsoft: [...new Set([LOGIN_BASE, GRAPH_BASE].map((u) => new URL(u).hostname))],
};

@Injectable()
abstract class ProviderAppCheck implements DoctorCheck, OnModuleInit {
  abstract readonly provider: ConnectionProviderId;
  abstract readonly id: string;
  abstract readonly label: string;
  readonly category = 'connections';
  readonly settingsPath = CONNECTIONS_SETTINGS_PATH;
  /** The wall clock; tests replace it. */
  clock: () => number = Date.now;

  constructor(
    private readonly doctor: DoctorCheckRegistry,
    private readonly apps: ConnectionApps,
    private readonly history: DiagnosticsHistory,
    private readonly diagnostics: DiagnosticsRegistry,
  ) {}

  onModuleInit(): void {
    this.doctor.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    try {
      const name = PROVIDER_INFO[this.provider].displayName;
      this.apps.invalidate();
      const readiness = await this.apps.readiness(this.provider);
      if (readiness === 'not_installed') return { status: 'pass', detail: `${name} connections are not installed on this deployment.`, data: { installed: false } };
      if (readiness === 'disabled') return { status: 'pass', detail: `${name} connections are switched off.`, data: { enabled: false } };
      if (readiness === 'not_configured') {
        return { status: 'fail', detail: `${name} connections are on, but the deployment's app has no client id or secret.`, remedy: `Finish the ${name} app in Administration → Connections, then press Test.`, data: { enabled: true, configured: false } };
      }
      // The provider's app test (E50.11) is the hook: while none is registered, a configured app passes on its settings alone.
      const testable = this.diagnostics.get('provider_app', this.provider) !== undefined;
      const last = await this.history.lastDeployment('provider_app', this.provider);
      const ageDays = last ? Math.floor((this.clock() - Date.parse(last.at)) / DAY_MS) : null;
      const data = { enabled: true, configured: true, lastReport: last?.overall ?? 'none', lastReportDays: ageDays };
      if (last?.overall === 'fail') return { status: 'fail', detail: `The last test of the ${name} app failed.`, remedy: `Open Administration → Connections, read the failed stage of the ${name} app and press Test after fixing it.`, data };
      if (last?.overall === 'warn') return { status: 'warn', detail: `The last test of the ${name} app warned.`, remedy: `Open Administration → Connections and read the stage of the ${name} app that warned.`, data };
      if (ageDays !== null && ageDays > APP_REPORT_STALE_DAYS) return { status: 'warn', detail: `The last test of the ${name} app is ${ageDays} days old.`, remedy: `Press Test on the ${name} app in Administration → Connections.`, data };
      if (!last && testable) return { status: 'warn', detail: `The ${name} app is configured but was never tested.`, remedy: `Press Test on the ${name} app in Administration → Connections.`, data };
      return { status: 'pass', detail: last ? `The ${name} app is configured; its last test passed.` : `The ${name} app is configured.`, data };
    } catch {
      return FAILED;
    }
  }
}

@Injectable()
export class GoogleAppCheck extends ProviderAppCheck {
  readonly provider = 'google' as const;
  readonly id = 'connections.google_app';
  readonly label = 'Google app';
}

@Injectable()
export class MicrosoftAppCheck extends ProviderAppCheck {
  readonly provider = 'microsoft' as const;
  readonly id = 'connections.microsoft_app';
  readonly label = 'Microsoft app';
}

@Injectable()
export class ConnectionAccountsCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'connections.accounts';
  readonly label = 'Connected accounts';
  readonly category = 'connections';
  readonly settingsPath = CONNECTIONS_SETTINGS_PATH;

  constructor(
    private readonly doctor: DoctorCheckRegistry,
    private readonly prisma: PrismaService,
  ) {}

  onModuleInit(): void {
    this.doctor.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    try {
      const rows = await this.prisma.connection.groupBy({ by: ['provider', 'status'], where: { provider: { in: [...CONNECTION_PROVIDER_IDS] } }, _count: { _all: true } });
      const count = (provider: string, status: string) => rows.find((r) => r.provider === provider && r.status === status)?._count._all ?? 0;
      const data: Record<string, number> = {};
      for (const p of CONNECTION_PROVIDER_IDS) {
        data[`${p}Active`] = count(p, 'active');
        data[`${p}NeedsReconnect`] = count(p, 'needs_reconnect');
      }
      const by = (suffix: string) => CONNECTION_PROVIDER_IDS.map((p) => `${PROVIDER_INFO[p].displayName} ${data[`${p}${suffix}`]}`).join(', ');
      const needs = CONNECTION_PROVIDER_IDS.reduce((a, p) => a + data[`${p}NeedsReconnect`]!, 0);
      if (needs > 0) {
        return {
          status: 'warn',
          detail: `${plural(needs, 'account needs', 'accounts need')} reconnecting (${by('NeedsReconnect')}): the provider refused the saved grant. The agent falls back to the browser or asks.`,
          remedy: 'Each owner connects the account again on their Connections page; they were notified once.',
          data,
        };
      }
      return { status: 'pass', detail: `Active accounts: ${by('Active')}.`, data };
    } catch {
      return FAILED;
    }
  }
}

@Injectable()
export class ConnectionsHealthJobCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'connections.health_job';
  readonly label = 'Connections health job';
  readonly category = 'connections';
  readonly settingsPath = '/admin/jobs';
  /** The wall clock; tests replace it. */
  clock: () => number = Date.now;

  constructor(
    private readonly doctor: DoctorCheckRegistry,
    private readonly prisma: PrismaService,
    private readonly health: ConnectionsHealth,
  ) {}

  onModuleInit(): void {
    this.doctor.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    try {
      const last = await this.prisma.job.findFirst({ where: { type: CONNECTIONS_HEALTH_JOB, status: { in: ['succeeded', 'failed'] } }, orderBy: [{ finishedAt: { sort: 'desc', nulls: 'last' } }, { createdAt: 'desc' }], select: { status: true, finishedAt: true } });
      if (last?.status === 'failed') return { status: 'fail', detail: `The last run of ${CONNECTIONS_HEALTH_JOB} failed.`, remedy: 'Open it under Administration → Jobs and read its error.', data: { lastRun: 'failed' } };
      const hours = last?.finishedAt ? Math.floor((this.clock() - last.finishedAt.getTime()) / 3_600_000) : null;
      if (hours !== null && hours <= HEALTH_JOB_STALE_HOURS) return { status: 'pass', detail: `${CONNECTIONS_HEALTH_JOB} ran ${hours} hour${hours === 1 ? '' : 's'} ago.`, data: { lastRun: 'succeeded', hoursAgo: hours } };
      // The daily task enqueues the job only when some connection is idle: with none, not running is right.
      const idle = (await this.health.idle(new Date(this.clock()), 1)).length;
      if (idle === 0) return { status: 'pass', detail: `No connection is idle: ${CONNECTIONS_HEALTH_JOB} has nothing to do.`, data: { lastRun: last ? 'succeeded' : 'never', hoursAgo: hours, idle: 0 } };
      return {
        status: 'warn',
        detail: hours === null ? `${CONNECTIONS_HEALTH_JOB} has never run, and idle connections are waiting for it.` : `${CONNECTIONS_HEALTH_JOB} has not run in ${hours} hours, and idle connections are waiting for it.`,
        remedy: 'Check that the API and its scheduler are running and look at Administration → Jobs; idle tokens may expire.',
        data: { lastRun: last ? 'succeeded' : 'never', hoursAgo: hours, idle },
      };
    } catch {
      return FAILED;
    }
  }
}

@Injectable()
export class McpServersCheck implements DoctorCheck, OnModuleInit {
  readonly id = 'connections.mcp';
  readonly label = 'MCP servers';
  readonly category = 'connections';
  readonly settingsPath = CONNECTIONS_SETTINGS_PATH;

  constructor(
    private readonly doctor: DoctorCheckRegistry,
    private readonly prisma: PrismaService,
    private readonly apps: ConnectionApps,
    private readonly history: DiagnosticsHistory,
  ) {}

  onModuleInit(): void {
    this.doctor.register(this);
  }

  async run(): Promise<DoctorCheckOutcome> {
    try {
      this.apps.invalidate();
      const [mcp, live, trouble, changed] = await Promise.all([
        this.apps.mcp(),
        this.prisma.connection.findMany({ where: { provider: 'mcp', status: 'active' }, select: { id: true }, take: 5_000 }),
        this.prisma.connection.count({ where: { provider: 'mcp', status: { in: ['active', 'needs_reconnect'] }, statusReason: { in: [...MCP_TROUBLE_REASONS] } } }),
        this.prisma.connectionMcpTool.count({ where: { review: 'changed' } }),
      ]);
      const active = live.length;
      // The stored history of the servers' diagnoses (E50.12's `McpDiagnostics`): how many last reports failed. A count only.
      const failedReports = (await this.history.lastOverallCounts('connection', live.map((c) => c.id))).fail;
      const data = { enabled: mcp.enabled, active, troubled: trouble, toolsChanged: changed, lastReportFailed: failedReports };
      if (trouble > 0 || changed > 0 || failedReports > 0) {
        const parts = [
          ...(trouble > 0 ? [`${plural(trouble, 'server')} unavailable or refusing the sign-in`] : []),
          ...(failedReports > 0 ? [`${plural(failedReports, 'server')} whose last diagnosis failed`] : []),
          ...(changed > 0 ? [`${plural(changed, 'tool')} changed and switched off until the owner reviews ${changed === 1 ? 'it' : 'them'}`] : []),
        ];
        return { status: 'warn', detail: `MCP servers are ${mcp.enabled ? 'on' : 'off'}: ${parts.join('; ')}.`, remedy: 'Each owner tests the server or reviews its tools on their Connections page.', data };
      }
      return { status: 'pass', detail: mcp.enabled ? `MCP servers are on: ${plural(active, 'active server')}.` : 'MCP servers are switched off for the deployment.', data };
    } catch {
      return FAILED;
    }
  }
}

/** The hosts connections call: each provider's API hosts (with its switch) and the distinct hosts of the users' MCP servers. */
@Injectable()
export class ConnectionsEgressContributor implements EgressContributor, OnModuleInit {
  readonly id = 'connections';

  constructor(
    private readonly egress: EgressRegistry,
    private readonly prisma: PrismaService,
    private readonly apps: ConnectionApps,
  ) {}

  onModuleInit(): void {
    this.egress.register(this);
  }

  /** The host of each live MCP server's address: host names only, never a path, a query or who added it. */
  private async mcpHosts(): Promise<string[]> {
    const rows = await this.prisma.connection.findMany({ where: { provider: 'mcp', status: { in: ['active', 'paused', 'needs_reconnect'] } }, select: { config: true }, orderBy: { createdAt: 'asc' }, take: 500 });
    const hosts = new Set<string>();
    for (const r of rows) {
      const url = (r.config as { url?: unknown } | null)?.url;
      if (typeof url !== 'string') continue;
      try {
        hosts.add(new URL(url).hostname.toLowerCase());
      } catch {
        // not an address: left out
      }
      if (hosts.size >= MCP_EGRESS_HOSTS) break;
    }
    return [...hosts];
  }

  async describe(): Promise<EgressDependency[]> {
    const s = await this.apps.system();
    const out: EgressDependency[] = CONNECTION_PROVIDER_IDS.map((p) =>
      egressDependency({
        id: `connections.${p}`,
        capability: `${PROVIDER_INFO[p].displayName} accounts (mail, calendar, documents)`,
        direction: 'server',
        enabled: s[p].enabled,
        required: false,
        hosts: [...PROVIDER_HOSTS[p]],
        degradation: 'The agent cannot use these accounts; tasks fall back to the browser or ask',
        settingsPath: CONNECTIONS_SETTINGS_PATH,
      }),
    );
    out.push(
      egressDependency({
        id: 'connections.mcp',
        capability: "MCP servers (the owners' own tools)",
        direction: 'server',
        enabled: s.mcp.enabled,
        required: false,
        hosts: await this.mcpHosts(),
        degradation: 'The agent cannot use these tools',
        settingsPath: CONNECTIONS_SETTINGS_PATH,
      }),
    );
    return out;
  }
}
