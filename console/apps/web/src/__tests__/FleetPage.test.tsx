import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, vi } from 'vitest';

import { COPIED_MS, FleetPage, PROFILE_NAME_RULE } from '../pages/FleetPage';
import type { FleetEnrollment, FleetHost } from '../types/fleet';
import { ConfirmProvider } from '../ui';
import { mockViewport } from './matchMedia';

const ID = '11111111-1111-4111-8111-111111111111';
const hosts: FleetHost[] = [
  {
    id: ID,
    name: 'vps',
    version: '0.1.0',
    online: true,
    browserConnected: true,
    onDemand: true,
    draining: false,
    viewerUrl: 'https://viewer.example.test/vnc.html',
    mode: null,
    desktop: false,
    profiles: [
      { name: 'default', running: false },
      { name: 'travel', running: true },
    ],
    lastSeen: '2026-11-15T00:00:00Z',
  },
];
const enrollment: FleetEnrollment = { enrollmentToken: 'hxe_x', expiresAt: null, command: 'hexactra-agent daemon --url http://fabric-control:8787 --enrollment-token hxe_x' };

function renderPage(permissions: string[], responses: Record<string, unknown> = {}) {
  const host = createTestPlatformHost({ permissions, responses: { 'GET /fleet/hosts': hosts, ...responses } });
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter>
          <FleetPage />
        </MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  return host;
}

