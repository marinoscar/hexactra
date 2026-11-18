// Connected AI apps (#464): the "AI apps" list, an app's page (limits,
// pause, disconnect), the "Connect an AI app" guide and its preflight, and
// "Started by" on the runs list.
import { configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { MemoryRouter, Route, Routes, useLocation } from 'react-router-dom';
import { PlatformHostProvider } from '@marinoscar/platform-web/core';
import { createTestPlatformHost, type TestApiRequest } from '@marinoscar/platform-web/testing';
import type { ReactElement } from 'react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../live', () => ({ subscribeRun: () => () => undefined, fetchRunScreenshot: async () => null }));

import { draftErrors, draftPatch, toDraft, type AppLimits, type AppPreflight, type ConnectedApp } from '../aiApps/types';
import { applyStartedBy, startedByValue } from '../components/RunFilterControls';
import { RunList } from '../components/RunList';
import { RecentRunsBlock } from '../components/home/blocks';
import { NO_FILTERS, apiFilter, filtersFromParams, filtersToParams, matchesFilters } from '../components/runFilters';
import { StartedByChip, appDisplayName, startedBy } from '../components/StartedByChip';
import { CONNECT_GUIDES, stepsFor } from '../content/connect-ai-apps';
import { AiAppCeilingsPage } from '../pages/AiAppCeilingsPage';
import { AiAppDetailPage } from '../pages/AiAppDetailPage';
import { AiAppsPage } from '../pages/AiAppsPage';
import { ConnectAiAppPage } from '../pages/ConnectAiAppPage';
import type { RunListItem } from '../types/runs';
import { ConfirmProvider } from '../ui';
import { mockViewport } from './matchMedia';
import { BALANCED, ECONOMY } from './policyFixtures';

vi.setConfig({ testTimeout: 20_000 });
configure({ asyncUtilTimeout: 5_000 });

const CLIENT = 'aaaaaaaa-1111-4111-8111-111111111111';
const LIMITS: AppLimits = { policyId: null, allowedPolicyIds: [], allowedDomains: [], maxConcurrentRuns: 2, dailyRunLimit: 50, dailyCostLimitUsd: null, confirmPurchases: true, paused: false };
const APP: ConnectedApp = {
  clientId: CLIENT,
  grantId: 'bbbbbbbb-2222-4222-8222-222222222222',
  name: 'chatgpt.com',
  displayName: 'ChatGPT',
  selfName: 'ChatGPT',
  host: 'chatgpt.com',
  logoUri: null,
  verified: true,
  removed: false,
  connectedAt: '2026-11-01T10:00:00.000Z',
  lastUsedAt: '2026-11-17T10:00:00.000Z',
  scopes: [
    { id: 'runs:write', label: 'Delegate', consent: 'Give goals to your Hexactra agent, start and stop runs', risk: 'low' },
    { id: 'inbox:read', label: 'Inbox', consent: 'See questions your agent is waiting on', risk: 'low' },
    { id: 'inbox:write', label: 'Inbox', consent: 'Ask you questions and pass on answers', risk: 'low' },
    { id: 'browser:evaluate', label: 'JavaScript', consent: 'Run JavaScript in pages you are signed in to', risk: 'high' },
  ],
  limits: LIMITS,
  usage: { runs30d: 3, costUsd30d: 0.42, costKnown: true, lastRunAt: null, liveRuns: 0, runsToday: 1, costTodayUsd: 0.1 },
};
const PREFLIGHT_OK: AppPreflight = {
  mcpUrl: 'https://console.example.test/api/mcp',
  admin: false,
  ready: true,
  checks: [
    { id: 'oauth_enabled', status: 'pass', title: 'Sign-in for AI apps is on', detail: 'ok', fix: null },
    { id: 'public_url', status: 'pass', title: 'The console is on a public HTTPS address', detail: 'ok', fix: null },
    { id: 'well_known', status: 'pass', title: 'The sign-in documents answer from the internet', detail: 'ok', fix: null },
  ],
  clients: [
    { id: 'chatgpt', allowed: true, hosts: ['chatgpt.com'], detail: 'ChatGPT may connect.' },
    { id: 'claude', allowed: true, hosts: ['claude.ai'], detail: 'Claude may connect.' },
    { id: 'claude-code', allowed: true, hosts: ['loopback'], detail: 'ok' },
    { id: 'other', allowed: null, hosts: [], detail: 'ok' },
  ],
};

