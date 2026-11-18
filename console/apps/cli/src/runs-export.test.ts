// `hexactra runs export <id>` (#542) against a fake fetch: the file it
// writes, the query it sends (--no-screenshots), the default file name, and
// a clear error with no file for a run that is not there.
import { existsSync, mkdtempSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { Command } from 'commander';
import { createCli } from '@marinoscar/platform-cli';
import { ApiClient } from '@marinoscar/platform-cli/api-client';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { APP_CLI_OPTIONS } from './app.js';
import { setConsoleApiFactory } from './console-api.js';
import { runsCommand } from './runs.command.js';
import { exportFilename, exportRun, sizeText } from './runs.js';

resetCliForTests();
createCli(APP_CLI_OPTIONS);

const RUN = '66666666-6666-4666-8666-666666666666';
const TRACE = { type: 'hexactra.run-trace', formatVersion: 1, partial: false, run: { id: RUN, goal: 'Find a fare' }, steps: [{ seq: 1, screenshot: { moment: 'final', data: 'AAAA' } }] };

/** The export route behind a fake fetch: the file as JSON (no `data` envelope), or a 404 for any other run. */
function fakeExport() {
  const urls: URL[] = [];
  const fetch = vi.fn(async (input: string | URL | Request) => {
    const url = new URL(String(input));
    urls.push(url);
    if (url.pathname !== `/api/runs/${RUN}/export`) {
      return new Response(JSON.stringify({ statusCode: 404, code: 'RUN_NOT_FOUND', message: 'Run not found' }), { status: 404, headers: { 'content-type': 'application/json' } });
    }
    return new Response(JSON.stringify(TRACE), {
      status: 200,
      headers: { 'content-type': 'application/json; charset=utf-8', 'content-disposition': `attachment; filename="hexactra-run-66666666-20261118.json"` },
    });
  });
  const api = new ApiClient({ baseUrl: 'http://console.example.test/api', token: 'pat_test', fetch });
  setConsoleApiFactory(() => api);
  return { api, urls };
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

describe('runs export', () => {
  it('writes the file to -o and prints its path and size; embeds the screenshots by default', async () => {
    const { urls } = fakeExport();
    const file = join(mkdtempSync(join(tmpdir(), 'hx-export-')), 'trace.json');
    const out = await run('runs', 'export', RUN, '-o', file);
    expect(JSON.parse(readFileSync(file, 'utf8'))).toEqual(TRACE);
    expect(out).toMatch(new RegExp(`^wrote ${file.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(\\d+ B\\)\\n$`));
    expect(urls[0]!.searchParams.get('screenshots')).toBe('embed');
    expect(urls[0]!.searchParams.get('format')).toBe('json');
  });

  it('passes --no-screenshots through as screenshots=none', async () => {
    const { urls } = fakeExport();
    const file = join(mkdtempSync(join(tmpdir(), 'hx-export-')), 'trace.json');
    await run('runs', 'export', RUN, '--no-screenshots', '-o', file);
    expect(urls[0]!.searchParams.get('screenshots')).toBe('none');
  });

  it("names the file as the console does, in the given directory (the current one by default)", async () => {
    const { api } = fakeExport();
    const dir = mkdtempSync(join(tmpdir(), 'hx-export-'));
    const written = await exportRun(api, RUN, { screenshots: true, dir });
    expect(written.path).toBe(join(dir, 'hexactra-run-66666666-20261118.json'));
    expect(written.bytes).toBe(readFileSync(written.path).length);
  });

  it('says clearly that a run is not found, fails, and writes no file', async () => {
    fakeExport();
    const dir = mkdtempSync(join(tmpdir(), 'hx-export-'));
    const other = '77777777-7777-4777-8777-777777777777';
    await expect(run('runs', 'export', other, '-o', join(dir, 'x.json'))).rejects.toThrow(`Run ${other} was not found: no run of yours has this id`);
    expect(existsSync(join(dir, 'x.json'))).toBe(false);
    expect(readdirSync(dir)).toEqual([]);
  });

  it('builds the default name and sizes', () => {
    expect(exportFilename(RUN, null, new Date('2026-11-18T23:00:00Z'))).toBe('hexactra-run-66666666-20261118.json');
    expect(exportFilename(RUN, 'attachment; filename="../evil.json"', new Date('2026-11-18T00:00:00Z'))).toBe('hexactra-run-66666666-20261118.json');
    expect([sizeText(512), sizeText(2048), sizeText(3 * 1024 * 1024)]).toEqual(['512 B', '2 KB', '3.0 MB']);
  });
});
