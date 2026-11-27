// `hexactra search …` (E50.15, #985): status, on/off, providers, test, query, keys and the administrator's settings. A key is read from a
// hidden prompt or standard input only, never an argument, and never printed.
import { createCli } from '@marinoscar/platform-cli';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_CLI_OPTIONS } from './app.js';
import { setConsoleApiFactory } from './console-api.js';
import type { DiagnosticReportView } from './diagnostics.js';
import { fakeApi, runCommand } from './fake-api.test-support.js';
import { setKeyReaders, webSearchCommand } from './web-search.command.js';
import { adminPatch, type ServiceCredentialView, type WebSearchProviderView, type WebSearchStatusView } from './web-search.js';

resetCliForTests();
createCli(APP_CLI_OPTIONS);

const run = (...args: string[]) => runCommand(webSearchCommand, ...args);
const KEY = 'BSA-test-key-0123456789abcdef';

const ON: WebSearchStatusView = { enabled: true, reason: null, provider: { id: 'brave', label: 'Brave Search', tier: 'system' }, today: { calls: 12, limit: 300, remaining: 288 }, perRunLimit: 30 };
const BRAVE: WebSearchProviderView = {
  id: 'brave',
  label: 'Brave Search',
  kind: 'results',
  credential: 'api_key',
  needsKey: true,
  enabled: true,
  listed: true,
  keyTier: 'user',
  keys: { user: true, organization: false, system: true },
  estimatedCostPerCallUsd: 0.005,
};

function readers(over: Partial<{ hidden: string; stdin: string; tty: boolean }> = {}) {
  const r = { hidden: vi.fn(async () => over.hidden ?? KEY), stdin: vi.fn(async () => over.stdin ?? KEY), isTTY: () => over.tty ?? true };
  setKeyReaders(r);
  return r;
}

afterEach(() => {
  setConsoleApiFactory(null);
  setKeyReaders(null);
  process.exitCode = undefined;
});

describe('hexactra search status, on, off and providers', () => {
  it('says on, the provider and the tier of its key, and today\'s count and limit', async () => {
    fakeApi({ 'GET /web-search/status': ON });
    const text = await run('search', 'status');
    expect(text).toContain('Web search: on');
    expect(text).toContain("Brave Search (brave), the deployment's key");
    expect(text).toContain('Today: 12 of 300 searches (288 left)');
    fakeApi({ 'GET /web-search/status': { ...ON, enabled: false, reason: 'no_key', provider: null, today: { calls: 0, limit: null, remaining: null }, perRunLimit: null } });
    const off = await run('search', 'status');
    expect(off).toContain('Web search: off: no search provider has a key you can use');
    expect(off).toContain('0 of unlimited');
    fakeApi({ 'GET /web-search/status': ON });
    expect(JSON.parse(await run('search', 'status', '--json'))).toEqual(ON);
  });

  it('switches your own setting on and off, then prints the status', async () => {
    const calls = fakeApi({ 'PATCH /user-settings': {}, 'GET /web-search/status': ON });
    await run('search', 'off');
    expect(await run('search', 'on')).toContain('Web search: on');
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ webSearch: { enabled: false } }, { webSearch: { enabled: true } }]);
  });

  it('lists the providers and whether each is usable', async () => {
    fakeApi({ 'GET /web-search/providers': [BRAVE, { ...BRAVE, id: 'searxng', label: 'SearXNG', needsKey: false, keyTier: null, enabled: false, estimatedCostPerCallUsd: null }, { ...BRAVE, id: 'other', keyTier: null }] });
    const text = await run('search', 'providers');
    expect(text).toMatch(/brave .*usable, your own key .*\$0\.005 a search \(estimate\)/);
    expect(text).toMatch(/searxng .*switched off by your administrator/);
    expect(text).toMatch(/other .*no key you can use/);
  });
});

