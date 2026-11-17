// The run page's budget meter, header chips and stop reasons, the runs list's
// cost and stop chips, routing rows and the task spend line (#408).
import { act, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';
import { describe, expect, it, vi } from 'vitest';

const live = vi.hoisted(() => ({ emit: null as null | ((e: unknown) => void) }));
vi.mock('../live', () => ({
  subscribeRun: (_id: string, on: (e: unknown) => void) => {
    live.emit = on;
    return () => undefined;
  },
  fetchRunScreenshot: async () => null,
}));

import { RunBudgetMeter, RunStopReason, TaskSpendLine } from '../components/RunBudgetMeter';
import { RunTimeline, type RunTimelineStep } from '../components/RunTimeline';
import { formatUsd, meterRows, meterTone, spendLine, STOP_REASONS, stopChipLabel, stopLine, tierChip, type RunBudget, type StopReason } from '../components/runBudget';
import { routingRow } from '../components/runRouting';
import { RunDetailPage } from '../pages/RunDetailPage';
import { RunsPage } from '../pages/RunsPage';
import { TasksPage } from '../pages/TasksPage';
import type { Run } from '../types/runs';
import type { Task } from '../types/tasks';
import { ConfirmProvider } from '../ui';

const RUN_ID = '22222222-2222-4222-8222-222222222222';
const TASK_ID = '11111111-1111-4111-8111-111111111111';

/** Balanced-like: four limits, input and output tokens unlimited. */
function budget(used: Partial<RunBudget['used']> = {}, extra: Partial<RunBudget> = {}): RunBudget {
  const limits = { actions: 60, modelCalls: 120, activeMinutes: 20, inputTokens: null, outputTokens: null, cost: 2 };
  const u = { actions: 0, modelCalls: 0, activeMinutes: 0, inputTokens: 0, outputTokens: 0, cost: 0, ...used };
  const percent = Object.fromEntries(Object.entries(limits).map(([k, l]) => [k, l === null ? null : (u[k as keyof typeof u] / l) * 100])) as RunBudget['percent'];
  return {
    effective: { ...limits, warnAtPercent: 80 },
    used: u,
    percent,
    source: { actions: 'policy', modelCalls: 'policy', activeMinutes: 'ceiling', inputTokens: null, outputTokens: null, cost: 'policy' },
    costKnown: true,
    ...extra,
  };
}

const baseRun: Run = {
  id: RUN_ID,
  taskId: TASK_ID,
  status: 'running',
  trigger: 'manual',
  goal: 'Find the cheapest fare',
  profile: 'travel',
  result: null,
  error: null,
  cancelRequested: false,
  stepCount: 3,
  createdAt: '2026-11-15T00:00:00Z',
  finishedAt: null,
  steps: [],
  costUsd: 0.42,
  costKnown: true,
  modelCalls: 6,
  policy: { id: 'builtin:balanced', name: 'Balanced', version: 1, source: 'user_default', builtin: true },
  tier: { start: 'standard', max: 'frontier', current: 'standard', escalations: 0, model: 'prov-a:model-mid' },
  budget: budget({ actions: 3, modelCalls: 6, activeMinutes: 1.5, inputTokens: 12_000, outputTokens: 800, cost: 0.42 }),
  stopReason: null,
};

describe('the budget meter rows', () => {
  it('render used / limit and a percent for limited budgets, used and ∞ for unlimited ones', () => {
    const rows = meterRows(budget({ actions: 30, inputTokens: 1_200_000, cost: 0.5 }));
    expect(rows.find((r) => r.key === 'actions')).toMatchObject({ text: '30 / 60', percent: 50, tone: 'primary' });
    expect(rows.find((r) => r.key === 'cost')).toMatchObject({ text: '$0.50 / $2.00', percent: 25 });
    expect(rows.find((r) => r.key === 'inputTokens')).toMatchObject({ limit: null, percent: null, text: '1.2M used' });
    expect(rows.find((r) => r.key === 'activeMinutes')?.ceiling).toBe(true);
  });

  it('turn warning at warnAtPercent and error at 100%', () => {
    expect(meterTone(79.9, 80)).toBe('primary');
    expect(meterTone(80, 80)).toBe('warning');
    expect(meterTone(100, 80)).toBe('error');
    expect(meterTone(null, 80)).toBe('primary');
    const rows = meterRows(budget({ actions: 50, cost: 2 }));
    expect(rows.find((r) => r.key === 'actions')?.tone).toBe('warning');
    expect(rows.find((r) => r.key === 'cost')?.tone).toBe('error');
  });

  it('show "≥" for a cost that is only a lower bound', () => {
    expect(meterRows(budget({ cost: 0.5 }, { costKnown: false })).find((r) => r.key === 'cost')?.text).toBe('≥ $0.50 / $2.00');
    expect(formatUsd(0.0042)).toBe('$0.0042');
    expect(formatUsd(3, false)).toBe('≥ $3.00');
  });

  it('tick active time forward from the last budget received', () => {
    expect(meterRows(budget({ activeMinutes: 1 }), 0.5).find((r) => r.key === 'activeMinutes')).toMatchObject({ used: 1.5, text: '1.5 min / 20 min' });
  });
});

describe('RunBudgetMeter', () => {
  it('draws a bar per limited budget, coloured by threshold, and ∞ for the rest', () => {
    render(<RunBudgetMeter budget={budget({ actions: 50, modelCalls: 12, cost: 2.1, outputTokens: 500 }, { costKnown: false })} ticking={false} now={Date.now()} />);
    const meter = screen.getByRole('group', { name: 'Budget' });
    expect(within(meter).getAllByRole('progressbar')).toHaveLength(4);
    expect(screen.getByTestId('budget-actions')).toHaveAttribute('data-tone', 'warning');
    expect(screen.getByTestId('budget-actions')).toHaveTextContent('50 / 60 · 83%');
    expect(screen.getByTestId('budget-modelCalls')).toHaveAttribute('data-tone', 'primary');
    expect(screen.getByTestId('budget-cost')).toHaveAttribute('data-tone', 'error');
    expect(screen.getByTestId('budget-cost')).toHaveTextContent('≥ $2.10 / $2.00');
    expect(screen.getByTestId('budget-outputTokens')).toHaveTextContent('500 used');
    expect(within(screen.getByTestId('budget-outputTokens')).getByLabelText('unlimited')).toHaveTextContent('∞');
  });
});

describe('stop reasons', () => {
  const cases: Record<StopReason, RegExp> = {
    finished: /^Finished: the agent completed the goal\.$/,
    budget_actions: /^Stopped: actions budget reached \(60\)\.$/,
    budget_model_calls: /^Stopped: model calls budget reached \(120\)\.$/,
    budget_active_time: /^Stopped: active time budget reached \(20 min\)\.$/,
    budget_input_tokens: /^Stopped: input tokens budget reached\.$/,
    budget_output_tokens: /^Stopped: output tokens budget reached\.$/,
    budget_cost: /^Stopped: cost budget reached \(\$2\.00\)\.$/,
    stalled: /^Stopped: stuck \(the same click repeated 3×\)\.$/,
    cancelled: /^Stopped: cancelled\.$/,
    error: /^Stopped: an error ended the run\.$/,
    no_model: /^Stopped: no usable model for this run's tier\.$/,
  };

  it.each(STOP_REASONS.map((r) => [r]))('renders a line for %s', (reason) => {
    const run = { status: reason === 'finished' ? 'succeeded' : 'failed', stopReason: reason, result: 'Compared 3 of 5 fares; 2 remain.', error: reason === 'stalled' ? 'the same click repeated 3×' : 'boom', budget: budget() };
    render(<RunStopReason run={run} />);
    const alert = screen.getByTestId('stop-reason');
    expect(stopLine(run)!.title).toMatch(cases[reason]);
    expect(alert).toHaveTextContent(stopLine(run)!.title);
    expect(alert).toHaveTextContent("The agent's summary: Compared 3 of 5 fares; 2 remain.");
  });

  it('reads the stall reason the runner records (#405) without repeating "stalled"', () => {
    const run = { status: 'failed', stopReason: 'stalled' as const, result: null, error: 'The agent stalled: no action in 3 rounds in a row', budget: budget() };
    expect(stopLine(run)!.title).toBe('Stopped: stuck (no action in 3 rounds in a row).');
  });

  it('says nothing while a run has no stop reason, and labels the list chips', () => {
    expect(stopLine({ status: 'running', stopReason: null, result: null, error: null })).toBeNull();
    expect(stopChipLabel('budget_cost')).toBe('cost budget');
    expect(stopChipLabel('stalled')).toBe('stuck');
    expect(stopChipLabel('finished')).toBeNull();
  });

  it('a budget stop whose wrap-up reported success is a success', () => {
    expect(stopLine({ status: 'succeeded', stopReason: 'budget_cost', result: 'Done', error: null, budget: budget() })?.severity).toBe('success');
  });
});

describe('routing rows', () => {
  const routing = (seq: number, args: Record<string, unknown>): RunTimelineStep => ({ id: `r${seq}`, seq, kind: 'routing', action: null, ok: true, summary: 'routing', args, reasoning: null });

  it('map escalations, de-escalations and fallbacks', () => {
    expect(routingRow(routing(1, { from: 'standard', to: 'frontier', reason: 'stuck on repeated click' }))).toEqual({ direction: 'up', label: '↑ Frontier: stuck on repeated click' });
    expect(routingRow(routing(2, { from: 'frontier', to: 'standard', reason: 'progressing' }))).toEqual({ direction: 'down', label: '↓ Standard: progressing' });
    expect(routingRow(routing(3, { from: 'prov-a:model-mid', to: 'prov-b:model-alt', reason: 'provider unavailable' }))).toEqual({ direction: 'fallback', label: '⇄ fallback model: provider unavailable' });
    expect(routingRow({ kind: 'action', args: null, summary: 'x' })).toBeNull();
  });

  it('render as their own rows in the timeline', () => {
    const steps: RunTimelineStep[] = [
      { id: 'a1', seq: 1, kind: 'action', action: 'click', ok: false, summary: 'no element', args: null, reasoning: null },
      routing(2, { from: 'standard', to: 'frontier', reason: 'stuck on repeated click' }),
      { id: 'a3', seq: 3, kind: 'action', action: 'click', ok: true, summary: 'done', args: null, reasoning: null },
      routing(4, { from: 'frontier', to: 'standard', reason: 'progressing' }),
    ];
    render(<RunTimeline steps={steps} live={false} />);
    expect(screen.getByTestId('routing-2')).toHaveTextContent('↑ Frontier: stuck on repeated click');
    expect(screen.getByTestId('routing-4')).toHaveTextContent('↓ Standard: progressing');
  });
});

function renderDetail(run: Run) {
  const host = createTestPlatformHost({
    permissions: ['runs:read', 'runs:write'],
    responses: { [`GET /runs/${run.id}`]: run, [`GET /runs/${run.id}/viewer`]: { hostId: null, hostName: null, desktop: false } },
  });
  render(
    <PlatformHostProvider host={host}>
      <MemoryRouter initialEntries={[`/runs/${run.id}`]}>
        <Routes>
          <Route path="/runs/:id" element={<RunDetailPage />} />
        </Routes>
      </MemoryRouter>
    </PlatformHostProvider>,
  );
}

describe('RunDetailPage', () => {
  it('shows the policy, tier and model chips and the meter, and a streamed run event updates the meter', async () => {
    renderDetail(baseRun);
    expect(await screen.findByTestId('policy-chip')).toHaveTextContent('policy: Balanced v1 · default');
    expect(screen.getByTestId('tier-chip')).toHaveTextContent('tier: Standard');
    expect(screen.getByTestId('model-chip')).toHaveTextContent('model: prov-a:model-mid');
    expect(screen.getByTestId('budget-cost')).toHaveTextContent('$0.42 / $2.00');
    expect(screen.getByTestId('budget-cost')).toHaveAttribute('data-tone', 'primary');

    // No reload: the stream's `run` event carries the new budget and the escalated tier.
    act(() =>
      live.emit!({
        type: 'run',
        data: { status: 'running', costUsd: 1.7, budget: budget({ actions: 20, cost: 1.7 }), tier: { ...baseRun.tier!, current: 'frontier', escalations: 1, model: 'prov-a:model-large' } },
      }),
    );
    expect(screen.getByTestId('budget-cost')).toHaveTextContent('$1.70 / $2.00');
    expect(screen.getByTestId('budget-cost')).toHaveAttribute('data-tone', 'warning');
    expect(screen.getByTestId('tier-chip')).toHaveTextContent('tier: Standard → Frontier');
    expect(screen.getByTestId('model-chip')).toHaveTextContent('model: prov-a:model-large');
  });

  it('shows why a finished run stopped, with the agent summary, instead of the bare result', async () => {
    renderDetail({ ...baseRun, status: 'failed', stopReason: 'budget_cost', result: 'Compared 3 of 5 fares; 2 remain.', error: 'Cost budget exhausted', budget: budget({ cost: 2.01 }) });
    expect(await screen.findByTestId('stop-reason')).toHaveTextContent('Stopped: cost budget reached ($2.00).');
    expect(screen.getByTestId('stop-reason')).toHaveTextContent("The agent's summary: Compared 3 of 5 fares; 2 remain.");
    expect(screen.queryByText('Cost budget exhausted')).toBeNull();
    expect(screen.getByTestId('budget-cost')).toHaveAttribute('data-tone', 'error');
  });
});

describe('RunsPage', () => {
  it('lists each run with its cost and a stop-reason chip, and the task spend on a task view', async () => {
    const runs: Run[] = [
      { ...baseRun, status: 'failed', stopReason: 'budget_cost', costUsd: 2.01, costKnown: false },
      { ...baseRun, id: '33333333-3333-4333-8333-333333333333', status: 'succeeded', stopReason: 'finished', costUsd: 0, modelCalls: 0 },
    ];
    const host = createTestPlatformHost({
      permissions: ['runs:read', 'tasks:read'],
      responses: {
        [`GET /runs?taskId=${TASK_ID}`]: runs,
        [`GET /tasks/${TASK_ID}`]: { name: 'Check fare', spend30d: { runs: 2, costUsd: 2.01, costKnown: false, tokens: 25_000, succeeded: 1, avgSuccessCostUsd: 0 } },
      },
    });
    render(
      <PlatformHostProvider host={host}>
        <MemoryRouter initialEntries={[`/runs?taskId=${TASK_ID}`]}>
          <Routes>
            <Route path="/runs" element={<RunsPage />} />
          </Routes>
        </MemoryRouter>
      </PlatformHostProvider>,
    );
    const first = await screen.findByTestId(`run-row-${RUN_ID}`);
    expect(within(first).getByTestId('run-cost')).toHaveTextContent('≥ $2.01');
    expect(within(first).getByTestId('run-stop')).toHaveTextContent('cost budget');
    const second = screen.getByTestId('run-row-33333333-3333-4333-8333-333333333333');
    expect(within(second).getByTestId('run-cost')).toHaveTextContent('—');
    expect(within(second).queryByTestId('run-stop')).toBeNull();
    expect(await screen.findByTestId('task-spend')).toHaveTextContent('Last 30 days: 2 runs · ≥ $2.01 · 25K tokens · ≥ $0.00 per successful run');
  });
});

describe('task spend', () => {
  it('reads runs, cost, tokens and the average cost per successful run', () => {
    expect(spendLine({ runs: 4, costUsd: 1.2, costKnown: true, tokens: 120_000, succeeded: 3, avgSuccessCostUsd: 0.3 })).toBe('Last 30 days: 4 runs · $1.20 · 120K tokens · $0.30 per successful run');
    expect(spendLine({ runs: 1, costUsd: 0.5, costKnown: true, tokens: 900, succeeded: 0, avgSuccessCostUsd: null })).toBe('Last 30 days: 1 run · $0.50 · 900 tokens · no successful run');
    expect(spendLine({ runs: 0, costUsd: 0, costKnown: true, tokens: 0 })).toBe('Last 30 days: no runs');
    render(<TaskSpendLine spend={undefined} />);
    expect(screen.queryByTestId('task-spend')).toBeNull();
  });

  it('shows on the task card', async () => {
    const task: Task = {
      id: TASK_ID,
      name: 'Check fare',
      goal: 'Find the cheapest fare',
      profile: 'travel',
      hostId: null,
      hostFallback: true,
      allowedDomains: [],
      confirmRiskyActions: true,
      policyId: null,
      spend30d: { runs: 2, costUsd: 0.8, costKnown: true, tokens: 4000, succeeded: 2, avgSuccessCostUsd: 0.4 },
    };
    const host = createTestPlatformHost({ permissions: ['tasks:read'], responses: { 'GET /tasks': [task], [`GET /schedules?taskId=${TASK_ID}`]: [] } });
    render(
      <PlatformHostProvider host={host}>
        <ConfirmProvider>
          <MemoryRouter initialEntries={['/tasks']}>
            <Routes>
              <Route path="/tasks" element={<TasksPage />} />
            </Routes>
          </MemoryRouter>
        </ConfirmProvider>
      </PlatformHostProvider>,
    );
    expect(await screen.findByTestId('task-spend')).toHaveTextContent('Last 30 days: 2 runs · $0.80 · 4,000 tokens · $0.40 per successful run');
  });
});

describe('tier chip', () => {
  it('highlights an escalated tier', () => {
    expect(tierChip({ start: 'standard', max: 'frontier', current: 'standard', escalations: 0, model: null })).toEqual({ label: 'tier: Standard', escalated: false });
    expect(tierChip({ start: 'standard', max: 'frontier', current: 'frontier', escalations: 1, model: null })).toEqual({ label: 'tier: Standard → Frontier', escalated: true });
  });
});
