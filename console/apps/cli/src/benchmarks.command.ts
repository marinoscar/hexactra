import type { Command } from 'commander';
import type { CliCommandRegistration } from '@marinoscar/platform-cli/core';

import { consoleApi, consoleCredentials, consoleWebUrl } from './console-api.js';
import { findHost, type FleetHost } from './fleet.js';
import { resolvePolicyId } from './policies.js';
import { sizeText } from './runs.js';
import {
  ENDED,
  EXPORT_FORMATS,
  benchmarkLine,
  comparisonText,
  exportBenchmark,
  parsePolicyFlag,
  recordedText,
  budget,
  positive,
  resolveBenchmarkId,
  scorecardText,
  suiteText,
  trialLines,
  waitForBenchmark,
  withCode,
  type BenchmarkTrialView,
  type BenchmarkView,
  type ComparisonView,
  type ExportFormat,
  type ExportTarget,
  type ScorecardView,
  type SuiteView,
} from './benchmarks.js';

const out = (s: string): void => {
  process.stdout.write(`${s}\n`);
};
const json = (v: unknown): void => out(JSON.stringify(v, null, 2));

let exportTargetFactory: (() => ExportTarget) | null = null;
let pollMs = 5_000;

/** Tests swap where `benchmarks export` fetches from (a fake fetch, no real login). */
export function setBenchmarkExportTarget(next: (() => ExportTarget) | null): void {
  exportTargetFactory = next;
}

/** Tests shorten how often `run --wait` polls. */
export function setBenchmarkPollMs(ms: number): void {
  pollMs = ms;
}

/** Every action prints an API refusal with its code (`400 CHALLENGE_UNKNOWN: ...`) and exits non-zero (the CLI's API exit code). */
function coded<A extends unknown[]>(fn: (...args: A) => Promise<void>): (...args: A) => Promise<void> {
  return async (...args: A) => {
    try {
      await fn(...args);
    } catch (e) {
      throw withCode(e);
    }
  };
}

const collect = (v: string, prev: string[] = []): string[] => [...prev, v];
/** `--record` alone is every policy and wins; `--record <policy>` adds that one (#845). */
const recordFlag = (v: string, prev: boolean | string[] | undefined): boolean | string[] => (prev === true ? true : [...(Array.isArray(prev) ? prev : []), v]);

function webLink(id: string): string | null {
  try {
    return `${consoleWebUrl()}/admin/settings/benchmarks/${id}`;
  } catch {
    return null;
  }
}

async function showBenchmark(id: string): Promise<{ benchmark: BenchmarkView; scorecard: ScorecardView }> {
  const api = consoleApi();
  const [benchmark, scorecard] = await Promise.all([api.get<BenchmarkView>(`/benchmarks/${id}`), api.get<ScorecardView>(`/benchmarks/${id}/scorecard`)]);
  return { benchmark, scorecard };
}

interface RunOpts {
  policy?: string[];
  challenge?: string[];
  trials?: string;
  capUsd?: string;
  /** `--cap`, the short spelling of `--cap-usd` (#844). */
  cap?: string;
  timeoutMinutes?: string;
  /** `--record`: every policy (`true`); `--record <policy>` (repeatable): only those (#845). */
  record?: boolean | string[];
  host?: string;
  profile?: string;
  name?: string;
  wait?: boolean;
  json?: boolean;
}

/** "started <id> (12 trials, cap $5, recording Economy)". */
export function startedLine(b: BenchmarkView): string {
  const recorded = recordedText(b.config);
  return `started ${b.id} (${b.progress.total} trials, ${b.config.capUsd === null ? 'no cap' : `cap $${b.config.capUsd}`}${recorded ? `, recording ${recorded}` : ''})`;
}

