// Run recordings (epic #755): the Recording card on the run page, and the Record video switch in New run.
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost, type TestApiRequest } from '@marinoscar/platform-web/testing';
import type { ReactElement } from 'react';

import { RunRecording, type RunRecordingView } from '../components/RunRecording';
import { ConfirmProvider } from '../ui';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

const READY: RunRecordingView = {
  status: 'ready', bytes: 4_200_000, durationMs: 95_000, mime: 'video/webm', droppedFrames: 3, note: null,
  startedAt: '2026-11-20T10:00:00.000Z', endedAt: '2026-11-20T10:01:35.000Z', expiresAt: '2026-12-20T10:00:00.000Z', masked: false,
};

function renderIt(el: ReactElement, responses: Record<string, unknown>, permissions = ['runs:read', 'runs:delete']) {
  const host = createTestPlatformHost({ permissions, responses });
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter>{el}</MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  return host;
}

describe('the Recording card', () => {
  it('plays a ready video by its signed link, says it is not masked, and when it is deleted', async () => {
    const host = renderIt(<RunRecording runId="r1" canDelete />, {
      'GET /runs/r1/recording': READY,
      'POST /runs/r1/recording/link': { url: '/api/recordings/tok', expiresAt: '2026-11-20T10:15:00.000Z' },
    });
    const card = await screen.findByTestId('run-recording');
    expect(within(card).getByText('This video is not masked. Anything that was on the page is visible in it. Only you can watch it.')).toBeInTheDocument();
    const video = await within(card).findByLabelText('Video of the run');
    expect(video).toHaveAttribute('src', '/api/recordings/tok');
    expect(within(card).getByText(/1 min 35 s · 4\.2 MB · Deleted on/)).toBeInTheDocument();
    expect(host.requests.some((r: TestApiRequest) => r.method === 'POST' && r.path === '/runs/r1/recording/link')).toBe(true);
  });

  it('says a video is kept when the policy keeps recordings indefinitely', async () => {
    renderIt(<RunRecording runId="r1" />, { 'GET /runs/r1/recording': { ...READY, expiresAt: null }, 'POST /runs/r1/recording/link': { url: '/api/recordings/tok' } });
    expect(await screen.findByText(/Kept until you delete it/)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Delete video' })).not.toBeInTheDocument();
  });

  it('explains a recording that is still being made, and a short one', async () => {
    renderIt(<RunRecording runId="r1" />, { 'GET /runs/r1/recording': { ...READY, status: 'processing', expiresAt: null, note: 'max_minutes' } });
    expect(await screen.findByText('The run ended. The video will be ready in about a minute.')).toBeInTheDocument();
    expect(screen.getByText(/longest length your administrator allows/)).toBeInTheDocument();
    expect(screen.queryByLabelText('Video of the run')).not.toBeInTheDocument();
  });

  it('shows nothing for a run without a recording', async () => {
    const host = renderIt(<RunRecording runId="r2" />, {});
    await waitFor(() => expect(host.requests.some((r: TestApiRequest) => r.path === '/runs/r2/recording')).toBe(true));
    expect(screen.queryByTestId('run-recording')).not.toBeInTheDocument();
  });

  it('deletes the video after a confirmation', async () => {
    const host = renderIt(<RunRecording runId="r1" canDelete />, {
      'GET /runs/r1/recording': READY,
      'POST /runs/r1/recording/link': { url: '/api/recordings/tok' },
      'DELETE /runs/r1/recording': undefined,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Delete video' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Delete video' , hidden: false }));
    await waitFor(() => expect(host.requests.some((r: TestApiRequest) => r.method === 'DELETE' && r.path === '/runs/r1/recording')).toBe(true));
    await waitFor(() => expect(screen.queryByTestId('run-recording')).not.toBeInTheDocument());
  });
});
