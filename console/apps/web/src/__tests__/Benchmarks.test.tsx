// The benchmark admin pages (E44.5, #743): the list, the new form's validation and start, the
// detail page's totals, scorecard, charts' tables and trials, and the comparison, at phone width
// where the layout changes.
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestApiError, createTestBlobResponse, createTestPlatformHost } from '@marinoscar/platform-web/testing';
import type { ReactElement } from 'react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { budgetOf, deltaText, deltaVerdict, newFormProblems, plannedRuns, rateText, type NewBenchmarkForm } from '../benchmarks/format';
import { BenchmarkComparePage } from '../pages/BenchmarkComparePage';
import { BenchmarkNewPage } from '../pages/BenchmarkNewPage';
import { BenchmarkPage } from '../pages/BenchmarkPage';
import { BenchmarksPage } from '../pages/BenchmarksPage';
import type { Benchmark, BenchmarkComparison, BenchmarkSuite, BenchmarkTrial, MetricDelta, Scorecard, ScoreMetrics } from '../types/benchmarks';
import { ConfirmProvider } from '../ui';
import { mockViewport } from './matchMedia';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

const ID = 'b0000000-0000-4000-8000-000000000001';
const BASE = 'b0000000-0000-4000-8000-000000000003';
const RUN = '33333333-3333-4333-8333-333333333333';

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

const suite: BenchmarkSuite = {
  key: 'builtin',
  version: 2,
  categories: [
    { id: 'navigation', label: 'Navigation' },
    { id: 'forms', label: 'Forms' },
  ],
  challenges: [
    { id: 'nav-lookup', title: 'Look up an order', category: 'navigation', difficulty: 1, requires: [], supported: true, missing: [], confirmRiskyActions: false },
    { id: 'form-multistep', title: 'Complete a registration', category: 'forms', difficulty: 2, requires: [], supported: true, missing: [], confirmRiskyActions: false },
    { id: 'form-upload', title: 'Attach a document', category: 'forms', difficulty: 2, requires: ['file_upload'], supported: false, missing: ['file_upload'], confirmRiskyActions: false },
  ],
  defaults: { trials: 3, capUsd: 25, trialTimeoutMinutes: 15 },
  limits: { maxPolicies: 8, maxTrials: 10, maxCapUsd: 1000, maxTrialTimeoutMinutes: 120 },
  site: { baseUrl: 'https://console.example.test/benchmark/', reachable: true, problem: null },
};

function benchmark(over: Partial<Benchmark> = {}): Benchmark {
  return {
    id: ID,
    name: 'After the planner change',
    status: 'completed',
    suiteKey: 'builtin',
    suiteVersion: 2,
    config: { challengeIds: ['nav-lookup', 'form-multistep'], policies: [{ ref: 'builtin:economy', label: 'Economy' }, { ref: 'builtin:thorough', label: 'Thorough' }], trials: 3, hostId: null, profile: 'default', capUsd: 25, trialTimeoutMinutes: 15, recordVideo: false },
    appVersion: '1.118.0',
    commit: '4f2c9a1e7b3d',
    spentUsd: 1.25,
    progress: { total: 12, pending: 0, running: 0, graded: 12, skipped: 0, pass: 9, fail: 3, error: 0, unsupported: 0 },
    totals: { inputTokens: 1_200_000, outputTokens: 90_000, cachedInputTokens: 400_000, modelCalls: 120, costUsd: 1.25, costKnown: true },
    baselineId: null,
    createdAt: '2026-11-21T10:00:00Z',
    startedAt: '2026-11-21T10:00:05Z',
    finishedAt: '2026-11-21T11:00:00Z',
    ...over,
  };
}

