// The Usage & Cost page (#734): tiles, the stacked chart's numbers, the
// unpriced warning, the by-model table, the period and stacking controls, the
// admin variant and the CSV export.
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestBlobResponse, createTestPlatformHost, type TestApiRequest } from '@marinoscar/platform-web/testing';
import type { ReactElement } from 'react';

import { AdminUsagePage, MyUsagePage } from '../pages/UsagePage';
import { bucketLabel, formatTokens, topSeries, type UsageReport, type UsageSeries } from '../usage/api';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

function report(over: Partial<UsageReport> = {}): UsageReport {
  return {
    range: '30d',
    scope: 'me',
    breakdown: 'model',
    timeZone: 'America/Chicago',
    granularity: 'day',
    from: '2026-10-23',
    to: '2026-11-21',
    buckets: ['2026-11-20', '2026-11-21'],
    series: [
      { key: 'openai:gpt-6.1-sol', label: 'gpt-6.1-sol', costUsd: [1, 2.5], tokens: [100_000, 250_000], requests: [3, 5] },
      { key: 'openai:gpt-6-luna', label: 'gpt-6-luna', costUsd: [0.1, 0.2], tokens: [1_000_000, 2_000_000], requests: [10, 20] },
    ],
    totals: {
      requests: 38,
      failed: 2,
      inputTokens: 3_000_000,
      cachedInputTokens: 1_200_000,
      outputTokens: 350_000,
      reasoningTokens: 50_000,
      tokens: 3_350_000,
      costUsd: 3.8,
      costKnown: false,
      costByTokenType: { input: 2, cachedInput: 0.1, output: 1.5, reasoning: 0.2 },
    },
    byModel: [
      { key: 'openai:gpt-6.1-sol', provider: 'openai', model: 'gpt-6.1-sol', requests: 8, failed: 1, inputTokens: 300_000, cachedInputTokens: 0, outputTokens: 50_000, reasoningTokens: 0, tokens: 350_000, costUsd: 3.5, costShare: 0.92 },
      { key: 'openai:mystery', provider: 'openai', model: 'mystery', requests: 1, failed: 0, inputTokens: 10, cachedInputTokens: 0, outputTokens: 1, reasoningTokens: 0, tokens: 11, costUsd: null, costShare: null },
    ],
    unpricedModels: ['openai:mystery'],
    runs: { count: 4, succeeded: 3, costUsd: 3, avgSuccessCostUsd: 0.75 },
    pricing: { overridesApplied: false },
    ...over,
  };
}

function renderPage(page: ReactElement, permissions: string[], handler: (r: TestApiRequest) => unknown) {
  const host = createTestPlatformHost({ permissions, responses: { 'GET /usage/report': handler as never } });
  render(
    <PlatformHostProvider host={host}>
      <MemoryRouter>{page}</MemoryRouter>
    </PlatformHostProvider>,
  );
  return host;
}

describe('the usage helpers', () => {
  it('formats tokens compactly and labels days and months', () => {
    expect(formatTokens(1234)).toBe('1,234');
    expect(formatTokens(34_500, true)).toBe('34.5k');
    expect(formatTokens(3_350_000, true)).toBe('3.4M');
    expect(bucketLabel('2026-11-21', 'day')).toBe('Nov 21');
    expect(bucketLabel('2026-03', 'month')).toBe('Mar 2026');
  });

  it('keeps the biggest series and sums the rest as Other', () => {
    const s = (key: string, v: number): UsageSeries => ({ key, label: key, costUsd: [v, v], tokens: [v, v], requests: [1, 1] });
    const top = topSeries([s('a', 1), s('b', 9), s('c', 5), s('d', 2)], 'costUsd', 3);
    expect(top.map((x) => x.key)).toEqual(['b', 'c', '__other']);
    expect(top[2]!.costUsd).toEqual([3, 3]);
  });
});

