// Deleting runs, pausing a task and the paged Runs screen (#432), against a
// fake fetch: what each command asks, what it sends and what it prints.
import { Command } from 'commander';
import { createCli } from '@marinoscar/platform-cli';
import { ApiClient } from '@marinoscar/platform-cli/api-client';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { renderTuiScreen, stripAnsi } from '@marinoscar/platform-cli/tui/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_CLI_OPTIONS } from './app.js';
import { setConsoleApiFactory } from './console-api.js';
import { runsCommand } from './runs.command.js';
import { mergeRunPages, olderThanInstant, parseDays } from './runs.js';
import { RUNS_PAGE_SIZE, RunsScreen } from './runs.screen.js';

resetCliForTests();
createCli(APP_CLI_OPTIONS);

interface Call {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
}
type Route = unknown | ((call: Call) => unknown);

/** The console API behind a fake fetch: a route is a value or a function of the call; `status` sets the HTTP status. */
function fakeApi(routes: Record<string, Route>, status: Record<string, number> = {}) {
  const calls: Call[] = [];
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = init?.method ?? 'GET';
    const call: Call = { method, path: decodeURIComponent(url.pathname.replace(/^\/api/, '')), query: url.searchParams, body: init?.body ? JSON.parse(String(init.body)) : undefined };
    calls.push(call);
    const key = `${method} ${call.path}`;
    if (!(key in routes)) return new Response(JSON.stringify({ message: 'not found' }), { status: 404 });
    const route = routes[key];
    const code = status[key] ?? 200;
    if (code === 204) return new Response(null, { status: 204 });
    return new Response(JSON.stringify({ data: typeof route === 'function' ? (route as (c: Call) => unknown)(call) : route }), { status: code, headers: { 'content-type': 'application/json' } });
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

const RUN = '66666666-6666-4666-8666-666666666666';
const TASK = '77777777-7777-4777-8777-777777777777';
const finished = { id: RUN, status: 'failed', goal: 'Find a fare', stepCount: 4 };
const sent = (calls: Call[], method: string) => calls.filter((c) => c.method === method).map((c) => c.path);

afterEach(() => setConsoleApiFactory(null));

describe('runs delete', () => {
  it('deletes one finished run with --yes', async () => {
    const calls = fakeApi({ [`GET /runs/${RUN}`]: finished, [`DELETE /runs/${RUN}`]: null }, { [`DELETE /runs/${RUN}`]: 204 });
    expect(await run('runs', 'delete', RUN, '--yes')).toBe('deleted\n');
    expect(sent(calls, 'DELETE')).toEqual([`/runs/${RUN}`]);
  });

  it('asks first: without --yes and without a terminal it deletes nothing and says how to confirm', async () => {
    const calls = fakeApi({ [`GET /runs/${RUN}`]: finished, [`DELETE /runs/${RUN}`]: null });
    const tty = process.stdin.isTTY;
    process.stdin.isTTY = false;
    try {
      await expect(run('runs', 'delete', RUN)).rejects.toThrow(/Delete run 66666666 \(Find a fare\)\? This cannot be undone: pass --yes\./);
    } finally {
      process.stdin.isTTY = tty;
    }
    expect(sent(calls, 'DELETE')).toEqual([]);
  });

  it('refuses a live run before asking, and names the way out', async () => {
    const calls = fakeApi({ [`GET /runs/${RUN}`]: { ...finished, status: 'waiting_human' } });
    await expect(run('runs', 'delete', RUN, '--yes')).rejects.toThrow(/is needs you: cancel it first \(hexactra runs cancel /);
    expect(sent(calls, 'DELETE')).toEqual([]);
  });

  it('--older-than counts the finished runs, then deletes that filter with the count it showed', async () => {
    const calls = fakeApi({
      'GET /runs/counts': { total: 14, live: 2, byStatus: { queued: 0, running: 1, waiting_human: 1, succeeded: 9, failed: 2, cancelled: 1 }, costUsd: 1.5, costKnown: true },
      'POST /runs/delete': { deleted: 12, costUsd: 1.5, skippedLive: [], notFound: [] },
    });
    const before = Date.now();
    expect(await run('runs', 'delete', '--older-than', '30', '--yes')).toBe('Deleted 12 runs.\n');
    const counted = calls.find((c) => c.path === '/runs/counts')!;
    const to = counted.query.get('to')!;
    // 30 days before now, and nothing else: the API never deletes a live run, whatever the filter.
    expect(Math.abs(Date.parse(to) - (before - 30 * 86_400_000))).toBeLessThan(60_000);
    expect([...counted.query.keys()]).toEqual(['to']);
    expect(calls.find((c) => c.method === 'POST')!.body).toEqual({ filter: { to }, expectedCount: 12 });
  });

  it('--older-than says when a queue job takes over, and does nothing when no run matches', async () => {
    fakeApi({
      'GET /runs/counts': { total: 5000, live: 0, byStatus: { queued: 0, running: 0, waiting_human: 0, succeeded: 4000, failed: 900, cancelled: 100 }, costUsd: null, costKnown: true },
      'POST /runs/delete': { jobId: 'job-1', matched: 5000, costUsd: null },
    });
    expect(await run('runs', 'delete', '--older-than', '90', '--yes')).toBe('Deleting 5000 runs in the background (job job-1).\n');

    const calls = fakeApi({ 'GET /runs/counts': { total: 0, live: 0, byStatus: { queued: 0, running: 0, waiting_human: 0, succeeded: 0, failed: 0, cancelled: 0 }, costUsd: null, costKnown: true } });
    expect(await run('runs', 'delete', '--older-than', '90', '--yes')).toBe('No finished run is older than 90 days.\n');
    expect(sent(calls, 'POST')).toEqual([]);
  });

  it('takes a run or --older-than, not both and not neither; days are a whole number from 1', async () => {
    fakeApi({});
    await expect(run('runs', 'delete')).rejects.toThrow(/Pass a run id, or --older-than/);
    await expect(run('runs', 'delete', RUN, '--older-than', '30')).rejects.toThrow(/Pass a run id, or --older-than/);
    for (const bad of ['0', '-3', '1.5', 'week']) expect(() => parseDays(bad)).toThrow(/whole number of days/);
    expect(parseDays('30')).toBe(30);
    expect(olderThanInstant(1, Date.parse('2026-11-17T10:00:00Z'))).toBe('2026-11-16T10:00:00.000Z');
  });
});

describe('tasks pause and resume', () => {
  it("posts to the task's schedules and says how many changed", async () => {
    const summary = { schedules: [{}, {}], nextRunAt: null as string | null };
    const calls = fakeApi({
      [`POST /tasks/${TASK}/schedules/pause`]: { id: TASK, summary },
      [`POST /tasks/${TASK}/schedules/resume`]: { id: TASK, summary: { ...summary, nextRunAt: '2026-11-18T08:00:00.000Z' } },
    });
    expect(await run('tasks', 'pause', TASK)).toBe('paused 2 schedules\n');
    expect(await run('tasks', 'resume', TASK)).toBe('resumed 2 schedules: next 2026-11-18T08:00:00.000Z\n');
    expect(sent(calls, 'POST')).toEqual([`/tasks/${TASK}/schedules/pause`, `/tasks/${TASK}/schedules/resume`]);
  });
});

describe('the Runs screen, paged', () => {
  const row = (n: number) => ({ id: `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`, status: 'succeeded', goal: `Goal ${n}`, stepCount: 1 });

  it('keeps the rows of the first page first and drops a row both pages hold', () => {
    expect(mergeRunPages([row(3), row(2)], [row(2), row(1)]).map((r) => r.goal)).toEqual(['Goal 3', 'Goal 2', 'Goal 1']);
    expect(mergeRunPages([], [row(1), row(1)])).toHaveLength(1);
  });

  it('asks for a page, and m loads the next one with the cursor until the list ends', async () => {
    const calls = fakeApi({
      'GET /runs': (c: Call) => (c.query.get('cursor') === 'c1' ? { items: [row(1)], nextCursor: null } : { items: [row(3), row(2)], nextCursor: 'c1' }),
    });
    const screen = await renderTuiScreen(RunsScreen, { columns: 100 });
    await screen.waitForFrame((f) => stripAnsi(f).includes('2 runs shown · m for older runs'));
    expect(calls[0]!.query.get('envelope')).toBe('1');
    expect(calls[0]!.query.get('limit')).toBe(String(RUNS_PAGE_SIZE));
    await screen.press('m');
    await screen.waitForFrame((f) => stripAnsi(f).includes('3 runs shown · that is all of them'));
    const frame = stripAnsi(screen.lastFrame() ?? '');
    expect(frame.indexOf('Goal 3')).toBeLessThan(frame.indexOf('Goal 2'));
    expect(frame.indexOf('Goal 2')).toBeLessThan(frame.indexOf('Goal 1'));
    // At the end `m` asks for nothing.
    const asked = calls.filter((c) => c.query.has('cursor')).length;
    await screen.press('m');
    expect(calls.filter((c) => c.query.has('cursor')).length).toBe(asked);
    screen.unmount();
  });
});
