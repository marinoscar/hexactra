// `hexactra benchmarks` (E44.8, #746): the pieces of the benchmark commands over `/api/benchmarks` (docs/benchmark.md). The text
// builders are pure and the requests take their client or fetch, so each piece is tested without a console. The shapes below are
// the slice of `benchmarks.schemas.ts` and `scorecard.schemas.ts` (apps/api/src/benchmark/) the CLI prints.
import { writeFileSync } from 'node:fs';
import { resolve } from 'node:path';

import { ApiError, buildUrl, type ApiClient, type FetchLike } from '@marinoscar/platform-cli/api-client';

export const BENCHMARK_STATUSES = ['queued', 'running', 'completed', 'cancelled', 'failed'] as const;
export const EXPORT_FORMATS = ['json', 'csv', 'pdf'] as const;
export type ExportFormat = (typeof EXPORT_FORMATS)[number];

/** A benchmark that has ended. `--wait` stops on these; `failed` and `cancelled` exit non-zero. */
export const ENDED = new Set(['completed', 'cancelled', 'failed']);

export interface BenchmarkTotalsView {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  modelCalls: number;
  costUsd: number;
  costKnown: boolean;
}

export interface BenchmarkView {
  id: string;
  name: string;
  status: string;
  suiteKey: string;
  suiteVersion: number;
  config: { challengeIds: string[]; policies: { ref: string; label: string; recordVideo?: boolean }[]; trials: number; hostId: string | null; profile: string; capUsd: number | null; trialTimeoutMinutes: number; recordVideo?: boolean };
  appVersion: string;
  commit: string | null;
  spentUsd: number;
  progress: { total: number; pending: number; running: number; graded: number; skipped: number; pass: number; fail: number; error: number; unsupported: number };
  totals: BenchmarkTotalsView;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface BenchmarkTrialView {
  id: string;
  challengeId: string;
  policyLabel: string;
  trialIndex: number;
  status: string;
  verdict: string | null;
  failureReason: string | null;
  claimedSuccess: boolean | null;
  runId: string | null;
  activeMs: number | null;
  steps: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  model: string | null;
  costUsd: number | null;
  costKnown: boolean | null;
  /**
   * The trial run's recording (#846): `ready` plays on the run page (`/runs/<runId>#recording`), `recording`/`processing` not yet,
   * `failed` never. Null when not recorded or for a viewer without `runs:read`; absent from an older console.
   */
  recording?: { status: string; durationMs: number | null } | null;
}

export interface SuiteView {
  key: string;
  version: number;
  categories: { id: string; label: string }[];
  challenges: { id: string; title: string; category: string; difficulty: number; requires: string[]; supported: boolean; missing: string[]; confirmRiskyActions: boolean }[];
  defaults: { trials: number; capUsd: number; trialTimeoutMinutes: number };
  limits: { maxPolicies: number; maxTrials: number; maxCapUsd: number; maxTrialTimeoutMinutes: number };
  site: { baseUrl: string; reachable: boolean; problem: string | null };
}

export interface RateView {
  k: number;
  n: number;
  value: number | null;
  low: number | null;
  high: number | null;
}

export interface ScoreMetricsView {
  counts: { total: number; judged: number; pass: number; fail: number; error: number; skipped: number; unsupported: number; unfinished: number };
  successRate: RateView;
  passAllK: { k: number; challenges: number; allPassed: number; rate: RateView };
  falseSuccess: RateView;
  speed: { medianActiveMs: number | null; p90ActiveMs: number | null; medianSteps: number | null; medianModelCalls: number | null };
  cost: { totalUsd: number; known: boolean; medianPerTrialUsd: number | null; perSuccessUsd: number | null };
  tokens: { input: number; output: number; cached: number; total: number; medianInput: number | null; medianOutput: number | null; medianCached: number | null; perSuccess: number | null };
  failureReasons: { key: string; count: number }[];
  safety: { flaggedTrials: number; checks: { key: string; count: number }[] };
  models: string[];
}

export interface ScorecardView {
  benchmarkId: string;
  name: string;
  status: string;
  live: boolean;
  suiteKey: string;
  suiteVersion: number;
  k: number;
  totals: { costUsd: number; costKnown: boolean; inputTokens: number; outputTokens: number; cachedInputTokens: number; totalTokens: number; modelCalls: number; counts: ScoreMetricsView['counts'] };
  ranking: { rank: number; ref: string; label: string }[];
  policies: { ref: string; label: string; rank: number; metrics: ScoreMetricsView; categories: { category: string; label: string; metrics: ScoreMetricsView }[] }[];
}

export interface MetricDeltaView {
  metric: string;
  current: number | null;
  baseline: number | null;
  delta: number | null;
  better: 'higher' | 'lower';
  improved: boolean | null;
  withinNoise: boolean | null;
  atLeast: boolean;
}

export interface ComparisonView {
  current: { id: string; name: string; suiteKey: string; suiteVersion: number; appVersion: string; commit: string | null };
  baseline: { id: string; name: string; suiteKey: string; suiteVersion: number; appVersion: string; commit: string | null };
  totals: MetricDeltaView[];
  policies: { ref: string; label: string; baselineRef: string; baselineLabel: string; matchedBy: 'ref' | 'label'; deltas: MetricDeltaView[] }[];
  unmatched: { current: { ref: string; label: string }[]; baseline: { ref: string; label: string }[] };
  flipped: { challengeId: string; policyLabel: string; baseline: { outcome: string; passes: number; judged: number }; current: { outcome: string; passes: number; judged: number }; direction: 'better' | 'worse' }[];
}

// ---- Formatting ----

/** `1,234,567`. */
export const int = (n: number): string => Math.round(n).toLocaleString('en-US');

/** `$1.23`, `$0.0042`, or `≥ $1.23` when a model call had no price (the figure is a lower bound). */
export function usd(n: number | null, known = true): string {
  if (n === null) return '-';
  const s = n !== 0 && Math.abs(n) < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
  return known ? s : `≥ ${s}`;
}

/** `67% (2/3, 21-94%)`, or `-` when nothing was counted. */
export function rate(r: RateView, withInterval = true): string {
  if (r.value === null) return `- (0/${r.n})`;
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  const ci = withInterval && r.low !== null && r.high !== null ? `, ${Math.round(r.low * 100)}-${pct(r.high)}` : '';
  return `${pct(r.value)} (${r.k}/${r.n}${ci})`;
}

/** `12.3 s`, `2.1 min`, or `-`. */
export function duration(ms: number | null): string {
  if (ms === null) return '-';
  return ms < 60_000 ? `${(ms / 1000).toFixed(1)} s` : `${(ms / 60_000).toFixed(1)} min`;
}

/** Tokens as `in 1,200 / out 300 / cached 800`: cached is part of input. */
export const tokenSplit = (input: number, output: number, cached: number): string => `in ${int(input)} / out ${int(output)} / cached ${int(cached)}`;

/** The suite: its version, the site, the defaults and limits, and every challenge. */
export function suiteText(s: SuiteView): string[] {
  const label = new Map(s.categories.map((c) => [c.id, c.label]));
  const lines = [
    `Suite ${s.key}, version ${s.version}: ${s.challenges.length} challenges (${s.challenges.filter((c) => c.supported).length} the agent can attempt)`,
    `  Site       ${s.site.baseUrl} ${s.site.reachable ? '(reachable from a node)' : `(NOT reachable: ${s.site.problem ?? 'a node cannot reach it'})`}`,
    `  Defaults   ${s.defaults.trials} trials, cap ${usd(s.defaults.capUsd)}, ${s.defaults.trialTimeoutMinutes} min per trial`,
    `  Limits     ${s.limits.maxPolicies} policies, ${s.limits.maxTrials} trials, cap ${usd(s.limits.maxCapUsd)}, ${s.limits.maxTrialTimeoutMinutes} min per trial`,
    '',
  ];
  for (const c of s.challenges) {
    const flags = [c.confirmRiskyActions ? 'asks before risky steps' : null, c.supported ? null : `unsupported: needs ${c.missing.join(', ')}`].filter(Boolean).join('; ');
    lines.push(`  ${c.id.padEnd(26)} ${(label.get(c.category) ?? c.category).padEnd(22)} ${'*'.repeat(c.difficulty).padEnd(3)}  ${c.title}${flags ? `  [${flags}]` : ''}`);
  }
  return lines;
}

/** One line of the list: id prefix, status, name, suite, policies, passes and spend. */
export function benchmarkLine(b: BenchmarkView): string {
  const p = b.progress;
  return `${b.id.slice(0, 8)}  ${b.status.padEnd(9)}  ${b.name.slice(0, 32).padEnd(32)}  ${b.suiteKey} v${b.suiteVersion}  ${String(b.config.policies.length).padStart(2)} policies  ${p.pass}/${p.graded} passed, ${p.graded + p.skipped + p.unsupported}/${p.total} done  ${usd(b.spentUsd, b.totals.costKnown)}`;
}

/** The progress line `--wait` prints when it changes. */
export function progressLine(b: BenchmarkView): string {
  const p = b.progress;
  const done = p.graded + p.skipped + p.unsupported;
  return `[${b.status}] ${done}/${p.total} trials: ${p.pass} pass, ${p.fail} fail, ${p.error} error, ${p.skipped} skipped, ${p.unsupported} unsupported; ${int(b.totals.inputTokens + b.totals.outputTokens)} tokens, ${usd(b.spentUsd, b.totals.costKnown)}${b.config.capUsd === null ? ' (no cap)' : ` of ${usd(b.config.capUsd)}`}`;
}

function metricLines(m: ScoreMetricsView, indent: string): string[] {
  const c = m.cost;
  const t = m.tokens;
  return [
    `${indent}success     ${rate(m.successRate)}   pass^${m.passAllK.k} ${rate(m.passAllK.rate, false)}   false success ${rate(m.falseSuccess, false)}`,
    `${indent}tokens      ${int(t.total)} (${tokenSplit(t.input, t.output, t.cached)})   median per trial ${t.medianInput === null ? '-' : tokenSplit(t.medianInput, t.medianOutput ?? 0, t.medianCached ?? 0)}   per success ${t.perSuccess === null ? '-' : int(t.perSuccess)}`,
    `${indent}cost        ${usd(c.totalUsd, c.known)}   median per trial ${usd(c.medianPerTrialUsd, c.known)}   per success ${usd(c.perSuccessUsd, c.known)}`,
    `${indent}speed       median ${duration(m.speed.medianActiveMs)}, p90 ${duration(m.speed.p90ActiveMs)}, ${m.speed.medianSteps ?? '-'} steps`,
  ];
}

/** The policies whose trial runs record a video (#841, #845): `null` for none, "all policies", or their labels. */
export function recordedText(config: Pick<BenchmarkView['config'], 'policies' | 'recordVideo'>): string | null {
  const recorded = config.policies.filter((p) => config.recordVideo || p.recordVideo);
  if (recorded.length === 0) return null;
  return recorded.length === config.policies.length ? 'all policies' : recorded.map((p) => p.label).join(', ');
}

/**
 * `show`: the benchmark, the whole benchmark's tokens and cost (and its trial recordings when `trials` carry any, #863), then every
 * policy (ranked) with its categories.
 */
export function scorecardText(b: BenchmarkView, s: ScorecardView, trials?: readonly BenchmarkTrialView[]): string[] {
  const t = s.totals;
  const c = t.counts;
  const lines = [
    `${b.name}  (${b.id})`,
    `  Status     ${b.status}${s.live ? ' (live: the scorecard is computed now)' : ''}`,
    `  Suite      ${b.suiteKey} v${b.suiteVersion}, ${b.config.challengeIds.length} challenges x ${b.config.policies.length} policies x ${b.config.trials} trials; console ${b.appVersion}${b.commit ? ` (${b.commit.slice(0, 7)})` : ''}`,
    `  Trials     ${c.total}: ${c.pass} pass, ${c.fail} fail, ${c.error} error, ${c.skipped} skipped, ${c.unsupported} unsupported${c.unfinished ? `, ${c.unfinished} not finished` : ''}`,
    `  Tokens     ${int(t.totalTokens)} (${tokenSplit(t.inputTokens, t.outputTokens, t.cachedInputTokens)}), ${int(t.modelCalls)} model calls`,
    `  Cost       ${usd(t.costUsd, t.costKnown)}${b.config.capUsd === null ? ', no cap' : ` of a ${usd(b.config.capUsd)} cap`}${t.costKnown ? '' : ' (a model call had no price: at least this much)'}`,
  ];
  const recorded = recordedText(b.config);
  if (recorded) lines.push(`  Recorded   ${recorded} (videos on each run page)`);
  const recordings = recordingSummary(trials);
  if (recordings) lines.push(recordings);
  const byRef = new Map(s.policies.map((p) => [p.ref, p]));
  const ordered = s.ranking.map((r) => byRef.get(r.ref)).filter((p): p is ScorecardView['policies'][number] => !!p);
  for (const p of ordered.length === s.policies.length ? ordered : s.policies) {
    const m = p.metrics;
    lines.push('', `#${p.rank} ${p.label}  (${p.ref})${m.models.length ? `  models ${m.models.join(', ')}` : ''}`, ...metricLines(m, '  '));
    if (m.failureReasons.length) lines.push(`  failures    ${m.failureReasons.map((r) => `${r.key} ${r.count}`).join(', ')}`);
    if (m.safety.flaggedTrials) lines.push(`  SAFETY      ${m.safety.flaggedTrials} trial(s) failed a safety check: ${m.safety.checks.map((r) => `${r.key} ${r.count}`).join(', ')}`);
    for (const cat of p.categories) {
      const cm = cat.metrics;
      lines.push(`    ${cat.label.padEnd(22)} ${rate(cm.successRate, false).padEnd(12)} ${int(cm.tokens.total).padStart(12)} tok (${tokenSplit(cm.tokens.input, cm.tokens.output, cm.tokens.cached)})  ${usd(cm.cost.totalUsd, cm.cost.known)}, ${usd(cm.cost.perSuccessUsd, cm.cost.known)} per success`);
    }
  }
  return lines;
}

/** A recording's length: `45s`, `1m12s`, `1h02m05s`. */
export function recordingLength(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = String(s % 60).padStart(2, '0');
  if (h) return `${h}h${String(m).padStart(2, '0')}m${sec}s`;
  return m ? `${m}m${sec}s` : `${s % 60}s`;
}

/** The run page's player of a trial (#863): `<console>/runs/<id>#recording`, or the path when the console URL is not known. */
export const recordingUrl = (runId: string, webUrl?: string | null): string => `${(webUrl ?? '').replace(/\/+$/, '')}/runs/${encodeURIComponent(runId)}#recording`;

/** A trial's recording state for `show --trials`: `rec ready 1m12s`, `rec processing`, `rec recording`, `rec failed`, or nothing. */
export function recordingText(t: BenchmarkTrialView): string {
  const r = t.recording;
  if (!r) return '';
  return r.status === 'ready' ? `rec ready${r.durationMs === null ? '' : ` ${recordingLength(r.durationMs)}`}` : `rec ${r.status}`;
}

/**
 * `Recordings N ready, M processing, K failed` for the `show` summary (#863), or null when no trial carries a recording (none recorded,
 * no `runs:read`, or an older console without the field). Processing counts a run still recording too.
 */
export function recordingSummary(trials: readonly BenchmarkTrialView[] | undefined): string | null {
  const recorded = (trials ?? []).filter((t) => t.recording);
  if (!recorded.length) return null;
  const n = (pred: (status: string) => boolean) => recorded.filter((t) => pred(t.recording!.status)).length;
  return `  Recordings ${n((s) => s === 'ready')} ready, ${n((s) => s === 'processing' || s === 'recording')} processing, ${n((s) => s === 'failed')} failed`;
}

/**
 * `show --trials`: one line per trial with its verdict, tokens, cost, run and recording state; a ready recording adds a line with the
 * run page's player (`webUrl` is the CLI's console URL; without it, the path).
 */
export function trialLines(trials: BenchmarkTrialView[], opts: { webUrl?: string | null } = {}): string[] {
  return trials.flatMap((t) => {
    const verdict = t.verdict ?? t.status;
    const why = t.failureReason ? ` (${t.failureReason}${t.claimedSuccess && t.verdict === 'fail' ? ', claimed success' : ''})` : '';
    const tokens = t.inputTokens === null ? '' : `  ${tokenSplit(t.inputTokens, t.outputTokens ?? 0, t.cachedInputTokens ?? 0)}  ${usd(t.costUsd, t.costKnown !== false)}`;
    const rec = recordingText(t);
    const line = `  ${t.challengeId.padEnd(26)} ${t.policyLabel.slice(0, 20).padEnd(20)} #${t.trialIndex + 1}  ${`${verdict}${why}`.padEnd(30)} ${duration(t.activeMs).padStart(9)}${tokens}${t.runId ? `  run ${t.runId.slice(0, 8)}` : ''}${rec ? `  ${rec}` : ''}`;
    return t.recording?.status === 'ready' && t.runId ? [line, `      ${recordingUrl(t.runId, opts.webUrl)}`] : [line];
  });
}

const METRIC_LABELS: Record<string, string> = {
  successRate: 'success rate',
  passAllK: 'pass^k',
  falseSuccessRate: 'false success',
  medianActiveMs: 'median time',
  medianCostUsd: 'median cost',
  totalCostUsd: 'total cost',
  costPerSuccessUsd: 'cost per success',
  totalTokens: 'total tokens',
  inputTokens: 'input tokens',
  outputTokens: 'output tokens',
  cachedInputTokens: 'cached tokens',
  tokensPerSuccess: 'tokens per success',
};

function value(metric: string, v: number | null, atLeast: boolean): string {
  if (v === null) return '-';
  if (metric.endsWith('Usd')) return usd(v, !atLeast);
  if (metric.endsWith('Ms')) return duration(v);
  if (metric === 'successRate' || metric === 'passAllK' || metric === 'falseSuccessRate') return `${Math.round(v * 100)}%`;
  return int(v);
}

/** One delta: `success rate   67% -> 100%  (+33%, better)`. */
export function deltaLine(d: MetricDeltaView): string {
  const isRate = d.metric === 'successRate' || d.metric === 'passAllK' || d.metric === 'falseSuccessRate';
  let delta = '-';
  if (d.delta !== null) {
    const sign = d.delta > 0 ? '+' : d.delta < 0 ? '-' : '±';
    const abs = Math.abs(d.delta);
    delta = `${sign}${isRate ? `${Math.round(abs * 100)}%` : value(d.metric, abs, d.atLeast).replace(/^≥ /, '')}`;
  }
  const verdict = d.withinNoise ? 'within noise' : d.improved === true ? 'better' : d.improved === false ? 'worse' : 'same';
  return `${(METRIC_LABELS[d.metric] ?? d.metric).padEnd(20)} ${value(d.metric, d.baseline, d.atLeast).padStart(12)} -> ${value(d.metric, d.current, d.atLeast).padEnd(12)} ${delta.padStart(10)}  ${verdict}${d.atLeast ? ' (a cost is unknown: at least)' : ''}`;
}

/**
 * One side's tokens and cost, read from a list of deltas (the comparison carries the input, output and cached input split and the total cost
 * for both sides). Null when the list lacks any of them, as from a console older than the split.
 */
function sideTokens(ds: readonly MetricDeltaView[], side: 'baseline' | 'current'): string | null {
  const by = new Map(ds.map((d) => [d.metric, d]));
  const [input, output, cached, cost] = [by.get('inputTokens'), by.get('outputTokens'), by.get('cachedInputTokens'), by.get('totalCostUsd')];
  if (!input || !output || !cached || !cost || input[side] === null || output[side] === null || cached[side] === null) return null;
  return `${tokenSplit(input[side]!, output[side]!, cached[side]!)}, ${usd(cost[side], !cost.atLeast)}`;
}

/**
 * `compare`: both benchmarks, the whole benchmark's tokens and cost side by side, every matched policy's deltas with its token split
 * and cost on both sides, what did not match, and the challenges that flipped. Everything comes from the comparison itself.
 */
export function comparisonText(c: ComparisonView): string[] {
  const side = (s: ComparisonView['current']) => `${s.name} (${s.id.slice(0, 8)}, console ${s.appVersion}${s.commit ? ` ${s.commit.slice(0, 7)}` : ''})`;
  const both = (ds: readonly MetricDeltaView[]): string[] =>
    (['baseline', 'current'] as const).flatMap((k) => {
      const t = sideTokens(ds, k);
      return t ? [`  ${k.padEnd(8)}  ${t}`] : [];
    });
  const lines = [`${side(c.current)}`, `  against ${side(c.baseline)}, suite ${c.current.suiteKey} v${c.current.suiteVersion}`, '', 'Whole benchmark', ...both(c.totals), ...c.totals.map((d) => `  ${deltaLine(d)}`)];
  for (const p of c.policies) {
    lines.push('', `${p.label}${p.baselineLabel !== p.label || p.baselineRef !== p.ref ? `  (baseline: ${p.baselineLabel}, matched by ${p.matchedBy})` : ''}`);
    lines.push(...both(p.deltas));
    for (const d of p.deltas) lines.push(`  ${deltaLine(d)}`);
  }
  if (c.unmatched.current.length || c.unmatched.baseline.length) {
    lines.push('', 'Not compared');
    for (const p of c.unmatched.current) lines.push(`  only in this benchmark: ${p.label} (${p.ref})`);
    for (const p of c.unmatched.baseline) lines.push(`  only in the baseline:   ${p.label} (${p.ref})`);
  }
  if (c.flipped.length) {
    lines.push('', 'Challenges that flipped');
    for (const f of c.flipped) lines.push(`  ${f.direction === 'better' ? '+' : '-'} ${f.challengeId.padEnd(26)} ${f.policyLabel.padEnd(20)} ${f.baseline.outcome} (${f.baseline.passes}/${f.baseline.judged}) -> ${f.current.outcome} (${f.current.passes}/${f.current.judged})`);
  }
  return lines;
}

// ---- Requests ----

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The benchmark a ref names: a full id as it is, else an id prefix or the exact name among your benchmarks. */
export async function resolveBenchmarkId(api: ApiClient, ref: string): Promise<string> {
  if (UUID.test(ref)) return ref;
  const list = await api.get<{ items: BenchmarkView[] }>('/benchmarks', { query: { limit: 200 } });
  const matches = list.items.filter((b) => b.id.startsWith(ref) || b.name === ref);
  if (matches.length === 1) return matches[0]!.id;
  throw new Error(matches.length ? `"${ref}" matches several benchmarks; use the id` : `No benchmark of yours matches "${ref}" (hexactra benchmarks list shows them).`);
}

/** `--policy <ref>` or `--policy <ref>=<label>`: the label is the scorecard's column name. */
export function parsePolicyFlag(raw: string): { ref: string; label?: string } {
  const at = raw.indexOf('=');
  const ref = (at < 0 ? raw : raw.slice(0, at)).trim();
  const label = at < 0 ? '' : raw.slice(at + 1).trim();
  if (!ref) throw new Error(`--policy needs a policy: builtin:<key>, an id, or a name (got "${raw}").`);
  return label ? { ref, label } : { ref };
}

/** A positive number flag. */
/** A budget flag (#844): `none`, `0` or an empty value is no budget (`null`); otherwise an amount above 0. */
export function budget(flag: string, raw: string): number | null {
  const t = raw.trim().toLowerCase();
  if (t === '' || t === 'none') return null;
  const n = Number(t);
  if (!Number.isFinite(n) || n < 0) throw new Error(`${flag} takes an amount in USD, or 0 or "none" for no budget (got "${raw}").`);
  return n === 0 ? null : n;
}

export function positive(flag: string, raw: string, integer = false): number {
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0 || (integer && !Number.isInteger(n))) throw new Error(`${flag} takes a ${integer ? 'whole ' : ''}number above 0 (got "${raw}").`);
  return n;
}

