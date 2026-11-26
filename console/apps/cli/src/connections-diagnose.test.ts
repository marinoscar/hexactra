// `hexactra connections diagnose|diagnostics|app-test`, the HEALTH column and the "what the agent can use" line (E50.15, #985).
import { createCli } from '@marinoscar/platform-cli';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { afterEach, describe, expect, it } from 'vitest';

import { APP_CLI_OPTIONS } from './app.js';
import { agentToolsLine, connectionsCommand, type ConnectionView } from './connections.command.js';
import { setConsoleApiFactory } from './console-api.js';
import { stageTitle, type DiagnosticReportView, type DiagnosticStageView } from './diagnostics.js';
import { fakeApi, runCommand } from './fake-api.test-support.js';

resetCliForTests();
createCli(APP_CLI_OPTIONS);

const WORK: ConnectionView = {
  id: '44444444-4444-4444-8444-444444444444',
  provider: 'google',
  label: 'Work',
  accountEmail: 'person.a@example.test',
  accountName: 'Person A',
  capabilities: ['mail_read'],
  granted: ['mail_read'],
  defaultFor: [],
  status: 'active',
  statusReason: null,
  lastUsedAt: null,
};
const PERSONAL: ConnectionView = { ...WORK, id: '55555555-5555-4555-8555-555555555555', label: 'Personal', status: 'paused' };

const REPORT = (overall: 'pass' | 'warn' | 'fail', stages: DiagnosticStageView[]): DiagnosticReportView => ({
  id: '77777777-7777-4777-8777-777777777777',
  target: { kind: 'connection', id: WORK.id },
  trigger: 'owner',
  overall,
  startedAt: '2026-11-26T10:00:00.000Z',
  finishedAt: '2026-11-26T10:00:01.000Z',
  stages,
});

const run = (...args: string[]) => runCommand(connectionsCommand, ...args);

afterEach(() => {
  setConsoleApiFactory(null);
  process.exitCode = undefined;
});

describe('hexactra connections diagnose', () => {
  it('prints each stage in order with a mark, its title, the code in words and the remedy, and exits 1 on a failure', async () => {
    const report = REPORT('fail', [
      { id: 'status', status: 'pass', code: null, remedy: null, ms: 1 },
      { id: 'sign_in', status: 'pass', code: null, remedy: null, ms: 120 },
      { id: 'capability:mail_read', status: 'fail', code: 'API_DISABLED', remedy: 'API_DISABLED', ms: 80, data: { api: 'gmail.googleapis.com' } },
      { id: 'latency', status: 'skipped', code: null, remedy: null, ms: null },
    ]);
    const calls = fakeApi({ 'GET /connections': [WORK], [`POST /connections/${WORK.id}/diagnose`]: report });
    const lines = (await run('connections', 'diagnose', 'Work')).trim().split('\n');
    expect(lines[0]).toMatch(/^ok {4}Connection status/);
    expect(lines[1]).toMatch(/^ok {4}Sign-in/);
    expect(lines[2]).toBe("FAIL  Capability mail_read  (API_DISABLED: The service is switched off in the administrator's app)  80 ms");
    expect(lines[3]).toMatch(/not enabled in the deployment's project.*\(your administrator can fix this\)/);
    expect(lines[4]).toBe('skip  Time taken');
    expect(lines.at(-1)).toMatch(/^Failed: Work/);
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: `/connections/${WORK.id}/diagnose` });
    expect(process.exitCode).toBe(1);
  });

  it('exits 0 for pass or warn, and --json is the API report, with no label unless --include-names', async () => {
    const report = REPORT('warn', [{ id: 'status', status: 'warn', code: 'CONNECTION_PAUSED', remedy: 'CONNECTION_PAUSED', ms: 0 }]);
    fakeApi({ 'GET /connections': [WORK], [`POST /connections/${WORK.id}/diagnose`]: report });
    const text = await run('connections', 'diagnose', 'Work');
    expect(text).toContain('warn  Connection status  (CONNECTION_PAUSED: Paused)');
    expect(text).toContain('Resume it to use it again.');
    expect(process.exitCode).toBe(0);
    const json = JSON.parse(await run('connections', 'diagnose', 'Work', '--json')) as Record<string, unknown>;
    expect(json).toEqual(report);
    expect(JSON.stringify(json)).not.toContain('Work');
    const named = JSON.parse(await run('connections', 'diagnose', 'Work', '--json', '--include-names')) as Record<string, unknown>;
    expect(named.label).toBe('Work');
  });

  it('exits 2 when the command could not run (an unknown connection, a refused call)', async () => {
    fakeApi({ 'GET /connections': [WORK] }, { [`POST /connections/${WORK.id}/diagnose`]: { status: 429, body: { code: 'DIAGNOSTICS_RATE_LIMITED', message: 'Wait 30 seconds' } } });
    await expect(run('connections', 'diagnose', 'nobody')).rejects.toMatchObject({ exitCode: 2, message: expect.stringMatching(/No connection matches/) });
    await expect(run('connections', 'diagnose', 'Work')).rejects.toMatchObject({ exitCode: 2, message: expect.stringMatching(/Wait 30 seconds/) });
  });

  it('names a stage it does not know in its own words', () => {
    expect(stageTitle('tool_list')).toBe('Tool list');
    expect(stageTitle('some_new_stage')).toBe('Some new stage');
    expect(stageTitle('capability:docs_write')).toBe('Capability docs_write');
  });
});

