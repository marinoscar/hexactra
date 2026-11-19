import { Command } from 'commander';
import { createCli } from '@marinoscar/platform-cli';
import { ApiClient } from '@marinoscar/platform-cli/api-client';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_CLI_OPTIONS } from './app.js';
import { matchText, triggerLine, type MailTriggerView } from './mail-triggers.js';
import { setConsoleApiFactory } from './console-api.js';
import { runsCommand } from './runs.command.js';

resetCliForTests();
createCli(APP_CLI_OPTIONS);

const TASK = '11111111-1111-4111-8111-111111111111';
const T: MailTriggerView = {
  id: '33333333-3333-4333-8333-333333333333',
  taskId: TASK,
  connectionLabel: 'Work',
  name: 'Invoices',
  enabled: true,
  match: { from: ['billing@example.test'], subjectContains: 'invoice', hasAttachment: true },
  afterStart: 'mark_read',
  pollSeconds: 300,
  maxRunsPerDay: 10,
  status: 'ok',
  statusReason: null,
  lastCheckedAt: null,
  runsToday: 2,
};

function fakeApi(routes: Record<string, unknown>) {
  const calls: string[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const key = `${init?.method ?? 'GET'} ${decodeURIComponent(url.pathname.replace(/^\/api/, ''))}`;
    calls.push(key);
    if (!(key in routes)) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    return new Response(JSON.stringify({ data: routes[key] }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  setConsoleApiFactory(() => new ApiClient({ baseUrl: 'http://console.example.test/api', token: 'pat_test', fetch }));
  return calls;
}

async function run(...args: string[]): Promise<string> {
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

afterEach(() => setConsoleApiFactory(null));

describe('email triggers in the CLI', () => {
  it('says the rules in words and the state in one line', () => {
    expect(matchText(T.match)).toBe('from billing@example.test, subject has "invoice", with an attachment');
    const line = triggerLine(T);
    expect(line).toContain('Invoices');
    expect(line).toContain('[watching]');
    expect(line).toContain('2/10 runs today');
    expect(line).toContain('after: mark read');
    expect(triggerLine({ ...T, enabled: false })).toContain('[off]');
    expect(triggerLine({ ...T, status: 'needs_reconnect' })).toContain('account must be connected again');
    expect(triggerLine({ ...T, connectionLabel: null })).toContain('account removed');
  });

  it('lists a task\'s triggers by name, and says when there are none', async () => {
    const calls = fakeApi({ 'GET /tasks': [{ id: TASK, name: 'Pay bills', profile: 'default', allowedDomains: [] }], [`GET /tasks/${TASK}/mail-triggers`]: [T] });
    expect(await run('tasks', 'triggers', 'list', 'Pay bills')).toContain('Invoices');
    expect(calls).toContain(`GET /tasks/${TASK}/mail-triggers`);
    fakeApi({ 'GET /tasks': [{ id: TASK, name: 'Pay bills', profile: 'default', allowedDomains: [] }], [`GET /tasks/${TASK}/mail-triggers`]: [] });
    expect(await run('tasks', 'triggers', 'list', TASK.slice(0, 8))).toContain('No email triggers on this task.');
  });
});
