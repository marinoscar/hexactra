// The policy pickers on schedules (#407): a schedule takes a policy override.
// The task form's picker is tested with the form pages (#427); the list's
// policy and start model, and "Run with...", in TasksPage.test.tsx (#426).
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestApiError, createTestPlatformHost, type TestApiRequest } from '@marinoscar/platform-web/testing';

import { TaskSchedules } from '../pages/TaskSchedules';
import type { Task } from '../types/tasks';
import { ConfirmProvider } from '../ui';
import { OWN_ID, POLICIES } from './policyFixtures';

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

// Full pages with MUI pickers: slow under a loaded parallel run, never hanging.
vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

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