describe('hexactra search test', () => {
  const report = (overall: 'pass' | 'fail'): DiagnosticReportView => ({
    id: '88888888-8888-4888-8888-888888888888',
    target: { kind: 'search_provider', id: 'brave' },
    trigger: 'owner',
    overall,
    startedAt: '2026-11-26T10:00:00.000Z',
    finishedAt: '2026-11-26T10:00:02.000Z',
    stages: [
      { id: 'network', status: 'pass', code: null, remedy: null, ms: 40, data: { host: 'api.search.brave.com' } },
      overall === 'pass' ? { id: 'live_query', status: 'pass', code: null, remedy: null, ms: 300, data: { hits: 5 } } : { id: 'live_query', status: 'fail', code: 'UNAVAILABLE', remedy: 'UNAVAILABLE', ms: 300 },
    ],
  });

  it('runs your diagnostic (with --provider as a query) and exits 0 on pass, 1 on fail', async () => {
    const calls = fakeApi({ 'POST /web-search/diagnose': report('pass') });
    const text = await run('search', 'test', '--provider', 'brave');
    expect(text).toContain('ok    Network');
    expect(text).toContain('ok    A live search');
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/web-search/diagnose', query: { provider: 'brave' } });
    expect(process.exitCode).toBe(0);
    fakeApi({ 'POST /web-search/diagnose': report('fail') });
    expect(await run('search', 'test')).toContain('FAIL  A live search  (UNAVAILABLE');
    expect(process.exitCode).toBe(1);
    fakeApi({ 'POST /web-search/diagnose': report('pass') });
    expect(JSON.parse(await run('search', 'test', '--json'))).toEqual(report('pass'));
  });

  it("tests the deployment's key for an administrator, and exits 2 when it could not run", async () => {
    const calls = fakeApi({ 'POST /web-search/admin/providers/brave/diagnose': report('pass') });
    await run('search', 'test', '--deployment', '--provider', 'brave');
    expect(calls.at(-1)!.path).toBe('/web-search/admin/providers/brave/diagnose');
    await expect(run('search', 'test', '--deployment')).rejects.toThrow(/needs --provider/);
    fakeApi({}, { 'POST /web-search/diagnose': { status: 403, body: { message: 'Forbidden' } } });
    await expect(run('search', 'test')).rejects.toMatchObject({ exitCode: 2 });
  });
});

describe('hexactra search query', () => {
  it('prints numbered titles, addresses and excerpts, and sends the options', async () => {
    const calls = fakeApi({
      'POST /web-search/search': { provider: 'brave', answer: null, hits: [{ title: 'Example  Domain', url: 'https://example.test/', snippet: 'An example\npage.', publishedAt: null }] },
    });
    const text = await run('search', 'query', 'example domain', '--count', '3', '--site', 'example.test', '--freshness', 'week');
    expect(text).toContain(' 1. Example Domain\n    https://example.test/\n    An example page.');
    expect(text).toContain('(answered by brave)');
    expect(calls.at(-1)!.body).toEqual({ query: 'example domain', count: 3, site: 'example.test', freshness: 'week' });
    await expect(run('search', 'query', 'x', '--freshness', 'decade')).rejects.toThrow(/day, week, month or year/);
    await expect(run('search', 'query', 'x', '--count', '50')).rejects.toThrow(/1 to 20/);
  });
});

