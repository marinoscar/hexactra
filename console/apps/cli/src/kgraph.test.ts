import { Command } from 'commander';
import { createCli } from '@marinoscar/platform-cli';
import { ApiClient } from '@marinoscar/platform-cli/api-client';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_CLI_OPTIONS } from './app.js';
import { setConsoleApiFactory } from './console-api.js';
import { FACTS_APPROVE_NOTE, kgraphCommand, procedureLine, statusText, stepLine, type ProcedureDetailView, type ProcedureItemView, type SiteFactView } from './kgraph.command.js';

resetCliForTests();
createCli(APP_CLI_OPTIONS);

const TASK = '44444444-4444-4444-8444-444444444444';
const ITEM: ProcedureItemView = { id: 'kgp-1', taskId: TASK, taskName: 'Pay the bill', name: 'Pay the bill', versionId: 'kgv-2', versionNumber: 2, state: 'active', health: 'healthy', steps: 3, updatedAt: '2026-06-01T00:00:00.000Z', ledger: { runs: 4, procedureRuns: 4, cleanReplayRate: 0.75, everydayRuns: 2 } };
const DETAIL: ProcedureDetailView = {
  ...ITEM,
  enabled: true,
  versions: 2,
  activeVersion: {
    id: 'kgv-2',
    number: 2,
    state: 'active',
    changeClass: 'structural',
    createdAt: '2026-06-01T00:00:00.000Z',
    health: 'healthy',
    counts: { successes: 3, failures: 1, repairs: 0 },
    sites: ['shop.example.test'],
    savedLogins: [{ kind: 'login', label: 'Shop login' }],
    parameters: [{ name: 'PIN', sensitive: true }],
    outputs: [{ name: 'paid' }],
    steps: [
      { id: 's1', kind: 'call', label: 'Open the shop', tool: 'navigate', target: 'shop.example.test', usesAi: false, commitClass: false, health: 'healthy', args: [{ name: 'url', source: 'literal', detail: 'https://shop.example.test/' }] },
      { id: 's2', kind: 'call', label: 'Sign in', tool: 'type_secret', target: null, usesAi: false, commitClass: false, health: 'unknown', args: [{ name: 'secret', source: 'secret', detail: 'login "Shop login"' }] },
      { id: 's3', kind: 'judge', label: 'Is it paid?', tool: null, target: null, usesAi: true, commitClass: false, health: 'unknown', args: [] },
    ],
  },
};
const VERSIONS = [
  { id: 'kgv-2', number: 2, state: 'active', changeClass: 'structural', createdAt: '2026-06-01T00:00:00.000Z', health: 'healthy', counts: { successes: 3, failures: 1, repairs: 0 }, steps: 3 },
  { id: 'kgv-1', number: 1, state: 'retired', changeClass: 'initial', createdAt: '2026-05-01T00:00:00.000Z', health: 'unknown', counts: { successes: 0, failures: 0, repairs: 0 }, steps: 2 },
];

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
  kgraphCommand(program);
  let text = '';
  const spy = vi.spyOn(process.stdout, 'write').mockImplementation((chunk) => {
    text += String(chunk);
    return true;
  });
  try {
    await program.parseAsync(['node', 'hexactra', ...args]);
  } finally {
    spy.mockRestore();
  }
  return text;
}

afterEach(() => setConsoleApiFactory(null));

describe('kgraph helpers', () => {
  it('says why it is off', () => {
    expect(statusText({ deployment: false, user: true, available: false, everyday: false })).toContain('turned off by your administrator');
    expect(statusText({ deployment: true, user: false, available: false, everyday: false })).toContain('hexactra kgraph on');
    expect(statusText({ deployment: true, user: true, available: true, everyday: false })).toContain('available');
  });

  it('shows the everyday switch, and that it waits for the Knowledge Graph while that is off', () => {
    expect(statusText({ deployment: true, user: true, available: true, everyday: true })).toContain('everyday    on\n');
    expect(statusText({ deployment: true, user: true, available: true, everyday: false })).toContain('everyday    off\n');
    expect(statusText({ deployment: true, user: false, available: false, everyday: true })).toContain('everyday    on (takes effect once the Knowledge Graph is available)');
  });

  it('prints a procedure and a step on one line each', () => {
    const line = procedureLine(ITEM);
    for (const part of ['kgp-1', 'v2 active', 'healthy', '3 steps', 'Pay the bill  (task: Pay the bill)', '75% clean replays']) expect(line).toContain(part);
    expect(stepLine(DETAIL.activeVersion!.steps[2]!, 2)).toContain('[uses AI]');
    expect(stepLine(DETAIL.activeVersion!.steps[1]!, 1)).toContain('secret=secret:login "Shop login"');
  });
});

