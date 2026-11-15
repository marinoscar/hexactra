import { fireEvent, render, screen, within } from '@testing-library/react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';
import { vi } from 'vitest';

import { FleetPage, type FleetEnrollment, type FleetHost } from '../pages/FleetPage';

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
      <FleetPage />
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
    expect(within(card).getByRole('link', { name: 'Open the viewer' })).toHaveAttribute('href', 'https://viewer.example.test/vnc.html');
    expect(screen.queryByRole('button', { name: 'Enroll host' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Drain' })).not.toBeInTheDocument();
  });

  it('opens the bundled host through a one-time viewer ticket', async () => {
    const local = { ...hosts[0]!, viewerUrl: 'http://localhost:3535/viewer/local/vnc.html' };
    const tab = { location: { href: '' }, close: vi.fn() };
    vi.spyOn(window, 'open').mockReturnValue(tab as unknown as Window);
    const host = createTestPlatformHost({
      permissions: ['fleet:read', 'fleet:write'],
      responses: { 'GET /fleet/hosts': [local], 'POST /fleet/viewer-ticket': { url: '/viewer/local/vnc.html?ticket=t.1.n.s' } },
    });
    render(
      <PlatformHostProvider host={host}>
        <FleetPage />
      </PlatformHostProvider>,
    );
    fireEvent.click(await screen.findByRole('button', { name: 'Open the viewer' }));
    await vi.waitFor(() => expect(tab.location.href).toBe('/viewer/local/vnc.html?ticket=t.1.n.s'));
  });

  it('drains a host, manages profiles and enrolls a new host for a writer', async () => {
    const host = renderPage(['fleet:read', 'fleet:write'], {
      [`POST /fleet/hosts/${ID}/drain`]: { state: 'succeeded' },
      [`POST /fleet/hosts/${ID}/profiles/travel/restart`]: { state: 'succeeded' },
      'POST /fleet/enrollments': enrollment,
    });
    fireEvent.click(await screen.findByRole('button', { name: 'Drain' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Restart travel on vps' }));
    fireEvent.click(screen.getByRole('button', { name: 'Enroll host' }));
    fireEvent.click(await screen.findByRole('button', { name: 'Create token' }));
    expect(await screen.findByLabelText('Agent command')).toHaveTextContent('--enrollment-token hxe_x');
    const calls = host.requests.map((r) => `${r.method} ${r.path}`);
    expect(calls).toContain(`POST /fleet/hosts/${ID}/drain`);
    expect(calls).toContain(`POST /fleet/hosts/${ID}/profiles/travel/restart`);
    expect(calls).toContain('POST /fleet/enrollments');
  });
});
