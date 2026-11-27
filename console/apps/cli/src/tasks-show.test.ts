// `hexactra tasks show` (E50.15, #985): one task, and one line of what its runs can use. There is no per-task tool flag (E50.17).
import { createCli } from '@marinoscar/platform-cli';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { Command } from 'commander';
import { afterEach, describe, expect, it } from 'vitest';

import { APP_CLI_OPTIONS } from './app.js';
import { setConsoleApiFactory } from './console-api.js';
import { fakeApi, runCommand } from './fake-api.test-support.js';
import { runsCommand } from './runs.command.js';

resetCliForTests();
createCli(APP_CLI_OPTIONS);

const TASK = { id: '99999999-9999-4999-8999-999999999999', name: 'Invoices', goal: 'Download this month\'s invoices', profile: 'default', allowedDomains: ['billing.example.test'], parameters: [] };
const conn = (label: string, status: string) => ({ id: `${label}-id`, provider: 'google', label, accountEmail: 'a@example.test', accountName: null, capabilities: [], granted: [], defaultFor: [], status, statusReason: null, lastUsedAt: null });

afterEach(() => {
  setConsoleApiFactory(null);
});

describe('hexactra tasks show', () => {
  it('prints the task and the one line of what the agent can use', async () => {
    fakeApi({ 'GET /tasks': [TASK], [`GET /tasks/${TASK.id}`]: TASK, 'GET /connections': [conn('Work', 'active'), conn('Old', 'paused')], 'GET /web-search/status': { enabled: true } });
    const text = await runCommand(runsCommand, 'tasks', 'show', 'Invoices');
    expect(text).toContain('Invoices  (99999999-9999-4999-8999-999999999999)');
    expect(text).toContain('sites: billing.example.test');
    expect(text).toContain('The agent can use: the browser, web search, Work.');
  });

  it('has no flag that chooses web search or connections per task or run', () => {
    const program = new Command();
    runsCommand(program);
    const flags = program.commands.flatMap((g) => g.commands.flatMap((c) => c.options.map((o) => o.long)));
    expect(flags).not.toContain('--web-search');
    expect(flags).not.toContain('--connection');
  });
});