describe('hexactra kgraph', () => {
  it('status, as text and JSON', async () => {
    fakeApi({ 'GET /kgraph/status': { deployment: true, user: false, available: false, everyday: false } });
    const text = await run('kgraph', 'status');
    expect(text).toContain('you         off');
    expect(text).toContain('everyday    off');
    expect(JSON.parse(await run('kgraph', 'status', '--json'))).toEqual({ deployment: true, user: false, available: false, everyday: false });
  });

  it('lists with filters, and says when the feature is off', async () => {
    const calls = fakeApi({ 'GET /kgraph/procedures': { enabled: false, procedures: [ITEM] } });
    const text = await run('kgraph', 'list', '--task', TASK, '--state', 'active', '--search', 'bill');
    expect(text).toContain('off for you');
    expect(text).toContain('kgp-1');
    expect(calls[0]!.query).toContain(`taskId=${TASK}`);
    expect(calls[0]!.query).toContain('state=active');
    expect(calls[0]!.query).toContain('q=bill');
    expect(JSON.parse(await run('kgraph', 'list', '--json')).procedures[0].id).toBe('kgp-1');
  });

  it('shows a procedure found by name as its ordered steps', async () => {
    fakeApi({ 'GET /kgraph/procedures': { enabled: true, procedures: [ITEM] }, 'GET /kgraph/procedures/kgp-1': DETAIL });
    const text = await run('kgraph', 'show', 'pay the bill');
    expect(text).toContain('version 2 of 2: active, healthy (3 clean, 1 failed, 0 repaired)');
    expect(text).toContain('parameters: PIN (sensitive)');
    expect(text).toContain('used in chats and one-off runs: 2');
    expect(text).toMatch(/1\. call +navigate +Open the shop -> shop.example.test/);
    expect(text).toMatch(/3\. judge .*Is it paid\? {2}\[uses AI\]/);
    expect(JSON.parse(await run('kgraph', 'show', 'kgp', '--json')).activeVersion.number).toBe(2);
  });

  it('lists versions, restores by number and forgets', async () => {
    const calls = fakeApi({
      'GET /kgraph/procedures': { enabled: true, procedures: [ITEM] },
      'GET /kgraph/procedures/kgp-1/versions': { enabled: true, procedureId: 'kgp-1', versions: VERSIONS },
      'POST /kgraph/procedures/kgp-1/restore': { procedureId: 'kgp-1', restoredFrom: 'kgv-1', versionId: 'kgv-3' },
      'POST /kgraph/procedures/kgp-1/forget': { procedureId: 'kgp-1', retired: 2 },
    });
    const versions = await run('kgraph', 'versions', 'kgp-1');
    expect(versions.split('\n')[0]).toMatch(/^v2 +active +structural/);
    expect(await run('kgraph', 'restore', 'kgp-1', '1')).toContain('restored Pay the bill: kgv-3 (from kgv-1)');
    expect(calls.find((c) => c.method === 'POST' && c.path.endsWith('/restore'))!.body).toEqual({ versionId: 'kgv-1' });
    await expect(run('kgraph', 'restore', 'kgp-1', '7')).rejects.toThrow(/no version 7/);
    expect(await run('kgraph', 'forget', 'kgp-1')).toContain('2 versions retired');
    await expect(run('kgraph', 'show', 'nothing')).rejects.toThrow(/No procedure matches/);
  });

  it('off and on change your own switch through the user settings', async () => {
    const calls = fakeApi({ 'PATCH /user-settings': {}, 'GET /kgraph/status': { deployment: true, user: true, available: true, everyday: false } });
    expect(await run('kgraph', 'on')).toContain('available');
    await run('kgraph', 'off');
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => c.body)).toEqual([{ kgraph: { enabled: true } }, { kgraph: { enabled: false } }]);
  });

  it('everyday on and off write kgraph.everyday only, and print the status', async () => {
    const calls = fakeApi({ 'PATCH /user-settings': {}, 'GET /kgraph/status': { deployment: true, user: true, available: true, everyday: true } });
    expect(await run('kgraph', 'everyday', 'on')).toContain('everyday    on');
    await run('kgraph', 'everyday', 'OFF');
    expect(calls.filter((c) => c.method === 'PATCH').map((c) => ({ path: c.path, body: c.body }))).toEqual([
      { path: '/user-settings', body: { kgraph: { everyday: true } } },
      { path: '/user-settings', body: { kgraph: { everyday: false } } },
    ]);
    await expect(run('kgraph', 'everyday', 'maybe')).rejects.toThrow(/kgraph everyday on/);
    expect(calls.filter((c) => c.method === 'PATCH')).toHaveLength(2);
  });

  const FACT: SiteFactView = { id: 'kgsf-1', site: 'example.com', kind: 'navigation', text: 'Invoices: Billing, then History', source: 'owner', status: 'active', evidence: { runId: null, steps: 0, screens: 0 }, lastUsedAt: '2026-11-20T10:00:00.000Z', createdAt: '2026-11-01T00:00:00.000Z' };
  const PROPOSED: SiteFactView = { ...FACT, id: 'kgsf-2', kind: 'sign_in', text: 'Sign-in asks for a one-time code', source: 'derived', status: 'proposed', lastUsedAt: null };

  it('sites lists each site with its counts', async () => {
    fakeApi({ 'GET /kgraph/sites': [{ site: 'example.com', active: 2, proposed: 1, archived: 0 }] });
    const text = await run('kgraph', 'sites');
    expect(text).toMatch(/example\.com +2 active +1 proposed +0 archived/);
    expect(JSON.parse(await run('kgraph', 'sites', '--json'))[0].site).toBe('example.com');
    fakeApi({ 'GET /kgraph/sites': [] });
    expect(await run('kgraph', 'sites')).toContain('No site facts yet');
  });

  it("facts <site> lists a site's facts, and says proposals are approved in the console", async () => {
    const calls = fakeApi({ 'GET /kgraph/sites/example.com/facts': [FACT, PROPOSED] });
    const text = await run('kgraph', 'facts', 'Example.com', '--status', 'active');
    expect(calls[0]!.path).toBe('/kgraph/sites/example.com/facts');
    expect(calls[0]!.query).toContain('status=active');
    expect(text).toMatch(/kgsf-1 +active +navigation +owner +used 2026-11-20 +Invoices: Billing, then History/);
    expect(text).toMatch(/kgsf-2 +proposed +sign_in +derived +not used yet/);
    expect(text).toContain(FACTS_APPROVE_NOTE);
  });

  it('facts add posts an owner-written fact', async () => {
    const calls = fakeApi({ 'POST /kgraph/sites/example.com/facts': FACT });
    expect(await run('kgraph', 'facts', 'add', 'example.com', '--kind', 'navigation', '--text', 'Invoices: Billing, then History')).toContain('added kgsf-1 about example.com (navigation), active');
    expect(calls[0]!.body).toEqual({ kind: 'navigation', text: 'Invoices: Billing, then History' });
    await expect(run('kgraph', 'facts', 'add', 'example.com', '--kind', 'secret', '--text', 'x')).rejects.toThrow(/--kind must be one of/);
  });

  it('offers no approve command: a proposal is approved in the console', () => {
    const program = new Command();
    kgraphCommand(program);
    const kg = program.commands.find((c) => c.name() === 'kgraph')!;
    const facts = kg.commands.find((c) => c.name() === 'facts')!;
    expect(facts.commands.map((c) => c.name())).toEqual(['add']);
    expect(kg.commands.map((c) => c.name())).not.toContain('approve');
    expect(facts.description()).toContain('approved, edited or declined in the console');
  });

  it('facts approve answers that proposals are approved in the console, and calls nothing', async () => {
    const calls = fakeApi({});
    await expect(run('kgraph', 'facts', 'approve', 'kgsf-2')).rejects.toThrow(/approved, edited or declined in the console/);
    expect(calls).toEqual([]);
  });
});
