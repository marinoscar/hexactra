// `hexactra runs diagnostics`, `tasks consistency`, `tasks improve [--wait]`, `tasks improvements` and `tasks improvement`
// (E52.10, #1025) against a fake fetch. No command changes a task: every request is a read, or the one POST that asks for a proposal.
import { Command } from 'commander';
import { createCli } from '@marinoscar/platform-cli';
import { ApiClient } from '@marinoscar/platform-cli/api-client';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_CLI_OPTIONS } from './app.js';
import { setConsoleApiFactory } from './console-api.js';
import { insightsCommands, setSleepForTests } from './insights.command.js';
import { consistencyLines, findingsLines, improvementLines, type Improvement } from './insights.js';

resetCliForTests();
createCli(APP_CLI_OPTIONS);

const TASK = '11111111-1111-4111-8111-111111111111';
const RUN = '33333333-3333-4333-8333-333333333333';
const IMP = '22222222-2222-4222-8222-222222222222';

const proposal = (status: string, over: Partial<Improvement> = {}): Improvement => ({
  id: IMP,
  taskId: TASK,
  status,
  runIds: [RUN],
  goalBefore: 'Send a text to {{Recipient}}.',
  proposedGoal: 'Send ONE text to {{Recipient}}. Click Send once, by position.',
  summary: 'Send was pressed three times.',
  changes: [{ kind: 'add', text: 'Click Send once, by position.', why: 'Script clicks were ignored.', evidence: [{ runId: RUN, seqFrom: 23, seqTo: 33 }] }],
  siteFacts: [{ site: 'example.test', kind: 'quirk', text: 'The Send button ignores script events.' }],
  confidence: 'high',
  error: null,
  createdAt: '2026-11-27T00:00:00Z',
  ...over,
});

function fake(routes: Record<string, unknown | (() => unknown)>) {
  const calls: { method: string; path: string; query: string; body: unknown }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace(/^\/api/, '');
    calls.push({ method, path, query: url.search, body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const hit = routes[`${method} ${path}`];
    if (hit === undefined) return new Response(JSON.stringify({ statusCode: 404, message: 'Not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    const value = typeof hit === 'function' ? (hit as () => unknown)() : hit;
    return new Response(JSON.stringify({ data: value }), { status: 200, headers: { 'content-type': 'application/json' } });
  });
  setConsoleApiFactory(() => new ApiClient({ baseUrl: 'http://console.example.test/api', token: 'pat_test', fetch }));
  return calls;
}

async function run(...args: string[]): Promise<string> {
  const program = new Command().exitOverride();
  insightsCommands(program);
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
  setSleepForTests(null);
  process.exitCode = 0;
});

const tasks = [{ id: TASK, name: 'Send a text' }];

describe('runs diagnostics', () => {
  it('prints the findings as lines, and JSON with --json', async () => {
    const d = { findings: [{ code: 'loop', severity: 'warn', title: 'Repeated 2 actions 12 times', detail: '58 steps, 47% of the run.', seqFrom: 53, seqTo: 110 }], truncated: false };
    fake({ [`GET /runs/${RUN}/diagnostics`]: d });
    expect(await run('runs', 'diagnostics', RUN)).toContain('WARN  loop               steps 53-110    Repeated 2 actions 12 times. 58 steps, 47% of the run.');
    fake({ [`GET /runs/${RUN}/diagnostics`]: d });
    expect(JSON.parse(await run('runs', 'diagnostics', RUN, '--json'))).toEqual(d);
  });
});

describe('tasks consistency', () => {
  it('finds the task by name and sends --last', async () => {
    const calls = fake({ 'GET /tasks': tasks, [`GET /tasks/${TASK}/consistency`]: { runs: 4, succeeded: 4, label: 'erratic', steps: { min: 33, median: 39, max: 124, ratio: 3.18 }, costUsd: null, activeMs: null, perRun: [{ runId: RUN, status: 'succeeded', stepCount: 124, findings: [{ code: 'loop', severity: 'warn' }] }] } });
    const text = await run('tasks', 'consistency', 'Send a text', '--last', '10');
    expect(text).toContain('Erratic: 4 of 4 runs succeeded.');
    expect(text).toContain('Steps: median 39, 33 to 124');
    expect(text).toContain('33333333  succeeded   124 steps  loop');
    expect(calls.find((c) => c.path.endsWith('/consistency'))!.query).toBe('?last=10');
  });
});

describe('tasks improve', () => {
  it('asks for a proposal and says how to read it; nothing but that POST writes', async () => {
    const calls = fake({ 'GET /tasks': tasks, [`POST /tasks/${TASK}/improvements`]: { id: IMP, status: 'queued' } });
    expect(await run('tasks', 'improve', TASK, '--run', RUN)).toContain(`hexactra tasks improvement ${IMP}`);
    expect(calls.filter((c) => c.method !== 'GET')).toEqual([{ method: 'POST', path: `/tasks/${TASK}/improvements`, query: '', body: { runIds: [RUN] } }]);
  });

  it('--wait polls until ready, then prints the proposal and how to use it', async () => {
    setSleepForTests(async () => undefined);
    let reads = 0;
    fake({ 'GET /tasks': tasks, [`POST /tasks/${TASK}/improvements`]: { id: IMP, status: 'queued' }, [`GET /task-improvements/${IMP}`]: () => (reads++ < 2 ? proposal('running') : proposal('ready')) });
    const text = await run('tasks', 'improve', 'Send a text', '--wait');
    expect(reads).toBe(3);
    expect(text).toContain('Proposed goal:');
    expect(text).toContain('To use it: open the task in the console and save the goal.');
  });

  it('a failed proposal exits non-zero with its reason', async () => {
    setSleepForTests(async () => undefined);
    fake({ 'GET /tasks': tasks, [`POST /tasks/${TASK}/improvements`]: { id: IMP, status: 'queued' }, [`GET /task-improvements/${IMP}`]: proposal('failed', { error: 'The proposal was refused twice: it names a site that is not in the task.' }) });
    expect(await run('tasks', 'improve', TASK, '--wait')).toContain('Failed: The proposal was refused twice');
    expect(process.exitCode).toBe(1);
  });
});

describe('tasks improvements and improvement', () => {
  it('lists and prints', async () => {
    fake({ 'GET /tasks': tasks, [`GET /tasks/${TASK}/improvements`]: { items: [proposal('ready')] } });
    expect(await run('tasks', 'improvements', TASK)).toContain(`${IMP}  ready`);
    fake({ [`GET /task-improvements/${IMP}`]: proposal('ready') });
    const text = await run('tasks', 'improvement', IMP);
    expect(text).toContain('add: Click Send once, by position. (Script clicks were ignored.) [33333333 steps 23-33]');
    expect(text).toContain('example.test (quirk): The Send button ignores script events.');
  });
});

describe('the words', () => {
  it('says when there are no findings, and when a proposal changes nothing', () => {
    expect(findingsLines([])).toEqual(['No findings: nothing in the steps points to wasted effort.']);
    expect(improvementLines(proposal('ready', { proposedGoal: 'Send a text to {{Recipient}}.' }))).toContain('No change proposed to the goal.');
    expect(consistencyLines({ runs: 1, succeeded: 1, label: 'not_enough_runs', steps: null, costUsd: null, activeMs: null, perRun: [] })[0]).toBe('Not enough runs yet: 1 of 1 runs succeeded.');
  });
});
