// "Keys of outside services" on the Secrets page (E50.3, #973): where each of the owner's keys is kept, Move here and Move to the
// console, Remove, the link to the service's own screen, the notes for a switched-off deployment and a Vault without the scope, and
// the Vault permission kept on a new consent. No value of a key is ever on the page.
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';
import { MemoryRouter } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { ServiceKeyView } from '../secrets/api';
import { ServiceKeysSection } from '../secrets/ServiceKeysSection';
import { permissionWords, whatWords } from '../secrets/words';
import { ConfirmProvider } from '../ui';

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 5_000 });
afterEach(cleanup);

const tiers = (set: boolean, setAt: string | null = null): ServiceKeyView['tiers'] => ({ user: { available: true, set, setAt }, organization: { available: false, set: false, setAt: null }, system: { available: true, set: false, setAt: null } });
const key = (over: Partial<ServiceKeyView> = {}): ServiceKeyView => ({
  service: 'web_search',
  name: 'brave',
  label: 'Brave Search API key',
  tier: 'user',
  tiers: tiers(true, '2026-11-20T10:00:00.000Z'),
  userBinding: 'credential_store',
  secretsProvider: { id: 'builtin', writable: true, releasesEnabled: true, ready: true },
  ...over,
});

function setup(keys: ServiceKeyView[], canWrite = true) {
  const host = createTestPlatformHost({
    permissions: ['secrets:read', 'secrets:write', 'connections:read', 'connections:write'],
    responses: { 'GET /service-credentials': keys, 'POST /service-credentials/web_search/brave/move': { binding: 'builtin', sourceRemoved: true }, 'DELETE /service-credentials/web_search/brave': null },
  });
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter>
          <ServiceKeysSection canWrite={canWrite} />
        </MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  return host;
}

describe('the keys of outside services', () => {
  it('lists a key in the console with Move here, Remove and the link to set it; Move here moves it into the built-in store', async () => {
    const host = setup([key()]);
    const section = await screen.findByTestId('service-keys');
    expect(within(section).getByRole('heading', { name: 'Keys of outside services' })).toBeInTheDocument();
    expect((await within(section).findAllByText('In the console')).length).toBeGreaterThan(0);
    expect(within(section).getAllByRole('link', { name: 'Change' })[0]).toHaveAttribute('href', '/settings/connections#web-search');
    fireEvent.click(within(section).getAllByRole('button', { name: 'Move here' })[0]!);
    await waitFor(() => expect(host.requests.find((r) => r.method === 'POST' && r.path === '/service-credentials/web_search/brave/move')).toBeTruthy());
    expect(host.requests.find((r) => r.path === '/service-credentials/web_search/brave/move')!.body).toEqual({ to: 'secrets_provider' });
    expect(await screen.findByText('Brave Search API key is now kept in the built-in store.')).toBeInTheDocument();
  });

  it('a key in the built-in store offers Move to the console', async () => {
    const host = setup([key({ userBinding: 'builtin' })]);
    expect((await screen.findAllByText('In the built-in store')).length).toBeGreaterThan(0);
    expect(screen.queryByRole('button', { name: 'Move here' })).not.toBeInTheDocument();
    fireEvent.click(screen.getAllByRole('button', { name: 'Move to the console' })[0]!);
    await waitFor(() => expect(host.requests.find((r) => r.method === 'POST' && r.path.endsWith('/move'))!.body).toEqual({ to: 'credential_store' }));
  });

  it('into a remote Vault asks the owner to add the key there first; without the scope, says how to give it', async () => {
    setup([key({ secretsProvider: { id: 'vault', writable: false, releasesEnabled: true, ready: false } })]);
    expect(await screen.findByTestId('service-keys-scope')).toHaveTextContent('Let Hexactra read your keys of outside services');
    expect(screen.queryByRole('button', { name: 'Move here' })).not.toBeInTheDocument();
    cleanup();
    setup([key({ secretsProvider: { id: 'vault', writable: false, releasesEnabled: true, ready: true } })]);
    fireEvent.click((await screen.findAllByRole('button', { name: 'Move here' }))[0]!);
    expect(await screen.findByText(/Hexactra cannot write into your Vault/)).toBeInTheDocument();
  });

  it('says when an administrator turned reading secrets off, and offers nothing to a viewer', async () => {
    setup([key({ secretsProvider: { id: 'builtin', writable: true, releasesEnabled: false, ready: true } })], false);
    expect(await screen.findByTestId('service-keys-off')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /Move|Remove/ })).not.toBeInTheDocument();
  });

  it('an unset key says so and links to set it; no outside service shows an empty state', async () => {
    setup([key({ tiers: tiers(false) })]);
    expect((await screen.findAllByText('Not set')).length).toBeGreaterThan(0);
    expect(screen.getAllByRole('link', { name: 'Set it' })[0]).toHaveAttribute('href', '/settings/connections#web-search');
    cleanup();
    setup([]);
    expect(await screen.findByText('No outside services yet')).toBeInTheDocument();
  });

  it('words: the Vault permission and the activity line of a release', () => {
    expect(permissionWords(['vault:service_keys_read'])).toEqual(['Read your keys of outside services for Hexactra’s calls to them']);
    expect(whatWords({ event: 'service_key', field: null, matches: null, purpose: 'service_call' })).toBe('Read a key of an outside service for a call to it');
  });
});
