// The task form's "Saved logins" section (E37.4, #593): the switch and the reasons it is disabled, the owner's
// default for a new task, the unattended-payments choice and its warning, and what is sent.
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TaskCreatePage } from '../pages/TaskCreatePage';
import { TaskEditPage } from '../pages/TaskEditPage';
import { unavailableReason } from '../secrets/useSavedLoginsAvailability';
import type { SecretsStatus, VaultStatus } from '../secrets/api';
import type { TaskWithSchedules } from '../taskForm/values';
import { ConfirmProvider, ToastHost, dismissToast } from '../ui';
import { mockViewport } from './matchMedia';
import { POLICY_READS } from './policyFixtures';

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 5_000 });

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const NEW_ID = '44444444-4444-4444-8444-444444444444';
const TASK: TaskWithSchedules = { id: TASK_ID, name: 'Check fare', goal: 'Find the cheapest fare', profile: 'default', hostId: null, hostFallback: true, allowedDomains: ['flights.example.test'], confirmRiskyActions: false, policyId: null, useSavedLogins: true, unattendedPayments: 'ask', summary: { schedules: [] } };

const VAULT: VaultStatus = {
  provider: 'vault', status: 'connected', configured: true, source: 'user', baseUrl: 'https://vault.example.test', clientId: 'hexactra', hasClientSecret: true, redirectUri: 'x', scopes: ['vault:items_read', 'vault:items_fill'], vaultUserId: 'v1', agentAccess: 'on', connectedAt: null, lastUsedAt: null, lastSuccessAt: null, lastErrorCode: null, connecting: false,
};
const status = (over: { vault?: Partial<VaultStatus>; deployment?: boolean; user?: boolean } = {}): SecretsStatus => {
  const deployment = over.deployment ?? true;
  const user = over.user ?? true;
  return { agentUse: { deployment, user, effective: deployment && user }, providers: { vault: { ...VAULT, ...over.vault } } };
};

const PERMS = ['tasks:read', 'tasks:write', 'runs:write', 'agent_policies:read', 'secrets:read'];

function mount(path: string, responses: Record<string, unknown> = {}, permissions: string[] = PERMS) {
  const host = createTestPlatformHost({
    permissions,
    responses: {
      ...POLICY_READS,
      'GET /fleet/hosts': [],
      'GET /secrets/status': status(),
      'GET /user-settings': {},
      'POST /tasks': { ...TASK, id: NEW_ID },
      [`GET /tasks/${TASK_ID}?include=summary`]: TASK,
      [`PATCH /tasks/${TASK_ID}`]: TASK,
      ...responses,
    },
  });
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/tasks" element={<div>tasks list</div>} />
            <Route path="/tasks/new" element={<TaskCreatePage />} />
            <Route path="/tasks/:id/edit" element={<TaskEditPage />} />
            <Route path="/tasks/:id" element={<div>task page</div>} />
            <Route path="/settings/secrets" element={<div>secrets page</div>} />
          </Routes>
        </MemoryRouter>
        <ToastHost />
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  const sent = (method: string, at: string) => host.requests.filter((r) => r.method === method && r.path === at);
  return { host, sent };
}

const save = () => screen.getByRole('button', { name: 'Save' });
const type = (label: RegExp | string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const fill = async () => {
  await screen.findByRole('form', { name: 'New task' });
  type(/^Name/, 'Miles');
  type(/^Goal/, 'Check my miles');
};
const savedLogins = () => screen.getByRole('switch', { name: 'Use my saved logins and details' });

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  dismissToast();
  cleanup();
});

describe('the reasons', () => {
  it('names the first thing that is missing, in order', () => {
    expect(unavailableReason(status(), true)).toBeNull();
    expect(unavailableReason(null, false)?.reason).toMatch(/not available to your account/);
    expect(unavailableReason(null, true)?.reason).toMatch(/could not be checked/);
    expect(unavailableReason(status({ deployment: false, vault: { status: 'disconnected' } }), true)?.reason).toMatch(/administrator has turned off/);
    expect(unavailableReason(status({ vault: { status: 'not_configured' } }), true)).toEqual({ reason: 'Connect a secrets provider first.', fixTo: '/settings/secrets' });
    expect(unavailableReason(status({ vault: { status: 'needs_reconnect' } }), true)?.reason).toBe('Connect a secrets provider first.');
    expect(unavailableReason(status({ user: false }), true)?.reason).toMatch(/Turn on .Let the agent use saved logins. first/);
  });
});