/** The body of `POST /benchmarks` from the flags; policy names and prefixes are resolved to ids. */
export async function benchmarkRequest(o: RunOpts): Promise<Record<string, unknown>> {
  if (!o.policy?.length) throw new Error('Name at least one policy: --policy builtin:economy --policy builtin:thorough (hexactra policies list shows them).');
  const policies: { ref: string; label?: string; recordVideo?: boolean }[] = [];
  const given: string[] = [];
  for (const raw of o.policy) {
    const p = parsePolicyFlag(raw);
    given.push(p.ref);
    policies.push({ ...p, ref: await resolvePolicyId(p.ref) });
  }
  // `--record <policy>` (#845): one of the --policy values, its label, or anything that resolves to the same policy.
  if (Array.isArray(o.record)) {
    for (const want of o.record) {
      const w = want.trim().toLowerCase();
      let i = policies.findIndex((p, n) => given[n]!.toLowerCase() === w || p.ref.toLowerCase() === w || p.label?.toLowerCase() === w);
      if (i < 0) {
        const id = await resolvePolicyId(want.trim()).catch(() => null);
        i = id ? policies.findIndex((p) => p.ref === id) : -1;
      }
      if (i < 0) throw new Error(`--record ${want}: not one of the --policy values (give its ref, id, name or label, or --record alone for every policy).`);
      policies[i]!.recordVideo = true;
    }
  }
  const body: Record<string, unknown> = { policies };
  if (o.name) body.name = o.name;
  if (o.challenge?.length) body.challengeIds = o.challenge;
  if (o.trials !== undefined) body.trials = positive('--trials', o.trials, true);
  // `none`, `0` or an empty value: no budget (#840, #844).
  if (o.cap !== undefined && o.capUsd !== undefined) throw new Error('Give the budget once: --cap or --cap-usd.');
  const cap = o.cap ?? o.capUsd;
  if (cap !== undefined) body.capUsd = budget(o.cap !== undefined ? '--cap' : '--cap-usd', cap);
  if (o.timeoutMinutes !== undefined) body.trialTimeoutMinutes = positive('--timeout-minutes', o.timeoutMinutes, true);
  // `--record` alone (#841): every policy's trial runs record a video (not masked, owner-only).
  if (o.record === true) body.recordVideo = true;
  if (o.host && o.host !== 'any') body.hostId = findHost(await consoleApi().get<FleetHost[]>('/fleet/hosts'), o.host).id;
  if (o.profile) body.profile = o.profile;
  return body;
}

