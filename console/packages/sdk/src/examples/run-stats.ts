// Example: how your runs behaved over the last 7 days, per task: success rate and the p50/p90 of steps, tokens and cost.
//
//   HEXACTRA_CONSOLE_URL=https://console.example.test HEXACTRA_TOKEN=pat_… node dist/examples/run-stats.js
//
// Set HEXACTRA_EXAMPLE_START=1 to start one run first (so a new account has something to count). Prints one table line per task and
// then one JSON line; it never prints the token.
import { createConsoleClient } from '../index.js';

async function main() {
  const baseUrl = process.env.HEXACTRA_CONSOLE_URL;
  const token = process.env.HEXACTRA_TOKEN;
  if (!baseUrl || !token) throw new Error('Set HEXACTRA_CONSOLE_URL and HEXACTRA_TOKEN');
  const hx = createConsoleClient({ baseUrl, token });
  if (process.env.HEXACTRA_EXAMPLE_START === '1') await hx.runs.start({ goal: 'Find a fare to Lisbon' });

  const from = new Date(Date.now() - 7 * 86_400_000).toISOString();
  const stats = await hx.runs.stats({ from, groupBy: 'task' });
  for (const g of stats.groups) {
    const m = g.metrics;
    console.log(`${g.label}: ${g.runs} runs, ${g.successRate === null ? '-' : Math.round(g.successRate * 100) + '%'} ok, steps p50 ${m.steps?.p50 ?? '-'} / p90 ${m.steps?.p90 ?? '-'}, tokens p50 ${m.totalTokens?.p50 ?? '-'}, cost p90 ${m.costUsd?.p90 ?? '-'}`);
  }
  console.log(JSON.stringify({ runs: stats.total.runs, finished: stats.total.finished, groups: stats.groups.length, groupBy: stats.groupBy, truncated: stats.truncated }));
}

main().catch((e: unknown) => {
  console.error(e instanceof Error ? e.message : e);
  process.exitCode = 1;
});
