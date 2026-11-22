// The OAuth server's web side in the console (E33.1, #459): the consent and
// error routes render the platform pages from the REAL app root (only the
// sign-in gate and the network are stubbed), the consent page shows the
// console's scope titles with an icon each (never a warning icon: the
// platform marks high-risk scopes itself, #460), and both OAuth cards arrive through the spread identity
// sections with the platform's permission strings.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

import { render, screen } from '@testing-library/react';
import { MemoryRouter, Outlet } from 'react-router-dom';
import { vi } from 'vitest';

vi.mock('@marinoscar/platform-web/identity/headless', async (importOriginal) => ({
  ...(await importOriginal<object>()),
  RequireAuth: () => <Outlet />,
}));

import App from '../App';
import { MCP_SCOPE_ICONS, mcpScopeIcon } from '../components/McpScopeIcon';
import { ADMIN_SECTIONS } from '../config/adminSections';
import { USER_SETTINGS_SECTIONS } from '../config/userSettingsSections';

const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');

/** The API's scope ids, read from its source (the one registry: apps/api/src/mcp/mcp.scopes.ts). */
const API_SCOPE_IDS = (() => {
  const source = read('../../../api/src/mcp/mcp.scopes.ts');
  const list = /export const MCP_SCOPE_IDS = \[([^\]]+)\]/.exec(source)?.[1] ?? '';
  return [...list.matchAll(/'([^']+)'/g)].map((m) => m[1]!);
})();

/** The API's scope titles, in registry order. */
const API_SCOPE_TITLES = (() => {
  const source = read('../../../api/src/mcp/mcp.scopes.ts');
  return [...source.matchAll(/\n\s+id: '([a-z:_]+)',\n\s+title: '([^']+)'/g)].map((m) => ({ id: m[1]!, title: m[2]! }));
})();

const RISK: Record<string, 'low' | 'elevated' | 'high'> = {
  'browser:drive': 'elevated',
  'browser:evaluate': 'high',
  'desktop:control': 'high',
  'policies:write': 'high',
};

function consentRequest() {
  return {
    id: 'req-1',
    client: { name: 'Assistant X', host: 'assistant.example.test', logoUri: null, kind: 'cimd', firstSeenAt: new Date().toISOString(), isNewToDeployment: false },
    redirectHost: 'assistant.example.test',
    isLoopbackRedirect: false,
    resource: { id: 'mcp', name: 'Hexactra agent tools' },
    scopes: API_SCOPE_TITLES.map((s) => ({ id: s.id, title: s.title, description: `${s.title}.`, risk: RISK[s.id] ?? 'low', grantable: true, required: false, alreadyGranted: false })),
    offlineAccess: true,
    organizations: [],
    expiresAt: new Date(Date.now() + 600_000).toISOString(),
  };
}

function stubFetch() {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes('/api/oauth/requests/req-1')) return new Response(JSON.stringify({ data: consentRequest() }), { status: 200, headers: { 'content-type': 'application/json' } });
      return new Response('{}', { status: 401, headers: { 'content-type': 'application/json' } });
    }),
  );
}

describe('OAuth routes (#459)', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('/oauth/consent renders the platform consent page with the console scopes and their icons', async () => {
    stubFetch();
    render(
      <MemoryRouter initialEntries={['/oauth/consent?request=req-1']}>
        <App />
      </MemoryRouter>,
    );
    // The client's host leads.
    expect((await screen.findAllByText(/assistant\.example\.test/, {}, { timeout: 8000 })).length).toBeGreaterThan(0);
    for (const s of API_SCOPE_TITLES) expect(screen.getByText(s.title)).toBeInTheDocument();
    for (const id of API_SCOPE_IDS) expect(screen.getByTestId(`scope-icon-${id}`)).toBeInTheDocument();
    // The console's icons say what a scope is about; the platform adds its own warning to high-risk scopes,
    // so none of the console's icons is a warning one (it would show twice).
    for (const id of API_SCOPE_IDS) expect(screen.getByTestId(`scope-icon-${id}`).getAttribute('class')).not.toMatch(/colorWarning/);
  }, 15_000);

  it('/oauth/error renders the public error page, echoing nothing from the query', async () => {
    stubFetch();
    const { container } = render(
      <MemoryRouter initialEntries={['/oauth/error?code=client_not_allowed&host=evil.example.test%3Cscript%3E']}>
        <App />
      </MemoryRouter>,
    );
    expect(await screen.findByRole('heading')).toBeInTheDocument();
    expect(container.textContent).not.toMatch(/<script>/);
  });
});

