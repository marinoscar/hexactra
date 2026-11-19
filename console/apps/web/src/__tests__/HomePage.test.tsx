// The Home page (#430): what it says, which blocks it renders, what its
// buttons send, and when it reads the summary again.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { InboxCountProvider, useInboxCount } from '../components/InboxCountProvider';
import { NEW_RUN_LINK, budgetColor, checklistSteps, greeting, liveLine, recentTasks, statusSentence, timeLeft, upNextWhen, weekRunsLink } from '../components/home/homeText';
import { NO_FILTERS, filtersFromParams } from '../components/runFilters';
import { HOME_ONBOARDED_KEY, HOME_POLL_LIVE_MS, HOME_POLL_MS, HomePage } from '../pages/HomePage';
import type { HomeLiveRun, HomeQuestion, HomeRecentRun, HomeSummary } from '../types/home';
import { ConfirmProvider } from '../ui';
import { mockViewport } from './matchMedia';

// The chart draws SVG that jsdom cannot measure; its own module is a lazy chunk.
vi.mock('../components/home/HomeWeekChart', () => ({ default: ({ series }: { series: unknown[] }) => <div data-testid="week-chart">{series.length} days</div> }));

const NOW = Date.parse('2026-11-17T10:00:00Z');
const iso = (ms: number) => new Date(NOW + ms).toISOString();
const MIN = 60_000;
const HOUR = 60 * MIN;
const ALL = ['runs:read', 'runs:write', 'tasks:read', 'tasks:write', 'fleet:read'];

const question = (over: Partial<HomeQuestion> = {}): HomeQuestion => ({
  questionId: 'q-1',
  runId: 'run-wait',
  kind: 'confirmation',
  input: 'confirm',
  prompt: 'Buy the ticket for 120 EUR?',
  risk: 'low',
  expiresAt: iso(4 * MIN + 30_000),
  createdAt: iso(-MIN),
  goal: 'Book the fare',
  ...over,
});
const liveRun = (over: Partial<HomeLiveRun> = {}): HomeLiveRun => ({
  id: 'run-1',
  taskId: 'task-1',
  taskName: 'Morning report',
  goal: 'Read the report',
  status: 'running',
  activity: { phase: 'acting', action: 'click_at', reason: 'Open the report', startedAt: iso(-5_000), note: null },
  stepCount: 12,
  startedAt: iso(-2 * MIN),
  hostId: 'host-1',
  hostName: 'den-mini',
  policyName: 'Balanced',
  currentTier: 'standard',
  startTier: 'standard',
  budgetPercent: 62,
  budgetWarnPercent: 80,
  ...over,
});
const recentRun = (over: Partial<HomeRecentRun> = {}): HomeRecentRun => ({
  id: 'done-1',
  taskId: 'task-2',
  taskName: 'Fare watch',
  goal: 'Check the fare',
  status: 'succeeded',
  trigger: 'schedule',
  createdAt: iso(-HOUR),
  startedAt: iso(-HOUR),
  finishedAt: iso(-HOUR + 3 * MIN),
  stepCount: 14,
  stopReason: 'finished',
  costUsd: 0.42,
  costKnown: true,
  error: null,
  ...over,
});

const quiet = (): HomeSummary => ({
  generatedAt: iso(0),
  timezone: 'UTC',
  needsYou: { count: 0, items: [] },
  liveRuns: { count: 0, running: 0, items: [] },
  upcoming: { items: [], pausedCount: 0, failingCount: 0 },
  recentRuns: { items: [] },
  week: {
    totals: { succeeded: 0, failed: 0, cancelled: 0, successRate: null, costUsd: null, costKnown: true, budgetStops: 0, stalled: 0 },
    series: Array.from({ length: 7 }, (_, i) => ({ date: `2026-11-${11 + i}`, succeeded: 0, failed: 0, cancelled: 0, costUsd: null })),
  },
  fleet: { total: 1, online: 1, disabled: 0, stale: false, hosts: [{ id: 'host-1', name: 'den-mini', online: true, draining: false, mode: 'unattended' }] },
  counts: { tasks: 2, runs: 9 },
});

