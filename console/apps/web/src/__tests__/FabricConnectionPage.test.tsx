import { fireEvent, render, screen } from '@testing-library/react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';

import {
  BUNDLED_FABRIC_URL,
  FabricConnectionPage,
  connectionMode,
  type FabricConnectionTest,
  type FabricConnectionView,
} from '../pages/FabricConnectionPage';

const token = { hint: 'hxs_…a1b2', updatedAt: '2026-11-01T10:00:00.000Z' };
const managed: FabricConnectionView = { configured: true, url: BUNDLED_FABRIC_URL, token };
const custom: FabricConnectionView = { configured: true, url: 'https://fabric.example.test', token };
const missing: FabricConnectionView = { configured: false, url: null, token: null };
const test: FabricConnectionTest = {
  reachable: true,
  authenticated: true,
  version: '0.1.0',
  latencyMs: 4,
  hosts: 2,
  onlineHosts: 1,
  error: null,
};

function renderPage(view: FabricConnectionView, permissions: string[] = ['fabric_config:read', 'fabric_config:write']) {
  const host = createTestPlatformHost({
    permissions,
    responses: { 'GET /fabric/connection': view, 'POST /fabric/connection/test': test },
  });
  render(
    <PlatformHostProvider host={host}>
      <FabricConnectionPage />
    </PlatformHostProvider>,
  );
}

describe('connectionMode', () => {
  it('tells the bundled fabric from a custom one and from nothing stored', () => {
    expect(connectionMode(managed)).toBe('managed');
    expect(connectionMode({ ...managed, url: `${BUNDLED_FABRIC_URL}/` })).toBe('managed');
    expect(connectionMode(custom)).toBe('custom');
    expect(connectionMode(missing)).toBe('missing');
  });
});

describe('FabricConnectionPage', () => {
  it('shows the bundled fabric as managed, tests it on load, and keeps the form collapsed', async () => {
    renderPage(managed);
    expect(await screen.findByText('Managed by deploy')).toBeInTheDocument();
    expect(await screen.findByText('1 of 2 hosts online')).toBeInTheDocument();
    expect(screen.getByText('Token accepted')).toBeInTheDocument();
    expect(screen.getByText(BUNDLED_FABRIC_URL)).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: /Fabric URL/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();

    fireEvent.click(screen.getByRole('button', { name: 'Use a different fabric…' }));
    expect(await screen.findByDisplayValue(BUNDLED_FABRIC_URL)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use a different fabric…' })).not.toBeInTheDocument();
  });

  it('runs the test again on demand', async () => {
    renderPage(managed);
    await screen.findByText('1 of 2 hosts online');
    fireEvent.click(screen.getByRole('button', { name: 'Test connection' }));
    expect(await screen.findByText('Token accepted')).toBeInTheDocument();
  });

  it('shows the form open for a custom fabric, never the token', async () => {
    renderPage(custom);
    expect(await screen.findByText('Custom fabric')).toBeInTheDocument();
    expect(screen.getByDisplayValue('https://fabric.example.test')).toBeInTheDocument();
    expect(screen.queryByDisplayValue(/hxs_/)).not.toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Save' })).toBeInTheDocument();
    expect(await screen.findByText('1 of 2 hosts online')).toBeInTheDocument();
  });

  it('shows the form open with a hint when nothing is stored', async () => {
    renderPage(missing);
    expect(await screen.findByText(/Not connected/)).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: /Fabric URL/ })).toHaveValue('');
    expect(screen.getByRole('button', { name: 'Test connection' })).toBeDisabled();
    expect(screen.queryByText('Token accepted')).not.toBeInTheDocument();
  });

  it('is read-only without fabric_config:write', async () => {
    renderPage(managed, ['fabric_config:read']);
    expect(await screen.findByText('Managed by deploy')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Use a different fabric…' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });

  it('disables the form for a custom fabric without fabric_config:write', async () => {
    renderPage(custom, ['fabric_config:read']);
    expect(await screen.findByDisplayValue('https://fabric.example.test')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save' })).not.toBeInTheDocument();
  });
});
