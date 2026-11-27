// The task page (#428): the overview, the statistics and their periods, the
// embedded run list, the live banner, the header's actions, the schedules
// (switch, add, edit with a policy override, delete, the failing warning),
// the configuration (policy and model), permissions, 404 and the layout.
import { act, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestApiError, createTestPlatformHost, type TestPlatformHost } from '@marinoscar/platform-web/testing';

vi.mock('../live', () => ({ subscribeRun: () => () => undefined, fetchRunScreenshot: async () => null }));
// The chart library draws SVG that jsdom cannot measure; the page's own part (the tiles and the data table) is what is tested.
vi.mock('../components/TaskStatsChart', () => ({ default: ({ days, describedBy }: { days: unknown[]; describedBy: string }) => <div data-testid="chart" data-days={days.length} aria-describedby={describedBy} /> }));

import { durationWords, goalIsLong, nextSchedule, statsSpend, stoppedWords, successRate, TASK_DETAIL_LIVE_REFRESH_MS } from '../components/taskDetail';
import { taskPaths } from '../components/taskList';
import { TaskDetailPage } from '../pages/TaskDetailPage';
import type { RunListItem } from '../types/runs';
import type { TaskStats, TaskWithSummary } from '../types/tasks';
import { ConfirmProvider, ToastHost, dismissToast } from '../ui';
import { mockViewport } from './matchMedia';
import { OWN_ID, POLICY_READS } from './policyFixtures';
import { RUN_ID, TASK_ID, schedule, scheduledRow, summary, taskRow } from './taskFixtures';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

const ALL = ['tasks:read', 'tasks:write', 'runs:read', 'runs:write', 'runs:delete', 'agent_policies:read', 'fleet:read'];
const SCHEDULE_ID = schedule().id;
const HOST_ID = '44444444-4444-4444-8444-444444444444';
const HOSTS = [{ id: HOST_ID, name: 'home-mini', version: '1', online: false, browserConnected: false, onDemand: false, draining: false, viewerUrl: null, mode: 'unattended', desktop: false, profiles: [], lastSeen: '2026-11-16T00:00:00Z' }];

function series(days: number): TaskStats['series'] {
  return Array.from({ length: days }, (_, i) => ({ date: new Date(Date.UTC(2026, 9, 18 + i)).toISOString().slice(0, 10), succeeded: i % 3, failed: i % 5 === 0 ? 1 : 0, cancelled: 0, costUsd: 0.1 }));
}
function stats(days = 30, extra: Partial<TaskStats> = {}, totals: Partial<TaskStats['totals']> = {}): TaskStats {
  return {
    days,
    timezone: 'UTC',
    totals: { runs: 26, succeeded: 23, failed: 2, cancelled: 1, successRate: 0.92, costUsd: 4.2, costKnown: true, ...totals },
    avgDurationSeconds: 200,
    p95DurationSeconds: 540,
    avgSteps: 12.4,
    avgCostPerSuccessUsd: 0.18,
    series: series(days),
    stopReasons: [{ reason: 'finished', count: 23 }],
    ...extra,
  };
}
function runItem(over: Partial<RunListItem> = {}): RunListItem {
  return {
    id: RUN_ID,
    taskId: TASK_ID,
    taskName: 'Check fare',
    status: 'succeeded',
    trigger: 'schedule',
    goal: 'Find the cheapest fare',
    profile: 'travel',
    result: null,
    error: null,
    cancelRequested: false,
    stepCount: 4,
    costUsd: 0.2,
    costKnown: true,
    modelCalls: 3,
    stopReason: 'finished',
    policy: null,
    createdAt: '2026-11-16T09:00:00Z',
    startedAt: '2026-11-16T09:00:01Z',
    finishedAt: '2026-11-16T09:03:00Z',
    ...over,
  };
}
const COUNTS = { total: 1, live: 0, byStatus: { queued: 0, running: 0, waiting_human: 0, succeeded: 1, failed: 0, cancelled: 0 }, costUsd: 0.2, costKnown: true };
const LAST = { id: RUN_ID, status: 'succeeded', trigger: 'schedule', createdAt: '2026-11-16T09:00:00Z', finishedAt: '2026-11-16T09:03:00Z' };
const TASK = scheduledRow({ createdAt: '2026-11-01T10:00:00Z', updatedAt: '2026-11-10T10:00:00Z', summary: { lastRun: LAST, runCounts: { total: 26, last7d: { succeeded: 5, failed: 1, cancelled: 0 } } } });

