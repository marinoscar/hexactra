// The runs list (#423): paging, filters in the URL, counts, the live tick,
// select and bulk delete, the row menu, the New run dialog, and Delete on the
// run page.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { PlatformHostProvider, type PlatformApiClient } from '@marinoscar/platform-web/core';
import { createTestApiError, createTestPlatformHost } from '@marinoscar/platform-web/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../live', () => ({ subscribeRun: () => () => undefined, fetchRunScreenshot: async () => null }));

import { BACKGROUND_POLL_MS, RunList } from '../components/RunList';
import { NO_FILTERS, apiFilter, deleteFilter, filtersFromParams, filtersToParams, matchesFilters, rangeInstants } from '../components/runFilters';
import { rowCost, runAgain, runDuration, runMenuActions, triggerWords, type RunMenuAction } from '../components/runRow';
import { RunDetailPage } from '../pages/RunDetailPage';
import { RunsPage } from '../pages/RunsPage';
import { RUN_STATUSES, type RunCounts, type RunListItem, type RunStatus } from '../types/runs';
import { ConfirmProvider } from '../ui';
import { mockViewport } from './matchMedia';
import { BALANCED, ECONOMY } from './policyFixtures';

const uuid = (i: number) => `00000000-0000-4000-8000-${String(i).padStart(12, '0')}`;
const TASK_ID = '11111111-1111-4111-8111-111111111111';
const T0 = Date.parse('2026-11-16T12:00:00Z');

function run(i: number, over: Partial<RunListItem> = {}): RunListItem {
  const created = T0 - i * 60_000;
  return {
    id: uuid(i),
    taskId: null,
    taskName: null,
    status: 'succeeded',
    trigger: 'manual',
    goal: `Goal ${i}`,
    profile: 'default',
    result: null,
    error: null,
    cancelRequested: false,
    stepCount: 4,
    costUsd: 0,
    costKnown: true,
    modelCalls: 0,
    stopReason: 'finished',
    policy: null,
    createdAt: new Date(created).toISOString(),
    startedAt: new Date(created + 1_000).toISOString(),
    finishedAt: new Date(created + 61_000).toISOString(),
    ...over,
  };
}

function counts(over: Partial<RunCounts['byStatus']> = {}, cost: Pick<RunCounts, 'costUsd' | 'costKnown'> = { costUsd: null, costKnown: true }): RunCounts {
  const byStatus = { queued: 0, running: 0, waiting_human: 0, paused: 0, succeeded: 0, failed: 0, cancelled: 0, ...over };
  return { total: Object.values(byStatus).reduce((a, b) => a + b, 0), live: byStatus.queued + byStatus.running + byStatus.waiting_human + byStatus.paused, byStatus, ...cost };
}

type Request = { method: string; path: string; body?: unknown };
const query = (r: Request) => new URLSearchParams(r.path.split('?')[1] ?? '');
/** The list requests (not the counts, not one run). */
const listRequests = (host: { requests: Request[] }) => host.requests.filter((r) => r.method === 'GET' && r.path.startsWith('/runs?'));

function Where() {
  const location = useLocation();
  return <div data-testid="where">{`${location.pathname}${location.search}`}</div>;
}

/** The address's query, beside the page under test. */
function Search() {
  return <div data-testid="search">{useLocation().search}</div>;
}

function renderList(host: ReturnType<typeof createTestPlatformHost>, url = '/runs', element = <RunList showTaskColumn />) {
  return render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route
              path="/runs"
              element={
                <>
                  {element}
                  <Where />
                </>
              }
            />
            <Route path="/runs/:id" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
}

const ALL = ['runs:read', 'runs:write', 'runs:delete', 'tasks:read'];
let restoreViewport: (() => void) | null = null;

