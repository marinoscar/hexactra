// Web search settings (E50.5, #975; E50.14 #984 made the user's page a section of Connections and tools): the user's block (status and reason, own key write-only, the switch, a test search) and the
// administrator's page (switches, limits, the deployment key, usage).
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost, type TestApiRequest } from '@marinoscar/platform-web/testing';

import { AdminWebSearchPage } from '../pages/AdminWebSearchPage';
import type { WebSearchProvider, WebSearchStatus } from '../webSearch/api';
import { WebSearchSection as WebSearchSettingsPage, webHref } from '../webSearch/WebSearchSection';
import { ConfirmProvider } from '../ui';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

const OFF: WebSearchStatus = { enabled: false, reason: 'no_key', provider: null, today: { calls: 0, limit: 300, remaining: 300 }, perRunLimit: 30 };
const ON: WebSearchStatus = { enabled: true, reason: null, provider: { id: 'brave', label: 'Brave Search', tier: 'user' }, today: { calls: 1, limit: 300, remaining: 299 }, perRunLimit: 30 };
const BRAVE: WebSearchProvider = { id: 'brave', label: 'Brave Search', needsKey: true, enabled: true, listed: true, keyTier: null, keys: { user: false, organization: false, system: false }, estimatedCostPerCallUsd: 0.005 };

function mount(node: React.ReactNode, permissions: string[], responses: Record<string, unknown>) {
  const host = createTestPlatformHost({ permissions, responses: responses as never });
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter>{node}</MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  return host;
}
const sent = (host: { requests: TestApiRequest[] }, method: string) => host.requests.filter((r) => r.method === method).map((r) => [r.path, r.body]);