let restoreViewport: (() => void) | null = null;
afterEach(() => {
  restoreViewport?.();
  restoreViewport = null;
  vi.useRealTimers();
  dismissToast();
});

function Where() {
  const location = useLocation();
  return <div data-testid="where">{`${location.pathname}${location.search}`}</div>;
}

function mount(task: TaskWithSummary | null = TASK, responses: Record<string, unknown> = {}, permissions: string[] = ALL, entry = `/tasks/${TASK_ID}`): TestPlatformHost {
  const host = createTestPlatformHost({
    permissions,
    responses: {
      ...POLICY_READS,
      'GET /fleet/hosts': HOSTS,
      ...(task ? { [`GET /tasks/${TASK_ID}`]: task } : {}),
      [`GET /tasks/${TASK_ID}/stats`]: (req: { path: string }) => stats(Number(new URLSearchParams(req.path.split('?')[1]).get('days'))),
      'GET /runs': { items: [runItem()], nextCursor: null },
      'GET /runs/counts': COUNTS,
      [`GET /tasks/${TASK_ID}/mail-triggers`]: [],
      'GET /schedules': [{ ...schedule(), taskId: TASK_ID, lastRunId: RUN_ID }],
      'POST /schedules/preview': (req: { body?: unknown }) => {
        const { cron, timezone = 'UTC' } = req.body as { cron: string; timezone?: string };
        return { valid: true, cron, timezone, description: `Runs on ${cron}`, next: ['2026-11-18T15:00:00.000Z'], intervalSeconds: null };
      },
      ...responses,
    },
  });
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[entry]}>
          <Where />
          <ToastHost />
          <Routes>
            <Route path="/tasks/:id" element={<TaskDetailPage />} />
            <Route path="/tasks" element={<div>tasks list</div>} />
            <Route path="/tasks/:id/edit" element={<div>edit task page</div>} />
            <Route path="/runs/:id" element={<div>run page</div>} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  return host;
}

const loaded = () => screen.findByRole('heading', { level: 1, name: TASK.name });
const reject = (status: number, message: string) => () => Promise.reject(createTestApiError(status, message));
const requests = (host: TestPlatformHost, method: string, prefix: string) => host.requests.filter((r) => r.method === method && r.path.startsWith(prefix));
const where = () => screen.getByTestId('where').textContent;

