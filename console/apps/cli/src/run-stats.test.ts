// `hexactra runs stats` (E53.4, #1072) against a fake fetch: the flags it sends, the table it prints and the JSON it passes through.
import { Command } from 'commander';
import { createCli } from '@marinoscar/platform-cli';
import { ApiClient } from '@marinoscar/platform-cli/api-client';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_CLI_OPTIONS } from './app.js';
import { setConsoleApiFactory } from './console-api.js';
import { insightsCommands } from './insights.command.js';
import { statsLines, statsQuery, timeArg, type RunStats, type StatsGroup } from './run-stats.js';

resetCliForTests();
createCli(APP_CLI_OPTIONS);

const TASK = '11111111-1111-4111-8111-111111111111';
const NOW = Date.parse('2026-11-27T12:00:00Z');

const dist = (p50: number, p90: number, sum = p50 * 10) => ({ n: 10, sum, mean: p50, min: 0, p50, p90, max: p90 * 2 });
function group(over: Partial<StatsGroup> = {}): StatsGroup {
  return {
    runs: 12,
    finished: 10,
    live: 2,
    byStatus: { queued: 0, running: 2, waiting_human: 0, paused: 0, succeeded: 8, failed: 1, cancelled: 1 },
    successRate: 0.8,
    costPerSuccessUsd: 0.0525,
    costKnown: true,
    metrics: {
      workingMs: dist(90_000, 300_000),
      wallMs: dist(120_000, 600_000),
      steps: dist(19, 52),
      modelCalls: dist(30, 80),
      inputTokens: dist(40_000, 120_000),
      cachedInputTokens: dist(10_000, 30_000),
      outputTokens: dist(2_000, 6_000),
      totalTokens: dist(42_000, 126_000),
      costUsd: dist(0.04, 0.11, 0.42),
    },
    ...over,
  };
}
const stats = (over: Partial<RunStats> = {}): RunStats => ({ groupBy: 'none', timeZone: 'UTC', scanned: 12, truncated: false, total: group(), groups: [], groupsTruncated: false, ...over });