describe('hexactra connections diagnostics', () => {
  it('lists the history newest first, passes --limit, and says how to make the first report', async () => {
    const report = REPORT('fail', [{ id: 'sign_in', status: 'fail', code: 'GRANT_REVOKED', remedy: 'GRANT_REVOKED', ms: 10 }]);
    const calls = fakeApi({ 'GET /connections': [WORK], [`GET /connections/${WORK.id}/diagnostics`]: [report] });
    expect(await run('connections', 'diagnostics', 'Work', '--limit', '3')).toContain('2026-11-26 10:00:01  fail     owner       Sign-in (GRANT_REVOKED)');
    expect(calls.at(-1)!.query).toEqual({ limit: '3' });
    fakeApi({ 'GET /connections': [WORK], [`GET /connections/${WORK.id}/diagnostics`]: [] });
    expect(await run('connections', 'diagnostics', 'Work')).toContain('No reports yet');
  });
});

describe('hexactra connections app-test', () => {
  it("tests the deployment's app at a provider, and refuses another name", async () => {
    const report = { ...REPORT('pass', [{ id: 'app_config', status: 'pass', code: null, remedy: null, ms: 1 }]), target: { kind: 'provider_app', id: 'google' } };
    const calls = fakeApi({ 'POST /connections/admin/apps/google/diagnose': report });
    const text = await run('connections', 'app-test', 'google');
    expect(text).toContain("ok    The deployment's app");
    expect(text).toContain('Everything passed: the google app');
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/connections/admin/apps/google/diagnose' });
    expect(process.exitCode).toBe(0);
    await expect(run('connections', 'app-test', 'yahoo')).rejects.toThrow(/google or microsoft/);
  });
});

describe('the HEALTH column and what the agent can use', () => {
  it('shows the HEALTH of each connection from the summary route, and leaves the column out when it cannot be read', async () => {
    fakeApi({ 'GET /connections': [WORK, PERSONAL], 'GET /connections/diagnostics/summary': [{ targetId: WORK.id, overall: 'fail', at: '2026-11-26T10:00:00.000Z' }] });
    const text = await run('connections', 'list');
    expect(text.split('\n')[0]).toContain('HEALTH');
    expect(text).toMatch(/44444444 {2}google {5}fail {9}Work/);
    expect(text).toMatch(/55555555 {2}google {5}not checked {2}Personal/);
    fakeApi({ 'GET /connections': [WORK] });
    expect(await run('connections', 'list')).not.toContain('HEALTH');
  });

  it('says in one line what the agent can use: the browser, web search while on, and every active connection', () => {
    expect(agentToolsLine([WORK, PERSONAL], { enabled: true })).toBe('The agent can use: the browser, web search, Work.');
    expect(agentToolsLine([], { enabled: false })).toBe('The agent can use: the browser.');
    expect(agentToolsLine(null, null)).toMatch(/web search if it is on .*the connections you switched on/);
  });
});