describe('the task page: overview', () => {
  it('renders the name, the schedule sentence, the goal, the configuration with policy and model, and the run list scoped to the task', async () => {
    const host = mount();
    await loaded();
    expect(screen.getByText(/Next run/).closest('p')).toHaveTextContent(/Next run .* · Monday to Friday at 09:00/);
    expect(screen.getByTestId('task-goal')).toHaveTextContent('Find the cheapest fare');
    expect(screen.getByRole('link', { name: '← Tasks' })).toHaveAttribute('href', '/tasks');

    // Configuration: the policy with "(default)", its tiers and budget, and the start-tier model (ported from the task card).
    const policy = await screen.findByTestId('task-policy');
    expect(policy).toHaveTextContent('Balanced (default)');
    expect(policy).toHaveAttribute('href', '/settings/agent-policies');
    expect(screen.getByText('Standard → Frontier · 60 actions · $2 · 20 min')).toBeInTheDocument();
    expect(screen.getByTestId('task-model')).toHaveTextContent('provider-a:model-std');
    expect(screen.getByText('Any available machine')).toBeInTheDocument();
    expect(screen.getByText('travel')).toBeInTheDocument();
    expect(screen.getByText('flights.example.test')).toBeInTheDocument();
    expect(screen.getByText('Ask before risky steps').nextSibling).toHaveTextContent('No');
    expect(screen.getByText('Created')).toBeInTheDocument();
    expect(screen.getByText('Last edited')).toBeInTheDocument();

    // The run history is the Runs list fixed to this task.
    await waitFor(() => expect(requests(host, 'GET', '/runs?').some((r) => new URLSearchParams(r.path.split('?')[1]).get('taskId') === TASK_ID && r.path.includes('limit=25'))).toBe(true));
    // Every run of the task has the task's goal: the embedded table has no Goal column, and keeps the cost.
    await screen.findByRole('columnheader', { name: 'Status' });
    expect(screen.queryByRole('columnheader', { name: 'Goal' })).toBeNull();
    expect(screen.getByRole('columnheader', { name: 'Cost' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Open in Runs' })).toHaveAttribute('href', `/runs?taskId=${TASK_ID}`);
    expect(requests(host, 'GET', `/tasks/${TASK_ID}?include=summary`)).toHaveLength(1);
    expect(taskPaths.runs(TASK_ID)).toBe(`/tasks/${TASK_ID}#runs`);
  });

  it('says how an unscheduled or a paused task runs', async () => {
    mount(taskRow());
    await loaded();
    expect(screen.getByText('Runs only when you start it')).toBeInTheDocument();
    expect(screen.getByText('Not scheduled')).toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: /^Scheduled/ })).toBeNull();
  });

  it('a paused task reads "Schedule paused"', async () => {
    mount(scheduledRow({ summary: { schedules: [schedule({ enabled: false, nextRunAt: null })], scheduleState: 'paused', nextRunAt: null } }));
    await loaded();
    expect(screen.getByText('Schedule paused')).toBeInTheDocument();
  });

  it('an own policy links to its editor; a deleted one falls back to the default and says so', async () => {
    mount({ ...TASK, policyId: OWN_ID });
    await loaded();
    const own = await screen.findByTestId('task-policy');
    expect(own).toHaveTextContent('Careful shopping');
    expect(own).toHaveAttribute('href', `/settings/agent-policies/${OWN_ID}`);
    expect(screen.getByTestId('task-model')).toHaveTextContent('provider-a:model-big');
  });

  it('a deleted policy reads "Default (name): this task\'s policy was deleted."', async () => {
    mount({ ...TASK, policyId: '99999999-9999-4999-8999-999999999999' });
    await loaded();
    expect((await screen.findByTestId('task-policy')).closest('dd')).toHaveTextContent("Default (Balanced): this task's policy was deleted.");
  });

  it('a pinned machine shows its name, "only" without fallback, and the offline warning', async () => {
    mount({ ...TASK, hostId: HOST_ID, hostFallback: false });
    await loaded();
    expect(await screen.findByText(/home-mini only/)).toBeInTheDocument();
    expect(screen.getByText('home-mini is offline right now. Runs will fail until it is back.')).toBeInTheDocument();
  });

  it('copies the goal', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true });
    mount();
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Copy the goal' }));
    expect(writeText).toHaveBeenCalledWith('Find the cheapest fare');
    expect(await screen.findByText('Goal copied')).toBeInTheDocument();
  });

  it('a task that does not exist renders the "does not exist" state with a link to Tasks', async () => {
    mount(null, { [`GET /tasks/${TASK_ID}`]: reject(404, 'Task not found') });
    expect(await screen.findByText('This task does not exist')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Back to Tasks' })).toHaveAttribute('href', '/tasks');
  });
});

