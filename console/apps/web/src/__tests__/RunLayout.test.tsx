// The run page's layout by width (#431): two panes at lg and up while the run
// is live, one column below, a sticky action bar below md, and the result in
// the frame's place once the run finished. Everything #408 put on the page
// (chips, budget meter, stop reason) stays in each of them.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { ConfirmProvider } from '../ui';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../live', () => ({
  subscribeRun: () => () => undefined,
  // Any blob URL will do: the test fires the image's load event itself.
  fetchRunScreenshot: async () => 'blob:frame',
}));

import { ActionOverlay } from '../components/RunActivity';
import { mostUsedRow, RunBudgetMeter } from '../components/RunBudgetMeter';
import { RunTimeline, type RunTimelineStep } from '../components/RunTimeline';
import { meterRows, type RunBudget } from '../components/runBudget';
import { RunDetailPage } from '../pages/RunDetailPage';
import type { Run } from '../types/runs';
import { mockViewport } from './matchMedia';

const RUN_ID = '22222222-2222-4222-8222-222222222222';
const HOST_ID = '33333333-3333-4333-8333-333333333333';

const budget: RunBudget = {
  effective: { actions: 60, modelCalls: 120, activeMinutes: 20, inputTokens: null, outputTokens: null, cost: 2, warnAtPercent: 80 },
  used: { actions: 6, modelCalls: 12, activeMinutes: 1, inputTokens: 12_000, outputTokens: 800, cost: 1.5 },
  percent: { actions: 10, modelCalls: 10, activeMinutes: 5, inputTokens: null, outputTokens: null, cost: 75 },
  source: { actions: 'policy', modelCalls: 'policy', activeMinutes: 'ceiling', inputTokens: null, outputTokens: null, cost: 'policy' },
  costKnown: true,
};

const liveRun: Run = {
  id: RUN_ID,
  taskId: '11111111-1111-4111-8111-111111111111',
  status: 'running',
  trigger: 'manual',
  goal: 'Find the cheapest fare',
  profile: 'travel',
  result: null,
  error: null,
  cancelRequested: false,
  stepCount: 2,
  createdAt: '2026-11-15T00:00:00Z',
  finishedAt: null,
  steps: [{ id: 's1', seq: 1, kind: 'action', action: 'click', ok: true, summary: 'Opened the fares page', args: null, reasoning: null, durationMs: 900 }] as Run['steps'],
  costUsd: 1.5,
  costKnown: true,
  modelCalls: 12,
  policy: { id: 'builtin:balanced', name: 'Balanced', version: 1, source: 'user_default', builtin: true },
  tier: { start: 'standard', max: 'frontier', current: 'standard', escalations: 0, model: 'prov-a:model-mid' },
  budget,
  stopReason: null,
  activity: { phase: 'acting', action: 'click_at', args: { x: 640, y: 180 }, startedAt: new Date().toISOString(), target: { x: 640, y: 180 } },
};

function renderRun(run: Run, permissions = ['runs:read', 'runs:write', 'fleet:desktop']) {
  const host = createTestPlatformHost({
    permissions,
    responses: {
      [`GET /runs/${run.id}`]: run,
      [`GET /runs/${run.id}/viewer`]: { hostId: HOST_ID, hostName: 'mini-pc', desktop: true },
      [`POST /runs/${run.id}/cancel`]: {},
    },
  });
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[`/runs/${run.id}`]}>
          <Routes>
            <Route path="/runs/:id" element={<RunDetailPage />} />
            <Route path="/fleet/hosts/:id/desktop" element={<p>Desktop page</p>} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  return host;
}

/** True when `a` comes before `b` in the document. */
const before = (a: Element, b: Element) => Boolean(a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING);

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

