// The Tasks list (#426): one paged request with each task's summary, the
// toolbar's state in the URL, the Scheduled switch, Run and "Run with…"
// without leaving the page, spend, policy, delete, permissions and layout.
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestApiError, createTestPlatformHost, type TestApiRequest, type TestPlatformHost } from '@marinoscar/platform-web/testing';

import { taskListPath, taskPaths } from '../components/taskList';
import { TASK_LIVE_REFRESH_MS } from '../components/useTaskList';
import { TasksPage } from '../pages/TasksPage';
import type { TaskWithSummary } from '../types/tasks';
import { ConfirmProvider } from '../ui';
import { mockViewport } from './matchMedia';
import { OWN_ID, POLICY_READS } from './policyFixtures';
import { OTHER_ID, RUN_ID, TASK_ID, page, schedule, scheduledRow, taskRow } from './taskFixtures';

// Full pages with MUI menus: slow under a loaded parallel run, never hanging.
vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

const ALL = ['tasks:read', 'tasks:write', 'runs:read', 'runs:write', 'agent_policies:read'];
const PLAIN = taskRow();
const PINNED = scheduledRow({ id: OTHER_ID, name: 'Weekly order', goal: 'Order the groceries', policyId: OWN_ID });

let restoreViewport: (() => void) | null = null;
afterEach(() => {
  restoreViewport?.();
  restoreViewport = null;
  vi.useRealTimers();
});

function Where() {
  const location = useLocation();
  return <div data-testid="where">{`${location.pathname}${location.search}`}</div>;
}

function mount(responses: Record<string, unknown>, permissions: string[] = ALL, entry = '/tasks'): TestPlatformHost {
  const host = createTestPlatformHost({ permissions, responses: { ...POLICY_READS, 'GET /tasks': page([PLAIN, PINNED]), ...responses } });
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[entry]}>
          <Where />
          <Routes>
            <Route path="/tasks" element={<TasksPage />} />
            {/* The form pages (#427) and the run page are not this page's: stubs. */}
            <Route path="/tasks/new" element={<div>new task page</div>} />
            <Route path="/tasks/:id/edit" element={<div>edit task page</div>} />
            <Route path="/runs/:id" element={<div>run page</div>} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  return host;
}

const listRequests = (host: TestPlatformHost) => host.requests.filter((r) => r.method === 'GET' && r.path.startsWith('/tasks?'));
const lastList = (host: TestPlatformHost) => new URLSearchParams(listRequests(host).at(-1)!.path.split('?')[1]);
/** The table row of a task (the list is a table at the default, desktop, width). */
const row = async (name: string) => (await screen.findByText(name)).closest('tr')!;
const posts = (host: TestPlatformHost, path: string) => host.requests.filter((r) => r.method === 'POST' && r.path === path);

