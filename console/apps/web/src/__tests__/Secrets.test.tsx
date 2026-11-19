// The Secrets pages (E37.4, #593): the provider card in each state (not connected, deployment default, connected,
// needs reconnect, deployment off), connect and disconnect, the switches (the write switch starts a new consent),
// what the agent can reach, the Activity list (uses and refusals, no value), permissions, and the administrator page.
import { MenuList } from '@mui/material';
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestApiError, createTestPlatformHost, type TestApiRequest } from '@marinoscar/platform-web/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { AdminSecretsPage } from '../pages/AdminSecretsPage';
import { SecretsSettingsPage } from '../pages/SecretsSettingsPage';
import { SecretsMenuItem } from '../secrets/SecretsMenuItem';
import type { ActivityItem, SecretsStatus, VaultStatus } from '../secrets/api';
import { fieldsWords, outcomeWords, permissionWords, whatWords } from '../secrets/words';
import { ConfirmProvider } from '../ui';
import { mockViewport } from './matchMedia';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

const MARKER = 'MARKER-never-on-screen';

const VAULT: VaultStatus = {
  provider: 'vault',
  status: 'not_configured',
  configured: false,
  source: 'none',
  baseUrl: null,
  clientId: null,
  hasClientSecret: false,
  redirectUri: 'https://console.example.test/api/secrets/vault/callback',
  scopes: [],
  vaultUserId: null,
  agentAccess: 'unknown',
  connectedAt: null,
  lastUsedAt: null,
  lastSuccessAt: null,
  lastErrorCode: null,
  connecting: false,
};
const CONNECTED: VaultStatus = { ...VAULT, status: 'connected', configured: true, source: 'user', baseUrl: 'https://vault.example.test', clientId: 'hexactra', hasClientSecret: true, scopes: ['vault:items_read', 'vault:items_fill', 'offline_access'], vaultUserId: 'abcdef12-0000-4000-8000-000000000000', agentAccess: 'on', connectedAt: '2026-11-18T10:00:00.000Z', lastUsedAt: '2026-11-19T09:00:00.000Z', lastSuccessAt: '2026-11-19T09:00:00.000Z' };

const status = (vault: VaultStatus, use = { deployment: true, user: false }): SecretsStatus => ({ agentUse: { ...use, effective: use.deployment && use.user }, providers: { vault } });

const RUN = 'bbbbbbbb-2222-4222-8222-222222222222';
const ACTIVITY: ActivityItem[] = [
  { id: 'a1', at: '2026-11-19T09:00:00.000Z', event: 'release', runId: RUN, site: 'app.example.test', field: 'password', outcome: 'typed', refused: false, matches: null },
  { id: 'a2', at: '2026-11-19T08:59:00.000Z', event: 'release', runId: null, site: 'evil.example.test', field: 'password', outcome: 'origin_mismatch', refused: true, matches: null },
  { id: 'a3', at: '2026-11-19T08:58:00.000Z', event: 'lookup', runId: RUN, site: 'app.example.test', field: null, outcome: 'ok', refused: false, matches: 1 },
];

const WRITE = ['secrets:read', 'secrets:write', 'runs:read'];

function renderPage(responses: Record<string, unknown>, permissions: readonly string[] = WRITE, entry = '/settings/secrets') {
  const host = createTestPlatformHost({
    permissions,
    responses: { 'GET /secrets/activity': { items: [], providerActivityUrl: null }, 'GET /secrets/reach': { listing: 'per_origin', items: [] }, ...responses },
  });
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[entry]}>
          <Routes>
            <Route path="/settings/secrets" element={<SecretsSettingsPage />} />
            <Route path="/admin/settings/secrets" element={<AdminSecretsPage />} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  return host;
}

let restore: (() => void) | null = null;
const assign = vi.fn();
beforeEach(() => {
  restore = mockViewport(1440);
  Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign } });
});
afterEach(() => {
  restore?.();
  restore = null;
  assign.mockReset();
  cleanup();
});

