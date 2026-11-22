// Export a benchmark report (E44.6, #744): the button and its menu (PDF, CSV, JSON), the URL each format calls, the file saved under the
// server's name, the busy state, an error, the in-progress note and the permission.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestApiError, createTestBlobResponse, createTestPlatformHost, type TestPlatformHost } from '@marinoscar/platform-web/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { BENCHMARK_EXPORT_NOTE, BenchmarkExportButton, benchmarkExportPath } from '../components/BenchmarkExportMenu';

const ID = '77777777-7777-4777-8777-777777777777';
const BASE = '66666666-6666-4666-8666-666666666666';

const file = (ext: string) => createTestBlobResponse('x', { 'Content-Type': 'application/octet-stream', 'Content-Disposition': `attachment; filename="hexactra-benchmark-77777777-20261122.${ext}"` });
const formatOf = (path: string) => /format=(\w+)/.exec(path)?.[1] ?? 'json';

function renderButton(opts: { permissions?: string[]; respond?: (req: { path: string }) => unknown; live?: boolean; baselineId?: string } = {}): TestPlatformHost {
  const host = createTestPlatformHost({
    permissions: opts.permissions ?? ['benchmarks:read'],
    responses: { [`GET /benchmarks/${ID}/export`]: opts.respond ?? ((req: { path: string }) => file(formatOf(req.path))) },
  });
  render(
    <PlatformHostProvider host={host}>
      <BenchmarkExportButton benchmarkId={ID} live={opts.live} baselineId={opts.baselineId} />
    </PlatformHostProvider>,
  );
  return host;
}
const exports = (host: TestPlatformHost) => host.requests.filter((r) => r.path.startsWith(`/benchmarks/${ID}/export`)).map((r) => r.path);

let clicks: string[] = [];
beforeEach(() => {
  clicks = [];
  URL.createObjectURL = vi.fn(() => 'blob:test');
  URL.revokeObjectURL = vi.fn();
  vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(function (this: HTMLAnchorElement) {
    clicks.push(this.download);
  });
});
afterEach(() => vi.restoreAllMocks());

describe('benchmarkExportPath', () => {
  it('builds the query of each format', () => {
    expect(benchmarkExportPath(ID, { format: 'csv' })).toBe(`/benchmarks/${ID}/export?format=csv`);
    expect(benchmarkExportPath(ID, { format: 'json', baseline: BASE })).toBe(`/benchmarks/${ID}/export?format=json&baseline=${BASE}`);
    expect(benchmarkExportPath(ID, { format: 'pdf', paper: 'letter' })).toBe(`/benchmarks/${ID}/export?format=pdf&paper=letter`);
  });
});

describe('BenchmarkExportButton', () => {
  it('downloads the PDF, the CSV and the JSON under the server names', async () => {
    const host = renderButton();
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    const menu = await screen.findByRole('menu');
    expect(menu).toHaveTextContent(BENCHMARK_EXPORT_NOTE);
    expect(within(menu).getAllByRole('menuitem').map((m) => m.textContent)).toEqual(['PDF report', 'CSV of trials', 'JSON report']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'PDF report' }));
    await waitFor(() => expect(clicks).toEqual(['hexactra-benchmark-77777777-20261122.pdf']));
    expect(exports(host)[0]).toMatch(new RegExp(`^/benchmarks/${ID}/export\\?format=pdf&paper=(a4|letter)$`));

    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'CSV of trials' }));
    await waitFor(() => expect(clicks.at(-1)).toBe('hexactra-benchmark-77777777-20261122.csv'));
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'JSON report' }));
    await waitFor(() => expect(clicks.at(-1)).toBe('hexactra-benchmark-77777777-20261122.json'));
    expect(exports(host).slice(1)).toEqual([`/benchmarks/${ID}/export?format=csv`, `/benchmarks/${ID}/export?format=json`]);
  });

  it('passes the baseline, and says the benchmark is still running', async () => {
    const host = renderButton({ baselineId: BASE, live: true });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    const menu = await screen.findByRole('menu');
    expect(menu).toHaveTextContent('The report includes the comparison with the baseline.');
    expect(menu).toHaveTextContent('The benchmark is still running: the files are marked in progress.');
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'CSV of trials' }));
    await waitFor(() => expect(exports(host)).toEqual([`/benchmarks/${ID}/export?format=csv&baseline=${BASE}`]));
  });

  it('is disabled while the file is prepared, and cannot be pressed twice', async () => {
    let finish: (v: unknown) => void = () => undefined;
    const host = renderButton({ respond: () => new Promise((r) => (finish = r)) });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'JSON report' }));
    const busy = await screen.findByRole('button', { name: 'Preparing…' });
    expect(busy).toBeDisabled();
    fireEvent.click(busy);
    expect(exports(host)).toHaveLength(1);
    await act(async () => finish(file('json')));
    expect(await screen.findByRole('button', { name: 'Export' })).toBeEnabled();
  });

  it('shows the server message when the export is refused', async () => {
    renderButton({ respond: () => Promise.reject(createTestApiError(429, 'At most 10 benchmark exports a minute. Wait 30 seconds and try again.', 'EXPORT_RATE_LIMITED')) });
    fireEvent.click(screen.getByRole('button', { name: 'Export' }));
    fireEvent.click(await screen.findByRole('menuitem', { name: 'PDF report' }));
    const line = await screen.findByText('At most 10 benchmark exports a minute. Wait 30 seconds and try again.');
    expect(line.closest('[role="alert"]')).not.toBeNull();
  });

  it('is hidden without benchmarks:read', () => {
    renderButton({ permissions: ['runs:read'] });
    expect(screen.queryByRole('button', { name: 'Export' })).toBeNull();
  });
});
