// "What happened" (E52.6, #1021): a run's findings on its page, warnings first, each linking to its steps.
import { fireEvent, render, screen, within } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import { RunFindingsList, stepsLabel, type RunFinding } from '../components/RunFindings';

const loop: RunFinding = { code: 'loop', severity: 'warn', title: 'Repeated the same 2 actions (click at 90,100; click at 1160,540) 12 times', detail: '58 steps, 47% of the run.', seqFrom: 53, seqTo: 110, stepsSpent: 58 };
const slow: RunFinding = { code: 'slow_start', severity: 'info', title: '66 s before the first step', detail: 'The run started, then waited before it did anything.', seqFrom: 1, seqTo: 1, stepsSpent: 0 };
const pressure: RunFinding = { code: 'budget_pressure', severity: 'warn', title: 'Used 81% of the actions budget', detail: 'The run came close to its actions limit.', seqFrom: null, seqTo: null, stepsSpent: 0 };

describe('RunFindingsList', () => {
  it('lists each finding with its severity, and a link to its steps that scrolls the timeline there', () => {
    const row = document.createElement('div');
    row.setAttribute('data-testid', 'step-53');
    row.scrollIntoView = vi.fn();
    document.body.appendChild(row);
    render(<RunFindingsList findings={[loop, pressure, slow]} />);
    const section = screen.getByRole('region', { name: 'What happened' });
    expect(within(section).getAllByText('Worth fixing')).toHaveLength(2);
    expect(within(section).getByText('Note')).toBeInTheDocument();
    expect(within(section).getByText(loop.title)).toBeInTheDocument();
    fireEvent.click(within(section).getByRole('button', { name: 'Steps 53–110' }));
    expect(row.scrollIntoView).toHaveBeenCalled();
    // Two findings name steps; the one about the whole run (a budget) has no link.
    expect(within(section).getAllByRole('button').map((b) => b.textContent)).toEqual(['Steps 53–110', 'Step 1']);
    row.remove();
  });

  it('says when a long run was only partly read', () => {
    render(<RunFindingsList findings={[loop]} truncated />);
    expect(screen.getByText(/first 2,000 steps/)).toBeInTheDocument();
  });

  it('renders nothing without findings', () => {
    const { container } = render(<RunFindingsList findings={[]} />);
    expect(container).toBeEmptyDOMElement();
  });

  it('words a step range and a single step', () => {
    expect(stepsLabel(loop)).toBe('Steps 53–110');
    expect(stepsLabel(slow)).toBe('Step 1');
    expect(stepsLabel(pressure)).toBeNull();
  });
});