describe('My usage & cost', () => {
  it('shows the cost as a lower bound, the token split, the unpriced model and the table per model', async () => {
    renderPage(<MyUsagePage />, ['usage:read'], () => report());
    expect(await screen.findByTestId('usage-cost')).toHaveTextContent('≥ $3.80');
    expect(screen.getByTestId('usage-tokens')).toHaveTextContent('3.4M');
    expect(screen.getByTestId('usage-requests')).toHaveTextContent('2 failed');
    expect(screen.getByTestId('usage-cache')).toHaveTextContent('40%');
    expect(screen.getByTestId('usage-runs')).toHaveTextContent('$0.75');
    expect(screen.getByTestId('usage-unpriced')).toHaveTextContent('openai:mystery');
    // A user without the price settings is told to ask, not given a link.
    expect(within(screen.getByTestId('usage-unpriced')).queryByRole('link')).toBeNull();
    expect(screen.getByTestId('usage-token-types')).toHaveTextContent('Cached input');
    expect(screen.getByRole('table', { name: 'Cost per period' })).toHaveTextContent('Nov 21');
    expect(screen.getAllByText('No price').length).toBeGreaterThan(0);
    expect(screen.getByTestId('usage-series-totals')).toHaveTextContent('gpt-6.1-sol: $3.50');
  });

  it('asks again for a new period and stacking, with the caller’s own scope', async () => {
    const host = renderPage(<MyUsagePage />, ['usage:read'], (r) => report({ range: r.path.includes('range=1y') ? '1y' : '30d', granularity: r.path.includes('range=1y') ? 'month' : 'day' }));
    await screen.findByTestId('usage-cost');
    fireEvent.click(screen.getByRole('button', { name: '1 year' }));
    await waitFor(() => expect(host.requests.some((r) => r.path.includes('range=1y'))).toBe(true));
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Stack by' }));
    expect(screen.queryByRole('option', { name: 'User' })).toBeNull();
    fireEvent.click(await screen.findByRole('option', { name: 'Token type' }));
    await waitFor(() => expect(host.requests.some((r) => r.path.includes('breakdown=tokenType'))).toBe(true));
    expect(host.requests.every((r) => !r.path.startsWith('/usage/') || r.path.includes('scope=me'))).toBe(true);
  });

  it('says so when there is no usage', async () => {
    renderPage(<MyUsagePage />, ['usage:read'], () => report({ totals: { ...report().totals, requests: 0, tokens: 0, costUsd: 0, costKnown: true }, series: [], byModel: [], unpricedModels: [] }));
    expect(await screen.findByText('No AI usage in this period')).toBeInTheDocument();
  });

  it('exports the CSV through the signed-in client', async () => {
    const host = createTestPlatformHost({
      permissions: ['usage:read'],
      responses: {
        'GET /usage/report': report() as never,
        'GET /usage/export.csv?range=30d&scope=me&breakdown=none': createTestBlobResponse('period,provider\r\n', { 'content-disposition': 'attachment; filename="ai-usage-me.csv"' }),
      },
    });
    const created = vi.fn(() => 'blob:x');
    const revoked = vi.fn();
    Object.assign(URL, { createObjectURL: created, revokeObjectURL: revoked });
    render(
      <PlatformHostProvider host={host}>
        <MemoryRouter>
          <MyUsagePage />
        </MemoryRouter>
      </PlatformHostProvider>,
    );
    await screen.findByTestId('usage-cost');
    fireEvent.click(screen.getAllByRole('button', { name: /Export CSV/ })[0]!);
    await waitFor(() => expect(created).toHaveBeenCalled());
  });
});

describe('AI usage & cost (administrator)', () => {
  it('asks for everyone, offers User stacking and links to the model prices', async () => {
    const host = renderPage(<AdminUsagePage />, ['ai_config:read', 'system_settings:read'], () => report({ scope: 'all' }));
    await screen.findByTestId('usage-cost');
    expect(host.requests.find((r) => r.path.startsWith('/usage/report'))!.path).toContain('scope=all');
    expect(within(screen.getByTestId('usage-unpriced')).getByRole('link', { name: 'Set model prices' })).toHaveAttribute('href', '/admin/settings/agent-pricing');
    fireEvent.mouseDown(screen.getByRole('combobox', { name: 'Stack by' }));
    expect(await screen.findByRole('option', { name: 'User' })).toBeInTheDocument();
  });
});
