// `hexactra tasks deliveries list|test` and `hexactra runs deliveries` (E39.6, #603), against a fake fetch.
import { Command } from 'commander';
import { createCli } from '@marinoscar/platform-cli';
import { ApiClient } from '@marinoscar/platform-cli/api-client';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_CLI_OPTIONS } from './app.js';
import { setConsoleApiFactory } from './console-api.js';
import { deliveryLines, destinationText, findDelivery, runDeliveryLines, type CliDelivery, type CliRunDelivery } from './deliveries.js';
import { runsCommand } from './runs.command.js';

resetCliForTests();
createCli(APP_CLI_OPTIONS);

interface Call {
  method: string;
  path: string;
  body: unknown;
}
type Route = unknown | ((call: Call) => unknown);

function fakeApi(routes: Record<string, Route>) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const call: Call = { method: init?.method ?? 'GET', path: decodeURIComponent(url.pathname.replace(/^\/api/, '')), body: init?.body ? JSON.parse(String(init.body)) : undefined };
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

afterEach(() => {
  setConsoleApiFactory(null);
  process.exitCode = undefined;
});

const TASK = '11111111-1111-4111-8111-111111111111';
const RUN = '22222222-2222-4222-8222-222222222222';
const D1 = '33333333-3333-4333-8333-333333333333';
const D2 = '44444444-4444-4444-8444-444444444444';

const delivery = (over: Partial<CliDelivery> & Pick<CliDelivery, 'id' | 'kind'>): CliDelivery => ({ enabled: true, when: 'always', config: {}, recipients: [], connection: null, disabledReason: null, ...over });
const DELIVERIES: CliDelivery[] = [
  delivery({ id: D1, kind: 'email', recipients: [{ address: 'person-a@example.test', state: 'own' }, { address: 'person-b@example.test', state: 'unconfirmed' }] }),
  delivery({ id: D2, kind: 'sheet_row', when: 'succeeded', connection: { id: 'c1', label: 'Work' }, enabled: false, disabledReason: 'connection_removed' }),
];

describe('tasks deliveries', () => {
  it('lists a task\'s deliveries, finding the task by name, with where each goes and whether it is on', async () => {
    const calls = fakeApi({ 'GET /tasks': [{ id: TASK, name: 'Pay the rent' }], [`GET /tasks/${TASK}/deliveries`]: DELIVERIES });
    const lines = (await run('tasks', 'deliveries', 'list', 'Pay the rent')).trimEnd().split('\n');
    expect(lines).toEqual([
      `${D1}  email  person-a@example.test (yours), person-b@example.test (NOT CONFIRMED)  [on, always]`,
      `${D2}  spreadsheet row  connection Work  [off: connection removed, when it succeeds]`,
    ]);
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual(['GET /tasks', `GET /tasks/${TASK}/deliveries`]);
  });

  it('says so for a task with none, and passes --json through', async () => {
    fakeApi({ 'GET /tasks': [{ id: TASK, name: 'Pay the rent' }], [`GET /tasks/${TASK}/deliveries`]: [] });
    expect(await run('tasks', 'deliveries', 'list', TASK)).toBe('This task sends nothing when a run ends.\n');
    fakeApi({ 'GET /tasks': [{ id: TASK, name: 'Pay the rent' }], [`GET /tasks/${TASK}/deliveries`]: DELIVERIES });
    expect(JSON.parse(await run('tasks', 'deliveries', 'list', TASK, '--json'))).toHaveLength(2);
  });

  it('sends a test to one delivery, printing the answer, the row it added, and failing the exit code when it could not', async () => {
    const calls = fakeApi({
      'GET /tasks': [{ id: TASK, name: 'Pay the rent' }],
      [`GET /tasks/${TASK}/deliveries`]: DELIVERIES,
      [`POST /tasks/${TASK}/deliveries/${D2}/test`]: { ok: true, code: null, message: 'The test was sent.', detail: { location: 'Sheet1!A2:C2' } },
    });
    expect(await run('tasks', 'deliveries', 'test', 'Pay the rent', D2.slice(0, 8))).toBe('The test was sent.\nrow: Sheet1!A2:C2\n');
    expect(calls.at(-1)).toMatchObject({ method: 'POST', path: `/tasks/${TASK}/deliveries/${D2}/test` });
    expect(process.exitCode).toBeUndefined();
    fakeApi({
      'GET /tasks': [{ id: TASK, name: 'Pay the rent' }],
      [`GET /tasks/${TASK}/deliveries`]: DELIVERIES,
      [`POST /tasks/${TASK}/deliveries/${D1}/test`]: { ok: false, code: 'EMAIL_NOT_CONFIGURED', message: 'The test could not be sent: email is not set up on this deployment.', detail: {} },
    });
    expect(await run('tasks', 'deliveries', 'test', TASK, D1)).toBe('The test could not be sent: email is not set up on this deployment.\n');
    expect(process.exitCode).toBe(1);
  });

  it('refuses a delivery that matches none', async () => {
    fakeApi({ 'GET /tasks': [{ id: TASK, name: 'Pay the rent' }], [`GET /tasks/${TASK}/deliveries`]: DELIVERIES });
    await expect(run('tasks', 'deliveries', 'test', TASK, 'zzz')).rejects.toThrow('No delivery matches "zzz"');
  });
});

