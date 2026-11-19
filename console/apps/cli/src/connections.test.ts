import { Command } from 'commander';
import { createCli } from '@marinoscar/platform-cli';
import { ApiClient } from '@marinoscar/platform-cli/api-client';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_CLI_OPTIONS } from './app.js';
import { capabilitiesText, connectionLine, connectionsCommand, type ConnectionView } from './connections.command.js';
import { setConsoleApiFactory } from './console-api.js';

resetCliForTests();
createCli(APP_CLI_OPTIONS);

const WORK: ConnectionView = {
  id: '44444444-4444-4444-8444-444444444444',
  provider: 'google',
  label: 'Work',
  accountEmail: 'person.a@example.test',
  accountName: 'Person A',
  capabilities: ['mail_read', 'mail_send', 'calendar_read'],
  granted: ['mail_read', 'mail_send', 'calendar_read'],
  defaultFor: ['mail'],
  status: 'active',
  statusReason: null,
  lastUsedAt: null,
};
const PERSONAL: ConnectionView = { ...WORK, id: '55555555-5555-4555-8555-555555555555', label: 'Personal', accountEmail: 'person.b@example.test', capabilities: ['mail_read'], defaultFor: [], status: 'paused' };

function fakeApi(routes: Record<string, unknown>) {
  const calls: { method: string; path: string; body: unknown }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = decodeURIComponent(url.pathname.replace(/^\/api/, ''));
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
  connectionsCommand(program);
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

afterEach(() => {
  setConsoleApiFactory(null);
  process.exitCode = undefined;
});

describe('connection helpers', () => {
  it('groups the capabilities the way the page shows them', () => {
    expect(capabilitiesText(['mail_read', 'mail_send', 'calendar_read', 'docs_read', 'docs_write'])).toBe('mail (read, send), calendar (read), documents (read, write)');
    expect(capabilitiesText([])).toBe('nothing switched on');
  });

  it('prints one line per connection, with its state and defaults', () => {
    expect(connectionLine(WORK)).toContain('Work');
    expect(connectionLine(WORK)).toContain('[default for mail]');
    expect(connectionLine({ ...PERSONAL, status: 'needs_reconnect', statusReason: 'GRANT_REVOKED' })).toContain('[needs reconnect (GRANT_REVOKED)]');
  });
});

describe('hexactra connections', () => {
  it('lists, and says how to connect when there are none', async () => {
    fakeApi({ 'GET /connections': [WORK, PERSONAL] });
    const text = await run('connections', 'list');
    expect(text).toContain('Work');
    expect(text).toContain('Personal');
    fakeApi({ 'GET /connections': [] });
    expect(await run('connections', 'list')).toContain('Settings → Connections');
  });

  it('lists as JSON without a token or a scope', async () => {
    fakeApi({ 'GET /connections': [WORK] });
    const parsed = JSON.parse(await run('connections', 'list', '--json')) as ConnectionView[];
    expect(parsed[0]!.id).toBe(WORK.id);
    expect(JSON.stringify(parsed)).not.toMatch(/token|scope/i);
  });

  it('tests a connection found by label and fails the command when a capability fails', async () => {
    const calls = fakeApi({ 'GET /connections': [WORK, PERSONAL], [`POST /connections/${WORK.id}/test`]: { results: [{ capability: 'mail_read', ok: true, code: null }, { capability: 'calendar_read', ok: false, code: 'FORBIDDEN' }] } });
    const text = await run('connections', 'test', 'work');
    expect(text).toContain('ok    mail_read');
    expect(text).toContain('FAIL  calendar_read  (FORBIDDEN)');
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: `/connections/${WORK.id}/test` });
    expect(process.exitCode).toBe(1);
  });

  it('pauses and resumes by id prefix', async () => {
    const calls = fakeApi({ 'GET /connections': [WORK, PERSONAL], [`POST /connections/${PERSONAL.id}/resume`]: { ...PERSONAL, status: 'active' }, [`POST /connections/${WORK.id}/pause`]: { ...WORK, status: 'paused' } });
    expect(await run('connections', 'pause', '44444444')).toContain('paused Work');
    expect(await run('connections', 'resume', 'Personal')).toContain('resumed Personal');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(expect.arrayContaining([`POST /connections/${WORK.id}/pause`, `POST /connections/${PERSONAL.id}/resume`]));
  });

  it('disconnects, and says when the provider could not be asked', async () => {
    const calls = fakeApi({ 'GET /connections': [WORK], [`DELETE /connections/${WORK.id}`]: { revoked: false, clearedReferences: 2 } });
    const text = await run('connections', 'rm', 'Work');
    expect(text).toContain('disconnected Work');
    expect(text).toContain('could not be asked');
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: `/connections/${WORK.id}` });
  });

  it('refuses an unknown or ambiguous reference without calling anything else', async () => {
    const calls = fakeApi({ 'GET /connections': [WORK, { ...PERSONAL, id: '44444444-0000-4000-8000-000000000000' }] });
    await expect(run('connections', 'pause', 'nobody')).rejects.toThrow(/No connection matches/);
    await expect(run('connections', 'pause', '44444444')).rejects.toThrow(/several connections/);
    expect(calls.every((c) => c.method === 'GET')).toBe(true);
  });

  it('there is no connect command: it needs a browser', () => {
    const program = new Command();
    connectionsCommand(program);
    const names = program.commands.find((c) => c.name() === 'connections')!.commands.map((c) => c.name());
    expect(names.sort()).toEqual(['list', 'pause', 'resume', 'rm', 'test']);
  });
});
