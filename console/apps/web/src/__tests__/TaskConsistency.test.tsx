// The task page's "Consistency" card (E52.7, #1022).
import { render, screen, within } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { describe, expect, it } from 'vitest';

import { TaskConsistencyCard, consistencySentence, type TaskConsistencyData } from '../components/TaskConsistency';

const spread = (min: number, median: number, max: number) => ({ min, median, p90: max, max, ratio: median ? max / median : 1 });
const data = (over: Partial<TaskConsistencyData> = {}): TaskConsistencyData => ({
  taskId: 't',
  runs: 4,
  succeeded: 4,
  successRate: 1,
  steps: spread(33, 39, 124),
  modelCalls: spread(33, 39, 129),
  activeMs: spread(97_000, 176_000, 707_000),
  costUsd: spread(0.013, 0.015, 0.063),
  label: 'erratic',
  since: null,
  perRun: [
    { runId: '00000000-0000-4000-8000-000000000001', status: 'succeeded', createdAt: '2026-11-27T00:00:00Z', stepCount: 33, costUsd: 0.013, activeMs: 97_000, findings: [] },
    { runId: '00000000-0000-4000-8000-000000000004', status: 'succeeded', createdAt: '2026-11-26T23:00:00Z', stepCount: 124, costUsd: 0.063, activeMs: 707_000, findings: [{ code: 'loop', severity: 'warn' }, { code: 'slow_start', severity: 'info' }] },
  ],
  ...over,
});

describe('TaskConsistencyCard', () => {
  it('shows the label, one sentence, the ranges and a bar per run with its warnings', () => {
    render(<MemoryRouter><TaskConsistencyCard data={data()} /></MemoryRouter>);
    const card = screen.getByRole('region', { name: 'Consistency' });
    expect(within(card).getByText('Erratic')).toBeInTheDocument();
    expect(within(card).getByText('Usually 39 steps; the longest of the last 4 took 124.')).toBeInTheDocument();
    expect(within(card).getByText('39 (33–124)')).toBeInTheDocument();
    expect(within(card).getByText('4 of 4')).toBeInTheDocument();
    const runs = within(card).getByRole('list', { name: 'Runs by steps' });
    expect(within(runs).getByRole('link', { name: 'Run with 124 steps, succeeded' })).toHaveAttribute('href', '/runs/00000000-0000-4000-8000-000000000004');
    expect(within(runs).getByText('Loop')).toBeInTheDocument();
    // Information findings are not shown as chips.
    expect(within(runs).queryByText('slow_start')).toBeNull();
  });

  it('words each label', () => {
    for (const [label, text] of [['steady', 'Steady'], ['varies', 'Varies'], ['not_enough_runs', 'Not enough runs yet']] as const) {
      const { unmount } = render(<MemoryRouter><TaskConsistencyCard data={data({ label })} /></MemoryRouter>);
      expect(screen.getByText(text)).toBeInTheDocument();
      unmount();
    }
  });

  it('says so with no runs and with fewer than three', () => {
    expect(consistencySentence(data({ runs: 0, steps: null, perRun: [] }))).toBe('No finished runs yet.');
    expect(consistencySentence(data({ runs: 2, steps: spread(30, 31, 32) }))).toBe('2 finished runs so far, 31 steps at the median.');
    expect(consistencySentence(data({ runs: 5, steps: spread(31, 31, 31) }))).toBe('Every one of the last 5 runs took about 31 steps.');
  });
});