describe('run page at lg and up (live)', () => {
  it('is two panes: the frame sticky on the left; chips, activity, budget and the scrolling timeline on the right', async () => {
    restore = mockViewport(1440);
    renderRun(liveRun);
    const panes = await screen.findByTestId('run-panes');
    const left = within(panes).getByTestId('run-frame-pane');
    const right = within(panes).getByTestId('run-side-pane');
    expect(left).toHaveStyle({ position: 'sticky' });
    expect(right).toHaveStyle({ position: 'sticky' });
    // Left: the actions and the live frame.
    expect(within(left).getByRole('button', { name: 'Cancel run' })).toBeInTheDocument();
    expect(await within(left).findByAltText("The run's browser, live")).toBeInTheDocument();
    expect(within(left).getByTestId('frame-age')).toBeInTheDocument();
    // Right, in order: policy chips, activity bar, budget meter, then the timeline.
    const chips = within(right).getByLabelText('Run policy');
    const activity = within(right).getByRole('status', { name: 'Now' });
    const meter = within(right).getByRole('group', { name: 'Budget' });
    const scroll = within(right).getByTestId('run-timeline-scroll');
    expect(before(chips, activity) && before(activity, meter) && before(meter, scroll)).toBe(true);
    // The meter is above the scrolling region, not inside it, so it stays visible while the steps scroll.
    expect(scroll).not.toContainElement(meter);
    expect(scroll).toHaveStyle({ overflowY: 'auto' });
    expect(within(scroll).getByRole('list', { name: 'Steps' })).toBeInTheDocument();
    // Every budget bar shows: nothing is collapsed on a wide screen.
    expect(within(meter).getAllByTestId(/^budget-/)).toHaveLength(6);
    // No sticky bar: the buttons are in the left pane.
    expect(screen.queryByRole('toolbar', { name: 'Run actions' })).not.toBeInTheDocument();
  });

  it('a finished run has no frame pane: the stop reason takes its place and the timeline the full width', async () => {
    restore = mockViewport(1440);
    renderRun({ ...liveRun, status: 'failed', stopReason: 'budget_cost', result: 'Compared 3 of 5 fares.', error: 'Cost budget exhausted', activity: null });
    expect(await screen.findByTestId('stop-reason')).toHaveTextContent('Stopped: cost budget reached');
    expect(screen.queryByTestId('run-panes')).not.toBeInTheDocument();
    expect(screen.queryByAltText("The run's browser, live")).not.toBeInTheDocument();
    expect(screen.getByRole('group', { name: 'Budget' })).toBeInTheDocument();
    expect(screen.getByTestId('policy-chip')).toBeInTheDocument();
    expect(screen.getByRole('list', { name: 'Steps' })).toBeInTheDocument();
  });
});

describe('run page at md (live)', () => {
  it('is one column with the buttons in the page and the frame capped at 60% of the window height', async () => {
    restore = mockViewport(1024);
    renderRun(liveRun);
    const frame = await screen.findByAltText("The run's browser, live");
    expect(screen.queryByTestId('run-panes')).not.toBeInTheDocument();
    expect(screen.queryByRole('toolbar', { name: 'Run actions' })).not.toBeInTheDocument();
    expect(await screen.findByRole('button', { name: 'Take over on mini-pc' })).toBeInTheDocument();
    expect(frame).toHaveStyle({ maxHeight: '60vh' });
  });
});