function Where() {
  const l = useLocation();
  return <div data-testid="where">{`${l.pathname}${l.search}`}</div>;
}

function renderAt(url: string, responses: Record<string, unknown>, permissions = ['connected_apps:read', 'connected_apps:write', 'runs:read', 'agent_policies:read']) {
  const host = createTestPlatformHost({ permissions, responses });
  const page = (el: ReactElement) => (
    <>
      {el}
      <Where />
    </>
  );
  render(
    <PlatformHostProvider host={host}>
      <ConfirmProvider>
        <MemoryRouter initialEntries={[url]}>
          <Routes>
            <Route path="/settings/ai-apps" element={page(<AiAppsPage />)} />
            <Route path="/settings/ai-apps/connect" element={page(<ConnectAiAppPage />)} />
            <Route path="/settings/ai-apps/:clientId" element={page(<AiAppDetailPage />)} />
            <Route path="/runs" element={page(<RunList showTaskColumn />)} />
          </Routes>
        </MemoryRouter>
      </ConfirmProvider>
    </PlatformHostProvider>,
  );
  return host;
}

let restore: (() => void) | null = null;
afterEach(() => {
  restore?.();
  restore = null;
});

const RUNS = { 'GET /runs': { items: [], nextCursor: null }, 'GET /runs/counts': { total: 0, live: 0, byStatus: { queued: 0, running: 0, waiting_human: 0, succeeded: 0, failed: 0, cancelled: 0 }, costUsd: null, costKnown: true } };
const POLICIES = { 'GET /agent-policies': [BALANCED, ECONOMY], 'GET /agent-policies/default': { policyId: BALANCED.id, explicit: false } };

describe('AI apps list', () => {
  it('lists apps: name, host, verified, scopes in words (high risk in warning), usage, and links to the guide', async () => {
    restore = mockViewport(1440);
    renderAt('/settings/ai-apps', { 'GET /connected-apps': [APP] });
    expect(await screen.findByText('ChatGPT')).toBeInTheDocument();
    expect(screen.getByTestId('app-verified')).toBeInTheDocument();
    const scopes = screen.getByTestId('app-scopes');
    // The two Inbox scopes show once; JavaScript is high risk.
    expect(within(scopes).getAllByText('Inbox')).toHaveLength(1);
    expect(within(scopes).getByLabelText('JavaScript (high risk)')).toHaveAttribute('data-risk', 'high');
    expect(screen.getByText('3 runs · $0.42')).toBeInTheDocument();
    expect(screen.getAllByRole('link', { name: /Connect an AI app/ })[0]).toHaveAttribute('href', '/settings/ai-apps/connect');
    expect(screen.getByRole('link', { name: 'Connected apps' })).toHaveAttribute('href', '/settings/connected-apps');
  });

  it('the Paused switch patches only `paused`', async () => {
    restore = mockViewport(1440);
    const host = renderAt('/settings/ai-apps', { 'GET /connected-apps': [APP], [`PATCH /connected-apps/${CLIENT}/settings`]: (r: TestApiRequest) => ({ ...LIMITS, ...(r.body as object) }) });
    fireEvent.click(await screen.findByRole('switch', { name: 'Pause ChatGPT' }));
    await waitFor(() => expect(screen.getByRole('switch', { name: 'Pause ChatGPT' })).toBeChecked());
    expect(host.requests.find((r) => r.method === 'PATCH')).toMatchObject({ path: `/connected-apps/${CLIENT}/settings`, body: { paused: true } });
  });

  it('without connected_apps:write there is no switch', async () => {
    restore = mockViewport(1440);
    renderAt('/settings/ai-apps', { 'GET /connected-apps': [{ ...APP, limits: { ...LIMITS, paused: true } }] }, ['connected_apps:read']);
    expect(await screen.findByText('ChatGPT')).toBeInTheDocument();
    expect(screen.queryByRole('switch')).not.toBeInTheDocument();
    expect(screen.getAllByText('Paused').length).toBeGreaterThan(0);
  });

  it('empty: "No AI apps are connected" with the guide button', async () => {
    renderAt('/settings/ai-apps', { 'GET /connected-apps': [] });
    expect(await screen.findByText('No AI apps are connected')).toBeInTheDocument();
    expect(within(screen.getByRole('status')).getByRole('link', { name: /Connect an AI app/ })).toHaveAttribute('href', '/settings/ai-apps/connect');
  });
});

