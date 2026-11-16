import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';

import { vi } from 'vitest';

import { RunDetailPage, withStreamedSteps, type Run } from '../pages/RunsPage';

const live = vi.hoisted(() => ({ emit: null as null | ((e: unknown) => void) }));
vi.mock('../live', () => ({
  subscribeRun: (_id: string, on: (e: unknown) => void) => {
    live.emit = on;
    return () => undefined;
  },
  fetchRunScreenshot: async () => 'blob:shot',
}));
import { TasksPage, type Task } from '../pages/TasksPage';

const task: Task = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Check fare',
  goal: 'Find the cheapest fare',
  profile: 'travel',
  hostId: null,
  allowedDomains: ['flights.example.test'],
  maxSteps: 40,
  maxMinutes: 15,
  confirmRiskyActions: true,
  model: null,
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

describe('TasksPage', () => {
  it('lists tasks and starts a run', async () => {
    const host = createTestPlatformHost({
      permissions: ['tasks:read', 'tasks:write', 'runs:write'],
      responses: { 'GET /tasks': [task], [`POST /tasks/${task.id}/runs`]: { id: run.id }, [`GET /schedules?taskId=${task.id}`]: [] },
    });
    render(
      <PlatformHostProvider host={host}>
        <MemoryRouter initialEntries={['/tasks']}>
          <Routes>
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/runs/:id" element={<div>run page</div>} />
          </Routes>
        </MemoryRouter>
      </PlatformHostProvider>,
    );
    expect(await screen.findByText('Find the cheapest fare')).toBeInTheDocument();
    expect(screen.getByText('flights.example.test')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    expect(await screen.findByText('run page')).toBeInTheDocument();
  });

  it('hides creating and running from a reader', async () => {
    const host = createTestPlatformHost({ permissions: ['tasks:read'], responses: { 'GET /tasks': [task], [`GET /schedules?taskId=${task.id}`]: [] } });
    render(
      <PlatformHostProvider host={host}>
        <MemoryRouter>
          <TasksPage />
        </MemoryRouter>
      </PlatformHostProvider>,
    );
    expect(await screen.findByText('Check fare')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run now' })).not.toBeInTheDocument();
    expect(screen.queryByRole('form', { name: 'New task' })).not.toBeInTheDocument();
  });
});

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
        <MemoryRouter initialEntries={[`/runs/${run.id}`]}>
          <Routes>
            <Route path="/runs/:id" element={<RunDetailPage />} />
          </Routes>
        </MemoryRouter>
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
    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }));
    expect(host.requests.map((r) => `${r.method} ${r.path}`)).toContain(`POST /runs/${run.id}/cancel`);
  });
});

describe('TaskSchedules', () => {
  it('lists a schedule and adds one', async () => {
    const { TaskSchedules } = await import('../pages/TaskSchedules');
    const host = createTestPlatformHost({
      permissions: ['tasks:read', 'tasks:write'],
      responses: {
        [`GET /schedules?taskId=${task.id}`]: [{ id: 'sc1', taskId: task.id, cron: '0 9 * * 1-5', timezone: 'Europe/Madrid', enabled: true, concurrency: 'skip', nextRunAt: '2026-11-16T08:00:00Z', lastRunAt: null, consecutiveFailures: 0 }],
        'POST /schedules': { id: 'sc2' },
      },
    });
    render(
      <PlatformHostProvider host={host}>
        <TaskSchedules taskId={task.id} canWrite />
      </PlatformHostProvider>,
    );
    expect(await screen.findByText('0 9 * * 1-5 (Europe/Madrid)')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Cron'), { target: { value: '30 7 * * *' } });
    fireEvent.click(screen.getByRole('button', { name: 'Add schedule' }));
    await screen.findByText('0 9 * * 1-5 (Europe/Madrid)');
    expect(host.requests.find((r) => r.method === 'POST')?.body).toMatchObject({ taskId: task.id, cron: '30 7 * * *' });
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
