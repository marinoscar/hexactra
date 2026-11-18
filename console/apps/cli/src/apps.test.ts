// `hexactra apps …` and `runs list --app` (#464), against a fake console API.
import { Command } from 'commander';
import { createCli } from '@marinoscar/platform-cli';
import { ApiClient } from '@marinoscar/platform-cli/api-client';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_CLI_OPTIONS } from './app.js';
import { appLine, findApp, limitsPatch, startedBy, type AppView } from './apps.js';
import { appsCommand } from './apps.command.js';
import { setConsoleApiFactory } from './console-api.js';
import { runsCommand } from './runs.command.js';

resetCliForTests();
createCli(APP_CLI_OPTIONS);

const CLIENT = 'aaaaaaaa-1111-4111-8111-111111111111';
const limits = { policyId: null, allowedPolicyIds: [], allowedDomains: [], maxConcurrentRuns: 2, dailyRunLimit: 50, dailyCostLimitUsd: null, confirmPurchases: true, paused: false };
const APP: AppView = {
  clientId: CLIENT,
  grantId: 'g1',
  name: 'chatgpt.com',
  displayName: 'ChatGPT',
  selfName: 'ChatGPT',
  host: 'chatgpt.com',
  verified: true,
  removed: false,
  connectedAt: '2026-11-01T10:00:00.000Z',
  lastUsedAt: null,
  scopes: [
    { id: 'runs:write', label: 'Delegate', consent: 'Give goals', risk: 'low' },
    { id: 'browser:drive', label: 'Drive browser', consent: 'Control a browser', risk: 'elevated' },
  ],
  limits,
  usage: { runs30d: 3, costUsd30d: 0.42, costKnown: true, lastRunAt: null, liveRuns: 0, runsToday: 1, costTodayUsd: 0.1 },
};

