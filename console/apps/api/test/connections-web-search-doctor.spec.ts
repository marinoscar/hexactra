// The Doctor lines of connections, MCP servers and web search (E50.13, #983): a pass, a warn and a fail for each of the six checks,
// over fakes that offer READ methods only (a write, or any outbound call, would throw), and the egress entries. Nothing in an outcome
// names a user, an account address, a label or a URL path.
import { DoctorCheckRegistry, EgressRegistry } from '@marinoscar/platform-api/doctor';

import { ConnectionAccountsCheck, ConnectionsEgressContributor, ConnectionsHealthJobCheck, GoogleAppCheck, McpServersCheck, MicrosoftAppCheck } from '../src/connections/connections.doctor';
import { resolveConnectionsSystemSettings } from '../src/connections/connections.settings';
import { DiagnosticsRegistry } from '../src/diagnostics/diagnostics.registry';
import type { DiagnosticSummary } from '../src/diagnostics/diagnostics-history.service';
import { SearchProviderRegistry } from '../src/web-search/search-provider';
import { FakeSearchProvider } from '../src/web-search/testing/fake-search-provider';
import { WebSearchEgressContributor, WebSearchProviderCheck } from '../src/web-search/web-search.doctor';
import { resolveWebSearchSystemSettings, type WebSearchSystemSettings } from '../src/web-search/web-search.settings';
import type { ProviderReadiness } from '../src/connections/connection-apps.service';

const NOW = Date.parse('2026-11-26T12:00:00Z');
const DAY = 86_400_000;

/** Only read methods: a write would be `undefined is not a function`. Every call is logged. */
function readOnly<T extends Record<string, Record<string, (...a: never[]) => unknown>>>(models: T) {
  const calls: string[] = [];
  const proxy = new Proxy(models, {
    get(target, model: string) {
      const m = target[model];
      if (!m) throw new Error(`model ${model} not offered`);
      return new Proxy(m, {
        get(mt, method: string) {
          if (!/^(find|count|aggregate|groupBy)/.test(method)) throw new Error(`write ${model}.${method} attempted`);
          calls.push(`${model}.${method}`);
          return mt[method];
        },
      });
    },
  });
  return { prisma: proxy as never, calls };
}

const doctor = () => ({ register: jest.fn() }) as unknown as DoctorCheckRegistry;
const lastReport = (overall: string | null, daysAgo = 1) => ({ lastDeployment: async (): Promise<DiagnosticSummary | null> => (overall ? { targetId: 'x', overall: overall as never, at: new Date(NOW - daysAgo * DAY).toISOString() } : null) });

function apps(readiness: ProviderReadiness, over: Parameters<typeof resolveConnectionsSystemSettings>[0] = {}) {
  return { invalidate: jest.fn(), readiness: async () => readiness, system: async () => resolveConnectionsSystemSettings(over), mcp: async () => resolveConnectionsSystemSettings(over).mcp };
}

describe('connections.google_app and connections.microsoft_app', () => {
  const check = (readiness: ProviderReadiness, overall: string | null, opts: { daysAgo?: number; testable?: boolean } = {}) => {
    const reg = new DiagnosticsRegistry();
    if (opts.testable) reg.register('provider_app', 'google', { codes: [], diagnose: async () => [] });
    const c = new GoogleAppCheck(doctor(), apps(readiness) as never, lastReport(overall, opts.daysAgo) as never, reg);
    c.clock = () => NOW;
    return c.run();
  };

  it('pass: off, not installed, configured (no app test yet), or the last app test passed', async () => {
    expect(await check('disabled', null)).toMatchObject({ status: 'pass', detail: expect.stringContaining('switched off') });
    expect(await check('not_installed', null)).toMatchObject({ status: 'pass' });
    expect(await check('ready', null)).toMatchObject({ status: 'pass', data: { configured: true, lastReport: 'none' } });
    expect(await check('ready', 'pass', { testable: true })).toMatchObject({ status: 'pass', data: { lastReport: 'pass', lastReportDays: 1 } });
  });

  it('warn: the last app test warned, is older than 30 days, or was never run once app tests exist', async () => {
    expect((await check('ready', 'warn')).status).toBe('warn');
    expect(await check('ready', 'pass', { daysAgo: 31 })).toMatchObject({ status: 'warn', data: { lastReportDays: 31 } });
    expect(await check('ready', null, { testable: true })).toMatchObject({ status: 'warn', detail: expect.stringContaining('never tested') });
  });

  it('fail: on and not configured, or the last app test failed; and the check that cannot run', async () => {
    expect(await check('not_configured', null)).toMatchObject({ status: 'fail', remedy: expect.stringContaining('Administration') });
    expect((await check('ready', 'fail')).status).toBe('fail');
    const broken = new MicrosoftAppCheck(doctor(), { invalidate: jest.fn(), readiness: async () => Promise.reject(new Error('db')) } as never, lastReport(null) as never, new DiagnosticsRegistry());
    expect(await broken.run()).toMatchObject({ status: 'fail', detail: 'The check could not run.' });
    expect(broken).toMatchObject({ id: 'connections.microsoft_app', category: 'connections', settingsPath: '/admin/settings/connections' });
  });
});