function fake(routes: Record<string, unknown>) {
  const calls: { path: string; query: URLSearchParams }[] = [];
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    const path = url.pathname.replace(/^\/api/, '');
    calls.push({ path, query: url.searchParams });
    const hit = routes[`GET ${path}`];
    if (hit === undefined) return new Response(JSON.stringify({ statusCode: 404, message: 'Not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    return new Response(JSON.stringify({ data: hit }), { status: 200, headers: { 'content-type': 'application/json' } });
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
  vi.restoreAllMocks();
});

describe('timeArg', () => {
  it('reads relative times back from now', () => {
    expect(timeArg('7d', NOW)).toBe('2026-11-20T12:00:00.000Z');
    expect(timeArg('24h', NOW)).toBe('2026-11-26T12:00:00.000Z');
    expect(timeArg('2w', NOW)).toBe('2026-11-13T12:00:00.000Z');
  });
  it('reads a date as UTC midnight and keeps a date-time with a zone', () => {
    expect(timeArg('2026-06-01')).toBe('2026-06-01T00:00:00.000Z');
    expect(timeArg('2026-06-01T08:00:00-06:00')).toBe('2026-06-01T14:00:00.000Z');
  });
  it('refuses anything else, and a date-time without a zone', () => {
    expect(() => timeArg('last week')).toThrow(/not a time/);
    expect(() => timeArg('2026-06-01T08:00:00')).toThrow(/not a time/);
  });
});

describe('statsQuery', () => {
  it('maps the flags to the API parameters', () => {
    expect(statsQuery({ by: 'task', from: '7d', status: 'failed,cancelled', stopReason: 'budget', policy: 'builtin:economy', trigger: 'schedule', origin: 'cli', q: 'fares', tz: 'America/Costa_Rica' }, TASK, NOW)).toEqual({
      groupBy: 'task',
      from: '2026-11-20T12:00:00.000Z',
      taskId: TASK,
      status: 'failed,cancelled',
      stopReason: 'budget',
      policyId: 'builtin:economy',
      trigger: 'schedule',
      origin: 'cli',
      q: 'fares',
      tz: 'America/Costa_Rica',
    });
  });
  it('defaults to the total and refuses an unknown grouping', () => {
    expect(statsQuery({})).toEqual({ groupBy: 'none' });
    expect(() => statsQuery({ by: 'goal' })).toThrow(/--by must be one of/);
  });
});

describe('statsLines', () => {
  it('prints the total as one row with the p50/p90 columns and a note', () => {
    const lines = statsLines(stats());
    expect(lines[0]).toMatch(/RUNS\s+OK\s+STEPS p50\/p90\s+TIME p50\/p90\s+TOKENS p50\/p90\s+COST p50\/p90\s+COST TOTAL\s+\$\/SUCCESS/);
    expect(lines[1]).toMatch(/^All runs\s+12\s+80%\s+19\/52\s+1\.5m\/5\.0m\s+42\.0k\/126\.0k\s+\$0\.0400\/\$0\.1100\s+\$0\.4200\s+\$0\.0525$/);
    expect(lines).toContain('10 finished (8 succeeded, 1 failed, 1 cancelled), 2 live. Percentiles are over finished runs; time is working time.');
  });

  it('prints one row per group, then the total', () => {
    const s = stats({ groupBy: 'task', groups: [{ ...group({ runs: 9 }), key: TASK, label: 'Check fares' }, { ...group({ runs: 3, successRate: null }), key: 'none', label: 'No task' }] });
    const lines = statsLines(s);
    expect(lines[0]).toMatch(/^TASK\s+RUNS/);
    expect(lines[1]).toMatch(/^Check fares\s+9\s+80%/);
    expect(lines[2]).toMatch(/^No task\s+3\s+-/);
    expect(lines[3]).toMatch(/^TOTAL\s+12/);
  });

  it('marks an unknown cost as a lower bound and says when it read only part', () => {
    const lines = statsLines(stats({ total: group({ costKnown: false }), truncated: true, scanned: 100_000 }));
    expect(lines[1]).toContain('≥$0.4200');
    expect(lines).toContain('≥: a model had no price, so the cost is a lower bound.');
    expect(lines).toContain('Only the newest 100000 runs were read: narrow --from/--to for exact numbers.');
  });

  it('names the time zone of days and says when nothing matched', () => {
    expect(statsLines(stats({ groupBy: 'day', timeZone: 'America/Costa_Rica', groups: [{ ...group(), key: '2026-06-01', label: '2026-06-01' }] })).at(-1)).toBe('Days are in America/Costa_Rica.');
    expect(statsLines(stats({ total: group({ runs: 0 }) }))).toEqual(['No runs match.']);
  });
});

describe('hexactra runs stats', () => {
  it('resolves a task by name and sends the grouping', async () => {
    const calls = fake({ 'GET /tasks': [{ id: TASK, name: 'Check fares' }], 'GET /runs/stats': stats({ groupBy: 'day', groups: [{ ...group(), key: '2026-06-01', label: '2026-06-01' }] }) });
    const out = await run('runs', 'stats', '--task', 'Check fares', '--by', 'day', '--tz', 'UTC');
    const req = calls.find((c) => c.path === '/runs/stats')!;
    expect(req.query.get('taskId')).toBe(TASK);
    expect(req.query.get('groupBy')).toBe('day');
    expect(req.query.get('tz')).toBe('UTC');
    expect(out).toContain('2026-06-01');
  });

  it('passes `--task none` through without a lookup', async () => {
    const calls = fake({ 'GET /runs/stats': stats() });
    await run('runs', 'stats', '--task', 'none');
    expect(calls.map((c) => c.path)).toEqual(['/runs/stats']);
    expect(calls[0]!.query.get('taskId')).toBe('none');
  });

  it('reads every user with --all, by user, and keeps --task an id', async () => {
    const calls = fake({ 'GET /admin/runs/stats': stats({ groupBy: 'user', groups: [{ ...group(), key: TASK, label: 'Ana' }] }) });
    const out = await run('runs', 'stats', '--all', '--by', 'user', '--task', TASK);
    expect(calls.map((c) => c.path)).toEqual(['/admin/runs/stats']);
    expect(calls[0]!.query.get('groupBy')).toBe('user');
    expect(calls[0]!.query.get('taskId')).toBe(TASK);
    expect(out).toMatch(/^USER\s+RUNS/);
  });

  it('refuses --by user without --all, and --q with --all', async () => {
    fake({});
    await expect(run('runs', 'stats', '--by', 'user')).rejects.toThrow('--by user needs --all');
    await expect(run('runs', 'stats', '--all', '--q', 'money')).rejects.toThrow(/--q is not offered with --all/);
  });

  it('prints the API answer unchanged with --json', async () => {
    const answer = stats();
    fake({ 'GET /runs/stats': answer });
    expect(JSON.parse(await run('runs', 'stats', '--json'))).toEqual(answer);
  });

  it('fails with a clear message for an unknown task', async () => {
    fake({ 'GET /tasks': [] });
    await expect(run('runs', 'stats', '--task', 'nope')).rejects.toThrow(/No task "nope"/);
  });
});
