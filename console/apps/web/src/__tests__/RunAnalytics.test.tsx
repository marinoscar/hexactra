// Runs Analytics (E53.5, #1073): the tiles, the trend table, the breakdown with links to the runs (own page only), the period and
// breakdown controls, the admin variant (by user, no links, no export), loading, empty and error states, the dataset export, and the
// Tokens column of the runs list's helper.
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost, type TestApiRequest } from '@marinoscar/platform-web/testing';
import type { ReactElement } from 'react';

import { rowTokens } from '../components/runRow';
import { AdminRunAnalyticsPage, MyRunAnalyticsPage } from '../pages/RunAnalyticsPage';
import { shortDay } from '../runAnalytics/RunsTrendChart';
import { formatCount, formatDuration, periodOf, runsLink, type RunStats, type StatsGroup } from '../runAnalytics/api';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

const TASK = '11111111-1111-4111-8111-111111111111';
const d = (p50: number, p90: number, sum = p50 * 10) => ({ n: 10, sum, mean: p50, min: 0, p50, p90, max: p90 * 2 });
function group(over: Partial<StatsGroup> = {}): StatsGroup {
  return {
    runs: 12,
    finished: 10,
    live: 2,
    byStatus: { queued: 0, running: 2, waiting_human: 0, paused: 0, succeeded: 8, failed: 1, cancelled: 1 },
    successRate: 0.8,
    costPerSuccessUsd: 0.0525,
    costKnown: true,
    metrics: { workingMs: d(90_000, 300_000), wallMs: d(120_000, 600_000), steps: d(19, 52), modelCalls: d(30, 80), inputTokens: d(40_000, 120_000), cachedInputTokens: d(10_000, 30_000), outputTokens: d(2_000, 6_000), totalTokens: d(42_000, 126_000), costUsd: d(0.04, 0.11, 0.42) },
    ...over,
  };
}
const stats = (groupBy: string, over: Partial<RunStats> = {}): RunStats => ({
  groupBy,
  timeZone: 'America/Costa_Rica',
  scanned: 12,
  truncated: false,
  total: group(),
  groups:
    groupBy === 'day' || groupBy === 'week'
      ? [{ ...group({ runs: 5 }), key: '2026-11-26', label: '2026-11-26' }, { ...group({ runs: 7 }), key: '2026-11-27', label: '2026-11-27' }]
      : groupBy === 'user'
        ? [{ ...group({ runs: 9 }), key: 'u1', label: 'Ana' }]
        : [{ ...group({ runs: 9 }), key: TASK, label: 'Check fares' }, { ...group({ runs: 3, successRate: null }), key: 'none', label: 'No task' }],
  groupsTruncated: false,
  ...over,
});

const groupByOf = (r: TestApiRequest) => new URLSearchParams(r.path.split('?')[1]).get('groupBy') ?? 'none';

function renderPage(page: ReactElement, responses: Record<string, (r: TestApiRequest) => unknown>, permissions = ['runs:read']) {
  const host = createTestPlatformHost({ permissions, responses: responses as never });
  render(
    <PlatformHostProvider host={host}>
      <MemoryRouter>{page}</MemoryRouter>
    </PlatformHostProvider>,
  );
  return host;
}

describe('the analytics helpers', () => {
  it('formats durations and counts, picks the period and builds the runs links', () => {
    expect(formatDuration(45_000)).toBe('45s');
    expect(formatDuration(192_000)).toBe('3.2 min');
    expect(formatDuration(5_400_000)).toBe('1.5 h');
    expect(formatCount(34_500)).toBe('34.5k');
    expect(formatCount(950)).toBe('950');
    expect(periodOf('1y')).toBe('week');
    expect(shortDay('2026-10-29')).toBe('Oct 29');
    expect(shortDay('none')).toBe('none');
    expect(periodOf('30d')).toBe('day');
    const now = Date.parse('2026-11-27T12:00:00Z');
    expect(runsLink('task', TASK, '7d', now)).toBe(`/runs?from=2026-11-20&taskId=${TASK}`);
    expect(runsLink('stopReason', 'stalled', '7d', now)).toBe('/runs?from=2026-11-20&stopReason=stalled');
    expect(runsLink('tier', 'standard', '7d', now)).toBeNull();
    expect(runsLink('policy', 'none', '7d', now)).toBeNull();
  });

  it('shows a run’s tokens in the list, nothing without a model call', () => {
    expect(rowTokens({ inputTokens: 40_000, outputTokens: 2_000 })).toBe('42k');
    expect(rowTokens({ inputTokens: 900, outputTokens: 34 })).toBe('934');
    expect(rowTokens({})).toBeNull();
  });
});