describe('runs deliveries', () => {
  const log: CliRunDelivery[] = [
    { id: 'r1', deliveryId: D1, kind: 'email', status: 'sent', attempts: 1, errorCode: null, errorText: null, detail: { messages: 1 }, sentAt: '2026-11-18T18:00:00.000Z', nextAttemptAt: null },
    { id: 'r2', deliveryId: D2, kind: 'sheet_row', status: 'failed', attempts: 1, errorCode: 'CONNECTION_NEEDS_RECONNECT', errorText: 'the connection needs reconnecting', detail: {}, sentAt: null, nextAttemptAt: null },
    { id: 'r3', deliveryId: null, kind: 'webhook', status: 'pending', attempts: 2, errorCode: 'RATE_LIMITED', errorText: 'the provider asked to slow down', detail: {}, sentAt: null, nextAttemptAt: '2026-11-18T18:10:00.000Z' },
  ];

  it('prints one line per delivery with its status and the fixed reason', async () => {
    fakeApi({ [`GET /runs/${RUN}/deliveries`]: log });
    expect((await run('runs', 'deliveries', RUN)).trimEnd().split('\n')).toEqual([
      'r1  email  sent  attempts 1',
      'r2  spreadsheet row  failed: the connection needs reconnecting  attempts 1',
      'r3  webhook  pending: the provider asked to slow down  attempts 2 (next try 2026-11-18T18:10:00.000Z)',
    ]);
  });

  it('retries one entry, then lists', async () => {
    const calls = fakeApi({ [`POST /runs/${RUN}/deliveries/r2/retry`]: log[1], [`GET /runs/${RUN}/deliveries`]: [{ ...log[1], status: 'pending', errorText: null, errorCode: null }] });
    expect(await run('runs', 'deliveries', RUN, '--retry', 'r2')).toBe('r2  spreadsheet row  pending  attempts 1\n');
    expect(calls.map((c) => `${c.method} ${c.path}`)).toEqual([`POST /runs/${RUN}/deliveries/r2/retry`, `GET /runs/${RUN}/deliveries`]);
  });

  it('says so for a run with nothing sent', async () => {
    fakeApi({ [`GET /runs/${RUN}/deliveries`]: [] });
    expect(await run('runs', 'deliveries', RUN)).toBe('Nothing was sent for this run.\n');
  });
});

describe('the text helpers', () => {
  it('names a destination without a secret: an address, a webhook host (never its path), a connection\'s label', () => {
    expect(destinationText(delivery({ id: 'x', kind: 'webhook', config: { url: 'https://hooks.example.test/secret-path?token=abc' } }))).toBe('hooks.example.test');
    expect(destinationText(delivery({ id: 'x', kind: 'folder', config: { target: 'storage' } }))).toBe("the console's storage");
    expect(destinationText(delivery({ id: 'x', kind: 'folder', connection: { id: 'c', label: null } }))).toBe('connection (removed)');
    expect(destinationText(delivery({ id: 'x', kind: 'email' }))).toBe('(no address)');
    expect(deliveryLines([])).toEqual(['This task sends nothing when a run ends.']);
    expect(runDeliveryLines([])).toEqual(['Nothing was sent for this run.']);
  });

  it('finds a delivery by id or prefix and refuses an ambiguous one', () => {
    expect(findDelivery(DELIVERIES, D2.slice(0, 4)).id).toBe(D2);
    expect(() => findDelivery([delivery({ id: 'ab1', kind: 'email' }), delivery({ id: 'ab2', kind: 'email' })], 'ab')).toThrow('matches several');
  });
});