const rate = (k: number, n: number) => ({ k, n, value: n ? k / n : null, low: n ? Math.max(0, k / n - 0.2) : null, high: n ? Math.min(1, k / n + 0.1) : null });
function metrics(pass: number, judged: number, costUsd: number, known = true): ScoreMetrics {
  return {
    counts: { total: judged, judged, pass, fail: judged - pass, error: 0, skipped: 0, unsupported: 0, unfinished: 0 },
    successRate: rate(pass, judged),
    passAllK: { k: 3, challenges: 2, allPassed: pass === judged ? 2 : 1, rate: rate(pass === judged ? 2 : 1, 2) },
    falseSuccess: rate(judged - pass > 0 ? 1 : 0, judged),
    falseFailure: rate(0, judged),
    speed: { medianActiveMs: 65_000, p90ActiveMs: 120_000, medianSteps: 12, medianModelCalls: 8 },
    cost: { totalUsd: costUsd, known, medianPerTrialUsd: costUsd / judged, perSuccessUsd: pass ? costUsd / pass : null },
    tokens: { input: 500_000, output: 40_000, cached: 150_000, total: 540_000, medianInput: 80_000, medianOutput: 6_000, medianCached: 25_000, perSuccess: pass ? Math.round(540_000 / pass) : null },
    failureReasons: judged > pass ? [{ key: 'wrong_result', count: judged - pass }] : [],
    stopReasons: [{ key: 'finished', count: judged }],
    safety: judged > pass ? { flaggedTrials: 1, checks: [{ key: 'safety:no-injected-order', count: 1 }] } : { flaggedTrials: 0, checks: [] },
    models: ['provider-a:model-small'],
  };
}

function scorecard(): Scorecard {
  const eco = metrics(3, 6, 0.25);
  const tho = metrics(6, 6, 1, false);
  return {
    format: 'hexactra.benchmark-scorecard',
    version: 1,
    benchmarkId: ID,
    name: 'After the planner change',
    status: 'completed',
    live: false,
    suiteKey: 'builtin',
    suiteVersion: 2,
    appVersion: '1.118.0',
    commit: '4f2c9a1e7b3d',
    k: 3,
    computedAt: '2026-11-21T11:00:00Z',
    totals: { costUsd: 1.25, costKnown: false, inputTokens: 1_200_000, outputTokens: 90_000, cachedInputTokens: 400_000, totalTokens: 1_290_000, modelCalls: 120, counts: { total: 12, judged: 12, pass: 9, fail: 3, error: 0, skipped: 0, unsupported: 0, unfinished: 0 } },
    ranking: [
      { rank: 1, ref: 'builtin:thorough', label: 'Thorough', successRate: 1, costPerSuccessUsd: 1 / 6, costKnown: false, medianActiveMs: 65_000, totalCostUsd: 1, totalTokens: 540_000 },
      { rank: 2, ref: 'builtin:economy', label: 'Economy', successRate: 0.5, costPerSuccessUsd: 0.25 / 3, costKnown: true, medianActiveMs: 65_000, totalCostUsd: 0.25, totalTokens: 540_000 },
    ],
    policies: [
      { ref: 'builtin:economy', label: 'Economy', rank: 2, metrics: eco, categories: [{ category: 'navigation', label: 'Navigation', metrics: metrics(3, 3, 0.1) }, { category: 'forms', label: 'Forms', metrics: metrics(0, 3, 0.15) }] },
      { ref: 'builtin:thorough', label: 'Thorough', rank: 1, metrics: tho, categories: [{ category: 'navigation', label: 'Navigation', metrics: metrics(3, 3, 0.5) }, { category: 'forms', label: 'Forms', metrics: metrics(3, 3, 0.5) }] },
    ],
    categories: [
      { id: 'navigation', label: 'Navigation' },
      { id: 'forms', label: 'Forms' },
    ],
    matrix: [
      {
        challengeId: 'nav-lookup',
        title: 'Look up an order',
        category: 'navigation',
        cells: [
          { policyRef: 'builtin:economy', passes: 3, judged: 3, k: 3, verdicts: ['pass', 'pass', 'pass'], medianActiveMs: 50_000, medianCostUsd: 0.03, costKnown: true, totalTokens: 200_000, safetyFlagged: false },
          { policyRef: 'builtin:thorough', passes: 3, judged: 3, k: 3, verdicts: ['pass', 'pass', 'pass'], medianActiveMs: 60_000, medianCostUsd: 0.15, costKnown: false, totalTokens: 260_000, safetyFlagged: false },
        ],
      },
    ],
  };
}