describe('the user page', () => {
  it('says why search is off, saves the own key write-only and runs a test search', async () => {
    let status = OFF;
    const host = mount(<WebSearchSettingsPage />, ['web_search:read', 'web_search:write', 'connections:write'], {
      'GET /web-search/status': () => status,
      'GET /web-search/providers': [BRAVE],
      'GET /user-settings': {},
      'PUT /service-credentials/web_search/brave': () => {
        status = ON;
        return undefined;
      },
      'POST /web-search/search': { provider: 'brave', hits: [{ title: 'Widgets', url: 'https://docs.example.test/widgets', snippet: '' }], answer: null },
    });
    expect(await screen.findByText(/No key is set that your searches may use/)).toBeInTheDocument();
    expect(screen.getByText(/about \$0.005 a search \(estimate\)/)).toBeInTheDocument();
    const field = screen.getByLabelText('Your own Brave Search API key');
    expect(field).toHaveAttribute('type', 'password');
    fireEvent.change(field, { target: { value: 'BSAinventedkey000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }));
    await waitFor(() => expect(sent(host, 'PUT')).toEqual([['/service-credentials/web_search/brave', { value: 'BSAinventedkey000000' }]]));
    expect(await screen.findByText(/Brave Search answers, with your own key/)).toBeInTheDocument();
    expect(screen.getByLabelText('Your own Brave Search API key')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Search for'), { target: { value: 'example widgets' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    const link = await screen.findByRole('link', { name: 'Widgets' });
    expect(link).toHaveAttribute('href', 'https://docs.example.test/widgets');
    expect(link).toHaveAttribute('target', '_blank');
    expect(link).toHaveAttribute('rel', 'noopener noreferrer');
    expect(sent(host, 'POST')).toEqual([['/web-search/search', { query: 'example widgets', count: 5 }]]);
  });

  it('switches web search off for the user', async () => {
    const host = mount(<WebSearchSettingsPage />, ['web_search:read'], { 'GET /web-search/status': ON, 'GET /web-search/providers': [], 'GET /user-settings': {}, 'PATCH /user-settings': {} });
    fireEvent.click(await screen.findByRole('switch', { name: 'Let the agent search the web' }));
    await waitFor(() => expect(sent(host, 'PATCH')).toEqual([['/user-settings', { webSearch: { enabled: false } }]]));
    expect(screen.queryByRole('button', { name: 'Search' })).not.toBeInTheDocument(); // no web_search:write
  });
});

describe('the administrator page', () => {
  const settings = { enabled: true, providers: {}, order: ['brave'], shareDeploymentKey: true, allowUserKeys: true, limits: { perRun: 30, perUserPerDay: 300 }, installed: [{ id: 'brave', label: 'Brave Search', credential: 'api_key', hosts: ['api.search.brave.com'], defaultEstimatedCostPerCallUsd: 0.005 }] };

  it('saves a switch and the limits (empty is unlimited), sets the deployment key and shows the usage', async () => {
    const host = mount(<AdminWebSearchPage />, ['system_settings:read', 'system_settings:write'], {
      'GET /web-search/admin': settings,
      'PUT /web-search/admin': (r: TestApiRequest) => ({ ...settings, ...(r.body as object) }),
      'GET /web-search/admin/usage': [{ day: '2026-11-26', provider: 'brave', calls: 12, failures: 1, estimatedCostUsd: 0.055 }],
      'GET /service-credentials': [{ service: 'web_search', name: 'brave', tiers: { user: { set: false }, organization: { set: false }, system: { set: false } } }],
      'PUT /service-credentials/admin/web_search/brave': undefined,
    });
    fireEvent.click(await screen.findByRole('switch', { name: "Everyone may use the deployment's key" }));
    expect(await screen.findByText('Saved.')).toBeInTheDocument();
    fireEvent.change(screen.getByLabelText('Searches a user a day'), { target: { value: '' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limits' }));
    await waitFor(() => expect(sent(host, 'PUT').filter(([p]) => p === '/web-search/admin')).toEqual([['/web-search/admin', { shareDeploymentKey: false }], ['/web-search/admin', { limits: { perRun: 30, perUserPerDay: null } }]]));
    fireEvent.change(screen.getByLabelText("The deployment's Brave Search API key"), { target: { value: 'BSAinventedkey000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }));
    await waitFor(() => expect(sent(host, 'PUT').some(([p]) => p === '/service-credentials/admin/web_search/brave')).toBe(true));
    expect(screen.getByRole('table', { name: 'Web search usage' })).toHaveTextContent('2026-11-26brave121~$0.055');
  });
});

describe('E50.14: keys, Test, order, page reading and permissions', () => {
  const MARK = 'BSAkeyneverontheScreen';
  const SAVED: WebSearchProvider = { ...BRAVE, keys: { user: true, organization: false, system: false }, keyTier: 'user' };
  const CREDS = [{ service: 'web_search', name: 'brave', binding: 'credential_store', tiers: { user: { set: true, setAt: '2026-11-20T10:00:00.000Z' }, organization: { set: false }, system: { set: false } } }];

  it('a saved key is said in words with its date, never shown; the field is empty, a password field with no autofill', async () => {
    mount(<WebSearchSettingsPage />, ['web_search:read', 'connections:write'], { 'GET /web-search/status': { ...ON, secretKey: MARK }, 'GET /web-search/providers': [SAVED], 'GET /user-settings': {}, 'GET /service-credentials': CREDS });
    expect(await screen.findByTestId('key-saved')).toHaveTextContent(/^Key saved on Nov 20, 2026\. Type a new one to replace it\./);
    const field = screen.getByLabelText('Your own Brave Search API key');
    expect(field).toHaveValue('');
    expect(field).toHaveAttribute('type', 'password');
    expect(field).toHaveAttribute('autocomplete', 'new-password');
    expect(screen.getByText(/Kept in the console, encrypted, never shown again/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Remove' })).toBeInTheDocument();
    expect(document.body.textContent).not.toContain(MARK);
  });

  it('Test opens the panel for the provider that answers, and says a test makes one real search', async () => {
    mount(<WebSearchSettingsPage />, ['web_search:read', 'web_search:write'], { 'GET /web-search/status': ON, 'GET /web-search/providers': [BRAVE], 'GET /user-settings': {}, 'POST /web-search/diagnose?provider=brave': { id: 'r', target: { kind: 'search_provider', id: 'brave' }, trigger: 'owner', overall: 'pass', startedAt: '2026-11-26T10:00:00Z', finishedAt: '2026-11-26T10:00:01Z', stages: [{ id: 'live_query', status: 'pass', code: null, remedy: null, ms: 300, data: { hits: 1 } }] }, 'GET /web-search/diagnostics?limit=20': [] });
    fireEvent.click(await screen.findByRole('button', { name: 'Test' }));
    const dialog = await screen.findByRole('dialog', { name: 'Test of Brave Search' });
    expect(dialog).toHaveTextContent('A test makes one real search');
    fireEvent.click(await screen.findByRole('button', { name: /One real search/ }));
    expect(await screen.findByText('1 result')).toBeInTheDocument();
  });

  it('a search result that is not a web address is text, not a link', () => {
    expect(webHref('javascript:alert(1)')).toBeNull();
    expect(webHref('data:text/html,x')).toBeNull();
    expect(webHref('https://docs.example.test/a')).toBe('https://docs.example.test/a');
  });

  it('without the permissions there is no key to type, no Test and no search box', async () => {
    mount(<WebSearchSettingsPage />, ['web_search:read'], { 'GET /web-search/status': OFF, 'GET /web-search/providers': [BRAVE], 'GET /user-settings': {} });
    expect(await screen.findByLabelText('Your own Brave Search API key')).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Test' })).toBeNull();
    expect(screen.queryByLabelText('Search for')).toBeNull();
  });

  const settings2 = {
    enabled: true,
    providers: {},
    order: ['brave', 'other'],
    shareDeploymentKey: true,
    allowUserKeys: true,
    limits: { perRun: 30, perUserPerDay: 300, fetchPerRun: null },
    fetch: { enabled: true, blockedHosts: ['blocked.example.test'] },
    installed: [
      { id: 'brave', label: 'Brave Search', credential: 'api_key', hosts: ['api.search.brave.com'], defaultEstimatedCostPerCallUsd: 0.005 },
      { id: 'other', label: 'Other Search', credential: 'none', hosts: ['search.example.test'], defaultEstimatedCostPerCallUsd: null },
    ],
  };

  it('the administrator reorders providers with buttons, edits the estimate, sets page reading and tests a provider with the deployment key', async () => {
    const host = mount(<AdminWebSearchPage />, ['system_settings:read', 'system_settings:write'], {
      'GET /web-search/admin': settings2,
      'PUT /web-search/admin': (r: TestApiRequest) => ({ ...settings2, ...(r.body as object) }),
      'GET /web-search/admin/usage': [],
      'GET /service-credentials': [],
      'POST /web-search/admin/providers/other/diagnose': { id: 'r', target: { kind: 'search_provider', id: 'other' }, trigger: 'admin', overall: 'pass', startedAt: '2026-11-26T10:00:00Z', finishedAt: '2026-11-26T10:00:01Z', stages: [] },
      'GET /web-search/admin/providers/other/diagnostics': [],
    });
    expect(await screen.findByRole('button', { name: 'Move Brave Search up' })).toBeDisabled();
    fireEvent.click(screen.getByRole('button', { name: 'Move Other Search up' }));
    await waitFor(() => expect(sent(host, 'PUT')).toContainEqual(['/web-search/admin', { order: ['other', 'brave'] }]));
    const brave = within(screen.getByRole('region', { name: 'Brave Search' }));
    fireEvent.change(brave.getByLabelText('Estimated cost per search (USD)'), { target: { value: '0.004' } });
    fireEvent.click(brave.getByRole('button', { name: 'Save estimate' }));
    await waitFor(() => expect(sent(host, 'PUT')).toContainEqual(['/web-search/admin', { providers: { brave: { costPerCallUsd: 0.004 } } }]));
    fireEvent.change(screen.getByLabelText('Blocked hosts'), { target: { value: 'blocked.example.test\n*.Bad.example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save blocked hosts' }));
    await waitFor(() => expect(sent(host, 'PUT')).toContainEqual(['/web-search/admin', { fetch: { blockedHosts: ['blocked.example.test', '*.bad.example.test'] } }]));
    fireEvent.click(screen.getByRole('button', { name: 'Test Other Search' }));
    expect(await screen.findByRole('dialog', { name: 'Test of Other Search' })).toHaveTextContent("It uses the deployment's key only.");
    await waitFor(() => expect(host.requests.some((r) => r.path === '/web-search/admin/providers/other/diagnose')).toBe(true));
  });

  it('an administrator who may only read sees no Test, no order buttons and no save', async () => {
    mount(<AdminWebSearchPage />, ['system_settings:read'], { 'GET /web-search/admin': settings2, 'GET /web-search/admin/usage': [], 'GET /service-credentials': [] });
    expect(await screen.findByRole('switch', { name: 'Web search for this console' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: /^Test / })).toBeNull();
    expect(screen.queryByRole('button', { name: /^Move / })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Save limits' })).toBeNull();
    expect(screen.getByText('No searches yet.')).toBeInTheDocument();
  });
});
