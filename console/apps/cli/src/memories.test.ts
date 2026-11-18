import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { createCli } from '@marinoscar/platform-cli';
import { ApiClient } from '@marinoscar/platform-cli/api-client';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_CLI_OPTIONS } from './app.js';
import { setConsoleApiFactory } from './console-api.js';
import { memoriesCommand, memoryLine, parseAttributes, type MemoryView } from './memories.command.js';

resetCliForTests();
createCli(APP_CLI_OPTIONS);

const ID = '33333333-3333-4333-8333-333333333333';
const WIFE: MemoryView = { id: ID, kind: 'person', label: 'My wife', aliases: ['wife'], attributes: { name: 'Person A', phone: '555-010-6020' }, note: null, status: 'active', source: 'owner', lastUsedAt: null };

function fakeApi(routes: Record<string, unknown>) {
  const calls: { method: string; path: string; query: string; body: unknown }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const path = decodeURIComponent(url.pathname.replace(/^\/api/, ''));
    calls.push({ method, path, query: url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const key = `${method} ${path}`;
    if (!(key in routes)) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    if (method === 'DELETE') return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ data: routes[key] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  setConsoleApiFactory(() => new ApiClient({ baseUrl: 'http://console.example.test/api', token: 'pat_test', fetch }));
  return calls;
}

async function run(...args: string[]): Promise<string> {
  const program = new Command().exitOverride();
  memoriesCommand(program);
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

describe('memory helpers', () => {
  it('parses --attr pairs and refuses one without a name', () => {
    expect(parseAttributes(['name=Person A', 'phone = 555-010-6020', 'note=a=b'])).toEqual({ name: 'Person A', phone: '555-010-6020', note: 'a=b' });
    expect(() => parseAttributes(['=x'])).toThrow(/name=value/);
    expect(() => parseAttributes(['plain'])).toThrow(/name=value/);
  });

  it('prints one line per memory', () => {
    expect(memoryLine(WIFE)).toContain('My wife');
    expect(memoryLine({ ...WIFE, source: 'agent_proposed', status: 'archived' })).toContain('[archived, suggested by the agent]');
  });
});

describe('hexactra memories', () => {
  it('lists with filters', async () => {
    const calls = fakeApi({ 'GET /memories': [WIFE] });
    const text = await run('memories', 'list', '--kind', 'person', '--search', 'wife');
    expect(text).toContain('My wife');
    expect(calls[0]!.query).toContain('kind=person');
    expect(calls[0]!.query).toContain('q=wife');
    expect(calls[0]!.query).toContain('status=active');
  });

  it('shows a memory found by label', async () => {
    fakeApi({ 'GET /memories': [WIFE], [`GET /memories/${ID}`]: { ...WIFE, history: [{ ...WIFE, attributes: { phone: 'old' } }] } });
    const text = await run('memories', 'show', 'my wife');
    expect(text).toContain('phone: 555-010-6020');
    expect(text).toContain('earlier: phone: old');
    expect(text).toContain('added by you');
  });

  it('adds from flags', async () => {
    const calls = fakeApi({ 'POST /memories': WIFE });
    const text = await run('memories', 'add', 'My wife', '--kind', 'person', '--attr', 'name=Person A', '--attr', 'phone=555-010-6020', '--alias', 'wife');
    expect(text).toContain(`added My wife  ${ID}`);
    expect(calls[0]!.body).toEqual({ kind: 'person', label: 'My wife', attributes: { name: 'Person A', phone: '555-010-6020' }, aliases: ['wife'] });
  });

  it('refuses an unknown kind', async () => {
    fakeApi({});
    await expect(run('memories', 'add', 'X', '--kind', 'secret')).rejects.toThrow(/--kind/);
  });

  it('deletes by id prefix', async () => {
    const calls = fakeApi({ 'GET /memories': [WIFE], [`DELETE /memories/${ID}`]: null });
    expect(await run('memories', 'rm', ID.slice(0, 8))).toContain('deleted My wife');
    expect(calls.at(-1)).toMatchObject({ method: 'DELETE', path: `/memories/${ID}` });
  });

  it('exports to a file', async () => {
    const file = { kind: 'hexactra.memories', formatVersion: 1, exportedAt: '2026-11-18T00:00:00.000Z', memories: [] };
    fakeApi({ 'GET /memories/export': file });
    const path = join(mkdtempSync(join(tmpdir(), 'mem-')), 'm.json');
    expect(await run('memories', 'export', '-o', path)).toContain(`wrote ${path}`);
    expect(JSON.parse(readFileSync(path, 'utf8'))).toMatchObject({ kind: 'hexactra.memories' });
  });
});