describe('the words', () => {
  it('names the granted permissions and leaves out offline_access', () => {
    expect(permissionWords(['offline_access', 'vault:items_write', 'vault:items_read'])).toEqual(['Find your logins', 'Save and change logins']);
    expect(permissionWords([])).toEqual([]);
  });
  it('names the fields, the actions and the outcomes', () => {
    expect(fieldsWords(['username', 'password', 'one_time_code'])).toBe('username, password and code');
    expect(fieldsWords(['one_time_code'])).toBe('code');
    expect(whatWords({ event: 'release', field: 'one_time_code', matches: null })).toBe('Typed the code');
    expect(whatWords({ event: 'lookup', field: null, matches: 0 })).toBe('Looked for a saved login: none found');
    expect(outcomeWords('origin_mismatch')).toBe('Refused: the page was not the saved site');
    expect(outcomeWords('something_new')).toBe('Failed');
  });
});

describe('the provider card', () => {
  it('not connected: says what a provider is and asks for the Vault, then saves and starts the connection', async () => {
    const host = renderPage({ 'GET /secrets/status': status(VAULT), 'PUT /secrets/vault/client': status(VAULT), 'POST /secrets/vault/connect': { authorizeUrl: 'https://vault.example.test/oauth/authorize?x=1', expiresAt: '2026-11-19T10:00:00.000Z' } });
    expect(await screen.findByText('Connect a secrets provider')).toBeInTheDocument();
    expect(screen.getByText(/keeps your logins and one-time codes safe/)).toBeInTheDocument();
    const save = screen.getByRole('button', { name: 'Save and connect' });
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByLabelText(/Vault address/), { target: { value: 'https://vault.example.test' } });
    fireEvent.change(screen.getByLabelText(/Client ID/), { target: { value: 'hexactra' } });
    fireEvent.change(screen.getByLabelText(/Client secret/), { target: { value: 'the-client-secret' } });
    fireEvent.click(save);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://vault.example.test/oauth/authorize?x=1'));
    expect(host.requests.find((r) => r.method === 'PUT')).toMatchObject({ path: '/secrets/vault/client', body: { baseUrl: 'https://vault.example.test', clientId: 'hexactra', clientSecret: 'the-client-secret' } });
    expect(host.requests.find((r) => r.path === '/secrets/vault/connect')?.body).toEqual({ allowWrite: false, returnTo: '/settings/secrets' });
  });

  it('with an address set by the administrator: prefilled, one press on Connect Vault', async () => {
    const host = renderPage({
      'GET /secrets/status': status({ ...VAULT, status: 'disconnected', configured: true, source: 'deployment', baseUrl: 'https://vault.example.test', clientId: 'hexactra', hasClientSecret: true }),
      'POST /secrets/vault/connect': { authorizeUrl: 'https://vault.example.test/oauth/authorize', expiresAt: '2026-11-19T10:00:00.000Z' },
    });
    expect(await screen.findByTestId('vault-address')).toHaveTextContent('Vault at vault.example.test (set by your administrator)');
    expect(screen.queryByLabelText(/Client secret/)).not.toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Connect Vault' }));
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://vault.example.test/oauth/authorize'));
    expect(host.requests.some((r) => r.method === 'PUT')).toBe(false);
  });

  it('connected: the address, the permissions in words, last used', async () => {
    renderPage({ 'GET /secrets/status': status(CONNECTED) });
    expect(await screen.findByTestId('provider-state')).toHaveTextContent('Connected');
    expect(screen.getByTestId('vault-address')).toHaveTextContent('https://vault.example.test');
    expect(screen.getByText('Find your logins, Type them for you')).toBeInTheDocument();
    expect(screen.queryByText(/Save and change logins$/)).not.toBeInTheDocument();
    expect(screen.getByText('Your Vault account (abcdef12)')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Disconnect' })).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Reconnect' })).not.toBeInTheDocument();
  });

  it('connected with Vault\'s own agent access off: says so', async () => {
    renderPage({ 'GET /secrets/status': status({ ...CONNECTED, agentAccess: 'off' }) });
    expect(await screen.findByText(/Agent access is switched off in Vault/)).toBeInTheDocument();
  });

  it('needs reconnecting: a warning and Reconnect, which starts the flow again', async () => {
    const host = renderPage({ 'GET /secrets/status': status({ ...CONNECTED, status: 'needs_reconnect', lastErrorCode: 'UNAUTHORIZED' }), 'POST /secrets/vault/connect': { authorizeUrl: 'https://vault.example.test/oauth/authorize', expiresAt: 'x' } });
    expect(await screen.findByTestId('provider-state')).toHaveTextContent('Needs reconnecting');
    expect(screen.getByText(/no longer accepts the saved connection/)).toBeInTheDocument();
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect' }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(host.requests.find((r) => r.path === '/secrets/vault/connect')?.body).toEqual({ allowWrite: false, returnTo: '/settings/secrets' });
  });

  it('Disconnect asks first ("Runs will ask you to sign in again."), then disconnects', async () => {
    const host = renderPage({ 'GET /secrets/status': status(CONNECTED), 'POST /secrets/vault/disconnect': { revoked: true, status: status({ ...VAULT, status: 'disconnected', configured: true, source: 'user', baseUrl: 'https://vault.example.test', clientId: 'hexactra', hasClientSecret: true }) } });
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    const ask = await screen.findByRole('dialog', { name: 'Disconnect Vault?' });
    expect(within(ask).getByText('Runs will ask you to sign in again.')).toBeInTheDocument();
    fireEvent.click(within(ask).getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText('Vault is disconnected.')).toBeInTheDocument();
    expect(host.requests.find((r) => r.path === '/secrets/vault/disconnect')).toBeTruthy();
    expect(await screen.findByRole('button', { name: 'Connect Vault' })).toBeInTheDocument();
  });

  it('Cancel on the confirmation disconnects nothing', async () => {
    const host = renderPage({ 'GET /secrets/status': status(CONNECTED) });
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    fireEvent.click(within(await screen.findByRole('dialog', { name: 'Disconnect Vault?' })).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(host.requests.some((r) => r.method === 'POST')).toBe(false);
  });

  it('a disconnect Vault could not confirm tells the owner to remove the app there', async () => {
    renderPage({ 'GET /secrets/status': status(CONNECTED), 'POST /secrets/vault/disconnect': { revoked: false, status: status({ ...VAULT, status: 'disconnected' }) } });
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disconnect' }));
    expect(await screen.findByText(/Remove Hexactra in Vault under Connected apps/)).toBeInTheDocument();
  });

  it('coming back from Vault says what happened, once', async () => {
    renderPage({ 'GET /secrets/status': status(CONNECTED) }, WRITE, '/settings/secrets?vault=connected');
    expect(await screen.findByText('Vault is connected.')).toBeInTheDocument();
    cleanup();
    renderPage({ 'GET /secrets/status': status(VAULT) }, WRITE, '/settings/secrets?vault=denied');
    expect(await screen.findByText(/You did not approve the connection in Vault/)).toBeInTheDocument();
  });

  it('a viewer sees the page but cannot connect or change anything', async () => {
    renderPage({ 'GET /secrets/status': status(CONNECTED) }, ['secrets:read']);
    expect(await screen.findByTestId('provider-state')).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
    for (const sw of screen.getAllByRole('switch')) expect(sw).toBeDisabled();
  });
});

