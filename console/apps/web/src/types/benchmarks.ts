// The benchmark shapes the admin pages read (E44.5, #743), as the API returns them:
// `apps/api/src/benchmark/benchmarks.schemas.ts` (#741) and `scorecard.schemas.ts` (#742).
// Every number a page shows is computed by the API; the pages do no arithmetic of their own
// beyond formatting.

export const BENCHMARK_STATUSES = ['queued', 'running', 'completed', 'cancelled', 'failed'] as const;
export type BenchmarkStatus = (typeof BENCHMARK_STATUSES)[number];

export const TRIAL_VERDICTS = ['pass', 'fail', 'error', 'skipped', 'unsupported'] as const;
export type TrialVerdict = (typeof TRIAL_VERDICTS)[number];

export type TrialStatus = 'pending' | 'running' | 'graded' | 'skipped';

export type Category = 'navigation' | 'forms' | 'extraction' | 'pointer' | 'dynamic' | 'long' | 'safety';
export type Capability = 'pointer' | 'real_keys' | 'file_upload' | 'file_download';

export interface BenchmarkConfig {
  challengeIds: string[];
  policies: { ref: string; label: string }[];
  trials: number;
  hostId: string | null;
  profile: string;
  /** The spend cap in USD; null: no cap (#840). */
  capUsd: number | null;
  /** Every trial's run records a video (#841). */
  recordVideo: boolean;
  trialTimeoutMinutes: number;
}

export interface BenchmarkProgress {
  total: number;
  pending: number;
  running: number;
  graded: number;
  skipped: number;
  pass: number;
  fail: number;
  error: number;
  unsupported: number;
}

export interface BenchmarkTotals {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  modelCalls: number;
  costUsd: number;
  costKnown: boolean;
}

