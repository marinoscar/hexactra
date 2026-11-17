import { fireEvent, render, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it } from 'vitest';

import { RunTimeline, type RunTimelineStep } from '../components/RunTimeline';
import { formatStepDuration, groupSteps } from '../components/runTimeline';

let n = 0;
const step = (seq: number, action: string, ok = true, summary = 'done', durationMs: number | null = null): RunTimelineStep => ({
  id: `s${++n}`,
  seq,
  kind: action === 'look' ? 'observe' : 'action',
  action,
  ok,
  summary,
  durationMs,
  args: null,
  reasoning: null,
});

// The run from the bug report (#378): navigate, then reads, a click, more reads, two host timeouts.
const united = [
  step(1, 'navigate', true, 'at https://www.united.com/en/us'),
  step(2, 'text', true, 'read 3605 characters'),
  step(3, 'elements', true, '80 interactive elements'),
  step(4, 'click', true, 'done'),
  step(5, 'text', true, 'read 3886 characters'),
  step(6, 'elements', true, '80 interactive elements'),
  step(7, 'look', true, 'looked at the page'),
  step(8, 'elements', true, '80 interactive elements'),
  step(9, 'evaluate', false, 'host did not report a result in time'),
  step(10, 'click_at', false, 'host did not report a result in time'),
  step(11, 'click_at', false, 'host did not report a result in time'),
  step(12, 'text', true, 'read 3886 characters'),
];

describe('groupSteps (#380)', () => {
  it('folds runs of observations, keeps actions, and counts a repeated failure', () => {
    const rows = groupSteps(united, 'oldest');
    expect(rows.map((r) => (r.kind === 'observed' ? `obs:${r.steps.map((s) => s.seq).join(',')}` : `${r.step.seq}x${r.steps.length}`))).toEqual([
      '1x1',
      'obs:2,3',
      '4x1',
      'obs:5,6,7,8',
      '9x1',
      '11x2',
      '12x1',
    ]);
  });

  it('runs newest first, inside groups too', () => {
    const rows = groupSteps(united, 'newest');
    expect(rows[0]).toMatchObject({ kind: 'step', step: { seq: 12 } });
    expect(rows[1]).toMatchObject({ kind: 'step', step: { seq: 11 } });
    const obs = rows.find((r) => r.kind === 'observed')!;
    expect(obs.steps.map((s) => s.seq)).toEqual([8, 7, 6, 5]);
  });

  it('does not fold a failed observation or different failures', () => {
    const rows = groupSteps([step(1, 'text', false, 'no tab'), step(2, 'text'), step(3, 'click', false), step(4, 'type', false)], 'oldest');
    expect(rows.map((r) => r.kind)).toEqual(['step', 'step', 'step', 'step']);
  });

  it('formats durations', () => {
    expect(formatStepDuration(850)).toBe('850 ms');
    expect(formatStepDuration(4_230)).toBe('4.2 s');
    expect(formatStepDuration(65_000)).toBe('1 min 5 s');
    expect(formatStepDuration(null)).toBeNull();
  });
});

describe('RunTimeline (#380)', () => {
  beforeEach(() => {
    try {
      localStorage.clear();
    } catch {
      // storage may be unavailable
    }
  });

  it('shows the latest step first on a live run, marks failures and folds page reads', () => {
    render(<RunTimeline steps={[...united.slice(0, 9), { ...united[9]!, durationMs: 45_000 }, united[10]!]} live />);
    const list = screen.getByRole('list', { name: 'Steps' });
    const items = within(list).getAllByRole('listitem');
    expect(items[0]).toHaveTextContent('11. click_at (failed): host did not report a result in time (×2 in a row)');
    expect(within(items[0]!).getByLabelText('failed')).toBeInTheDocument();
    expect(screen.getByText('5–8. Observed the page (4 steps)')).toBeInTheDocument();
    expect(screen.queryByText('7. look: looked at the page')).not.toBeInTheDocument();
    fireEvent.click(screen.getByText('5–8. Observed the page (4 steps)'));
    expect(screen.getByText('7. look: looked at the page')).toBeInTheDocument();
  });

  it('shows a step duration', () => {
    render(<RunTimeline steps={[step(1, 'navigate', true, 'at https://example.test/', 4_230)]} live={false} />);
    expect(screen.getByTestId('step-1')).toHaveTextContent('4.2 s');
  });

  it('runs oldest first on a finished run, and remembers the viewer’s choice', () => {
    const { unmount } = render(<RunTimeline steps={united} live={false} />);
    expect(within(screen.getByRole('list', { name: 'Steps' })).getAllByRole('listitem')[0]).toHaveTextContent('1. navigate');
    fireEvent.click(screen.getByRole('button', { name: 'Newest first' }));
    expect(within(screen.getByRole('list', { name: 'Steps' })).getAllByRole('listitem')[0]).toHaveTextContent('12. text');
    unmount();
    render(<RunTimeline steps={united} live={false} />);
    expect(screen.getByRole('button', { name: 'Newest first' })).toHaveAttribute('aria-pressed', 'true');
  });
});