/**
 * An API refusal printed with its code: `400 CHALLENGE_UNKNOWN: ...`. It stays an `ApiError`, so the CLI exits with its API exit
 * code (3; 4 for no network, 5 for a 401). Anything else is returned as it is.
 */
export function withCode(e: unknown): unknown {
  if (!(e instanceof ApiError) || !e.code) return e;
  if (e.message.includes(e.code)) return e;
  const next = new ApiError({ status: e.status, serverMessage: e.serverMessage, code: e.code, details: e.details, method: e.method, url: e.url, structured: e.structured, rawBody: e.rawBody });
  next.message = `${e.status} ${e.code}: ${e.serverMessage}`;
  return next;
}

/** Poll a benchmark until it ends, calling `onChange` with each new progress line. */
export async function waitForBenchmark(api: ApiClient, id: string, opts: { intervalMs: number; onChange: (line: string) => void }): Promise<BenchmarkView> {
  let last = '';
  for (;;) {
    const b = await api.get<BenchmarkView>(`/benchmarks/${encodeURIComponent(id)}`);
    const line = progressLine(b);
    if (line !== last) {
      opts.onChange(line);
      last = line;
    }
    if (ENDED.has(b.status)) return b;
    await new Promise((res) => setTimeout(res, opts.intervalMs));
  }
}

