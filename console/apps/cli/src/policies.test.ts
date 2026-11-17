import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { createCli } from '@marinoscar/platform-cli';
import { ApiClient } from '@marinoscar/platform-cli/api-client';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { renderTuiScreen, stripAnsi } from '@marinoscar/platform-cli/tui/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_CLI_OPTIONS } from './app.js';
import { setConsoleApiFactory } from './console-api.js';
import { costText, findPolicy, policyLine, runPolicyLines, type PolicyView } from './policies.js';
import { policiesCommand } from './policies.command.js';
import { RunsScreen } from './runs.screen.js';
import { runsCommand } from './runs.command.js';

resetCliForTests();
createCli(APP_CLI_OPTIONS);

const OWN = '22222222-2222-4222-8222-222222222222';
const budget = { maxActions: 60, maxModelCalls: null, maxActiveMinutes: 20, maxInputTokens: null, maxOutputTokens: null, maxCostUsd: null, warnAtPercent: 80 };
const policy = (over: Partial<PolicyView> = {}): PolicyView => ({
  id: 'builtin:balanced',
  name: 'Balanced',
  description: null,
  version: 1,
  builtin: true,
  isDefault: true,
  hasNoHardStop: false,
  usage: { tasks: 0, schedules: 0 },
  spec: { models: { startTier: 'fast', maxTier: 'standard' }, budget },
  ...over,
});
const LIST = [policy(), policy({ id: 'builtin:unlimited', name: 'Unlimited', isDefault: false, hasNoHardStop: true, spec: { models: { startTier: 'standard', maxTier: 'frontier' }, budget: { ...budget, maxActions: null, maxActiveMinutes: null } } }), policy({ id: OWN, name: 'Fare lookups', builtin: false, isDefault: false })];

/** The console API behind a fake fetch: routes by `METHOD /path`; every call is recorded. */
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
  policiesCommand(program);
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