const busy = (): HomeSummary => ({
  ...quiet(),
  needsYou: {
    count: 5,
    items: [question(), question({ questionId: 'q-2', prompt: 'Delete the account?', risk: 'high', runId: null, goal: null, expiresAt: iso(10 * MIN) }), question({ questionId: 'q-3', input: 'secret', kind: 'code', prompt: 'Enter the code', risk: null })],
  },
  liveRuns: {
    count: 3,
    running: 2,
    items: [liveRun(), liveRun({ id: 'run-2', taskId: null, taskName: null, goal: 'Free roaming', budgetPercent: null, budgetWarnPercent: null, hostName: null, currentTier: 'frontier', activity: { phase: 'thinking', action: null, reason: null, startedAt: iso(-1000), note: null } }), liveRun({ id: 'run-wait', status: 'waiting_human', activity: null, taskId: 'task-2', taskName: 'Fare watch', budgetPercent: 91 })],
  },
  upcoming: {
    items: [
      { scheduleId: 's-1', taskId: 'task-1', taskName: 'Morning report', nextRunAt: iso(3 * HOUR), description: 'Monday to Friday at 09:00', timezone: 'UTC' },
      { scheduleId: 's-2', taskId: 'task-2', taskName: 'Fare watch', nextRunAt: iso(26 * HOUR), description: 'Every day at 12:00', timezone: 'UTC' },
    ],
    pausedCount: 2,
    failingCount: 1,
  },
  recentRuns: {
    items: [recentRun(), recentRun({ id: 'done-2', taskId: null, taskName: null, goal: 'One-off goal', status: 'failed', stopReason: 'budget_cost', costUsd: 2, costKnown: false, error: 'The page did not load' }), recentRun({ id: 'done-3', taskId: 'task-3', taskName: 'Third task', status: 'cancelled', stopReason: 'cancelled', costUsd: null })],
  },
  week: {
    totals: { succeeded: 11, failed: 3, cancelled: 1, successRate: 0.7857, costUsd: 18.4, costKnown: true, budgetStops: 3, stalled: 1 },
    series: Array.from({ length: 7 }, (_, i) => ({ date: `2026-11-${11 + i}`, succeeded: i, failed: i % 2, cancelled: 0, costUsd: i || null })),
  },
  fleet: {
    total: 3,
    online: 2,
    disabled: 1,
    stale: false,
    hosts: [
      { id: 'host-1', name: 'den-mini', online: true, draining: false, mode: 'unattended' },
      { id: 'host-2', name: 'office-nuc', online: true, draining: true, mode: 'attended' },
      { id: 'host-3', name: 'attic-box', online: false, draining: false, mode: null },
    ],
  },
});

function Where() {
  const l = useLocation();
  return <div data-testid="where">{`${l.pathname}${l.search}`}</div>;
}

function mount(summary: HomeSummary | (() => HomeSummary), opts: { permissions?: string[]; responses?: Record<string, unknown> } = {}) {
  const host = createTestPlatformHost({
    permissions: opts.permissions ?? ALL,
    responses: { 'GET /home/summary': typeof summary === 'function' ? () => summary() : summary, ...opts.responses },
  });
  const view = render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={['/']}>
          <Routes>
            <Route path="/" element={<HomePage />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  return { host, ...view };
}
const reads = (host: { requests: { method: string; path: string }[] }) => host.requests.filter((r) => r.method === 'GET' && r.path === '/home/summary').length;
const hrefOf = (name: string | RegExp, within_: HTMLElement = document.body) => within(within_).getByRole('link', { name }).getAttribute('href');

/** The navigation badge's number, as the shell reads it. */
function Badge() {
  return <div data-testid="badge">{useInboxCount().count}</div>;
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
  vi.useRealTimers();
  window.localStorage.clear();
  Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
});

