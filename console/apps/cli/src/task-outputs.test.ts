// `runs show` with outputs and `tasks outputs` (E39.5, #600), against a fake fetch.
import { Command } from 'commander';
import { createCli } from '@marinoscar/platform-cli';
import { ApiClient } from '@marinoscar/platform-cli/api-client';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_CLI_OPTIONS } from './app.js';
import { setConsoleApiFactory } from './console-api.js';
import { runsCommand } from './runs.command.js';
import { csvField, outputLines, outputsCsv, outputsTable, outputText, type CliOutputsPage, type CliRunOutput } from './task-outputs.js';

resetCliForTests();
createCli(APP_CLI_OPTIONS);

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
}
type Route = unknown | ((call: Call) => unknown);

function fakeApi(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = { method: init?.method ?? 'GET', path: decodeURIComponent(url.pathname.replace(/^\/api/, '')), query: url.searchParams };
    calls.push(call);
    const key = `${call.method} ${call.path}`;
    if (!(key in routes)) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    const route = routes[key];
    return new Response(JSON.stringify({ data: typeof route === 'function' ? (route as (c: Call) => unknown)(call) : route }), { status: 200, headers: { 'content-type': 'application/json' } });
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

const TASK = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const out = (o: Partial<CliRunOutput> & Pick<CliRunOutput, 'key' | 'label' | 'type' | 'value'>): CliRunOutput => ({ required: true, sensitive: false, ok: true, note: null, ...o });

const outputs: CliRunOutput[] = [
  out({ key: 'confirmation_number', label: 'Confirmation number', type: 'text', value: 'C-8841' }),
  out({ key: 'amount_paid', label: 'Amount paid', type: 'money', value: { amount: 1250, currency: 'USD' } }),
  out({ key: 'paid_on', label: 'Paid on', type: 'date', value: null, ok: false, note: 'Not found' }),
  out({ key: 'account', label: 'Account', type: 'text', value: '[hidden]', sensitive: true, required: false }),
];

describe('runs show', () => {
  it('prints what the run returned after its result, not found and hidden marked', async () => {
    fakeApi({ [`GET /runs/${RUN}`]: { id: RUN, status: 'succeeded', goal: 'Pay the rent', stepCount: 3, result: 'Paid.', error: null, steps: [], outputs, outputsComplete: false } });
    const text = await run('runs', 'show', RUN);
    expect(text).toContain('result: Paid.\noutputs:\n  Confirmation number: C-8841\n  Amount paid: USD 1250\n  Paid on: not found\n  Account: [hidden]\n  (not every output was found)\n');
  });

  it('prints nothing about outputs for a run without any, and passes them through --json', async () => {
    fakeApi({ [`GET /runs/${RUN}`]: { id: RUN, status: 'succeeded', goal: 'g', stepCount: 1, result: 'ok', steps: [], outputs: null } });
    expect(await run('runs', 'show', RUN)).not.toContain('outputs:');
    fakeApi({ [`GET /runs/${RUN}`]: { id: RUN, status: 'succeeded', goal: 'g', stepCount: 1, steps: [], outputs, outputsComplete: true } });
    expect(JSON.parse(await run('runs', 'show', RUN, '--json')).outputs).toHaveLength(4);
  });
});

const page = (): CliOutputsPage => ({
  columns: [
    { key: 'confirmation_number', label: 'Confirmation number', type: 'text' },
    { key: 'amount_paid', label: 'Amount paid', type: 'money' },
    { key: 'account', label: 'Account', type: 'text', sensitive: true },
  ],
  items: [
    { runId: RUN, status: 'succeeded', createdAt: '2026-03-25T10:00:00.000Z', finishedAt: '2026-03-25T10:05:00.000Z', outputsComplete: true, values: { confirmation_number: outputs[0]!, amount_paid: outputs[1]!, account: outputs[3]! } },
    { runId: '33333333-3333-4333-8333-333333333333', status: 'failed', createdAt: '2026-02-25T10:00:00.000Z', finishedAt: null, outputsComplete: false, values: { confirmation_number: out({ key: 'confirmation_number', label: 'Confirmation number', type: 'text', value: '=HYPERLINK("x")' }) } },
  ],
  nextCursor: null,
});

describe('tasks outputs', () => {
  const routes = (p: CliOutputsPage | ((c: Call) => CliOutputsPage)) => ({
    'GET /tasks': [{ id: TASK, name: 'Pay the rent', goal: 'g', profile: 'default', allowedDomains: [] }],
    [`GET /tasks/${TASK}/outputs`]: p,
  });

  it('prints a table, newest first, finding the task by name', async () => {
    const calls = fakeApi(routes(page()));
    const lines = (await run('tasks', 'outputs', 'Pay the rent')).trimEnd().split('\n');
    expect(lines[0]).toMatch(/^run\s+status\s+Confirmation number\s+Amount paid\s+Account$/);
    expect(lines[1]).toMatch(/^22222222\s+succeeded\s+C-8841\s+USD 1250\s+\[hidden\]$/);
    expect(lines[2]).toMatch(/^33333333\s+failed\s+=HYPERLINK\("x"\)\s+-\s+-$/);
    expect(calls.find((c) => c.path.endsWith('/outputs'))!.query.get('limit')).toBe('20');
  });

  it('prints CSV: a column per label, money amount and currency apart, a formula made text, hidden kept hidden', async () => {
    fakeApi(routes(page()));
    const csv = await run('tasks', 'outputs', TASK, '--csv');
    expect(csv.split('\n')).toEqual([
      'run,finished,status,Confirmation number,Amount paid,Amount paid (currency),Account',
      `${RUN},2026-03-25T10:05:00.000Z,succeeded,C-8841,1250,USD,[hidden]`,
      `33333333-3333-4333-8333-333333333333,,failed,"'=HYPERLINK(""x"")",,,`,
      '',
    ]);
  });

  it('follows the cursor until enough runs are read', async () => {
    const calls = fakeApi(
      routes((c) => (c.query.get('cursor') === 'c1' ? { ...page(), items: [page().items[1]!], nextCursor: null } : { ...page(), items: [page().items[0]!], nextCursor: 'c1' })),
    );
    const text = await run('tasks', 'outputs', TASK, '--limit', '150', '--json');
    expect(JSON.parse(text).items).toHaveLength(2);
    const asked = calls.filter((c) => c.path.endsWith('/outputs'));
    expect(asked.map((c) => c.query.get('limit'))).toEqual(['100', '100']);
    expect(asked[1]!.query.get('cursor')).toBe('c1');
  });

  it('says so for a task with no outputs, or none returned yet, and refuses a bad limit or an unknown task', async () => {
    fakeApi(routes({ columns: [], items: [], nextCursor: null }));
    expect(await run('tasks', 'outputs', TASK)).toMatch(/has no outputs/);
    fakeApi(routes({ ...page(), items: [] }));
    expect(await run('tasks', 'outputs', TASK)).toMatch(/No finished run of this task has returned outputs yet/);
    await expect(run('tasks', 'outputs', TASK, '--limit', '0')).rejects.toThrow(/--limit/);
    await expect(run('tasks', 'outputs', 'nope')).rejects.toThrow(/No task matches "nope"/);
  });
});

describe('the text helpers', () => {
  it('reads a value for a person', () => {
    expect(outputText(outputs[1]!)).toBe('USD 1250');
    expect(outputText(outputs[2]!)).toBe('not found');
    expect(outputText(out({ key: 'k', label: 'K', type: 'number', value: null, ok: false, note: 'Not a number' }))).toBe('not found (not a number)');
    expect(outputText(out({ key: 'k', label: 'K', type: 'boolean', value: true }))).toBe('Yes');
    expect(outputText(out({ key: 'k', label: 'K', type: 'text', value: null, ok: true }))).toBe('');
  });
  it('quotes a CSV field only when it must, and keeps a negative number a number', () => {
    expect(csvField('plain')).toBe('plain');
    expect(csvField('a,b')).toBe('"a,b"');
    expect(csvField('say "hi"')).toBe('"say ""hi"""');
    expect(csvField('-12.5')).toBe('-12.5');
    expect(csvField('+cmd')).toBe("'+cmd");
  });
  it('has nothing to say for no outputs', () => {
    expect(outputLines(null, null)).toEqual([]);
    expect(outputLines([], true)).toEqual([]);
    expect(outputsTable({ columns: [], items: [] })).toEqual(['run  status']);
    expect(outputsCsv({ columns: [], items: [] })).toBe('run,finished,status\n');
  });
});