function fakeApi(routes: Record<string, unknown>) {
  const calls: { method: string; path: string; query: string; body: unknown }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = decodeURIComponent(url.pathname.replace(/^\/api/, ''));
    calls.push({ method, path, query: url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${method} ${path}`;
    if (!(key in routes)) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    return new Response(JSON.stringify({ data: routes[key] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  setConsoleApiFactory(() => new ApiClient({ baseUrl: 'http://console.example.test/api', token: 'pat_test', fetch }));
  return calls;
}

async function run(...args: string[]): Promise<string> {
  const program = new Command().exitOverride();
  appsCommand(program);
  runsCommand(program);
  let out = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    out += String(chunk);
    return true;
  });
  try {
    await program.parseAsync(['node', 'hexactra', ...args]);
  } finally {
    spy.mockRestore();
  }
  return out;
}

afterEach(() => setConsoleApiFactory(null));

describe('apps helpers', () => {
  it('finds an app by id, prefix, host or name', () => {
    expect(findApp([APP], CLIENT).clientId).toBe(CLIENT);
    expect(findApp([APP], 'aaaaaaaa').clientId).toBe(CLIENT);
    expect(findApp([APP], 'chatgpt').clientId).toBe(CLIENT);
    expect(findApp([APP], 'CHATGPT.COM').clientId).toBe(CLIENT);
    expect(() => findApp([APP], 'claude')).toThrow(/No connected AI app/);
  });

  it('builds a limits patch from the options given, and refuses nonsense', () => {
    expect(limitsPatch({})).toEqual({});
    expect(limitsPatch({ maxRuns: '3', dailyRuns: '20', dailyCost: '2.5', sites: 'a.test, b.test', confirm: false, policy: 'default' })).toEqual({
      maxConcurrentRuns: 3,
      dailyRunLimit: 20,
      dailyCostLimitUsd: 2.5,
      allowedDomains: ['a.test', 'b.test'],
      confirmPurchases: false,
      policyId: null,
    });
    expect(limitsPatch({ dailyCost: 'none', sites: '' })).toEqual({ dailyCostLimitUsd: null, allowedDomains: [] });
    expect(() => limitsPatch({ maxRuns: 'two' })).toThrow(/whole number/);
    expect(() => limitsPatch({ dailyCost: '-1' })).toThrow(/positive/);
  });

  it('says who started a run', () => {
    expect(startedBy({ origin: 'mcp', client: { name: 'chatgpt.com', verified: true } })).toBe('chatgpt.com');
    expect(startedBy({ origin: 'mcp', client: { name: 'Hermes', verified: false } })).toBe('Hermes?');
    expect(startedBy({ origin: 'web', client: null })).toBe('console');
    expect(startedBy({ origin: 'schedule' })).toBe('schedule');
    expect(appLine(APP)).toMatch(/aaaaaaaa {2}ChatGPT .* active .* 3 runs\/30d .* \$0\.42 .* Delegate, Drive browser!/);
  });
});

describe('hexactra apps', () => {
  it('list: one line per app, or how to connect one', async () => {
    fakeApi({ 'GET /connected-apps': [APP] });
    expect(await run('apps', 'list')).toMatch(/ChatGPT/);
    fakeApi({ 'GET /connected-apps': [] });
    expect(await run('apps', 'list')).toMatch(/No AI apps are connected/);
  });

  it('show: scopes, usage and limits', async () => {
    fakeApi({ 'GET /connected-apps': [APP] });
    const text = await run('apps', 'show', 'chatgpt');
    expect(text).toMatch(/ChatGPT/);
    expect(text).toMatch(/may: Delegate, Drive browser \(elevated\)/);
    expect(text).toMatch(/usage: 3 runs in 30 days, \$0\.42/);
    expect(text).toMatch(/runs per day: 50/);
  });

  it('pause and resume patch `paused`', async () => {
    const calls = fakeApi({ 'GET /connected-apps': [APP], [`PATCH /connected-apps/${CLIENT}/settings`]: { ...limits, paused: true } });
    expect(await run('apps', 'pause', 'chatgpt')).toMatch(/is paused/);
    expect(await run('apps', 'resume', 'chatgpt')).toMatch(/may start runs again/);
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ paused: true }, { paused: false }]);
  });

  it('disconnect revokes the grant through the platform route', async () => {
    const calls = fakeApi({ 'GET /connected-apps': [APP], 'DELETE /oauth/grants/g1': null });
    expect(await run('apps', 'disconnect', 'ChatGPT')).toMatch(/was disconnected/);
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: '/oauth/grants/g1' });
  });

  it('limits: shows without options, patches only what was given, resolves the policy', async () => {
    const calls = fakeApi({
      'GET /connected-apps': [APP],
      'GET /agent-policies': [{ id: 'builtin:economy', name: 'Economy', builtin: true }],
      [`PATCH /connected-apps/${CLIENT}/settings`]: { ...limits, dailyRunLimit: 10, policyId: 'builtin:economy' },
    });
    expect(await run('apps', 'limits', 'chatgpt')).toMatch(/runs at once: 2/);
    expect(calls.some((c) => c.method === 'PATCH')).toBe(false);
    const text = await run('apps', 'limits', 'chatgpt', '--daily-runs', '10', '--policy', 'economy', '--no-confirm');
    expect(text).toMatch(/\(saved\)/);
    expect(calls.find((c) => c.method === 'PATCH')!.body).toEqual({ dailyRunLimit: 10, policyId: 'builtin:economy', confirmPurchases: false });
  });

  it('check prints the MCP URL and what blocks a connection', async () => {
    fakeApi({
      'GET /connected-apps/preflight': {
        mcpUrl: 'https://console.example.test/api/mcp',
        ready: false,
        checks: [{ id: 'oauth_enabled', status: 'fail', title: 'Sign-in for AI apps is on', detail: 'The OAuth server is off.', fix: { who: 'admin', path: null, text: 'Ask your administrator to turn it on.' } }],
        clients: [{ id: 'chatgpt', allowed: false, hosts: ['chatgpt.com'], detail: 'Sign-in for AI apps is off.' }],
      },
    });
    const text = await run('apps', 'check');
    expect(text).toMatch(/MCP URL: https:\/\/console\.example\.test\/api\/mcp/);
    expect(text).toMatch(/fail {2}Sign-in for AI apps is on: The OAuth server is off\. Ask your administrator/);
    expect(text).toMatch(/chatgpt +blocked/);
  });

  it('runs list --app filters by the app and shows who started each run', async () => {
    const calls = fakeApi({
      'GET /connected-apps': [APP],
      'GET /runs': [{ id: 'r1234567-0000', status: 'succeeded', stepCount: 3, goal: 'Book a table', origin: 'mcp', client: { name: 'chatgpt.com', verified: true }, policy: null }],
    });
    const text = await run('runs', 'list', '--app', 'chatgpt');
    expect(calls.at(-1)!.query).toContain(`clientId=${CLIENT}`);
    expect(text).toMatch(/Book a table {2}\[chatgpt\.com\]/);
    await run('runs', 'list', '--origin', 'web,cli');
    expect(calls.at(-1)!.query).toContain('origin=web%2Ccli');
  });
});