afterEach(() => {
  restoreViewport?.();
  restoreViewport = null;
  vi.useRealTimers();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

describe('RunList: paging and filters', () => {
  it('renders the first page from the envelope, and "Load more" appends the next page without duplicates', async () => {
    const page1 = Array.from({ length: 50 }, (_, i) => run(i + 1));
    // The second page repeats a row of the first (a run a live tick already listed).
    const page2 = [run(50), ...Array.from({ length: 20 }, (_, i) => run(i + 51))];
    const host = createTestPlatformHost({
      permissions: ALL,
      responses: {
        'GET /runs': (r: Request) => (query(r).get('cursor') === 'c1' ? { items: page2, nextCursor: null } : { items: page1, nextCursor: 'c1' }),
        'GET /runs/counts': counts({ succeeded: 70 }),
        'GET /tasks': [],
      },
    });
    renderList(host);
    expect(await screen.findByText('Goal 1')).toBeInTheDocument();
    expect(document.querySelectorAll('tbody tr')).toHaveLength(50);
    const first = listRequests(host)[0]!;
    expect(query(first).get('envelope')).toBe('1');
    expect(query(first).get('limit')).toBe('50');
    expect(await screen.findByTestId('run-showing')).toHaveTextContent('Showing 50 of 70');

    fireEvent.click(screen.getByRole('button', { name: 'Load more' }));
    expect(await screen.findByText('Goal 70')).toBeInTheDocument();
    expect(query(listRequests(host).at(-1)!).get('cursor')).toBe('c1');
    expect(document.querySelectorAll('tbody tr')).toHaveLength(70);
    expect(screen.getAllByText('Goal 50')).toHaveLength(1);
    expect(screen.queryByRole('button', { name: 'Load more' })).not.toBeInTheDocument();
    expect(screen.getByTestId('run-showing')).toHaveTextContent('Showing 70 of 70');
  }, 30_000);

  it('lists a paused run with the paused chip, counts it as live and under "Needs you", and has its own Paused tab (E38.2)', async () => {
    const host = createTestPlatformHost({
      permissions: ALL,
      responses: {
        'GET /runs': (r: Request) => (query(r).get('status') === 'paused' ? { items: [run(5, { status: 'paused', goal: 'A paused goal', stopReason: null, finishedAt: null })], nextCursor: null } : { items: [run(1)], nextCursor: null }),
        'GET /runs/counts': counts({ running: 1, waiting_human: 1, paused: 2, succeeded: 3 }),
        'GET /tasks': [],
      },
    });
    renderList(host);
    expect(await screen.findByText('Goal 1')).toBeInTheDocument();
    for (const name of ['All 7', 'Live 4', 'Needs you 3', 'Paused 2']) expect(await screen.findByRole('tab', { name })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('tab', { name: 'Paused 2' }));
    expect(await screen.findByText('A paused goal')).toBeInTheDocument();
    expect(query(listRequests(host).at(-1)!).get('status')).toBe('paused');
    expect(screen.getAllByText('paused').length).toBeGreaterThan(0);
  });

  it('shows each tab with its count, and a tab change resets the list and asks again', async () => {
    const host = createTestPlatformHost({
      permissions: ALL,
      responses: {
        'GET /runs': (r: Request) => (query(r).get('status') === 'failed' ? { items: [run(9, { status: 'failed', goal: 'A failed goal', stopReason: 'error' })], nextCursor: null } : { items: [run(1), run(2)], nextCursor: null }),
        'GET /runs/counts': counts({ running: 2, waiting_human: 1, succeeded: 30, failed: 12, cancelled: 4 }, { costUsd: 182.4, costKnown: true }),
        'GET /tasks': [],
      },
    });
    renderList(host);
    expect(await screen.findByText('Goal 1')).toBeInTheDocument();
    for (const name of ['All 49', 'Live 3', 'Needs you 1', 'Succeeded 30', 'Failed 12', 'Cancelled 4']) expect(await screen.findByRole('tab', { name })).toBeInTheDocument();
    expect(screen.getByTestId('run-counts')).toHaveTextContent('49 runs · $182.40');

    fireEvent.click(screen.getByRole('tab', { name: 'Failed 12' }));
    expect(await screen.findByText('A failed goal')).toBeInTheDocument();
    expect(screen.queryByText('Goal 1')).not.toBeInTheDocument();
    expect(query(listRequests(host).at(-1)!).get('status')).toBe('failed');
    expect(query(listRequests(host).at(-1)!).has('cursor')).toBe(false);
    expect(screen.getByTestId('where')).toHaveTextContent('/runs?view=failed');
    // The counts are per status: their query never carries the tab.
    expect(host.requests.filter((r) => r.path.startsWith('/runs/counts')).every((r) => !query(r).has('status') && !query(r).has('state'))).toBe(true);
  });

  it('reads the filters from the URL into the request', async () => {
    const host = createTestPlatformHost({ permissions: ALL, responses: { 'GET /runs': { items: [], nextCursor: null }, 'GET /runs/counts': counts(), 'GET /tasks': [] } });
    renderList(host, '/runs?view=failed&q=invoice&stopReason=budget&policyId=builtin%3Aeconomy&trigger=schedule,api&from=2026-11-01&to=2026-11-10');
    expect(await screen.findByText('No runs match these filters')).toBeInTheDocument();
    const q = query(listRequests(host)[0]!);
    expect(q.get('status')).toBe('failed');
    expect(q.get('q')).toBe('invoice');
    expect(q.get('stopReason')).toBe('budget');
    expect(q.get('policyId')).toBe('builtin:economy');
    expect(q.get('trigger')).toBe('schedule,api');
    expect(q.get('from')).toMatch(/^2026-1[01]-\d\dT/);
    expect(q.get('to')).toMatch(/^2026-11-1[01]T/);
    expect(screen.getByLabelText('Search goals')).toHaveValue('invoice');
    // The active filters are chips; removing one rewrites the URL and asks again.
    const chips = screen.getByLabelText('Active filters');
    expect(within(chips).getByText('Search: invoice')).toBeInTheDocument();
    expect(within(chips).getByText('Stopped by: Budget')).toBeInTheDocument();
    expect(within(chips).getByText('Trigger: Schedule, API')).toBeInTheDocument();
    fireEvent.click(within(chips).getByRole('button', { name: 'Clear all' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/runs\?view=failed$/));
    await waitFor(() => expect(query(listRequests(host).at(-1)!).has('q')).toBe(false));
  });

  it('debounces the search into the URL and the request', async () => {
    const host = createTestPlatformHost({ permissions: ALL, responses: { 'GET /runs': { items: [run(1)], nextCursor: null }, 'GET /runs/counts': counts({ succeeded: 1 }), 'GET /tasks': [] } });
    renderList(host);
    await screen.findByText('Goal 1');
    fireEvent.change(screen.getByLabelText('Search goals'), { target: { value: 'fare' } });
    expect(listRequests(host)).toHaveLength(1);
    await waitFor(() => expect(query(listRequests(host).at(-1)!).get('q')).toBe('fare'));
    expect(screen.getByTestId('where')).toHaveTextContent('/runs?q=fare');
    fireEvent.click(screen.getByRole('button', { name: 'Clear search' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(/^\/runs$/));
  });

  it('fixes the task with scope, and says "No runs yet" when the user has none', async () => {
    const onNewRun = vi.fn();
    const host = createTestPlatformHost({ permissions: ALL, responses: { 'GET /runs': { items: [], nextCursor: null }, 'GET /runs/counts': counts() } });
    renderList(host, '/runs', <RunList scope={{ taskId: TASK_ID }} onNewRun={onNewRun} />);
    expect(await screen.findByText('No runs yet')).toBeInTheDocument();
    expect(query(listRequests(host)[0]!).get('taskId')).toBe(TASK_ID);
    expect(query(host.requests.find((r) => r.path.startsWith('/runs/counts'))!).get('taskId')).toBe(TASK_ID);
    expect(screen.queryByLabelText('Task')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'New run' }));
    expect(onNewRun).toHaveBeenCalled();
  });

  it('shows an error with Retry', async () => {
    let fail = true;
    const host = createTestPlatformHost({
      permissions: ALL,
      responses: {
        'GET /runs': () => {
          if (fail) throw createTestApiError(500, 'The database is away');
          return { items: [run(1)], nextCursor: null };
        },
        'GET /runs/counts': counts({ succeeded: 1 }),
        'GET /tasks': [],
      },
    });
    renderList(host);
    expect(await screen.findByText('The database is away')).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByText('Goal 1')).toBeInTheDocument();
  });
});

describe('RunList: rows', () => {
  it('renders a known, a lower-bound and no cost, the stop reason in the status chip, the task link and the activity', async () => {
    const items = [
      run(1, { costUsd: 0.42, modelCalls: 3, taskId: TASK_ID, taskName: 'Morning report', trigger: 'schedule' }),
      run(2, { status: 'failed', stopReason: 'budget_cost', costUsd: 2.01, costKnown: false, modelCalls: 9 }),
      run(3, { trigger: 'external', actor: 'packer' }),
      run(4, { status: 'running', stopReason: null, finishedAt: null, activity: { phase: 'thinking', startedAt: new Date(T0).toISOString() } }),
      run(5, { status: 'failed', stopReason: 'no_model' }),
    ];
    const host = createTestPlatformHost({ permissions: ALL, responses: { 'GET /runs': { items, nextCursor: null }, 'GET /runs/counts': counts({ succeeded: 2, failed: 2, running: 1 }), 'GET /tasks': [] } });
    renderList(host);
    const row = async (i: number) => (await screen.findByTestId(`run-row-${uuid(i)}`)).closest('tr')!;
    expect(within(await row(1)).getByTestId('run-cost')).toHaveTextContent('$0.42');
    expect(within(await row(1)).getByRole('link', { name: 'Morning report' })).toHaveAttribute('href', `/tasks/${TASK_ID}`);
    expect(within(await row(1)).getByText('schedule')).toBeInTheDocument();
    expect(within(await row(2)).getByTestId('run-cost')).toHaveTextContent('≥ $2.01');
    expect(within(await row(2)).getByText('failed · cost budget')).toBeInTheDocument();
    expect(within(await row(3)).getByTestId('run-cost')).toHaveTextContent('—');
    expect(within(await row(3)).getByText('by packer')).toBeInTheDocument();
    expect(within(await row(4)).getByTestId('run-activity')).toHaveTextContent('Thinking about the next step');
    expect(within(await row(5)).getByText('failed · no model')).toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Cost' })).toBeInTheDocument();
    // Without agent_policies:read there is no Policy column.
    expect(screen.queryByRole('columnheader', { name: 'Policy' })).not.toBeInTheDocument();
  });

  it('has no Cost column when no row has a cost, and a Policy column with agent_policies:read', async () => {
    const host = createTestPlatformHost({
      permissions: [...ALL, 'agent_policies:read'],
      responses: {
        'GET /runs': { items: [run(1, { policy: { id: 'builtin:balanced', name: 'Balanced', version: 1, source: 'user_default', builtin: true }, currentTier: 'standard' }), run(2, { costUsd: 0, costKnown: false, modelCalls: 5 })], nextCursor: null },
        'GET /runs/counts': counts({ succeeded: 2 }),
        'GET /tasks': [],
        'GET /agent-policies': [BALANCED],
        'GET /agent-policies/default': { policyId: 'builtin:balanced', explicit: false },
      },
    });
    renderList(host);
    await screen.findByText('Goal 1');
    expect(screen.queryByRole('columnheader', { name: 'Cost' })).not.toBeInTheDocument();
    expect(screen.queryByTestId('run-cost')).not.toBeInTheDocument();
    expect(screen.getByRole('columnheader', { name: 'Policy' })).toBeInTheDocument();
    expect(screen.getByTestId('run-policy')).toHaveTextContent('Balanced');
    expect(screen.getByTestId('run-counts')).toHaveTextContent(/^2 runs$/);
  });

  it('reads cost, duration and trigger in words', () => {
    expect(rowCost({ costUsd: 0.42, costKnown: true, modelCalls: 2 })).toBe('$0.42');
    expect(rowCost({ costUsd: 2.01, costKnown: false, modelCalls: 2 })).toBe('≥ $2.01');
    expect(rowCost({ costUsd: 0, costKnown: true, modelCalls: 0 })).toBeNull();
    expect(rowCost({ costUsd: 0, costKnown: false, modelCalls: 4 })).toBeNull();
    expect(rowCost({ costUsd: null })).toBeNull();
    expect(runDuration(run(1), T0)).toBe('1 min');
    expect(runDuration(run(1, { status: 'running', finishedAt: null, startedAt: new Date(T0 - 125_000).toISOString() }), T0)).toBe('running 2 min');
    expect(runDuration(run(1, { status: 'queued', finishedAt: null, startedAt: null }), T0)).toBeNull();
    expect(triggerWords({ trigger: 'external', actor: null })).toBe('by an external agent');
    expect(triggerWords({ trigger: 'mcp' })).toBe('MCP');
  });

  it('is a table at md and up, and cards with a filter drawer below', async () => {
    const responses = { 'GET /runs': { items: [run(1, { costUsd: 0.42, modelCalls: 2 })], nextCursor: null }, 'GET /runs/counts': counts({ succeeded: 1 }), 'GET /tasks': [] };
    restoreViewport = mockViewport(1440);
    const desktop = renderList(createTestPlatformHost({ permissions: ALL, responses }));
    await screen.findByText('Goal 1');
    expect(screen.getByRole('table', { name: 'Runs' })).toBeInTheDocument();
    expect(screen.getByRole('combobox', { name: 'Trigger' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Filters' })).not.toBeInTheDocument();
    desktop.unmount();
    restoreViewport();

    restoreViewport = mockViewport(390);
    renderList(createTestPlatformHost({ permissions: ALL, responses }));
    const card = await screen.findByTestId(`run-row-${uuid(1)}`);
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
    expect(within(card).getByRole('link')).toHaveAttribute('href', `/runs/${uuid(1)}`);
    expect(card).toHaveTextContent('manual · 4 steps · 1 min · $0.42');
    // The filters are behind a button; Search stays on the page.
    expect(screen.getByLabelText('Search goals')).toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Trigger' })).not.toBeInTheDocument();
    // Select is a toggle on a phone: no checkboxes until it is on.
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Select' }));
    expect(screen.getByRole('checkbox', { name: 'Select Goal 1' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Filters' }));
    const drawer = await screen.findByRole('dialog', { name: 'Filters' });
    expect(within(drawer).getByRole('combobox', { name: 'Trigger' })).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Apply' })).toBeInTheDocument();
    expect(within(drawer).getByRole('button', { name: 'Reset' })).toBeInTheDocument();
  });
});

describe('RunList: the live tick', () => {
  const live = (host: { requests: Request[] }) => listRequests(host).filter((r) => query(r).get('state') === 'live');

  it('asks for the live runs only, updates a row, reads the final state of a run that left the live set and prepends a new run', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const running = run(1, { status: 'running', stopReason: null, finishedAt: null });
    const finishing = run(2, { status: 'running', stopReason: null, finishedAt: null, taskId: TASK_ID, taskName: 'Morning report' });
    const vanishing = run(3, { status: 'queued', stopReason: null, finishedAt: null });
    const fresh = run(0, { status: 'queued', stopReason: null, finishedAt: null, goal: 'A new goal' });
    const host = createTestPlatformHost({
      permissions: ALL,
      responses: {
        'GET /runs': (r: Request) =>
          query(r).get('state') === 'live' ? { items: [fresh, { ...running, status: 'waiting_human' }], nextCursor: null } : { items: [running, finishing, vanishing, run(4)], nextCursor: null },
        // What `GET /runs/:id` answers: the run, without its task's name.
        [`GET /runs/${uuid(2)}`]: { ...finishing, status: 'failed', stopReason: 'stalled', taskName: undefined },
        'GET /runs/counts': counts({ running: 2, queued: 1, succeeded: 1 }),
        'GET /tasks': [],
      },
    });
    renderList(host);
    await screen.findByText('Goal 1');
    const before = host.requests.length;
    const countsBefore = host.requests.filter((r) => r.path.startsWith('/runs/counts')).length;
    await act(() => vi.advanceTimersByTimeAsync(5_000));

    const tick = host.requests.slice(before);
    const liveRequest = tick.find((r) => r.path.startsWith('/runs?'))!;
    expect(query(liveRequest).get('state')).toBe('live');
    expect(query(liveRequest).get('limit')).toBe('100');
    // Only the live runs, and the two rows that left the live set: never the whole list again.
    expect(tick.filter((r) => r.path.startsWith('/runs?'))).toHaveLength(1);
    expect(tick.map((r) => r.path).filter((p) => /^\/runs\/[0-9a-f-]{36}$/.test(p)).sort()).toEqual([`/runs/${uuid(2)}`, `/runs/${uuid(3)}`]);

    const row = (i: number) => screen.getByTestId(`run-row-${uuid(i)}`).closest('tr')!;
    await waitFor(() => expect(within(row(1)).getByText('needs you')).toBeInTheDocument());
    expect(within(row(2)).getByText('failed · stalled')).toBeInTheDocument();
    // The list's task name survives the single-run read.
    expect(within(row(2)).getByRole('link', { name: 'Morning report' })).toBeInTheDocument();
    // Deleted on another device: gone, without an error.
    expect(screen.queryByTestId(`run-row-${uuid(3)}`)).not.toBeInTheDocument();
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
    // A new run the filter includes is prepended.
    expect(screen.getAllByRole('row')[1]).toHaveTextContent('A new goal');
    expect(host.requests.filter((r) => r.path.startsWith('/runs/counts')).length).toBe(countsBefore + 1);
  });

  it('does not read the counts again when the tick changed nothing, and does not prepend a run the filter excludes', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const running = run(1, { status: 'running', stopReason: null, finishedAt: null, goal: 'Check the invoice' });
    const host = createTestPlatformHost({
      permissions: ALL,
      responses: {
        'GET /runs': (r: Request) => (query(r).get('state') === 'live' ? { items: [run(0, { status: 'queued', goal: 'Something else', finishedAt: null }), running], nextCursor: null } : { items: [running], nextCursor: null }),
        'GET /runs/counts': counts({ running: 1 }),
        'GET /tasks': [],
      },
    });
    renderList(host, '/runs?q=invoice');
    await screen.findByText('Check the invoice');
    const countsBefore = host.requests.filter((r) => r.path.startsWith('/runs/counts')).length;
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(live(host)).toHaveLength(1);
    expect(screen.queryByText('Something else')).not.toBeInTheDocument();
    expect(host.requests.filter((r) => r.path.startsWith('/runs/counts')).length).toBe(countsBefore);
  });

  it('does not poll while the tab is hidden', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const host = createTestPlatformHost({ permissions: ALL, responses: { 'GET /runs': { items: [run(1)], nextCursor: null }, 'GET /runs/counts': counts({ succeeded: 1 }), 'GET /tasks': [] } });
    renderList(host);
    await screen.findByText('Goal 1');
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(() => vi.advanceTimersByTimeAsync(20_000));
    expect(live(host)).toHaveLength(0);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(() => vi.advanceTimersByTimeAsync(5_000));
    expect(live(host)).toHaveLength(1);
  });
});

describe('RunList: select and bulk delete', () => {
  const deletes = (host: { requests: Request[] }) => host.requests.filter((r) => r.method === 'POST' && r.path === '/runs/delete');

  it('posts the selected ids, removes the rows and reports the spend and the runs that were skipped', async () => {
    const items = [run(1), run(2), run(3), run(4, { status: 'running', stopReason: null, finishedAt: null })];
    const host = createTestPlatformHost({
      permissions: ALL,
      responses: {
        'GET /runs': { items, nextCursor: null },
        'GET /runs/counts': counts({ succeeded: 3, running: 1 }),
        'GET /tasks': [],
        'POST /runs/delete': { deleted: 1, costUsd: 14.2, skippedLive: [uuid(2)], notFound: [] },
      },
    });
    renderList(host);
    await screen.findByText('Goal 1');
    // A live run cannot be selected: cancel it first.
    expect(screen.getByRole('checkbox', { name: 'Select Goal 4' })).toBeDisabled();
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Goal 1' }));
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select Goal 2' }));
    const bar = screen.getByRole('region', { name: 'Selection' });
    expect(bar).toHaveTextContent('2 selected');
    fireEvent.click(within(bar).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Delete 2 runs?');
    expect(dialog).toHaveTextContent('Their steps and answers are deleted too. Their cost and stop-reason history is removed from task spend and alerts. This cannot be undone.');
    // 100 or fewer: no word to type.
    expect(within(dialog).queryByRole('textbox')).not.toBeInTheDocument();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(deletes(host)).toHaveLength(1));
    expect(deletes(host)[0]!.body).toEqual({ ids: [uuid(1), uuid(2)] });
    expect(await screen.findByText('Deleted 1 run ($14.20 of recorded spend). 1 is still running and was skipped')).toBeInTheDocument();
    expect(screen.queryByText('Goal 1')).not.toBeInTheDocument();
    expect(screen.getByText('Goal 2')).toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Selection' })).not.toBeInTheDocument();
  });

  it('"select all that match" posts the filter with the expected count, asks to type "delete" and shows the background banner on a 202', async () => {
    const page = Array.from({ length: 50 }, (_, i) => run(i + 1, { status: 'failed', stopReason: 'error' }));
    const host = createTestPlatformHost({
      permissions: ALL,
      responses: {
        'GET /runs': { items: page, nextCursor: 'c1' },
        'GET /runs/counts': counts({ running: 3, succeeded: 200, failed: 1240 }),
        'GET /tasks': [],
        // What a 202 carries: a queue job deletes the runs.
        'POST /runs/delete': { jobId: uuid(999), matched: 1240, costUsd: 3.5 },
      },
    });
    renderList(host, '/runs?view=failed&q=invoice');
    await screen.findByText('Goal 1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }));
    expect(screen.getByRole('region', { name: 'Selection' })).toHaveTextContent('50 selected');
    expect(screen.getByText(/All 50 loaded runs are selected\./)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Select all 1,240 finished runs that match' }));
    expect(screen.getByRole('region', { name: 'Selection' })).toHaveTextContent('1,240 selected');
    fireEvent.click(within(screen.getByRole('region', { name: 'Selection' })).getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Delete 1,240 runs?');
    // More than 100: the word must be typed.
    const confirmButton = within(dialog).getByRole('button', { name: 'Delete' });
    expect(confirmButton).toBeDisabled();
    fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'delete' } });
    expect(confirmButton).toBeEnabled();
    fireEvent.click(confirmButton);
    await waitFor(() => expect(deletes(host)).toHaveLength(1));
    expect(deletes(host)[0]!.body).toEqual({ filter: { status: ['failed'], q: 'invoice' }, expectedCount: 1240 });
    expect(await screen.findByText('Deleting 1,240 runs in the background…')).toBeInTheDocument();
  });

  it('a background delete that is done by the first read clears its banner and re-reads the list then, not 30 s later', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      let deleted = false;
      const page = Array.from({ length: 50 }, (_, i) => run(i + 1, { status: 'succeeded' }));
      const host = createTestPlatformHost({
        permissions: ALL,
        responses: {
          'GET /runs': () => (deleted ? { items: [], nextCursor: null } : { items: page, nextCursor: 'c1' }),
          'GET /runs/counts': () => (deleted ? counts({ failed: 4 }) : counts({ succeeded: 866, failed: 4 })),
          'GET /tasks': [],
          // The job is quick: by the time the page reads the counts again, every run is gone.
          'POST /runs/delete': () => ((deleted = true), { jobId: uuid(998), matched: 866, costUsd: 1 }),
        },
      });
      renderList(host, '/runs?view=succeeded');
      await screen.findByText('Goal 1');
      fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }));
      fireEvent.click(screen.getByRole('button', { name: 'Select all 866 finished runs that match' }));
      fireEvent.click(within(screen.getByRole('region', { name: 'Selection' })).getByRole('button', { name: 'Delete' }));
      const dialog = await screen.findByRole('dialog');
      fireEvent.change(within(dialog).getByRole('textbox'), { target: { value: 'delete' } });
      fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
      expect(await screen.findByText('Deleting 866 runs in the background…')).toBeInTheDocument();
      // One read of the counts later (3 s): 870 became 4, so all 866 are gone.
      await act(async () => {
        await vi.advanceTimersByTimeAsync(BACKGROUND_POLL_MS + 50);
      });
      await waitFor(() => expect(screen.queryByText('Deleting 866 runs in the background…')).not.toBeInTheDocument());
      await waitFor(() => expect(screen.queryByText('Goal 1')).not.toBeInTheDocument());
    } finally {
      vi.useRealTimers();
    }
  });

  it('keeps the selection and says the list changed on a 409 COUNT_CHANGED', async () => {
    const page = Array.from({ length: 3 }, (_, i) => run(i + 1));
    const host = createTestPlatformHost({
      permissions: ALL,
      responses: {
        'GET /runs': { items: page, nextCursor: 'c1' },
        'GET /runs/counts': counts({ succeeded: 60 }),
        'GET /tasks': [],
        'POST /runs/delete': () => {
          throw createTestApiError(409, 'The matching runs changed', 'COUNT_CHANGED', { matched: 80, expectedCount: 60 });
        },
      },
    });
    renderList(host);
    await screen.findByText('Goal 1');
    fireEvent.click(screen.getByRole('checkbox', { name: 'Select all' }));
    fireEvent.click(screen.getByRole('button', { name: 'Select all 60 finished runs that match' }));
    fireEvent.click(within(screen.getByRole('region', { name: 'Selection' })).getByRole('button', { name: 'Delete' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByText('The list changed. Review it and try again.')).toBeInTheDocument();
    expect(deletes(host)[0]!.body).toEqual({ filter: { state: 'finished' }, expectedCount: 60 });
    // The selection is intact, and the list was read again.
    await waitFor(() => expect(listRequests(host).length).toBeGreaterThan(1));
    expect(await screen.findByRole('region', { name: 'Selection' })).toHaveTextContent('60 selected');
  });

  it('has no select UI and no Delete without runs:delete', async () => {
    const host = createTestPlatformHost({ permissions: ['runs:read', 'runs:write'], responses: { 'GET /runs': { items: [run(1)], nextCursor: null }, 'GET /runs/counts': counts({ succeeded: 1 }) } });
    renderList(host);
    await screen.findByText('Goal 1');
    expect(screen.queryByRole('checkbox')).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Goal 1' }));
    expect(await screen.findByRole('menuitem', { name: 'Open' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Delete' })).not.toBeInTheDocument();
  });
});

describe('the row menu', () => {
  const LIVE: RunStatus[] = ['queued', 'running', 'waiting_human', 'paused'];
  const cases = RUN_STATUSES.flatMap((status) =>
    [true, false].flatMap((canWrite) => [true, false].flatMap((canDelete) => [true, false].map((canPickPolicy) => ({ status, canWrite, canDelete, canPickPolicy })))),
  );

  it.each(cases)('$status, runs:write $canWrite, runs:delete $canDelete, policies $canPickPolicy', ({ status, canWrite, canDelete, canPickPolicy }) => {
    const expected: RunMenuAction[] = [
      'open',
      ...(canWrite ? (['again'] as const) : []),
      ...(canWrite && canPickPolicy ? (['againWith'] as const) : []),
      ...(canWrite && LIVE.includes(status) ? (['cancel'] as const) : []),
      ...(canDelete && !LIVE.includes(status) ? (['delete'] as const) : []),
    ];
    expect(runMenuActions({ status, trigger: 'manual' }, { canWrite, canDelete, canPickPolicy })).toEqual(expected);
    // A run an external agent drove cannot be started again.
    expect(runMenuActions({ status, trigger: 'external' }, { canWrite, canDelete, canPickPolicy })).toEqual(expected.filter((a) => a !== 'again' && a !== 'againWith'));
  });

  it('renders the items of a run, cancels a live one and deletes a finished one after a confirmation', async () => {
    const host = createTestPlatformHost({
      permissions: [...ALL, 'agent_policies:read'],
      responses: {
        'GET /runs': { items: [run(1, { status: 'running', stopReason: null, finishedAt: null }), run(2)], nextCursor: null },
        'GET /runs/counts': counts({ succeeded: 1, running: 1 }),
        'GET /tasks': [],
        'GET /agent-policies': [BALANCED, ECONOMY],
        'GET /agent-policies/default': { policyId: 'builtin:balanced', explicit: false },
        [`POST /runs/${uuid(1)}/cancel`]: { cancelRequested: true },
        [`DELETE /runs/${uuid(2)}`]: undefined,
        'POST /runs': { id: uuid(77) },
      },
    });
    renderList(host);
    await screen.findByText('Goal 1');
    await waitFor(() => expect(host.requests.some((r) => r.path === '/agent-policies')).toBe(true));
    fireEvent.click(screen.getByRole('button', { name: 'Actions for Goal 1' }));
    await waitFor(() => expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Open', 'Run again', 'Run again with…', 'Export PDF', 'Export JSON', 'Cancel']));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Cancel' }));
    await waitFor(() => expect(host.requests.some((r) => r.method === 'POST' && r.path === `/runs/${uuid(1)}/cancel`)).toBe(true));

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Goal 2' }));
    await waitFor(() => expect(screen.getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['Open', 'Run again', 'Run again with…', 'Export PDF', 'Export JSON', 'Delete']));
    fireEvent.click(screen.getByRole('menuitem', { name: 'Delete' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete' }));
    await waitFor(() => expect(host.requests.some((r) => r.method === 'DELETE' && r.path === `/runs/${uuid(2)}`)).toBe(true));
    await waitFor(() => expect(screen.queryByText('Goal 2')).not.toBeInTheDocument());
    expect(await screen.findByText('Run deleted')).toBeInTheDocument();

    // "Run again with…" opens the policy menu of RunWithButton and starts the run under the choice.
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Goal 1' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Run again with…' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: /Economy/ }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(`/runs/${uuid(77)}`));
    expect(host.requests.find((r) => r.method === 'POST' && r.path === '/runs')?.body).toEqual({ goal: 'Goal 1', profile: 'default', policyId: 'builtin:economy' });
  });
});

describe('Run again', () => {
  const api = () => {
    const calls: { path: string; body: unknown }[] = [];
    const client = { post: async (path: string, body: unknown) => (calls.push({ path, body }), { id: 'new' }) } as unknown as PlatformApiClient;
    return { client, calls };
  };
  const chosen = { id: 'builtin:thorough', name: 'Thorough', version: 1, source: 'run' as const, builtin: true };

  it('sends the original policy only when it was chosen for that run', async () => {
    const a = api();
    await runAgain(a.client, run(1, { taskId: TASK_ID, policy: chosen }));
    await runAgain(a.client, run(2, { taskId: TASK_ID, policy: { ...chosen, source: 'task' } }));
    expect(a.calls).toEqual([
      { path: `/tasks/${TASK_ID}/runs`, body: { policyId: 'builtin:thorough' } },
      { path: `/tasks/${TASK_ID}/runs`, body: {} },
    ]);
  });

  it('starts an ad-hoc run with the same goal, profile and machine, under the same rule', async () => {
    const a = api();
    const HOST = '55555555-5555-4555-8555-555555555555';
    await runAgain(a.client, run(1, { goal: 'Check my miles', profile: 'travel', hostId: HOST, hostFallback: false, policy: chosen }));
    await runAgain(a.client, run(2, { policy: { ...chosen, source: 'user_default' } }));
    await runAgain(a.client, run(3, { policy: { ...chosen, source: 'user_default' } }), 'builtin:economy');
    expect(a.calls).toEqual([
      { path: '/runs', body: { goal: 'Check my miles', profile: 'travel', hostId: HOST, hostFallback: false, policyId: 'builtin:thorough' } },
      { path: '/runs', body: { goal: 'Goal 2', profile: 'default' } },
      { path: '/runs', body: { goal: 'Goal 3', profile: 'default', policyId: 'builtin:economy' } },
    ]);
  });
});

describe('the filters, as the URL and the API read them', () => {
  const zone = 'America/Costa_Rica';

  it('round-trips through the URL and keeps other parameters', () => {
    const filters = { ...NO_FILTERS, view: 'failed' as const, q: 'invoice', taskId: 'none', trigger: ['manual' as const, 'mcp' as const], from: '2026-11-01', to: '2026-11-10', stopReason: ['budget' as const], policyId: 'builtin:economy' };
    const params = filtersToParams(filters, new URLSearchParams('tab=runs'));
    expect(params.get('tab')).toBe('runs');
    expect(filtersFromParams(params)).toEqual(filters);
    expect(filtersToParams(NO_FILTERS).toString()).toBe('');
    expect(filtersFromParams(new URLSearchParams('view=nope&taskId=x&trigger=cron&from=yesterday'))).toEqual(NO_FILTERS);
  });

  it('cuts days in the profile time zone: from is inclusive, to is the day after', () => {
    expect(rangeInstants({ from: '2026-11-01', to: '2026-11-10' }, zone)).toEqual({ from: '2026-11-01T06:00:00.000Z', to: '2026-11-11T06:00:00.000Z' });
    expect(rangeInstants({ from: null, to: null }, zone)).toEqual({});
  });

  it('maps the tabs, drops "Stopped by" where it does not apply, and restricts a delete to finished runs', () => {
    expect(apiFilter({ ...NO_FILTERS, view: 'live' }, {}, zone)).toEqual({ state: 'live' });
    // "Needs you" is every run that waits for its owner: a question to answer, or a pause to end (E38.2); "Paused" is the pause alone.
    expect(apiFilter({ ...NO_FILTERS, view: 'needs' }, {}, zone)).toEqual({ status: ['waiting_human', 'paused'] });
    expect(apiFilter({ ...NO_FILTERS, view: 'paused' }, {}, zone)).toEqual({ status: ['paused'] });
    expect(apiFilter({ ...NO_FILTERS, view: 'succeeded', stopReason: ['budget'] }, { taskId: TASK_ID }, zone)).toEqual({ status: ['succeeded'], taskId: TASK_ID });
    expect(apiFilter({ ...NO_FILTERS, view: 'failed', stopReason: ['budget', 'stalled'] }, {}, zone, false)).toEqual({ stopReason: ['budget', 'stalled'] });
    expect(deleteFilter(NO_FILTERS, {}, zone)).toEqual({ state: 'finished' });
    expect(deleteFilter({ ...NO_FILTERS, view: 'cancelled', taskId: 'none' }, {}, zone)).toEqual({ status: ['cancelled'], taskId: 'none' });
  });

  it('tests a run on the client the way the server would', () => {
    const r = run(1, { status: 'failed', stopReason: 'budget_cost', goal: 'Pay the Invoice', trigger: 'schedule', taskId: TASK_ID, policy: { id: 'builtin:economy', name: 'Economy', version: 1, source: 'task', builtin: true } });
    const ok = (f: Partial<typeof NO_FILTERS>, scope = {}) => matchesFilters(r, { ...NO_FILTERS, ...f }, scope, zone);
    expect(ok({})).toBe(true);
    expect(ok({ view: 'failed', q: 'invoice', trigger: ['schedule'], stopReason: ['budget'], policyId: 'builtin:economy', taskId: TASK_ID })).toBe(true);
    expect(ok({ view: 'live' })).toBe(false);
    expect(ok({ q: 'receipt' })).toBe(false);
    expect(ok({ taskId: 'none' })).toBe(false);
    expect(ok({}, { taskId: uuid(5) })).toBe(false);
    expect(ok({ trigger: ['manual'] })).toBe(false);
    expect(ok({ stopReason: ['stalled'] })).toBe(false);
    // A benchmark's trial run is in no list unless the trigger filter names it, as on the server (E44, #738).
    const trial = run(2, { status: 'running', trigger: 'benchmark' });
    expect(matchesFilters(trial, NO_FILTERS, {}, zone)).toBe(false);
    expect(matchesFilters(trial, { ...NO_FILTERS, view: 'live' }, {}, zone)).toBe(false);
    expect(matchesFilters(trial, { ...NO_FILTERS, trigger: ['benchmark'] }, {}, zone)).toBe(true);
    expect(filtersFromParams(new URLSearchParams('trigger=benchmark')).trigger).toEqual(['benchmark']);
    expect(ok({ policyId: 'builtin:balanced' })).toBe(false);
    expect(ok({ from: '2026-11-17' })).toBe(false);
    expect(ok({ to: '2026-11-15' })).toBe(false);
    expect(ok({ from: '2026-11-16', to: '2026-11-16' })).toBe(true);
  });
});

describe('RunsPage: New run', () => {
  const HOME = '33333333-3333-4333-8333-333333333333';
  const hostRow = { id: HOME, name: 'Linux-Mini-PC', version: '0.1.0', online: false, browserConnected: false, onDemand: true, draining: false, viewerUrl: null, mode: 'unattended', desktop: true, profiles: [], lastSeen: '2026-11-17T00:00:00Z' };
  const base = { 'GET /runs': { items: [], nextCursor: null }, 'GET /runs/counts': counts(), 'GET /tasks': [], 'POST /runs': { id: uuid(42) } };
  const page = (host: ReturnType<typeof createTestPlatformHost>, at = '/runs') =>
    render(
      <PlatformHostProvider host={host}>
        <ConfirmProvider>
          <MemoryRouter initialEntries={[at]}>
            <Routes>
              <Route
                path="/runs"
                element={
                  <>
                    <RunsPage />
                    <Search />
                  </>
                }
              />
              <Route path="/runs/:id" element={<Where />} />
            </Routes>
          </MemoryRouter>
        </ConfirmProvider>
      </PlatformHostProvider>,
    );

  it('posts the goal, profile, machine, fallback and policy, and opens the run', async () => {
    const host = createTestPlatformHost({
      permissions: [...ALL, 'fleet:read', 'agent_policies:read'],
      responses: {
        ...base,
        'GET /fleet/hosts': [hostRow],
        'GET /agent-policies': [BALANCED, ECONOMY],
        'GET /agent-policies/default': { policyId: 'builtin:balanced', explicit: false },
      },
    });
    page(host);
    fireEvent.click(await screen.findByRole('button', { name: 'New run' }));
    const dialog = await screen.findByRole('dialog', { name: 'New run' });
    expect(within(dialog).getByRole('button', { name: 'Start' })).toBeDisabled();
    fireEvent.change(within(dialog).getByLabelText(/^Goal/), { target: { value: '  Check my miles  ' } });
    expect(within(dialog).getByText('18 / 4,000')).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText('Profile'), { target: { value: 'travel' } });
    fireEvent.mouseDown(within(dialog).getByRole('combobox', { name: 'Machine' }));
    fireEvent.click(await screen.findByRole('option', { name: 'Linux-Mini-PC (offline)' }));
    expect(await within(dialog).findByText(/Linux-Mini-PC is offline right now/)).toBeInTheDocument();
    fireEvent.click(within(dialog).getByLabelText('If it is unavailable, use another available machine'));
    fireEvent.mouseDown(within(dialog).getByRole('combobox', { name: 'Policy' }));
    fireEvent.click(await screen.findByRole('option', { name: /Economy/ }));
    expect(within(dialog).getByRole('link', { name: 'Save as task instead' })).toHaveAttribute('href', '/tasks/new?goal=Check%20my%20miles');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(`/runs/${uuid(42)}`));
    expect(host.requests.find((r) => r.method === 'POST' && r.path === '/runs')?.body).toEqual({ goal: 'Check my miles', profile: 'travel', hostId: HOME, hostFallback: false, policyId: 'builtin:economy' });
  });

  it('omits the policy for the default, and has no policy picker without agent_policies:read', async () => {
    const withPolicies = createTestPlatformHost({
      permissions: [...ALL, 'agent_policies:read'],
      responses: { ...base, 'GET /agent-policies': [BALANCED], 'GET /agent-policies/default': { policyId: 'builtin:balanced', explicit: false } },
    });
    const first = page(withPolicies);
    fireEvent.click(await screen.findByRole('button', { name: 'New run' }));
    let dialog = await screen.findByRole('dialog', { name: 'New run' });
    expect(within(dialog).getByRole('combobox', { name: 'Policy' })).toBeInTheDocument();
    fireEvent.change(within(dialog).getByLabelText(/^Goal/), { target: { value: 'Check my miles' } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(withPolicies.requests.some((r) => r.method === 'POST' && r.path === '/runs')).toBe(true));
    expect(withPolicies.requests.find((r) => r.method === 'POST' && r.path === '/runs')?.body).toEqual({ goal: 'Check my miles', profile: 'default' });
    first.unmount();

    const without = createTestPlatformHost({ permissions: ALL, responses: base });
    page(without);
    fireEvent.click(await screen.findByRole('button', { name: 'New run' }));
    dialog = await screen.findByRole('dialog', { name: 'New run' });
    expect(within(dialog).queryByRole('combobox', { name: 'Policy' })).not.toBeInTheDocument();
  });

  it('`?new=1` arrives with the dialog open (Home\'s "More options"), drops the parameter and keeps the filters', async () => {
    page(createTestPlatformHost({ permissions: ALL, responses: base }), '/runs?view=failed&new=1');
    expect(await screen.findByRole('dialog', { name: 'New run' })).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('search')).toHaveTextContent(/^\?view=failed$/));
    // The page behind the dialog is on the Failed tab.
    expect(screen.getByRole('tab', { name: /^Failed/, hidden: true })).toHaveAttribute('aria-selected', 'true');
  });

  it('`?new=1` opens nothing without runs:write', async () => {
    page(createTestPlatformHost({ permissions: ['runs:read'], responses: base }), '/runs?new=1');
    expect(await screen.findByText('No runs yet')).toBeInTheDocument();
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('search')).toBeEmptyDOMElement());
  });

  it('has no "New run" without runs:write', async () => {
    page(createTestPlatformHost({ permissions: ['runs:read'], responses: base }));
    expect(await screen.findByText('No runs yet')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'New run' })).not.toBeInTheDocument();
  });
});

