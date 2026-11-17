import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';

import { vi } from 'vitest';

import { withStreamedSteps } from '../components/runTimeline';
import { RunDetailPage } from '../pages/RunDetailPage';
import type { Run } from '../types/runs';
import type { Task } from '../types/tasks';
import { ConfirmProvider } from '../ui';

const live = vi.hoisted(() => ({ emit: null as null | ((e: unknown) => void) }));
vi.mock('../live', () => ({
  subscribeRun: (_id: string, on: (e: unknown) => void) => {
    live.emit = on;
    return () => undefined;
  },
  fetchRunScreenshot: async () => 'blob:shot',
}));

const task: Task = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Check fare',
  goal: 'Find the cheapest fare',
  profile: 'travel',
  hostId: null,
  hostFallback: true,
  allowedDomains: ['flights.example.test'],
  confirmRiskyActions: true,
  policyId: null,
};
const run: Run = {
  id: '22222222-2222-4222-8222-222222222222',
  taskId: task.id,
  status: 'waiting_human',
  trigger: 'manual',
  goal: task.goal,
  profile: 'travel',
  result: null,
  error: null,
  cancelRequested: false,
  stepCount: 1,
  createdAt: '2026-11-15T00:00:00Z',
  finishedAt: null,
  steps: [{ id: 's1', seq: 1, kind: 'action', action: 'navigate', args: { url: 'https://flights.example.test/' }, ok: true, summary: 'at https://flights.example.test/ — Flights', reasoning: 'open the site', createdAt: '2026-11-15T00:00:01Z' }],
};

// The Tasks list is covered by TasksPage.test.tsx (#426); the task form (machine picker, fallback, offline warning) by the form pages' tests (#427).

describe('RunDetailPage', () => {
  it('shows the steps and cancels a live run', async () => {
    live.emit = null;
    const host = createTestPlatformHost({
      permissions: ['runs:read', 'runs:write', 'fleet:desktop'],
      responses: {
        [`GET /runs/${run.id}`]: run,
        [`POST /runs/${run.id}/cancel`]: { ...run, cancelRequested: true },
        [`GET /runs/${run.id}/viewer`]: { hostId: '44444444-4444-4444-8444-444444444444', hostName: 'vps', desktop: true },
      },
    });
    render(
      <PlatformHostProvider host={host}>
        <ConfirmProvider>
          <MemoryRouter initialEntries={[`/runs/${run.id}`]}>
            <Routes>
              <Route path="/runs/:id" element={<RunDetailPage />} />
            </Routes>
          </MemoryRouter>
        </ConfirmProvider>
      </PlatformHostProvider>,
    );
    expect(await screen.findByText(/1\. navigate: at https:\/\/flights.example.test/)).toBeInTheDocument();
    expect(screen.getByText('needs you')).toBeInTheDocument();
    // A step arrives over the stream, and the live browser shows. Wait for
    // this page's subscription first: emitting earlier would drop the step.
    await waitFor(() => expect(live.emit).not.toBeNull());
    act(() => live.emit!({ type: 'step', data: { id: 's2', seq: 2, kind: 'action', action: 'click', args: null, ok: true, summary: 'done', reasoning: 'search', createdAt: '2026-11-15T00:00:02Z' } }));
    expect(await screen.findByText('2. click: done')).toBeInTheDocument();
    expect(await screen.findByAltText("The run's browser, live")).toHaveAttribute('src', 'blob:shot');
    expect(await screen.findByRole('button', { name: 'Take over on vps' })).toBeInTheDocument();
    expect(await screen.findByTestId('frame-age')).toHaveTextContent(/Live · updated \d+ s ago/);
    // While it runs, the page says what it is doing right now (#379).
    act(() => live.emit!({ type: 'run', data: { status: 'running', activity: { phase: 'acting', action: 'click_at', args: { x: 612, y: 340 }, reason: 'Enter the member number', startedAt: new Date().toISOString(), timeoutMs: 45_000 } } }));
    const now = await screen.findByRole('status', { name: 'Now' });
    expect(now).toHaveTextContent('Doing: click_at (612, 340)');
    expect(now).toHaveTextContent('Enter the member number');
    expect(now).toHaveTextContent(/\d+ s \/ 45 s/);
    // Where it acts is marked on the frame, once the frame's size is known (#381).
    const frame = screen.getByAltText("The run's browser, live") as HTMLImageElement;
    Object.defineProperty(frame, 'naturalWidth', { value: 1280 });
    Object.defineProperty(frame, 'naturalHeight', { value: 720 });
    fireEvent.load(frame);
    act(() => live.emit!({ type: 'run', data: { activity: { phase: 'acting', action: 'click_at', args: { x: 640, y: 360 }, target: { x: 640, y: 360 }, startedAt: new Date().toISOString(), timeoutMs: 45_000 } } }));
    expect(await screen.findByTestId('action-target')).toHaveStyle({ left: '50.000%', top: '50.000%' });
    // Thinking: nothing is marked.
    act(() => live.emit!({ type: 'run', data: { activity: { phase: 'thinking', startedAt: new Date().toISOString() } } }));
    expect(screen.queryByTestId('action-target')).not.toBeInTheDocument();
    // Stuck for a minute: the page says so.
    act(() => live.emit!({ type: 'run', data: { activity: { phase: 'acting', action: 'evaluate', startedAt: new Date(Date.now() - 60_000).toISOString(), timeoutMs: 45_000 } } }));
    expect(await screen.findByText(/waiting on the browser for 1 min/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }));
    expect(host.requests.map((r) => `${r.method} ${r.path}`)).toContain(`POST /runs/${run.id}/cancel`);
  });
});