describe('the task page: statistics', () => {
  it('shows the tiles from /stats, the p95 in the tooltip, and re-requests with days=7|30|90', async () => {
    const host = mount();
    await loaded();
    expect(await screen.findByTestId('stat-success')).toHaveTextContent('92 %');
    expect(screen.getByTestId('stat-success')).toHaveTextContent('of 25 finished runs · 1 cancelled not counted');
    expect(screen.getByTestId('stat-runs')).toHaveTextContent('26');
    expect(screen.getByTestId('stat-runs')).toHaveTextContent('last 30 days');
    expect(screen.getByTestId('stat-duration')).toHaveTextContent('3 min 20 s');
    expect(screen.getByLabelText('95 % of runs finish within 9 min')).toBe(screen.getByTestId('stat-duration'));
    expect(screen.getByTestId('stat-spend')).toHaveTextContent('$4.20');
    expect(screen.getByTestId('stat-spend')).toHaveTextContent('avg $0.18 per successful run');
    expect(within(screen.getByTestId('stat-last-run')).getByText('succeeded')).toBeInTheDocument();
    expect(requests(host, 'GET', `/tasks/${TASK_ID}/stats`).map((r) => r.path)).toEqual([`/tasks/${TASK_ID}/stats?days=30`]);

    fireEvent.click(screen.getByRole('button', { name: '7 days' }));
    await waitFor(() => expect(screen.getByTestId('stat-runs')).toHaveTextContent('last 7 days'));
    fireEvent.click(screen.getByRole('button', { name: '90 days' }));
    await waitFor(() => expect(screen.getByTestId('stat-runs')).toHaveTextContent('last 90 days'));
    expect(requests(host, 'GET', `/tasks/${TASK_ID}/stats`).map((r) => r.path.split('?')[1])).toEqual(['days=30', 'days=7', 'days=90']);
  });

  it('the chart has a hidden data table with one row per day, which describes it', async () => {
    mount();
    await loaded();
    const chart = await screen.findByTestId('chart');
    const table = screen.getByRole('table', { name: /Runs per day, last 30 days/ });
    expect(chart).toHaveAttribute('aria-describedby', table.id);
    // The clipping box is a div around the table: a table does not honour `width: 1px` and would widen the page.
    expect(table.parentElement).toHaveAttribute('data-testid', 'task-stats-table');
    expect(table.parentElement).toHaveStyle({ position: 'absolute', width: '1px', overflow: 'hidden' });
    expect(table).not.toHaveStyle({ position: 'absolute' });
    expect(within(table).getAllByRole('row')).toHaveLength(31);
    expect(within(table).getByRole('rowheader', { name: 'Oct 18' })).toBeInTheDocument();
    expect(chart).toHaveAttribute('data-days', '30');
  });

  it('on a phone the chart draws the last 14 days; the table keeps every day', async () => {
    restoreViewport = mockViewport(390);
    mount();
    await loaded();
    expect(await screen.findByTestId('chart')).toHaveAttribute('data-days', '14');
    expect(within(screen.getByRole('table', { name: /Runs per day/ })).getAllByRole('row')).toHaveLength(31);
  });

  it('with no finished run the success rate reads "n/a"', async () => {
    mount(TASK, { [`GET /tasks/${TASK_ID}/stats`]: stats(30, { avgDurationSeconds: null, p95DurationSeconds: null, avgSteps: null, avgCostPerSuccessUsd: null }, { runs: 0, succeeded: 0, failed: 0, cancelled: 0, successRate: null, costUsd: null }) });
    await loaded();
    expect(await screen.findByTestId('stat-success')).toHaveTextContent('n/a');
    expect(screen.getByTestId('stat-duration')).toHaveTextContent('n/a');
    expect(screen.getByText('No runs in the last 30 days.')).toBeInTheDocument();
  });

  it('spend is "≥" when partly unknown and absent when there is no cost', async () => {
    mount(TASK, { [`GET /tasks/${TASK_ID}/stats`]: stats(30, {}, { costKnown: false }) });
    await loaded();
    expect(await screen.findByTestId('stat-spend')).toHaveTextContent('≥ $4.20');
    expect(screen.getByTestId('stat-spend')).toHaveTextContent('avg ≥ $0.18 per successful run');

    expect(statsSpend(stats(30, { avgCostPerSuccessUsd: null }, { costUsd: null }))).toBeNull();
    // A deployment without model prices: a lower bound of zero is not a number worth showing.
    expect(statsSpend(stats(30, {}, { costUsd: 0, costKnown: false }))).toBeNull();
    expect(statsSpend(stats(30, { avgCostPerSuccessUsd: null }))).toEqual({ value: '$4.20', detail: null });
  });

  it('the spend tile is absent when cost is null', async () => {
    mount(TASK, { [`GET /tasks/${TASK_ID}/stats`]: stats(30, { avgCostPerSuccessUsd: null }, { costUsd: null }) });
    await loaded();
    await screen.findByTestId('stat-success');
    expect(screen.queryByTestId('stat-spend')).toBeNull();
  });

  it('a last run stopped by a budget or a stall says so in words', async () => {
    mount({ ...TASK, summary: { ...TASK.summary, lastRun: { ...LAST, status: 'failed' } } }, { 'GET /runs': { items: [runItem({ status: 'failed', stopReason: 'budget_cost' })], nextCursor: null } });
    await loaded();
    expect(await within(await screen.findByTestId('stat-last-run')).findByText('Stopped: cost budget')).toBeInTheDocument();
    expect(stoppedWords('stalled')).toBe('Stopped: stalled');
    expect(stoppedWords('error')).toBeNull();
    expect(stoppedWords('finished')).toBeNull();
  });

  it('a stats failure leaves "Could not load statistics · Retry" and the rest of the page', async () => {
    let fail = true;
    const host = mount(TASK, { [`GET /tasks/${TASK_ID}/stats`]: () => (fail ? Promise.reject(createTestApiError(500, 'boom')) : stats()) });
    await loaded();
    expect(await screen.findByText(/Could not load statistics/)).toBeInTheDocument();
    expect(screen.getByTestId('task-goal')).toBeInTheDocument();
    await waitFor(() => expect(requests(host, 'GET', '/runs?').length).toBeGreaterThan(0));
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('stat-success')).toHaveTextContent('92 %');
  });

  it('the words of the statistics', () => {
    expect(durationWords(45)).toBe('45 s');
    expect(durationWords(200)).toBe('3 min 20 s');
    expect(durationWords(180)).toBe('3 min');
    expect(durationWords(7500)).toBe('2 h 5 min');
    expect(successRate(stats().totals)).toEqual({ value: '92 %', detail: 'of 25 finished runs · 1 cancelled not counted' });
    expect(goalIsLong('short')).toBe(false);
    expect(goalIsLong('line\n'.repeat(7))).toBe(true);
    expect(goalIsLong('x'.repeat(400))).toBe(true);
    const two = summary({ schedules: [schedule({ id: 'a', nextRunAt: '2099-02-01T00:00:00Z' }), schedule({ id: 'b', nextRunAt: '2099-01-01T00:00:00Z', description: 'Every day at 07:00' })], scheduleState: 'active', nextRunAt: '2099-01-01T00:00:00Z' });
    expect(nextSchedule(two)?.id).toBe('b');
  });
});