describe('hexactra search key and keys', () => {
  it('refuses a key passed as an argument, and sends nothing', async () => {
    const calls = fakeApi({});
    const r = readers();
    await expect(run('search', 'key', 'set', 'brave', KEY)).rejects.toThrow(/never passed as an argument/);
    expect(calls).toEqual([]);
    expect(r.hidden).not.toHaveBeenCalled();
  });

  it('reads the key from a hidden prompt, stores your own key, and never prints it', async () => {
    const calls = fakeApi({ 'PUT /service-credentials/web_search/brave': null });
    const r = readers();
    const text = await run('search', 'key', 'set', 'brave');
    expect(r.hidden).toHaveBeenCalledWith(expect.stringContaining('not shown'));
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', path: '/service-credentials/web_search/brave', body: { value: KEY } });
    expect(text).toContain('stored your own key for brave');
    expect(text).not.toContain(KEY);
  });

  it('reads from standard input with --stdin; --deployment and --org pick the tier', async () => {
    const calls = fakeApi({ 'PUT /service-credentials/admin/web_search/brave': null, 'PUT /service-credentials/org/web_search/brave': null, 'DELETE /service-credentials/admin/web_search/brave': null });
    const r = readers({ tty: false });
    expect(await run('search', 'key', 'set', 'brave', '--stdin', '--deployment')).toContain("stored the deployment's key");
    expect(r.stdin).toHaveBeenCalled();
    expect(r.hidden).not.toHaveBeenCalled();
    await run('search', 'key', 'set', 'brave', '--stdin', '--org');
    expect(await run('search', 'key', 'rm', 'brave', '--deployment')).toContain("removed the deployment's key for brave");
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['PUT /service-credentials/admin/web_search/brave', 'PUT /service-credentials/org/web_search/brave', 'DELETE /service-credentials/admin/web_search/brave']);
  });

  it('refuses without a terminal or --stdin, an empty key and both tiers at once', async () => {
    const calls = fakeApi({});
    readers({ tty: false });
    await expect(run('search', 'key', 'set', 'brave')).rejects.toThrow(/--stdin/);
    readers({ stdin: '' });
    await expect(run('search', 'key', 'set', 'brave', '--stdin')).rejects.toThrow(/nothing was stored/);
    await expect(run('search', 'key', 'set', 'brave', '--org', '--deployment')).rejects.toThrow(/not both/);
    await expect(run('search', 'key', 'set', 'Not A Provider')).rejects.toThrow(/not a provider id/);
    expect(calls).toEqual([]);
  });

  it('lists which tiers hold a search key, never a key', async () => {
    const cred: ServiceCredentialView = {
      service: 'web_search',
      name: 'brave',
      label: 'Brave Search',
      binding: 'credential_store',
      tier: 'user',
      tiers: { user: { available: true, set: true, setAt: '2026-11-20T08:00:00.000Z' }, organization: { available: false, set: false, setAt: null }, system: { available: true, set: true, setAt: null } },
    };
    fakeApi({ 'GET /service-credentials': [cred, { ...cred, service: 'other' }] });
    const text = await run('search', 'keys');
    expect(text.trim().split('\n')).toHaveLength(1);
    expect(text).toContain('stored: user (2026-11-20), deployment');
    expect(text).toContain('used: your own key');
  });
});

describe('hexactra search admin', () => {
  it('turns a field and a value into the settings body', () => {
    expect(adminPatch('enabled', 'off')).toEqual({ enabled: false });
    expect(adminPatch('order', 'brave, searxng')).toEqual({ order: ['brave', 'searxng'] });
    expect(adminPatch('limits.perUserPerDay', 'unlimited')).toEqual({ limits: { perUserPerDay: null } });
    expect(adminPatch('limits.perRun', '10')).toEqual({ limits: { perRun: 10 } });
    expect(adminPatch('fetch.blockedHosts', 'none')).toEqual({ fetch: { blockedHosts: [] } });
    expect(adminPatch('providers.brave.enabled', 'on')).toEqual({ providers: { brave: { enabled: true } } });
    expect(adminPatch('providers.brave.costPerCallUsd', 'default')).toEqual({ providers: { brave: { costPerCallUsd: null } } });
    expect(() => adminPatch('limits.perRun', '-1')).toThrow(/whole number/);
    expect(() => adminPatch('enabled', 'maybe')).toThrow(/on or off/);
    expect(() => adminPatch('nope', '1')).toThrow(/Unknown field/);
  });

  const VIEW = {
    enabled: true,
    providers: {},
    order: ['brave'],
    shareDeploymentKey: true,
    allowUserKeys: true,
    limits: { perRun: 30, perUserPerDay: 300, fetchPerRun: 30 },
    fetch: { enabled: true, blockedHosts: [] },
    installed: [{ id: 'brave', label: 'Brave Search', credential: 'api_key', hosts: ['api.search.brave.com'], defaultEstimatedCostPerCallUsd: 0.005 }],
  };

  it('shows and sets the settings, and prints the usage', async () => {
    const calls = fakeApi({ 'GET /web-search/admin': VIEW, 'PUT /web-search/admin': { ...VIEW, limits: { ...VIEW.limits, perRun: 10 } }, 'GET /web-search/admin/usage': [{ day: '2026-11-25', provider: 'brave', calls: 40, failures: 1, estimatedCostUsd: 0.2 }] });
    expect(await run('search', 'admin', 'show')).toContain('providers.brave  on, ~$0.005 a search (estimate)');
    expect(await run('search', 'admin', 'set', 'limits.perRun', '10')).toContain('limits.perRun        10');
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', path: '/web-search/admin', body: { limits: { perRun: 10 } } });
    expect(await run('search', 'admin', 'usage', '--days', '7')).toContain('2026-11-25  brave             40 searches     1 failed  ~$0.20');
    expect(calls.at(-1)!.query).toEqual({ days: '7' });
  });
});
