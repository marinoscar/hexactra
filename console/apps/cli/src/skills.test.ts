import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { createCli } from '@marinoscar/platform-cli';
import { ApiClient } from '@marinoscar/platform-cli/api-client';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_CLI_OPTIONS } from './app.js';
import { setConsoleApiFactory } from './console-api.js';
import { skillLine, skillsCommand, type SkillView } from './skills.command.js';

resetCliForTests();
createCli(APP_CLI_OPTIONS);

const ID = '44444444-4444-4444-8444-444444444444';
const SMS: SkillView = {
  id: ID,
  name: 'Google Messages',
  description: 'How I send text messages from Google Messages on the web',
  body: 'Open messages.google.com. Start chat is top left.',
  sites: ['google.com'],
  enabled: true,
  archivedAt: null,
  lastUsedAt: null,
  useCount: 0,
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
    if (method === 'DELETE') return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ data: routes[key] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  setConsoleApiFactory(() => new ApiClient({ baseUrl: 'http://console.example.test/api', token: 'pat_test', fetch }));
  return calls;
}

async function run(...args: string[]): Promise<string> {
  const program = new Command().exitOverride();
  skillsCommand(program);
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

describe('hexactra skills (#1008)', () => {
  it('lists the skills in use, one line each, without their text', async () => {
    const calls = fakeApi({ 'GET /skills': [SMS] });
    const text = await run('skills', 'list');
    expect(calls[0]).toMatchObject({ method: 'GET', path: '/skills', query: '?archived=false' });
    expect(text).toBe(`${skillLine(SMS)}\n`);
    expect(text).not.toContain('Start chat');
  });

  it('shows one skill by name with its text', async () => {
    fakeApi({ 'GET /skills': [SMS] });
    const text = await run('skills', 'show', 'google messages');
    expect(text).toContain('Google Messages');
    expect(text).toContain('sites: google.com');
    expect(text).toContain('Start chat is top left.');
  });

  it('adds a skill with its text from a file and its sites', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'skills-'));
    const file = join(dir, 'sms.md');
    writeFileSync(file, 'Open messages.google.com.\n');
    const calls = fakeApi({ 'POST /skills': SMS });
    const text = await run('skills', 'add', '--name', 'Google Messages', '--description', 'How I text', '--file', file, '--site', 'google.com');
    expect(calls[0]).toMatchObject({ method: 'POST', path: '/skills', body: { name: 'Google Messages', description: 'How I text', body: 'Open messages.google.com.\n', sites: ['google.com'] } });
    expect(text).toContain(`added Google Messages  ${ID}`);
  });

  it('edits, switches off and on, archives, unarchives and deletes', async () => {
    const calls = fakeApi({ 'GET /skills': [SMS], [`PATCH /skills/${ID}`]: SMS, [`POST /skills/${ID}/archive`]: SMS, [`POST /skills/${ID}/unarchive`]: SMS, [`DELETE /skills/${ID}`]: null });
    await run('skills', 'edit', 'Google Messages', '--description', 'When I text');
    await run('skills', 'disable', 'Google Messages');
    await run('skills', 'enable', 'Google Messages');
    await run('skills', 'archive', 'Google Messages');
    await run('skills', 'archive', 'Google Messages', '--undo');
    expect(await run('skills', 'delete', 'Google Messages')).toContain('deleted Google Messages');
    const writes = calls.filter((c) => c.method !== 'GET').map((c) => [c.method, c.path, c.body]);
    expect(writes).toEqual([
      ['PATCH', `/skills/${ID}`, { description: 'When I text' }],
      ['PATCH', `/skills/${ID}`, { enabled: false }],
      ['PATCH', `/skills/${ID}`, { enabled: true }],
      ['POST', `/skills/${ID}/archive`, {}],
      ['POST', `/skills/${ID}/unarchive`, {}],
      ['DELETE', `/skills/${ID}`, undefined],
    ]);
  });

  it('refuses an edit with nothing to change, and a name that matches nothing', async () => {
    fakeApi({ 'GET /skills': [SMS] });
    await expect(run('skills', 'edit', 'Google Messages')).rejects.toThrow(/Nothing to change/);
    await expect(run('skills', 'show', 'Nope')).rejects.toThrow(/No skill matches/);
  });
});
