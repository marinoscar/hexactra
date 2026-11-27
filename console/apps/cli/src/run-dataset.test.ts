// `hexactra runs dataset export` and `runs dataset status` (E53.4, #1072) against a fake console and a fake object store.
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Command } from 'commander';
import { createCli } from '@marinoscar/platform-cli';
import { ApiClient } from '@marinoscar/platform-cli/api-client';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_CLI_OPTIONS } from './app.js';
import { setConsoleApiFactory } from './console-api.js';
import { insightsCommands, setDatasetFetchForTests, setSleepForTests } from './insights.command.js';
import { datasetBody, dayArg, exportDataset, type ExportView } from './run-dataset.js';

resetCliForTests();
createCli(APP_CLI_OPTIONS);

const TASK = '11111111-1111-4111-8111-111111111111';
const EXPORT = '22222222-2222-4222-8222-222222222222';
const NOW = Date.parse('2026-11-27T12:00:00Z');
const SIGNED = 'https://storage.example.test/exports/users/u/run-dataset.json?X-Amz-Signature=abc';

const view = (status: ExportView['status'], over: Partial<ExportView> = {}): ExportView => ({
  id: EXPORT,
  status,
  fileName: 'hexactra-runs-2026-11-27.json',
  sizeBytes: status === 'ready' ? 42 : null,
  rowCounts: status === 'ready' ? { runs: 3, findings: 2 } : null,
  error: status === 'failed' ? 'The export could not be produced' : null,
  download: status === 'ready' ? { url: SIGNED, expiresAt: '2026-11-27T12:05:00Z' } : null,
  ...over,
});

function fake(statuses: ExportView[]) {
  const calls: { method: string; path: string; body: unknown; auth: string | null }[] = [];
  let polls = 0;
  const fetch = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(String(input));
    const method = (init?.method ?? 'GET').toUpperCase();
    const path = url.pathname.replace(/^\/api/, '');
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : undefined, auth: new Headers(init?.headers).get('authorization') });
    const json = (data: unknown) => new Response(JSON.stringify({ data }), { status: 200, headers: { 'content-type': 'application/json' } });
    if (method === 'GET' && path === '/tasks') return json([{ id: TASK, name: 'Check fares' }]);
    if (method === 'POST' && path === '/exports') return json(view('pending'));
    if (method === 'GET' && path === `/exports/${EXPORT}`) return json(statuses[Math.min(polls++, statuses.length - 1)]);
    return new Response(JSON.stringify({ statusCode: 404, message: 'Not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
  });
  setConsoleApiFactory(() => new ApiClient({ baseUrl: 'http://console.example.test/api', token: 'pat_test', fetch }));
  const downloads: { url: string }[] = [];
  setDatasetFetchForTests(async (url) => {
    downloads.push({ url });
    return new Response('{"datasets":{}}', { status: 200 });
  });
  setSleepForTests(async () => {});
  return { calls, downloads };
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
  setDatasetFetchForTests(null);
  setSleepForTests(null);
  vi.restoreAllMocks();
});

describe('datasetBody', () => {
  it('maps the flags to the run-dataset request', () => {
    expect(datasetBody({ from: '7d', to: '2026-11-26', status: 'failed', stopReason: 'budget', trigger: 'schedule', steps: true, format: 'csv' }, TASK, NOW)).toEqual({
      source: 'run-dataset',
      format: 'csv',
      request: { status: 'failed', includeSteps: true, from: '2026-11-20', to: '2026-11-26', taskId: TASK, stopReason: 'budget', trigger: 'schedule' },
    });
  });
  it('defaults to the finished runs as JSON, without steps', () => {
    expect(datasetBody({})).toEqual({ source: 'run-dataset', format: 'json', request: { status: 'finished', includeSteps: false } });
  });
  it('refuses an unknown format or status, and reads relative days', () => {
    expect(() => datasetBody({ format: 'parquet' })).toThrow(/--format must be one of/);
    expect(() => datasetBody({ status: 'done' })).toThrow(/--status must be one of/);
    expect(dayArg('2w', NOW)).toBe('2026-11-13');
  });
});

describe('hexactra runs dataset export', () => {
  it('starts the export, waits until it is ready and saves the file, fetching the signed link without the token', async () => {
    const { calls, downloads } = fake([view('running'), view('ready')]);
    const dir = mkdtempSync(join(tmpdir(), 'hx-dataset-'));
    const output = join(dir, 'runs.json');
    const out = await run('runs', 'dataset', 'export', '--task', 'Check fares', '--steps', '-o', output);
    expect(calls.find((c) => c.method === 'POST')?.body).toEqual({ source: 'run-dataset', format: 'json', request: { status: 'finished', includeSteps: true, taskId: TASK } });
    expect(calls.filter((c) => c.path === `/exports/${EXPORT}`)).toHaveLength(2);
    expect(downloads).toEqual([{ url: SIGNED }]);
    expect(readFileSync(output, 'utf8')).toBe('{"datasets":{}}');
    expect(out).toBe(`wrote ${output} (15 bytes; 3 runs, 2 findings)\n`);
    // The console token goes to the console only.
    expect(calls.every((c) => c.auth === 'Bearer pat_test')).toBe(true);
  });

  it('fails with the console message when the export failed', async () => {
    fake([view('failed')]);
    await expect(run('runs', 'dataset', 'export')).rejects.toThrow('The dataset was not made (failed): The export could not be produced');
  });

  it('gives up after the wait and names the export to check later', async () => {
    fake([view('running')]);
    const api = new ApiClient({ baseUrl: 'http://console.example.test/api', token: 'pat_test', fetch: async (input, init) => {
      const path = new URL(String(input)).pathname;
      const body = (init?.method ?? 'GET').toUpperCase() === 'POST' && path.endsWith('/exports') ? view('pending') : view('running');
      return new Response(JSON.stringify({ data: body }), { status: 200, headers: { 'content-type': 'application/json' } });
    } });
    await expect(exportDataset(api, datasetBody({}), { waitMs: -1, pollMs: 0, sleep: async () => {}, fetchFile: async () => new Response('') })).rejects.toThrow(`hexactra runs dataset status ${EXPORT}`);
  });
});

describe('hexactra runs dataset status', () => {
  it('prints the status and never the signed link', async () => {
    fake([view('ready')]);
    const out = await run('runs', 'dataset', 'status', EXPORT);
    expect(out).toBe(`${EXPORT}  ready  42 bytes\n`);
    const json = await run('runs', 'dataset', 'status', EXPORT, '--json');
    expect(json).not.toContain('X-Amz-Signature');
    expect(JSON.parse(json)).toMatchObject({ id: EXPORT, status: 'ready', rowCounts: { runs: 3, findings: 2 } });
  });
});