describe('the consent page scope icons', () => {
  it('cover exactly the scopes the API registers', () => {
    // The ten scopes of E33, plus procedures:read and procedures:run (E46.22).
    expect(API_SCOPE_IDS).toHaveLength(12);
    expect(Object.keys(MCP_SCOPE_ICONS).sort()).toEqual([...API_SCOPE_IDS].sort());
    expect(API_SCOPE_TITLES.map((s) => s.id)).toEqual(API_SCOPE_IDS);
  });

  it('are never warning icons, are distinct per scope, and an unknown scope gets none', () => {
    const icons = Object.values(MCP_SCOPE_ICONS).map((v) => v.Icon);
    expect(new Set(icons).size).toBe(icons.length);
    for (const [id, node] of Object.keys(MCP_SCOPE_ICONS).map((k) => [k, mcpScopeIcon(k)] as const)) {
      expect([id, (node as { props: { color: string } }).props.color]).toEqual([id, 'action']);
    }
    expect(mcpScopeIcon('offline_access')).toBeNull();
  });
});

describe('OAuth settings cards (#459)', () => {
  const admin = ADMIN_SECTIONS.flatMap((s) => s.cards);
  const user = USER_SETTINGS_SECTIONS.flatMap((s) => s.cards);

  it('"OAuth clients" is in the admin hub, appended last to Access, with oauth_clients:read and no feature', () => {
    const access = ADMIN_SECTIONS.find((s) => s.label === 'Access')!;
    const card = admin.find((c) => c.path === '/admin/settings/oauth-clients');
    expect(card).toMatchObject({ permission: 'oauth_clients:read' });
    expect(card?.feature).toBeUndefined();
    expect(access.cards.at(-1)?.path).toBe('/admin/settings/oauth-clients');
  });

  it('"Connected apps" is in the user hub, appended to Security after the identity cards, behind the oauthServer feature and no permission', () => {
    const security = USER_SETTINGS_SECTIONS.find((s) => s.label === 'Security')!;
    const card = user.find((c) => c.path === '/settings/connected-apps');
    expect(card).toMatchObject({ feature: 'oauthServer' });
    expect(card?.permission).toBeUndefined();
    // The core's Security cards end with it; the enabled slices append theirs after (the AI keys card).
    const paths = security.cards.map((c) => c.path);
    expect(paths.indexOf('/settings/connected-apps')).toBeGreaterThan(paths.indexOf('/settings/tokens'));
  });

  it('routes both pages: the OAuth clients page behind the permission its API enforces', () => {
    const app = read('../App.tsx');
    expect(app).toMatch(/path="admin\/settings\/oauth-clients" element=\{<Gate permission="oauth_clients:read"><OAuthClientsPage \/><\/Gate>\}/);
    expect(app).toMatch(/path="settings\/connected-apps" element=\{<ConnectedAppsPage \/>\}/);
    expect(app).toMatch(/registerSettingsFeature\('oauthServer', useOAuthServerFeature\)/);
  });
});

describe('the dev server well-known mapping (#459)', () => {
  it('proxies the two OAuth documents to the API and leaves other paths alone', async () => {
    const { isOpenIdConfigurationPath, wellKnownApiPath, wellKnownProxy } = await import('../../build-config/oauth-well-known');
    expect(wellKnownApiPath('/.well-known/oauth-protected-resource/api/mcp')).toBe('/api/oauth/.well-known/protected-resource/api/mcp');
    expect(wellKnownApiPath('/.well-known/oauth-authorization-server')).toBe('/api/oauth/.well-known/authorization-server');
    expect(wellKnownApiPath('/.well-known/assetlinks.json')).toBeNull();
    expect(isOpenIdConfigurationPath('/.well-known/openid-configuration')).toBe(true);
    expect(Object.keys(wellKnownProxy('http://localhost:3000')).sort()).toEqual(['/.well-known/oauth-authorization-server', '/.well-known/oauth-protected-resource']);
    expect(read('../../vite.config.ts')).toMatch(/\.\.\.wellKnownProxy\(API_PROXY_TARGET\)/);
  });
});