describe('connections.accounts', () => {
  const run = (rows: { provider: string; status: string; n: number }[] | Error) => {
    const { prisma, calls } = readOnly({ connection: { groupBy: async () => (rows instanceof Error ? Promise.reject(rows) : rows.map((r) => ({ provider: r.provider, status: r.status, _count: { _all: r.n } }))) } });
    return { out: new ConnectionAccountsCheck(doctor(), prisma).run(), calls };
  };

  it('pass: active accounts by provider; warn: some need reconnecting, by provider; fail: it could not run', async () => {
    const pass = await run([{ provider: 'google', status: 'active', n: 3 }, { provider: 'microsoft', status: 'active', n: 1 }]).out;
    expect(pass).toEqual({ status: 'pass', detail: 'Active accounts: Google 3, Microsoft 1.', data: { googleActive: 3, googleNeedsReconnect: 0, microsoftActive: 1, microsoftNeedsReconnect: 0 } });
    const warn = await run([{ provider: 'google', status: 'active', n: 3 }, { provider: 'google', status: 'needs_reconnect', n: 2 }]).out;
    expect(warn).toMatchObject({ status: 'warn', detail: expect.stringContaining('2 accounts need reconnecting (Google 2, Microsoft 0)'), data: { googleNeedsReconnect: 2 } });
    expect((await run(new Error('db')).out).status).toBe('fail');
  });
});

describe('connections.health_job', () => {
  const run = (job: { status: string; finishedAt: Date | null } | null, idle: number | Error = 1) => {
    const { prisma } = readOnly({ job: { findFirst: async () => job } });
    const health = { idle: async () => (idle instanceof Error ? Promise.reject(idle) : Array.from({ length: idle }, () => ({ id: 'c', userId: 'u' }))) };
    const c = new ConnectionsHealthJobCheck(doctor(), prisma, health as never);
    c.clock = () => NOW;
    return c.run();
  };

  it('pass: ran in the last 26 hours, or nothing was idle; warn: it did not run; fail: its last run failed', async () => {
    expect(await run({ status: 'succeeded', finishedAt: new Date(NOW - 5 * 3_600_000) })).toMatchObject({ status: 'pass', data: { hoursAgo: 5 } });
    expect(await run(null, 0)).toMatchObject({ status: 'pass', data: { lastRun: 'never', idle: 0 } });
    expect(await run({ status: 'succeeded', finishedAt: new Date(NOW - 30 * 3_600_000) })).toMatchObject({ status: 'warn', detail: expect.stringContaining('30 hours') });
    expect(await run(null)).toMatchObject({ status: 'warn', detail: expect.stringContaining('never run') });
    expect(await run({ status: 'failed', finishedAt: new Date(NOW - 3_600_000) })).toMatchObject({ status: 'fail', data: { lastRun: 'failed' } });
    expect((await run(null, new Error('db'))).status).toBe('fail');
  });
});

describe('connections.mcp', () => {
  const run = (counts: { active: number; trouble: number; changed: number } | Error, enabled = true) => {
    const fail = counts instanceof Error;
    const { prisma } = readOnly({
      connection: { count: async (q: { where: { statusReason?: unknown } }) => (fail ? Promise.reject(counts) : q.where.statusReason ? counts.trouble : counts.active) },
      connectionMcpTool: { count: async () => (fail ? 0 : counts.changed) },
    });
    return new McpServersCheck(doctor(), prisma, apps('ready', { mcp: { enabled } }) as never).run();
  };

  it('pass: the switch and the active servers; warn: unavailable or refusing servers, changed tools; fail: it could not run', async () => {
    expect(await run({ active: 2, trouble: 0, changed: 0 })).toEqual({ status: 'pass', detail: 'MCP servers are on: 2 active servers.', data: { enabled: true, active: 2, troubled: 0, toolsChanged: 0 } });
    expect(await run({ active: 0, trouble: 0, changed: 0 }, false)).toMatchObject({ status: 'pass', detail: 'MCP servers are switched off for the deployment.' });
    expect(await run({ active: 2, trouble: 1, changed: 3 })).toMatchObject({ status: 'warn', detail: expect.stringContaining('1 server unavailable or refusing the sign-in; 3 tools changed'), data: { troubled: 1, toolsChanged: 3 } });
    expect((await run(new Error('db'))).status).toBe('fail');
  });
});