describe('the Tasks list', () => {
  it('renders rows from one paged request with summaries: no per-task schedule request, one catalog load', async () => {
    const host = mount({});
    const plain = await row('Check fare');
    expect(within(plain).getByText('Find the cheapest fare')).toHaveAttribute('title', 'Find the cheapest fare');
    expect(within(plain).getByText('Not scheduled')).toBeInTheDocument();
    expect(within(plain).getByText('Never run')).toBeInTheDocument();
    const pinned = await row('Weekly order');
    expect(within(pinned).getByText(/Monday to Friday at 09:00/)).toBeInTheDocument();

    expect(listRequests(host).map((r) => r.path)).toEqual(['/tasks?envelope=1&include=summary&limit=50&sort=created_desc']);
    expect(host.requests.some((r) => r.path.startsWith('/schedules'))).toBe(false);
    await waitFor(() => expect(within(plain).getByText('Balanced (default)')).toBeInTheDocument());
    expect(host.requests.filter((r) => r.path === '/agent-policies')).toHaveLength(1);
    expect(host.requests.filter((r) => r.path === '/agent-policies/default')).toHaveLength(1);
    // The header: the title, what the page is for, and the primary action.
    expect(screen.getByRole('heading', { level: 1, name: 'Tasks' })).toBeInTheDocument();
    expect(screen.getByText('What your agents do, and when.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New task' })).toHaveAttribute('href', '/tasks/new');
  });

  it('shows the schedule, the next run, the last run and the 7-day strip of a row', async () => {
    const busy = scheduledRow({
      summary: {
        schedules: [schedule(), schedule({ id: 's2', description: 'Every Sunday at 18:00' }), schedule({ id: 's3', description: 'Every hour' })],
        lastRun: { id: RUN_ID, status: 'failed', trigger: 'schedule', createdAt: '2026-11-16T09:00:00Z', finishedAt: '2026-11-16T09:04:00Z' },
        runCounts: { total: 20, last7d: { succeeded: 12, failed: 1, cancelled: 0 } },
      },
    });
    const paused = scheduledRow({ id: OTHER_ID, name: 'Paused one', summary: { scheduleState: 'paused', nextRunAt: null, schedules: [schedule({ enabled: false, nextRunAt: null })] } });
    mount({ 'GET /tasks': page([busy, paused]) });
    const first = await row('Check fare');
    expect(within(first).getByText('+2 more')).toBeInTheDocument();
    expect(within(first).getByRole('link', { name: 'Last run of Check fare: failed' })).toHaveAttribute('href', `/runs/${RUN_ID}`);
    expect(within(first).getByRole('img', { name: '12 succeeded, 1 failed in the last 7 days' })).toHaveTextContent('12 ✓ · 1 ✗');
    // A future firing is a relative time with the absolute one in its tooltip.
    expect(first.querySelector('time[datetime="2099-01-05T09:00:00.000Z"]')).not.toBeNull();
    const second = await row('Paused one');
    expect(within(second).getAllByText('Paused').length).toBeGreaterThan(0);
    expect(within(second).getByRole('img', { name: 'No runs in the last 7 days' })).toBeInTheDocument();
  });

  it('links the name, Edit, Duplicate and View runs; a live run shows as a chip that links to it', async () => {
    const live = taskRow({ summary: { liveRunId: RUN_ID, lastRun: { id: RUN_ID, status: 'running', trigger: 'manual', createdAt: '2026-11-17T09:00:00Z', finishedAt: null } } });
    mount({ 'GET /tasks': page([live]) });
    const r = await row('Check fare');
    expect(within(r).getByRole('link', { name: 'Check fare' })).toHaveAttribute('href', taskPaths.detail(TASK_ID));
    const chip = within(r).getByRole('link', { name: 'Live run of Check fare' });
    expect(chip).toHaveAttribute('href', `/runs/${RUN_ID}`);
    expect(chip).toHaveTextContent('running');
    fireEvent.click(within(r).getByRole('button', { name: 'More actions: Check fare' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Edit' })).toHaveAttribute('href', `/tasks/${TASK_ID}/edit`);
    expect(within(menu).getByRole('menuitem', { name: 'Duplicate' })).toHaveAttribute('href', `/tasks/new?from=${TASK_ID}`);
    expect(within(menu).getByRole('menuitem', { name: 'View runs' })).toHaveAttribute('href', taskPaths.runs(TASK_ID));
    expect(within(menu).getByRole('menuitem', { name: 'Delete' })).toBeInTheDocument();
  });
});

describe('search, filter and sort', () => {
  it('sends the search after a pause in typing, and clears it', async () => {
    const host = mount({});
    await row('Check fare');
    fireEvent.change(screen.getByRole('textbox', { name: 'Search tasks' }), { target: { value: 'fa' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Search tasks' }), { target: { value: 'fare' } });
    await waitFor(() => expect(lastList(host).get('q')).toBe('fare'));
    // Debounced: the half-typed text was never sent.
    expect(listRequests(host).some((r) => new URLSearchParams(r.path.split('?')[1]).get('q') === 'fa')).toBe(false);
    expect(screen.getByTestId('where')).toHaveTextContent('/tasks?q=fare');
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    await waitFor(() => expect(lastList(host).get('q')).toBeNull());
    expect(screen.getByTestId('where')).toHaveTextContent(/\/tasks$/);
  });

  it.each([
    ['Scheduled', 'scheduled'],
    ['Paused', 'paused'],
    ['Not scheduled', 'unscheduled'],
    ['Failing', 'failing'],
    ['Never run', 'never_run'],
  ])('the "%s" chip asks for filter=%s', async (label, value) => {
    const host = mount({});
    await row('Check fare');
    const group = screen.getByRole('group', { name: 'Filter' });
    fireEvent.click(within(group).getByRole('button', { name: label }));
    await waitFor(() => expect(lastList(host).get('filter')).toBe(value));
    expect(within(group).getByRole('button', { name: label })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByTestId('where')).toHaveTextContent(`filter=${value}`);
    // "All" takes the filter off again.
    fireEvent.click(within(group).getByRole('button', { name: 'All' }));
    await waitFor(() => expect(lastList(host).get('filter')).toBeNull());
  });

  it.each([
    ['Name', 'name_asc'],
    ['Last run', 'last_run_desc'],
    ['Next run', 'next_run_asc'],
    ['Spend', 'spend_desc'],
  ])('the "%s" sort asks for sort=%s', async (label, value) => {
    const host = mount({});
    await row('Check fare');
    expect(lastList(host).get('sort')).toBe('created_desc');
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Sort' }));
    fireEvent.click(await screen.findByRole('option', { name: label }));
    await waitFor(() => expect(lastList(host).get('sort')).toBe(value));
    expect(screen.getByTestId('where')).toHaveTextContent(`sort=${value}`);
  });

  it('restores the search, the filter, the sort and the policy from the URL', async () => {
    const host = mount({}, ALL, '/tasks?q=fare&filter=failing&sort=name_asc&policyId=builtin%3Athorough');
    await row('Check fare');
    const first = new URLSearchParams(listRequests(host)[0]!.path.split('?')[1]);
    expect(Object.fromEntries(first)).toMatchObject({ q: 'fare', filter: 'failing', sort: 'name_asc', policyId: 'builtin:thorough', envelope: '1', include: 'summary', limit: '50' });
    expect(screen.getByRole('textbox', { name: 'Search tasks' })).toHaveValue('fare');
    expect(screen.getByRole('button', { name: 'Failing' })).toHaveAttribute('aria-pressed', 'true');
    expect(screen.getByRole('combobox', { name: 'Sort' })).toHaveTextContent('Name');
    await waitFor(() => expect(screen.getByRole('combobox', { name: 'Policy' })).toHaveTextContent('Thorough'));
  });

  it('offers the Policy filter once the tasks use more than one policy, and sends policyId', async () => {
    const other = { ...PINNED, summary: { ...PINNED.summary, policy: { id: OWN_ID, name: 'Careful shopping', builtin: false, isDefault: false } } };
    const host = mount({ 'GET /tasks': page([PLAIN, other]) });
    await row('Check fare');
    fireEvent.mouseDown(await screen.findByRole('combobox', { name: 'Policy' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Careful shopping' }));
    await waitFor(() => expect(lastList(host).get('policyId')).toBe(OWN_ID));
  });

  it('has no Policy filter while every task uses the same policy', async () => {
    mount({});
    const r = await row('Check fare');
    await waitFor(() => expect(within(r).getByText('Balanced (default)')).toBeInTheDocument());
    expect(screen.queryByRole('combobox', { name: 'Policy' })).not.toBeInTheDocument();
  });

  it('says when nothing matches, and clears the filters', async () => {
    const host = mount({ 'GET /tasks': (r: TestApiRequest) => (r.path.includes('filter=') ? page([]) : page([PLAIN])) }, ALL, '/tasks?filter=failing&q=zz');
    expect(await screen.findByText('No tasks match')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Clear filters' }));
    expect(await screen.findByText('Check fare')).toBeInTheDocument();
    expect(lastList(host).get('filter')).toBeNull();
    expect(lastList(host).get('q')).toBeNull();
    expect(screen.getByRole('textbox', { name: 'Search tasks' })).toHaveValue('');
  });
});

describe('the Scheduled switch', () => {
  const ACTIVE = scheduledRow();
  const PAUSED = { ...ACTIVE, summary: { ...ACTIVE.summary, scheduleState: 'paused' as const, nextRunAt: null } };

  it('pauses an active task and resumes a paused one, updating the row from the answer', async () => {
    const host = mount({
      'GET /tasks': page([ACTIVE]),
      [`POST /tasks/${TASK_ID}/schedules/pause`]: { ...PAUSED, skipped: [] },
      [`POST /tasks/${TASK_ID}/schedules/resume`]: { ...ACTIVE, skipped: [] },
    });
    const r = await row('Check fare');
    const toggle = within(r).getByRole('switch', { name: 'Scheduled: Check fare' });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    await waitFor(() => expect(posts(host, `/tasks/${TASK_ID}/schedules/pause`)).toHaveLength(1));
    await waitFor(() => expect(within(r).getByRole('switch', { name: 'Scheduled: Check fare' })).not.toBeChecked());
    expect(within(r).getByText('Paused')).toBeInTheDocument();
    await waitFor(() => expect(within(r).getByRole('switch', { name: 'Scheduled: Check fare' })).toBeEnabled());
    fireEvent.click(within(r).getByRole('switch', { name: 'Scheduled: Check fare' }));
    await waitFor(() => expect(posts(host, `/tasks/${TASK_ID}/schedules/resume`)).toHaveLength(1));
    await waitFor(() => expect(within(r).getByRole('switch', { name: 'Scheduled: Check fare' })).toBeChecked());
  });

  it('is absent for a task with no schedule, which links to adding one', async () => {
    mount({ 'GET /tasks': page([PLAIN]) });
    const r = await row('Check fare');
    expect(within(r).queryByRole('switch')).not.toBeInTheDocument();
    expect(within(r).getByRole('link', { name: 'Add schedule' })).toHaveAttribute('href', `/tasks/${TASK_ID}/edit#schedule`);
  });

  it('says "Partly paused" and resumes when some schedules are paused', async () => {
    const partial = { ...ACTIVE, summary: { ...ACTIVE.summary, scheduleState: 'partial' as const } };
    const host = mount({ 'GET /tasks': page([partial]), [`POST /tasks/${TASK_ID}/schedules/resume`]: { ...ACTIVE, skipped: [] } });
    const r = await row('Check fare');
    expect(within(r).getByText('Partly paused')).toBeInTheDocument();
    const toggle = within(r).getByRole('switch', { name: 'Scheduled: Check fare' });
    expect(toggle).toHaveAttribute('aria-checked', 'mixed');
    fireEvent.click(toggle);
    await waitFor(() => expect(posts(host, `/tasks/${TASK_ID}/schedules/resume`)).toHaveLength(1));
    await waitFor(() => expect(within(r).queryByText('Partly paused')).not.toBeInTheDocument());
  });

  it('rolls back and names the task when the request fails', async () => {
    let fail: (e: unknown) => void = () => undefined;
    mount({
      'GET /tasks': page([ACTIVE]),
      [`POST /tasks/${TASK_ID}/schedules/pause`]: () => new Promise((_resolve, reject) => (fail = reject)),
    });
    const r = await row('Check fare');
    fireEvent.click(within(r).getByRole('switch', { name: 'Scheduled: Check fare' }));
    // Optimistic: off before the answer.
    await waitFor(() => expect(within(r).getByRole('switch', { name: 'Scheduled: Check fare' })).not.toBeChecked());
    await act(async () => fail(createTestApiError(500, 'The database is away')));
    await waitFor(() => expect(within(r).getByRole('switch', { name: 'Scheduled: Check fare' })).toBeChecked());
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not pause the schedule of “Check fare”: The database is away');
  });

  it('is a read-only chip without tasks:write', async () => {
    mount({ 'GET /tasks': page([ACTIVE, { ...PAUSED, id: OTHER_ID, name: 'Resting' }]) }, ['tasks:read']);
    const r = await row('Check fare');
    expect(within(r).queryByRole('switch')).not.toBeInTheDocument();
    expect(within(r).getByText('Scheduled')).toBeInTheDocument();
    expect(within(await row('Resting')).getAllByText('Paused').length).toBeGreaterThan(0);
  });
});

describe('Run and Run with…', () => {
  it('"Run now" posts no policyId, stays on the page and links the snackbar to the run', async () => {
    const host = mount({ [`POST /tasks/${TASK_ID}/runs`]: { id: RUN_ID } });
    const r = await row('Check fare');
    fireEvent.click(within(r).getByRole('button', { name: 'Run now' }));
    const snack = await screen.findByText('Run started');
    expect(within(snack.closest('[role="status"]') as HTMLElement).getByRole('link', { name: 'View' })).toHaveAttribute('href', `/runs/${RUN_ID}`);
    expect(posts(host, `/tasks/${TASK_ID}/runs`).map((p) => p.body)).toEqual([{}]);
    // Still the list: the row now shows the live run.
    expect(screen.queryByText('run page')).not.toBeInTheDocument();
    expect(screen.getByTestId('where')).toHaveTextContent('/tasks');
    expect(within(r).getByRole('link', { name: 'Live run of Check fare' })).toHaveAttribute('href', `/runs/${RUN_ID}`);
    expect(within(r).getByRole('button', { name: 'Run again' })).toBeInTheDocument();
  });

  it('"Run with…" marks the usual policy and posts the chosen one', async () => {
    const host = mount({ [`POST /tasks/${TASK_ID}/runs`]: { id: RUN_ID } });
    const r = await row('Check fare');
    fireEvent.click(await within(r).findByRole('button', { name: 'Run with…' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByText('Balanced (usual)')).toBeInTheDocument();
    fireEvent.click(within(menu).getByText('Unlimited'));
    await screen.findByText('Run started');
    expect(posts(host, `/tasks/${TASK_ID}/runs`).map((p) => p.body)).toEqual([{ policyId: 'builtin:unlimited' }]);
    expect(screen.queryByText('run page')).not.toBeInTheDocument();
  });

  it('asks before starting a second run of a task that is running', async () => {
    const live = taskRow({ summary: { liveRunId: RUN_ID, lastRun: { id: RUN_ID, status: 'running', trigger: 'manual', createdAt: '2026-11-17T09:00:00Z', finishedAt: null } } });
    const host = mount({ 'GET /tasks': page([live]), [`POST /tasks/${TASK_ID}/runs`]: { id: 'new-run' } });
    const r = await row('Check fare');
    fireEvent.click(within(r).getByRole('button', { name: 'Run again' }));
    let dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('This task is already running. Start another run?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(posts(host, `/tasks/${TASK_ID}/runs`)).toHaveLength(0);
    fireEvent.click(within(r).getByRole('button', { name: 'Run again' }));
    dialog = await screen.findByRole('dialog');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Run again' }));
    await waitFor(() => expect(posts(host, `/tasks/${TASK_ID}/runs`)).toHaveLength(1));
  });

  it('names the task when the run cannot start, and leaves the list as it was', async () => {
    mount({ [`POST /tasks/${TASK_ID}/runs`]: () => Promise.reject(createTestApiError(409, 'No machine is available')) });
    const r = await row('Check fare');
    fireEvent.click(within(r).getByRole('button', { name: 'Run now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not start a run of “Check fare”: No machine is available');
    expect(within(r).getByText('Never run')).toBeInTheDocument();
    expect(within(r).getByRole('button', { name: 'Run now' })).toBeInTheDocument();
  });

  it('removes a task that no longer exists when an action finds it gone', async () => {
    mount({ [`POST /tasks/${TASK_ID}/runs`]: () => Promise.reject(createTestApiError(404, 'Task not found')) });
    const r = await row('Check fare');
    fireEvent.click(within(r).getByRole('button', { name: 'Run now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('This task no longer exists');
    await waitFor(() => expect(screen.queryByText('Check fare')).not.toBeInTheDocument());
    expect(screen.getByText('Weekly order')).toBeInTheDocument();
  });
});

describe('policy, model and spend', () => {
  it('names the policy with "(default)" and the model its start tier uses', async () => {
    mount({});
    const plain = await row('Check fare');
    // Follows the default (Balanced: starts on Standard, the deployment's model).
    await waitFor(() => expect(within(plain).getByText('Balanced (default)')).toBeInTheDocument());
    await waitFor(() => expect(within(plain).getByText('provider-a:model-std')).toBeInTheDocument());
    // Its own policy pins the Frontier tier it starts on.
    const pinned = await row('Weekly order');
    expect(within(pinned).getByText('Careful shopping')).toBeInTheDocument();
    expect(within(pinned).getByText('provider-a:model-big')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Policy' })).toBeInTheDocument();
    // Below xl, where the Policy column is hidden, the same two facts sit under the task's goal.
    expect(within(pinned).getByTestId('task-policy-line')).toHaveTextContent('Careful shopping · provider-a:model-big');
  });

  it('has no Policy column and a plain Run button without agent_policies:read', async () => {
    const host = mount({ [`POST /tasks/${TASK_ID}/runs`]: { id: RUN_ID } }, ['tasks:read', 'tasks:write', 'runs:read', 'runs:write']);
    const r = await row('Check fare');
    expect(screen.queryByRole('columnheader', { name: 'Policy' })).not.toBeInTheDocument();
    expect(screen.queryByText('Balanced (default)')).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run with…' })).not.toBeInTheDocument();
    expect(host.requests.some((q) => q.path.startsWith('/agent-policies'))).toBe(false);
    fireEvent.click(within(r).getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(posts(host, `/tasks/${TASK_ID}/runs`).map((p) => p.body)).toEqual([{}]));
  });

  it('keeps the list when the policy catalog fails to load: no Policy column, a plain Run button', async () => {
    mount({ 'GET /agent-policies': () => Promise.reject(createTestApiError(500, 'Policies are away')) });
    const r = await row('Check fare');
    await waitFor(() => expect(screen.queryByRole('columnheader', { name: 'Policy' })).not.toBeInTheDocument());
    expect(within(r).getByRole('button', { name: 'Run now' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run with…' })).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('shows the 30-day spend: the total, "≥" when part is unknown, a dash at zero', async () => {
    const spend = (costUsd: number, costKnown: boolean, runs = 12) => ({ runs, costUsd, costKnown, tokens: 1000, succeeded: runs ? 10 : 0, avgSuccessCostUsd: runs ? 0.35 : null });
    mount({
      'GET /tasks': page([
        taskRow({ name: 'Known', spend30d: spend(4.2, true) }),
        taskRow({ id: OTHER_ID, name: 'Partly', spend30d: spend(4.2, false) }),
        taskRow({ id: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', name: 'Idle', spend30d: spend(0, true, 0) }),
      ]),
    });
    expect(within(await row('Known')).getByLabelText('$4.20 in the last 30 days: 12 runs in the last 30 days · $0.35 per successful run')).toHaveTextContent('$4.20');
    expect(within(await row('Partly')).getByLabelText(/^≥ \$4\.20 in the last 30 days/)).toHaveTextContent('≥ $4.20');
    expect(within(await row('Idle')).getByLabelText('No runs in the last 30 days')).toHaveTextContent('—');
  });

  it('names the machine, with the profile and the allowed sites in its tooltip', async () => {
    const HOST = '44444444-4444-4444-8444-444444444444';
    mount(
      {
        'GET /tasks': page([taskRow({ hostId: HOST, hostFallback: false }), taskRow({ id: OTHER_ID, name: 'Anywhere' })]),
        'GET /fleet/hosts': [{ id: HOST, name: 'mini-pc' }],
      },
      [...ALL, 'fleet:read'],
    );
    const r = await row('Check fare');
    expect(await within(r).findByText('mini-pc only')).toHaveAttribute('aria-label', 'Profile: travel · Sites: flights.example.test');
    expect(within(await row('Anywhere')).getByText('Any')).toBeInTheDocument();
  });
});

describe('delete', () => {
  it('says what goes and what stays, deletes nothing on Cancel, and removes the row on Confirm', async () => {
    const big = scheduledRow({ summary: { schedules: [schedule(), schedule({ id: 's2' })], runCounts: { total: 148, last7d: { succeeded: 0, failed: 0, cancelled: 0 } } } });
    const host = mount({ 'GET /tasks': page([big, PINNED]), [`DELETE /tasks/${TASK_ID}`]: {} });
    const deletes = () => host.requests.filter((q) => q.method === 'DELETE').map((q) => q.path);
    const open = async () => {
      fireEvent.click(within(await row('Check fare')).getByRole('button', { name: 'More actions: Check fare' }));
      fireEvent.click(await screen.findByRole('menuitem', { name: 'Delete' }));
      return screen.findByRole('dialog');
    };
    let dialog = await open();
    expect(dialog).toHaveTextContent('Delete “Check fare”?');
    expect(dialog).toHaveTextContent('Its 2 schedules are deleted. Its 148 runs are kept in Runs as one-off runs.');
    expect(within(dialog).getByRole('button', { name: 'Delete' }).className).toMatch(/colorError/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(deletes()).toEqual([]);
    expect(screen.getByText('Check fare')).toBeInTheDocument();

    dialog = await open();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deletes()).toEqual([`/tasks/${TASK_ID}`]));
    await waitFor(() => expect(screen.queryByText('Check fare')).not.toBeInTheDocument());
    expect(await screen.findByText('Task deleted')).toBeInTheDocument();
    expect(screen.getByText('Weekly order')).toBeInTheDocument();
  });
});

describe('permissions', () => {
  it('without tasks:write: no New task, no Edit, Duplicate or Delete; the name is not a link to the form', async () => {
    mount({}, ['tasks:read', 'runs:read', 'runs:write']);
    const r = await row('Check fare');
    expect(screen.queryByRole('link', { name: 'New task' })).not.toBeInTheDocument();
    expect(within(r).queryByRole('link', { name: 'Add schedule' })).not.toBeInTheDocument();
    expect(within(r).getByRole('button', { name: 'Run now' })).toBeInTheDocument();
    fireEvent.click(within(r).getByRole('button', { name: 'More actions: Check fare' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'View runs' })).toBeInTheDocument();
    for (const name of ['Edit', 'Duplicate', 'Delete']) expect(within(menu).queryByRole('menuitem', { name })).not.toBeInTheDocument();
  });

  it('without runs:write: no Run control; with tasks:write the rest stays', async () => {
    mount({}, ['tasks:read', 'tasks:write']);
    const r = await row('Check fare');
    expect(screen.queryByRole('button', { name: 'Run now' })).not.toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New task' })).toBeInTheDocument();
    fireEvent.click(within(r).getByRole('button', { name: 'More actions: Check fare' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Edit' })).toBeInTheDocument();
    // Without runs:read there is no Runs page to send the person to.
    expect(within(menu).queryByRole('menuitem', { name: 'View runs' })).not.toBeInTheDocument();
  });

  it('a reader sees the list and nothing to change', async () => {
    mount({}, ['tasks:read']);
    const r = await row('Check fare');
    expect(within(r).queryByRole('button')).not.toBeInTheDocument();
    expect(within(r).queryByRole('link', { name: 'Check fare' })).not.toBeInTheDocument();
  });
});

describe('states', () => {
  it('with no task at all: the first-task message and three example goals that carry `goal`', async () => {
    mount({ 'GET /tasks': page([]) });
    expect(await screen.findByText('Create your first task')).toBeInTheDocument();
    expect(screen.getByText('A task is a goal your agent can run on demand or on a schedule.')).toBeInTheDocument();
    const examples = within(screen.getByRole('list', { name: 'Example tasks' })).getAllByRole('link');
    expect(examples.map((a) => a.getAttribute('href'))).toEqual([
      '/tasks/new?goal=Check%20my%20electricity%20bill%20and%20tell%20me%20the%20amount%20due',
      "/tasks/new?goal=Download%20last%20month's%20bank%20statement",
      '/tasks/new?goal=Renew%20my%20library%20loans',
    ]);
    expect(screen.queryByRole('textbox', { name: 'Search tasks' })).not.toBeInTheDocument();
  });

  it('shows a load failure with Retry', async () => {
    let fail = true;
    mount({ 'GET /tasks': () => (fail ? Promise.reject(createTestApiError(500, 'The API is away')) : page([PLAIN])) });
    expect(await screen.findByRole('alert')).toHaveTextContent('The API is away');
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Check fare')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });

  it('with 200 tasks: renders the first 50 and loads more on demand, by cursor', async () => {
    const all = Array.from({ length: 200 }, (_v, i) => taskRow({ id: `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`, name: `Task ${i + 1}` }));
    const host = mount({
      'GET /tasks': (r: TestApiRequest) => {
        const q = new URLSearchParams(r.path.split('?')[1]);
        const start = Number(q.get('cursor') ?? 0);
        const limit = Number(q.get('limit'));
        return page(all.slice(start, start + limit), { total: 200, nextCursor: start + limit < 200 ? String(start + limit) : null });
      },
    });
    await screen.findByText('Task 1');
    expect(screen.getAllByRole('row')).toHaveLength(51); // the header and 50 tasks
    expect(screen.getByText('50 of 200 tasks')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Task 100')).toBeInTheDocument();
    expect(screen.getAllByRole('row')).toHaveLength(101);
    expect(lastList(host).get('cursor')).toBe('50');
    expect(screen.getByText('100 of 200 tasks')).toBeInTheDocument();
  });

  it('refreshes on window focus, and a row with a live run every 5 s', async () => {
    const live = taskRow({ summary: { liveRunId: RUN_ID, lastRun: { id: RUN_ID, status: 'running', trigger: 'manual', createdAt: '2026-11-17T09:00:00Z', finishedAt: null } } });
    const done = taskRow({ summary: { liveRunId: null, lastRun: { id: RUN_ID, status: 'succeeded', trigger: 'manual', createdAt: '2026-11-17T09:00:00Z', finishedAt: '2026-11-17T09:03:00Z' } } });
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const host = mount({ 'GET /tasks': page([live]), [`GET /tasks/${TASK_ID}`]: done });
    const r = await row('Check fare');
    expect(listRequests(host)).toHaveLength(1);
    fireEvent.focus(window);
    await waitFor(() => expect(listRequests(host)).toHaveLength(2));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TASK_LIVE_REFRESH_MS + 50);
    });
    expect(host.requests.some((q) => q.path === `/tasks/${TASK_ID}?include=summary`)).toBe(true);
    await waitFor(() => expect(within(r).getByRole('link', { name: 'Last run of Check fare: succeeded' })).toBeInTheDocument());
    expect(within(r).getByRole('button', { name: 'Run now' })).toBeInTheDocument();
  });
});

describe('layout', () => {
  it('is a table at md and up, with the header button and no floating button', async () => {
    restoreViewport = mockViewport(1440);
    mount({});
    await screen.findByText('Check fare');
    expect(screen.getByRole('table', { name: 'Tasks' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New task' }).className).not.toMatch(/MuiFab/);
  });

  it('is cards on a tablet, still without the floating button', async () => {
    restoreViewport = mockViewport(768);
    mount({});
    await screen.findByText('Check fare');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(screen.getByLabelText('Task Check fare')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New task' }).className).not.toMatch(/MuiFab/);
  });

  it('on a phone: cards with the policy, model and spend line, a Sort menu, and New task as a floating button', async () => {
    restoreViewport = mockViewport(390);
    const host = mount({
      'GET /tasks': page([scheduledRow({ spend30d: { runs: 3, costUsd: 4.2, costKnown: true, tokens: 10, succeeded: 3, avgSuccessCostUsd: 1.4 } })]),
      [`POST /tasks/${TASK_ID}/runs`]: { id: RUN_ID },
    });
    const card = await screen.findByLabelText('Task Check fare');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    await waitFor(() => expect(within(card).getByTestId('task-policy-line')).toHaveTextContent('Balanced (default) · provider-a:model-std · $4.20 in 30 days'));
    expect(within(card).getByRole('switch', { name: 'Scheduled: Check fare' })).toBeChecked();
    expect(within(card).getByText('Scheduled')).toBeInTheDocument();
    // The only "New task" is the floating button.
    const fab = screen.getByRole('link', { name: 'New task' });
    expect(fab.className).toMatch(/MuiFab/);
    expect(fab).toHaveAttribute('href', '/tasks/new');
    // Sort is an icon menu.
    expect(screen.queryByRole('combobox', { name: 'Sort' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Sort: Newest' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Name' }));
    await waitFor(() => expect(lastList(host).get('sort')).toBe('name_asc'));
    // The card body opens the task; its controls do not.
    fireEvent.click(within(card).getByRole('button', { name: 'Run now' }));
    await screen.findByText('Run started');
    expect(screen.getByTestId('where')).toHaveTextContent('/tasks?sort=name_asc');
    fireEvent.click(within(card).getByText('Find the cheapest fare'));
    expect(await screen.findByText('edit task page')).toBeInTheDocument();
  });

  it('builds the request path of a query', () => {
    expect(taskListPath({ q: ' fare ', filter: 'paused', sort: 'spend_desc', policyId: 'default' }, 50, 'abc')).toBe(
      '/tasks?envelope=1&include=summary&limit=50&q=fare&filter=paused&sort=spend_desc&policyId=default&cursor=abc',
    );
  });
});

// Kept from the earlier page's test (TasksRuns.test.tsx): a reader sees the tasks and cannot create or run.
describe('a reader', () => {
  it('sees tasks without the create and run controls', async () => {
    const tasks: TaskWithSummary[] = [PLAIN];
    mount({ 'GET /tasks': page(tasks) }, ['tasks:read']);
    expect(await screen.findByText('Check fare')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run now' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: 'New task' })).not.toBeInTheDocument();
  });
});
