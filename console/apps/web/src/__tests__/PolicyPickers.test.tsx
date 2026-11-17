// The policy pickers on tasks, schedules and runs (#407): the task form sends
// `policyId` (never the earlier step, minute and model fields), the task card
// shows its policy and start model, "Run with..." posts the chosen policy, and
// a schedule takes a policy override.
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestApiError, createTestPlatformHost, type TestApiRequest } from '@marinoscar/platform-web/testing';

import { TaskSchedules } from '../pages/TaskSchedules';
import { TasksPage } from '../pages/TasksPage';
import type { Task } from '../types/tasks';
import { ConfirmProvider } from '../ui';
import { OWN_ID, POLICIES, POLICY_READS } from './policyFixtures';

const TASK: Task = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Check fare',
  goal: 'Find the cheapest fare',
  profile: 'travel',
  hostId: null,
  hostFallback: true,
  allowedDomains: ['flights.example.test'],
  confirmRiskyActions: false,
  policyId: null,
};
const PINNED: Task = { ...TASK, id: '22222222-2222-4222-8222-222222222222', name: 'Weekly order', goal: 'Order the groceries', policyId: OWN_ID };
const RUN_ID = '33333333-3333-4333-8333-333333333333';

const PERMS = ['tasks:read', 'tasks:write', 'runs:write', 'agent_policies:read'];

// Full pages with MUI pickers: slow under a loaded parallel run, never hanging.
vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

function renderTasks(responses: Record<string, unknown>, permissions = PERMS) {
  const host = createTestPlatformHost({
    permissions,
    responses: {
      ...POLICY_READS,
      'GET /tasks': [TASK, PINNED],
      [`GET /schedules?taskId=${TASK.id}`]: [],
      [`GET /schedules?taskId=${PINNED.id}`]: [],
      ...responses,
    },
  });
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={['/tasks']}>
          <Routes>
            <Route path="/tasks" element={<TasksPage />} />
            <Route path="/runs/:id" element={<div>run page</div>} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  return host;
}

