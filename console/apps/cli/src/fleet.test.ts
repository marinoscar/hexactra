import { Command } from 'commander';
import { createCli } from '@marinoscar/platform-cli';
import { ApiClient } from '@marinoscar/platform-cli/api-client';
import { renderTuiScreen, stripAnsi } from '@marinoscar/platform-cli/tui/testing';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_CLI_OPTIONS } from './app.js';

import { setConsoleApiFactory } from './console-api.js';
import { fleetCommand } from './fleet.command.js';
import type { FleetHost } from './fleet.js';
import { FleetScreen } from './fleet.screen.js';

resetCliForTests();
createCli(APP_CLI_OPTIONS);

const ID = '11111111-1111-4111-8111-111111111111';
const hosts: FleetHost[] = [
  {
    id: ID,
    name: 'vps',
    version: '0.1.0',
    online: true,
    browserConnected: true,
    onDemand: true,
    draining: false,
    viewerUrl: null,
    profiles: [
      { name: 'default', running: false },
      { name: 'travel', running: true },
    ],
    lastSeen: '2026-11-15T00:00:00Z',
  },
];

/** The console API behind a fake fetch, in the `{ data }` envelope. */
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
  fleetCommand(program);
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

describe('hexactra fleet', () => {
  it('lists hosts with running profiles starred', async () => {
    fakeApi({ 'GET /fleet/hosts': hosts });
    expect(await run('fleet', 'hosts')).toContain('vps  [online, launch]  profiles: default, travel*');
  });

  it('drains, manages profiles and enrolls, naming hosts by name', async () => {
    const calls = fakeApi({
      'GET /fleet/hosts': hosts,
      [`POST /fleet/hosts/${ID}/drain`]: { kind: 'drain', profile: null, state: 'succeeded' },
      [`POST /fleet/hosts/${ID}/profiles`]: { kind: 'create_profile', profile: 'work', state: 'succeeded' },
      [`POST /fleet/hosts/${ID}/profiles/travel/restart`]: { kind: 'restart_browser', profile: 'travel', state: 'succeeded' },
      'POST /fleet/enrollments': { enrollmentToken: 'hxe_x', expiresAt: null, command: 'hexactra-agent daemon --url http://f:8787 --enrollment-token hxe_x' },
    });
    expect(await run('fleet', 'drain', 'vps')).toContain('drain: succeeded');
    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: { enabled: true } });
    expect(await run('fleet', 'profile', 'create', 'vps', 'work')).toContain('create_profile work: succeeded');
    expect(await run('fleet', 'profile', 'restart', ID.slice(0, 8), 'travel')).toContain('restart_browser travel: succeeded');
    expect(await run('fleet', 'enroll', '--name', 'home')).toContain('--enrollment-token hxe_x');
    expect(calls.at(-1)).toMatchObject({ path: '/fleet/enrollments', body: { name: 'home' } });
  });

  it('refuses destructive changes without --yes and unknown hosts clearly', async () => {
    fakeApi({ 'GET /fleet/hosts': hosts });
    await expect(run('fleet', 'profile', 'delete', 'vps', 'travel')).rejects.toThrow(/pass --yes/);
    await expect(run('fleet', 'revoke', 'vps')).rejects.toThrow(/pass --yes/);
    await expect(run('fleet', 'drain', 'nope')).rejects.toThrow(/No host matches "nope"/);
  });
});

describe('FleetScreen', () => {
  it('shows the hosts and drains the selected one with d', async () => {
    const calls = fakeApi({ 'GET /fleet/hosts': hosts, [`POST /fleet/hosts/${ID}/drain`]: { kind: 'drain', state: 'succeeded' } });
    const screen = await renderTuiScreen(FleetScreen, { columns: 100 });
    await screen.waitForFrame((f) => stripAnsi(f).includes('profiles: default, travel*'));
    await screen.press('d');
    await screen.waitForFrame((f) => stripAnsi(f).includes('vps: draining'));
    expect(calls.some((c) => c.method === 'POST' && c.path === `/fleet/hosts/${ID}/drain`)).toBe(true);
    screen.unmount();
  });

  it('says so when not logged in', async () => {
    const screen = await renderTuiScreen(FleetScreen, { theme: 'mono', columns: 40 });
    await screen.waitForFrame((f) => /Not logged in|login/.test(stripAnsi(f)));
    screen.unmount();
  });
});
