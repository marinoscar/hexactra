// The desktop viewer's layout and toolbar (#431): fit or actual size, the
// compact toolbar on a phone, the on-screen keyboard's path to the remote and
// the rotate hint. The connection logic is covered by DesktopPage.test.tsx.
import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, vi } from 'vitest';

interface FakeRfb extends EventTarget {
  viewOnly: boolean;
  scaleViewport: boolean;
  clipViewport: boolean;
  dragViewport: boolean;
  sendKey: ReturnType<typeof vi.fn>;
  clipboardPasteFrom: ReturnType<typeof vi.fn>;
}
const rfb = vi.hoisted(() => ({ instances: [] as unknown[] }));
vi.mock('@novnc/novnc/core/rfb.js', () => ({
  default: class extends EventTarget {
    viewOnly = true;
    scaleViewport = false;
    clipViewport = false;
    dragViewport = false;
    focusOnClick = false;
    disconnect = vi.fn();
    sendCtrlAltDel = vi.fn();
    sendKey = vi.fn();
    focus = vi.fn();
    clipboardPasteFrom = vi.fn();
    constructor() {
      super();
      rfb.instances.push(this);
    }
  },
}));

import { diffKeysyms, keyboardDiff, KEYBOARD_SENTINEL, keysymOf } from '../components/remoteKeyboard';
import { applyScale, DesktopPage } from '../pages/DesktopPage';
import type { FleetHost } from '../types/fleet';
import { mockViewport } from './matchMedia';

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
  profiles: [
    { name: 'default', running: false, signin: 'unknown', accounts: [], checkedAt: null },
    { name: 'travel', running: false, signin: 'unknown', accounts: [], checkedAt: null },
  ],
  lastSeen: '2026-11-16T00:00:00Z',
};

async function renderConnected() {
  const platform = createTestPlatformHost({
    permissions: ['fleet:read', 'fleet:desktop'],
    responses: {
      [`GET /fleet/hosts/${ID}`]: host,
      [`POST /fleet/hosts/${ID}/viewer-session`]: { hostId: ID, wsPath: `/viewer/${ID}/websockify`, expiresAt: '2026-11-16T01:00:00Z' },
      [`DELETE /fleet/hosts/${ID}/viewer-session`]: undefined,
      [`GET /fleet/hosts/${ID}/takeover`]: null,
      [`POST /fleet/hosts/${ID}/takeover`]: { leaseId: 'l1', userId: 'test-user', displayName: 'Person A', expiresAt: '2026-11-16T01:00:00Z' },
      [`DELETE /fleet/hosts/${ID}/takeover/l1`]: undefined,
      [`POST /fleet/hosts/${ID}/profiles/travel/show`]: { state: 'succeeded' },
    },
  });
  render(
    <PlatformHostProvider host={platform}>
      <MemoryRouter initialEntries={[`/fleet/hosts/${ID}/desktop`]}>
        <Routes>
          <Route path="/fleet/hosts/:id/desktop" element={<DesktopPage />} />
          <Route path="/fleet" element={<p>Fleet list</p>} />
        </Routes>
      </MemoryRouter>
    </PlatformHostProvider>,
  );
  await waitFor(() => expect(rfb.instances).toHaveLength(1));
  const r = rfb.instances[0] as FakeRfb;
  act(() => {
    r.dispatchEvent(new Event('connect'));
  });
  await screen.findByText('Connected');
  return { platform, r };
}

let restore: (() => void) | null = null;
beforeEach(() => {
  rfb.instances.length = 0;
});
afterEach(() => {
  restore?.();
  restore = null;
});

