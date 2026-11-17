import { Command } from 'commander';
import { createCli } from '@marinoscar/platform-cli';
import { ApiClient } from '@marinoscar/platform-cli/api-client';
import { renderTuiScreen, stripAnsi } from '@marinoscar/platform-cli/tui/testing';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_CLI_OPTIONS } from './app.js';

import { setConsoleApiFactory } from './console-api.js';
import { fleetCommand } from './fleet.command.js';
import { hostLine, type FleetHost } from './fleet.js';
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
    mode: null,
    desktop: false,
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
    expect(hostLine({ ...hosts[0]!, mode: 'unattended', desktop: true })).toBe('vps  [online, unattended, desktop]  profiles: default, travel*');
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
    expect(await run('fleet', 'disable', 'vps')).toContain('drain: succeeded');
    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: { enabled: true } });
    expect(await run('fleet', 'enable', 'vps')).toContain('drain: succeeded');
    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: { enabled: false } });
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
  it('shows the hosts and disables the selected one with d', async () => {
    const calls = fakeApi({ 'GET /fleet/hosts': hosts, [`POST /fleet/hosts/${ID}/drain`]: { kind: 'drain', state: 'succeeded' } });
    const screen = await renderTuiScreen(FleetScreen, { columns: 100 });
    await screen.waitForFrame((f) => stripAnsi(f).includes('profiles: default, travel*'));
    await screen.press('d');
    await screen.waitForFrame((f) => stripAnsi(f).includes('vps: disabled'));
    expect(calls.some((c) => c.method === 'POST' && c.path === `/fleet/hosts/${ID}/drain`)).toBe(true);
    screen.unmount();
  });

  it('says so when not logged in', async () => {
    const screen = await renderTuiScreen(FleetScreen, { theme: 'mono', columns: 40 });
    await screen.waitForFrame((f) => /Not logged in|login/.test(stripAnsi(f)));
    screen.unmount();
  });
});