describe('an AI app\'s page', () => {
  const responses = (over: Record<string, unknown> = {}) => ({
    [`GET /connected-apps/${CLIENT}`]: APP,
    [`PATCH /connected-apps/${CLIENT}/settings`]: (r: TestApiRequest) => ({ ...LIMITS, ...(r.body as object) }),
    [`DELETE /oauth/grants/${APP.grantId}`]: null,
    ...POLICIES,
    ...RUNS,
    ...over,
  });

  it('shows the consent text of each scope, the limits, and the app\'s runs (scoped by clientId)', async () => {
    restore = mockViewport(1440);
    const host = renderAt(`/settings/ai-apps/${CLIENT}`, responses());
    expect(await screen.findByRole('heading', { name: 'ChatGPT' })).toBeInTheDocument();
    expect(screen.getByText('Run JavaScript in pages you are signed in to')).toBeInTheDocument();
    expect(screen.getByRole('spinbutton', { name: 'Runs at once' })).toHaveValue(2);
    expect(screen.getByRole('spinbutton', { name: 'Runs per day' })).toHaveValue(50);
    await waitFor(() => expect(host.requests.some((r) => r.path.startsWith('/runs?') && r.path.includes(`clientId=${CLIENT}`))).toBe(true));
  });

  it('validates the form and saves only what changed', async () => {
    restore = mockViewport(1440);
    const host = renderAt(`/settings/ai-apps/${CLIENT}`, responses());
    const conc = await screen.findByRole('spinbutton', { name: 'Runs at once' });
    const save = screen.getByRole('button', { name: 'Save limits' });
    expect(save).toBeDisabled();
    fireEvent.change(conc, { target: { value: '0' } });
    expect(screen.getByText('From 1 to 20')).toBeInTheDocument();
    expect(save).toBeDisabled();
    fireEvent.change(screen.getByRole('textbox', { name: 'Spend per day' }), { target: { value: '1.234' } });
    expect(screen.getByText('At most two decimals')).toBeInTheDocument();
    fireEvent.change(conc, { target: { value: '3' } });
    fireEvent.change(screen.getByRole('textbox', { name: 'Spend per day' }), { target: { value: '2.5' } });
    fireEvent.click(screen.getByRole('switch', { name: /Always ask me before purchases/ }));
    expect(save).toBeEnabled();
    fireEvent.click(save);
    await screen.findByText('Limits saved.');
    expect(host.requests.find((r) => r.method === 'PATCH')!.body).toEqual({ maxConcurrentRuns: 3, dailyCostLimitUsd: 2.5, confirmPurchases: false });
  });

  it('Pause on the page', async () => {
    restore = mockViewport(1440);
    const host = renderAt(`/settings/ai-apps/${CLIENT}`, responses());
    fireEvent.click(await screen.findByRole('switch', { name: 'Paused' }));
    await screen.findByText(/Paused: it cannot start runs/);
    expect(host.requests.find((r) => r.method === 'PATCH')!.body).toEqual({ paused: true });
  });

  it('Disconnect asks first, then revokes the grant through the platform route', async () => {
    restore = mockViewport(1440);
    const host = renderAt(`/settings/ai-apps/${CLIENT}`, responses());
    fireEvent.click(await screen.findByRole('button', { name: 'Disconnect' }));
    const dialog = await screen.findByRole('dialog');
    expect(dialog).toHaveTextContent('Disconnect ChatGPT?');
    fireEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(host.requests.some((r) => r.method === 'DELETE')).toBe(false);
    fireEvent.click(screen.getByRole('button', { name: 'Disconnect' }));
    fireEvent.click(within(await screen.findByRole('dialog')).getByRole('button', { name: 'Disconnect' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent('/settings/ai-apps'));
    expect(host.requests.find((r) => r.method === 'DELETE')!.path).toBe(`/oauth/grants/${APP.grantId}`);
  });

  it('without connected_apps:write the controls are read-only and there is no Disconnect', async () => {
    restore = mockViewport(1440);
    renderAt(`/settings/ai-apps/${CLIENT}`, responses(), ['connected_apps:read', 'agent_policies:read']);
    expect(await screen.findByRole('spinbutton', { name: 'Runs at once' })).toBeDisabled();
    expect(screen.queryByRole('button', { name: 'Save limits' })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Disconnect' })).not.toBeInTheDocument();
  });
});

describe('Connect an AI app', () => {
  it('all good: the preflight passes, four tabs, the MCP URL to copy and the steps', async () => {
    renderAt('/settings/ai-apps/connect', { 'GET /connected-apps/preflight': PREFLIGHT_OK });
    expect(await screen.findByText('Your console is ready for AI apps')).toBeInTheDocument();
    expect(screen.getAllByRole('tab').map((t) => t.textContent)).toEqual(['ChatGPT', 'Claude', 'Claude Code', 'Other MCP client']);
    expect(screen.getAllByTestId('copy-value')[0]).toHaveTextContent('https://console.example.test/api/mcp');
    expect(screen.getByTestId('guide-chatgpt')).toHaveTextContent('paste https://console.example.test/api/mcp as the MCP server URL');
    fireEvent.click(screen.getByRole('tab', { name: 'Claude Code' }));
    expect(await screen.findByTestId('guide-claude-code')).toBeInTheDocument();
    expect(screen.getAllByTestId('copy-value')[1]).toHaveTextContent('claude mcp add --transport http hexactra https://console.example.test/api/mcp');
    expect(screen.getByTestId('where')).toHaveTextContent('?app=claude-code');
    fireEvent.click(screen.getByRole('tab', { name: 'Other MCP client' }));
    expect(await screen.findByRole('link', { name: 'Access tokens' })).toHaveAttribute('href', '/settings/tokens');
    expect(screen.getByRole('link', { name: 'Agent framework recipes' })).toHaveAttribute('href', expect.stringContaining('agent-frameworks.md'));
    fireEvent.click(screen.getByRole('tab', { name: 'Claude' }));
    expect(await screen.findByTestId('guide-claude')).toHaveTextContent('Add custom connector');
  });

  it('OAuth off, as a member: who fixes it is the administrator, with no link', async () => {
    const off: AppPreflight = {
      ...PREFLIGHT_OK,
      ready: false,
      checks: [
        { id: 'oauth_enabled', status: 'fail', title: 'Sign-in for AI apps is on', detail: 'The OAuth server is off.', fix: { who: 'admin', path: null, text: 'Ask your administrator to turn on the OAuth server in Administration → OAuth clients.' } },
        { ...PREFLIGHT_OK.checks[1]!, status: 'skip' },
        { ...PREFLIGHT_OK.checks[2]!, status: 'skip' },
      ],
      clients: PREFLIGHT_OK.clients.map((c) => ({ ...c, allowed: c.id === 'other' ? null : false, detail: 'Sign-in for AI apps is off.' })),
    };
    renderAt('/settings/ai-apps/connect', { 'GET /connected-apps/preflight': off });
    expect(await screen.findByText('Before you connect')).toBeInTheDocument();
    const row = screen.getByTestId('preflight-oauth_enabled');
    expect(row).toHaveAttribute('data-status', 'fail');
    expect(row).toHaveTextContent('Ask your administrator to turn on the OAuth server');
    expect(within(row).queryByRole('link')).not.toBeInTheDocument();
    expect(screen.getByTestId('client-blocked')).toHaveTextContent('Sign-in for AI apps is off.');
  });

  it('OAuth off, as an administrator: the fix links to the admin page', async () => {
    const off: AppPreflight = {
      ...PREFLIGHT_OK,
      admin: true,
      ready: false,
      checks: [{ id: 'oauth_enabled', status: 'fail', title: 'Sign-in for AI apps is on', detail: 'off', fix: { who: 'admin', path: '/admin/settings/oauth-clients', text: 'Turn on the OAuth server in Administration → OAuth clients.' } }],
    };
    renderAt('/settings/ai-apps/connect', { 'GET /connected-apps/preflight': off });
    expect(await screen.findByRole('link', { name: /Turn on the OAuth server/ })).toHaveAttribute('href', '/admin/settings/oauth-clients');
  });

  it('not public: the public URL check warns and says what to do', async () => {
    const priv: AppPreflight = {
      ...PREFLIGHT_OK,
      ready: false,
      checks: [
        PREFLIGHT_OK.checks[0]!,
        { id: 'public_url', status: 'warn', title: 'The console is on a public HTTPS address', detail: 'APP_URL is http://localhost:3535: hosted clients cannot reach it.', fix: { who: 'admin', path: null, text: 'Ask your administrator to serve the console on a public https:// address.' } },
        { ...PREFLIGHT_OK.checks[2]!, status: 'skip' },
      ],
    };
    renderAt('/settings/ai-apps/connect', { 'GET /connected-apps/preflight': priv });
    const row = await screen.findByTestId('preflight-public_url');
    expect(row).toHaveAttribute('data-status', 'warn');
    expect(row).toHaveTextContent('hosted clients cannot reach it');
    expect(screen.getByTestId('preflight-well_known')).toHaveAttribute('data-status', 'skip');
  });

  it('the steps of every client come from one file, with the URL filled in', () => {
    expect(CONNECT_GUIDES.map((g) => g.id)).toEqual(['chatgpt', 'claude', 'claude-code', 'other']);
    for (const g of CONNECT_GUIDES) expect(stepsFor(g, 'https://x.test/api/mcp').join(' ')).not.toContain('{url}');
  });
});

describe('Started by (#464)', () => {
  const base = { id: '00000000-0000-4000-8000-000000000001', taskId: null, taskName: null, status: 'succeeded', trigger: 'api', goal: 'Book a table', profile: 'default', result: null, error: null, cancelRequested: false, stepCount: 2, createdAt: '2026-11-17T10:00:00.000Z', finishedAt: '2026-11-17T10:01:00.000Z' } as RunListItem;

  it('reads an origin or an app', () => {
    expect(startedBy({ origin: 'web' }).label).toBe('Console');
    expect(startedBy({ origin: 'cli' }).label).toBe('CLI');
    expect(startedBy({ origin: 'schedule' }).label).toBe('Schedule');
    expect(startedBy({ origin: 'android' }).label).toBe('Android');
    expect(startedBy({ origin: 'mcp', client: { id: CLIENT, name: 'chatgpt.com', verified: true } })).toMatchObject({ label: 'ChatGPT', detail: 'chatgpt.com' });
    expect(startedBy({ origin: 'mcp', client: { id: null, name: 'Hermes Agent', verified: false } }).detail).toMatch(/unverified/);
    expect(startedBy({ origin: 'mcp', client: { id: CLIENT, name: 'claude.ai', verified: true } }, { removed: true }).detail).toMatch(/removed app/);
    expect(appDisplayName('claude.ai')).toBe('Claude');
    render(<StartedByChip run={{ origin: 'mcp', client: { id: null, name: 'Hermes Agent', verified: false } }} />);
    expect(screen.getByTestId('started-by')).toHaveTextContent('Hermes Agent?');
  });

  it('the filter lives in the URL and becomes origin or clientId on the API', () => {
    const f = filtersFromParams(new URLSearchParams(`origin=cli,web&app=${CLIENT}&x=1`));
    expect(f).toMatchObject({ origin: ['web', 'cli'], clientId: CLIENT });
    expect(filtersToParams(f).toString()).toContain(`app=${CLIENT}`);
    expect(apiFilter({ ...NO_FILTERS, origin: ['schedule'] }, {}, 'UTC')).toEqual({ origin: ['schedule'] });
    expect(apiFilter(NO_FILTERS, { clientId: CLIENT }, 'UTC')).toEqual({ clientId: CLIENT });
    expect(applyStartedBy(NO_FILTERS, `app:${CLIENT}`)).toMatchObject({ clientId: CLIENT, origin: [] });
    expect(applyStartedBy({ ...NO_FILTERS, clientId: CLIENT }, 'origin:cli')).toMatchObject({ clientId: null, origin: ['cli'] });
    expect(startedByValue({ origin: [], clientId: null })).toBe('');
    expect(matchesFilters({ ...base, origin: 'mcp', client: { id: CLIENT, name: 'x', verified: true } }, { ...NO_FILTERS, clientId: CLIENT }, {}, 'UTC')).toBe(true);
    expect(matchesFilters({ ...base, origin: 'web', client: null }, { ...NO_FILTERS, clientId: CLIENT }, {}, 'UTC')).toBe(false);
  });

  it('the runs list shows the chip and filters by an app', async () => {
    restore = mockViewport(1440);
    const host = renderAt(
      '/runs',
      {
        ...RUNS,
        'GET /runs': { items: [{ ...base, origin: 'mcp', client: { id: CLIENT, name: 'chatgpt.com', verified: true } }], nextCursor: null },
        'GET /tasks': [],
        'GET /connected-apps': [APP],
      },
      ['runs:read', 'runs:write', 'connected_apps:read'],
    );
    expect((await screen.findAllByTestId('started-by'))[0]).toHaveTextContent('ChatGPT');
    const select = screen.getByLabelText('Started by');
    fireEvent.mouseDown(select);
    fireEvent.click(await screen.findByRole('option', { name: 'ChatGPT' }));
    await waitFor(() => expect(screen.getByTestId('where')).toHaveTextContent(`app=${CLIENT}`));
    await waitFor(() => expect(host.requests.some((r) => r.path.startsWith('/runs?') && r.path.includes(`clientId=${CLIENT}`))).toBe(true));
    expect(screen.getByText('Started by: ChatGPT')).toBeInTheDocument();
  });
});

describe('Home recent runs (#464)', () => {
  it('shows who started a run that the console did not', () => {
    const row = { id: 'r1', taskId: null, taskName: null, goal: 'Book a table', status: 'succeeded' as const, trigger: 'api', createdAt: '2026-11-17T10:00:00.000Z', startedAt: null, finishedAt: '2026-11-17T10:01:00.000Z', stepCount: 2, stopReason: null, costUsd: null, costKnown: true, error: null };
    render(
      <MemoryRouter>
        <RecentRunsBlock recentRuns={{ items: [{ ...row, origin: 'mcp', client: { id: CLIENT, name: 'claude.ai', verified: true } }, { ...row, id: 'r2', origin: 'web', client: null }] }} />
      </MemoryRouter>,
    );
    const chips = screen.getAllByTestId('started-by');
    expect(chips).toHaveLength(1);
    expect(chips[0]).toHaveTextContent('Claude');
  });
});

describe('limits draft', () => {
  it('validates and diffs', () => {
    const d = toDraft(LIMITS);
    expect(draftErrors(d)).toEqual({});
    expect(draftErrors({ ...d, dailyRunLimit: '1001' }).dailyRunLimit).toBe('From 1 to 1,000');
    expect(draftErrors({ ...d, policyId: 'builtin:thorough', allowedPolicyIds: ['builtin:economy'] }).policyId).toMatch(/allowed/);
    expect(draftPatch({ ...d, dailyCostLimitUsd: '3', allowedDomains: ['shop.example.test'] }, LIMITS)).toEqual({ dailyCostLimitUsd: 3, allowedDomains: ['shop.example.test'] });
    expect(draftPatch(d, LIMITS)).toEqual({});
  });
});

describe('AI app limits (admin)', () => {
  it('reads the mcp ceilings and saves both with If-Match', async () => {
    const host = createTestPlatformHost({
      permissions: ['system_settings:read', 'system_settings:write'],
      responses: { 'GET /system-settings': { version: 7, mcp: { elicitation: true, maxConcurrentRunsPerApp: 3 } }, 'PATCH /system-settings': { version: 8 } },
    });
    render(
      <PlatformHostProvider host={host}>
        <MemoryRouter>
          <AiAppCeilingsPage />
        </MemoryRouter>
      </PlatformHostProvider>,
    );
    const conc = await screen.findByRole('spinbutton', { name: 'Runs at once per app' });
    expect(conc).toHaveValue(3);
    expect(screen.getByRole('spinbutton', { name: 'Runs per day per app' })).toHaveValue(200);
    fireEvent.change(conc, { target: { value: '25' } });
    expect(screen.getByText('From 1 to 20')).toBeInTheDocument();
    fireEvent.change(conc, { target: { value: '4' } });
    fireEvent.click(screen.getByRole('button', { name: 'Save limits' }));
    await screen.findByText(/Saved\./);
    expect(host.requests.find((r) => r.method === 'PATCH')).toMatchObject({ body: { mcp: { maxConcurrentRunsPerApp: 4, maxDailyRunsPerApp: 200 } } });
  });
});
