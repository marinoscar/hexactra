import { fireEvent, render, screen, within } from '@testing-library/react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';
import { MemoryRouter } from 'react-router-dom';
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
      <MemoryRouter>
        <FleetPage />
      </MemoryRouter>
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
    expect(screen.queryByRole('button', { name: 'Drain' })).not.toBeInTheDocument();
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

  it('links desktop hosts to the console desktop page for fleet:desktop, never to an external viewer', async () => {
    const node: FleetHost = { ...hosts[0]!, id: '22222222-2222-4222-8222-222222222222', name: 'mini-pc', viewerUrl: null, mode: 'unattended', desktop: true };
    const attended: FleetHost = { ...node, id: '33333333-3333-4333-8333-333333333333', name: 'mini-pc-attended', mode: 'attended', desktop: false };
    renderPage(['fleet:read', 'fleet:desktop'], { 'GET /fleet/hosts': [node, attended] });
    const card = await screen.findByLabelText('Host mini-pc');
    expect(within(card).getByRole('link', { name: 'Open desktop' })).toHaveAttribute('href', `/fleet/hosts/${node.id}/desktop`);
    expect(within(screen.getByLabelText('Host mini-pc-attended')).queryByRole('link', { name: 'Open desktop' })).not.toBeInTheDocument();
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
