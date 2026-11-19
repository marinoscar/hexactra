// The task create and edit pages (#427): one form for the goal, where it runs,
// the agent policy, the safety opt-ins and the schedules. What it sends
// (`POST /tasks` with `schedules[]`; `PATCH` with the changed fields only;
// `PUT /tasks/:id/schedules` when the set changed; never `maxSteps`,
// `maxMinutes` or `model`), and every control ported from the earlier form.
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestApiError, createTestPlatformHost, type TestApiRequest } from '@marinoscar/platform-web/testing';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { TaskCreatePage } from '../pages/TaskCreatePage';
import { TaskEditPage } from '../pages/TaskEditPage';
import type { TaskWithSchedules } from '../taskForm/values';
import { ConfirmProvider, ToastHost, dismissToast } from '../ui';
import { mockViewport } from './matchMedia';
import { OWN_ID, POLICY_READS } from './policyFixtures';

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 5_000 });

const TASK_ID = '11111111-1111-4111-8111-111111111111';
const NEW_ID = '44444444-4444-4444-8444-444444444444';
const RUN_ID = '33333333-3333-4333-8333-333333333333';
const HOME = '55555555-5555-4555-8555-555555555555';
const CLOUD = '66666666-6666-4666-8666-666666666667';
const SCHEDULE_ID = '77777777-7777-4777-8777-777777777777';
const PERMS = ['tasks:read', 'tasks:write', 'runs:write', 'agent_policies:read', 'fleet:read'];
const LEGACY = ['maxSteps', 'maxMinutes', 'model'];

const hostBase = { version: '0.1.0', browserConnected: false, onDemand: true, viewerUrl: null, desktop: true, lastSeen: '2026-11-17T00:00:00Z' };
const HOSTS = [
  { ...hostBase, id: HOME, name: 'home-mini', online: false, draining: false, mode: 'unattended', profiles: [{ name: 'default', running: false }, { name: 'travel', running: false }] },
  { ...hostBase, id: CLOUD, name: 'cloud-1', online: true, draining: false, mode: 'container', profiles: [{ name: 'default', running: false }, { name: 'travel', running: false }, { name: 'work', running: false }] },
];

const TASK: TaskWithSchedules = {
  id: TASK_ID,
  name: 'Check fare',
  goal: 'Find the cheapest fare',
  profile: 'travel',
  hostId: null,
  hostFallback: true,
  allowedDomains: ['flights.example.test'],
  confirmRiskyActions: false,
  policyId: null,
  summary: {
    schedules: [{ id: SCHEDULE_ID, cron: '0 9 * * 1-5', timezone: 'UTC', enabled: true, concurrency: 'skip', policyId: null, description: 'Monday to Friday at 09:00', nextRunAt: '2026-11-18T09:00:00.000Z', consecutiveFailures: 0 }],
  },
};

/** The preview route: always valid, in words. */
function preview(request: TestApiRequest) {
  const { cron, timezone } = request.body as { cron: string; timezone: string };
  return { valid: true, cron, timezone, description: cron === '0 9 * * 1-5' ? 'Monday to Friday at 09:00' : `Runs on ${cron}`, next: ['2026-11-18T15:00:00.000Z'], intervalSeconds: null };
}

function mount(path: string, responses: Record<string, unknown> = {}, permissions: string[] = PERMS) {
  const host = createTestPlatformHost({
    permissions,
    responses: {
      ...POLICY_READS,
      'GET /fleet/hosts': HOSTS,
      'POST /schedules/preview': preview,
      'POST /tasks': { ...TASK, id: NEW_ID },
      [`GET /tasks/${TASK_ID}?include=summary`]: TASK,
      [`PATCH /tasks/${TASK_ID}`]: TASK,
      [`PUT /tasks/${TASK_ID}/schedules`]: TASK,
      [`POST /tasks/${NEW_ID}/runs`]: { id: RUN_ID },
      [`POST /tasks/${TASK_ID}/runs`]: { id: RUN_ID },
      ...responses,
    },
  });
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[path]}>
          <Link to="/elsewhere">Go elsewhere</Link>
          <Routes>
            <Route path="/tasks" element={<div>tasks list</div>} />
            <Route path="/tasks/new" element={<TaskCreatePage />} />
            <Route path="/tasks/:id/edit" element={<TaskEditPage />} />
            <Route path="/tasks/:id" element={<div>task page</div>} />
            <Route path="/runs/:id" element={<div>run page</div>} />
            <Route path="/elsewhere" element={<div>elsewhere page</div>} />
          </Routes>
        </MemoryRouter>
        <ToastHost />
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  const sent = (method: string, at: string) => host.requests.filter((r) => r.method === method && r.path === at);
  /** Every request the form made that changes something. */
  const writes = () => host.requests.filter((r) => r.method !== 'GET' && r.path !== '/schedules/preview');
  return { host, sent, writes };
}

