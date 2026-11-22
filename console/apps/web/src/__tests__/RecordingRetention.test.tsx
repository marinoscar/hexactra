// Run recordings retention (E45.6, #761): the administrator's Run recordings page.
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost, type TestApiRequest } from '@marinoscar/platform-web/testing';

import { RecordingRetentionPage } from '../pages/RecordingRetentionPage';
import { ConfirmProvider } from '../ui';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

function renderPage(recordings: unknown, permissions = ['system_settings:read', 'system_settings:write']) {
  const host = createTestPlatformHost({
    permissions,
    responses: {
      'GET /system-settings': { version: 3, ...(recordings === undefined ? {} : { recordings }) },
      'PATCH /system-settings': (r: TestApiRequest) => ({ version: 4, ...(r.body as object) }),
    },
  });
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter>
          <RecordingRetentionPage />
        </MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  return host;
}
const patches = (host: { requests: TestApiRequest[] }) => host.requests.filter((r) => r.method === 'PATCH').map((r) => r.body);

describe('Run recordings settings', () => {
  it('starts at 30 days and 60 minutes when nothing is stored', async () => {
    renderPage(undefined);
    expect(await screen.findByRole('spinbutton', { name: 'Days a recording is kept' })).toHaveValue(30);
    expect(screen.getByRole('radio', { name: 'Delete after a number of days' })).toBeChecked();
    expect(screen.getByRole('spinbutton', { name: 'Longest recording in minutes' })).toHaveValue(60);
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('saves "Keep indefinitely" as null, with the version it read', async () => {
    const host = renderPage({ keepDays: 30, maxMinutes: 60 });
    fireEvent.click(await screen.findByRole('radio', { name: 'Keep indefinitely' }));
    expect(screen.queryByRole('spinbutton', { name: 'Days a recording is kept' })).not.toBeInTheDocument();
    expect(screen.getByText(/Recordings stay until their owner deletes them/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches(host)).toEqual([{ recordings: { keepDays: null, maxMinutes: 60 } }]));
    expect(host.requests.find((r) => r.method === 'PATCH')?.ifMatch).toBe('3');
    expect(await screen.findByText(/Saved/)).toBeInTheDocument();
  });

  it('reads a stored "keep indefinitely" and saves a number of days', async () => {
    const host = renderPage({ keepDays: null, maxMinutes: 30 });
    expect(await screen.findByRole('radio', { name: 'Keep indefinitely' })).toBeChecked();
    fireEvent.click(screen.getByRole('radio', { name: 'Delete after a number of days' }));
    fireEvent.change(screen.getByRole('spinbutton', { name: 'Days a recording is kept' }), { target: { value: '7' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(patches(host)).toEqual([{ recordings: { keepDays: 7, maxMinutes: 30 } }]));
  });

  it('refuses a value out of range', async () => {
    renderPage({ keepDays: 30, maxMinutes: 60 });
    fireEvent.change(await screen.findByRole('spinbutton', { name: 'Days a recording is kept' }), { target: { value: '0' } });
    expect(screen.getByText('From 1 to 3,650')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled();
  });

  it('is read-only without system_settings:write', async () => {
    renderPage({ keepDays: 30, maxMinutes: 60 }, ['system_settings:read']);
    expect(await screen.findByRole('spinbutton', { name: 'Days a recording is kept' })).toBeDisabled();
    expect(screen.getByRole('radio', { name: 'Keep indefinitely' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});
