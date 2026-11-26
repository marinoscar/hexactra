// The task form opened from the task builder (E42.2): prefilled with every field of the draft and its
// schedules, the warnings shown, the builder linked once the task is saved.
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestApiError, createTestPlatformHost, type TestApiRequest, type TestPlatformHost } from '@marinoscar/platform-web/testing';

import { TaskCreatePage, valuesFromBuilderDraft } from '../pages/TaskCreatePage';
import type { TaskBuilderDraft } from '../types/taskBuilder';
import { ConfirmProvider, ToastHost, dismissToast } from '../ui';
import { mockViewport } from './matchMedia';
import { POLICY_READS } from './policyFixtures';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

const ALL = ['tasks:read', 'tasks:write', 'runs:read', 'runs:write', 'agent_policies:read', 'fleet:read', 'chat:read'];
const BUILDER_ID = '77777777-7777-4777-8777-777777777777';
const TASK_ID = '11111111-1111-4111-8111-111111111111';
const DRAFT: TaskBuilderDraft = {
  name: 'Pay the water bill',
  goal: 'Pay {{Amount}} on water.example.test. Done when the confirmation number is shown.',
  profile: 'default',
  hostId: null,
  hostFallback: true,
  policyId: null,
  allowedDomains: ['water.example.test'],
  confirmRiskyActions: true,
  useSavedLogins: false,
  useSavedIdentity: false,
  useSavedCards: false,
  parameters: [{ key: 'amount', label: 'Amount', type: 'money', required: true }],
  outputs: [],
  connections: [],
  unattendedPayments: 'ask',
  needsBrowser: 'always',
  schedules: [{ cron: '0 9 1 * *', timezone: 'America/Costa_Rica', enabled: true, concurrency: 'skip', policyId: null, inputs: { amount: '25' } }],
  warnings: ['No active account is named "Nobody": add it under Accounts, or choose another.'],
};

let restoreViewport: (() => void) | null = null;
beforeAll(() => {
  Element.prototype.scrollTo = () => undefined;
  Element.prototype.scrollIntoView = () => undefined;
});
afterEach(() => {
  restoreViewport?.();
  restoreViewport = null;
  dismissToast();
});

function Where() {
  const location = useLocation();
  return <div data-testid="where">{location.pathname}</div>;
}

function mount(responses: Record<string, unknown> = {}, draft: TaskBuilderDraft = DRAFT): TestPlatformHost {
  restoreViewport = mockViewport(1440);
  const host = createTestPlatformHost({
    permissions: ALL,
    responses: {
      ...POLICY_READS,
      'GET /fleet/hosts': [],
      [`POST /task-builder/${BUILDER_ID}/task-link`]: { id: 'm1', seq: 9, role: 'system', kind: 'text', text: 'Saved as the task "Pay the water bill".', runId: null, meta: { taskId: TASK_ID }, createdAt: '2026-11-21T10:00:00Z' },
      'POST /tasks': (req: TestApiRequest) => ({ id: TASK_ID, ...(req.body as object) }),
      ...responses,
    },
  });
  render(
    <PlatformHostProvider host={host}>
      <MemoryRouter initialEntries={[{ pathname: '/tasks/new', state: { builderId: BUILDER_ID, builderDraft: draft } }]}>
        <ConfirmProvider>
          <Routes>
            <Route path="/tasks/new" element={<TaskCreatePage />} />
            <Route path="/tasks/:id" element={<div>task page</div>} />
          </Routes>
          <Where />
        </ConfirmProvider>
        <ToastHost />
      </MemoryRouter>
    </PlatformHostProvider>,
  );
  return host;
}

const sent = (host: TestPlatformHost, method: string, path: string) => host.requests.filter((r) => r.method === method && r.path === path);

describe('The task form from the task builder', () => {
  it('is prefilled, says where the draft came from and shows each warning', async () => {
    mount();
    expect(await screen.findByLabelText(/^Name/)).toHaveValue('Pay the water bill');
    expect(screen.getAllByLabelText(/^Goal/).some((el) => (el as HTMLTextAreaElement).value === DRAFT.goal)).toBe(true);
    expect(screen.getByText('Drafted with the task builder. Check it, change what you like, then save.')).toBeInTheDocument();
    expect(screen.getByText(DRAFT.warnings![0]!)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: /Task builder/ })).toHaveAttribute('href', `/tasks/builder/${BUILDER_ID}`);
  });

  it('saves the task with its schedules, links the builder and goes to the task', async () => {
    const host = mount();
    await screen.findByLabelText(/^Name/);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(sent(host, 'POST', '/tasks')).toHaveLength(1));
    // The browser is the agent's call (#967): a draft's `needsBrowser` is not saved.
    expect(sent(host, 'POST', '/tasks')[0]!.body).not.toHaveProperty('needsBrowser');
    expect(sent(host, 'POST', '/tasks')[0]!.body).toMatchObject({
      name: 'Pay the water bill',
      allowedDomains: ['water.example.test'],
      confirmRiskyActions: true,
      schedules: [{ cron: '0 9 1 * *', timezone: 'America/Costa_Rica', enabled: true, concurrency: 'skip', policyId: null, inputs: { amount: '25' } }],
    });
    await waitFor(() => expect(sent(host, 'POST', `/task-builder/${BUILDER_ID}/task-link`)[0]?.body).toEqual({ taskId: TASK_ID }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(`/tasks/${TASK_ID}`));
  });

  it('still saves the task when the builder cannot be told', async () => {
    const host = mount({ [`POST /task-builder/${BUILDER_ID}/task-link`]: () => Promise.reject(createTestApiError(500, 'away')) });
    await screen.findByLabelText(/^Name/);
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(`/tasks/${TASK_ID}`));
    expect(sent(host, 'POST', '/tasks')).toHaveLength(1);
  });

  it('maps a draft to form values, with safe defaults for what an odd draft lacks', () => {
    const v = valuesFromBuilderDraft(DRAFT);
    expect(v.schedules).toEqual([{ cron: '0 9 1 * *', timezone: 'America/Costa_Rica', enabled: true, concurrency: 'skip', policyId: null, inputs: { amount: '25' } }]);
    expect(v.needsBrowser).toBe('auto');
    expect(v.connectionsMode).toBe('all');
    const odd = valuesFromBuilderDraft({ ...DRAFT, schedules: [{ cron: 5 } as never, ...Array.from({ length: 12 }, () => DRAFT.schedules![0]!)], needsBrowser: 'sometimes' as never, unattendedPayments: 'yes' as never });
    expect(odd.schedules).toHaveLength(10);
    expect(odd.needsBrowser).toBe('auto');
    expect(odd.unattendedPayments).toBe('ask');
  });
});