describe('the words of the Home page', () => {
  it('builds the status sentence for the three cases, and their variants', () => {
    expect(statusSentence(busy(), NOW, 'UTC')).toBe('2 agents are running and 5 are waiting for you.');
    const one = busy();
    one.liveRuns = { count: 1, running: 1, items: [liveRun()] };
    one.needsYou = { count: 1, items: [question()] };
    expect(statusSentence(one, NOW, 'UTC')).toBe('1 agent is running and 1 is waiting for you.');
    one.needsYou = { count: 0, items: [] };
    expect(statusSentence(one, NOW, 'UTC')).toBe('1 agent is running.');

    const next = quiet();
    next.upcoming = busy().upcoming;
    expect(statusSentence(next, NOW, 'UTC')).toBe('Nothing is running. Next: Morning report in 3 h.');
    expect(statusSentence(quiet(), NOW, 'UTC')).toBe('All quiet.');

    const waiting = quiet();
    waiting.needsYou = { count: 2, items: [question(), question({ questionId: 'q-2' })] };
    expect(statusSentence(waiting, NOW, 'UTC')).toBe('2 agents are waiting for you.');
    const queued = quiet();
    queued.liveRuns = { count: 1, running: 0, items: [liveRun({ status: 'queued', activity: null })] };
    expect(statusSentence(queued, NOW, 'UTC')).toBe('1 run is waiting for a machine.');

    // A paused run is not "waiting for a machine": it waits for its owner to resume it (E38.2).
    const paused = quiet();
    paused.liveRuns = { count: 2, running: 0, items: [liveRun({ status: 'paused', activity: null }), liveRun({ id: 'run-p2', status: 'paused', activity: null })] };
    expect(statusSentence(paused, NOW, 'UTC')).toBe('2 runs are paused: resume them when you are ready.');
    expect(liveLine(liveRun({ status: 'paused', activity: null }))).toBe('Paused: waiting for you to resume it');

    const nothing: HomeSummary = { ...quiet(), needsYou: null, liveRuns: null, upcoming: null, recentRuns: null, week: null, fleet: null, counts: { tasks: null, runs: null } };
    expect(statusSentence(nothing, NOW, 'UTC')).toBe('Ask an administrator for access to tasks and runs.');
  });

  it('greets by the clock of the profile time zone', () => {
    expect(greeting(Date.parse('2026-11-17T10:00:00Z'), 'UTC')).toBe('Good morning');
    expect(greeting(Date.parse('2026-11-17T10:00:00Z'), 'Asia/Tokyo')).toBe('Good evening');
    expect(greeting(Date.parse('2026-11-17T13:00:00Z'), 'UTC')).toBe('Good afternoon');
  });

  it('counts down, places a firing, colours the budget and builds the week links', () => {
    expect(timeLeft(iso(4 * MIN + 30_000), NOW)).toBe('4 min left');
    expect(timeLeft(iso(45_000), NOW)).toBe('45 s left');
    expect(timeLeft(iso(-1), NOW)).toBe('expired');
    expect(upNextWhen(iso(3 * HOUR), NOW, 'UTC')).toBe('Today 13:00 · in 3 h');
    expect(upNextWhen(iso(26 * HOUR), NOW, 'UTC')).toBe('Tomorrow 12:00');
    expect(upNextWhen(iso(4 * 24 * HOUR), NOW, 'UTC')).toBe('Sat, Nov 21 10:00');
    expect([budgetColor(62, 80), budgetColor(62, 60), budgetColor(85, null), budgetColor(100, 80)]).toEqual(['primary', 'warning', 'warning', 'error']);
    expect(weekRunsLink('2026-11-11')).toBe('/runs?view=failed&from=2026-11-11');
    expect(weekRunsLink('2026-11-11', 'budget')).toBe('/runs?view=failed&stopReason=budget&from=2026-11-11');
  });

  it('links to the Runs page in the words its filters read (#423): nothing is dropped on arrival', () => {
    const read = (link: string) => filtersFromParams(new URLSearchParams(link.split('?')[1]));
    expect(read(weekRunsLink('2026-11-11'))).toEqual({ ...NO_FILTERS, view: 'failed', from: '2026-11-11' });
    expect(read(weekRunsLink('2026-11-11', 'budget'))).toEqual({ ...NO_FILTERS, view: 'failed', from: '2026-11-11', stopReason: ['budget'] });
    expect(read(weekRunsLink('2026-11-11', 'stalled'))).toEqual({ ...NO_FILTERS, view: 'failed', from: '2026-11-11', stopReason: ['stalled'] });
    // "More options" opens the New run dialog and is not a filter.
    expect(NEW_RUN_LINK).toBe('/runs?new=1');
    expect(read(NEW_RUN_LINK)).toEqual(NO_FILTERS);
  });

  it('offers the most recently run tasks once each, four at most', () => {
    expect(recentTasks(busy())).toEqual([
      { id: 'task-1', name: 'Morning report' },
      { id: 'task-2', name: 'Fare watch' },
      { id: 'task-3', name: 'Third task' },
    ]);
    const many = busy();
    many.recentRuns = { items: Array.from({ length: 8 }, (_, i) => recentRun({ id: `d-${i}`, taskId: `t-${i}`, taskName: `Task ${i}` })) };
    expect(recentTasks(many)).toHaveLength(4);
  });

  it('ticks the first-run steps from the data and leaves out the ones the viewer may not do', () => {
    const fresh = quiet();
    fresh.fleet = { total: 0, online: 0, disabled: 0, stale: false, hosts: [] };
    fresh.counts = { tasks: 1, runs: 0 };
    expect(checklistSteps(fresh, () => true).map((s) => [s.key, s.done])).toEqual([
      ['machine', false],
      ['task', true],
      ['run', false],
    ]);
    expect(checklistSteps(fresh, (p) => p === 'tasks:write').map((s) => s.key)).toEqual(['machine', 'task']);
    expect(checklistSteps({ ...fresh, fleet: null }, () => false)).toEqual([]);
  });
});