describe('web_search.provider', () => {
  const run = (opts: { settings?: WebSearchSystemSettings; key?: boolean; last?: string | null; daysAgo?: number; usage?: { calls: number; failures: number }; broken?: boolean } = {}) => {
    const registry = new SearchProviderRegistry();
    registry.register(new FakeSearchProvider('alpha'));
    const service = { invalidate: jest.fn(), system: async () => (opts.broken ? Promise.reject(new Error('x')) : resolveWebSearchSystemSettings(opts.settings ?? { order: ['alpha'] })) };
    const yesterday = new Date(NOW - DAY).toISOString().slice(0, 10);
    const usage = { totals: async () => (opts.usage ? [{ day: yesterday, provider: 'alpha', calls: opts.usage.calls, failures: opts.usage.failures, estimatedCostUsd: 0 }] : []) };
    const creds = { describe: jest.fn(async () => (opts.key === false ? null : { updatedAt: new Date() })) };
    const c = new WebSearchProviderCheck(doctor(), registry, service as never, lastReport(opts.last === undefined ? 'pass' : opts.last, opts.daysAgo) as never, usage as never, creds as never);
    c.clock = () => NOW;
    return { out: c.run(), creds };
  };

  it('pass: a deployment key and a passing last report; or search is off (says so)', async () => {
    const r = run();
    expect(await r.out).toMatchObject({ status: 'pass', data: { provider: 'alpha', deploymentKey: true, lastReport: 'pass' } });
    expect(r.creds.describe).toHaveBeenCalledWith('service_credential', 'web_search.alpha');
    expect(await run({ settings: { enabled: false } }).out).toMatchObject({ status: 'pass', detail: expect.stringContaining('switched off') });
  });

  it('warn: no deployment key, the last report warned, is old or missing, or yesterday failed over 20%', async () => {
    expect(await run({ key: false }).out).toMatchObject({ status: 'warn', detail: expect.stringContaining('each user needs their own key') });
    expect((await run({ last: 'warn' }).out).status).toBe('warn');
    expect((await run({ daysAgo: 40 }).out).status).toBe('warn');
    expect(await run({ last: null }).out).toMatchObject({ status: 'warn', detail: expect.stringContaining('never tested') });
    expect(await run({ usage: { calls: 10, failures: 3 } }).out).toMatchObject({ status: 'warn', data: { callsYesterday: 10, failuresYesterday: 3 } });
    expect((await run({ usage: { calls: 10, failures: 2 } }).out).status).toBe('pass');
  });

  it('fail: a key is set and the last report failed; and the check that cannot run', async () => {
    expect((await run({ last: 'fail' }).out).status).toBe('fail');
    expect((await run({ broken: true }).out).status).toBe('fail');
  });
});

describe('the egress entries', () => {
  it('connections: the providers\' API hosts with their switch; MCP: the distinct hosts of the servers, host names only', async () => {
    const rows = [{ config: { url: 'https://mcp.example.test/private/path?x=1' } }, { config: { url: 'https://mcp.example.test/other' } }, { config: { url: 'https://tools.example.test/mcp' } }, { config: null }];
    const { prisma } = readOnly({ connection: { findMany: async () => rows } });
    const egress = { register: jest.fn() } as unknown as EgressRegistry;
    const list = await new ConnectionsEgressContributor(egress, prisma, apps('ready', { mcp: { enabled: true }, providers: { google: { enabled: true }, microsoft: { enabled: false } } }) as never).describe();
    expect(list.map((d) => [d.id, d.enabled])).toEqual([['connections.google', true], ['connections.microsoft', false], ['connections.mcp', true]]);
    expect(list[0]!.hosts).toEqual(expect.arrayContaining(['oauth2.googleapis.com', 'gmail.googleapis.com', 'www.googleapis.com']));
    expect(list[1]!.hosts).toEqual(expect.arrayContaining(['login.microsoftonline.com', 'graph.microsoft.com']));
    expect(list[2]!.hosts).toEqual(['mcp.example.test', 'tools.example.test']);
    expect(list[0]!.degradation).toBe('The agent cannot use these accounts; tasks fall back to the browser or ask');
    expect(JSON.stringify(list)).not.toMatch(/private|path|x=1/);
  });

  it("web search: each provider's hosts plus the fetch check's page host", async () => {
    const registry = new SearchProviderRegistry();
    registry.register(new FakeSearchProvider('alpha'));
    const service = { system: async () => resolveWebSearchSystemSettings({ order: ['alpha'] }) };
    const list = await new WebSearchEgressContributor({ register: jest.fn() } as never, registry, service as never).describe();
    expect(list).toEqual([expect.objectContaining({ id: 'web_search.alpha', enabled: true, hosts: ['alpha.search.example.test', 'example.com'] })]);
  });
});
