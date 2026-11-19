// `hexactra dev scenario-from-trace` (#587): the file it writes from the exported trace fixture of the API's specs, the TODO list it prints,
// a refusal to replace a file, and a clear error for a file that is not a run trace.
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { Command } from 'commander';
import { createCli } from '@marinoscar/platform-cli';
import { resetCliForTests } from '@marinoscar/platform-cli/testing';
import { describe, expect, it, vi } from 'vitest';

import { APP_CLI_OPTIONS } from './app.js';
import { defaultScenarioName, devCommand } from './dev.command.js';

resetCliForTests();
createCli(APP_CLI_OPTIONS);

const FIXTURE = fileURLToPath(new URL('../../api/test/fixtures/run-trace-transfer.json', import.meta.url));

async function run(...args: string[]): Promise<{ out: string; err: string }> {
  const program = new Command().exitOverride();
  devCommand(program);
  let out = '';
  let err = '';
  const o = vi.spyOn(process.stdout, 'write').mockImplementation((c) => ((out += String(c)), true));
  const e = vi.spyOn(process.stderr, 'write').mockImplementation((c) => ((err += String(c)), true));
  try {
    await program.parseAsync(['node', 'hexactra', ...args]);
  } finally {
    o.mockRestore();
    e.mockRestore();
  }
  return { out, err };
}

describe('dev scenario-from-trace', () => {
  it('writes a scenario skeleton from an exported trace and lists what is left to finish', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hx-scn-')), 'transfer.scenario.json');
    const { out, err } = await run('dev', 'scenario-from-trace', FIXTURE, '--out', file);
    expect(out).toBe(`Wrote ${file}\n`);
    const scenario = JSON.parse(readFileSync(file, 'utf8'));
    expect(scenario.goal).toBe('Send 25.00 to Person A from the Checking account');
    expect(scenario.task.allowedDomains).toEqual(['site-1.example.test']);
    expect(err).toMatch(/A skeleton, not a recording/);
    expect(err).toMatch(/TODO /);
  });

  it('prints the scenario with --out - and writes nothing', async () => {
    const { out } = await run('dev', 'scenario-from-trace', FIXTURE, '--out', '-');
    expect(JSON.parse(out).expect.status).toBe('succeeded');
  });

  it('does not replace a file without --force', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'hx-scn-')), 'x.scenario.json');
    writeFileSync(file, 'keep');
    await expect(run('dev', 'scenario-from-trace', FIXTURE, '--out', file)).rejects.toThrow(/exists: pass --force/);
    expect(readFileSync(file, 'utf8')).toBe('keep');
    await run('dev', 'scenario-from-trace', FIXTURE, '--out', file, '--force');
    expect(JSON.parse(readFileSync(file, 'utf8')).name).toMatch(/^TODO name/);
  });

  it('refuses a file that is not a run trace, and writes nothing', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'hx-scn-'));
    const bad = join(dir, 'other.json');
    writeFileSync(bad, JSON.stringify({ type: 'something-else' }));
    await expect(run('dev', 'scenario-from-trace', bad, '--out', join(dir, 'out.json'))).rejects.toThrow(/not a run trace/);
    expect(existsSync(join(dir, 'out.json'))).toBe(false);
  });

  it('names the default file after the trace', () => {
    expect(defaultScenarioName('/tmp/hexactra-run-66666666-20261118.json')).toBe('hexactra-run-66666666-20261118.scenario.json');
  });
});
