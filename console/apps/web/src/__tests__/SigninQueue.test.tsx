// "Fix sign-ins" (E48.6, #932): the queue of every profile that needs a Google sign-in, signed in one at a time with the guided
// sign-in of E48.4. Order, next and skip, the takeover lease kept within a host and released when the queue moves to another
// host or ends, the summary, and offline, taken-over and busy items skipped with their reason. noVNC is replaced by a fake.
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestApiError, createTestPlatformHost, type TestApiRequest } from '@marinoscar/platform-web/testing';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@novnc/novnc/core/rfb.js', () => ({
  default: class extends EventTarget {
    viewOnly = true;
    scaleViewport = false;
    focusOnClick = false;
    disconnect = vi.fn(() => this.dispatchEvent(new Event('disconnect')));
    focus = vi.fn();
  },
}));

import { ATTENDED_HINT, NO_DESKTOP_ACCESS_HINT, NO_DESKTOP_HINT } from '../components/fleet/ProfileSigninStatus';
import type { ProfileSignin } from '../fleet/signin';
import {
  BUSY_REASON,
  OFFLINE_REASON,
  SKIPPED_REASON,
  buildSigninQueue,
  fixableCount,
  loadQueue,
  recordResult,
  releaseHeld,
  retryItems,
  saveQueue,
  skipSignin,
  startNext,
  summaryOf,
  type SigninQueue,
} from '../fleet/signinQueue';
import { DesktopPage } from '../pages/DesktopPage';
import { FleetPage } from '../pages/FleetPage';
import { SigninQueuePage } from '../pages/SigninQueuePage';
import type { FleetHost, FleetProfile } from '../types/fleet';
import { ConfirmProvider } from '../ui';

const A = 'aaaaaaaa-0000-4000-8000-000000000001';
const B = 'bbbbbbbb-0000-4000-8000-000000000002';
const C = 'cccccccc-0000-4000-8000-000000000003';
const LEASE_A = 'aaaaaaaa-1111-4000-8000-000000000001';
const LEASE_B = 'bbbbbbbb-1111-4000-8000-000000000002';

const profile = (name: string, signin: FleetProfile['signin']): FleetProfile => ({ name, running: false, signin, accounts: [], checkedAt: '2026-11-25T10:00:00Z' });
const host = (id: string, name: string, profiles: FleetProfile[], over: Partial<FleetHost> = {}): FleetHost => ({
  id,
  name,
  version: '1.0.0',
  online: true,
  browserConnected: true,
  onDemand: true,
  draining: false,
  viewerUrl: null,
  mode: 'unattended',
  desktop: true,
  profiles,
  lastSeen: '2026-11-25T10:00:00Z',
  ...over,
});

// Given out of order on purpose: the queue sorts by host name, then profile name.
const beta = host(B, 'beta', [profile('work', 'expired'), profile('default', 'signed_in')]);
const alpha = host(A, 'alpha', [profile('zeta', 'signed_out'), profile('main', 'expired'), profile('ok', 'signed_in'), profile('new', 'unknown')]);
const gamma = host(C, 'gamma', [profile('default', 'signed_out')], { online: false });
const laptop = host('dddddddd-0000-4000-8000-000000000004', 'laptop', [profile('default', 'signed_out')], { mode: 'attended', desktop: false });
const vps = host('eeeeeeee-0000-4000-8000-000000000005', 'vps', [profile('default', 'expired')], { desktop: false });
const fleet = [beta, laptop, gamma, alpha, vps];

