// Words and number formats of the benchmark pages (E44.5, #743), and the new form's validation.
// Pure: the pages and their tests share them.
import { formatCost } from '../ui';
import { formatTokens } from '../usage/api';
import type { Benchmark, BenchmarkStatus, BenchmarkSuite, ComparedMetric, MetricDelta, Rate, ScoreMetrics, TrialVerdict } from '../types/benchmarks';

export { formatTokens };

/** Where the pages live (the admin path convention: `/admin/settings/<page>`). */
export const BENCHMARKS_PATH = '/admin/settings/benchmarks';
export const benchmarkPath = (id: string) => `${BENCHMARKS_PATH}/${id}`;
export const comparePath = (id: string, baseline: string) => `${BENCHMARKS_PATH}/${id}/compare/${baseline}`;

export const STATUS_LABEL: Record<BenchmarkStatus, string> = { queued: 'queued', running: 'running', completed: 'completed', cancelled: 'cancelled', failed: 'failed' };
export const VERDICT_LABEL: Record<TrialVerdict, string> = { pass: 'pass', fail: 'fail', error: 'error', skipped: 'skipped', unsupported: 'unsupported' };

/** Why a trial did not pass, in words (`TRIAL_FAILURE_REASONS`). An unknown one reads as its raw text. */
export const FAILURE_REASON_LABEL: Record<string, string> = {
  wrong_result: 'wrong result',
  gave_up: 'gave up',
  budget: 'ran out of budget',
  stalled: 'stalled',
  asked_person: 'asked a person',
  timeout: 'timed out',
  error: 'error',
  no_model: 'no model',
  cancelled: 'cancelled',
  cap: 'spend cap reached',
  unsupported: 'needs a capability the agent lacks',
};
export const failureReasonLabel = (r: string) => FAILURE_REASON_LABEL[r] ?? r;

export const CAPABILITY_LABEL: Record<string, string> = { pointer: 'pointer input', real_keys: 'real key presses', file_upload: 'file upload', file_download: 'file download' };

export const isLiveBenchmark = (status: BenchmarkStatus | string) => status === 'queued' || status === 'running';

/** "64%"; "n/a" when nothing was counted. */
export function pct(value: number | null | undefined): string {
  if (value === null || value === undefined || !Number.isFinite(value)) return 'n/a';
  return `${Math.round(value * 100)}%`;
}

/** "64% (45–80%)": a rate with its 95% interval. */
export function rateText(r: Rate): string {
  if (r.value === null) return 'n/a';
  return r.low === null || r.high === null ? pct(r.value) : `${pct(r.value)} (${pct(r.low)}–${pct(r.high)})`;
}

/** "7 of 11". */
export const ofText = (k: number, n: number) => `${k.toLocaleString('en-US')} of ${n.toLocaleString('en-US')}`;