describe('the switches', () => {
  it('"Let the agent use saved logins" patches the user setting and announces it', async () => {
    const host = renderPage({ 'GET /secrets/status': status(CONNECTED), 'PATCH /user-settings': (r: TestApiRequest) => r.body });
    const sw = await screen.findByRole('switch', { name: 'Let the agent use saved logins' });
    expect(sw).not.toBeChecked();
    expect(sw).toHaveAccessibleDescription(/never sees the password or code/);
    fireEvent.click(sw);
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Let the agent use saved logins' })).toBeChecked());
    expect(host.requests.find((r) => r.method === 'PATCH')).toMatchObject({ path: '/user-settings', body: { secrets: { agentUse: { enabled: true } } } });
    expect(screen.getAllByRole('status').map((n) => n.textContent).join(' ')).toContain('The agent may use your saved logins.');
  });

  it('when the administrator has the deployment switch off: a notice, and the switch is disabled with the reason', async () => {
    renderPage({ 'GET /secrets/status': status(CONNECTED, { deployment: false, user: true }) });
    expect(await screen.findByTestId('deployment-off')).toHaveTextContent(/An administrator has turned off saved secrets/);
    const sw = screen.getByRole('switch', { name: 'Let the agent use saved logins' });
    expect(sw).toBeDisabled();
    expect(sw).toHaveAccessibleDescription('Turned off by an administrator for this deployment.');
  });

  it('"Let the agent save and change logins" starts a NEW consent with allowWrite', async () => {
    const host = renderPage({ 'GET /secrets/status': status(CONNECTED), 'POST /secrets/vault/connect': { authorizeUrl: 'https://vault.example.test/oauth/authorize?scope=write', expiresAt: 'x' } });
    const sw = await screen.findByRole('switch', { name: 'Let the agent save and change logins' });
    expect(sw).not.toBeChecked();
    fireEvent.click(sw);
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://vault.example.test/oauth/authorize?scope=write'));
    expect(host.requests.find((r) => r.path === '/secrets/vault/connect')?.body).toEqual({ allowWrite: true, returnTo: '/settings/secrets' });
  });

  it('with the write permission granted the switch is on; turning it off asks, then connects without it', async () => {
    const host = renderPage({
      'GET /secrets/status': status({ ...CONNECTED, scopes: [...CONNECTED.scopes, 'vault:items_write'] }),
      'POST /secrets/vault/connect': { authorizeUrl: 'https://vault.example.test/oauth/authorize?scope=read', expiresAt: 'x' },
    });
    const sw = await screen.findByRole('switch', { name: 'Let the agent save and change logins' });
    expect(sw).toBeChecked();
    expect(screen.getByText('Find your logins, Type them for you, Save and change logins')).toBeInTheDocument();
    fireEvent.click(sw);
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Continue' }));
    await waitFor(() => expect(assign).toHaveBeenCalled());
    expect(host.requests.find((r) => r.path === '/secrets/vault/connect')?.body).toMatchObject({ allowWrite: false });
  });

  it('the write switch needs a connected provider', async () => {
    renderPage({ 'GET /secrets/status': status(VAULT) });
    const sw = await screen.findByRole('switch', { name: 'Let the agent save and change logins' });
    expect(sw).toBeDisabled();
    expect(sw).toHaveAccessibleDescription('Connect your provider first.');
  });

  it('a failed change says so and leaves the switch where it was', async () => {
    renderPage({
      'GET /secrets/status': status(CONNECTED),
      'PATCH /user-settings': () => {
        throw createTestApiError(500, 'Could not save');
      },
    });
    fireEvent.click(await screen.findByRole('switch', { name: 'Let the agent use saved logins' }));
    expect(await screen.findByText('Could not save')).toBeInTheDocument();
    expect(screen.getByRole('switch', { name: 'Let the agent use saved logins' })).not.toBeChecked();
  });
});

