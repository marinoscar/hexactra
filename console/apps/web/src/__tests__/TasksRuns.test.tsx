import { fireEvent, render, screen } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';

import { RunDetailPage, type Run } from '../pages/RunsPage';
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
      responses: { 'GET /tasks': [task], [`POST /tasks/${task.id}/runs`]: { id: run.id } },
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
    const host = createTestPlatformHost({ permissions: ['tasks:read'], responses: { 'GET /tasks': [task] } });
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
    const host = createTestPlatformHost({
      permissions: ['runs:read', 'runs:write'],
      responses: { [`GET /runs/${run.id}`]: run, [`POST /runs/${run.id}/cancel`]: { ...run, cancelRequested: true } },
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
    fireEvent.click(screen.getByRole('button', { name: 'Cancel run' }));
    expect(host.requests.map((r) => `${r.method} ${r.path}`)).toContain(`POST /runs/${run.id}/cancel`);
  });
});