/** "1m 05s", "42s", "1h 02m"; "n/a" for none. */
export function duration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined || !Number.isFinite(ms)) return 'n/a';
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${String(s % 60).padStart(2, '0')}s`;
  return `${Math.floor(m / 60)}h ${String(m % 60).padStart(2, '0')}m`;
}

/** A cost, "at least" when unknown; "n/a" when there is none. */
export const money = (usd: number | null | undefined, known = true) => formatCost(usd, known) ?? 'n/a';

/** A token count, compact; "n/a" for none. */
export const tokens = (n: number | null | undefined, compact = true) => (n === null || n === undefined ? 'n/a' : formatTokens(n, compact));

/** A median that may be fractional (an even count): one decimal at most. */
export const num = (n: number | null | undefined) => (n === null || n === undefined ? 'n/a' : n.toLocaleString('en-US', { maximumFractionDigits: 1 }));

/** "openai:gpt-x" → "gpt-x" with the provider kept for the title. */
export const modelName = (m: string) => m.split(':').slice(1).join(':') || m;

/** How many trials a benchmark of this shape starts: challenges that can run x policies x trials. */
export function plannedRuns(supportedChallenges: number, policies: number, trials: number): number {
  return Math.max(0, supportedChallenges) * Math.max(0, policies) * Math.max(0, trials);
}

/** What the new form holds before it is sent. Numbers stay text while typed. */
export interface NewBenchmarkForm {
  name: string;
  challengeIds: string[];
  policies: { ref: string; label: string }[];
  trials: string;
  hostId: string | null;
  profile: string;
  capUsd: string;
}

export type NewFormField = 'name' | 'challenges' | 'policies' | 'trials' | 'profile' | 'capUsd';

const PROFILE_NAME = /^[a-z0-9][a-z0-9_-]{0,31}$/;

/** The form's problems, by field; empty when it can be sent. The same limits the API enforces. */
export function newFormProblems(form: NewBenchmarkForm, suite: Pick<BenchmarkSuite, 'limits' | 'challenges'>): Partial<Record<NewFormField, string>> {
  const out: Partial<Record<NewFormField, string>> = {};
  if (form.name.trim().length > 200) out.name = 'At most 200 characters.';
  const runnable = form.challengeIds.filter((id) => suite.challenges.some((c) => c.id === id && c.supported));
  if (runnable.length === 0) out.challenges = 'Choose at least one challenge the agent can attempt.';
  if (form.policies.length === 0) out.policies = 'Choose at least one agent policy.';
  else if (form.policies.length > suite.limits.maxPolicies) out.policies = `At most ${suite.limits.maxPolicies} policies.`;
  else {
    const labels = form.policies.map((p) => p.label.trim().toLowerCase());
    if (labels.some((l) => !l)) out.policies = 'Every policy needs a label.';
    else if (new Set(labels).size !== labels.length) out.policies = 'Each policy needs its own label.';
  }
  const trials = Number(form.trials);
  if (!/^\d+$/.test(form.trials.trim()) || trials < 1 || trials > suite.limits.maxTrials) out.trials = `A whole number from 1 to ${suite.limits.maxTrials}.`;
  if (!PROFILE_NAME.test(form.profile)) out.profile = 'Use 1-32 lowercase letters, digits, - and _.';
  const cap = Number(form.capUsd);
  if (!form.capUsd.trim() || !Number.isFinite(cap) || cap <= 0 || cap > suite.limits.maxCapUsd) out.capUsd = `More than $0 and at most $${suite.limits.maxCapUsd.toLocaleString('en-US')}.`;
  return out;
}

/** The best policy's success, for the list: the highest success rate among the scorecard-free progress is not known, so the list shows passes over judged. */
export function overallSuccess(b: Pick<Benchmark, 'progress'>): string {
  const judged = b.progress.pass + b.progress.fail;
  return judged === 0 ? 'n/a' : `${pct(b.progress.pass / judged)} (${ofText(b.progress.pass, judged)})`;
}

// ---- Compare ----

export const METRIC_LABEL: Record<ComparedMetric, string> = {
  successRate: 'Success rate',
  passAllK: 'Reliability (pass^k)',
  falseSuccessRate: 'False success',
  medianActiveMs: 'Median active time',
  medianCostUsd: 'Median cost per trial',
  totalCostUsd: 'Total cost',
  costPerSuccessUsd: 'Cost per success',
  totalTokens: 'Total tokens',
  inputTokens: 'Input tokens',
  outputTokens: 'Output tokens',
  cachedInputTokens: 'Cached input tokens',
  tokensPerSuccess: 'Tokens per success',
};

const RATE_METRICS: ComparedMetric[] = ['successRate', 'passAllK', 'falseSuccessRate'];
const COST_METRICS: ComparedMetric[] = ['medianCostUsd', 'totalCostUsd', 'costPerSuccessUsd'];

/** One side of a delta in its unit. */
export function metricValue(metric: ComparedMetric, v: number | null, atLeast = false): string {
  if (v === null) return 'n/a';
  if (RATE_METRICS.includes(metric)) return pct(v);
  if (COST_METRICS.includes(metric)) return money(v, !atLeast);
  if (metric === 'medianActiveMs') return duration(v);
  return tokens(v);
}

/** The signed change in its unit: "+12 pts", "−$0.40", "+1.2k". */
export function deltaText(d: MetricDelta): string {
  if (d.delta === null) return 'n/a';
  if (d.delta === 0) return 'no change';
  const sign = d.delta > 0 ? '+' : '−';
  const abs = Math.abs(d.delta);
  if (RATE_METRICS.includes(d.metric)) return `${sign}${Math.round(abs * 100)} pts`;
  if (COST_METRICS.includes(d.metric)) return `${sign}$${abs.toFixed(abs < 0.01 ? 4 : 2)}${d.atLeast ? ', a cost is unknown' : ''}`;
  if (d.metric === 'medianActiveMs') return `${sign}${duration(abs)}`;
  return `${sign}${tokens(abs)}`;
}

/** How a delta reads: within noise (never a win or a loss), better, worse, or unchanged. */
export type DeltaVerdict = 'noise' | 'better' | 'worse' | 'same' | 'none';
export function deltaVerdict(d: MetricDelta): DeltaVerdict {
  if (d.delta === null) return 'none';
  if (d.withinNoise) return 'noise';
  if (d.delta === 0 || d.improved === null) return 'same';
  return d.improved ? 'better' : 'worse';
}
export const DELTA_VERDICT_LABEL: Record<DeltaVerdict, string> = { noise: 'within noise', better: 'better', worse: 'worse', same: 'no change', none: 'n/a' };

/** The headline cost of a group of trials: "$1.20" or "≥ $1.20". */
export const costOf = (m: ScoreMetrics) => money(m.cost.totalUsd, m.cost.known);
