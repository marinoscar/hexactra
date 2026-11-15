import { fireEvent, render, screen } from '@testing-library/react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';

import { FabricConnectionPage, type FabricConnectionTest, type FabricConnectionView } from '../pages/FabricConnectionPage';

const view: FabricConnectionView = {
  configured: true,
  url: 'http://fabric-control:8787',
  token: { hint: 'hxs_…a1b2', updatedAt: '2026-11-01T10:00:00.000Z' },
};
const test: FabricConnectionTest = {
  reachable: true,
  authenticated: true,
  version: '0.1.0',
  latencyMs: 4,
  hosts: 2,
  onlineHosts: 1,
  error: null,
};

describe('FabricConnectionPage', () => {
  it('shows the stored URL, never the token, and tests the connection', async () => {
    const host = createTestPlatformHost({
      permissions: ['fabric_config:read', 'fabric_config:write'],
      responses: { 'GET /fabric/connection': view, 'POST /fabric/connection/test': test },
    });
    render(
      <PlatformHostProvider host={host}>
        <FabricConnectionPage />
      </PlatformHostProvider>,
    );
    expect(await screen.findByDisplayValue('http://fabric-control:8787')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('1 of 2 hosts online')).toBeInTheDocument();
    expect(screen.getByText('Token accepted')).toBeInTheDocument();
  });

  it('is read-only without fabric_config:write', async () => {
    const host = createTestPlatformHost({ permissions: ['fabric_config:read'], responses: { 'GET /fabric/connection': view } });
    render(
      <PlatformHostProvider host={host}>
        <FabricConnectionPage />
      </PlatformHostProvider>,
    );
    expect(await screen.findByDisplayValue('http://fabric-control:8787')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});
