// Identity details (E37.6, #595) in the web app: the sub-switch of saved logins on the task form and the reasons it is disabled,
// the Secrets page's read-only list and its consent switch, the run page's "Filled from your saved details" line, a task parameter
// taken from a saved detail, and an AI app's limit.
import { cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost } from '@marinoscar/platform-web/testing';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { UsedSavedIdentity } from '../components/UsedSavedIdentity';
import { SecretsSettingsPage } from '../pages/SecretsSettingsPage';
import { TaskCreatePage } from '../pages/TaskCreatePage';
import { hasIdentityScopes, identityReason } from '../secrets/useSavedLoginsAvailability';
import { fieldsWords, outcomeWords, permissionWords, whatWords } from '../secrets/words';
import type { IdentityListing, SecretsStatus, VaultStatus } from '../secrets/api';
import { cleanParameters, defaultMode, savedValueText } from '../taskParams/model';
import { ConfirmProvider, ToastHost, dismissToast } from '../ui';
import { POLICY_READS } from './policyFixtures';

vi.setConfig({ testTimeout: 30_000 });
configure({ asyncUtilTimeout: 5_000 });

const IDENTITY_SCOPES = ['vault:items_read', 'vault:items_fill', 'vault:identity_read', 'vault:identity_fill'];
const VAULT: VaultStatus = {
  provider: 'vault', status: 'connected', configured: true, source: 'user', baseUrl: 'https://vault.example.test', clientId: 'hexactra', hasClientSecret: true, redirectUri: 'x', scopes: ['vault:items_read', 'vault:items_fill'], vaultUserId: 'v1', agentAccess: 'on', connectedAt: null, lastUsedAt: null, lastSuccessAt: null, lastErrorCode: null, connecting: false,
};
const status = (scopes: string[] = VAULT.scopes): SecretsStatus => ({ agentUse: { deployment: true, user: true, effective: true }, providers: { vault: { ...VAULT, scopes } } });
const LISTING: IdentityListing = {
  available: true,
  reason: 'ok',
  manageUrl: 'https://vault.example.test',
  items: [{ name: 'Passport', fields: [{ label: 'Full name', sensitive: false }, { label: 'Date of birth', sensitive: true }, { label: 'ID number', sensitive: true }] }],
};
const NEW_ID = '44444444-4444-4444-8444-444444444444';
const PERMS = ['tasks:read', 'tasks:write', 'runs:write', 'agent_policies:read', 'secrets:read', 'secrets:write'];

afterEach(() => {
  dismissToast();
  cleanup();
});

describe('the words', () => {
  it('reads the grant, the fields and the outcomes of identity details in plain words', () => {
    expect(hasIdentityScopes(IDENTITY_SCOPES)).toBe(true);
    expect(hasIdentityScopes(['vault:identity_read'])).toBe(false);
    expect(identityReason(status())).toMatch(/Allow .Let the agent fill identity details. on the Secrets page first/);
    expect(identityReason(status(IDENTITY_SCOPES))).toBeNull();
    expect(identityReason(null)).toMatch(/could not be checked/);
    expect(permissionWords(IDENTITY_SCOPES)).toEqual(['Find your logins', 'Type them for you', 'See which identity details you saved', 'Fill them into forms for you']);
    expect(fieldsWords(['date_of_birth', 'id_number'])).toBe('date of birth and ID number');
    expect(whatWords({ event: 'release', field: 'id_number', matches: null, outcome: 'typed' })).toBe('Filled the ID number');
    expect(whatWords({ event: 'release', field: 'date_of_birth', matches: null, outcome: 'selected' })).toBe('Chose the date of birth');
    expect(whatWords({ event: 'release', field: 'password', matches: null, outcome: 'typed' })).toBe('Typed the password');
    expect(outcomeWords('selected')).toBe('Chosen');
    expect(outcomeWords('insecure_origin')).toMatch(/does not use https/);
  });
});

