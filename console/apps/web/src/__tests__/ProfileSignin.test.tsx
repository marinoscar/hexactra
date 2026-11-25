// The desktop page's sign-in mode (E48.4, #930): the banner names the profile and says what to do, the page adopts the lease
// the API took, follows the sign-in to "Signed in as <email>", then offers the next steps. Cancel ends it. Plus the API
// client the Fleet page's Sign in button calls. noVNC is replaced by a fake.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestApiError, createTestPlatformHost } from '@marinoscar/platform-web/testing';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';

const rfb = vi.hoisted(() => ({ instances: [] as Array<EventTarget & { viewOnly: boolean }> }));
vi.mock('@novnc/novnc/core/rfb.js', () => ({
  default: class extends EventTarget {
    viewOnly = true;
    scaleViewport = false;
    focusOnClick = false;
    disconnect = vi.fn(() => this.dispatchEvent(new Event('disconnect')));
    sendCtrlAltDel = vi.fn();
    clipboardPasteFrom = vi.fn();
    focus = vi.fn();
    constructor() {
      super();
      rfb.instances.push(this as never);
    }
  },
}));

import { ProfileSigninBanner } from '../fleet/ProfileSigninBanner';
import { profileInUseRun, signinDesktopPath, startProfileSignin, type ProfileSignin } from '../fleet/signin';
import { DesktopPage } from '../pages/DesktopPage';
import type { FleetHost } from '../types/fleet';

const ID = '22222222-2222-4222-8222-222222222222';
const SID = '33333333-3333-4333-8333-333333333333';
const LEASE = '44444444-4444-4444-8444-444444444444';
const host: FleetHost = {
  id: ID,
  name: 'mini-pc',
  version: '0.4.0',
  online: true,
  browserConnected: true,
  onDemand: true,
  draining: false,
  viewerUrl: null,
  mode: 'unattended',
  desktop: true,
  profiles: [{ name: 'work', running: true, signin: 'signed_out', accounts: [], checkedAt: null }],
  lastSeen: '2026-11-25T00:00:00Z',
};
const session = (over: Partial<ProfileSignin> = {}): ProfileSignin => ({
  id: SID,
  hostId: ID,
  profile: 'work',
  status: 'started',
  phase: 'waiting',
  leaseId: LEASE,
  keepLease: false,
  signin: 'signed_out',
  email: null,
  resultState: null,
  endReason: null,
  startedAt: '2026-11-25T10:00:00Z',
  expiresAt: '2026-11-25T10:15:00Z',
  endedAt: null,
  ...over,
});

function renderSigninPage(polls: ProfileSignin[]) {
  let i = 0;
  const platform = createTestPlatformHost({
    permissions: ['fleet:read', 'fleet:desktop'],
    responses: {
      [`GET /fleet/hosts/${ID}`]: host,
      [`POST /fleet/hosts/${ID}/viewer-session`]: { hostId: ID, wsPath: `/viewer/${ID}/websockify`, expiresAt: '2026-11-25T11:00:00Z' },
      [`DELETE /fleet/hosts/${ID}/viewer-session`]: undefined,
      [`GET /fleet/hosts/${ID}/takeover`]: { leaseId: LEASE, userId: 'test-user', displayName: 'Owner', expiresAt: '2026-11-25T10:05:00Z' },
      [`DELETE /fleet/hosts/${ID}/takeover/${LEASE}`]: undefined,
      [`GET /fleet/signin-sessions/${SID}`]: () => polls[Math.min(i++, polls.length - 1)],
      [`POST /fleet/signin-sessions/${SID}/cancel`]: session({ status: 'abandoned', phase: null, leaseId: null, endReason: 'cancelled' }),
    },
  });
  render(
    <PlatformHostProvider host={platform}>
      <MemoryRouter initialEntries={[`/fleet/hosts/${ID}/desktop?signin=${SID}`]}>
        <Routes>
          <Route path="/fleet/hosts/:id/desktop" element={<DesktopPage />} />
          <Route path="/fleet" element={<p>Fleet list</p>} />
        </Routes>
      </MemoryRouter>
    </PlatformHostProvider>,
  );
  return platform;
}