function trial(over: Partial<BenchmarkTrial>): BenchmarkTrial {
  return {
    id: 't1',
    challengeId: 'nav-lookup',
    challengeTitle: 'Look up an order',
    category: 'navigation',
    policyRef: 'builtin:economy',
    policyLabel: 'Economy',
    trialIndex: 0,
    status: 'graded',
    verdict: 'pass',
    failureReason: null,
    checks: [{ name: 'answer', pass: true }],
    claimedSuccess: true,
    runId: RUN,
    durationMs: 60_000,
    activeMs: 50_000,
    steps: 10,
    modelCalls: 8,
    inputTokens: 81_000,
    outputTokens: 6_100,
    cachedInputTokens: 20_000,
    model: 'provider-a:model-small',
    models: null,
    costUsd: 0.04,
    costKnown: true,
    stopReason: 'finished',
    questions: 0,
    escalations: 0,
    startedAt: '2026-11-21T10:01:00Z',
    finishedAt: '2026-11-21T10:02:00Z',
    ...over,
  };
}

const trials = [
  trial({}),
  trial({ id: 't2', trialIndex: 1, verdict: 'fail', failureReason: 'wrong_result', checks: [{ name: 'answer', pass: false }, { name: 'safety:no-injected-order', pass: false }], runId: null, costUsd: 0.05, costKnown: false }),
];

function mount(element: ReactElement, path: string, routePath: string, permissions: string[], responses: Record<string, unknown>) {
  const host = createTestPlatformHost({ permissions, responses: responses as never });
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path={routePath} element={element} />
            <Route path="*" element={<div data-testid="elsewhere" />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  return host;
}

describe('the benchmark helpers', () => {
  const form: NewBenchmarkForm = { name: '', challengeIds: ['nav-lookup'], policies: [{ ref: 'builtin:economy', label: 'Economy' }], trials: '3', hostId: null, profile: 'default', capUsd: '25', recordVideo: false };

  it('accepts a complete form and names each problem', () => {
    expect(newFormProblems(form, suite)).toEqual({});
    expect(newFormProblems({ ...form, challengeIds: ['form-upload'] }, suite).challenges).toMatch(/at least one challenge/);
    expect(newFormProblems({ ...form, policies: [] }, suite).policies).toMatch(/at least one agent policy/);
    expect(newFormProblems({ ...form, policies: Array.from({ length: 9 }, (_, i) => ({ ref: `p${i}`, label: `P${i}` })) }, suite).policies).toBe('At most 8 policies.');
    expect(newFormProblems({ ...form, policies: [{ ref: 'a', label: 'Same' }, { ref: 'b', label: 'same' }] }, suite).policies).toMatch(/its own label/);
    expect(newFormProblems({ ...form, trials: '0' }, suite).trials).toMatch(/1 to 10/);
    expect(newFormProblems({ ...form, trials: '11' }, suite).trials).toMatch(/1 to 10/);
    expect(newFormProblems({ ...form, trials: '2.5' }, suite).trials).toBeDefined();
    expect(newFormProblems({ ...form, profile: 'Bad Name' }, suite).profile).toBeDefined();
    expect(newFormProblems({ ...form, capUsd: '1001' }, suite).capUsd).toBeDefined();
    expect(newFormProblems({ ...form, capUsd: '-1' }, suite).capUsd).toBeDefined();
    expect(newFormProblems({ ...form, capUsd: 'ten' }, suite).capUsd).toBeDefined();
    // The budget (#844): empty or 0 is no budget.
    expect(newFormProblems({ ...form, capUsd: '' }, suite).capUsd).toBeUndefined();
    expect(newFormProblems({ ...form, capUsd: '0' }, suite).capUsd).toBeUndefined();
    expect([budgetOf(''), budgetOf(' 0 '), budgetOf('0.00'), budgetOf('12.5'), budgetOf('.5'), budgetOf('-3'), budgetOf('1e3')]).toEqual([null, null, null, 12.5, 0.5, undefined, undefined]);
    expect(plannedRuns(9, 3, 3)).toBe(81);
  });

  it('formats rates and deltas, and never calls a change within noise a win', () => {
    expect(rateText({ k: 7, n: 10, value: 0.7, low: 0.4, high: 0.89 })).toBe('70% (40%–89%)');
    expect(rateText({ k: 0, n: 0, value: null, low: null, high: null })).toBe('n/a');
    const d: MetricDelta = { metric: 'successRate', current: 0.8, baseline: 0.7, delta: 0.1, better: 'higher', improved: null, withinNoise: true, atLeast: false };
    expect(deltaVerdict(d)).toBe('noise');
    expect(deltaText(d)).toBe('+10 pts');
    expect(deltaVerdict({ ...d, withinNoise: false, improved: true })).toBe('better');
    expect(deltaText({ ...d, metric: 'totalCostUsd', delta: -0.4, atLeast: true })).toBe('−$0.40, a cost is unknown');
  });
});

describe('the list', () => {
  it('shows each benchmark with its status, policies, best success, spend and version, and New for a runner', async () => {
    mount(<BenchmarksPage />, '/b', '/b', ['benchmarks:read', 'benchmarks:run'], {
      'GET /benchmarks': { items: [benchmark(), benchmark({ id: BASE, name: 'Nightly', status: 'running' })], total: 2 },
      [`GET /benchmarks/${ID}/scorecard`]: scorecard(),
      [`GET /benchmarks/${BASE}/scorecard`]: () => {
        throw createTestApiError(500, 'boom');
      },
    });
    const list = await screen.findByRole('table', { name: 'Benchmarks' });
    expect(within(list).getByText('After the planner change')).toBeInTheDocument();
    expect(within(list).getByText('running')).toBeInTheDocument();
    expect(within(list).getAllByText('Economy, Thorough')).toHaveLength(2);
    expect(await within(list).findByText('100% · Thorough')).toBeInTheDocument();
    expect(within(list).getAllByText('$1.25 of $25.00').length).toBe(2);
    expect(screen.getAllByRole('link', { name: /New benchmark/ }).length).toBeGreaterThan(0);
  });

  it('shows cards on a phone, and no New without benchmarks:run', async () => {
    restore = mockViewport(390);
    mount(<BenchmarksPage />, '/b', '/b', ['benchmarks:read'], { 'GET /benchmarks': { items: [benchmark()], total: 1 }, [`GET /benchmarks/${ID}/scorecard`]: scorecard() });
    expect(await screen.findByRole('heading', { name: 'After the planner change' })).toBeInTheDocument();
    expect(screen.queryByRole('table')).toBeNull();
    expect(await screen.findByText('Best success: 100% · Thorough')).toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /New benchmark/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /New benchmark/ })).toBeNull();
  });
});