/** `GET /api/benchmarks/{id}`. */
export interface Benchmark {
  id: string;
  name: string;
  status: BenchmarkStatus;
  suiteKey: string;
  suiteVersion: number;
  config: BenchmarkConfig;
  appVersion: string;
  commit: string | null;
  spentUsd: number;
  progress: BenchmarkProgress;
  totals: BenchmarkTotals;
  baselineId: string | null;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

export interface BenchmarkList {
  items: Benchmark[];
  total: number;
}

export interface TrialCheck {
  name: string;
  pass: boolean;
  detail?: string;
}

/** One row of `GET /api/benchmarks/{id}/trials`. */
export interface BenchmarkTrial {
  id: string;
  challengeId: string;
  challengeTitle: string;
  category: Category | null;
  policyRef: string;
  policyLabel: string;
  trialIndex: number;
  status: TrialStatus;
  verdict: TrialVerdict | null;
  failureReason: string | null;
  checks: TrialCheck[] | null;
  claimedSuccess: boolean | null;
  runId: string | null;
  durationMs: number | null;
  activeMs: number | null;
  steps: number | null;
  modelCalls: number | null;
  inputTokens: number | null;
  outputTokens: number | null;
  cachedInputTokens: number | null;
  model: string | null;
  models: { startTier: string; maxTier: string; finalTier: string; model: string | null; tiers: { tier: string; model: string | null; fallbackModel: string | null }[] } | null;
  costUsd: number | null;
  costKnown: boolean | null;
  stopReason: string | null;
  questions: number | null;
  escalations: number | null;
  startedAt: string | null;
  finishedAt: string | null;
  /** The trial run's video (#846): its status only; null when not recorded, the run is gone, or the viewer lacks `runs:read`. */
  recording: { status: 'recording' | 'processing' | 'ready' | 'failed'; durationMs: number | null } | null;
}

export interface SuiteChallenge {
  id: string;
  title: string;
  category: Category;
  difficulty: number;
  requires: Capability[];
  supported: boolean;
  missing: Capability[];
  confirmRiskyActions: boolean;
}

/** `GET /api/benchmarks/suite`. */
export interface BenchmarkSuite {
  key: string;
  version: number;
  categories: { id: Category; label: string }[];
  challenges: SuiteChallenge[];
  defaults: { trials: number; capUsd: number; trialTimeoutMinutes: number };
  limits: { maxPolicies: number; maxTrials: number; maxCapUsd: number; maxTrialTimeoutMinutes: number };
  site: { baseUrl: string; reachable: boolean; problem: string | null };
}

/** `POST /api/benchmarks`. */
export interface CreateBenchmarkInput {
  name?: string;
  challengeIds?: string[];
  policies: { ref: string; label?: string }[];
  trials?: number;
  hostId?: string | null;
  profile?: string;
  /** Absent: the deployment default; null: no cap (#840). */
  capUsd?: number | null;
  /** Record a video of each trial run (#841). */
  recordVideo?: boolean;
  trialTimeoutMinutes?: number;
}

// ---- Scorecard (#742) ----

export interface Rate {
  k: number;
  n: number;
  value: number | null;
  low: number | null;
  high: number | null;
}

export interface ScoreCounts {
  total: number;
  judged: number;
  pass: number;
  fail: number;
  error: number;
  skipped: number;
  unsupported: number;
  unfinished: number;
}

export interface Counted {
  key: string;
  count: number;
}

export interface ScoreMetrics {
  counts: ScoreCounts;
  successRate: Rate;
  passAllK: { k: number; challenges: number; allPassed: number; rate: Rate };
  falseSuccess: Rate;
  falseFailure: Rate;
  speed: { medianActiveMs: number | null; p90ActiveMs: number | null; medianSteps: number | null; medianModelCalls: number | null };
  cost: { totalUsd: number; known: boolean; medianPerTrialUsd: number | null; perSuccessUsd: number | null };
  tokens: { input: number; output: number; cached: number; total: number; medianInput: number | null; medianOutput: number | null; medianCached: number | null; perSuccess: number | null };
  failureReasons: Counted[];
  stopReasons: Counted[];
  safety: { flaggedTrials: number; checks: Counted[] };
  models: string[];
}

export interface PolicyScore {
  ref: string;
  label: string;
  rank: number;
  metrics: ScoreMetrics;
  categories: { category: Category; label: string; metrics: ScoreMetrics }[];
}

export interface MatrixCell {
  policyRef: string;
  passes: number;
  judged: number;
  k: number;
  verdicts: (string | null)[];
  medianActiveMs: number | null;
  medianCostUsd: number | null;
  costKnown: boolean;
  totalTokens: number;
  safetyFlagged: boolean;
}

export interface MatrixRow {
  challengeId: string;
  title: string;
  category: Category | null;
  cells: MatrixCell[];
}

export interface ScorecardTotals {
  costUsd: number;
  costKnown: boolean;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  totalTokens: number;
  modelCalls: number;
  counts: ScoreCounts;
}

export interface RankingEntry {
  rank: number;
  ref: string;
  label: string;
  successRate: number | null;
  costPerSuccessUsd: number | null;
  costKnown: boolean;
  medianActiveMs: number | null;
  totalCostUsd: number;
  totalTokens: number;
}

/** `GET /api/benchmarks/{id}/scorecard`. */
export interface Scorecard {
  format: 'hexactra.benchmark-scorecard';
  version: number;
  benchmarkId: string;
  name: string;
  status: BenchmarkStatus;
  live: boolean;
  suiteKey: string;
  suiteVersion: number;
  appVersion: string;
  commit: string | null;
  k: number;
  computedAt: string;
  totals: ScorecardTotals;
  ranking: RankingEntry[];
  policies: PolicyScore[];
  categories: { id: Category; label: string }[];
  matrix: MatrixRow[];
}

// ---- Compare (#742) ----

export const COMPARED_METRICS = ['successRate', 'passAllK', 'falseSuccessRate', 'medianActiveMs', 'medianCostUsd', 'totalCostUsd', 'costPerSuccessUsd', 'totalTokens', 'inputTokens', 'outputTokens', 'cachedInputTokens', 'tokensPerSuccess'] as const;
export type ComparedMetric = (typeof COMPARED_METRICS)[number];

export interface MetricDelta {
  metric: ComparedMetric;
  current: number | null;
  baseline: number | null;
  delta: number | null;
  better: 'higher' | 'lower';
  improved: boolean | null;
  withinNoise: boolean | null;
  atLeast: boolean;
}

export interface ComparisonSide {
  id: string;
  name: string;
  status: BenchmarkStatus;
  suiteKey: string;
  suiteVersion: number;
  appVersion: string;
  commit: string | null;
  finishedAt: string | null;
}

export type Outcome = 'pass' | 'fail' | 'mixed';

export interface FlippedChallenge {
  challengeId: string;
  title: string;
  category: Category | null;
  policyRef: string;
  policyLabel: string;
  baseline: { outcome: Outcome; passes: number; judged: number };
  current: { outcome: Outcome; passes: number; judged: number };
  direction: 'better' | 'worse';
}

/** `GET /api/benchmarks/{id}/compare?baseline=`. */
export interface BenchmarkComparison {
  current: ComparisonSide;
  baseline: ComparisonSide;
  totals: MetricDelta[];
  policies: { ref: string; label: string; baselineRef: string; baselineLabel: string; matchedBy: 'ref' | 'label'; deltas: MetricDelta[] }[];
  unmatched: { current: { ref: string; label: string }[]; baseline: { ref: string; label: string }[] };
  flipped: FlippedChallenge[];
}
