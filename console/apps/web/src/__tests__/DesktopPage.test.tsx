// The remote desktop page (#339): it opens a viewer session, connects noVNC
// to this host's /viewer/<id>/websockify, reconnects with backoff, and ends
// the session on close. noVNC itself is replaced by a fake.
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { vi } from 'vitest';

const rfb = vi.hoisted(() => ({ instances: [] as Array<{ url: string; target: EventTarget; disconnect: ReturnType<typeof vi.fn>; sendCtrlAltDel: ReturnType<typeof vi.fn> }> }));
vi.mock('@novnc/novnc/lib/rfb', () => ({
  default: class extends EventTarget {
    viewOnly = true;
    scaleViewport = false;
    focusOnClick = false;
    disconnect = vi.fn(() => this.dispatchEvent(new Event('disconnect')));
    sendCtrlAltDel = vi.fn();
    clipboardPasteFrom = vi.fn();
    constructor(_el: HTMLElement, public url: string) {
      super();
      rfb.instances.push(this as never);
    }
  },
}));

import { backoff, DesktopPage } from '../pages/DesktopPage';
import type { FleetHost } from '../pages/FleetPage';

const ID = '22222222-2222-4222-8222-222222222222';
const host: FleetHost = {
  id: ID,
  name: 'mini-pc',
  version: '0.3.0',
  online: true,
  browserConnected: true,
  onDemand: true,
  draining: false,
  viewerUrl: null,
  mode: 'unattended',
  desktop: true,
  profiles: [],
  lastSeen: '2026-11-16T00:00:00Z',
};

function renderPage(h: FleetHost = host) {
  const platform = createTestPlatformHost({
    permissions: ['fleet:read', 'fleet:desktop'],
    responses: {
      [`GET /fleet/hosts/${ID}`]: h,
      [`POST /fleet/hosts/${ID}/viewer-session`]: { hostId: ID, wsPath: `/viewer/${ID}/websockify`, expiresAt: '2026-11-16T01:00:00Z' },
      [`DELETE /fleet/hosts/${ID}/viewer-session`]: undefined,
      [`POST /fleet/hosts/${ID}/profiles/personal/show`]: { id: 'c1', kind: 'show_profile', profile: 'personal', state: 'succeeded', error: null, createdAt: '', completedAt: '' },
      'GET /fleet/hosts': [h],
    },
  });
  const view = render(
    <PlatformHostProvider host={platform}>
      <MemoryRouter initialEntries={[`/fleet/hosts/${ID}/desktop`]}>
        <Routes>
          <Route path="/fleet/hosts/:id/desktop" element={<DesktopPage />} />
          <Route path="/fleet" element={<p>Fleet list</p>} />
        </Routes>
      </MemoryRouter>
    </PlatformHostProvider>,
  );
  return { platform, view };
}

describe('DesktopPage', () => {
  beforeEach(() => {
    rfb.instances.length = 0;
  });

  it('opens a viewer session and connects to this host\'s desktop path on the console', async () => {
    const { platform } = renderPage();
    await waitFor(() => expect(rfb.instances).toHaveLength(1));
    expect(rfb.instances[0]!.url).toBe(`ws://${window.location.host}/viewer/${ID}/websockify`);
    expect(platform.requests.map((r) => `${r.method} ${r.path}`)).toContain(`POST /fleet/hosts/${ID}/viewer-session`);
    act(() => {
      (rfb.instances[0] as unknown as EventTarget).dispatchEvent(new Event('connect'));
    });
    expect(await screen.findByText('Connected')).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Ctrl-Alt-Del' }));
    expect(rfb.instances[0]!.sendCtrlAltDel).toHaveBeenCalled();
  });

  it('reconnects after a drop, and Close ends the session and goes back to Fleet', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const { platform } = renderPage();
      await waitFor(() => expect(rfb.instances).toHaveLength(1));
      act(() => {
        (rfb.instances[0] as unknown as EventTarget).dispatchEvent(new Event('disconnect'));
      });
      expect(await screen.findByText('Reconnecting…')).toBeInTheDocument();
      await act(async () => {
        vi.advanceTimersByTime(1000);
      });
      await waitFor(() => expect(rfb.instances).toHaveLength(2));
      fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      expect(await screen.findByText('Fleet list')).toBeInTheDocument();
      expect(platform.requests.some((r) => r.method === 'DELETE' && r.path === `/fleet/hosts/${ID}/viewer-session`)).toBe(true);
      expect(rfb.instances).toHaveLength(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it('opens a profile at the Google sign-in on an unattended node', async () => {
    const { platform } = renderPage({ ...host, profiles: [{ name: 'personal', running: false }] });
    await waitFor(() => expect(rfb.instances).toHaveLength(1));
    act(() => {
      (rfb.instances[0] as unknown as EventTarget).dispatchEvent(new Event('connect'));
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Sign in to profile' }));
    expect(await screen.findByText(/Chrome for "personal" is open at the Google sign-in/)).toBeInTheDocument();
    expect(platform.requests.some((r) => r.method === 'POST' && r.path === `/fleet/hosts/${ID}/profiles/personal/show`)).toBe(true);
  });

  it('says when the node is offline or shares no desktop, without connecting', async () => {
    renderPage({ ...host, online: false });
    expect(await screen.findByText(/mini-pc is offline/)).toBeInTheDocument();
    expect(rfb.instances).toHaveLength(0);
  });

  it('backs off from 1 s to 30 s', () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(backoff)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
});