const form = (name = 'New task') => screen.findByRole('form', { name });
const save = () => screen.getByRole('button', { name: 'Save' });
const type = (label: RegExp | string, value: string) => fireEvent.change(screen.getByLabelText(label), { target: { value } });
const choose = async (combobox: HTMLElement, option: string | RegExp) => {
  fireEvent.mouseDown(combobox);
  fireEvent.click(await screen.findByRole('option', { name: option }));
};
const fill = async () => {
  await form();
  type(/^Name/, 'Miles');
  type(/^Goal/, 'Check my miles');
};
const sites = () => screen.getByRole('combobox', { name: 'Allowed sites' });

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  dismissToast();
});

describe('creating a task', () => {
  it('posts one request with every field and its schedules, never a legacy field, and opens the task', async () => {
    const { sent, writes } = mount('/tasks/new');
    await fill();
    // Machine, fallback and the offline warning (ported from the earlier form, #384).
    expect(screen.queryByLabelText('If it is unavailable, use another available machine')).not.toBeInTheDocument();
    await choose(screen.getByRole('combobox', { name: 'Machine' }), 'home-mini (offline)');
    expect(await screen.findByText(/home-mini is offline right now\. Runs will use another available machine/)).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('If it is unavailable, use another available machine'));
    expect(screen.getByText(/Runs will fail until it is back/)).toBeInTheDocument();
    // The profile select lists that machine's profiles.
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Browser profile' }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['default', 'travel']);
    fireEvent.click(screen.getByRole('option', { name: 'travel' }));
    // The policy, with the manage link.
    expect(screen.getByRole('link', { name: 'Manage policies' })).toHaveAttribute('href', '/settings/agent-policies');
    await choose(screen.getByRole('combobox', { name: 'Policy' }), 'Thorough');
    // Sites and the purchase confirmation.
    fireEvent.change(sites(), { target: { value: 'Shop.Example.test, https://a.example.test/x' } });
    fireEvent.blur(sites());
    expect(screen.getByText('shop.example.test')).toBeInTheDocument();
    expect(screen.getByText('a.example.test')).toBeInTheDocument();
    fireEvent.click(screen.getByLabelText('Ask me before purchases and other irreversible steps'));
    // A schedule with its own policy.
    expect(screen.getByText('This task only runs when you start it.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Add a schedule' }));
    const schedule = await screen.findByRole('group', { name: 'Schedule 1' });
    await choose(within(schedule).getByRole('combobox', { name: 'Policy override' }), 'Careful shopping');
    await waitFor(() => expect(save()).toBeEnabled());
    fireEvent.click(save());

    expect(await screen.findByText('task page')).toBeInTheDocument();
    expect(await screen.findByText('Task created')).toBeInTheDocument();
    expect(sent('POST', '/tasks')).toHaveLength(1);
    const body = sent('POST', '/tasks')[0]!.body as Record<string, unknown>;
    expect(body).toEqual({
      name: 'Miles',
      goal: 'Check my miles',
      profile: 'travel',
      hostId: HOME,
      hostFallback: false,
      policyId: 'builtin:thorough',
      allowedDomains: ['shop.example.test', 'a.example.test'],
      confirmRiskyActions: true,
      useSavedLogins: false,
      unattendedPayments: 'ask',
      schedules: [{ cron: '0 9 * * 1-5', timezone: expect.any(String), enabled: true, concurrency: 'skip', policyId: OWN_ID }],
    });
    // The API answers `Deprecation: true` exactly when a request body names one of these (tasks.controller.ts
    // `flagLegacyFields`); the test host has no response headers, so the rule is asserted on every body sent.
    for (const request of writes()) for (const key of LEGACY) expect(request.body ?? {}).not.toHaveProperty(key);
    expect(writes().map((r) => `${r.method} ${r.path}`)).toEqual(['POST /tasks']);
  });

  it('without agent_policies:read has no Model and budget section and sends no policyId', async () => {
    const { sent } = mount('/tasks/new', {}, ['tasks:read', 'tasks:write']);
    await fill();
    expect(screen.queryByRole('heading', { name: 'Model and budget' })).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Policy' })).not.toBeInTheDocument();
    // Without fleet:read: any available machine only, and the profile is typed.
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Machine' }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['Any available machine']);
    fireEvent.click(screen.getByRole('option', { name: 'Any available machine' }));
    type('Browser profile', 'Not Valid');
    expect(screen.getByText('Use 1-32 lowercase letters, digits, - and _')).toBeInTheDocument();
    expect(save()).toBeDisabled();
    type('Browser profile', 'work');
    // No runs:write: no "Save and run now".
    expect(screen.queryByRole('button', { name: 'Save and run now' })).not.toBeInTheDocument();
    fireEvent.click(save());
    await screen.findByText('task page');
    const body = sent('POST', '/tasks')[0]!.body as Record<string, unknown>;
    expect(body).not.toHaveProperty('policyId');
    expect(body).not.toHaveProperty('schedules');
    expect(body).toMatchObject({ profile: 'work', hostId: null, hostFallback: true, allowedDomains: [], confirmRiskyActions: false });
  });

  it('shows the start model and budget of the chosen policy, and the schedule override follows it', async () => {
    mount('/tasks/new');
    await fill();
    const summary = () => screen.getByLabelText('Policy summary');
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Policy' })).toHaveTextContent('Default (Balanced)'));
    await waitFor(() => expect(summary()).toHaveTextContent('Starts on provider-a:model-std · Standard → Frontier · 60 actions · $2 · 20 min'));
    fireEvent.click(screen.getByRole('button', { name: 'Add a schedule' }));
    const schedule = await screen.findByRole('group', { name: 'Schedule 1' });
    expect(within(schedule).getByRole('combobox', { name: 'Policy override' })).toHaveTextContent("Task's policy (Balanced)");
    await choose(screen.getByRole('combobox', { name: 'Policy' }), 'Careful shopping');
    expect(summary()).toHaveTextContent('Starts on provider-a:model-big · Frontier · 120 actions · $4 · 30 min');
    expect(within(schedule).getByRole('combobox', { name: 'Policy override' })).toHaveTextContent("Task's policy (Careful shopping)");
    // A policy without a hard stop says so.
    await choose(screen.getByRole('combobox', { name: 'Policy' }), 'Unlimited');
    expect(summary()).toHaveTextContent('Unlimited');
    expect(screen.getByText('Nothing will stop this run except finishing, Stop, or stall detection.')).toBeInTheDocument();
  });

  it('marks a site the server would refuse and blocks Save until it is removed', async () => {
    mount('/tasks/new');
    await fill();
    expect(save()).toBeEnabled();
    fireEvent.change(sites(), { target: { value: 'not_a_site ' } });
    expect(screen.getByText(/“not_a_site” is not a site/)).toBeInTheDocument();
    expect(screen.getByText('not_a_site').closest('.MuiChip-root')).toHaveClass('MuiChip-colorError');
    expect(save()).toBeDisabled();
    // A duplicate is ignored.
    fireEvent.change(sites(), { target: { value: 'ok.example.test OK.example.test ' } });
    expect(screen.getAllByText('ok.example.test')).toHaveLength(1);
    fireEvent.click(within(screen.getByText('not_a_site').closest('.MuiChip-root') as HTMLElement).getByTestId('CancelIcon'));
    expect(save()).toBeEnabled();
  });

  it('warns when the chosen machine lacks the profile, with a link to Fleet', async () => {
    mount('/tasks/new');
    await fill();
    // Any available machine: every profile, with how many machines have it.
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Browser profile' }));
    expect((await screen.findAllByRole('option')).map((o) => o.textContent)).toEqual(['default · on 2 of 2 machines', 'travel · on 2 of 2 machines', 'work · on 1 of 2 machines']);
    fireEvent.click(screen.getByRole('option', { name: /^work/ }));
    expect(screen.queryByText(/does not exist on/)).not.toBeInTheDocument();
    await choose(screen.getByRole('combobox', { name: 'Machine' }), 'home-mini (offline)');
    expect(screen.getByText(/“work” does not exist on home-mini\. The run will fail unless you create it in/)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Fleet' })).toHaveAttribute('href', '/fleet');
  });

  it('falls back to a typed profile when the machines cannot be loaded, and still saves', async () => {
    const { sent } = mount('/tasks/new', { 'GET /fleet/hosts': () => Promise.reject(createTestApiError(500, 'Fleet is down')) });
    await fill();
    expect(await screen.findByText(/The machines could not be loaded/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Browser profile' })).toHaveValue('default');
    fireEvent.click(save());
    await screen.findByText('task page');
    expect(sent('POST', '/tasks')).toHaveLength(1);
  });

  it('opens the schedule a server error names and shows the message on it', async () => {
    const path = 'schedules[0].cron';
    const { sent } = mount('/tasks/new', {
      'POST /tasks': () => Promise.reject(createTestApiError(400, `${path}: A schedule may fire at most every 5 minutes`, 'CRON_TOO_FREQUENT', { path, issues: [{ path, message: 'A schedule may fire at most every 5 minutes' }] })),
    });
    await fill();
    fireEvent.click(screen.getByRole('button', { name: 'Add a schedule' }));
    const schedule = await screen.findByRole('group', { name: 'Schedule 1' });
    await waitFor(() => expect(within(schedule).getByRole('button', { name: 'Done' })).toBeEnabled());
    fireEvent.click(within(schedule).getByRole('button', { name: 'Done' }));
    // Collapsed: the schedule in words.
    expect(await within(schedule).findByText('Monday to Friday at 09:00')).toBeInTheDocument();
    expect(within(schedule).queryByRole('group', { name: 'Schedule editor' })).not.toBeInTheDocument();
    fireEvent.click(save());
    expect(await within(schedule).findByText('A schedule may fire at most every 5 minutes')).toBeInTheDocument();
    expect(within(schedule).getByRole('group', { name: 'Schedule editor' })).toBeInTheDocument();
    // The form moves the focus in an effect, a render after the error is on screen (#496).
    await waitFor(() => expect(schedule).toHaveFocus());
    expect(sent('POST', '/tasks')).toHaveLength(1);
    expect(screen.queryByText('task page')).not.toBeInTheDocument();
  });

  it('puts a refused policy on the select, a field issue on its field, and anything else in the banner', async () => {
    let call = 0;
    mount('/tasks/new', {
      'POST /tasks': () => {
        call += 1;
        if (call === 1) return Promise.reject(createTestApiError(400, 'policyId does not name a built-in policy or one of yours', 'POLICY_REF_INVALID'));
        if (call === 2) return Promise.reject(createTestApiError(400, 'Validation failed', 'VALIDATION_ERROR', { issues: [{ path: 'name', message: 'Too long' }] }));
        return Promise.reject(createTestApiError(500, 'The database is away'));
      },
    });
    await fill();
    fireEvent.click(save());
    expect(await screen.findByText('This policy is not available. Choose another.')).toBeInTheDocument();
    fireEvent.click(save());
    expect(await screen.findByText('Too long')).toBeInTheDocument();
    // The focus leaves the policy select (the first failed save put it there) an effect later (#496).
    await waitFor(() => expect(screen.getByLabelText(/^Name/)).toHaveFocus());
    expect(screen.getByLabelText(/^Name/)).toHaveAccessibleDescription('Too long');
    fireEvent.click(save());
    expect(await screen.findByRole('alert')).toHaveTextContent('The database is away');
  });

  it('"Save and run now" saves, starts a run on the task\'s policy and opens it', async () => {
    const { sent } = mount('/tasks/new');
    await fill();
    fireEvent.click(screen.getByRole('button', { name: 'Save and run now' }));
    expect(await screen.findByText('run page')).toBeInTheDocument();
    expect(sent('POST', '/tasks')).toHaveLength(1);
    expect(sent('POST', `/tasks/${NEW_ID}/runs`).map((r) => r.body)).toEqual([{}]);
  });

  it('prefills the goal from ?goal=', async () => {
    mount('/tasks/new?goal=Read%20my%20balance');
    await form();
    expect(screen.getByLabelText(/^Goal/)).toHaveValue('Read my balance');
    expect(screen.getByLabelText(/^Name/)).toHaveFocus();
  });

  it('copies a task from ?from=: its fields, its policy, and its schedules paused', async () => {
    const source: TaskWithSchedules = { ...TASK, policyId: OWN_ID, summary: { schedules: [{ ...TASK.summary!.schedules[0]!, policyId: 'builtin:economy' }] } };
    const { sent } = mount(`/tasks/new?from=${TASK_ID}`, { [`GET /tasks/${TASK_ID}?include=summary`]: source });
    await form();
    expect(screen.getByLabelText(/^Name/)).toHaveValue('Copy of Check fare');
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Policy' })).toHaveTextContent('Careful shopping'));
    const schedule = screen.getByRole('group', { name: 'Schedule 1' });
    expect(within(schedule).getByText('Paused')).toBeInTheDocument();
    fireEvent.click(save());
    await screen.findByText('task page');
    expect(sent('POST', '/tasks')[0]!.body).toMatchObject({
      name: 'Copy of Check fare',
      goal: 'Find the cheapest fare',
      profile: 'travel',
      policyId: OWN_ID,
      allowedDomains: ['flights.example.test'],
      schedules: [{ cron: '0 9 * * 1-5', timezone: 'UTC', enabled: false, concurrency: 'skip', policyId: 'builtin:economy' }],
    });
    expect((sent('POST', '/tasks')[0]!.body as { schedules: object[] }).schedules[0]).not.toHaveProperty('id');
  });

  it('offers up to 10 schedules, and a new one that is removed just goes', async () => {
    mount('/tasks/new');
    await fill();
    fireEvent.click(screen.getByRole('button', { name: 'Add a schedule' }));
    fireEvent.click(within(await screen.findByRole('group', { name: 'Schedule 1' })).getByRole('button', { name: 'Remove' }));
    expect(screen.queryByRole('group', { name: 'Schedule 1' })).not.toBeInTheDocument();
    expect(screen.queryByText(/will be removed when you save/)).not.toBeInTheDocument();
    expect(screen.getByText('This task only runs when you start it.')).toBeInTheDocument();
  });
});

describe('leaving the form', () => {
  it('asks before discarding changes, and leaves at once when there are none', async () => {
    mount('/tasks/new');
    await form();
    type(/^Name/, 'Miles');
    fireEvent.click(screen.getByRole('link', { name: 'Go elsewhere' }));
    const dialog = await screen.findByRole('dialog', { name: 'Discard your changes?' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Keep editing' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(screen.getByLabelText(/^Name/)).toHaveValue('Miles');
    // The tab's own prompt on close or reload.
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Discard your changes?' })).getByRole('button', { name: 'Discard' }));
    expect(await screen.findByText('tasks list')).toBeInTheDocument();
  });

  it('does not ask on a clean form', async () => {
    mount('/tasks/new');
    await form();
    const unload = new Event('beforeunload', { cancelable: true });
    window.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
    fireEvent.click(screen.getByRole('link', { name: 'Go elsewhere' }));
    expect(await screen.findByText('elsewhere page')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });
});

describe('editing a task', () => {
  const edit = () => form('Edit task');

  it('sends nothing and keeps Save disabled while nothing changed; a changed policy sends { policyId } only', async () => {
    const { sent, writes } = mount(`/tasks/${TASK_ID}/edit`);
    await edit();
    expect(screen.getByLabelText(/^Name/)).toHaveValue('Check fare');
    expect(save()).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Save and run now' })).toBeDisabled();
    await choose(screen.getByRole('combobox', { name: 'Policy' }), 'Economy');
    expect(save()).toBeEnabled();
    fireEvent.click(save());
    expect(await screen.findByText('task page')).toBeInTheDocument();
    expect(await screen.findByText('Task saved')).toBeInTheDocument();
    expect(sent('PATCH', `/tasks/${TASK_ID}`).map((r) => r.body)).toEqual([{ policyId: 'builtin:economy' }]);
    expect(writes()).toHaveLength(1);
  });

  it('patches only the changed fields and leaves the schedules alone', async () => {
    const { sent, writes } = mount(`/tasks/${TASK_ID}/edit`);
    await edit();
    type(/^Goal/, 'Find the cheapest fare to Lisbon');
    fireEvent.click(screen.getByLabelText('Ask me before purchases and other irreversible steps'));
    fireEvent.click(save());
    await screen.findByText('task page');
    expect(sent('PATCH', `/tasks/${TASK_ID}`).map((r) => r.body)).toEqual([{ goal: 'Find the cheapest fare to Lisbon', confirmRiskyActions: true }]);
    expect(writes()).toHaveLength(1);
    for (const request of writes()) for (const key of LEGACY) expect(request.body).not.toHaveProperty(key);
  });

  it('replaces the schedule set only when it changed: a removal waits for Save and can be undone', async () => {
    const { sent, writes } = mount(`/tasks/${TASK_ID}/edit`);
    await edit();
    const schedule = screen.getByRole('group', { name: 'Schedule 1' });
    expect(within(schedule).getByText('Monday to Friday at 09:00')).toBeInTheDocument();
    fireEvent.click(within(schedule).getByRole('button', { name: 'Remove' }));
    expect(screen.getByText(/“Monday to Friday at 09:00” will be removed when you save\./)).toBeInTheDocument();
    expect(save()).toBeEnabled();
    fireEvent.click(screen.getByRole('button', { name: 'Undo' }));
    expect(save()).toBeDisabled();
    // Pause it and add a second one.
    fireEvent.click(within(screen.getByRole('group', { name: 'Schedule 1' })).getByRole('button', { name: 'Edit' }));
    fireEvent.click(within(screen.getByRole('group', { name: 'Schedule 1' })).getByRole('switch', { name: /Active/ }));
    fireEvent.click(screen.getByRole('button', { name: 'Add another schedule' }));
    await screen.findByRole('group', { name: 'Schedule 2' });
    await waitFor(() => expect(save()).toBeEnabled());
    fireEvent.click(save());
    await screen.findByText('task page');
    expect(sent('PATCH', `/tasks/${TASK_ID}`)).toHaveLength(0);
    expect(sent('PUT', `/tasks/${TASK_ID}/schedules`).map((r) => r.body)).toEqual([
      {
        schedules: [
          { id: SCHEDULE_ID, cron: '0 9 * * 1-5', timezone: 'UTC', enabled: false, concurrency: 'skip', policyId: null },
          { cron: '0 9 * * 1-5', timezone: expect.any(String), enabled: true, concurrency: 'skip', policyId: null },
        ],
      },
    ]);
    expect(writes()).toHaveLength(1);
  });

  it('keeps the schedule edits and says so when the task saved but its schedules did not', async () => {
    let fail = true;
    const { sent } = mount(`/tasks/${TASK_ID}/edit`, {
      [`PUT /tasks/${TASK_ID}/schedules`]: () => (fail ? Promise.reject(createTestApiError(409, 'A task has at most 10 schedules', 'SCHEDULE_LIMIT')) : TASK),
    });
    await edit();
    type(/^Name/, 'Check fares');
    fireEvent.click(within(screen.getByRole('group', { name: 'Schedule 1' })).getByRole('button', { name: 'Remove' }));
    fireEvent.click(save());
    expect(await screen.findByText('The task was saved but its schedules were not: A task has at most 10 schedules')).toBeInTheDocument();
    // The limit is also shown on the Schedule section; the removal is still pending.
    expect(screen.getAllByText('A task has at most 10 schedules').length).toBeGreaterThan(0);
    expect(screen.getByText(/will be removed when you save/)).toBeInTheDocument();
    expect(screen.queryByText('task page')).not.toBeInTheDocument();
    // A retry sends the schedules only: the task fields are already saved.
    fail = false;
    fireEvent.click(save());
    await screen.findByText('task page');
    expect(sent('PATCH', `/tasks/${TASK_ID}`).map((r) => r.body)).toEqual([{ name: 'Check fares' }]);
    expect(sent('PUT', `/tasks/${TASK_ID}/schedules`).map((r) => r.body)).toEqual([{ schedules: [] }, { schedules: [] }]);
  });

  it('reads a deleted policy as the default, with a note, and does not send it', async () => {
    const gone = '99999999-9999-4999-8999-999999999999';
    const { sent } = mount(`/tasks/${TASK_ID}/edit`, { [`GET /tasks/${TASK_ID}?include=summary`]: { ...TASK, policyId: gone } });
    await edit();
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Policy' })).toHaveTextContent('Default (Balanced)'));
    expect(screen.getByText("This task's policy was deleted; it runs under your default.")).toBeInTheDocument();
    expect(save()).toBeDisabled();
    type(/^Name/, 'Check fares');
    fireEvent.click(save());
    await screen.findByText('task page');
    expect(sent('PATCH', `/tasks/${TASK_ID}`).map((r) => r.body)).toEqual([{ name: 'Check fares' }]);
  });

  it('disables the policy select when the policies cannot be loaded and leaves the policy untouched', async () => {
    const { sent } = mount(`/tasks/${TASK_ID}/edit`, {
      [`GET /tasks/${TASK_ID}?include=summary`]: { ...TASK, policyId: OWN_ID },
      'GET /agent-policies': () => Promise.reject(createTestApiError(500, 'Away')),
    });
    await edit();
    expect(await screen.findByText(/Policies could not be loaded/)).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Policy' })).toHaveAttribute('aria-disabled', 'true');
    type(/^Name/, 'Check fares');
    fireEvent.click(save());
    await screen.findByText('task page');
    expect(sent('PATCH', `/tasks/${TASK_ID}`).map((r) => r.body)).toEqual([{ name: 'Check fares' }]);
  });

  it('deletes the task from the danger zone after a confirmation', async () => {
    const { sent } = mount(`/tasks/${TASK_ID}/edit`, { [`DELETE /tasks/${TASK_ID}`]: null });
    await edit();
    fireEvent.click(screen.getByRole('button', { name: 'Delete task' }));
    const dialog = await screen.findByRole('dialog', { name: 'Delete task “Check fare”?' });
    expect(within(dialog).getByText('Its schedules are deleted. Its runs are kept.')).toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('tasks list')).toBeInTheDocument();
    expect(sent('DELETE', `/tasks/${TASK_ID}`)).toHaveLength(1);
  });

  it('says so when the task does not exist', async () => {
    mount(`/tasks/${NEW_ID}/edit`);
    expect(await screen.findByText('This task does not exist')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Tasks' })).toHaveAttribute('href', '/tasks');
  });
});

describe('on a phone', () => {
  it('keeps Save in a fixed bar, with "Save and run now" and Cancel in its menu', async () => {
    restore = mockViewport(390);
    const { sent } = mount('/tasks/new');
    await fill();
    const bar = screen.getByRole('group', { name: 'Form actions' });
    expect(within(bar).getByRole('button', { name: 'Save' })).toBeEnabled();
    expect(screen.queryByRole('button', { name: 'Cancel' })).not.toBeInTheDocument();
    fireEvent.click(within(bar).getByRole('button', { name: 'More actions' }));
    expect(await screen.findByRole('menuitem', { name: 'Cancel' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('menuitem', { name: 'Save and run now' }));
    expect(await screen.findByText('run page')).toBeInTheDocument();
    expect(sent('POST', `/tasks/${NEW_ID}/runs`)).toHaveLength(1);
  });
});