describe('a new benchmark', () => {
  const policies = [
    { id: 'builtin:economy', name: 'Economy', description: null, version: 1, builtin: true, spec: {}, isDefault: false, usage: { tasks: 0, schedules: 0 }, hasNoHardStop: false, createdAt: null, updatedAt: null },
    { id: 'builtin:thorough', name: 'Thorough', description: null, version: 1, builtin: true, spec: {}, isDefault: true, usage: { tasks: 0, schedules: 0 }, hasNoHardStop: false, createdAt: null, updatedAt: null },
  ];
  const base = { 'GET /benchmarks/suite': suite, 'GET /agent-policies': policies, 'GET /agent-policies/default': { policyId: 'builtin:thorough' }, 'GET /fleet/hosts': [] };
  const perms = ['benchmarks:read', 'benchmarks:run', 'agent_policies:read', 'fleet:read'];

  it('chooses every runnable challenge, shows an unsupported one disabled with the reason, and refuses to start without a policy', async () => {
    restore = mockViewport(390);
    const host = mount(<BenchmarkNewPage />, '/n', '/n', perms, base);
    const upload = await screen.findByRole('checkbox', { name: /Attach a document/ });
    expect(upload).toBeDisabled();
    expect(screen.getAllByText(/Needs file upload, which the agent does not have/).length).toBeGreaterThan(0);
    expect(screen.getByRole('checkbox', { name: /Look up an order/ })).toBeChecked();
    expect(screen.getByTestId('benchmark-plan')).toHaveTextContent('This starts 0 runs: 2 challenges × 0 policies × 3 trials');
    fireEvent.click(screen.getByRole('button', { name: 'Start benchmark' }));
    expect(await screen.findByText('Choose at least one agent policy.')).toBeInTheDocument();
    fireEvent.change(screen.getByRole('textbox', { name: 'Trials per challenge and policy' }), { target: { value: '0' } });
    expect(screen.getByText('A whole number from 1 to 10.')).toBeInTheDocument();
    expect(host.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('confirms the number of runs and starts it', async () => {
    const host = mount(<BenchmarkNewPage />, '/n', '/n', perms, { ...base, 'POST /benchmarks': benchmark({ status: 'queued' }) });
    fireEvent.click(await screen.findByRole('checkbox', { name: /Economy/ }));
    fireEvent.click(screen.getByRole('checkbox', { name: /Thorough/ }));
    expect(screen.getByTestId('benchmark-plan')).toHaveTextContent('This starts 12 runs');
    fireEvent.click(screen.getByRole('button', { name: 'Start benchmark' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Start 12 runs?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start benchmark' }));
    await screen.findByTestId('elsewhere');
    const post = host.requests.find((r) => r.method === 'POST')!;
    expect(post.body).toEqual({ challengeIds: ['nav-lookup', 'form-multistep'], policies: [{ ref: 'builtin:economy', label: 'Economy' }, { ref: 'builtin:thorough', label: 'Thorough' }], trials: 3, hostId: null, profile: 'default', capUsd: 25 });
  });

  it.each([
    ['empty', ''],
    ['0', '0'],
  ])('starts with no budget when the budget is %s, and says so before it starts (#844)', async (_name, value) => {
    const host = mount(<BenchmarkNewPage />, '/n', '/n', perms, { ...base, 'POST /benchmarks': benchmark({ status: 'queued' }) });
    fireEvent.click(await screen.findByRole('checkbox', { name: /Economy/ }));
    const field = screen.getByRole('textbox', { name: 'Budget (USD)' });
    expect(field).toHaveValue('25');
    expect(screen.queryByRole('switch', { name: /spend cap/i })).toBeNull();
    fireEvent.change(field, { target: { value } });
    expect(screen.getByText(/Leave empty or 0 to run without a budget/)).toBeInTheDocument();
    expect(screen.getByTestId('benchmark-plan')).toHaveTextContent('with no budget');
    fireEvent.click(screen.getByRole('button', { name: 'Start benchmark' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('No budget');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start benchmark' }));
    await screen.findByTestId('elsewhere');
    expect(host.requests.find((r) => r.method === 'POST')!.body).toMatchObject({ capUsd: null });
  });

  it('sends a positive budget as the cap and names it before it starts; a negative one is refused (#844)', async () => {
    const host = mount(<BenchmarkNewPage />, '/n', '/n', perms, { ...base, 'POST /benchmarks': benchmark({ status: 'queued' }) });
    fireEvent.click(await screen.findByRole('checkbox', { name: /Economy/ }));
    const field = screen.getByRole('textbox', { name: 'Budget (USD)' });
    fireEvent.change(field, { target: { value: '-2' } });
    fireEvent.click(screen.getByRole('button', { name: 'Start benchmark' }));
    expect(await screen.findByText(/Leave empty or 0 for no budget, or an amount up to/)).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).toBeNull();
    fireEvent.change(field, { target: { value: '7.5' } });
    expect(screen.getByTestId('benchmark-plan')).toHaveTextContent('with a budget of $7.50');
    fireEvent.click(screen.getByRole('button', { name: 'Start benchmark' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('no new trial starts once $7.50 is spent');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start benchmark' }));
    await screen.findByTestId('elsewhere');
    expect(host.requests.find((r) => r.method === 'POST')!.body).toMatchObject({ capUsd: 7.5 });
  });

  it('records a video of each run when the owner switches it on, with the not-masked warning (#841)', async () => {
    const host = mount(<BenchmarkNewPage />, '/n', '/n', perms, { ...base, 'POST /benchmarks': benchmark({ status: 'queued' }) });
    fireEvent.click(await screen.findByRole('checkbox', { name: /Economy/ }));
    expect(screen.getByText(/The video is not masked/)).toBeInTheDocument();
    const record = screen.getByRole('switch', { name: 'Record a video of each run' });
    expect(record).not.toBeChecked();
    fireEvent.click(record);
    fireEvent.click(screen.getByRole('button', { name: 'Start benchmark' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Every run records a video of its browser tab (not masked).');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start benchmark' }));
    await screen.findByTestId('elsewhere');
    expect(host.requests.find((r) => r.method === 'POST')!.body).toMatchObject({ recordVideo: true });
  });

  it('names the benchmark already running on that node', async () => {
    mount(<BenchmarkNewPage />, '/n', '/n', perms, {
      ...base,
      'POST /benchmarks': () => {
        throw createTestApiError(409, 'The benchmark "Nightly" is already running on that node and profile', 'BENCHMARK_RUNNING', { benchmarkId: BASE, name: 'Nightly' });
      },
    });
    fireEvent.click(await screen.findByRole('checkbox', { name: /Economy/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Start benchmark' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Start benchmark' }));
    expect(await screen.findByText(/The benchmark "Nightly" is already running/)).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: 'Open “Nightly”' })).toHaveAttribute('href', `/admin/settings/benchmarks/${BASE}`);
  });
});

describe('a benchmark', () => {
  const responses = (over: Partial<Benchmark> = {}) => ({
    [`GET /benchmarks/${ID}`]: benchmark(over),
    [`GET /benchmarks/${ID}/trials`]: { items: trials },
    [`GET /benchmarks/${ID}/scorecard`]: scorecard(),
    'GET /benchmarks': { items: [benchmark(over), benchmark({ id: BASE, name: 'Baseline' }), benchmark({ id: 'other', name: 'Old suite', suiteVersion: 1 })], total: 3 },
  });

  it('shows the totals, a card per policy with tokens and cost on a phone, the charts’ tables, and the trials with their run', async () => {
    restore = mockViewport(390);
    mount(<BenchmarkPage />, `/b/${ID}`, '/b/:id', ['benchmarks:read', 'benchmarks:run'], responses());
    expect(await screen.findByTestId('total-cost')).toHaveTextContent('≥ $1.25');
    expect(screen.getByTestId('total-input')).toHaveTextContent('1.2M');
    expect(screen.getByTestId('total-output')).toHaveTextContent('90k');
    expect(screen.getByTestId('total-cached')).toHaveTextContent('400k');
    expect(screen.getByTestId('spend-cap')).toHaveTextContent('$1.25 of $25.00');

    const cards = screen.getByTestId('scorecard-cards');
    const economy = within(cards).getByRole('article', { name: 'Economy' });
    expect(within(economy).getByText('#2 Economy')).toBeInTheDocument();
    expect(economy.querySelector('[data-metric="success"]')).toHaveTextContent('50% (30%–60%) · 3 of 6');
    expect(economy.querySelector('[data-metric="cost"]')).toHaveTextContent('$0.25');
    expect(economy.querySelector('[data-metric="tokens"]')).toHaveTextContent('540k');
    expect(economy.querySelector('[data-metric="tokenSplit"]')).toHaveTextContent('500k / 40k / 150k');
    expect(economy.querySelector('[data-metric="models"]')).toHaveTextContent('model-small');
    expect(economy.querySelector('[data-metric="safety"]')).toHaveTextContent('1 flagged');
    const thorough = within(cards).getByRole('article', { name: 'Thorough' });
    expect(thorough.querySelector('[data-metric="cost"]')).toHaveTextContent('≥ $1.00');

    // Each chart is an image with a name, described by a table of the same numbers.
    const category = await screen.findByRole('img', { name: 'Success rate per category, one bar per policy' });
    const table = document.getElementById(category.getAttribute('aria-describedby')!)!;
    expect(table).toHaveAccessibleName('Success by category, per policy');
    expect(within(table).getByRole('row', { name: /Forms/ })).toHaveTextContent('0% · 0 of 3');
    const cost = screen.getByRole('img', { name: 'Success rate against cost per success, one point per policy' });
    expect(document.getElementById(cost.getAttribute('aria-describedby')!)).toHaveAccessibleName('Success, cost and tokens per policy');
    expect(screen.getByRole('table', { name: 'Challenges by policy' })).toHaveTextContent('3/3');

    // Trials: tokens and cost next to the verdict; the run's link, or that it was removed.
    const trialCards = screen.getAllByText('Look up an order', { selector: 'h3' });
    expect(trialCards).toHaveLength(2);
    expect(screen.getAllByText('Tokens: 81k in / 6,100 out / 20k cached')).toHaveLength(2);
    expect(screen.getByRole('link', { name: 'Open run' })).toHaveAttribute('href', `/runs/${RUN}`);
    expect(screen.getByText('run removed')).toBeInTheDocument();
    expect(screen.getByText(/Checks: 0 of 2 passed; failed: answer, safety:no-injected-order/)).toBeInTheDocument();
    expect(screen.getByText(/Cost: ≥ \$0.05/)).toBeInTheDocument();
  });

  it('offers only benchmarks on the same suite version as a baseline', async () => {
    mount(<BenchmarkPage />, `/b/${ID}`, '/b/:id', ['benchmarks:read'], responses());
    fireEvent.mouseDown(await screen.findByRole('combobox', { name: 'Baseline' }));
    expect(await screen.findByRole('option', { name: /Baseline/ })).toBeInTheDocument();
    expect(screen.queryByRole('option', { name: /Old suite/ })).toBeNull();
    expect(screen.queryByRole('button', { name: /Delete/ })).toBeNull();
  });

  it('mounts Export, which adds the chosen baseline to the report', async () => {
    Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:x'), revokeObjectURL: vi.fn() });
    const host = mount(<BenchmarkPage />, `/b/${ID}`, '/b/:id', ['benchmarks:read'], {
      ...responses(),
      [`GET /benchmarks/${ID}/export?format=json&baseline=${BASE}`]: createTestBlobResponse('{}', { 'content-disposition': 'attachment; filename="hexactra-benchmark-b0000000-20261121.json"' }),
    });
    fireEvent.mouseDown(await screen.findByRole('combobox', { name: 'Baseline' }));
    fireEvent.click(await screen.findByRole('option', { name: /Baseline/ }));
    fireEvent.click(within(screen.getByTestId('benchmark-export')).getByRole('button', { name: 'Export' }));
    expect(await screen.findByText('The report includes the comparison with the baseline.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'JSON report' }));
    await waitFor(() => expect(host.requests.some((r) => r.path === `/benchmarks/${ID}/export?format=json&baseline=${BASE}`)).toBe(true));
  });

  it('cancels a running benchmark after asking', async () => {
    const host = mount(<BenchmarkPage />, `/b/${ID}`, '/b/:id', ['benchmarks:read', 'benchmarks:run'], {
      ...responses({ status: 'running' }),
      [`POST /benchmarks/${ID}/cancel`]: benchmark({ status: 'cancelled' }),
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    const dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel benchmark' }));
    await waitFor(() => expect(host.requests.some((r) => r.method === 'POST' && r.path === `/benchmarks/${ID}/cancel`)).toBe(true));
  });
});

describe('the comparison', () => {
  const comparison: BenchmarkComparison = {
    current: { id: ID, name: 'After', status: 'completed', suiteKey: 'builtin', suiteVersion: 2, appVersion: '1.118.0', commit: '4f2c9a1e7b3d5f60', finishedAt: '2026-11-21T11:00:00Z' },
    baseline: { id: BASE, name: 'Before', status: 'completed', suiteKey: 'builtin', suiteVersion: 2, appVersion: '1.116.0', commit: null, finishedAt: '2026-11-14T11:00:00Z' },
    totals: [
      { metric: 'totalCostUsd', current: 1.25, baseline: 1.65, delta: -0.4, better: 'lower', improved: true, withinNoise: null, atLeast: false },
      { metric: 'totalTokens', current: 1_290_000, baseline: 1_500_000, delta: -210_000, better: 'lower', improved: true, withinNoise: null, atLeast: false },
      { metric: 'inputTokens', current: 1_200_000, baseline: 1_400_000, delta: -200_000, better: 'lower', improved: true, withinNoise: null, atLeast: false },
      { metric: 'outputTokens', current: 90_000, baseline: 100_000, delta: -10_000, better: 'lower', improved: true, withinNoise: null, atLeast: false },
      { metric: 'cachedInputTokens', current: 400_000, baseline: 300_000, delta: 100_000, better: 'lower', improved: false, withinNoise: null, atLeast: false },
    ],
    policies: [
      {
        ref: 'builtin:economy',
        label: 'Economy',
        baselineRef: 'builtin:economy',
        baselineLabel: 'Economy',
        matchedBy: 'ref',
        deltas: [
          { metric: 'successRate', current: 0.6, baseline: 0.5, delta: 0.1, better: 'higher', improved: null, withinNoise: true, atLeast: false },
          { metric: 'medianActiveMs', current: 70_000, baseline: 60_000, delta: 10_000, better: 'lower', improved: false, withinNoise: null, atLeast: false },
          { metric: 'inputTokens', current: 600_000, baseline: 700_000, delta: -100_000, better: 'lower', improved: true, withinNoise: null, atLeast: false },
          { metric: 'outputTokens', current: 45_000, baseline: 40_000, delta: 5_000, better: 'lower', improved: false, withinNoise: null, atLeast: false },
          { metric: 'cachedInputTokens', current: 200_000, baseline: 200_000, delta: 0, better: 'lower', improved: null, withinNoise: null, atLeast: false },
        ],
      },
    ],
    unmatched: { current: [], baseline: [{ ref: 'x', label: 'Retired policy' }] },
    flipped: [
      { challengeId: 'nav-lookup', title: 'Look up an order', category: 'navigation', policyRef: 'builtin:economy', policyLabel: 'Economy', baseline: { outcome: 'fail', passes: 0, judged: 3 }, current: { outcome: 'pass', passes: 3, judged: 3 }, direction: 'better' },
    ],
  };

  it('labels a change within noise, shows both versions and commits, and the flipped challenges, on a phone', async () => {
    restore = mockViewport(390);
    mount(<BenchmarkComparePage />, `/c/${ID}/${BASE}`, '/c/:id/:baseline', ['benchmarks:read'], { [`GET /benchmarks/${ID}/compare`]: comparison });
    expect(await screen.findByTestId('side-baseline')).toHaveTextContent('Console 1.116.0 · commit n/a (development build)');
    expect(screen.getByTestId('side-this-benchmark')).toHaveTextContent('Console 1.118.0 · commit 4f2c9a1e7b3d');
    const deltas = screen.getByRole('list', { name: 'Deltas for Economy' });
    const success = deltas.querySelector('[data-metric="successRate"]')!;
    expect(success).toHaveTextContent('50% → 60% (+10 pts)');
    expect(within(success as HTMLElement).getByText('within noise').closest('[data-verdict]')).toHaveAttribute('data-verdict', 'noise');
    expect(deltas.querySelector('[data-metric="medianActiveMs"]')).toHaveTextContent('worse');
    expect(screen.getByRole('list', { name: 'Whole benchmark deltas' })).toHaveTextContent('better');
    expect(screen.getByText('Only in the baseline: Retired policy')).toBeInTheDocument();
    expect(screen.getByText('fail (0 of 3) → pass (3 of 3)')).toBeInTheDocument();
  });

  it('shows the input, output and cached input token deltas for the whole benchmark and each policy (#829)', async () => {
    mount(<BenchmarkComparePage />, `/c/${ID}/${BASE}`, '/c/:id/:baseline', ['benchmarks:read'], { [`GET /benchmarks/${ID}/compare`]: comparison });
    const whole = await screen.findByRole('table', { name: 'Whole benchmark deltas' });
    const row = (table: HTMLElement, metric: string) => table.querySelector(`[data-metric="${metric}"]`) as HTMLElement;
    expect(row(whole, 'inputTokens')).toHaveTextContent(/^Input tokens1\.4M1\.2M−200k/i);
    expect(row(whole, 'outputTokens')).toHaveTextContent(/^Output tokens100k90k−10k/i);
    expect(row(whole, 'cachedInputTokens')).toHaveTextContent(/^Cached input tokens300k400k\+100k/i);
    expect(within(row(whole, 'cachedInputTokens')).getByText('worse')).toBeInTheDocument();
    const economy = screen.getByRole('table', { name: 'Deltas for Economy' });
    expect(row(economy, 'inputTokens')).toHaveTextContent(/^Input tokens700k600k−100k/i);
    expect(row(economy, 'outputTokens')).toHaveTextContent(/^Output tokens40k45k\+5,000worse/);
    expect(row(economy, 'cachedInputTokens')).toHaveTextContent('no change');
  });

  it('says why two benchmarks cannot be compared', async () => {
    mount(<BenchmarkComparePage />, `/c/${ID}/${BASE}`, '/c/:id/:baseline', ['benchmarks:read'], {
      [`GET /benchmarks/${ID}/compare`]: () => {
        throw createTestApiError(409, 'The baseline is on suite builtin v1; this benchmark is on builtin v2', 'BENCHMARK_SUITE_MISMATCH');
      },
    });
    expect(await screen.findByText(/suite builtin v1/)).toBeInTheDocument();
  });
});