describe('the run page line', () => {
  it('lists the labels once each, and nothing else', () => {
    render(<UsedSavedIdentity details={[{ label: 'Date of birth', itemName: 'Passport', origin: 'https://forms.example.test' }, { label: 'ID number' }, { label: 'Date of birth' }]} />);
    expect(screen.getByTestId('used-saved-identity')).toHaveTextContent('Filled from your saved details: Date of birth, ID number');
    expect(screen.getByTestId('used-saved-identity').textContent).not.toMatch(/Passport|forms\.example/);
  });
  it('renders nothing for a run that filled none', () => {
    const { container } = render(<UsedSavedIdentity details={[]} />);
    expect(container).toBeEmptyDOMElement();
    cleanup();
    expect(render(<UsedSavedIdentity details={undefined} />).container).toBeEmptyDOMElement();
  });
});

describe('a parameter taken from a saved detail', () => {
  it('is its own mode, is worded, and is saved as { identity: { field } }', () => {
    const p = { key: 'id_number', label: 'ID number', type: 'text' as const, required: true, default: { identity: { field: 'id_number' } } };
    expect(defaultMode(p)).toBe('identity');
    expect(savedValueText(p)).toBe('From your saved details: ID number');
    expect(cleanParameters([p])[0]!.default).toEqual({ identity: { field: 'id_number' } });
    expect(cleanParameters([{ ...p, sensitive: true }])[0]!.default).toBeUndefined();
  });
});

function mountTaskForm(scopes: string[], over: Record<string, unknown> = {}) {
  const host = createTestPlatformHost({
    permissions: PERMS,
    responses: { ...POLICY_READS, 'GET /fleet/hosts': [], 'GET /secrets/status': status(scopes), 'GET /user-settings': {}, 'POST /tasks': { id: NEW_ID, name: 'Apply', goal: 'x', profile: 'default', hostFallback: true, allowedDomains: [], confirmRiskyActions: false, policyId: null }, ...over },
  });
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={['/tasks/new']}>
          <Routes>
            <Route path="/tasks/new" element={<TaskCreatePage />} />
            <Route path="/tasks/:id" element={<div>task page</div>} />
            <Route path="/tasks" element={<div>tasks list</div>} />
            <Route path="/settings/secrets" element={<div>secrets page</div>} />
          </Routes>
        </MemoryRouter>
        <ToastHost />
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  return host;
}

describe('the task form', () => {
  it('has the identity sub-switch under the saved-logins one: off, disabled with a reason until logins are on and the permissions granted', async () => {
    mountTaskForm(['vault:items_read', 'vault:items_fill']);
    await screen.findByRole('form', { name: 'New task' });
    const logins = () => screen.getByRole('switch', { name: 'Use my saved logins and details' });
    const identity = () => screen.getByRole('switch', { name: 'Also fill my saved identity details' });
    await waitFor(() => expect(logins()).toBeEnabled());
    // Logins off: the sub-switch says so.
    expect(identity()).toBeDisabled();
    expect(screen.getByTestId('saved-identity-help')).toHaveTextContent('Turn on saved logins first.');
    fireEvent.click(logins());
    // Logins on, but the provider's identity permissions were not granted.
    await waitFor(() => expect(screen.getByTestId('saved-identity-help')).toHaveTextContent(/Allow .Let the agent fill identity details. on the Secrets page first/));
    expect(identity()).toBeDisabled();
    expect(identity()).not.toBeChecked();
  });

  it('with the permissions: the sub-switch works, and the task is created with useSavedIdentity (and turning logins off turns it off)', async () => {
    const host = mountTaskForm(IDENTITY_SCOPES);
    await screen.findByRole('form', { name: 'New task' });
    fireEvent.change(screen.getByLabelText(/^Name/), { target: { value: 'Apply' } });
    fireEvent.change(screen.getByLabelText(/^Goal/), { target: { value: 'Apply for the card' } });
    const logins = () => screen.getByRole('switch', { name: 'Use my saved logins and details' });
    const identity = () => screen.getByRole('switch', { name: 'Also fill my saved identity details' });
    await waitFor(() => expect(logins()).toBeEnabled());
    fireEvent.click(logins());
    await waitFor(() => expect(identity()).toBeEnabled());
    expect(identity()).toHaveAccessibleDescription(/never sees the value/);
    fireEvent.click(identity());
    expect(identity()).toBeChecked();
    // Logins off again: identity cannot stay on without them.
    fireEvent.click(logins());
    await waitFor(() => expect(identity()).toBeDisabled());
    fireEvent.click(logins());
    fireEvent.click(identity());
    fireEvent.click(screen.getByRole('button', { name: 'Save' }));
    await screen.findByText('task page');
    expect(host.requests.find((r) => r.method === 'POST' && r.path === '/tasks')!.body).toMatchObject({ useSavedLogins: true, useSavedIdentity: true });
  });
});