describe('HomePage: a busy account', () => {
  it('puts Needs you first, with the countdown and the Answer link', async () => {
    vi.useFakeTimers({ now: NOW, shouldAdvanceTime: true });
    mount(busy());
    const needs = await screen.findByTestId('home-needs-you');
    expect(screen.getByTestId('home-status')).toHaveTextContent('2 agents are running and 5 are waiting for you.');
    expect(screen.getByRole('heading', { level: 1 })).toHaveTextContent('Good morning');
    // Before every other block in the document.
    for (const id of ['home-running', 'home-quick-start', 'home-up-next', 'home-recent-runs', 'home-week', 'home-machines']) {
      expect(needs.compareDocumentPosition(screen.getByTestId(id)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    }
    const first = within(needs).getByTestId('home-question-q-1');
    expect(first).toHaveTextContent('Buy the ticket for 120 EUR?');
    expect(first).toHaveTextContent('Confirm');
    expect(within(first).getByRole('timer')).toHaveTextContent('4 min left');
    expect(hrefOf(/^Answer: Buy the ticket/, first)).toBe('/inbox?q=q-1');
    expect(hrefOf('View all (5)', needs)).toBe('/inbox');
    // The countdown moves.
    await act(async () => {
      await vi.advanceTimersByTimeAsync(40_000);
    });
    expect(within(first).getByRole('timer')).toHaveTextContent('3 min left');
  });

  it('approves a low-risk confirmation inline, and sends a high-risk one to the Inbox', async () => {
    const { host } = mount(busy(), { responses: { 'POST /questions/q-1/answer': { id: 'q-1', status: 'answered' } } });
    const low = await screen.findByTestId('home-question-q-1');
    const high = screen.getByTestId('home-question-q-2');
    expect(within(high).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(within(high).queryByRole('button', { name: 'Deny' })).toBeNull();
    expect(hrefOf(/^Answer: Delete the account/, high)).toBe('/inbox?q=q-2');
    // A secret is never typed here either.
    expect(within(screen.getByTestId('home-question-q-3')).queryByRole('textbox')).toBeNull();

    fireEvent.click(within(low).getByRole('button', { name: 'Approve' }));
    await waitFor(() => expect(host.requests.some((r) => r.method === 'POST' && r.path === '/questions/q-1/answer')).toBe(true));
    const sent = host.requests.find((r) => r.method === 'POST' && r.path === '/questions/q-1/answer')!;
    expect(sent.body).toEqual({ outcome: 'completed', value: 'approve', channel: 'web' });
    await waitFor(() => expect(reads(host)).toBe(2)); // the summary is read again
  });

  it('shows a failed inline answer inside the Needs you card', async () => {
    mount(busy(), {
      responses: {
        'POST /questions/q-1/answer': () => {
          throw new Error('The question has expired');
        },
      },
    });
    const needs = await screen.findByTestId('home-needs-you');
    fireEvent.click(within(needs).getAllByRole('button', { name: 'Deny' })[0]!);
    expect(await within(needs).findByRole('alert')).toHaveTextContent('The question has expired');
  });

  it('shows what each live run is doing, its budget bar, and no bar for an unlimited run', async () => {
    vi.useFakeTimers({ now: NOW, shouldAdvanceTime: true });
    mount(busy());
    const first = await screen.findByTestId('home-live-run-1');
    expect(within(first).getByTestId('home-live-activity')).toHaveTextContent('Doing: click_at · Open the report');
    expect(first).toHaveTextContent('Morning report');
    expect(first).toHaveTextContent('step 12 · 2 min · den-mini');
    expect(within(first).getByTestId('home-live-budget')).toHaveTextContent('62 % of budget');
    expect(within(first).getByRole('progressbar', { name: 'Budget used' })).toHaveAttribute('aria-valuenow', '62');
    expect(within(first).queryByTestId('home-live-tier')).toBeNull();
    expect(hrefOf(/^Watch: Morning report/, first)).toBe('/runs/run-1');

    const unlimited = screen.getByTestId('home-live-run-2');
    expect(unlimited).toHaveTextContent('Free roaming');
    expect(within(unlimited).getByTestId('home-live-activity')).toHaveTextContent('Thinking about the next step');
    expect(within(unlimited).queryByTestId('home-live-budget')).toBeNull();
    // On a stronger tier than the policy starts on.
    expect(within(unlimited).getByTestId('home-live-tier')).toHaveTextContent('frontier tier');

    const waiting = screen.getByTestId('home-live-run-wait');
    expect(within(waiting).getByTestId('home-live-activity')).toHaveTextContent('Waiting for your answer');
    expect(within(waiting).getByRole('progressbar', { name: 'Budget used' }).className).toMatch(/colorWarning/);
  });

  it('starts a run from the goal box and opens it', async () => {
    const { host } = mount(busy(), { responses: { 'POST /runs': { id: 'new-run' } } });
    const quick = await screen.findByTestId('home-quick-start');
    const run = within(quick).getByRole('button', { name: 'Run' });
    expect(run).toBeDisabled();
    fireEvent.change(within(quick).getByLabelText('What should your agent do?'), { target: { value: '  Find the cheapest fare  ' } });
    fireEvent.click(run);
    expect(await screen.findByTestId('where')).toHaveTextContent('/runs/new-run');
    expect(host.requests.find((r) => r.method === 'POST' && r.path === '/runs')!.body).toEqual({ goal: 'Find the cheapest fare', profile: 'default' });
  });

  it("runs a recent task from its chip, under the task's own policy, and has no policy select", async () => {
    const { host } = mount(busy(), { responses: { 'POST /tasks/task-2/runs': { id: 'task-run' } } });
    const quick = await screen.findByTestId('home-quick-start');
    expect(within(quick).getByText('Run: Morning report')).toBeInTheDocument();
    expect(within(quick).queryByRole('combobox')).toBeNull();
    expect(hrefOf('More options', quick)).toBe('/runs?new=1');
    fireEvent.click(within(quick).getByText('Run: Fare watch'));
    expect(await screen.findByTestId('where')).toHaveTextContent('/runs/task-run');
    expect(host.requests.find((r) => r.method === 'POST' && r.path === '/tasks/task-2/runs')!.body).toEqual({});
  });

  it('renders Up next, Recent runs, This week and Machines from the summary', async () => {
    vi.useFakeTimers({ now: NOW, shouldAdvanceTime: true });
    mount(busy());
    const next = await screen.findByTestId('home-up-next');
    expect(next).toHaveTextContent('Morning report');
    expect(next).toHaveTextContent('Today 13:00 · in 3 h');
    expect(next).toHaveTextContent('Monday to Friday at 09:00');
    expect(next).toHaveTextContent('Tomorrow 12:00');
    // A task's name opens the task's page.
    expect(hrefOf('Morning report', next)).toBe('/tasks/task-1');
    expect(hrefOf('Fare watch', next)).toBe('/tasks/task-2');
    expect(hrefOf('2 paused', next)).toBe('/tasks?filter=paused');
    expect(hrefOf('1 failing', next)).toBe('/tasks?filter=failing');

    const recent = screen.getByTestId('home-recent-runs');
    const failed = within(recent).getByTestId('home-recent-done-2');
    expect(failed).toHaveAttribute('href', '/runs/done-2');
    expect(failed).toHaveTextContent('failed · cost budget');
    expect(failed).toHaveTextContent('One-off goal');
    expect(failed).toHaveTextContent('The page did not load');
    expect(within(failed).getByTestId('home-recent-cost')).toHaveTextContent('≥ $2.00');
    const ok = within(recent).getByTestId('home-recent-done-1');
    expect(ok).toHaveTextContent('Fare watch');
    expect(ok).toHaveTextContent('3 min');
    expect(within(ok).getByTestId('home-recent-cost')).toHaveTextContent('$0.42');
    expect(within(within(recent).getByTestId('home-recent-done-3')).queryByTestId('home-recent-cost')).toBeNull();
    expect(hrefOf('All runs', recent)).toBe('/runs');

    const week = screen.getByTestId('home-week');
    expect(within(week).getByTestId('home-week-runs')).toHaveTextContent('15');
    expect(within(week).getByTestId('home-week-rate')).toHaveTextContent('79 %');
    expect(within(week).getByTestId('home-week-failed')).toHaveTextContent('3');
    expect(within(week).getByTestId('home-week-spend')).toHaveTextContent('$18.40');
    expect(hrefOf('Failed: 3', week)).toBe('/runs?view=failed&from=2026-11-11');
    expect(hrefOf('3 stopped by budget', week)).toBe('/runs?view=failed&stopReason=budget&from=2026-11-11');
    expect(hrefOf('1 stalled', week)).toBe('/runs?view=failed&stopReason=stalled&from=2026-11-11');
    expect(await within(week).findByTestId('week-chart')).toHaveTextContent('7 days');
    // The same numbers as a table for a screen reader.
    expect(within(within(week).getByTestId('home-week-table')).getAllByRole('row')).toHaveLength(8);

    const machines = screen.getByTestId('home-machines');
    expect(machines).toHaveTextContent('2 of 3 online · 1 disabled');
    expect(machines).toHaveTextContent('den-mini');
    expect(within(machines).getByText('offline')).toBeInTheDocument();
    expect(within(machines).getByText('disabled')).toBeInTheDocument();
    expect(hrefOf('Manage machines', machines)).toBe('/fleet');
    expect(within(machines).queryByTestId('home-machines-stale')).toBeNull();
  });

  it('shows Spend as known, as a lower bound, and not at all', async () => {
    const lower = busy();
    lower.week!.totals = { ...lower.week!.totals, costKnown: false, budgetStops: 0, stalled: 0 };
    const a = mount(lower);
    expect(await screen.findByTestId('home-week-spend')).toHaveTextContent('≥ $18.40');
    expect(screen.queryByTestId('home-week-stops')).toBeNull();
    a.unmount();

    const none = busy();
    none.week!.totals = { ...none.week!.totals, costUsd: null };
    mount(none);
    await screen.findByTestId('home-week');
    expect(screen.queryByTestId('home-week-spend')).toBeNull();
  });
});

describe('HomePage: quiet, new and restricted accounts', () => {
  it('a quiet account: one muted line instead of a Running card, and no Needs you', async () => {
    mount(quiet());
    expect(await screen.findByTestId('home-running-empty')).toHaveTextContent('No agent is running right now.');
    expect(screen.getByTestId('home-status')).toHaveTextContent('All quiet.');
    expect(screen.queryByTestId('home-needs-you')).toBeNull();
    expect(screen.getByTestId('home-up-next')).toHaveTextContent('Nothing is scheduled.');
    expect(hrefOf('Schedule a task', screen.getByTestId('home-up-next'))).toBe('/tasks');
    expect(screen.queryByTestId('home-get-started')).toBeNull();
    // No run in the week: figures, no chart.
    expect(screen.queryByTestId('week-chart')).toBeNull();
  });

  it('a brand-new account sees the checklist instead of the dashboard blocks, ticked from the data', async () => {
    const fresh = quiet();
    fresh.fleet = { total: 0, online: 0, disabled: 0, stale: false, hosts: [] };
    fresh.counts = { tasks: 1, runs: 0 };
    mount(fresh);
    const card = await screen.findByTestId('home-get-started');
    expect(within(card).getByTestId('home-step-machine')).toHaveAttribute('data-done', 'false');
    expect(within(card).getByTestId('home-step-task')).toHaveAttribute('data-done', 'true');
    expect(within(card).getByTestId('home-step-run')).toHaveAttribute('data-done', 'false');
    expect(hrefOf('1. Connect a machine', card)).toBe('/fleet');
    expect(hrefOf('3. Run it', card)).toBe('/tasks');
    // "Create a task" opens the form, not the list.
    expect(checklistSteps({ ...fresh, counts: { tasks: 0, runs: 0 } }, () => true).map((s) => s.to)).toEqual(['/fleet', '/tasks/new', '/tasks']);
    for (const id of ['home-quick-start', 'home-up-next', 'home-recent-runs', 'home-week', 'home-running-empty']) expect(screen.queryByTestId(id)).toBeNull();
    // The machines block stays: it says what is missing.
    expect(screen.getByTestId('home-machines')).toHaveTextContent('No machine is connected.');
    expect(hrefOf('Connect a machine', screen.getByTestId('home-machines'))).toBe('/fleet');
  });

  it('the checklist disappears once every step is done, and does not come back', async () => {
    let current = quiet();
    current.counts = { tasks: 0, runs: 0 };
    const first = mount(() => current);
    expect(await screen.findByTestId('home-get-started')).toBeInTheDocument();
    first.unmount();

    current = quiet(); // a machine, tasks and runs
    const second = mount(() => current);
    expect(await screen.findByTestId('home-quick-start')).toBeInTheDocument();
    expect(screen.queryByTestId('home-get-started')).toBeNull();
    // The page records it in an effect, a render after the dashboard is on screen (#502).
    await waitFor(() => expect(window.localStorage.getItem(HOME_ONBOARDED_KEY)).toBe('1'));
    second.unmount();

    // Every run deleted later: still the dashboard.
    current = quiet();
    current.counts = { tasks: 2, runs: 0 };
    mount(() => current);
    expect(await screen.findByTestId('home-quick-start')).toBeInTheDocument();
    expect(screen.queryByTestId('home-get-started')).toBeNull();
  });

  it('null blocks render nothing and leave no empty container', async () => {
    const only: HomeSummary = { ...quiet(), needsYou: null, liveRuns: null, upcoming: null, recentRuns: null, week: null, counts: { tasks: null, runs: null } };
    mount(only, { permissions: ['fleet:read'] });
    expect(await screen.findByTestId('home-machines')).toBeInTheDocument();
    for (const id of ['home-needs-you', 'home-running', 'home-running-empty', 'home-quick-start', 'home-up-next', 'home-recent-runs', 'home-week', 'home-get-started']) expect(screen.queryByTestId(id)).toBeNull();
    // One column, holding the machines card and nothing else.
    const columns = screen.getByTestId('home-columns');
    expect(columns.children).toHaveLength(1);
    expect(columns.children[0]!.children).toHaveLength(1);
  });

  it('a user with no permission sees the greeting and whom to ask', async () => {
    const nothing: HomeSummary = { ...quiet(), needsYou: null, liveRuns: null, upcoming: null, recentRuns: null, week: null, fleet: null, counts: { tasks: null, runs: null } };
    mount(nothing, { permissions: [] });
    await waitFor(() => expect(screen.getByTestId('home-status')).toHaveTextContent('Ask an administrator for access to tasks and runs.'));
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.queryByTestId('home-columns')).toBeNull();
    expect(screen.queryByRole('button')).toBeNull();
  });

  it('a viewer gets the read blocks and no write control', async () => {
    mount(busy(), { permissions: ['runs:read', 'tasks:read', 'fleet:read'] });
    const needs = await screen.findByTestId('home-needs-you');
    expect(within(needs).queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(within(needs).queryByRole('button', { name: 'Deny' })).toBeNull();
    expect(hrefOf(/^Open: Buy the ticket/, needs)).toBe('/inbox?q=q-1');
    expect(screen.queryByTestId('home-quick-start')).toBeNull();
    expect(screen.queryByRole('button', { name: 'New run' })).toBeNull();
    expect(screen.getByTestId('home-recent-runs')).toBeInTheDocument();
    expect(screen.getByTestId('home-up-next')).toBeInTheDocument();
  });

  it('says when the machine status may be out of date', async () => {
    const stale = quiet();
    stale.fleet = { ...stale.fleet!, stale: true };
    mount(stale);
    expect(await screen.findByTestId('home-machines-stale')).toHaveTextContent('Status may be out of date.');
  });
});

describe('HomePage: loading, errors and polling', () => {
  it('shows a skeleton for every block on the first load', async () => {
    let release: (s: HomeSummary) => void = () => undefined;
    const host = createTestPlatformHost({ permissions: ALL, responses: { 'GET /home/summary': () => new Promise<HomeSummary>((resolve) => (release = resolve)) } });
    render(
      <PlatformHostProvider host={host}>
        <MemoryRouter>
          <HomePage />
        </MemoryRouter>
      </PlatformHostProvider>,
    );
    for (const id of ['running', 'quick-start', 'recent-runs', 'up-next', 'week']) expect(screen.getByTestId(`home-skeleton-${id}`)).toBeInTheDocument();
    await act(async () => release(quiet()));
    expect(await screen.findByTestId('home-machines')).toBeInTheDocument();
    expect(screen.queryByTestId('home-skeleton-week')).toBeNull();
  });

  it('a failed first read keeps the greeting and the goal box, and Retry reads again', async () => {
    let fail = true;
    const { host } = mount(() => {
      if (fail) throw new Error('The server did not answer');
      return quiet();
    });
    expect(await screen.findByRole('alert')).toHaveTextContent('The server did not answer');
    expect(screen.getByRole('heading', { level: 1 })).toBeInTheDocument();
    expect(screen.getByTestId('home-quick-start')).toBeInTheDocument();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    expect(await screen.findByTestId('home-machines')).toBeInTheDocument();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(reads(host)).toBe(2);
  });

  it('a failed later read keeps the last good data on screen, with when it was read', async () => {
    vi.useFakeTimers({ now: NOW, shouldAdvanceTime: true });
    let fail = false;
    mount(() => {
      if (fail) throw new Error('The server did not answer');
      return busy();
    });
    expect(await screen.findByTestId('home-needs-you')).toBeInTheDocument();
    fail = true;
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOME_POLL_LIVE_MS);
    });
    const banner = await screen.findByTestId('home-error');
    expect(banner).toHaveTextContent('The server did not answer');
    expect(banner).toHaveTextContent(/Updated (just now|\d+ min ago)/);
    expect(screen.getByTestId('home-needs-you')).toBeInTheDocument();
    expect(screen.getByTestId('home-recent-runs')).toBeInTheDocument();
  });

  it('reads every 5 s while something is live and every 10 s otherwise', async () => {
    vi.useFakeTimers({ now: NOW });
    let current = busy();
    const { host } = mount(() => current);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(reads(host)).toBe(1);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOME_POLL_LIVE_MS);
    });
    expect(reads(host)).toBe(2);
    current = quiet();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOME_POLL_LIVE_MS);
    });
    expect(reads(host)).toBe(3); // this read says nothing is live any more
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOME_POLL_LIVE_MS);
    });
    expect(reads(host)).toBe(3); // 5 s later: nothing
    await act(async () => {
      await vi.advanceTimersByTimeAsync(HOME_POLL_MS - HOME_POLL_LIVE_MS);
    });
    expect(reads(host)).toBe(4); // 10 s after the last read
  });

  it('pauses while the tab is hidden, and reads at once when it is shown again or the window gets the focus', async () => {
    vi.useFakeTimers({ now: NOW });
    const { host } = mount(quiet());
    await act(async () => {
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(reads(host)).toBe(1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'hidden' });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(5 * HOME_POLL_MS);
    });
    expect(reads(host)).toBe(1);
    Object.defineProperty(document, 'visibilityState', { configurable: true, value: 'visible' });
    await act(async () => {
      document.dispatchEvent(new Event('visibilitychange'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(reads(host)).toBe(2);
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
      await vi.advanceTimersByTimeAsync(0);
    });
    expect(reads(host)).toBe(3);
  });
});