describe('the task page: a live run', () => {
  const liveTask = (status: string) => ({ ...TASK, summary: { ...TASK.summary, liveRunId: RUN_ID, lastRun: { ...LAST, status, finishedAt: null } } });

  it('shows "Running now" with the activity line and Watch, and refreshes every 5 s', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const host = mount(liveTask('running'), {
      'GET /runs': { items: [runItem({ status: 'running', finishedAt: null, stopReason: null, activity: { phase: 'thinking', startedAt: '2026-11-16T09:00:05Z' } })], nextCursor: null },
    });
    await loaded();
    const banner = await screen.findByTestId('task-live-banner');
    await waitFor(() => expect(banner).toHaveTextContent('Running now: Thinking about the next step'));
    // In the embedded list, what the run is doing sits under its status.
    expect(await screen.findByTestId('run-activity')).toHaveTextContent('Thinking about the next step');
    expect(within(banner).getByRole('link', { name: 'Watch' })).toHaveAttribute('href', `/runs/${RUN_ID}`);
    expect(host.requests.some((r) => r.path === `/runs?envelope=1&taskId=${TASK_ID}&limit=1&state=live`)).toBe(true);
    expect(screen.getByRole('button', { name: 'Run again' })).toBeInTheDocument();

    const before = requests(host, 'GET', `/tasks/${TASK_ID}?include=summary`).length;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(TASK_DETAIL_LIVE_REFRESH_MS + 50);
    });
    expect(requests(host, 'GET', `/tasks/${TASK_ID}?include=summary`).length).toBe(before + 1);
  });

  it('shows "Needs you" with Answer to the Inbox when the run waits for a person', async () => {
    mount(liveTask('waiting_human'), { 'GET /runs': { items: [runItem({ status: 'waiting_human', finishedAt: null, stopReason: null })], nextCursor: null } });
    await loaded();
    const banner = await screen.findByTestId('task-live-banner');
    expect(banner).toHaveTextContent('Needs you');
    expect(within(banner).getByRole('link', { name: 'Answer' })).toHaveAttribute('href', `/inbox?run=${RUN_ID}`);
  });

  it('Run again asks first; a refusal starts nothing', async () => {
    const host = mount(liveTask('running'), { [`POST /tasks/${TASK_ID}/runs`]: { id: RUN_ID } });
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Run again' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('This task is already running');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(requests(host, 'POST', `/tasks/${TASK_ID}/runs`)).toHaveLength(0);
  });
});