describe('desktop page in sign-in mode', () => {
  beforeEach(() => {
    rfb.instances.length = 0;
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('shows the banner naming the profile, uses the lease the API took, and hides Take over and Release', async () => {
    renderSigninPage([session()]);
    expect(await screen.findByText('Sign in to Google in the "work" profile')).toBeInTheDocument();
    expect(screen.getByText(/at Google's sign-in, and you control the desktop/)).toBeInTheDocument();
    await waitFor(() => expect(rfb.instances).toHaveLength(1));
    act(() => {
      rfb.instances[0]!.dispatchEvent(new Event('connect'));
    });
    await waitFor(() => expect(rfb.instances[0]!.viewOnly).toBe(false));
    expect(screen.queryByRole('button', { name: 'Release' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Take over' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Cancel' })).toBeInTheDocument();
  });

  it('follows the sign-in to "Signed in as <email>" and offers Back to Fleet', async () => {
    const platform = renderSigninPage([
      session(),
      session({ phase: 'saving', signin: 'signed_in', email: 'owner@example.com' }),
      session({ status: 'completed', phase: null, leaseId: null, signin: 'signed_in', email: 'owner@example.com', resultState: 'signed_in', endedAt: '2026-11-25T10:03:00Z' }),
    ]);
    expect(await screen.findByText('Sign in to Google in the "work" profile')).toBeInTheDocument();
    expect(await screen.findByText('Saving the profile', { exact: false }, { timeout: 4000 })).toBeInTheDocument();
    expect(await screen.findByText(/profile is saved and the desktop is released/, {}, { timeout: 4000 })).toBeInTheDocument();
    expect(screen.getByText('Signed in as owner@example.com')).toBeInTheDocument();
    // "Next profile" waits for the Fix sign-ins queue (E48.6).
    expect(screen.queryByRole('button', { name: 'Next profile' })).toBeNull();
    const polls = platform.requests.filter((r) => r.path === `/fleet/signin-sessions/${SID}`).length;
    fireEvent.click(screen.getByRole('button', { name: 'Back to Fleet' }));
    expect(await screen.findByText('Fleet list')).toBeInTheDocument();
    // The page stopped polling once the sign-in ended, and did not cancel a finished sign-in.
    expect(platform.requests.filter((r) => r.path === `/fleet/signin-sessions/${SID}`).length).toBe(polls);
    await new Promise((r) => setTimeout(r, 400));
    expect(platform.requests.some((r) => r.path.endsWith('/cancel'))).toBe(false);
  }, 15_000);

  it('Cancel ends the sign-in and says the browser was left open', async () => {
    const platform = renderSigninPage([session()]);
    fireEvent.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(await screen.findByText('Sign-in ended')).toBeInTheDocument();
    expect(screen.getByText(/You cancelled it\. The desktop is released; Chrome was left open/)).toBeInTheDocument();
    expect(platform.requests.some((r) => r.method === 'POST' && r.path === `/fleet/signin-sessions/${SID}/cancel`)).toBe(true);
    expect(screen.getByRole('button', { name: 'Back to Fleet' })).toBeInTheDocument();
  });
});

describe('ProfileSigninBanner', () => {
  it('offers Next profile when a queue gives one, and both next steps work', () => {
    const back = vi.fn();
    const next = vi.fn();
    render(<ProfileSigninBanner session={session({ status: 'completed', phase: null, email: 'a@example.com', signin: 'signed_in', resultState: 'signed_in' })} hostName="mini-pc" onCancel={vi.fn()} onBack={back} onNext={next} />);
    expect(screen.getByText('Signed in as a@example.com')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next profile' }));
    fireEvent.click(screen.getByRole('button', { name: 'Back to Fleet' }));
    expect(next).toHaveBeenCalledOnce();
    expect(back).toHaveBeenCalledOnce();
  });

  it('says so when Chrome closed but the profile does not read signed in', () => {
    render(<ProfileSigninBanner session={session({ status: 'completed', phase: null, resultState: 'signed_out' })} hostName={null} onCancel={vi.fn()} onBack={vi.fn()} />);
    expect(screen.getByText('The sign-in was not saved')).toBeInTheDocument();
    expect(screen.getByText(/reads signed out/)).toBeInTheDocument();
  });
});

describe('profile sign-in API client', () => {
  it('starts a sign-in, links the desktop page in sign-in mode, and reads the run of a PROFILE_IN_USE refusal', async () => {
    const platform = createTestPlatformHost({
      responses: {
        [`POST /fleet/hosts/${ID}/profiles/work/signin`]: session(),
        [`POST /fleet/hosts/${ID}/profiles/busy/signin`]: () => {
          throw createTestApiError(409, 'A run is using the profile', 'PROFILE_IN_USE', { runId: 'r1', runUrl: '/runs/r1' });
        },
      },
    });
    const s = await startProfileSignin(platform.api, ID, 'work', { keepLease: true });
    expect(platform.requests.at(-1)).toMatchObject({ method: 'POST', body: { keepLease: true } });
    expect(signinDesktopPath(s)).toBe(`/fleet/hosts/${ID}/desktop?signin=${SID}`);
    const err = await startProfileSignin(platform.api, ID, 'busy').catch((e: unknown) => e);
    expect(profileInUseRun(err)).toEqual({ runId: 'r1', runUrl: '/runs/r1' });
    expect(profileInUseRun(new Error('x'))).toBeNull();
  });
});