describe('FleetPage', () => {
  it('lists hosts, profiles and the viewer link', async () => {
    renderPage(['fleet:read']);
    const card = await screen.findByRole('article', { name: 'Host vps' }).catch(() => screen.findByLabelText('Host vps'));
    expect(within(card).getByText('Online')).toBeInTheDocument();
    expect(within(card).getByText('Launch mode')).toBeInTheDocument();
    expect(within(card).getByText('travel')).toBeInTheDocument();
    // Hosts are viewed in the console (Open desktop), never through an external viewer link.
    expect(within(card).queryByRole('link', { name: 'Open the viewer' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Enroll host' })).not.toBeInTheDocument();
    expect(screen.queryByRole('switch', { name: 'Enabled: vps' })).not.toBeInTheDocument();
  });

  it('shows each host mode and which hosts can share a desktop', async () => {
    const node: FleetHost = { ...hosts[0]!, id: '22222222-2222-4222-8222-222222222222', name: 'mini-pc', viewerUrl: null, mode: 'unattended', desktop: true };
    const attended: FleetHost = { ...node, id: '33333333-3333-4333-8333-333333333333', name: 'mini-pc-attended', mode: 'attended', desktop: false };
    renderPage(['fleet:read'], { 'GET /fleet/hosts': [node, attended] });
    const card = await screen.findByLabelText('Host mini-pc');
    expect(within(card).getByText('Unattended')).toBeInTheDocument();
    expect(within(card).getByLabelText('Desktop available')).toBeInTheDocument();
    const other = screen.getByLabelText('Host mini-pc-attended');
    expect(within(other).getByText('Attended')).toBeInTheDocument();
    expect(within(other).queryByLabelText('Desktop available')).not.toBeInTheDocument();
    // Opening a desktop needs fleet:desktop.
    expect(within(card).queryByRole('link', { name: 'Open desktop' })).not.toBeInTheDocument();
  });

  it('labels a user-level agent without a desktop "Browser only", not Unattended (#412)', async () => {
    const userAgent: FleetHost = { ...hosts[0]!, id: '44444444-4444-4444-8444-444444444444', name: 'Linux-Mini-PC', viewerUrl: null, mode: 'unattended', desktop: false };
    renderPage(['fleet:read', 'fleet:desktop'], { 'GET /fleet/hosts': [userAgent] });
    const card = await screen.findByLabelText('Host Linux-Mini-PC');
    expect(within(card).getByText('Browser only')).toBeInTheDocument();
    expect(within(card).queryByText('Unattended')).not.toBeInTheDocument();
    expect(within(card).queryByRole('link', { name: 'Open desktop' })).not.toBeInTheDocument();
    fireEvent.mouseOver(within(card).getByText('Browser only'));
    expect(await screen.findByRole('tooltip')).toHaveTextContent('hexactra agent install --mode unattended');
  });

  it('links desktop hosts to the console desktop page for fleet:desktop, never to an external viewer', async () => {
    const node: FleetHost = { ...hosts[0]!, id: '22222222-2222-4222-8222-222222222222', name: 'mini-pc', viewerUrl: null, mode: 'unattended', desktop: true };
    const attended: FleetHost = { ...node, id: '33333333-3333-4333-8333-333333333333', name: 'mini-pc-attended', mode: 'attended', desktop: false };
    renderPage(['fleet:read', 'fleet:desktop'], { 'GET /fleet/hosts': [node, attended] });
    const card = await screen.findByLabelText('Host mini-pc');
    expect(within(card).getByRole('link', { name: 'Open desktop' })).toHaveAttribute('href', `/fleet/hosts/${node.id}/desktop`);
    expect(within(screen.getByLabelText('Host mini-pc-attended')).queryByRole('link', { name: 'Open desktop' })).not.toBeInTheDocument();
  });

  it('disables a host, manages profiles and enrolls a new host for a writer', async () => {
    const host = renderPage(['fleet:read', 'fleet:write'], {
      [`POST /fleet/hosts/${ID}/drain`]: { state: 'succeeded' },
      [`POST /fleet/hosts/${ID}/profiles/travel/restart`]: { state: 'succeeded' },
      'POST /fleet/enrollments': enrollment,
    });
    fireEvent.click(await screen.findByRole('switch', { name: 'Enabled: vps' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restart travel on vps' }));
    fireEvent.click(screen.getByRole('button', { name: 'Enroll host' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create token' }));
    expect(await screen.findByLabelText('Agent command')).toHaveTextContent('--enrollment-token hxe_x');
    const calls = host.requests.map((r) => `${r.method} ${r.path}`);
    expect(calls).toContain(`POST /fleet/hosts/${ID}/drain`);
    expect(host.requests.find((r) => r.path === `/fleet/hosts/${ID}/drain`)?.body).toEqual({ enabled: true });
    expect(calls).toContain(`POST /fleet/hosts/${ID}/profiles/travel/restart`);
    expect(calls).toContain('POST /fleet/enrollments');
  });

  it('explains the profile name rule and offers "Connect a machine" when no host is enrolled', async () => {
    renderPage(['fleet:read', 'fleet:write']);
    expect(await screen.findByText(PROFILE_NAME_RULE)).toBeInTheDocument();
    renderPage(['fleet:read', 'fleet:write'], { 'GET /fleet/hosts': [] });
    fireEvent.click(await screen.findByRole('button', { name: 'Connect a machine' }));
    expect(await screen.findByRole('dialog', { name: 'Enroll a host' })).toBeInTheDocument();
  });
});

describe('FleetPage on a phone', () => {
  let restore: () => void;
  beforeEach(() => {
    restore = mockViewport(360);
  });
  afterEach(() => restore());

  it('puts the profile actions in one menu per profile', async () => {
    const host = renderPage(['fleet:read', 'fleet:write'], { [`POST /fleet/hosts/${ID}/profiles/travel/close`]: { state: 'succeeded' } });
    await screen.findByLabelText('Host vps');
    // No row of icon buttons to sit on top of the name.
    expect(screen.queryByRole('button', { name: 'Restart travel on vps' })).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Actions for travel on vps' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).getAllByRole('menuitem').map((i) => i.textContent)).toEqual(['Restart browser', 'Close browser', 'Delete profile']);
    fireEvent.click(within(menu).getByRole('menuitem', { name: 'Close browser' }));
    await waitFor(() => expect(host.requests.map((r) => `${r.method} ${r.path}`)).toContain(`POST /fleet/hosts/${ID}/profiles/travel/close`));
  });

  it('never offers to delete the default profile, and cannot close a stopped browser', async () => {
    renderPage(['fleet:read', 'fleet:write']);
    fireEvent.click(await screen.findByRole('button', { name: 'Actions for default on vps' }));
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: 'Delete profile' })).not.toBeInTheDocument();
    expect(within(menu).getByRole('menuitem', { name: 'Close browser' })).toHaveAttribute('aria-disabled', 'true');
  });
});

describe('the enrollment dialog', () => {
  const clipboard = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
  afterEach(() => {
    vi.useRealTimers();
    if (clipboard) Object.defineProperty(navigator, 'clipboard', clipboard);
    else delete (navigator as { clipboard?: unknown }).clipboard;
  });

  async function openCommand() {
    renderPage(['fleet:read', 'fleet:write'], { 'POST /fleet/enrollments': enrollment });
    fireEvent.click(await screen.findByRole('button', { name: 'Enroll host' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create token' }));
    await screen.findByLabelText('Agent command');
  }

  it('"Copy" writes the command and reads "Copied" for two seconds', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: { writeText } });
    await openCommand();
    vi.useFakeTimers();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    });
    expect(writeText).toHaveBeenCalledWith(enrollment.command);
    expect(screen.getByRole('button', { name: 'Copied' })).toBeInTheDocument();
    act(() => {
      vi.advanceTimersByTime(COPIED_MS);
    });
    expect(screen.getByRole('button', { name: 'Copy' })).toBeInTheDocument();
  });

  it('selects the command when the Clipboard API is missing', async () => {
    Object.defineProperty(navigator, 'clipboard', { configurable: true, value: undefined });
    await openCommand();
    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: 'Copy' }));
    });
    expect(window.getSelection()?.toString()).toBe(enrollment.command);
    expect(screen.getByText(/The command is selected/)).toBeInTheDocument();
  });

  it('"Done" closes it', async () => {
    await openCommand();
    fireEvent.click(screen.getByRole('button', { name: 'Done' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
  });
});