describe('what the agent can reach and what it used', () => {
  const reach = { listing: 'per_origin', items: [{ site: 'app.example.test', fields: ['username', 'password', 'one_time_code'], uses: 3, lastUsedAt: '2026-11-19T09:00:00.000Z', lastRunId: RUN }] };

  it('lists the logins used so far with a link to manage them in Vault, and explains why it is not the full list', async () => {
    renderPage({ 'GET /secrets/status': status(CONNECTED), 'GET /secrets/reach': reach });
    const list = await screen.findByRole('list', { name: 'Logins used so far' });
    expect(within(list).getByText('app.example.test')).toBeInTheDocument();
    expect(within(list).getByText(/Typed: username, password and code · used 3 times/)).toBeInTheDocument();
    expect(within(list).getByRole('link', { name: 'Manage app.example.test in Vault' })).toHaveAttribute('href', 'https://vault.example.test');
    expect(screen.getByText(/Vault can look logins up only for the page on screen/)).toBeInTheDocument();
  });

  it('says so when nothing was used yet', async () => {
    renderPage({ 'GET /secrets/status': status(CONNECTED) });
    expect(await screen.findByText('The agent has not used a saved login yet.')).toBeInTheDocument();
    expect(screen.getByText('Nothing yet')).toBeInTheDocument();
  });

  it('Activity: uses and refusals in words, a link to the run, a link to the provider, never a value', async () => {
    renderPage({ 'GET /secrets/status': status(CONNECTED), 'GET /secrets/activity': { items: ACTIVITY, providerActivityUrl: 'https://vault.example.test/settings/agent-activity' } });
    const table = await screen.findByRole('table', { name: 'Saved login activity' });
    expect(within(table).getAllByRole('row')).toHaveLength(4);
    expect(within(table).getByText('Typed')).toBeInTheDocument();
    expect(within(table).getByText('Refused: the page was not the saved site')).toBeInTheDocument();
    expect(within(table).getByText('evil.example.test')).toBeInTheDocument();
    expect(within(table).getAllByText('Typed the password')).toHaveLength(2);
    expect(within(table).getByText('Looked for a saved login: 1 found')).toBeInTheDocument();
    expect(within(table).getAllByRole('link', { name: 'Open run' })[0]).toHaveAttribute('href', `/runs/${RUN}`);
    expect(screen.getByRole('link', { name: /See your provider’s own activity/ })).toHaveAttribute('href', 'https://vault.example.test/settings/agent-activity');
    expect(document.body.textContent).not.toContain(MARKER);
  });

  it('on a phone the activity is a stack of cards', async () => {
    restore?.();
    restore = mockViewport(390);
    renderPage({ 'GET /secrets/status': status(CONNECTED), 'GET /secrets/activity': { items: ACTIVITY, providerActivityUrl: null } });
    expect(await screen.findByTestId('activity-a2')).toHaveTextContent('Refused: the page was not the saved site');
    expect(screen.queryByRole('table')).not.toBeInTheDocument();
  });
});

