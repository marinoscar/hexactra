// The admin "Request history" page (E40.4, #688): reads the `questions`
// system settings (defaults 7 days, 60 minutes), validates and saves with
// If-Match, and is read-only without system_settings:write.
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';

import { RequestHistorySettingsPage, wholeNumberError } from '../pages/RequestHistorySettingsPage';

const wrap = (host: ReturnType<typeof createTestPlatformHost>) =>
  render(
    <PlatformHostProvider host={host}>
      <MemoryRouter>
        <RequestHistorySettingsPage />
      </MemoryRouter>
    </PlatformHostProvider>,
  );

describe('the Request history admin page (E40.4)', () => {
  it('shows the defaults and saves both values with If-Match', async () => {
    const host = createTestPlatformHost({ permissions: ['system_settings:read', 'system_settings:write'], responses: { 'GET /system-settings': { version: 4 }, 'PATCH /system-settings': { version: 5, questions: { historyKeepDays: 14, defaultWaitMinutes: 240 } } } });
    wrap(host);
    const days = await screen.findByLabelText('Days request history is kept');
    expect(days).toHaveValue(7);
    expect(screen.getByLabelText('Minutes a question waits for an answer')).toHaveValue(60);
    fireEvent.change(days, { target: { value: '14' } });
    fireEvent.change(screen.getByLabelText('Minutes a question waits for an answer'), { target: { value: '240' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await waitFor(() => expect(host.requests.some((r) => r.method === 'PATCH')).toBe(true));
    const patch = host.requests.find((r) => r.method === 'PATCH')!;
    expect(patch.body).toEqual({ questions: { historyKeepDays: 14, defaultWaitMinutes: 240 } });
    expect(await screen.findByText(/Saved/)).toBeInTheDocument();
  });

  it('is read-only without write, and checks the numbers', async () => {
    const host = createTestPlatformHost({ permissions: ['system_settings:read'], responses: { 'GET /system-settings': { version: 1, questions: { historyKeepDays: 30, defaultWaitMinutes: 60 } } } });
    wrap(host);
    expect(await screen.findByLabelText('Days request history is kept')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
    expect(wholeNumberError('0', 3650)).toBe('From 1 to 3,650');
    expect(wholeNumberError('2.5', 10)).toBe('A whole number');
    expect(wholeNumberError('5', 10)).toBeNull();
  });
});