describe('Run analytics (your runs)', () => {
  it('shows the tiles, the trend table and the breakdown with links to the runs', async () => {
    renderPage(<MyRunAnalyticsPage />, { 'GET /runs/stats': (r) => stats(groupByOf(r)) });
    expect(await screen.findByTestId('analytics-runs')).toHaveTextContent('12');
    expect(screen.getByTestId('analytics-success')).toHaveTextContent('80%');
    expect(screen.getByTestId('analytics-time')).toHaveTextContent('1.5 min / 5 min');
    expect(screen.getByTestId('analytics-tokens')).toHaveTextContent('42k / 126k');
    expect(screen.getByTestId('analytics-cost')).toHaveTextContent('$0.42');
    expect(screen.getByTestId('analytics-per-success')).toHaveTextContent('$0.05');
    expect(screen.getByRole('table', { name: 'Runs per day' })).toHaveTextContent('2026-11-27');
    expect(screen.getByTestId('analytics-legend')).toHaveTextContent('Succeeded: 8');
    const list = screen.getByRole('table', { name: 'Runs by task' });
    expect(within(list).getByRole('link', { name: 'Check fares' }).getAttribute('href')).toMatch(new RegExp(`^/runs\\?from=\\d{4}-\\d{2}-\\d{2}&taskId=${TASK}$`));
    expect(screen.getByText('Days are in America/Costa_Rica.', { exact: false })).toBeTruthy();
  });

  it('asks again for a new period and breakdown, and offers no user breakdown', async () => {
    const host = renderPage(<MyRunAnalyticsPage />, { 'GET /runs/stats': (r) => stats(groupByOf(r)) });
    await screen.findByTestId('analytics-runs');
    fireEvent.click(screen.getByRole('button', { name: '1 year' }));
    await waitFor(() => expect(host.requests.some((r) => r.path.includes('groupBy=week'))).toBe(true));
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Break down by' }));
    expect(screen.queryByRole('option', { name: 'User' })).toBeNull();
    fireEvent.click(await screen.findByRole('option', { name: 'Stop reason' }));
    await waitFor(() => expect(host.requests.some((r) => r.path.includes('groupBy=stopReason'))).toBe(true));
    expect(host.requests.every((r) => !r.path.startsWith('/admin/'))).toBe(true);
  });

  it('shows the loading state, then an empty state with no runs', async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((r) => (release = r));
    renderPage(<MyRunAnalyticsPage />, { 'GET /runs/stats': async (r) => (await gate, stats(groupByOf(r), { total: group({ runs: 0, finished: 0, live: 0 }), groups: [] })) });
    expect(screen.getByTestId('analytics-loading')).toBeTruthy();
    release();
    expect(await screen.findByText('No runs in this period')).toBeTruthy();
    expect(screen.getByRole('button', { name: 'Export dataset' })).toBeDisabled();
  });

  it('shows an error with a retry', async () => {
    let fail = true;
    renderPage(<MyRunAnalyticsPage />, {
      'GET /runs/stats': (r) => {
        if (fail) throw new Error('boom');
        return stats(groupByOf(r));
      },
    });
    expect(await screen.findByText(/Could not load the statistics/)).toBeTruthy();
    fail = false;
    fireEvent.click(screen.getByRole('button', { name: /retry/i }));
    expect(await screen.findByTestId('analytics-runs')).toHaveTextContent('12');
  });

  it('starts the run dataset and says where to download it', async () => {
    const host = renderPage(<MyRunAnalyticsPage />, { 'GET /runs/stats': (r) => stats(groupByOf(r)), 'POST /exports': () => ({ id: 'e1', status: 'pending' }) });
    await screen.findByTestId('analytics-runs');
    fireEvent.click(screen.getByRole('button', { name: 'Export dataset' }));
    expect(await screen.findByTestId('dataset-started')).toHaveTextContent('Export your data');
    const post = host.requests.find((r) => r.method === 'POST')!;
    expect(post.path).toBe('/exports');
    expect(post.body).toMatchObject({ source: 'run-dataset', format: 'json', request: { status: 'all', includeSteps: true } });
  });
});

describe('Runs analytics (everyone)', () => {
  it('reads the admin route, breaks down by user first, links nothing and offers no export', async () => {
    const host = renderPage(<AdminRunAnalyticsPage />, { 'GET /admin/runs/stats': (r) => stats(groupByOf(r)) }, ['run_stats:read_all']);
    const table = await screen.findByRole('table', { name: 'Runs by user' });
    expect(within(table).getByText('Ana')).toBeTruthy();
    expect(within(table).queryByRole('link')).toBeNull();
    expect(screen.queryByRole('button', { name: 'Export dataset' })).toBeNull();
    expect(host.requests.every((r) => r.path.startsWith('/admin/runs/stats'))).toBe(true);
  });
});