describe('the avatar menu entry', () => {
  it('shows for secrets:read only', () => {
    const view = (permissions: string[]) => {
      const host = createTestPlatformHost({ permissions });
      render(
        <PlatformHostProvider host={host}>
          <MemoryRouter>
            <MenuList>
              <SecretsMenuItem onDone={() => undefined} />
            </MenuList>
          </MemoryRouter>
        </PlatformHostProvider>,
      );
    };
    view([]);
    expect(screen.queryByText('Secrets')).not.toBeInTheDocument();
    cleanup();
    view(['secrets:read']);
    expect(screen.getByRole('menuitem', { name: 'Secrets' })).toHaveAttribute('href', '/settings/secrets');
  });
});

describe('the administrator page', () => {
  const SUMMARY = { deploymentEnabled: false, usersConnected: 3, usersNeedingReconnect: 1, usesThisWeek: 12, refusalsThisWeek: 2 };
  const DEFAULT = { baseUrl: 'https://vault.example.test', clientId: 'hexactra', hasClientSecret: true, allowedHosts: [], redirectUri: 'https://console.example.test/api/secrets/vault/callback' };
  const ADMIN = ['system_settings:read', 'system_settings:write'];
  const responses = (over: Record<string, unknown> = {}) => ({ 'GET /system-settings': { version: 4, secrets: { agentUse: { enabled: false } } }, 'GET /secrets/admin/summary': SUMMARY, 'GET /secrets/vault/default-client': DEFAULT, ...over });

  it('shows the kill switch, the counts (no logins) and the default Vault', async () => {
    renderPage(responses(), ADMIN, '/admin/settings/secrets');
    const sw = await screen.findByRole('switch', { name: 'Let the agent use saved logins' });
    expect(sw).not.toBeChecked();
    expect(sw).toHaveAccessibleDescription(/Off by default/);
    expect(screen.getByTestId('count-Users connected')).toHaveTextContent('3');
    expect(screen.getByTestId('count-Fields typed this week')).toHaveTextContent('12');
    expect(screen.getByText(/You cannot see anyone’s logins, sites or what they typed/)).toBeInTheDocument();
    expect(await screen.findByLabelText('Vault address')).toHaveValue('https://vault.example.test');
    expect(screen.getByLabelText('Client ID')).toHaveValue('hexactra');
    expect(screen.getByText(/A secret is stored/)).toBeInTheDocument();
    expect(screen.getByText(DEFAULT.redirectUri)).toBeInTheDocument();
  });

  it('turning the kill switch on patches the system setting with the version it read', async () => {
    const host = renderPage(responses({ 'PATCH /system-settings': { version: 5, secrets: { agentUse: { enabled: true } } } }), ADMIN, '/admin/settings/secrets');
    fireEvent.click(await screen.findByRole('switch', { name: 'Let the agent use saved logins' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Let the agent use saved logins' })).toBeChecked());
    expect(host.requests.find((r) => r.method === 'PATCH')).toMatchObject({ path: '/system-settings', body: { secrets: { agentUse: { enabled: true } } }, ifMatch: '4' });
    expect(screen.getByText(/Saved secrets are on for this deployment/)).toBeInTheDocument();
  });

  it('saves and removes the default Vault; the secret is sent only when typed', async () => {
    const host = renderPage(responses({ 'PUT /secrets/vault/default-client': (r: TestApiRequest) => ({ ...DEFAULT, ...(r.body as object), hasClientSecret: true }), 'DELETE /secrets/vault/default-client': { ...DEFAULT, baseUrl: null, clientId: null, hasClientSecret: false } }), ADMIN, '/admin/settings/secrets');
    fireEvent.change(await screen.findByLabelText('Vault address'), { target: { value: 'https://vault2.example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save default' }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    expect(host.requests.find((r) => r.method === 'PUT')?.body).toEqual({ baseUrl: 'https://vault2.example.test', clientId: 'hexactra' });
    fireEvent.click(screen.getByRole('button', { name: 'Remove default' }));
    await waitFor(() => expect(screen.getByLabelText('Vault address')).toHaveValue(''));
    expect(host.requests.some((r) => r.method === 'DELETE')).toBe(true);
  });

  it('read-only without system_settings:write', async () => {
    renderPage(responses(), ['system_settings:read'], '/admin/settings/secrets');
    expect(await screen.findByRole('switch', { name: 'Let the agent use saved logins' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save default' })).not.toBeInTheDocument();
  });

  it('a conflicting save asks to reload', async () => {
    renderPage(
      responses({
        'PATCH /system-settings': () => {
          throw createTestApiError(409, 'conflict', 'VERSION_CONFLICT');
        },
      }),
      ADMIN,
      '/admin/settings/secrets',
    );
    fireEvent.click(await screen.findByRole('switch', { name: 'Let the agent use saved logins' }));
    expect(await screen.findByText(/The settings changed elsewhere/)).toBeInTheDocument();
  });
});
