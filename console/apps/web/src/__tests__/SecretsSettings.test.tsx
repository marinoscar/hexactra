// Settings → Secrets (E37.4, E37.5): the provider choice. "Store in Hexactra" is offered only while the deployment
// switched the built-in store on; one provider is active; the choice and the owner's switch are saved to the
// user's settings; a viewer sees but cannot change.
import { cleanup, configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SecretsSettingsPage, type SecretsStatus, type StoreStatus } from '../pages/SecretsSettingsPage';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

const STATUS: SecretsStatus = { agentUse: { deployment: true, user: false, effective: false }, providers: { vault: { status: 'not_configured', baseUrl: null } } };
const STORE: StoreStatus = { enabled: true, provider: 'vault', logins: 3, openToAgent: 1 };

function renderPage(responses: Record<string, unknown>, permissions = ['secrets:read', 'secrets:write']) {
  const host = createTestPlatformHost({ permissions, responses: { 'GET /secrets/status': STATUS, 'PATCH /user-settings': {}, ...responses } as never });
  render(
    <PlatformHostProvider host={host}>
      <MemoryRouter>
        <SecretsSettingsPage />
      </MemoryRouter>
    </PlatformHostProvider>,
  );
  return host;
}

afterEach(cleanup);

describe('Settings → Secrets', () => {
  it('offers both choices while the built-in store is on, with the counts, and chooses the built-in store', async () => {
    const host = renderPage({ 'GET /secrets/store/status': STORE });
    expect(await screen.findByRole('radio', { name: /Store in Hexactra/ })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /Connect Vault/ })).toBeChecked();
    expect(screen.getByText(/3 saved, 1 open to the agent/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('radio', { name: /Store in Hexactra/ }));
    await waitFor(() => expect(host.requests.find((r) => r.method === 'PATCH')).toMatchObject({ path: '/user-settings', body: { secrets: { provider: 'builtin' } } }));
  });

  it('shows the active built-in store with a link to the saved logins', async () => {
    renderPage({ 'GET /secrets/store/status': { ...STORE, provider: 'builtin' } });
    expect(await screen.findByRole('radio', { name: /Store in Hexactra/ })).toBeChecked();
    expect(screen.getByRole('link', { name: /My saved logins/ })).toHaveAttribute('href', '/secrets');
  });

  it('offers only Vault when the deployment did not switch the built-in store on (its route does not exist)', async () => {
    renderPage({});
    expect(await screen.findByRole('radio', { name: /Connect Vault/ })).toBeInTheDocument();
    expect(screen.queryByRole('radio', { name: /Store in Hexactra/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: /My saved logins/ })).not.toBeInTheDocument();
  });

  it('saves the owner’s switch, and says when the deployment has not switched agent use on', async () => {
    const host = renderPage({ 'GET /secrets/store/status': STORE, 'GET /secrets/status': { ...STATUS, agentUse: { deployment: false, user: false, effective: false } } });
    expect(await screen.findByText(/has not switched this on for the deployment/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('switch', { name: 'Let the agent use my saved logins' }));
    await waitFor(() => expect(host.requests.find((r) => r.method === 'PATCH')).toMatchObject({ body: { secrets: { agentUse: { enabled: true } } } }));
  });

  it('a viewer sees the choices but cannot change them', async () => {
    renderPage({ 'GET /secrets/store/status': STORE }, ['secrets:read']);
    expect(await screen.findByRole('radio', { name: /Store in Hexactra/ })).toBeDisabled();
    expect(screen.getByRole('switch', { name: 'Let the agent use my saved logins' })).toBeDisabled();
  });
});