describe('RunDetailPage: delete, run again, a missing run', () => {
  const detail = (host: ReturnType<typeof createTestPlatformHost>, id: string) =>
    render(
      <PlatformHostProvider host={host}>
        <ConfirmProvider>
          <MemoryRouter initialEntries={[`/runs/${id}`]}>
            <Routes>
              <Route path="/runs/:id" element={<RunDetailPage />} />
              <Route path="/runs" element={<RunsPage />} />
            </Routes>
          </MemoryRouter>
        </ConfirmProvider>
      </PlatformHostProvider>,
    );
  const listResponses = { 'GET /runs': { items: [], nextCursor: null }, 'GET /runs/counts': counts() };

  it('confirms, deletes the run and goes back to the list, which says so', async () => {
    const finished = run(1, { taskId: TASK_ID, steps: [] });
    const host = createTestPlatformHost({
      permissions: ['runs:read', 'runs:write', 'runs:delete', 'tasks:read'],
      responses: { ...listResponses, [`GET /runs/${uuid(1)}`]: finished, [`DELETE /runs/${uuid(1)}`]: undefined, [`GET /tasks/${TASK_ID}`]: { name: 'Morning report' }, 'GET /tasks': [] },
    });
    detail(host, uuid(1));
    expect(await screen.findByRole('link', { name: 'Task: Morning report' })).toHaveAttribute('href', `/tasks/${TASK_ID}`);
    expect(screen.getByRole('button', { name: 'Run again' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Delete this run?');
    expect(host.requests.some((r) => r.method === 'DELETE')).toBe(false);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Delete' }));
    expect(await screen.findByRole('heading', { name: 'Runs' })).toBeInTheDocument();
    expect(host.requests.some((r) => r.method === 'DELETE' && r.path === `/runs/${uuid(1)}`)).toBe(true);
    expect(await screen.findByText('Run deleted')).toBeInTheDocument();
  });

  it('offers neither Delete nor Run again on a live run, and no Delete without runs:delete', async () => {
    const liveRun = run(1, { status: 'running', stopReason: null, finishedAt: null, steps: [] });
    const first = detail(createTestPlatformHost({ permissions: ['runs:read', 'runs:write', 'runs:delete'], responses: { [`GET /runs/${uuid(1)}`]: liveRun, [`GET /runs/${uuid(1)}/viewer`]: { hostId: null, hostName: null, desktop: false } } }), uuid(1));
    expect(await screen.findByRole('button', { name: 'Cancel run' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Run again' })).not.toBeInTheDocument();
    first.unmount();
    detail(createTestPlatformHost({ permissions: ['runs:read', 'runs:write'], responses: { [`GET /runs/${uuid(2)}`]: run(2, { steps: [] }) } }), uuid(2));
    expect(await screen.findByRole('button', { name: 'Run again' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete' })).not.toBeInTheDocument();
  });

  it('Pause (E38.2): beside Cancel while running, "Pausing…" at once; paused shows the banner with Resume and Cancel, and the browser view stays', async () => {
    const liveRun = run(1, { status: 'running', stopReason: null, finishedAt: null, steps: [] });
    const host = createTestPlatformHost({
      permissions: ['runs:read', 'runs:write'],
      responses: { [`GET /runs/${uuid(1)}`]: liveRun, [`GET /runs/${uuid(1)}/viewer`]: { hostId: null, hostName: null, desktop: false }, [`POST /runs/${uuid(1)}/pause`]: {}, [`POST /runs/${uuid(1)}/resume`]: {} },
    });
    const first = detail(host, uuid(1));
    expect(await screen.findByRole('button', { name: 'Cancel run' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Pause' }));
    expect(await screen.findByRole('button', { name: 'Pausing…' })).toBeDisabled();
    expect(host.requests.filter((r) => r.method === 'POST' && r.path === `/runs/${uuid(1)}/pause`)).toHaveLength(1);
    first.unmount();

    const pausedRun = run(2, { status: 'paused', stopReason: null, finishedAt: null, pauseRequested: true, pausedAt: new Date(T0).toISOString(), steps: [] });
    const host2 = createTestPlatformHost({
      permissions: ['runs:read', 'runs:write'],
      responses: { [`GET /runs/${uuid(2)}`]: pausedRun, [`GET /runs/${uuid(2)}/viewer`]: { hostId: null, hostName: null, desktop: false }, [`POST /runs/${uuid(2)}/resume`]: {} },
    });
    detail(host2, uuid(2));
    const banner = await screen.findByTestId('paused-banner');
    expect(banner).toHaveTextContent('Paused. Nothing happens until you resume.');
    expect(screen.queryByRole('button', { name: 'Pause' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Pausing…' })).not.toBeInTheDocument();
    expect(within(banner).getByRole('button', { name: 'Stop' })).toBeInTheDocument();
    // The browser view is still offered while paused.
    expect(screen.getByRole('button', { name: /Stop watching|Watch the browser/ })).toBeInTheDocument();
    fireEvent.click(within(banner).getByRole('button', { name: 'Resume' }));
    await waitFor(() => expect(host2.requests.some((r) => r.method === 'POST' && r.path === `/runs/${uuid(2)}/resume`)).toBe(true));
  });

  it('has no Pause, Resume or Stop without runs:write', async () => {
    const pausedRun = run(3, { status: 'paused', stopReason: null, finishedAt: null, pauseRequested: true, steps: [] });
    detail(createTestPlatformHost({ permissions: ['runs:read'], responses: { [`GET /runs/${uuid(3)}`]: pausedRun, [`GET /runs/${uuid(3)}/viewer`]: { hostId: null, hostName: null, desktop: false } } }), uuid(3));
    const banner = await screen.findByTestId('paused-banner');
    expect(within(banner).queryByRole('button')).not.toBeInTheDocument();
  });

  it('says a missing run does not exist any more, with a link to Runs', async () => {
    detail(createTestPlatformHost({ permissions: ['runs:read'], responses: {} }), uuid(9));
    expect(await screen.findByText('This run does not exist any more.')).toBeInTheDocument();
    expect(screen.getByText('It may have been deleted.')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'Go to Runs' })).toHaveAttribute('href', '/runs');
    expect(screen.queryByRole('alert')).not.toBeInTheDocument();
  });
});

describe('Run again after a confirmed step (#540)', () => {
  const STEP = { seq: 58, prompt: 'Send $10 to Person A?', action: 'click', at: '2026-11-18T19:00:00Z' };

  it('asks first in the runs list; Cancel starts nothing, Run again starts it', async () => {
    const host = createTestPlatformHost({
      permissions: ALL,
      responses: { 'GET /runs': { items: [run(1, { status: 'failed', confirmedActions: 1 }), run(2)], nextCursor: null }, 'GET /runs/counts': counts({ failed: 1, succeeded: 1 }), 'GET /tasks': [], 'POST /runs': { id: uuid(77) } },
    });
    renderList(host);
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Goal 1' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Run again' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Run this again?');
    expect(dialog).toHaveTextContent('This run already carried out a step you confirmed. Running it again may do it twice.');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(host.requests.some((r) => r.method === 'POST' && r.path === '/runs')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Actions for Goal 1' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Run again' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Run again' }));
    await waitFor(() => expect(host.requests.some((r) => r.method === 'POST' && r.path === '/runs')).toBe(true));
  });

  it('asks nothing for a run without confirmed steps', async () => {
    const host = createTestPlatformHost({
      permissions: ALL,
      responses: { 'GET /runs': { items: [run(2, { confirmedActions: 0 })], nextCursor: null }, 'GET /runs/counts': counts({ succeeded: 1 }), 'GET /tasks': [], 'POST /runs': { id: uuid(77) } },
    });
    renderList(host);
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for Goal 2' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'Run again' }));
    await waitFor(() => expect(host.requests.some((r) => r.method === 'POST' && r.path === '/runs')).toBe(true));
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument();
  });

  it('asks first on the run page, naming the step, and marks it in the timeline', async () => {
    const steps = [
      { id: 's57', seq: 57, kind: 'handoff', action: null, args: null, ok: true, summary: 'asked a person (confirmation)', reasoning: null, durationMs: 5, createdAt: '2026-11-18T19:00:00Z' },
      { id: 's58', seq: 58, kind: 'action', action: 'click', args: null, ok: true, summary: 'done', reasoning: null, durationMs: 5, createdAt: '2026-11-18T19:00:01Z' },
    ];
    const host = createTestPlatformHost({
      permissions: ['runs:read', 'runs:write'],
      responses: { [`GET /runs/${uuid(1)}`]: run(1, { status: 'failed', steps, confirmedActions: [STEP] } as Partial<RunListItem>), 'POST /runs': { id: uuid(77) } },
    });
    render(
      <PlatformHostProvider host={host}>
        <ConfirmProvider>
          <MemoryRouter initialEntries={[`/runs/${uuid(1)}`]}>
            <Routes>
              <Route path="/runs/:id" element={<RunDetailPage />} />
            </Routes>
          </MemoryRouter>
        </ConfirmProvider>
      </PlatformHostProvider>,
    );
    expect(await screen.findByTestId('confirmed-58')).toHaveTextContent('Confirmed by you');
    expect(screen.queryByTestId('confirmed-57')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Run again' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent("This run already carried out a step you confirmed: 'Send $10 to Person A?'. Running it again may do it twice.");
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(host.requests.some((r) => r.method === 'POST')).toBe(false);
  });
});
