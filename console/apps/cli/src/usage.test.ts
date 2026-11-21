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
import { setUsageCsvTarget, usageCommand, usageQuery } from './usage.command.js';
import { usageReportText, usd, type UsageReportView } from './usage.js';

resetCliForTests();
createCli(APP_CLI_OPTIONS);

const REPORT: UsageReportView = {
  range: '7d',
  scope: 'me',
  timeZone: 'America/Chicago',
  granularity: 'day',
  from: '2026-11-15',
  to: '2026-11-21',
  buckets: ['2026-11-20', '2026-11-21'],
  series: [{ key: 'openai:gpt-6-luna', label: 'gpt-6-luna', costUsd: [0, 1.25], tokens: [0, 1_200_000], requests: [0, 12] }],
  totals: { requests: 12, failed: 1, inputTokens: 1_000_000, cachedInputTokens: 400_000, outputTokens: 200_000, reasoningTokens: 50_000, tokens: 1_200_000, costUsd: 1.25, costKnown: false },
  byModel: [{ key: 'openai:gpt-6-luna', provider: 'openai', model: 'gpt-6-luna', requests: 12, tokens: 1_200_000, costUsd: 1.25, costShare: 1 }],
  unpricedModels: ['openai:mystery'],
  runs: { count: 3, succeeded: 2, costUsd: 1, avgSuccessCostUsd: 0.4 },
  pricing: { overridesApplied: false },
};

async function run(...args: string[]): Promise<string> {
  const program = new Command().exitOverride();
  usageCommand(program);
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
  setUsageCsvTarget(null);
});

describe('usage helpers', () => {
  it('validates the range, the breakdown and --user before any request', () => {
    expect(usageQuery({ range: '1y', all: true, by: 'user', user: '11111111-1111-4111-8111-111111111111' })).toEqual({ range: '1y', scope: 'all', breakdown: 'user', userId: '11111111-1111-4111-8111-111111111111' });
    expect(() => usageQuery({ range: '2y' })).toThrow(/--range/);
    expect(() => usageQuery({ range: '7d', by: 'colour' })).toThrow(/--by/);
    expect(() => usageQuery({ range: '7d', user: 'x' })).toThrow(/--all/);
    expect(() => usageQuery({ range: '7d', by: 'user' })).toThrow(/--all/);
  });

  it('formats dollars, small amounts and lower bounds', () => {
    expect(usd(1.234)).toBe('$1.23');
    expect(usd(0.0042)).toBe('$0.0042');
    expect(usd(2, false)).toBe('≥ $2.00');
  });

  it('prints totals, the token split, models and only the days with usage', () => {
    const text = usageReportText(REPORT).join('\n');
    expect(text).toContain('Cost        ≥ $1.25');
    expect(text).toContain('input 600,000, cached 400,000, output 150,000, reasoning 50,000');
    expect(text).toContain('$0.40 per successful run');
    expect(text).toContain('No price for openai:mystery');
    expect(text).toContain('2026-11-21');
    expect(text).not.toContain('2026-11-20 ');
  });
});

describe('hexactra usage', () => {
  it('report asks /api/usage/report with the flags', async () => {
    const seen: string[] = [];
    const fetch = vi.fn(async (input: string | URL | Request) => {
      seen.push(String(input));
      return new Response(JSON.stringify({ data: REPORT }), { status: 200, headers: { 'content-type': 'application/json' } });
    });
    setConsoleApiFactory(() => new ApiClient({ baseUrl: 'http://console.example.test/api', token: 'pat_test', fetch }));
    const out = await run('usage', 'report', '--range', '90d', '--by', 'tokenType', '--feature', 'browser_agent');
    expect(seen[0]).toContain('/api/usage/report?');
    expect(seen[0]).toContain('range=90d');
    expect(seen[0]).toContain('breakdown=tokenType');
    expect(seen[0]).toContain('feature=browser_agent');
    expect(out).toContain('AI usage 2026-11-15 to 2026-11-21');
  });

  it('export writes the CSV the console returns, and reports a refusal', async () => {
    const csv = 'period,provider\r\n2026-11-21,openai\r\n';
    let url = '';
    setUsageCsvTarget(() => ({
      apiBaseUrl: 'http://console.example.test/api',
      token: 'pat_test',
      fetch: vi.fn(async (input: string | URL | Request) => {
        url = String(input);
        return new Response(csv, { status: 200, headers: { 'content-type': 'text/csv' } });
      }),
    }));
    const file = join(mkdtempSync(join(tmpdir(), 'usage-')), 'u.csv');
    const out = await run('usage', 'export', '--range', '1y', '--all', '-o', file);
    expect(url).toBe('http://console.example.test/api/usage/export.csv?range=1y&scope=all');
    expect(readFileSync(file, 'utf8')).toBe(csv);
    expect(out).toContain('Wrote 1 line(s)');

    setUsageCsvTarget(() => ({ apiBaseUrl: 'http://x/api', token: 't', fetch: vi.fn(async () => new Response(JSON.stringify({ message: 'scope=all needs the ai_config:read permission' }), { status: 403 })) }));
    await expect(run('usage', 'export', '--all')).rejects.toThrow(/ai_config:read/);
  });
});