describe('the task form', () => {
  it('sends policyId and never maxSteps, maxMinutes or model', async () => {
    const host = renderTasks({ 'POST /tasks': { ...TASK, id: '44444444-4444-4444-8444-444444444444' } });
    fireEvent.change(await screen.findByLabelText(/^Name/), { target: { value: 'Miles' } });
    fireEvent.change(screen.getByLabelText(/^Goal/), { target: { value: 'Check my miles' } });
    const form = screen.getByRole('form', { name: 'New task' });
    // The summary of the default policy shows under the picker, with a way to manage policies.
    await waitFor(() => expect(within(form).getByRole('combobox', { name: 'Policy' })).toHaveTextContent('Default (Balanced)'));
    expect(within(form).getByText(/Standard → Frontier · 60 actions · \$2 · 20 min/)).toBeInTheDocument();
    expect(within(form).getByRole('link', { name: 'Manage policies' })).toHaveAttribute('href', '/settings/agent-policies');
    fireEvent.mouseDown(within(form).getByRole('combobox', { name: 'Policy' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Thorough' }));
    expect(within(form).getByText(/Frontier · 200 actions · \$10 · 60 min/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(host.requests.some((r) => r.method === 'POST' && r.path === '/tasks')).toBe(true));
    const body = host.requests.find((r) => r.method === 'POST' && r.path === '/tasks')!.body as Record<string, unknown>;
    expect(body.policyId).toBe('builtin:thorough');
    for (const legacy of ['maxSteps', 'maxMinutes', 'model']) expect(body).not.toHaveProperty(legacy);
  });

  it('sends policyId null for "Default" and keeps the task\'s policy when editing', async () => {
    const host = renderTasks({ 'POST /tasks': TASK, [`PATCH /tasks/${PINNED.id}`]: PINNED });
    const card = await screen.findByLabelText('Task Weekly order');
    fireEvent.click(within(card).getByRole('button', { name: 'Edit' }));
    const form = screen.getByRole('form', { name: 'Edit task' });
    expect(within(form).getByRole('combobox', { name: 'Policy' })).toHaveTextContent('Careful shopping');
    fireEvent.click(within(form).getByRole('button', { name: 'Save task' }));
    await waitFor(() => expect(host.requests.some((r) => r.method === 'PATCH')).toBe(true));
    const body = host.requests.find((r) => r.method === 'PATCH')!.body as Record<string, unknown>;
    expect(body.policyId).toBe(OWN_ID);
    for (const legacy of ['maxSteps', 'maxMinutes', 'model']) expect(body).not.toHaveProperty(legacy);
  });

  it('has no policy picker for someone who cannot read policies, and sends no policyId', async () => {
    const host = renderTasks({ 'POST /tasks': TASK }, ['tasks:read', 'tasks:write']);
    fireEvent.change(await screen.findByLabelText(/^Name/), { target: { value: 'Miles' } });
    fireEvent.change(screen.getByLabelText(/^Goal/), { target: { value: 'Check my miles' } });
    expect(screen.queryByRole('combobox', { name: 'Policy' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Create task' }));
    await waitFor(() => expect(host.requests.some((r) => r.method === 'POST' && r.path === '/tasks')).toBe(true));
    expect(host.requests.find((r) => r.method === 'POST' && r.path === '/tasks')!.body).not.toHaveProperty('policyId');
  });
});

describe('the task card', () => {
  it('shows the policy and the model its start tier uses', async () => {
    renderTasks({});
    const plain = await screen.findByLabelText('Task Check fare');
    // Follows the default (Balanced: starts on Standard, the deployment's model).
    await waitFor(() => expect(within(plain).getByText('policy: Balanced (default)')).toBeInTheDocument());
    await waitFor(() => expect(within(plain).getByText('model: provider-a:model-std')).toBeInTheDocument());
    // Its own policy pins the Frontier tier it starts on.
    const pinned = screen.getByLabelText('Task Weekly order');
    expect(within(pinned).getByText('policy: Careful shopping')).toBeInTheDocument();
    expect(within(pinned).getByText('model: provider-a:model-big')).toBeInTheDocument();
    // The earlier steps and minutes chip is gone.
    expect(screen.queryByText(/steps ·/)).not.toBeInTheDocument();
  });
});

describe('Run with…', () => {
  it('posts the chosen policyId for this run only', async () => {
    const host = renderTasks({ [`POST /tasks/${TASK.id}/runs`]: { id: RUN_ID } });
    const card = await screen.findByLabelText('Task Check fare');
    await waitFor(() => expect(within(card).getByRole('button', { name: 'Run with…' })).toBeInTheDocument());
    fireEvent.click(within(card).getByRole('button', { name: 'Run with…' }));
    const menu = await screen.findByRole('menu');
    // The task's usual policy is marked.
    expect(within(menu).getByText('Balanced (usual)')).toBeInTheDocument();
    fireEvent.click(within(menu).getByText('Unlimited'));
    expect(await screen.findByText('run page')).toBeInTheDocument();
    const post = host.requests.find((r: TestApiRequest) => r.method === 'POST' && r.path === `/tasks/${TASK.id}/runs`);
    expect(post?.body).toEqual({ policyId: 'builtin:unlimited' });
  });

  it('"Run now" sends no policy, so the run follows the schedule, task and default', async () => {
    const host = renderTasks({ [`POST /tasks/${TASK.id}/runs`]: { id: RUN_ID } });
    const card = await screen.findByLabelText('Task Check fare');
    fireEvent.click(within(card).getByRole('button', { name: 'Run now' }));
    expect(await screen.findByText('run page')).toBeInTheDocument();
    expect(host.requests.find((r) => r.method === 'POST' && r.path === `/tasks/${TASK.id}/runs`)?.body).toEqual({});
  });
});

describe('the schedule policy override', () => {
  const catalog = { policies: POLICIES, defaultId: 'builtin:balanced', byId: (id: string | null | undefined) => POLICIES.find((p) => p.id === id) };
  const SAVED = { id: 'sc1', taskId: TASK.id, cron: '0 9 * * 1-5', timezone: 'Europe/Madrid', enabled: true, concurrency: 'skip', nextRunAt: null, lastRunAt: null, consecutiveFailures: 0, description: 'Monday to Friday at 09:00', policyId: 'builtin:economy' };

  function renderSchedules(taskPolicyId: string | null = null) {
    const host = createTestPlatformHost({
      permissions: ['tasks:read', 'tasks:write'],
      responses: {
        [`GET /schedules?taskId=${TASK.id}`]: [SAVED],
        'POST /schedules/preview': (r: TestApiRequest) => ({ valid: true, ...(r.body as object), description: 'A schedule', next: [], intervalSeconds: null }),
        'POST /schedules': { id: 'sc2' },
        'PATCH /schedules/sc1': SAVED,
      },
    });
    render(
      <PlatformHostProvider host={host}>
        <ConfirmProvider>
          <MemoryRouter>
            <TaskSchedules taskId={TASK.id} canWrite catalog={catalog} taskPolicyId={taskPolicyId} />
          </MemoryRouter>
        </ConfirmProvider>
      </PlatformHostProvider>,
    );
    return host;
  }
  const choose = async (dialog: HTMLElement, option: string | RegExp) => {
    fireEvent.mouseDown(within(dialog).getByRole('combobox', { name: 'Policy override' }));
    fireEvent.click(await screen.findByRole('option', { name: option }));
  };
  const closed = () => waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());

  it('adds a schedule with another policy and shows the override on the schedule', async () => {
    const host = renderSchedules();
    // The saved schedule names its override.
    expect(await screen.findByText(/Monday to Friday at 09:00 · Europe\/Madrid · policy: Economy/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add schedule' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add schedule' });
    expect(within(dialog).getByRole('combobox', { name: 'Policy override' })).toHaveTextContent("Task's policy (Balanced)");
    fireEvent.change(within(dialog).getByLabelText('Time'), { target: { value: '07:30' } });
    await choose(dialog, 'Careful shopping');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add schedule' }));
    await closed();
    expect(host.requests.find((r) => r.method === 'POST' && r.path === '/schedules')?.body).toMatchObject({ taskId: TASK.id, cron: '30 7 * * *', policyId: OWN_ID });
  });

  it("edits a schedule: its expression, and its policy override changed, then cleared (the PATCH body)", async () => {
    const host = renderSchedules(OWN_ID);
    const row = await screen.findByRole('group', { name: 'Schedule Monday to Friday at 09:00' });
    const patches = () => host.requests.filter((r) => r.method === 'PATCH' && r.path === '/schedules/sc1').map((r) => r.body);

    fireEvent.click(within(row).getByRole('button', { name: 'Edit' }));
    let dialog = await screen.findByRole('dialog', { name: 'Edit schedule' });
    // The editor opens on the saved schedule: Weekly, its policy, and the task's policy named.
    expect(within(dialog).getByRole('button', { name: 'Weekly' })).toHaveAttribute('aria-pressed', 'true');
    expect(within(dialog).getByRole('combobox', { name: 'Policy override' })).toHaveTextContent('Economy');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Saturday' }));
    await choose(dialog, 'Thorough');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save schedule' }));
    await closed();
    expect(patches()).toEqual([{ cron: '0 9 * * 1-6', timezone: 'Europe/Madrid', enabled: true, concurrency: 'skip', policyId: 'builtin:thorough' }]);
    expect(host.requests.some((r) => r.method === 'POST' && r.path === '/schedules')).toBe(false);

    fireEvent.click(within(screen.getByRole('group', { name: 'Schedule Monday to Friday at 09:00' })).getByRole('button', { name: 'Edit' }));
    dialog = await screen.findByRole('dialog', { name: 'Edit schedule' });
    await choose(dialog, "Task's policy (Careful shopping)");
    fireEvent.click(within(dialog).getByRole('button', { name: 'Save schedule' }));
    await closed();
    expect(patches()[1]).toEqual({ cron: '0 9 * * 1-5', timezone: 'Europe/Madrid', enabled: true, concurrency: 'skip', policyId: null });
  });

  it('a save the server refuses stays in the dialog with its message; Cancel changes nothing', async () => {
    const host = createTestPlatformHost({
      permissions: ['tasks:read', 'tasks:write'],
      responses: {
        [`GET /schedules?taskId=${TASK.id}`]: [],
        'POST /schedules/preview': { valid: true, cron: '0 9 * * *', timezone: 'UTC', description: 'Every day at 09:00', next: [], intervalSeconds: 86400 },
        'POST /schedules': () => {
          throw createTestApiError(409, 'A task can have up to 10 schedules');
        },
      },
    });
    render(
      <PlatformHostProvider host={host}>
        <ConfirmProvider>
          <MemoryRouter>
            <TaskSchedules taskId={TASK.id} canWrite />
          </MemoryRouter>
        </ConfirmProvider>
      </PlatformHostProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Add schedule' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add schedule' });
    // Without a catalog there is no policy control.
    expect(within(dialog).queryByRole('combobox', { name: 'Policy override' })).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Add schedule' }));
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('A task can have up to 10 schedules');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await closed();
  });
});
