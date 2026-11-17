// Run retention (#422): the user's Run history settings page and the
// administrator's Run history limit page.
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost, type TestApiRequest } from '@marinoscar/platform-web/testing';
import type { ReactElement } from 'react';

import { RunHistorySettingsPage, previewLine } from '../pages/RunHistorySettingsPage';
import { RunRetentionCeilingPage } from '../pages/RunRetentionCeilingPage';
import type { RetentionPreview, RetentionSettings } from '../types/retention';
import { ConfirmProvider } from '../ui';
import { mockViewport } from './matchMedia';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

const SETTINGS: RetentionSettings = { keepDays: 90, keepPerTask: null, keepFailedDays: null, saved: true, maxKeepDays: null, floorHours: 24 };
const PREVIEW: RetentionPreview = { wouldDelete: 1240, finished: 5012, oldestKept: '2026-08-18T10:00:00.000Z', costUsd: 12.4, maxKeepDays: null, capped: false, floorHours: 24 };

function renderPage(page: ReactElement, responses: Record<string, unknown>, permissions = ['runs:delete', 'user_settings:write']) {
  const host = createTestPlatformHost({ permissions, responses });
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter>{page}</MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  return host;
}
const user = (settings: Partial<RetentionSettings> = {}, preview: Partial<RetentionPreview> = {}, more: Record<string, unknown> = {}) =>
  renderPage(<RunHistorySettingsPage />, {
    'GET /runs/retention': { ...SETTINGS, ...settings },
    'GET /runs/retention/preview': { ...PREVIEW, ...preview },
    'PATCH /user-settings': (r: TestApiRequest) => ({ version: 2, ...(r.body as object) }),
    'POST /runs/retention/apply': { jobId: '11111111-1111-4111-8111-111111111111' },
    ...more,
  });
const previews = (host: { requests: TestApiRequest[] }) => host.requests.filter((r) => r.path.startsWith('/runs/retention/preview')).map((r) => r.path);
const days = () => screen.findByRole('spinbutton', { name: 'Keep runs for (days)' });

