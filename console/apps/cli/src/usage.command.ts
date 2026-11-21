import { writeFileSync } from 'node:fs';

import type { Command } from 'commander';
import type { CliCommandRegistration } from '@marinoscar/platform-cli/core';

import { consoleApi, consoleCredentials } from './console-api.js';
import { USAGE_BREAKDOWNS, USAGE_RANGES, fetchUsageCsv, usageReportText, type UsageCsvTarget, type UsageReportView } from './usage.js';

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};

let csvTargetFactory: (() => UsageCsvTarget) | null = null;

/** Tests swap where `usage export` fetches from (a fake fetch, no real login). */
export function setUsageCsvTarget(next: (() => UsageCsvTarget) | null): void {
  csvTargetFactory = next;
}

export interface UsageOpts {
  range: string;
  all?: boolean;
  by?: string;
  model?: string;
  feature?: string;
  user?: string;
  tz?: string;
}

/** The query of both routes, validated here so a typo fails before the request. */
export function usageQuery(o: UsageOpts): Record<string, string> {
  if (!USAGE_RANGES.includes(o.range as (typeof USAGE_RANGES)[number])) throw new Error(`--range is one of ${USAGE_RANGES.join(', ')}`);
  if (o.by && !USAGE_BREAKDOWNS.includes(o.by as (typeof USAGE_BREAKDOWNS)[number])) throw new Error(`--by is one of ${USAGE_BREAKDOWNS.join(', ')}`);
  if (o.user && !o.all) throw new Error('--user needs --all');
  if (o.by === 'user' && !o.all) throw new Error('--by user needs --all');
  const q: Record<string, string> = { range: o.range, scope: o.all ? 'all' : 'me' };
  if (o.by) q.breakdown = o.by;
  if (o.model) q.model = o.model;
  if (o.feature) q.feature = o.feature;
  if (o.user) q.userId = o.user;
  if (o.tz) q.tz = o.tz;
  return q;
}

const common = (c: Command): Command =>
  c
    .option('--range <range>', `${USAGE_RANGES.join(', ')} (1y is by month)`, '30d')
    .option('--all', "every user's usage (needs ai_config:read)")
    .option('--user <id>', 'only this user (with --all)')
    .option('--model <id>', 'only this model')
    .option('--feature <id>', 'only this AI feature (browser_agent, chat_orchestrator, ...)')
    .option('--tz <zone>', 'IANA time zone of the days and months (default: your setting)');

/** `hexactra usage …` over /api/usage: AI token use and cost. */
export const usageCommand: CliCommandRegistration = (program: Command) => {
  const usage = program.command('usage').description('AI usage and cost: tokens and dollars by day, month and model');
  common(usage.command('report').description('Tokens, requests and cost, by model and by day (or month)'))
    .option('--by <breakdown>', `split the series: ${USAGE_BREAKDOWNS.join(', ')}`)
    .option('--json', 'print JSON')
    .action(async (o: UsageOpts & { json?: boolean }) => {
      const r = await consoleApi().get<UsageReportView>('/usage/report', { query: usageQuery(o) });
      if (o.json) out(JSON.stringify(r, null, 2));
      else usageReportText(r).forEach(out);
    });
  common(usage.command('export').description('Download the usage as a CSV file (one line per period, model and feature)'))
    .option('-o, --out <file>', 'write to this file ("-" for stdout)', '-')
    .action(async (o: UsageOpts & { out: string }) => {
      const target = csvTargetFactory ? csvTargetFactory() : consoleCredentials();
      const csv = await fetchUsageCsv(target, usageQuery(o));
      if (o.out === '-') {
        process.stdout.write(csv);
        return;
      }
      writeFileSync(o.out, csv);
      out(`Wrote ${csv.split('\r\n').filter(Boolean).length - 1} line(s) to ${o.out}`);
    });
};