describe('policy helpers', () => {
  it('finds a policy by id, builtin key, prefix or name and refuses a clash', () => {
    expect(findPolicy(LIST, 'balanced').id).toBe('builtin:balanced');
    expect(findPolicy(LIST, 'builtin:unlimited').name).toBe('Unlimited');
    expect(findPolicy(LIST, OWN.slice(0, 8)).id).toBe(OWN);
    expect(findPolicy(LIST, 'Fare lookups').id).toBe(OWN);
    expect(() => findPolicy(LIST, 'nope')).toThrow(/No policy matches/);
    expect(() => findPolicy([...LIST, policy({ id: '22222222-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'Other', builtin: false })], '2222')).toThrow(/several/);
  });

  it('shows tiers, unlimited budgets and flags in a line', () => {
    expect(policyLine(LIST[0]!)).toMatch(/fast -> standard.*60 actions, 20 min, unlimited model calls, cost unlimited.*built-in, default/);
    expect(policyLine(LIST[1]!)).toMatch(/unlimited actions, unlimited min.*no hard stop/);
  });

  it('describes a run from what the API reports and nothing else', () => {
    expect(runPolicyLines({})).toEqual([]);
    expect(costText({ costUsd: 0.1234, costKnown: true })).toBe('$0.1234');
    expect(costText({ costUsd: 3.5, costKnown: false })).toMatch(/^\$3\.50\+/);
    expect(costText({})).toBeNull();
    expect(runPolicyLines({ budget: { percent: { actions: null, cost: null } } })).toEqual(['budget: no limit']);
    expect(runPolicyLines({ policy: { id: 'builtin:balanced', name: 'Balanced', version: 1 }, currentTier: 'standard', model: 'model-x', costUsd: 0.02, costKnown: true, modelCalls: 4, budget: { percent: { actions: 41.6, modelCalls: null, cost: 12 } }, stopReason: 'budget_cost' })).toEqual([
      'policy: Balanced v1',
      'tier standard, model model-x',
      'cost: $0.0200, 4 model calls',
      'budget: actions 42%, cost 12%',
      'stopped: budget_cost',
    ]);
  });
});

describe('hexactra policies', () => {
  it('list prints each policy, or JSON', async () => {
    fakeApi({ 'GET /agent-policies': LIST });
    const text = await run('policies', 'list');
    expect(text).toMatch(/builtin:balanced +Balanced/);
    expect(text).toMatch(new RegExp(`${OWN.slice(0, 8)} +Fare lookups`));
    expect(JSON.parse(await run('policies', 'list', '--json'))).toHaveLength(3);
  });

  it('show resolves a name and prints the spec', async () => {
    const calls = fakeApi({ 'GET /agent-policies': LIST, [`GET /agent-policies/${OWN}`]: LIST[2] });
    const text = await run('policies', 'show', 'Fare lookups');
    expect(calls.at(-1)).toMatchObject({ method: 'GET', path: `/agent-policies/${OWN}` });
    expect(text).toMatch(/Fare lookups/);
    expect(text).toMatch(/"maxActions": 60/);
  });

  it('export writes the file and import sends it back: a round trip against a mocked API', async () => {
    const file = { kind: 'hexactra.agent-policies', formatVersion: 1, exportedAt: '2026-11-17T00:00:00Z', policies: [{ name: 'Fare lookups', description: null, spec: LIST[2]!.spec }] };
    const calls = fakeApi({
      'GET /agent-policies': LIST,
      'GET /agent-policies/export': file,
      'POST /agent-policies/import': { created: [{ index: 0, id: 'x', name: 'Fare lookups (2)', renamedFrom: 'Fare lookups' }], replaced: [], skipped: [], warnings: [{ index: 0, name: 'Fare lookups', code: 'PIN_DROPPED', message: 'pin dropped' }], errors: [] },
    });
    const dir = mkdtempSync(join(tmpdir(), 'policies-'));
    const path = join(dir, 'p.json');
    expect(await run('policies', 'export', '--ids', 'Fare lookups', '--no-pins', '-o', path)).toMatch(/wrote/);
    expect(calls.find((c) => c.path === '/agent-policies/export')).toMatchObject({ query: `?ids=${encodeURIComponent(OWN)}&includePins=false` });
    expect(JSON.parse(readFileSync(path, 'utf8'))).toEqual(file);
    // Without -o the file goes to stdout, ready to pipe.
    expect(JSON.parse(await run('policies', 'export'))).toEqual(file);
    expect(calls.filter((c) => c.path === '/agent-policies/export').at(-1)).toMatchObject({ query: '?ids=all&includePins=true' });

    const text = await run('policies', 'import', path, '--on-conflict', 'replace');
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/agent-policies/import', body: { file, onConflict: 'replace' } });
    expect(text).toMatch(/created +Fare lookups \(2\) \(was "Fare lookups"\)/);
    expect(text).toMatch(/warning +Fare lookups: pin dropped/);
    await expect(run('policies', 'import', path, '--on-conflict', 'merge')).rejects.toThrow(/rename, skip or replace/);
    writeFileSync(path, 'not json');
    await expect(run('policies', 'import', path)).rejects.toThrow(/as JSON/);
  });

  it('default shows, sets and resets the default policy', async () => {
    const calls = fakeApi({ 'GET /agent-policies/default': { policyId: 'builtin:balanced', explicit: false }, 'PUT /agent-policies/default': { policyId: OWN, explicit: true }, 'GET /agent-policies': LIST });
    expect(await run('policies', 'default')).toMatch(/builtin:balanced \(not chosen/);
    expect(await run('policies', 'default', 'Fare lookups')).toMatch(new RegExp(OWN));
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', body: { policyId: OWN } });
    await run('policies', 'default', '--reset');
    expect(calls.at(-1)).toMatchObject({ method: 'PUT', body: { policyId: null } });
  });
});

describe('hexactra runs with a policy', () => {
  it('runs start --policy sends policyId (a full reference as it is, a name looked up)', async () => {
    const calls = fakeApi({ 'POST /runs': { id: 'run-1' }, 'GET /agent-policies': LIST });
    await run('runs', 'start', 'Find a fare', '--policy', 'builtin:thorough');
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: '/runs', body: { goal: 'Find a fare', policyId: 'builtin:thorough' } });
    await run('runs', 'start', 'Find a fare', '--policy', 'Fare lookups');
    expect(calls.at(-1)!.body).toMatchObject({ policyId: OWN });
    await run('runs', 'start', 'No policy');
    expect(calls.at(-1)!.body).not.toHaveProperty('policyId');
  });

  it('tasks run, tasks create/update and schedules create take --policy', async () => {
    const calls = fakeApi({ 'GET /tasks': [{ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', name: 'T', goal: 'g', profile: 'default', allowedDomains: [] }], 'POST /tasks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/runs': { id: 'r' }, 'POST /tasks': { id: 't' }, 'PATCH /tasks/t': { id: 't' }, 'POST /schedules': { id: 's', nextRunAt: 'soon' } });
    await run('tasks', 'run', 'aaaaaaaa', '--policy', 'builtin:economy');
    expect(calls.at(-1)).toMatchObject({ path: '/tasks/aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa/runs', body: { policyId: 'builtin:economy' } });
    await run('tasks', 'create', 'N', 'goal', '--policy', 'builtin:thorough');
    expect(calls.at(-1)!.body).toMatchObject({ policyId: 'builtin:thorough' });
    await run('tasks', 'update', 't', '--policy', 'default');
    expect(calls.at(-1)).toMatchObject({ method: 'PATCH', body: { policyId: null } });
    await run('schedules', 'create', 't', '0 9 * * *', '--policy', 'builtin:economy');
    expect(calls.at(-1)!.body).toMatchObject({ policyId: 'builtin:economy' });
  });

  it('runs list and show print the policy and the cost the API reports', async () => {
    const r = { id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', status: 'succeeded', goal: 'Find a fare', stepCount: 3, result: 'ok', error: null, createdAt: '', steps: [], policy: { id: 'builtin:balanced', name: 'Balanced', version: 1, builtin: true }, costUsd: 0.05, costKnown: true, modelCalls: 6, stopReason: null };
    fakeApi({ 'GET /runs': [r], [`GET /runs/${r.id}`]: r });
    expect(await run('runs', 'list')).toMatch(/Balanced +\$0\.0500 +Find a fare/);
    const shown = await run('runs', 'show', r.id);
    expect(shown).toMatch(/policy: Balanced v1/);
    expect(shown).toMatch(/cost: \$0\.0500, 6 model calls/);
    expect(shown).not.toMatch(/budget:|stopped:/);
  });

  it('the Runs screen shows the policy, tier and cost columns, and the detail lines', async () => {
    const r = { id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', status: 'running', goal: 'Find a fare', stepCount: 2, steps: [], policy: { id: 'builtin:economy', name: 'Economy', version: 1 }, currentTier: 'fast', costUsd: 0.0123, costKnown: true, modelCalls: 2 };
    fakeApi({ 'GET /runs': { items: [r], nextCursor: null }, [`GET /runs/${r.id}`]: r });
    const screen = await renderTuiScreen(RunsScreen, {});
    await vi.waitFor(() => expect(stripAnsi(screen.lastFrame() ?? '')).toMatch(/Economy +fast +\$0\.0123 +Find a fare/));
    screen.stdin.write('\r');
    await vi.waitFor(() => expect(stripAnsi(screen.lastFrame() ?? '')).toMatch(/policy: Economy v1/));
    expect(stripAnsi(screen.lastFrame() ?? '')).toMatch(/tier fast/);
    screen.unmount();
  });
});