describe('HomePage: layout', () => {
  it('is one column on a phone, in order of urgency, and two from md', async () => {
    restore = mockViewport(390);
    mount(busy());
    const columns = await screen.findByTestId('home-columns');
    // Two wrappers (`display: contents` on a phone), five slots ordered 1..5 by CSS `order`.
    expect(columns.children).toHaveLength(2);
    const slots = [...columns.children].flatMap((c) => [...c.children]) as HTMLElement[];
    const order = (id: string) => slots.findIndex((slot) => slot.querySelector(`[data-testid="${id}"]`) !== null);
    expect(order('home-quick-start')).toBe(0);
    expect(order('home-recent-runs')).toBe(1);
    expect(order('home-up-next')).toBe(2);
    expect(order('home-week')).toBe(3);
    expect(order('home-machines')).toBe(4);
    // The phone has no "New run" button in the header: the goal box is the action.
    const header = screen.getByRole('heading', { level: 1 }).parentElement!.parentElement!;
    expect(within(header).getByRole('button', { name: 'New run', hidden: true })).toBeInTheDocument();
  });
});

describe('HomePage: the navigation badge', () => {
  it('re-reads the Inbox count when the summary says another number, and not while they agree (#431)', async () => {
    let waiting = 1;
    const summary = () => {
      const s = quiet();
      s.needsYou = { count: waiting, items: Array.from({ length: waiting }, (_, i) => question({ questionId: `q-${i + 1}` })) };
      return s;
    };
    const host = createTestPlatformHost({
      permissions: ALL,
      responses: { 'GET /home/summary': () => summary(), 'GET /inbox': () => Array.from({ length: waiting }, (_, i) => ({ questionId: `q-${i + 1}` })) },
    });
    const inboxReads = () => host.requests.filter((r) => r.method === 'GET' && r.path === '/inbox').length;
    render(
      <PlatformHostProvider host={host}>
        <ConfirmProvider>
          <MemoryRouter initialEntries={['/']}>
            <InboxCountProvider>
              <HomePage />
              <Badge />
            </InboxCountProvider>
          </MemoryRouter>
        </ConfirmProvider>
      </PlatformHostProvider>,
    );
    expect(await screen.findByTestId('home-needs-you')).toBeInTheDocument();
    await waitFor(() => expect(screen.getByTestId('badge')).toHaveTextContent('1'));
    const settled = inboxReads();

    // A second question arrives: the page's next read sees it, and the badge follows without waiting for its own poll.
    waiting = 2;
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(screen.getByTestId('home-status')).toHaveTextContent('2 agents are waiting for you.'));
    await waitFor(() => expect(screen.getByTestId('badge')).toHaveTextContent('2'));
    expect(inboxReads()).toBe(settled + 1);

    // The same number again: no extra read.
    await act(async () => {
      window.dispatchEvent(new Event('focus'));
    });
    await waitFor(() => expect(reads(host)).toBeGreaterThanOrEqual(3));
    expect(inboxReads()).toBe(settled + 1);
  });
});