describe('Run history settings', () => {
  it('shows the saved rule and the live line from the preview route', async () => {
    const host = user();
    expect(await days()).toHaveValue(90);
    expect(screen.getByRole('switch', { name: 'Keep runs forever' })).not.toBeChecked();
    expect(screen.getByRole('switch', { name: 'No limit on runs per task' })).toBeChecked();
    expect(screen.getByRole('spinbutton', { name: 'Keep only the latest N runs of each task' })).toBeDisabled();
    const line = await screen.findByText(/With these settings, 1,240 of your 5,012 finished runs would be deleted tonight/);
    expect(line).toHaveTextContent('recorded spend $12.40');
    expect(line).toHaveTextContent(/The oldest kept run would be from .*Aug.*2026/);
    expect(previews(host)).toEqual(['/runs/retention/preview?keepDays=90&keepPerTask=&keepFailedDays=']);
    expect(screen.getByText(/Never removed: live runs, runs waiting for your answer, and runs that finished in the last 24 hours/)).toBeInTheDocument();
    // Nothing changed yet.
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.queryByText(/You have not chosen a rule yet/)).not.toBeInTheDocument();
  });

  it('"Forever" disables the field and saves null', async () => {
    const host = user();
    await days();
    fireEvent.click(screen.getByRole('switch', { name: 'Keep runs forever' }));
    expect(await days()).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Saved\. The nightly cleanup uses these settings/);
    const patch = host.requests.find((r) => r.method === 'PATCH')!;
    expect(patch.path).toBe('/user-settings');
    expect(patch.body).toEqual({ runs: { keepDays: null, keepPerTask: null, keepFailedDays: null } });
    await waitFor(() => expect(previews(host).at(-1)).toBe('/runs/retention/preview?keepDays=&keepPerTask=&keepFailedDays='));
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('saves a per-task limit and a longer limit for failed runs (under More)', async () => {
    const host = user();
    await days();
    fireEvent.click(screen.getByRole('switch', { name: 'No limit on runs per task' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Keep only the latest N runs of each task' }), { target: { value: '50' } });
    expect(screen.queryByRole('spinbutton', { name: 'Keep failed runs for (days)' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'More' }));
    fireEvent.change(await screen.findByRole('spinbutton', { name: 'Keep failed runs for (days)' }), { target: { value: '180' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Saved\./);
    expect(host.requests.find((r) => r.method === 'PATCH')!.body).toEqual({ runs: { keepDays: 90, keepPerTask: 50, keepFailedDays: 180 } });
    await waitFor(() => expect(previews(host).at(-1)).toBe('/runs/retention/preview?keepDays=90&keepPerTask=50&keepFailedDays=180'));
  });

  it('blocks Save and the preview while a field is invalid', async () => {
    const host = user();
    fireEvent.change(await days(), { target: { value: '0' } });
    expect(screen.getByText('From 1 to 3,650')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    expect(screen.getByRole('button', { name: 'Apply now' })).toBeDisabled();
    expect(screen.getByText('Correct the fields above to see what would be deleted.')).toBeInTheDocument();
    await new Promise((r) => setTimeout(r, 500));
    expect(previews(host).every((p) => !p.includes('keepDays=0'))).toBe(true);
  });

  it('warns that task spend covers 30 days when fewer are kept', async () => {
    user();
    const helper = /Task spend covers 30 days; with fewer days kept it will only reflect the runs that remain\./;
    expect(screen.queryByText(helper)).not.toBeInTheDocument();
    fireEvent.change(await days(), { target: { value: '14' } });
    expect(screen.getByText(helper)).toBeInTheDocument();
    fireEvent.change(await days(), { target: { value: '30' } });
    expect(screen.queryByText(helper)).not.toBeInTheDocument();
  });

  it("names the administrator's ceiling when it cuts the rule", async () => {
    user({ keepDays: null, maxKeepDays: 180 }, { maxKeepDays: 180, capped: true });
    expect(await screen.findByText('Capped at 180 days by your administrator.')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Keep runs forever' }));
    fireEvent.change(await days(), { target: { value: '60' } });
    expect(screen.queryByText('Capped at 180 days by your administrator.')).not.toBeInTheDocument();
    fireEvent.change(await days(), { target: { value: '365' } });
    expect(screen.getByText('Capped at 180 days by your administrator.')).toBeInTheDocument();
  });

  it('"Apply now" asks for confirmation naming the count, then posts', async () => {
    const host = user();
    await screen.findByText(/1,240 of your 5,012/);
    fireEvent.click(screen.getByRole('button', { name: 'Apply now' }));
    const dialog = await screen.findByRole('dialog');
    expect(within(dialog).getByText('Delete 1,240 runs now?')).toBeInTheDocument();
    // Cancel: nothing is posted.
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(host.requests.some((r) => r.method === 'POST')).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: 'Apply now' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Delete runs' }));
    await screen.findByText(/Cleanup started/);
    expect(host.requests.filter((r) => r.method === 'POST').map((r) => r.path)).toEqual(['/runs/retention/apply']);
  });

  it('"Apply now" waits for unsaved changes to be saved, and for something to delete', async () => {
    user({}, { wouldDelete: 0, oldestKept: '2026-08-18T10:00:00.000Z', costUsd: null });
    await screen.findByText('With these settings, none of your 5,012 finished runs would be deleted tonight.');
    expect(screen.getByRole('button', { name: 'Apply now' })).toBeDisabled();
    fireEvent.change(await days(), { target: { value: '45' } });
    expect(screen.getByText('Save your changes to apply them now.')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Apply now' })).toBeDisabled();
  });

  it('tells a user on the default rule that nothing is removed before a notice', async () => {
    user({ saved: false });
    expect(await screen.findByText(/You have not chosen a rule yet, so the default applies: runs are kept for 90 days/)).toBeInTheDocument();
  });

  it('is read-only without user_settings:write', async () => {
    renderPage(<RunHistorySettingsPage />, { 'GET /runs/retention': SETTINGS, 'GET /runs/retention/preview': PREVIEW }, ['runs:delete']);
    expect(await days()).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('keeps each switch beside its field on a phone', async () => {
    const restore = mockViewport(360);
    try {
      user();
      const field = await days();
      const row = field.closest('.MuiStack-root')!;
      expect(within(row as HTMLElement).getByRole('switch', { name: 'Keep runs forever' })).toBeInTheDocument();
      expect(getComputedStyle(row).flexDirection).toBe('row');
    } finally {
      restore();
    }
  });
});

describe('previewLine', () => {
  it('reads well with one run, no cost and nothing kept', () => {
    expect(previewLine({ ...PREVIEW, wouldDelete: 1, finished: 1, oldestKept: null, costUsd: null })).toBe('With these settings, 1 of your 1 finished run would be deleted tonight. No finished run would be kept.');
    expect(previewLine({ ...PREVIEW, wouldDelete: 0, finished: 0, oldestKept: null, costUsd: null })).toBe('You have no finished runs yet, so nothing would be deleted.');
  });
});

describe('Run history limit (admin)', () => {
  const doc = (maxKeepDays: number | null) => ({ version: 4, runs: { maxKeepDays } });

  it('shows no limit by default and saves a ceiling with If-Match', async () => {
    const host = renderPage(<RunRetentionCeilingPage />, { 'GET /system-settings': doc(null), 'PATCH /system-settings': { version: 5, runs: { maxKeepDays: 180 } } }, ['system_settings:read', 'system_settings:write']);
    const toggle = await screen.findByRole('switch', { name: 'No limit on how long runs are kept' });
    expect(toggle).toBeChecked();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
    fireEvent.click(toggle);
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Most days runs are kept' }), { target: { value: '180' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText(/Saved\. The next nightly cleanup uses this limit/);
    const patch = host.requests.find((r) => r.method === 'PATCH')!;
    expect(patch).toMatchObject({ path: '/system-settings', ifMatch: '4', body: { runs: { maxKeepDays: 180 } } });
  });

  it('is read-only without system_settings:write', async () => {
    renderPage(<RunRetentionCeilingPage />, { 'GET /system-settings': doc(365) }, ['system_settings:read']);
    expect(await screen.findByRole('spinbutton', { name: 'Most days runs are kept' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});
