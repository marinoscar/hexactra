// A benchmark report's inputs for the export tests (#744). Generated data only: two policies, two challenges, three trials each, a run
// goal holding a trial site token, results and check notes seeded with a console token, a card-like number and an email.
import type { BenchmarkTrialView, BenchmarkView } from '../../src/benchmark/benchmarks.schemas';
import type { ReportInput, TrialRunText } from '../../src/benchmark/benchmark-report';
import { compareScorecards, computeScorecard, type ScoreBenchmark } from '../../src/benchmark/scorecard';

export const SEEDED = {
  token: `pat_${'a1B2'.repeat(10)}`,
  card: '4111 1111 1111 1111',
  email: 'person.a@example.test',
  siteToken: 'Zk3vQ9xT2mLp8sWc4nRb7yHd1fGj6aKe0uIo5tEq_-w',
} as const;

export const POLICY_A = { ref: 'builtin:economy', label: 'Economy' };
// A label a spreadsheet would read as a formula.
export const POLICY_B = { ref: 'builtin:balanced', label: '=HYPERLINK("x")' };

const BENCH_ID = '00000000-0000-4000-8000-00000000e744';
const runId = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;

function trialsOf(): BenchmarkTrialView[] {
  const out: BenchmarkTrialView[] = [];
  let n = 0;
  for (let trialIndex = 0; trialIndex < 3; trialIndex++) {
    for (const challengeId of ['nav-lookup', 'form-multistep'] as const) {
      for (const p of [POLICY_A, POLICY_B]) {
        n++;
        const fail = p === POLICY_B && challengeId === 'form-multistep' && trialIndex === 0;
        const model = p === POLICY_A ? 'fixture:small' : 'fixture:large';
        out.push({
          id: `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`,
          challengeId,
          challengeTitle: challengeId === 'nav-lookup' ? 'Look up a record' : 'Multi-step form',
          category: challengeId === 'nav-lookup' ? 'navigation' : 'forms',
          policyRef: p.ref,
          policyLabel: p.label,
          trialIndex,
          status: 'graded',
          verdict: fail ? 'fail' : 'pass',
          failureReason: fail ? 'wrong_result' : null,
          checks: fail ? [{ name: 'safety:no-order-placed', pass: false, detail: `Order placed for ${SEEDED.email}` }, { name: 'total', pass: false, detail: '-42 off' }] : [{ name: 'graded', pass: true }],
          claimedSuccess: true,
          runId: runId(n),
          durationMs: 25_000 + n * 1000,
          activeMs: 20_000 + n * 1000,
          steps: 5 + n,
          modelCalls: 3 + n,
          inputTokens: 10_000 + n * 100,
          outputTokens: 500 + n * 10,
          cachedInputTokens: 4_000 + n * 10,
          model,
          models: { startTier: 'standard', maxTier: 'standard', finalTier: 'standard', model, tiers: [{ tier: 'standard', model, fallbackModel: null }] },
          costUsd: Math.round((0.01 + n * 0.001) * 1e6) / 1e6,
          costKnown: true,
          stopReason: 'finished',
          questions: 0,
          escalations: 0,
          startedAt: new Date(Date.UTC(2026, 10, 1, 10, 0, n)).toISOString(),
          finishedAt: new Date(Date.UTC(2026, 10, 1, 10, 1, n)).toISOString(),
          // The first trial run was recorded (#846), the second is still being prepared; the rest were not recorded.
          recording: n === 1 ? { status: 'ready', durationMs: 61_000 } : n === 2 ? { status: 'processing', durationMs: null } : null,
        });
      }
    }
  }
  return out;
}

export function reportInput(opts: { status?: BenchmarkView['status']; baseline?: boolean } = {}): ReportInput {
  const status = opts.status ?? 'completed';
  const trials = trialsOf();
  const spent = Math.round(trials.reduce((s, t) => s + (t.costUsd ?? 0), 0) * 1e6) / 1e6;
  const totals = {
    inputTokens: trials.reduce((s, t) => s + (t.inputTokens ?? 0), 0),
    outputTokens: trials.reduce((s, t) => s + (t.outputTokens ?? 0), 0),
    cachedInputTokens: trials.reduce((s, t) => s + (t.cachedInputTokens ?? 0), 0),
    modelCalls: trials.reduce((s, t) => s + (t.modelCalls ?? 0), 0),
    costUsd: spent,
    costKnown: true,
  };
  const live = status === 'running' || status === 'queued';
  const benchmark: BenchmarkView = {
    id: BENCH_ID,
    name: `Nightly comparison for ${SEEDED.email}`,
    status,
    suiteKey: 'core',
    suiteVersion: 1,
    config: { challengeIds: ['nav-lookup', 'form-multistep'], policies: [{ ...POLICY_A, recordVideo: false }, { ...POLICY_B, recordVideo: false }], trials: 3, hostId: null, profile: 'default', capUsd: 5, trialTimeoutMinutes: 15, recordVideo: false },
    appVersion: '1.2.3',
    commit: '0123456789abcdef0123456789abcdef01234567',
    spentUsd: spent,
    progress: { total: 12, pending: 0, running: 0, graded: 12, skipped: 0, pass: 11, fail: 1, error: 0, unsupported: 0 },
    totals,
    baselineId: null,
    createdAt: '2026-11-01T09:59:00.000Z',
    startedAt: '2026-11-01T10:00:00.000Z',
    finishedAt: live ? null : '2026-11-01T10:30:00.000Z',
  };
  const score: ScoreBenchmark = { id: BENCH_ID, name: benchmark.name, status, suiteKey: 'core', suiteVersion: 1, appVersion: '1.2.3', commit: benchmark.commit, spentUsd: spent, config: { challengeIds: benchmark.config.challengeIds, policies: benchmark.config.policies, trials: 3 } };
  const now = new Date('2026-11-02T08:00:00Z');
  const scorecard = computeScorecard(score, trials, { live, now });
  const runs = new Map<string, TrialRunText>(
    trials.map((t, i) => [
      t.runId!,
      {
        goal: `Open https://console.example.test/benchmark/t/${SEEDED.siteToken}/nav and find the record of ${SEEDED.email}.`,
        result: i === 0 ? `Done. Paid with ${SEEDED.card}; token ${SEEDED.token}; mailed ${SEEDED.email}.` : '+Found it',
      },
    ]),
  );
  let baseline = null;
  if (opts.baseline) {
    const baseTrials = trials.map((t) => (t.policyRef === POLICY_A.ref && t.challengeId === 'form-multistep' ? { ...t, verdict: 'fail' as const, failureReason: 'wrong_result' as const } : t));
    const base = computeScorecard({ ...score, id: '00000000-0000-4000-8000-0000000ba5e1', name: 'Last week', appVersion: '1.2.0', commit: null }, baseTrials, { live: false, now });
    const side = (b: { id: string; name: string; appVersion: string; commit: string | null }) => ({ id: b.id, name: b.name, status: 'completed' as const, suiteKey: 'core', suiteVersion: 1, appVersion: b.appVersion, commit: b.commit, finishedAt: '2026-10-25T10:00:00.000Z' });
    baseline = compareScorecards(scorecard, base, { current: side(score), baseline: side({ id: base.benchmarkId, name: 'Last week', appVersion: '1.2.0', commit: null }) });
  }
  return { benchmark, scorecard, trials, runs, baseline, consoleVersion: '1.2.3', exportedAt: now };
}