describe('the Saved logins section', () => {
  it('available: the switch works and a new task is created with it on, and "Ask me" for payments', async () => {
    const { sent } = mount('/tasks/new');
    await fill();
    await waitFor(() => expect(savedLogins()).toBeEnabled());
    expect(savedLogins()).not.toBeChecked();
    expect(savedLogins()).toHaveAccessibleDescription(/never sees the password or the code/);
    fireEvent.click(savedLogins());
    expect(savedLogins()).toBeChecked();
    expect(screen.getByRole('radio', { name: 'Ask me' })).toBeChecked();
    fireEvent.click(save());
    await screen.findByText('task page');
    expect(sent('POST', '/tasks')[0]!.body).toMatchObject({ useSavedLogins: true, unattendedPayments: 'ask' });
  });

  it.each([
    ['no provider is connected', status({ vault: { status: 'not_configured' } }), 'Connect a secrets provider first.'],
    ['the provider needs reconnecting', status({ vault: { status: 'needs_reconnect' } }), 'Connect a secrets provider first.'],
    ['the owner’s own switch is off', status({ user: false }), 'Turn on “Let the agent use saved logins” first.'],
    ['the administrator has it off', status({ deployment: false }), 'An administrator has turned off saved logins for this deployment.'],
  ])('disabled with a reason when %s', async (_why, s, reason) => {
    mount('/tasks/new', { 'GET /secrets/status': s });
    await screen.findByRole('form', { name: 'New task' });
    await waitFor(() => expect(savedLogins()).toBeDisabled());
    await waitFor(() => expect(screen.getByTestId('saved-logins-help')).toHaveTextContent(reason));
    expect(savedLogins()).toHaveAccessibleDescription(expect.stringContaining(reason));
    expect(savedLogins()).not.toBeChecked();
    expect(screen.getByRole('radio', { name: 'Go ahead' })).toBeDisabled();
  });

  it('links the reason to the Secrets page where it can be fixed', async () => {
    mount('/tasks/new', { 'GET /secrets/status': status({ vault: { status: 'not_configured' } }) });
    const help = await screen.findByTestId('saved-logins-help');
    await waitFor(() => expect(within(help).getByRole('link', { name: 'Open Secrets' })).toHaveAttribute('href', '/settings/secrets'));
  });

  it('without secrets:read: disabled, "not available to your account", and nothing is fetched', async () => {
    const { host } = mount('/tasks/new', {}, ['tasks:read', 'tasks:write', 'agent_policies:read']);
    await screen.findByRole('form', { name: 'New task' });
    await waitFor(() => expect(savedLogins()).toBeDisabled());
    expect(screen.getByTestId('saved-logins-help')).toHaveTextContent('not available to your account');
    expect(host.requests.some((r) => r.path === '/secrets/status')).toBe(false);
  });

  it('a new task starts from the owner’s default, and that is not an edit', async () => {
    const { sent } = mount('/tasks/new', { 'GET /user-settings': { secrets: { defaultUseSavedLogins: true } } });
    await fill();
    await waitFor(() => expect(savedLogins()).toBeChecked());
    fireEvent.click(save());
    await screen.findByText('task page');
    expect(sent('POST', '/tasks')[0]!.body).toMatchObject({ useSavedLogins: true });
  });

  it('a default that cannot work (no provider) leaves the switch off', async () => {
    mount('/tasks/new', { 'GET /user-settings': { secrets: { defaultUseSavedLogins: true } }, 'GET /secrets/status': status({ vault: { status: 'disconnected' } }) });
    await screen.findByRole('form', { name: 'New task' });
    await waitFor(() => expect(savedLogins()).toBeDisabled());
    expect(savedLogins()).not.toBeChecked();
  });

  it('"Go ahead" for payments shows a warning and is sent; the default explains the safe behaviour', async () => {
    restore = mockViewport(390);
    const { sent } = mount('/tasks/new');
    await fill();
    await waitFor(() => expect(savedLogins()).toBeEnabled());
    expect(screen.getByRole('radio', { name: 'Ask me' })).toBeDisabled();
    fireEvent.click(savedLogins());
    expect(screen.getByTestId('unattended-help')).toHaveTextContent(/still stops and asks in your Inbox before it pays/);
    expect(screen.queryByText(/lets this task spend money unattended/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: 'Go ahead' }));
    expect(screen.getByText(/lets this task spend money unattended/)).toBeInTheDocument();
    expect(screen.getByTestId('unattended-help')).toHaveTextContent(/pay without asking, while you are not there/);
    fireEvent.click(save());
    await screen.findByText('task page');
    expect(sent('POST', '/tasks')[0]!.body).toMatchObject({ useSavedLogins: true, unattendedPayments: 'allow' });
  });

  it('editing: a saved task shows its choices and a change patches only that field', async () => {
    const { sent } = mount(`/tasks/${TASK_ID}/edit`, { [`GET /tasks/${TASK_ID}?include=summary`]: { ...TASK, unattendedPayments: 'ask' } });
    await waitFor(() => expect(savedLogins()).toBeChecked());
    fireEvent.click(screen.getByRole('radio', { name: 'Go ahead' }));
    fireEvent.click(save());
    await screen.findByText('task page');
    expect(sent('PATCH', `/tasks/${TASK_ID}`).map((r) => r.body)).toEqual([{ unattendedPayments: 'allow' }]);
  });
});
