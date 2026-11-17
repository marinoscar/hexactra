// Every destructive action asks through the kit's confirm dialog (#419):
// deleting a task, a schedule and a profile, and revoking a host. Cancel
// changes nothing; confirming sends the request.
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';
import { MemoryRouter } from 'react-router-dom';
import type { ReactElement } from 'react';

import { FleetPage } from '../pages/FleetPage';
import { TaskSchedules } from '../pages/TaskSchedules';
import { TasksPage } from '../pages/TasksPage';
import type { FleetHost } from '../types/fleet';
import type { Task, TaskSchedule } from '../types/tasks';
import { ConfirmProvider } from '../ui';

const TASK: Task = {
  id: '11111111-1111-4111-8111-111111111111',
  name: 'Check fare',
  goal: 'Find the cheapest fare',
  profile: 'travel',
  hostId: null,
  hostFallback: true,
  allowedDomains: [],
  confirmRiskyActions: false,
  policyId: null,
};
const SCHEDULE: TaskSchedule = { id: 'sc1', taskId: TASK.id, cron: '0 9 * * 1-5', timezone: 'Europe/Madrid', enabled: true, concurrency: 'skip', nextRunAt: '2026-11-18T08:00:00Z', lastRunAt: null, consecutiveFailures: 0, description: 'Monday to Friday at 09:00' };
const HOST: FleetHost = {
  id: '22222222-2222-4222-8222-222222222222',
  name: 'mini-pc',
  version: '0.1.0',
  online: true,
  browserConnected: true,
  onDemand: true,
  draining: false,
  viewerUrl: null,
  mode: 'unattended',
  desktop: true,
  profiles: [
    { name: 'default', running: false },
    { name: 'travel', running: true },
  ],
  lastSeen: '2026-11-17T00:00:00Z',
};

function mount(page: ReactElement, permissions: string[], responses: Record<string, unknown>) {
  const host = createTestPlatformHost({ permissions, responses });
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter>{page}</MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  const deletes = () => host.requests.filter((r) => r.method === 'DELETE').map((r) => r.path);
  return { host, deletes };
}

/** Opens the dialog with `open`, cancels it, opens it again and confirms with `confirmLabel`. */
async function cancelThenConfirm(open: () => void, confirmLabel: string, deletes: () => string[], expected: string, text: RegExp) {
  open();
  let dialog = await screen.findByRole('dialog');
  expect(dialog).toHaveTextContent(text);
  // Destructive: the confirm button is the error colour and focus starts on Cancel.
  expect(within(dialog).getByRole('button', { name: confirmLabel }).className).toMatch(/colorError/);
  fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  expect(deletes()).toEqual([]);

  open();
  dialog = await screen.findByRole('dialog');
  fireEvent.click(within(dialog).getByRole('button', { name: confirmLabel }));
  await waitFor(() => expect(deletes()).toEqual([expected]));
}

describe('destructive actions ask first', () => {
  it('deleting a task', async () => {
    const { deletes } = mount(<TasksPage />, ['tasks:read', 'tasks:write'], {
      'GET /tasks': [TASK],
      [`GET /schedules?taskId=${TASK.id}`]: [],
      [`DELETE /tasks/${TASK.id}`]: {},
    });
    const card = await screen.findByLabelText('Task Check fare');
    await cancelThenConfirm(
      () => fireEvent.click(within(card).getByRole('button', { name: 'Delete' })),
      'Delete',
      deletes,
      `/tasks/${TASK.id}`,
      /Delete task “Check fare”\?.*Its schedules are deleted\. Its runs are kept\./,
    );
  });

  it('deleting a schedule', async () => {
    const { deletes } = mount(<TaskSchedules taskId={TASK.id} canWrite />, ['tasks:read', 'tasks:write'], {
      [`GET /schedules?taskId=${TASK.id}`]: [SCHEDULE],
      'DELETE /schedules/sc1': {},
    });
    await screen.findByText(/Monday to Friday at 09:00/);
    await cancelThenConfirm(() => fireEvent.click(screen.getByRole('button', { name: 'Delete' })), 'Delete', deletes, '/schedules/sc1', /Delete this schedule\?/);
  });

  it('deleting a profile', async () => {
    const { deletes } = mount(<FleetPage />, ['fleet:read', 'fleet:write'], {
      'GET /fleet/hosts': [HOST],
      [`DELETE /fleet/hosts/${HOST.id}/profiles/travel`]: {},
    });
    await screen.findByLabelText('Host mini-pc');
    await cancelThenConfirm(
      () => fireEvent.click(screen.getByRole('button', { name: 'Delete travel on mini-pc' })),
      'Delete',
      deletes,
      `/fleet/hosts/${HOST.id}/profiles/travel`,
      /Delete profile "travel" on mini-pc\? Its cookies and sign-ins are removed\./,
    );
  });

  it('revoking a host', async () => {
    const { deletes } = mount(<FleetPage />, ['fleet:read', 'fleet:write'], {
      'GET /fleet/hosts': [HOST],
      [`DELETE /fleet/hosts/${HOST.id}`]: {},
    });
    const card = await screen.findByLabelText('Host mini-pc');
    await cancelThenConfirm(
      () => fireEvent.click(within(card).getByRole('button', { name: 'Revoke' })),
      'Revoke',
      deletes,
      `/fleet/hosts/${HOST.id}`,
      /Revoke mini-pc\? Its credential stops working and its sessions end\./,
    );
  });
});
