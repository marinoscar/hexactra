// Web search settings (E50.5, #975): the user's page (status and reason, own key write-only, the switch, a test search) and the
// administrator's page (switches, limits, the deployment key, usage).
import { configure, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { vi } from 'vitest';
import { MemoryRouter } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost, type TestApiRequest } from '@marinoscar/platform-web/testing';

import { AdminWebSearchPage, WebSearchSettingsPage, type WebSearchProvider, type WebSearchStatus } from '../pages/WebSearchPages';
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
    expect(screen.getByText(/about \$5.00 per 1,000 searches \(estimate\)/)).toBeInTheDocument();
    const field = screen.getByLabelText('Your own Brave Search API key');
    expect(field).toHaveAttribute('type', 'password');
    fireEvent.change(field, { target: { value: 'BSAinventedkey000000' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save key' }));
    await waitFor(() => expect(sent(host, 'PUT')).toEqual([['/service-credentials/web_search/brave', { value: 'BSAinventedkey000000' }]]));
    expect(await screen.findByText(/Brave Search, with your own key/)).toBeInTheDocument();
    expect(screen.getByLabelText('Your own Brave Search API key')).toHaveValue('');
    fireEvent.change(screen.getByLabelText('Search for'), { target: { value: 'example widgets' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByText('Widgets — https://docs.example.test/widgets')).toBeInTheDocument();
    expect(sent(host, 'POST')).toEqual([['/web-search/search', { query: 'example widgets', count: 5 }]]);
  });

  it('switches web search off for the user', async () => {
    const host = mount(<WebSearchSettingsPage />, ['web_search:read'], { 'GET /web-search/status': ON, 'GET /web-search/providers': [], 'GET /user-settings': {}, 'PATCH /user-settings': {} });
    fireEvent.click(await screen.findByRole('switch', { name: 'Use web search in my runs and chats' }));
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

describe('OpenAI web search (E50.9): an answer-type provider through the AI settings', () => {
  const OPENAI: WebSearchProvider = { id: 'openai', label: 'OpenAI web search', credential: 'ai_service', needsKey: false, enabled: true, listed: true, keyTier: null, keys: { user: false, organization: false, system: false }, estimatedCostPerCallUsd: 0.01 };

  it('the user page says it uses the OpenAI key from AI settings, has no key field, and shows a test answer as text', async () => {
    mount(<WebSearchSettingsPage />, ['web_search:read', 'web_search:write', 'connections:write'], {
      'GET /web-search/status': { ...ON, provider: { id: 'openai', label: 'OpenAI web search', tier: null } },
      'GET /web-search/providers': [OPENAI],
      'GET /user-settings': {},
      'POST /web-search/search': { provider: 'openai', hits: [{ title: 'Rivertown', url: 'https://facts.example.test/rivertown', snippet: '' }], answer: { text: '<b>48,200</b> inhabitants.', citations: ['https://facts.example.test/rivertown'] } },
    });
    expect(await screen.findByText('Uses your OpenAI key from AI settings. No search key is needed.')).toBeInTheDocument();
    expect(screen.getByText(/under AI usage, feature "Web search"/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/OpenAI web search API key/)).toBeNull();
    fireEvent.change(screen.getByLabelText('Search for'), { target: { value: 'Rivertown population' } });
    fireEvent.click(screen.getByRole('button', { name: 'Search' }));
    expect(await screen.findByLabelText('Answer')).toHaveTextContent('<b>48,200</b> inhabitants.');
    expect(screen.getByText('Rivertown — https://facts.example.test/rivertown')).toBeInTheDocument();
  });

  it('the administrator page has no key field for it, saves its model, and says where the token cost is', async () => {
    const settings = { enabled: true, providers: {}, order: ['openai'], shareDeploymentKey: true, allowUserKeys: true, limits: { perRun: 30, perUserPerDay: 300 }, installed: [{ id: 'openai', label: 'OpenAI web search', credential: 'ai_service', hosts: ['api.openai.com'], defaultEstimatedCostPerCallUsd: 0.01 }] };
    const host = mount(<AdminWebSearchPage />, ['system_settings:read', 'system_settings:write'], {
      'GET /web-search/admin': settings,
      'PUT /web-search/admin': (r: TestApiRequest) => ({ ...settings, ...(r.body as object) }),
      'GET /web-search/admin/usage': [],
      'GET /service-credentials': [],
    });
    expect(await screen.findByText(/Not chosen: this provider is not used/)).toBeInTheDocument();
    expect(screen.queryByLabelText(/API key/)).toBeNull();
    expect(screen.getAllByText(/The cost shown is the search fee only/).length).toBeGreaterThan(0);
    fireEvent.change(screen.getByLabelText('Model for web search'), { target: { value: 'invented-search-model' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save model' }));
    await waitFor(() => expect(sent(host, 'PUT')).toEqual([['/web-search/admin', { providers: { openai: { model: 'invented-search-model' } } }]]));
  });
});
