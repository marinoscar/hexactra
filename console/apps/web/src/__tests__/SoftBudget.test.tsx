// A chat run's budgets are soft (#537): the meter's over tone and caption, the
// chat card's near-limit and over-limit lines, and no "Stopped" banner for a
// finished run that went over its usual limit.
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { SoftBudgetLine } from '../components/ChatBrowser';
import { RunBudgetMeter, RunStopReason } from '../components/RunBudgetMeter';
import { meterRows, meterTone, overLimitLine, softBudgetNotice, SOFT_BUDGET_CAPTION, usedOfLimitText, type RunBudget } from '../components/runBudget';

function budget(used: Partial<RunBudget['used']> = {}, enforcement: 'hard' | 'soft' = 'soft'): RunBudget {
  const limits = { actions: 60, modelCalls: 120, activeMinutes: 20, inputTokens: null, outputTokens: null, cost: 2 };
  const u = { actions: 0, modelCalls: 0, activeMinutes: 0, inputTokens: 0, outputTokens: 0, cost: 0, ...used };
  const percent = Object.fromEntries(Object.entries(limits).map(([k, l]) => [k, l === null ? null : Math.round((u[k as keyof typeof u] / l) * 1000) / 10])) as RunBudget['percent'];
  const over = (Object.keys(limits) as (keyof typeof limits)[]).filter((k) => limits[k] !== null && u[k] >= limits[k]!);
  return {
    effective: { ...limits, warnAtPercent: 80 },
    used: u,
    percent,
    source: { actions: 'policy', modelCalls: 'policy', activeMinutes: 'policy', inputTokens: null, outputTokens: null, cost: 'policy' },
    costKnown: true,
    enforcement,
    over,
  };
}

describe('the meter of a soft budget', () => {
  it('turns over (not error) past 100% and keeps the percent above 100', () => {
    expect(meterTone(107, 80, true)).toBe('over');
    expect(meterTone(107, 80, false)).toBe('error');
    const row = meterRows(budget({ actions: 64 })).find((r) => r.key === 'actions')!;
    expect(row).toMatchObject({ tone: 'over', text: '64 / 60', percent: 106.7 });
  });

  it('draws a full bar labelled "64 / 60 · 106%" and the reference caption', () => {
    render(<RunBudgetMeter budget={budget({ actions: 64 })} ticking={false} now={0} />);
    const bar = screen.getByTestId('budget-actions');
    expect(bar).toHaveAttribute('data-tone', 'over');
    expect(bar).toHaveTextContent('64 / 60 · 106%');
    expect(screen.getByRole('progressbar', { name: 'Actions budget' })).toHaveAttribute('aria-valuenow', '100');
    expect(screen.getByTestId('budget-soft-caption')).toHaveTextContent(SOFT_BUDGET_CAPTION);
  });

  it('a hard budget has no caption and keeps the error tone', () => {
    render(<RunBudgetMeter budget={budget({ actions: 64 }, 'hard')} ticking={false} now={0} />);
    expect(screen.queryByTestId('budget-soft-caption')).toBeNull();
    expect(screen.getByTestId('budget-actions')).toHaveAttribute('data-tone', 'error');
  });
});

describe("the chat card's budget line", () => {
  it('says nothing below the warning threshold, or for a hard budget', () => {
    expect(softBudgetNotice(budget({ actions: 10 }))).toBeNull();
    expect(softBudgetNotice(budget({ actions: 70 }, 'hard'))).toBeNull();
    expect(softBudgetNotice(null)).toBeNull();
  });

  it('near the limit names the closest budget', () => {
    expect(softBudgetNotice(budget({ actions: 48, modelCalls: 10 }))).toEqual({ tone: 'near', text: "Close to this chat's usual limit: 48 of 60 actions." });
  });

  it('over the limit names the furthest over, says it is still working, and is a status in the warning colour', () => {
    expect(softBudgetNotice(budget({ actions: 64, cost: 2.5 }))).toEqual({ tone: 'over', text: 'Over the usual limit: $2.50 of $2.00. Still working. Press Stop to end it.' });
    render(<SoftBudgetLine run={{ budget: budget({ actions: 64 }) }} />);
    const line = screen.getByRole('status');
    expect(line).toHaveTextContent('Over the usual limit: 64 of 60 actions. Still working. Press Stop to end it.');
    expect(line).toHaveAttribute('data-tone', 'over');
  });

  it('words each budget in its unit', () => {
    expect(usedOfLimitText('actions', 64, 60)).toBe('64 of 60 actions');
    expect(usedOfLimitText('modelCalls', 130, 120)).toBe('130 of 120 model calls');
    expect(usedOfLimitText('activeMinutes', 21, 20)).toBe('21 min of 20 min of active time');
    expect(usedOfLimitText('cost', 2.1, 2)).toBe('$2.10 of $2.00');
  });
});

describe('a finished run that went over its usual limit', () => {
  const run = { status: 'succeeded', stopReason: 'finished' as const, result: 'Paid.', error: null, budget: budget({ actions: 64 }) };

  it('shows no "Stopped" banner for the budget, only a plain line', () => {
    render(<RunStopReason run={run} />);
    expect(screen.queryByText(/budget reached/)).toBeNull();
    expect(screen.getByTestId('stop-reason')).toHaveTextContent('Finished: the agent completed the goal.');
    expect(screen.getByTestId('over-limit-line')).toHaveTextContent('Went over its usual limit: 64 of 60 actions.');
  });

  it('a hard-budget run stopped by its budget keeps the Stopped banner and no over line', () => {
    const hard = { ...run, status: 'failed', stopReason: 'budget_actions' as const, budget: budget({ actions: 60 }, 'hard') };
    expect(overLimitLine(hard)).toBeNull();
    render(<RunStopReason run={hard} />);
    expect(screen.getByTestId('stop-reason')).toHaveTextContent('Stopped: actions budget reached (60).');
    expect(screen.queryByTestId('over-limit-line')).toBeNull();
  });
});