describe('hexactra tasks and runs', () => {
  async function runCli(...args: string[]): Promise<string> {
    const { runsCommand } = await import('./runs.command.js');
    const program = new Command().exitOverride();
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

  it('creates and runs a task, and shows a run with its steps', async () => {
    const T = '33333333-3333-4333-8333-333333333333';
    const R = '44444444-4444-4444-8444-444444444444';
    const calls = fakeApi({
      'POST /tasks': { id: T, name: 'Fare', goal: 'Find a fare', profile: 'travel', allowedDomains: [] },
      'GET /fleet/hosts': hosts,
      'GET /tasks': [{ id: T, name: 'Fare', goal: 'Find a fare', profile: 'travel', allowedDomains: [] }],
      [`POST /tasks/${T}/runs`]: { id: R, status: 'queued', goal: 'Find a fare', stepCount: 0 },
      [`GET /runs/${R}`]: { id: R, status: 'succeeded', goal: 'Find a fare', stepCount: 1, result: '$120', steps: [{ seq: 1, kind: 'action', action: 'navigate', ok: true, summary: 'at https://f.example.test/' }] },
    });
    expect(await runCli('tasks', 'create', 'Fare', 'Find a fare', '--profile', 'travel', '--allow', 'f.example.test')).toContain(`created ${T}`);
    expect(calls.at(-1)?.body).toMatchObject({ profile: 'travel', allowedDomains: ['f.example.test'], confirmRiskyActions: true, hostFallback: true });
    expect(calls.at(-1)?.body).not.toHaveProperty('hostId');
    // A machine by name, failing instead of falling back (#384).
    expect(await runCli('tasks', 'create', 'Fare', 'Find a fare', '--host', 'vps', '--no-host-fallback')).toContain(`created ${T}`);
    expect(calls.at(-1)?.body).toMatchObject({ hostId: ID, hostFallback: false });
    const runOut = await runCli('tasks', 'run', T.slice(0, 8), '--watch');
    expect(runOut).toContain(`run ${R}`);
    expect(runOut).toContain('1. navigate: at https://f.example.test/');
    expect(runOut).toContain('result: $120');
  });
});

describe('RunsScreen', () => {
  it('lists runs, opens one, and cancels it with c', async () => {
    const { RunsScreen } = await import('./runs.screen.js');
    const R = '55555555-5555-4555-8555-555555555555';
    const calls = fakeApi({
      'GET /runs': [{ id: R, status: 'running', goal: 'Find a fare', stepCount: 2 }],
      [`GET /runs/${R}`]: { id: R, status: 'running', goal: 'Find a fare', stepCount: 2, steps: [{ seq: 1, kind: 'action', action: 'navigate', ok: true, summary: 'at https://f.example.test/' }] },
      [`POST /runs/${R}/cancel`]: { id: R, status: 'running', cancelRequested: true },
    });
    const screen = await renderTuiScreen(RunsScreen, { columns: 100 });
    await screen.waitForFrame((f) => stripAnsi(f).includes('running'));
    await screen.press('enter');
    await screen.waitForFrame((f) => stripAnsi(f).includes('1. navigate: at https://f.example.test/'));
    await screen.press('c');
    await screen.waitForFrame((f) => stripAnsi(f).includes('cancel requested'));
    expect(calls.some((c) => c.method === 'POST' && c.path === `/runs/${R}/cancel`)).toBe(true);
    screen.unmount();
  });
});

describe('the inbox', () => {
  const item = { questionId: '66666666-6666-4666-8666-000000000000', runId: '66666666-6666-4666-8666-666666666666', goal: 'Fare', kind: 'code', prompt: 'Enter the code', input: 'secret', choices: [], expiresAt: '2026-11-15T00:10:00Z' };

  it('answers from the CLI and refuses a secret as an argument', async () => {
    const { inboxCommand } = await import('./inbox.command.js');
    const calls = fakeApi({ 'GET /inbox': [item], [`POST /inbox/${item.runId}/respond`]: { ok: true } });
    const program = new Command().exitOverride();
    inboxCommand(program);
    await expect(program.parseAsync(['node', 'hexactra', 'inbox', 'answer', item.runId.slice(0, 8), '--done'])).resolves.toBeDefined();
    expect(calls.at(-1)).toMatchObject({ method: 'POST', body: { outcome: 'completed' } });
    const p2 = new Command().exitOverride();
    inboxCommand(p2);
    await expect(p2.parseAsync(['node', 'hexactra', 'inbox', 'answer', item.runId.slice(0, 8)])).rejects.toThrow(/--secret-stdin/);
  });

  it('types a masked secret in the TUI and sends it', async () => {
    const { InboxScreen } = await import('./inbox.screen.js');
    const calls = fakeApi({ 'GET /inbox': [item], [`POST /inbox/${item.runId}/respond`]: { ok: true } });
    const screen = await renderTuiScreen(InboxScreen, { columns: 100 });
    await screen.waitForFrame((f) => stripAnsi(f).includes('[code] Enter the code'));
    for (const ch of '9876') await screen.press(ch);
    await screen.waitForFrame((f) => stripAnsi(f).includes('secret: ••••'));
    expect(stripAnsi(screen.lastFrame() ?? '')).not.toContain('9876');
    await screen.press('enter');
    await screen.waitForFrame((f) => stripAnsi(f).includes('sent; the agent continues'));
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ outcome: 'completed', value: '9876' });
    screen.unmount();
  });
});

describe('hexactra mcp serve', () => {
  it('bridges stdio JSON-RPC lines to POST /api/mcp and back', async () => {
    const { serveMcpStdio } = await import('./mcp.command.js');
    const { PassThrough } = await import('node:stream');
    const input = new PassThrough();
    const output = new PassThrough();
    const seen: { url: string; auth: string | null; body: string }[] = [];
    const fetch = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const body = String(init?.body);
      seen.push({ url: String(url), auth: new Headers(init?.headers).get('authorization'), body });
      const msg = JSON.parse(body) as { id?: number; method: string };
      if (msg.id === undefined) return new Response(null, { status: 202 });
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: msg.id, result: { echoed: msg.method } }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    let out = '';
    output.on('data', (d) => (out += String(d)));
    const done = serveMcpStdio({ input, output, fetch: fetch as never, credentials: { apiBaseUrl: 'http://console.example.test/api', token: 'pat_x' } });
    input.write('{"jsonrpc":"2.0","id":1,"method":"initialize","params":{}}\n');
    input.write('{"jsonrpc":"2.0","method":"notifications/initialized"}\n');
    input.write('not json\n');
    input.end();
    await done;
    const lines = out.trim().split('\n').map((l) => JSON.parse(l));
    expect(lines).toContainEqual({ jsonrpc: '2.0', id: 1, result: { echoed: 'initialize' } });
    expect(lines).toContainEqual(expect.objectContaining({ error: expect.objectContaining({ code: -32700 }) }));
    expect(lines).toHaveLength(2);
    expect(seen[0]).toMatchObject({ url: 'http://console.example.test/api/mcp', auth: 'Bearer pat_x' });
  });
});