let seq = 0;
const session = (hostId: string, name: string, over: Partial<ProfileSignin> = {}): ProfileSignin => ({
  id: `5191a000-0000-4000-8000-${String(++seq).padStart(12, '0')}`,
  hostId,
  profile: name,
  status: 'started',
  phase: 'waiting',
  leaseId: hostId === A ? LEASE_A : LEASE_B,
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
const done = (s: ProfileSignin, over: Partial<ProfileSignin> = {}): ProfileSignin => ({ ...s, status: 'completed', phase: null, signin: 'signed_in', resultState: 'signed_in', ...over });

/** A fake sign-in API: starts answer with a session (keepLease echoed), or with the refusal given for that profile. */
function signinApi(refusals: Record<string, Error> = {}, extra: Record<string, unknown> = {}) {
  const started: ProfileSignin[] = [];
  const startRoute = (hostId: string, name: string) => (r: TestApiRequest) => {
    const refusal = refusals[`${hostId}/${name}`];
    if (refusal) throw refusal;
    const s = session(hostId, name, { keepLease: Boolean((r.body as { keepLease?: boolean })?.keepLease) });
    started.push(s);
    return s;
  };
  const responses: Record<string, unknown> = { 'GET /fleet/hosts': fleet, ...extra };
  for (const h of fleet) for (const p of h.profiles) responses[`POST /fleet/hosts/${h.id}/profiles/${p.name}/signin`] = startRoute(h.id, p.name);
  for (const id of [A, B]) for (const l of [LEASE_A, LEASE_B]) responses[`DELETE /fleet/hosts/${id}/takeover/${l}`] = undefined;
  const platform = createTestPlatformHost({ permissions: ['fleet:read', 'fleet:desktop'], responses });
  return { platform, api: platform.api, started };
}

const starts = (reqs: TestApiRequest[]) => reqs.filter((r) => r.method === 'POST' && r.path.endsWith('/signin')).map((r) => `${r.path.split('/')[3] === A ? 'alpha' : r.path.split('/')[3] === B ? 'beta' : 'gamma'}/${r.path.split('/')[5]} ${JSON.stringify(r.body)}`);
const releases = (reqs: TestApiRequest[]) => reqs.filter((r) => r.method === 'DELETE' && r.path.includes('/takeover/')).map((r) => r.path);

beforeEach(() => {
  saveQueue(null);
});

describe('the sign-in queue (E48.6)', () => {
  it('lists the profiles by host name, then profile name; offline items start skipped; the others sign in on the node', () => {
    const q = buildSigninQueue(fleet, true);
    expect(q.items.map((it) => `${it.hostName}/${it.profile}:${it.status}`)).toEqual(['alpha/main:pending', 'alpha/zeta:pending', 'beta/work:pending', 'gamma/default:skipped']);
    expect(q.items.at(-1)!.reason).toBe(OFFLINE_REASON);
    expect(q.onNode).toEqual([
      expect.objectContaining({ hostName: 'laptop', profile: 'default', hint: ATTENDED_HINT }),
      expect.objectContaining({ hostName: 'vps', profile: 'default', hint: NO_DESKTOP_HINT }),
    ]);
    expect(fixableCount(fleet, true)).toBe(4);
    // Without fleet:desktop nothing is fixable here: every profile is "sign in on the node".
    const viewer = buildSigninQueue(fleet, false);
    expect(viewer.items).toEqual([]);
    expect(viewer.onNode.filter((o) => o.hint === NO_DESKTOP_ACCESS_HINT).map((o) => `${o.hostName}/${o.profile}`)).toEqual(['alpha/main', 'alpha/zeta', 'beta/work', 'gamma/default']);
    expect(fixableCount(fleet, false)).toBe(0);
    // The same order whatever order the fleet comes in.
    expect(buildSigninQueue([...fleet].reverse(), true).items.map((it) => it.key)).toEqual(q.items.map((it) => it.key));
  });

  it('keeps the lease within a host and lets the last sign-in on it give the lease back; the end releases nothing more', async () => {
    const { api, platform, started } = signinApi();
    let q = buildSigninQueue(fleet, true);
    let r = await startNext(api, q);
    expect(r.session!.profile).toBe('main');
    expect(r.queue.held).toEqual({ hostId: A, leaseId: LEASE_A });
    // Next profile: the first signed in.
    q = recordResult(r.queue, done(started[0]!, { keepLease: true }));
    r = await startNext(api, q);
    expect(r.session!.profile).toBe('zeta');
    // The last one on alpha does not keep the lease: the API gives it back when it ends.
    expect(r.queue.held).toBeNull();
    q = recordResult(r.queue, done(started[1]!, { resultState: 'expired' }));
    r = await startNext(api, q);
    expect(r.session!.profile).toBe('work');
    q = recordResult(r.queue, done(started[2]!));
    r = await startNext(api, q);
    expect(r.session).toBeNull();
    expect(starts(platform.requests)).toEqual(['alpha/main {"keepLease":true}', 'alpha/zeta {}', 'beta/work {}']);
    expect(releases(platform.requests)).toEqual([]);
    expect(summaryOf(r.queue)).toEqual({ pending: 0, signed_in: 2, skipped: 1, failed: 1 });
    expect(r.queue.items.find((it) => it.profile === 'zeta')!.reason).toMatch(/reads expired/);
  });

  it('releases a kept lease when the queue moves to another host, and skips busy, taken-over and offline items with their reason', async () => {
    const { api, platform, started } = signinApi({
      [`${A}/zeta`]: createTestApiError(409, 'A run is using the profile', 'PROFILE_IN_USE', { runId: 'r1', runUrl: '/runs/r1' }),
      [`${B}/work`]: createTestApiError(409, 'Someone is controlling beta’s desktop', 'TAKEOVER_HELD'),
      [`${C}/default`]: createTestApiError(409, 'gamma is offline', 'SIGNIN_HOST_OFFLINE'),
    });
    let r = await startNext(api, buildSigninQueue(fleet, true));
    expect(r.session!.keepLease).toBe(true);
    const q = recordResult(r.queue, done(started[0]!, { keepLease: true }));
    r = await startNext(api, retryItems(q, [`${C}/default`]));
    expect(r.session).toBeNull();
    // alpha's lease was released once the queue left alpha (zeta was busy), before beta was tried.
    expect(releases(platform.requests)).toEqual([`/fleet/hosts/${A}/takeover/${LEASE_A}`]);
    const order = platform.requests.filter((x) => x.method !== 'GET').map((x) => `${x.method} ${x.path.split('/').slice(3).join('/')}`);
    expect(order.indexOf(`DELETE ${A}/takeover/${LEASE_A}`)).toBeLessThan(order.indexOf(`POST ${B}/profiles/work/signin`));
    const by = Object.fromEntries(r.queue.items.map((it) => [it.profile === 'default' ? 'gamma' : it.profile, it]));
    expect(by.zeta).toMatchObject({ status: 'skipped', reason: BUSY_REASON, runUrl: '/runs/r1' });
    expect(by.work).toMatchObject({ status: 'skipped', reason: 'Someone is controlling beta’s desktop' });
    expect(by.gamma).toMatchObject({ status: 'skipped', reason: OFFLINE_REASON });
    expect(summaryOf(r.queue)).toEqual({ pending: 0, signed_in: 1, skipped: 3, failed: 0 });
  });

  it('Skip keeps the lease for a next profile on the same host and leaves the item unresolved; stopping releases it', async () => {
    const { api, platform, started } = signinApi({}, {});
    const r = await startNext(api, buildSigninQueue(fleet, true));
    const s = started[0]!;
    // The page's Skip: cancel with the sign-in's own keepLease (true: zeta is next on alpha).
    const cancelled = { ...s, status: 'abandoned' as const, phase: null, endReason: 'cancelled' as const };
    const withCancel = createTestPlatformHost({ responses: { [`POST /fleet/signin-sessions/${s.id}/cancel`]: cancelled } });
    await skipSignin(withCancel.api, s);
    expect(withCancel.requests.at(-1)).toMatchObject({ method: 'POST', body: { keepLease: true } });
    const q = recordResult(r.queue, cancelled);
    expect(q.items[0]).toMatchObject({ status: 'skipped', reason: SKIPPED_REASON });
    expect(q.held).toEqual({ hostId: A, leaseId: LEASE_A });
    // A timeout is a failure, not a skip.
    expect(recordResult(r.queue, { ...cancelled, endReason: 'timeout' }).items[0]).toMatchObject({ status: 'failed', reason: 'Not finished within 15 minutes' });
    // Stopping the queue gives the kept lease back.
    expect((await releaseHeld(api, q)).held).toBeNull();
    expect(releases(platform.requests)).toEqual([`/fleet/hosts/${A}/takeover/${LEASE_A}`]);
  });
});

function Where() {
  const l = useLocation();
  return <div data-testid="where">{`${l.pathname}${l.search}`}</div>;
}

function renderAt(platform: ReturnType<typeof createTestPlatformHost>, path: string) {
  render(
    <PlatformHostProvider host={platform}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[path]}>
          <Routes>
            <Route path="/fleet" element={<FleetPage />} />
            <Route path="/fleet/signin-queue" element={<SigninQueuePage />} />
            <Route path="/fleet/hosts/:id/desktop" element={<DesktopPage />} />
            <Route path="*" element={<Where />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
}

describe('Fix sign-ins on the Fleet page and the queue page (E48.6)', () => {
  it('the Fleet page offers "Fix sign-ins (N)" to fleet:desktop only', async () => {
    const { platform } = signinApi();
    renderAt(platform, '/fleet');
    const link = await screen.findByRole('link', { name: /Fix sign-ins \(4\)/ });
    expect(link).toHaveAttribute('href', '/fleet/signin-queue');

    cleanup();
    const reader = createTestPlatformHost({ permissions: ['fleet:read'], responses: { 'GET /fleet/hosts': fleet } });
    renderAt(reader, '/fleet');
    await screen.findByText(/Needs sign-in \(/);
    expect(screen.queryByRole('link', { name: /Fix sign-ins/ })).toBeNull();
  });

  it('lists the queue grouped by host with statuses, and Start opens the first sign-in on the desktop page in queue mode', async () => {
    const { platform, started } = signinApi();
    renderAt(platform, '/fleet/signin-queue');
    const hosts = await screen.findAllByRole('heading', { level: 2 });
    expect(hosts.map((h) => h.textContent)).toEqual(['alpha', 'beta', 'gamma', 'Sign in on the node']);
    const gammaCard = screen.getByLabelText('Host gamma');
    expect(within(gammaCard).getByText('Skipped')).toBeInTheDocument();
    expect(within(gammaCard).getByText(OFFLINE_REASON)).toBeInTheDocument();
    expect(screen.getByText(ATTENDED_HINT)).toBeInTheDocument();
    expect(screen.getAllByTestId('queue-item').map((e) => e.getAttribute('data-status'))).toEqual(['pending', 'pending', 'pending', 'skipped']);
    fireEvent.click(screen.getByRole('button', { name: 'Start' }));
    await waitFor(() => expect(started).toHaveLength(1));
    expect(starts(platform.requests)).toEqual(['alpha/main {"keepLease":true}']);
    expect(loadQueue()!.active).toEqual({ key: `${A}/main`, sessionId: started[0]!.id });
  });

  it('back from the desktop page, records the outcome and starts the next; at the end shows the summary with retries', async () => {
    const q0: SigninQueue = buildSigninQueue([alpha], true);
    const s1 = session(A, 'zeta', { keepLease: false });
    const stored: SigninQueue = { ...q0, items: q0.items.map((it) => (it.profile === 'main' ? { ...it, status: 'skipped', reason: SKIPPED_REASON } : it)), active: { key: `${A}/zeta`, sessionId: s1.id }, ran: true };
    saveQueue(stored);
    const { platform } = signinApi({}, { [`GET /fleet/signin-sessions/${s1.id}`]: done(s1) });
    renderAt(platform, `/fleet/signin-queue?from=${s1.id}`);
    const summary = await screen.findByTestId('queue-summary');
    expect(within(summary).getByTestId('summary-signed-in')).toHaveTextContent('Signed in: 1');
    expect(within(summary).getByTestId('summary-skipped')).toHaveTextContent('Skipped: 1');
    expect(within(summary).getByTestId('summary-failed')).toHaveTextContent('Failed: 0');
    expect(screen.getByRole('button', { name: 'Done' })).toBeInTheDocument();
    // Retry skipped puts main back and starts it.
    fireEvent.click(within(summary).getByRole('button', { name: 'Retry skipped' }));
    await waitFor(() => expect(starts(platform.requests)).toEqual(['alpha/main {}']));
  });

  it('back with stop=1 records the outcome without starting another, and releases the kept lease', async () => {
    const q0 = buildSigninQueue([alpha], true);
    const s1 = session(A, 'main', { keepLease: true });
    saveQueue({ ...q0, ran: true, held: { hostId: A, leaseId: LEASE_A }, active: { key: `${A}/main`, sessionId: s1.id } });
    const { platform } = signinApi({}, { [`GET /fleet/signin-sessions/${s1.id}`]: done(s1, { keepLease: true }) });
    renderAt(platform, `/fleet/signin-queue?from=${s1.id}&stop=1`);
    await waitFor(() => expect(releases(platform.requests)).toEqual([`/fleet/hosts/${A}/takeover/${LEASE_A}`]));
    expect(await screen.findByRole('button', { name: 'Continue' })).toBeInTheDocument();
    expect(starts(platform.requests)).toEqual([]);
    expect(loadQueue()!.items.map((it) => it.status)).toEqual(['signed_in', 'pending']);
  });
});

describe('the desktop page inside the queue (E48.6)', () => {
  it('Skip cancels keeping the lease for the next profile on the host and goes back to the queue; Next profile too', async () => {
    const s = session(A, 'main', { keepLease: true });
    const platform = createTestPlatformHost({
      permissions: ['fleet:read', 'fleet:desktop'],
      responses: {
        [`GET /fleet/hosts/${A}`]: alpha,
        [`POST /fleet/hosts/${A}/viewer-session`]: { hostId: A, wsPath: `/viewer/${A}/websockify`, expiresAt: '2026-11-25T11:00:00Z' },
        [`DELETE /fleet/hosts/${A}/viewer-session`]: undefined,
        [`GET /fleet/hosts/${A}/takeover`]: { leaseId: LEASE_A, userId: 'test-user', displayName: 'Owner', expiresAt: '2026-11-25T10:05:00Z' },
        [`GET /fleet/signin-sessions/${s.id}`]: s,
        [`POST /fleet/signin-sessions/${s.id}/cancel`]: { ...s, status: 'abandoned', phase: null, endReason: 'cancelled' },
        'GET /fleet/hosts': [alpha],
      },
    });
    renderAt(platform, `/fleet/hosts/${A}/desktop?signin=${s.id}&queue=1`);
    fireEvent.click(await screen.findByRole('button', { name: 'Skip' }));
    await waitFor(() => expect(platform.requests.some((r) => r.method === 'POST' && r.path === `/fleet/signin-sessions/${s.id}/cancel`)).toBe(true));
    expect(platform.requests.find((r) => r.path.endsWith('/cancel'))!.body).toEqual({ keepLease: true });
    // Leaving for the queue never releases a lease kept for the next profile.
    await screen.findByRole('heading', { name: 'Fix sign-ins' });
    expect(releases(platform.requests)).toEqual([]);
  });

  it('an ended sign-in in the queue offers Next profile and Back to the queue', async () => {
    const s = done(session(A, 'main', { keepLease: true }));
    const platform = createTestPlatformHost({
      permissions: ['fleet:read', 'fleet:desktop'],
      responses: {
        [`GET /fleet/hosts/${A}`]: alpha,
        [`POST /fleet/hosts/${A}/viewer-session`]: { hostId: A, wsPath: `/viewer/${A}/websockify`, expiresAt: '2026-11-25T11:00:00Z' },
        [`DELETE /fleet/hosts/${A}/viewer-session`]: undefined,
        [`GET /fleet/hosts/${A}/takeover`]: null,
        [`GET /fleet/signin-sessions/${s.id}`]: s,
        'GET /fleet/hosts': [alpha],
      },
    });
    renderAt(platform, `/fleet/hosts/${A}/desktop?signin=${s.id}&queue=1`);
    expect(await screen.findByText(/you keep the desktop for the next profile/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Back to the queue' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Next profile' }));
    await screen.findByRole('heading', { name: 'Fix sign-ins' });
  });
});