describe('run page below md (live)', () => {
  it('stacks status, activity, budget, frame, timeline and keeps the actions in a sticky bar', async () => {
    restore = mockViewport(390);
    const host = renderRun(liveRun);
    const bar = await screen.findByRole('toolbar', { name: 'Run actions' });
    expect(bar).toHaveStyle({ position: 'sticky' });
    // Take over appears once the run's viewer is known.
    await within(bar).findByRole('button', { name: 'Take over on mini-pc' });
    expect(within(bar).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Cancel run', 'Stop watching', 'Take over on mini-pc']);
    const activity = screen.getByRole('status', { name: 'Now' });
    const meter = screen.getByRole('group', { name: 'Budget' });
    const browser = screen.getByRole('heading', { name: 'Browser' });
    const steps = screen.getByRole('list', { name: 'Steps' });
    expect(before(screen.getByLabelText('Run policy'), activity) && before(activity, meter) && before(meter, browser) && before(browser, steps) && before(steps, bar)).toBe(true);
    fireEvent.click(within(bar).getByRole('button', { name: 'Cancel run' }));
    await waitFor(() => expect(host.requests.some((r) => r.method === 'POST' && r.path === `/runs/${RUN_ID}/cancel`)).toBe(true));
    fireEvent.click(within(bar).getByRole('button', { name: 'Take over on mini-pc' }));
    expect(await screen.findByText('Desktop page')).toBeInTheDocument();
  });

  it('collapses the budget to its most-used bar and expands to all of them', async () => {
    restore = mockViewport(390);
    renderRun(liveRun);
    const meter = await screen.findByRole('group', { name: 'Budget' });
    expect(within(meter).getAllByTestId(/^budget-/).map((e) => e.dataset.testid)).toEqual(['budget-cost']);
    fireEvent.click(within(meter).getByRole('button', { name: 'Show all 6' }));
    expect(within(meter).getAllByTestId(/^budget-/)).toHaveLength(6);
    fireEvent.click(within(meter).getByRole('button', { name: 'Show less' }));
    expect(within(meter).getAllByTestId(/^budget-/)).toHaveLength(1);
  });

  it('the frame is open while live and collapses; collapsing it stops watching', async () => {
    restore = mockViewport(390);
    renderRun(liveRun);
    expect(await screen.findByAltText("The run's browser, live")).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Hide the browser' }));
    await waitFor(() => expect(screen.queryByAltText("The run's browser, live")).not.toBeInTheDocument());
    expect(screen.getByRole('button', { name: 'Watch the browser' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Show the browser' })).toHaveAttribute('aria-expanded', 'false');
  });

  it('a reader without runs:write or fleet:desktop gets only Watch', async () => {
    restore = mockViewport(390);
    renderRun(liveRun, ['runs:read']);
    const bar = await screen.findByRole('toolbar', { name: 'Run actions' });
    expect(within(bar).getAllByRole('button').map((b) => b.getAttribute('aria-label'))).toEqual(['Stop watching']);
  });
});

describe('where the agent acts, in a narrower pane', () => {
  it('the page wraps the frame in a box that is exactly the rendered image, and the marker is placed in percent of it', async () => {
    restore = mockViewport(1440);
    renderRun(liveRun);
    const img = (await screen.findByAltText("The run's browser, live")) as HTMLImageElement;
    Object.defineProperty(img, 'naturalWidth', { value: 1280 });
    Object.defineProperty(img, 'naturalHeight', { value: 720 });
    fireEvent.load(img);
    const wrapper = screen.getByTestId('frame');
    // Shrink-wrapped and positioned: the overlay's containing block is the image's own box at any pane width.
    expect(wrapper).toHaveStyle({ position: 'relative', display: 'inline-block' });
    expect(img.parentElement).toBe(wrapper);
    const marker = await screen.findByRole('img', { name: 'The agent acts here: click_at' });
    expect(marker.parentElement).toBe(wrapper);
    expect(marker).toHaveStyle({ left: '50.000%', top: '25.000%' });
  });

  it.each([[820], [560], [312]])('a frame rendered %i px wide marks the same point of the page', (rendered) => {
    // 1280 x 720 natural, shown `rendered` px wide: the marker's pixel position scales with the box.
    render(
      <div style={{ position: 'relative', width: rendered, height: (rendered * 720) / 1280 }}>
        <ActionOverlay activity={{ phase: 'acting', action: 'click_at', startedAt: '2026-11-15T00:00:00Z', target: { x: 320, y: 540 } }} natural={{ width: 1280, height: 720 }} />
      </div>,
    );
    const marker = screen.getByTestId('action-target');
    const left = (parseFloat(getComputedStyle(marker).left) / 100) * rendered;
    const top = (parseFloat(getComputedStyle(marker).top) / 100) * ((rendered * 720) / 1280);
    expect(left).toBeCloseTo((320 / 1280) * rendered, 3);
    expect(top).toBeCloseTo((540 / 720) * ((rendered * 720) / 1280), 3);
  });
});

describe('the pieces in a narrow pane', () => {
  it('the most-used budget is the one closest to its limit; the first when none is limited', () => {
    expect(mostUsedRow(meterRows(budget))?.key).toBe('cost');
    const unlimited: RunBudget = { ...budget, effective: { ...budget.effective, actions: null, modelCalls: null, activeMinutes: null, cost: null } };
    expect(mostUsedRow(meterRows(unlimited))?.key).toBe('actions');
  });

  it('a meter that is not collapsible shows every bar and no toggle', () => {
    render(<RunBudgetMeter budget={budget} ticking={false} now={0} maxColumns={2} />);
    expect(screen.getAllByTestId(/^budget-/)).toHaveLength(6);
    expect(screen.queryByRole('button')).not.toBeInTheDocument();
  });

  it('routing rows wrap instead of clipping, and keep their arrow', () => {
    const routing: RunTimelineStep = { id: 'r2', seq: 2, kind: 'routing', action: null, ok: true, summary: '', args: { from: 'standard', to: 'frontier', reason: 'stuck on a repeated click at the same place for a very long time' }, reasoning: null };
    render(
      <div style={{ width: 280 }}>
        <RunTimeline steps={[routing]} live />
      </div>,
    );
    const row = screen.getByTestId('routing-2');
    expect(row).toHaveTextContent('↑ Frontier');
    expect(row.querySelector('svg')).not.toBeNull();
    // The text may break anywhere; nothing sets nowrap on it.
    const text = within(row).getByText(/Frontier/);
    expect(getComputedStyle(text).whiteSpace).not.toBe('nowrap');
    expect(text).toHaveStyle({ overflowWrap: 'anywhere' });
  });
});