/** `hexactra benchmarks …` over /api/benchmarks (docs/benchmark.md): an organization administrator's feature. */
export const benchmarksCommand: CliCommandRegistration = (program: Command) => {
  const bm = program.command('benchmarks').description("Benchmarks: run the challenge suite under several agent policies on a node and compare success, tokens and cost (benchmarks:read, benchmarks:run)");

  bm.command('suite')
    .description('The challenges, which the agent can attempt, the defaults and limits, and whether a node can reach the challenge site')
    .option('--json', 'print JSON')
    .action(
      coded(async (o: { json?: boolean }) => {
        const s = await consoleApi().get<SuiteView>('/benchmarks/suite');
        if (o.json) return json(s);
        suiteText(s).forEach(out);
      }),
    );

  bm.command('list')
    .description('Your benchmarks, newest first: status, passes and spend')
    .option('--limit <n>', 'how many', '20')
    .option('--json', 'print JSON')
    .action(
      coded(async (o: { limit: string; json?: boolean }) => {
        const r = await consoleApi().get<{ items: BenchmarkView[]; total: number }>('/benchmarks', { query: { limit: positive('--limit', o.limit, true) } });
        if (o.json) return json(r);
        if (!r.items.length) return out('No benchmarks yet: start one with `hexactra benchmarks run --policy builtin:economy --policy builtin:thorough`.');
        r.items.forEach((b) => out(benchmarkLine(b)));
        if (r.total > r.items.length) out(`(${r.items.length} of ${r.total}; --limit shows more)`);
      }),
    );

  bm.command('run')
    .description('Start a benchmark: every challenge under every policy, --trials times each, one trial at a time on a node. It spends on model calls up to --cap-usd')
    .option('--policy <ref>', 'an agent policy, repeatable (1 to 8): builtin:<key>, an id, or a name; `<ref>=<label>` names its column', collect)
    .option('--challenge <id>', 'a challenge, repeatable (default: the whole suite; `benchmarks suite` lists them)', collect)
    .option('--trials <n>', 'attempts per challenge and policy (default: the deployment setting, usually 3)')
    .option('--cap-usd <usd|none>', 'the budget: no new trial starts once this much is spent; 0 or "none": no budget (default: the deployment setting)')
    .option('--cap <usd|none>', 'the same as --cap-usd')
    .option('--timeout-minutes <n>', 'how long one trial may take (default: the deployment setting)')
    .option('--record [policy]', 'record a video of the trial runs (not masked; watch it on the run page): alone, of every policy; with a policy (repeatable), of that one only', recordFlag)
    .option('--host <name|id>', 'the node every trial runs on ("any": the fabric picks one per trial)')
    .option('--profile <name>', 'the browser profile on the node', 'default')
    .option('--name <name>', 'the benchmark\'s name (default: "Benchmark" and the date)')
    .option('--wait', 'follow it until it ends and print the scorecard; exits non-zero when it fails or is cancelled')
    .option('--json', 'print JSON')
    .action(
      coded(async (o: RunOpts) => {
        const api = consoleApi();
        const b = await api.post<BenchmarkView>('/benchmarks', await benchmarkRequest(o));
        if (!o.wait) {
          if (o.json) return json(b);
          out(startedLine(b));
          const link = webLink(b.id);
          return out(`follow it: hexactra benchmarks show ${b.id.slice(0, 8)}${link ? ` or ${link}` : ''}`);
        }
        if (!o.json) out(startedLine(b));
        const ended = await waitForBenchmark(api, b.id, { intervalMs: pollMs, onChange: (line) => (o.json ? undefined : out(line)) });
        const scorecard = await api.get<ScorecardView>(`/benchmarks/${b.id}/scorecard`);
        if (o.json) json({ benchmark: ended, scorecard });
        else {
          out('');
          scorecardText(ended, scorecard).forEach(out);
        }
        if (ended.status !== 'completed') {
          process.stderr.write(`benchmark ${ended.status}\n`);
          process.exitCode = 1;
        }
      }),
    );

  bm.command('show <id>')
    .description("A benchmark and its scorecard: success, reliability, speed, tokens (input, output, cached) and cost per policy, per category and for the benchmark")
    .option('--trials', 'also list every trial with its verdict, tokens, cost and run')
    .option('--json', 'print JSON (the benchmark, its scorecard and, with --trials, its trials)')
    .action(
      coded(async (ref: string, o: { trials?: boolean; json?: boolean }) => {
        const id = await resolveBenchmarkId(consoleApi(), ref);
        const { benchmark, scorecard } = await showBenchmark(id);
        const trials = o.trials ? (await consoleApi().get<{ items: BenchmarkTrialView[] }>(`/benchmarks/${id}/trials`)).items : undefined;
        if (o.json) return json({ benchmark, scorecard, ...(trials ? { trials } : {}) });
        scorecardText(benchmark, scorecard).forEach(out);
        if (trials) {
          out('');
          out('Trials');
          trialLines(trials).forEach(out);
        }
        if (!ENDED.has(benchmark.status)) out(`\nstill ${benchmark.status}: the numbers will change`);
      }),
    );

  bm.command('compare <id> <baseline>')
    .description('Compare a benchmark with an earlier one on the same suite version: deltas per policy and for the whole benchmark (tokens and cost on both sides) and the challenges that flipped')
    .option('--json', 'print JSON')
    .action(
      coded(async (ref: string, baselineRef: string, o: { json?: boolean }) => {
        const api = consoleApi();
        const id = await resolveBenchmarkId(api, ref);
        const baseline = await resolveBenchmarkId(api, baselineRef);
        const comparison = await api.get<ComparisonView>(`/benchmarks/${id}/compare`, { query: { baseline } });
        if (o.json) return json(comparison);
        comparisonText(comparison).forEach(out);
      }),
    );

  bm.command('export <id>')
    .description('Write the masked benchmark report as JSON, CSV (one row per trial) or PDF')
    .option('--format <format>', EXPORT_FORMATS.join(', '), 'json')
    .option('--paper <size>', "the PDF's paper: a4 or letter", 'a4')
    .option('--baseline <id>', 'include the comparison with this earlier benchmark')
    .option('-o, --output <file>', 'write to this file ("-" for stdout; default: the console\'s file name in the current directory)')
    .action(
      coded(async (ref: string, o: { format: string; paper: string; baseline?: string; output?: string }) => {
        const format = o.format.toLowerCase();
        if (!EXPORT_FORMATS.includes(format as ExportFormat)) throw new Error(`--format is one of ${EXPORT_FORMATS.join(', ')}, not "${o.format}".`);
        const paper = o.paper.toLowerCase();
        if (paper !== 'a4' && paper !== 'letter') throw new Error(`--paper is a4 or letter, not "${o.paper}".`);
        const api = consoleApi();
        const id = await resolveBenchmarkId(api, ref);
        const baseline = o.baseline ? await resolveBenchmarkId(api, o.baseline) : undefined;
        const target = exportTargetFactory ? exportTargetFactory() : consoleCredentials();
        const file = await exportBenchmark(target, id, { format: format as ExportFormat, paper, ...(baseline ? { baseline } : {}), ...(o.output ? { output: o.output } : {}) });
        if (file.path !== '-') out(`wrote ${file.path} (${sizeText(file.bytes)})`);
      }),
    );

  bm.command('cancel <id>')
    .description('Cancel a benchmark: nothing more starts, the trials not run are skipped, the running trial is stopped')
    .action(
      coded(async (ref: string) => {
        const api = consoleApi();
        const id = await resolveBenchmarkId(api, ref);
        const b = await api.post<BenchmarkView>(`/benchmarks/${id}/cancel`, {});
        out(`${b.status}: ${b.progress.pass}/${b.progress.graded} passed, ${b.progress.skipped} skipped, $${b.spentUsd.toFixed(2)} spent`);
      }),
    );
};