function mountSecrets(scopes: string[], identity: IdentityListing, extra: Record<string, unknown> = {}) {
  const host = createTestPlatformHost({
    permissions: PERMS,
    responses: {
      'GET /secrets/status': status(scopes),
      'GET /secrets/activity': { items: [{ id: 'a1', at: new Date().toISOString(), event: 'release', runId: null, site: 'forms.example.test', loginName: null, field: 'date_of_birth', outcome: 'selected', refused: false, matches: null }], providerActivityUrl: null },
      'GET /secrets/reach': { listing: 'per_origin', items: [] },
      'GET /secrets/identity': identity,
      'GET /secrets/store/status': undefined,
      'GET /user-settings': {},
      ...extra,
    },
  });
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={['/settings/secrets']}>
          <Routes>
            <Route path="/settings/secrets" element={<SecretsSettingsPage />} />
          </Routes>
        </MemoryRouter>
        <ToastHost />
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  return host;
}

describe('the Secrets page', () => {
  it('lists identity items by name with field labels and which are sensitive, read-only, linking to the provider; never a value', async () => {
    mountSecrets(IDENTITY_SCOPES, LISTING);
    const section = await screen.findByTestId('identity-section');
    await waitFor(() => expect(within(section).getByText('Passport')).toBeInTheDocument());
    for (const chip of ['Full name', 'Date of birth · sensitive', 'ID number · sensitive']) expect(within(section).getByText(chip)).toBeInTheDocument();
    expect(within(section).getByRole('link', { name: /Manage Passport and its allowed sites in Vault/ })).toHaveAttribute('href', 'https://vault.example.test');
    // Read-only: no input, no edit control.
    expect(within(section).queryByRole('textbox')).toBeNull();
    expect(within(section).queryByRole('button')).toBeNull();
    // The activity row is in words.
    expect(await screen.findByText(/Chose the date of birth/)).toBeInTheDocument();
  });

  it.each([
    ['needs_scope', /Turn on .Let the agent fill identity details. above/],
    ['not_connected', /Connect your provider to see/],
    ['provider_off', /switched off in your provider/],
    ['switched_off', /Turn on .Let the agent use saved logins./],
  ] as const)('says why there is no list: %s', async (reason, text) => {
    mountSecrets(['vault:items_read', 'vault:items_fill'], { available: false, reason, items: [], manageUrl: null });
    const section = await screen.findByTestId('identity-section');
    await waitFor(() => expect(within(section).getByText(text)).toBeInTheDocument());
  });

  it('the identity switch starts a new consent with allowIdentity, keeping the write permission', async () => {
    const host = mountSecrets(['vault:items_read', 'vault:items_fill', 'vault:items_write'], { available: false, reason: 'needs_scope', items: [], manageUrl: null }, { 'POST /secrets/vault/connect': { authorizeUrl: 'https://vault.example.test/consent', expiresAt: 'x' } });
    const sw = await screen.findByRole('switch', { name: 'Let the agent fill identity details' });
    await waitFor(() => expect(sw).toBeEnabled());
    expect(sw).not.toBeChecked();
    const assign = vi.fn();
    Object.defineProperty(window, 'location', { configurable: true, value: { ...window.location, assign } });
    fireEvent.click(sw);
    await waitFor(() => expect(host.requests.find((r) => r.method === 'POST' && r.path === '/secrets/vault/connect')).toBeTruthy());
    expect(host.requests.find((r) => r.method === 'POST' && r.path === '/secrets/vault/connect')!.body).toEqual({ allowWrite: true, allowIdentity: true, returnTo: '/settings/secrets' });
    await waitFor(() => expect(assign).toHaveBeenCalledWith('https://vault.example.test/consent'));
  });

  it('shows the switch on when the permissions were granted', async () => {
    mountSecrets(IDENTITY_SCOPES, LISTING);
    const sw = await screen.findByRole('switch', { name: 'Let the agent fill identity details' });
    await waitFor(() => expect(sw).toBeChecked());
  });
});