describe('the task page: actions', () => {
  it('Run navigates to the new run', async () => {
    const host = mount(TASK, { [`POST /tasks/${TASK_ID}/runs`]: { id: RUN_ID } });
    await loaded();
    await screen.findByRole('button', { name: 'Run with…' });
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    await waitFor(() => expect(where()).toBe(`/runs/${RUN_ID}`));
    expect(requests(host, 'POST', `/tasks/${TASK_ID}/runs`)[0]!.body).toEqual({});
  });

  it('"Run with…" sends the chosen policy for that run', async () => {
    const host = mount(TASK, { [`POST /tasks/${TASK_ID}/runs`]: { id: RUN_ID } });
    await loaded();
    fireEvent.click(await screen.findByRole('button', { name: 'Run with…' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Careful shopping/ }));
    await waitFor(() => expect(where()).toBe(`/runs/${RUN_ID}`));
    expect(requests(host, 'POST', `/tasks/${TASK_ID}/runs`)[0]!.body).toEqual({ policyId: OWN_ID });
  });

  it('a failed start stays on the page and says why', async () => {
    mount(TASK, { [`POST /tasks/${TASK_ID}/runs`]: reject(409, 'No machine is available') });
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Run now' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('Could not start a run of “Check fare”: No machine is available');
    expect(where()).toBe(`/tasks/${TASK_ID}`);
  });

  it('the Scheduled switch pauses and resumes every schedule of the task', async () => {
    const paused = { ...TASK, summary: { ...TASK.summary, scheduleState: 'paused' as const, nextRunAt: null, schedules: [schedule({ enabled: false, nextRunAt: null })] } };
    const host = mount(TASK, { [`POST /tasks/${TASK_ID}/schedules/pause`]: { ...paused, skipped: [] }, [`POST /tasks/${TASK_ID}/schedules/resume`]: { ...TASK, skipped: [] } });
    await loaded();
    const toggle = screen.getByRole('switch', { name: 'Scheduled: Check fare' });
    expect(toggle).toBeChecked();
    fireEvent.click(toggle);
    expect(await screen.findByText('Schedule paused')).toBeInTheDocument();
    expect(requests(host, 'POST', `/tasks/${TASK_ID}/schedules/pause`)).toHaveLength(1);
    fireEvent.click(screen.getByRole('switch', { name: 'Scheduled: Check fare' }));
    await waitFor(() => expect(requests(host, 'POST', `/tasks/${TASK_ID}/schedules/resume`)).toHaveLength(1));
    await waitFor(() => expect(screen.queryByText('Schedule paused')).toBeNull());
  });

  it('Edit and Duplicate link to the form; Delete confirms, deletes and goes to Tasks with a snackbar', async () => {
    const host = mount(TASK, { [`DELETE /tasks/${TASK_ID}`]: undefined });
    await loaded();
    // The header's button and the configuration's link.
    for (const edit of screen.getAllByRole('link', { name: 'Edit' })) expect(edit).toHaveAttribute('href', `/tasks/${TASK_ID}/edit`);
    fireEvent.click(screen.getByRole('button', { name: 'More actions: Check fare' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getByRole('menuitem', { name: 'Duplicate' })).toHaveAttribute('href', `/tasks/new?from=${TASK_ID}`);
    expect(within(menu).queryByRole('menuitem', { name: 'Open' })).toBeNull();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Delete “Check fare”?');
    expect(dialog).toHaveTextContent('Its schedule is deleted. Its 26 runs are kept in Runs as one-off runs.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(where()).toBe('/tasks'));
    expect(requests(host, 'DELETE', `/tasks/${TASK_ID}`)).toHaveLength(1);
    expect(await screen.findByText('Task deleted')).toBeInTheDocument();
  });
});

describe('the task page: schedules', () => {
  const row = async () => (await screen.findAllByTestId('task-schedule'))[0]!;

  it('a schedule row shows its policy override and last run; its switch pauses that schedule only', async () => {
    const host = mount({ ...TASK, summary: { ...TASK.summary, schedules: [schedule({ policyId: OWN_ID, lastRunAt: '2026-11-16T09:00:00Z' })] } }, { [`PATCH /schedules/${SCHEDULE_ID}`]: { ...schedule({ enabled: false }), taskId: TASK_ID } });
    await loaded();
    const first = await row();
    await waitFor(() => expect(first).toHaveTextContent('Monday to Friday at 09:00 · policy: Careful shopping'));
    await waitFor(() => expect(within(first).getByRole('link', { name: /last run/ })).toHaveAttribute('href', `/runs/${RUN_ID}`));
    fireEvent.click(within(first).getByRole('switch', { name: 'Active: Monday to Friday at 09:00' }));
    await waitFor(() => expect(requests(host, 'PATCH', `/schedules/${SCHEDULE_ID}`)).toHaveLength(1));
    expect(requests(host, 'PATCH', `/schedules/${SCHEDULE_ID}`)[0]!.body).toEqual({ enabled: false });
    expect(requests(host, 'POST', `/tasks/${TASK_ID}/schedules/pause`)).toHaveLength(0);
    // The task is read again after the change.
    await waitFor(() => expect(requests(host, 'GET', `/tasks/${TASK_ID}?include=summary`).length).toBeGreaterThan(1));
  });

  it('warns once a schedule failed three times in a row, with a link to its last run', async () => {
    mount({ ...TASK, summary: { ...TASK.summary, schedules: [schedule({ consecutiveFailures: 3, lastRunAt: '2026-11-16T09:00:00Z' })] } });
    await loaded();
    const first = await row();
    expect(within(first).getByRole('alert')).toHaveTextContent('Failed 3 times in a row.');
    await waitFor(() => expect(within(first).getByRole('link', { name: 'See the last run' })).toHaveAttribute('href', `/runs/${RUN_ID}`));
  });

  it('two failures do not warn', async () => {
    mount({ ...TASK, summary: { ...TASK.summary, schedules: [schedule({ consecutiveFailures: 2 })] } });
    await loaded();
    expect(within(await row()).queryByRole('alert')).toBeNull();
  });

  it('edits a schedule in a dialog: the expression and the policy override are saved with PATCH /schedules/:id', async () => {
    const host = mount(TASK, { [`PATCH /schedules/${SCHEDULE_ID}`]: { ...schedule(), taskId: TASK_ID } });
    await loaded();
    fireEvent.click(within(await row()).getByRole('button', { name: 'Edit schedule: Monday to Friday at 09:00' }));
    const dialog = await screen.findByRole('dialog', { name: 'Edit schedule' });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Advanced' }));
    fireEvent.change(within(dialog).getByLabelText('Cron expression'), { target: { value: '30 7 * * *' } });
    fireEvent.mouseDown(within(dialog).getByRole('combobox', { name: /Policy override/ }));
    fireEvent.click(await screen.findByRole('option', { name: /Careful shopping/ }));
    const save = within(dialog).getByRole('button', { name: 'Save' });
    await waitFor(() => expect(save).toBeEnabled());
    fireEvent.click(save);
    await waitFor(() => expect(requests(host, 'PATCH', `/schedules/${SCHEDULE_ID}`)).toHaveLength(1));
    expect(requests(host, 'PATCH', `/schedules/${SCHEDULE_ID}`)[0]!.body).toEqual({ cron: '30 7 * * *', timezone: 'UTC', enabled: true, concurrency: 'skip', policyId: OWN_ID });
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('adds a schedule with POST /schedules; a refusal stays in the dialog', async () => {
    let refuse = true;
    const host = mount(taskRow(), { 'POST /schedules': () => (refuse ? Promise.reject(createTestApiError(409, 'A task can have at most 10 schedules')) : { ...schedule(), taskId: TASK_ID }) });
    await loaded();
    fireEvent.click(screen.getByRole('button', { name: 'Add a schedule' }));
    const dialog = await screen.findByRole('dialog', { name: 'Add a schedule' });
    const add = within(dialog).getByRole('button', { name: 'Add' });
    await waitFor(() => expect(add).toBeEnabled());
    fireEvent.click(add);
    expect(await within(dialog).findByRole('alert')).toHaveTextContent('A task can have at most 10 schedules');
    refuse = false;
    fireEvent.click(add);
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    const body = requests(host, 'POST', '/schedules').filter((r) => r.path === '/schedules').at(-1)!.body as Record<string, unknown>;
    expect(body).toMatchObject({ taskId: TASK_ID, cron: '0 9 * * *', enabled: true, concurrency: 'skip', policyId: null });
    expect(body).not.toHaveProperty('id');
  });

  it('deletes a schedule after asking; an error shows on that row', async () => {
    let fail = true;
    const host = mount(TASK, { [`DELETE /schedules/${SCHEDULE_ID}`]: () => (fail ? Promise.reject(createTestApiError(500, 'The schedule could not be deleted')) : undefined) });
    await loaded();
    const first = await row();
    fireEvent.click(within(first).getByRole('button', { name: 'Delete schedule: Monday to Friday at 09:00' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(await within(first).findByRole('alert')).toHaveTextContent('The schedule could not be deleted');
    fail = false;
    fireEvent.click(within(first).getByRole('button', { name: 'Delete schedule: Monday to Friday at 09:00' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(requests(host, 'DELETE', `/schedules/${SCHEDULE_ID}`)).toHaveLength(2));
    await waitFor(() => expect(within(first).queryByRole('alert')).toBeNull());
  });
});

describe('the task page: permissions and failures', () => {
  it('without runs:read the statistics and the runs are absent', async () => {
    const host = mount(TASK, {}, ['tasks:read', 'tasks:write', 'agent_policies:read']);
    await loaded();
    await screen.findByTestId('task-policy');
    expect(screen.queryByRole('region', { name: 'Statistics' })).toBeNull();
    expect(screen.queryByRole('heading', { name: 'Runs' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Run now' })).toBeNull();
    expect(host.requests.some((r) => r.path.startsWith('/runs') || r.path.includes('/stats') || r.path.startsWith('/schedules'))).toBe(false);
  });

  it('without tasks:write the write controls are absent', async () => {
    mount(TASK, {}, ['tasks:read', 'runs:read', 'agent_policies:read']);
    await loaded();
    await screen.findByTestId('task-policy');
    expect(screen.getByText('Scheduled')).toBeInTheDocument();
    for (const name of [/^Scheduled:/, /^Active:/]) expect(screen.queryByRole('switch', { name })).toBeNull();
    expect(screen.queryByRole('link', { name: 'Edit' })).toBeNull();
    for (const name of [/^More actions/, 'Add a schedule', /^Edit schedule/, /^Delete schedule/]) expect(screen.queryByRole('button', { name })).toBeNull();
  });

  it('without agent_policies:read the policy and model rows are absent and Run is a plain button', async () => {
    const host = mount(TASK, {}, ['tasks:read', 'tasks:write', 'runs:read', 'runs:write']);
    await loaded();
    await screen.findByTestId('stat-success');
    expect(screen.queryByText('Agent policy')).toBeNull();
    expect(screen.queryByText('Model')).toBeNull();
    expect(screen.getByRole('button', { name: 'Run now' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run with…' })).toBeNull();
    expect(host.requests.some((r) => r.path.startsWith('/agent-policies'))).toBe(false);
  });

  it('a policy catalog failure shows the raw reference with "details unavailable" and a plain Run button', async () => {
    mount({ ...TASK, policyId: OWN_ID }, { 'GET /agent-policies': reject(500, 'boom') });
    await loaded();
    expect((await screen.findByText('details unavailable')).closest('dd')).toHaveTextContent(`${OWN_ID} · details unavailable`);
    expect(screen.queryByText('Model')).toBeNull();
    expect(screen.getByRole('button', { name: 'Run now' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run with…' })).toBeNull();
  });
});

describe('the task page: layout', () => {
  it('two columns from md, one below, in reading order', async () => {
    mount();
    await loaded();
    const headings = () => screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    await screen.findByTestId('stat-success');
    expect(headings().filter((h) => ['Statistics', 'Runs', 'Goal', 'Schedules', 'Configuration'].includes(h ?? ''))).toEqual(['Statistics', 'Runs', 'Goal', 'Schedules', 'Configuration']);
    expect(screen.getByTestId('task-columns')).toHaveStyle({ display: 'grid' });
    expect(document.getElementById('runs')).not.toBeNull();
    expect(document.getElementById('schedule')).not.toBeNull();
  });

  it('puts the Knowledge Graph control right after the goal, before the schedules (#1031)', async () => {
    mount(TASK, { 'GET /kgraph/status': { deployment: true, user: true, available: true, everyday: false, autoApproveFacts: false }, [`GET /tasks/${TASK_ID}/kgraph`]: { taskId: TASK_ID, mode: 'learn', available: true } }, [...ALL, 'kgraph:read', 'kgraph:write']);
    await loaded();
    await screen.findByTestId('task-kgraph');
    const headings = screen.getAllByRole('heading', { level: 2 }).map((h) => h.textContent);
    expect(headings.filter((h) => ['Goal', 'Knowledge Graph', 'Schedules'].includes(h ?? ''))).toEqual(['Goal', 'Knowledge Graph', 'Schedules']);
    expect(screen.getByTestId('task-kgraph-chip')).toHaveTextContent('Learning');
  });

  it('on a phone a long goal starts collapsed with the configuration; a short one is open', async () => {
    restoreViewport = mockViewport(390);
    mount({ ...TASK, goal: 'A long goal. '.repeat(40) });
    await loaded();
    const goal = screen.getByRole('button', { name: 'Goal' });
    const config = screen.getByRole('button', { name: 'Configuration' });
    expect(goal).toHaveAttribute('aria-expanded', 'false');
    expect(config).toHaveAttribute('aria-expanded', 'false');
    fireEvent.click(goal);
    expect(goal).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByTestId('task-goal')).toBeVisible();
  });

  it('on a phone a short goal is open', async () => {
    restoreViewport = mockViewport(390);
    mount();
    await loaded();
    expect(screen.getByRole('button', { name: 'Goal' })).toHaveAttribute('aria-expanded', 'true');
  });
});