describe('TaskSchedules', () => {
  it('lists a schedule and adds one through the editor', async () => {
    const { TaskSchedules } = await import('../pages/TaskSchedules');
    const host = createTestPlatformHost({
      permissions: ['tasks:read', 'tasks:write'],
      responses: {
        [`GET /schedules?taskId=${task.id}`]: [
          { id: 'sc1', taskId: task.id, cron: '0 9 * * 1-5', timezone: 'Europe/Madrid', enabled: true, concurrency: 'skip', nextRunAt: '2026-11-16T08:00:00Z', lastRunAt: null, consecutiveFailures: 0, description: 'Monday to Friday at 09:00' },
        ],
        'POST /schedules/preview': { valid: true, cron: '30 7 * * *', timezone: 'UTC', description: 'Every day at 07:30', next: [], intervalSeconds: 86400 },
        'POST /schedules': { id: 'sc2' },
      },
    });
    render(
      <PlatformHostProvider host={host}>
        <ConfirmProvider>
          <TaskSchedules taskId={task.id} canWrite />
        </ConfirmProvider>
      </PlatformHostProvider>,
    );
    expect(await screen.findByText(/Monday to Friday at 09:00/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add schedule' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add schedule' });
    fireEvent.change(within(dialog).getByLabelText('Time'), { target: { value: '07:30' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add schedule' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    const post = host.requests.find((r) => r.method === 'POST' && r.path === '/schedules');
    expect(post?.body).toMatchObject({ taskId: task.id, cron: '30 7 * * *', enabled: true, concurrency: 'skip', policyId: null });
  });
});

describe('withStreamedSteps', () => {
  const base = { id: 'r1', stepCount: 1, steps: [{ seq: 1 }] } as unknown as Run;
  it('keeps steps the stream delivered before a slower load finished', () => {
    const prev = { ...base, stepCount: 2, steps: [{ seq: 1 }, { seq: 2 }] } as unknown as Run;
    const merged = withStreamedSteps(base, prev);
    expect(merged.steps?.map((st) => st.seq)).toEqual([1, 2]);
    expect(merged.stepCount).toBe(2);
  });
  it('uses the fetched run alone when nothing is missing or it is another run', () => {
    expect(withStreamedSteps(base, null)).toBe(base);
    expect(withStreamedSteps(base, { ...base, id: 'r2', steps: [{ seq: 9 }] } as unknown as Run)).toBe(base);
  });
});