/** Where and as whom an export is fetched: the API root, the token and (in tests) a fake fetch. */
export interface ExportTarget {
  apiBaseUrl: string;
  token: string;
  fetch?: FetchLike;
}

const ACCEPT: Record<ExportFormat, string> = { json: 'application/json', csv: 'text/csv', pdf: 'application/pdf' };

/** The console's file name from `content-disposition`, else `hexactra-benchmark-<8>.<ext>`. Never a path. */
export function exportFilename(id: string, disposition: string | null, format: ExportFormat): string {
  const m = disposition ? /filename\*?=(?:UTF-8'')?"?([^";]+)"?/i.exec(disposition) : null;
  const name = m ? decodeURIComponent(m[1]!).replace(/[/\\]/g, '_').trim() : '';
  return name && !name.startsWith('.') ? name : `hexactra-benchmark-${id.slice(0, 8)}.${format}`;
}

/**
 * `hexactra benchmarks export` (#744's route): `GET /benchmarks/{id}/export?format=json|csv|pdf`, an attachment with no `{data}`
 * envelope, so this is a plain `fetch` with the same bearer token, like `runs export --pdf`. Written to `output` (default: the
 * console's file name in `dir`); `-` writes it to stdout. On an error no file is written and the error carries the API's code.
 */
export async function exportBenchmark(
  target: ExportTarget,
  id: string,
  opts: { format: ExportFormat; paper?: 'a4' | 'letter'; baseline?: string; output?: string; dir?: string; stdout?: (b: Buffer) => void },
): Promise<{ path: string; bytes: number }> {
  const query: Record<string, string> = { format: opts.format };
  if (opts.format === 'pdf') query.paper = opts.paper ?? 'a4';
  if (opts.baseline) query.baseline = opts.baseline;
  const url = buildUrl(target.apiBaseUrl, `/benchmarks/${encodeURIComponent(id)}/export`, query);
  const fetchImpl = target.fetch ?? globalThis.fetch;
  const res = await fetchImpl(url, { headers: { authorization: `Bearer ${target.token}`, accept: `${ACCEPT[opts.format]}, application/json` }, signal: AbortSignal.timeout(180_000) });
  if (!res.ok) {
    const raw = await res.text();
    throw withCode(ApiError.fromBody({ status: res.status, statusText: res.statusText, rawBody: raw, method: 'GET', url }));
  }
  const bytes = Buffer.from(await res.arrayBuffer());
  if (opts.format === 'pdf' && bytes.subarray(0, 5).toString('latin1') !== '%PDF-') throw new Error(`The console did not send a PDF for benchmark ${id}: is the server URL right?`);
  if (opts.output === '-') {
    (opts.stdout ?? ((b: Buffer) => process.stdout.write(b)))(bytes);
    return { path: '-', bytes: bytes.length };
  }
  const path = resolve(opts.dir ?? process.cwd(), opts.output ?? exportFilename(id, res.headers.get('content-disposition'), opts.format));
  writeFileSync(path, bytes);
  return { path, bytes: bytes.length };
}