describe('desktop viewer scale', () => {
  it('fits the remote screen by default; "Actual size" clips and pans inside the viewer, "Fit to window" goes back', async () => {
    const { r } = await renderConnected();
    expect([r.scaleViewport, r.clipViewport, r.dragViewport]).toEqual([true, false, false]);
    fireEvent.click(screen.getByRole('button', { name: 'Actual size' }));
    expect([r.scaleViewport, r.clipViewport, r.dragViewport]).toEqual([false, true, true]);
    expect(screen.getByText(/drag to move around the screen/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Fit to window' }));
    expect([r.scaleViewport, r.clipViewport, r.dragViewport]).toEqual([true, false, false]);
  });

  it('applyScale sets the three noVNC switches together', () => {
    const r = { scaleViewport: false, clipViewport: false, dragViewport: false };
    applyScale(r, 'fit');
    expect(r).toEqual({ scaleViewport: true, clipViewport: false, dragViewport: false });
    applyScale(r, 'actual');
    expect(r).toEqual({ scaleViewport: false, clipViewport: true, dragViewport: true });
  });
});

describe('desktop viewer on a phone', () => {
  it('is one row of labelled icon buttons, with the rest in a menu', async () => {
    restore = mockViewport(390);
    const { platform } = await renderConnected();
    const toolbar = screen.getByRole('toolbar', { name: 'Desktop controls' });
    const names = within(toolbar).getAllByRole('button').map((b) => b.getAttribute('aria-label'));
    expect(names).toEqual(['Close', 'Take over', 'Actual size', 'Keyboard', 'Ctrl-Alt-Del', 'More']);
    // No text buttons: every label is an accessible name only.
    for (const b of within(toolbar).getAllByRole('button')) expect(b.textContent).toBe('');
    fireEvent.click(within(toolbar).getByRole('button', { name: 'More' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Paste clipboard', 'Reconnect', 'default', 'travel']);
    expect(within(menu).getByText('Sign in to profile')).toBeInTheDocument();
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'travel' }));
    expect(await screen.findByText(/Chrome for "travel" is open at the Google sign-in/)).toBeInTheDocument();
    expect(platform.requests.some((q) => q.method === 'POST' && q.path === `/fleet/hosts/${ID}/profiles/travel/show`)).toBe(true);
  });

  it('hints to rotate in portrait', async () => {
    restore = mockViewport(390);
    const base = window.matchMedia;
    window.matchMedia = ((q: string) => (q.includes('orientation') ? { ...base(q), matches: q.includes('portrait') } : base(q))) as typeof window.matchMedia;
    await renderConnected();
    expect(screen.getByTestId('rotate-hint')).toHaveTextContent('Rotate for a larger view.');
  });

  it('shows no rotate hint on a desktop', async () => {
    await renderConnected();
    expect(screen.queryByTestId('rotate-hint')).not.toBeInTheDocument();
  });
});

describe('the on-screen keyboard', () => {
  it('is off while watching; after Take over it focuses the hidden field, whose text goes to the remote as keysyms', async () => {
    const { r } = await renderConnected();
    expect(screen.getByRole('button', { name: 'Keyboard' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Take over' }));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Keyboard' })).toBeEnabled());
    fireEvent.click(screen.getByRole('button', { name: 'Keyboard' }));
    const field = screen.getByLabelText('Keyboard input for the remote desktop') as HTMLInputElement;
    expect(document.activeElement).toBe(field);
    fireEvent.input(field, { target: { value: `${KEYBOARD_SENTINEL}hé` } });
    expect(r.sendKey.mock.calls.map((c) => c[0])).toEqual([0x68, 0xe9]);
    // The field goes back to its filler, so a Backspace always has something to delete.
    expect(field.value).toBe(KEYBOARD_SENTINEL);
    fireEvent.input(field, { target: { value: KEYBOARD_SENTINEL.slice(1) } });
    expect(r.sendKey.mock.calls.at(-1)![0]).toBe(0xff08);
    fireEvent.keyDown(field, { key: 'Enter' });
    expect(r.sendKey.mock.calls.at(-1)![0]).toBe(0xff0d);
  });

  it('maps characters to X11 keysyms and diffs what the keyboard changed', () => {
    expect(keysymOf('a')).toBe(0x61);
    expect(keysymOf('\n')).toBe(0xff0d);
    expect(keysymOf('€')).toBe(0x010020ac);
    expect(keyboardDiff('__', '__a')).toEqual({ backspaces: 0, text: 'a' });
    expect(keyboardDiff('__', '_')).toEqual({ backspaces: 1, text: '' });
    // Autocorrect replaces the word being typed.
    expect(keyboardDiff('__teh', '__the ')).toEqual({ backspaces: 2, text: 'he ' });
    expect(diffKeysyms('__teh', '__the ')).toEqual([0xff08, 0xff08, 0x68, 0x65, 0x20]);
  });
});
