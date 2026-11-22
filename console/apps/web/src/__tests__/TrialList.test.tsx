// The benchmark trial list's "Recording" link (#846): next to "Open run" when the trial run's video is ready, "Recording…" while it is
// made, nothing when it failed, was never made or the run was removed; in the table (1440 px) and the cards (360 px). The link opens
// the run page at its player (`/runs/:id#recording`).
import { fireEvent, render, screen, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation, useParams } from 'react-router-dom';
import { afterEach, describe, expect, it } from 'vitest';

import { TrialList } from '../benchmarks/TrialList';
import type { BenchmarkTrial } from '../types/benchmarks';
import { mockViewport } from './matchMedia';

const runOf = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

function trial(n: number, over: Partial<BenchmarkTrial>): BenchmarkTrial {
  return {
    id: `t${n}`,
    challengeId: 'nav-lookup',
    challengeTitle: 'Look up an order',
    category: 'navigation',
    policyRef: 'builtin:economy',
    policyLabel: 'Economy',
    trialIndex: n,
    status: 'graded',
    verdict: 'pass',
    failureReason: null,
    checks: [{ name: 'answer', pass: true }],
    claimedSuccess: true,
    runId: runOf(n),
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
    recording: null,
    ...over,
  };
}

/** One trial per state, in order: ready, processing, recording, failed, none, run removed. */
const TRIALS: BenchmarkTrial[] = [
  trial(0, { recording: { status: 'ready', durationMs: 61_000 } }),
  trial(1, { recording: { status: 'processing', durationMs: null } }),
  trial(2, { recording: { status: 'recording', durationMs: null } }),
  trial(3, { recording: { status: 'failed', durationMs: null } }),
  trial(4, { recording: null }),
  trial(5, { runId: null, recording: null }),
];

function RunPage() {
  const { id } = useParams();
  const { hash } = useLocation();
  return <p data-testid="run-page">{`run ${id} ${hash}`}</p>;
}

function mount() {
  render(
    <MemoryRouter initialEntries={['/b/1']}>
      <Routes>
        <Route path="/b/:id" element={<TrialList trials={TRIALS} />} />
        <Route path="/runs/:id" element={<RunPage />} />
      </Routes>
    </MemoryRouter>,
  );
}

let restore: (() => void) | undefined;
afterEach(() => {
  restore?.();
  restore = undefined;
});

/** Each trial's row (table) or card, in order. */
function entries(): HTMLElement[] {
  const table = screen.queryByRole('table', { name: 'Trials' });
  if (table) return within(table).getAllByRole('row').slice(1);
  return screen.getAllByRole('heading', { level: 3, name: 'Look up an order' }).map((h) => h.closest<HTMLElement>('.MuiCard-root')!);
}

describe.each([
  [1440, 'the table'],
  [360, 'the cards'],
])('the trial list at %i px (%s)', (width) => {
  it('shows each recording state next to Open run', () => {
    restore = mockViewport(width);
    mount();
    expect(screen.queryByRole('table', { name: 'Trials' }) !== null).toBe(width === 1440);
    const rows = entries();
    expect(rows).toHaveLength(TRIALS.length);
    const [ready, processing, recording, failed, none, removed] = rows as [HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement, HTMLElement];

    // Ready: a link to the run page's player, beside Open run.
    expect(within(ready).getByRole('link', { name: 'Open run' })).toHaveAttribute('href', `/runs/${runOf(0)}`);
    expect(within(ready).getByRole('link', { name: /^Recording of Look up an order, Economy, attempt 1$/ })).toHaveAttribute('href', `/runs/${runOf(0)}#recording`);
    expect(within(ready).getByRole('link', { name: /^Recording of/ })).toHaveTextContent('Recording');

    // Still being made: muted text, no link.
    for (const row of [processing, recording]) {
      expect(within(row).getByRole('link', { name: 'Open run' })).toBeInTheDocument();
      expect(within(row).getByText('Recording…')).toBeInTheDocument();
      expect(within(row).queryByRole('link', { name: /^Recording/ })).not.toBeInTheDocument();
    }

    // Failed, never recorded, run removed: nothing.
    for (const row of [failed, none, removed]) {
      expect(within(row).queryByText(/^Recording/)).not.toBeInTheDocument();
      expect(within(row).queryByRole('link', { name: /^Recording/ })).not.toBeInTheDocument();
    }
    expect(within(failed).getByRole('link', { name: 'Open run' })).toBeInTheDocument();
    expect(within(removed).getByText('run removed')).toBeInTheDocument();
  });

  it('opens the run page at its player', () => {
    restore = mockViewport(width);
    mount();
    fireEvent.click(within(entries()[0]!).getByRole('link', { name: /^Recording of/ }));
    expect(screen.getByTestId('run-page')).toHaveTextContent(`run ${runOf(0)} #recording`);
  });
});
