// `hexactra mcp status|enable|disable` (#465), against a fake console API.
import { Command } from 'commander';
import { createCli } from '@marinoscar/platform-cli';
import { ApiClient } from '@marinoscar/platform-cli/api-client';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_CLI_OPTIONS } from './app.js';
import { setConsoleApiFactory } from './console-api.js';
import { mcpCommand, statusLines, switchPatch, type McpStatusView } from './mcp.command.js';

resetCliForTests();
createCli(APP_CLI_OPTIONS);

const STATUS: McpStatusView = {
  externalAppsEnabled: true,
  patMcpEnabled: false,
  oauthEnabled: true,
  mcpUrl: 'https://console.example.test/api/mcp',
  publicHttps: true,
  connectedApps: 3,
  connectedUsers: 2,
  highRiskGrants: 1,
};

function fakeApi(routes: Record<string, unknown>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = url.pathname.replace(/^\/api/, '');
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${method} ${path}`;
    if (!(key in routes)) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    return new Response(JSON.stringify({ data: routes[key] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  setConsoleApiFactory(() => new ApiClient({ baseUrl: 'http://console.example.test/api', token: 'pat_test', fetch }));
  return calls;
}

async function run(...args: string[]): Promise<string> {
  const program = new Command().exitOverride();
  mcpCommand(program);
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

describe('hexactra mcp status|enable|disable (#465)', () => {
  it('status reads /admin/mcp/status and says what is on, the URL check and the counts', async () => {
    const calls = fakeApi({ 'GET /admin/mcp/status': STATUS });
    const out = await run('mcp', 'status');
    expect(calls).toEqual([{ method: 'GET', path: '/admin/mcp/status', body: undefined }]);
    expect(out).toContain('External AI apps (OAuth): on');
    expect(out).toContain('Personal access tokens over MCP: OFF');
    expect(out).toContain('Public HTTPS address: yes');
    expect(out).toContain('Connected apps: 3 (2 users); high-risk grants: 1');
    expect(JSON.parse(await run('mcp', 'status', '--json'))).toEqual(STATUS);
  });

  it('status says when the console is not reachable from the internet or OAuth is off', () => {
    const lines = statusLines({ ...STATUS, publicHttps: false, oauthEnabled: false, connectedUsers: 1 });
    expect(lines.join('\n')).toMatch(/public-exposure\.md/);
    expect(lines.join('\n')).toMatch(/OAuth server is off/);
    expect(lines.join('\n')).toMatch(/\(1 user\)/);
  });

  it('disable and enable patch the mcp namespace: OAuth apps by default, --pat, --all', async () => {
    const calls = fakeApi({ 'PATCH /system-settings': { version: 2 } });
    expect(await run('mcp', 'disable')).toMatch(/External AI apps \(OAuth\): off\. It takes effect within a few seconds/);
    expect(await run('mcp', 'enable', '--pat')).toMatch(/Personal access tokens over MCP: on/);
    await run('mcp', 'disable', '--all');
    expect(calls.map((c) => c.body)).toEqual([{ mcp: { externalAppsEnabled: false } }, { mcp: { patMcpEnabled: true } }, { mcp: { externalAppsEnabled: false, patMcpEnabled: false } }]);
    expect(calls.every((c) => c.method === 'PATCH' && c.path === '/system-settings')).toBe(true);
    expect(switchPatch(true, {})).toEqual({ externalAppsEnabled: true });
  });
});

describe('apps limits --confirm-sensitive (#465)', () => {
  it('maps to confirmSensitiveActions only when given', async () => {
    const { limitsPatch } = await import('./apps.js');
    expect(limitsPatch({ confirmSensitive: false })).toEqual({ confirmSensitiveActions: false });
    expect(limitsPatch({})).toEqual({});
  });
});

describe('apps activity (#465)', () => {
  it('reads /connected-apps/activity and prints a line per row', async () => {
    const { appsCommand } = await import('./apps.command.js');
    const calls = fakeApi({
      'GET /connected-apps/activity': {
        items: [{ createdAt: '2026-11-18T10:00:00.000Z', event: 'tool_call', credentialKind: 'oauth', clientName: 'chatgpt.com', tool: 'browser_navigate', outcome: 'ok', errorCode: null, durationMs: 120, runId: null, sessionId: 'aaaaaaaa-1111-4111-8111-111111111111', detail: { host: 'shop.example.test' } }],
        nextCursor: null,
      },
    });
    const program = new Command().exitOverride();
    appsCommand(program);
    let out = '';
    const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
      out += String(chunk);
      return true;
    });
    try {
      await program.parseAsync(['node', 'hexactra', 'apps', 'activity', '--outcome', 'ok']);
    } finally {
      spy.mockRestore();
    }
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/connected-apps/activity' });
    expect(out).toMatch(/2026-11-18 10:00:00 {2}chatgpt\.com +browser_navigate session aaaaaaaa shop\.example\.test +ok/);
  });
});

describe('the VPS host proxy and /api/mcp (#465)', () => {
  it('declares /api/mcp with a 300 s timeout, so a tool that waits 200 s is not cut at 60 s', () => {
    expect(APP_CLI_OPTIONS.proxy?.streamPaths).toContainEqual({ path: '/api/mcp', timeoutSeconds: 300 });
  });
});
