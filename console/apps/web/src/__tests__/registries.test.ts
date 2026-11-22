import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { dangerZoneLastViolations } from '@marinoscar/platform-web/user-data/headless';

import { ADMIN_SECTIONS } from '../config/adminSections';
import { NAVIGATION, PHONE_BAR_KEYS, PHONE_NAVIGATION } from '../config/navigation';
import { USER_SETTINGS_SECTIONS } from '../config/userSettingsSections';
import { sliceRoutes } from '../slices/manifest';

// The Settings UI Pattern, as tests: every card is reachable (App.tsx has its
// route) and the app's own card declares the exact permission its API route
// enforces. The packaged cards are checked by the platform's own suites.
const read = (relative: string) => readFileSync(fileURLToPath(new URL(relative, import.meta.url)), 'utf8');
const appSource = read('../App.tsx');
// Every path the app routes: the core's literal routes in App.tsx and the enabled slices' (src/slices/<id>.tsx).
const routedPaths = new Set([...[...appSource.matchAll(/path="([^"]+)"/g)].map((match) => match[1]!), ...sliceRoutes.map((route) => route.path)]);
const cards = [...ADMIN_SECTIONS, ...USER_SETTINGS_SECTIONS].flatMap((section) => section.cards);

describe('settings registries', () => {
  it('give every card a unique path', () => {
    const paths = cards.map((card) => card.path);
    expect(paths.every(Boolean)).toBe(true);
    expect(new Set(paths).size).toBe(paths.length);
  });

  it.each(cards.map((card) => [card.path!]))('route %s exists (App.tsx or an enabled slice)', (path) => {
    expect(routedPaths.has(path.replace(/^\//, ''))).toBe(true);
  });

  it('keep the Danger Zone group last in both hubs', () => {
    expect(dangerZoneLastViolations(ADMIN_SECTIONS, '/admin/settings/factory-reset')).toEqual([]);
    expect(dangerZoneLastViolations(USER_SETTINGS_SECTIONS, '/settings/danger-zone')).toEqual([]);
  });

  it('gate the About card with the permission GET /api/admin/about enforces (the host slice default)', () => {
    const card = cards.find((c) => c.path === '/admin/settings/about');
    expect(card?.permission).toBe('system_settings:read');
    expect(appSource).toMatch(/path="admin\/settings\/about" element=\{<Gate permission="system_settings:read">/);
    // The API binds AboutModule without a `permission` override, so the slice's default applies.
    expect(read('../../../api/src/platform/about.config.ts')).not.toMatch(/permission\s*:/);
  });

  it('gate the notes card with the permission GET /api/notes enforces', () => {
    const controller = read('../../../api/src/notes/notes.controller.ts');
    const listRoute = /@Get\(\)\s*\n\s*@Auth\(\{ permissions: \['([^']+)'\] \}\)/.exec(controller);
    const card = cards.find((c) => c.path === '/notes');
    expect(listRoute?.[1]).toBe('notes:read');
    expect(card?.permission).toBe(listRoute?.[1]);
  });
});

// The shell's navigation (the rail, the bottom bar, the user menu) reaches the
// same routes, behind the same permissions, as the cards.
describe('shell navigation', () => {
  it.each(NAVIGATION.destinations.filter((d) => d.path !== '/').map((d) => [d.path]))('destination %s has a route', (path) => {
    expect(routedPaths.has(path.replace(/^\//, ''))).toBe(true);
  });

  it('gate the Fleet destination with the permission the fleet API enforces', () => {
    const destination = NAVIGATION.destinations.find((d) => d.key === 'fleet');
    expect(destination?.permission).toBe('fleet:read');
  });

  it('pins the phone bottom bar: Chat, Inbox, Overview, then Tasks and Runs under More, the first five destinations in that order', () => {
    // The shell draws at most four tabs; with more destinations it draws the first
    // three and "More", which lists the others. Chat is the home (#486, #713), so
    // Tasks and Runs are under "More".
    expect([...PHONE_BAR_KEYS]).toEqual(['chat', 'inbox', 'overview', 'tasks', 'runs']);
    expect(NAVIGATION.destinations.slice(0, 5).map((d) => d.key)).toEqual([...PHONE_BAR_KEYS]);
    expect(PHONE_NAVIGATION.destinations.map((d) => d.label)).toEqual(['Chat', 'Inbox', 'Overview', 'Tasks', 'Runs']);
    // Active state still resolves against every destination's routes.
    expect(PHONE_NAVIGATION.destinationRoutes).toBe(NAVIGATION.destinationRoutes);
  });

  it('keeps Fleet, Settings and Administration in the full table the user menu and the rail draw', () => {
    expect(NAVIGATION.destinations.slice(5).map((d) => d.key)).toEqual(['fleet', 'settings', 'console']);
  });

  it('mounts the phone bar and the Inbox count in the shell', () => {
    expect(appSource).toMatch(/bottomNav=\{<ShellBottomNav navigation=\{PHONE_NAVIGATION\} \/>\}/);
    expect(appSource).toMatch(/AppPlatformHost, InboxCountProvider,/);
  });
});

// The browser agent's cards (#407): the exact strings the API routes enforce,
// the AI-dependent ones behind the `ai` feature, appended as their own group
// so no existing card moves.
describe('browser agent cards', () => {
  const group = (sections: typeof ADMIN_SECTIONS) => sections.find((s) => s.label === 'Browser agent');
  const policiesController = read('../../../api/src/policies/policies.controller.ts');
  const approvalsController = read('../../../api/src/approvals/approval-rules.controller.ts');
  const secretsController = read('../../../api/src/secrets/secrets.controller.ts');
  const secretsActivityController = read('../../../api/src/secrets/secrets-activity.controller.ts');
  const connectionsController = read('../../../api/src/connections/connections.controller.ts');
  const connectionsAdminController = read('../../../api/src/connections/connections-admin.controller.ts');
  // The platform's system settings routes (GET /api/system-settings) and their permission ids.
  const settingsPermissions = readFileSync(join(__dirname, '..', '..', '..', '..', 'node_modules', '@marinoscar', 'platform-api', 'dist', 'settings', 'settings.permissions.js'), 'utf8');

  it('the user cards: Agent policies and Model tiers, behind what GET /api/agent-policies enforces', () => {
    const listRoute = /@Get\(\)\s*\n\s*@ApiDataResponse\([^)]*\)\)?\s*\n\s*@Auth\(\{ permissions: \['([^']+)'\] \}\)/.exec(policiesController);
    expect(listRoute?.[1]).toBe('agent_policies:read');
    const approvalsList = /@Get\(\)\s*\n\s*@ApiDataResponse\([^)]*\)\s*\n\s*@Auth\(\{ permissions: \['([^']+)'\] \}\)/.exec(approvalsController);
    expect(approvalsList?.[1]).toBe('approvals:read');
    const secretsStatus = /@Get\('status'\)\s*\n\s*@ApiDataResponse\([^)]*\)\s*\n\s*@Auth\(\{ permissions: \['([^']+)'\] \}\)/.exec(secretsController);
    expect(secretsStatus?.[1]).toBe('secrets:read');
    const connectionsList = /@Get\(\)\s*\n\s*@ApiDataResponse\([^)]*\)\)?\s*\n\s*@Auth\(\{ permissions: \['([^']+)'\] \}\)/.exec(connectionsController);
    expect(connectionsList?.[1]).toBe('connections:read');
    expect(group(USER_SETTINGS_SECTIONS)?.cards.map((c) => [c.path, c.permission, c.feature])).toEqual([
      ['/settings/agent-policies', listRoute![1], undefined],
      ['/settings/agent-model-tiers', 'agent_policies:read', 'ai'],
      // #422, appended.
      ['/settings/run-history', 'runs:delete', undefined],
      // #464, appended: what GET /api/connected-apps enforces.
      ['/settings/ai-apps', 'connected_apps:read', undefined],
      // #551, appended: what GET /api/memories enforces.
      ['/settings/memories', 'memories:read', undefined],
      // #554, appended: what GET /api/approval-rules enforces.
      ['/settings/approvals', approvalsList![1], undefined],
      // #593, appended: what GET /api/secrets/status enforces.
      ['/settings/secrets', secretsStatus![1], undefined],
      // E39.2 (#599), appended: what GET /api/connections enforces.
      ['/settings/connections', connectionsList![1], undefined],
      // E43.4 (#734), appended: what GET /api/usage/report enforces for the caller's own usage.
      ['/settings/usage', 'usage:read', undefined],
      // E43.5 (#735), appended: the user's own `agentPricing` in GET/PATCH /api/user-settings.
      ['/settings/model-prices', 'user_settings:read', undefined],
    ]);
  });

  it('the admin cards: model tiers (AI), ceilings and prices, behind what GET /api/system-settings enforces', () => {
    expect(settingsPermissions).toMatch(/SYSTEM_SETTINGS_READ: \{\s*id: 'system_settings:read'/);
    expect(group(ADMIN_SECTIONS)?.cards.map((c) => [c.title, c.path, c.permission, c.feature])).toEqual([
      ['Agent model tiers', '/admin/settings/agent-model-tiers', 'system_settings:read', 'ai'],
      ['Agent budget ceilings', '/admin/settings/agent-ceilings', 'system_settings:read', undefined],
      ['Model prices', '/admin/settings/agent-pricing', 'system_settings:read', undefined],
      // #422, appended.
      ['Run history limit', '/admin/settings/run-history', 'system_settings:read', undefined],
      // #464, appended; #465 made it "External AI apps" (same route, same permission).
      ['External AI apps', '/admin/settings/ai-app-limits', 'system_settings:read', undefined],
      // #593, appended: what GET /api/secrets/admin/summary enforces.
      ['Secrets', '/admin/settings/secrets', 'system_settings:read', undefined],
      // E39.2 (#599), appended: what GET /api/connections/admin/apps enforces.
      ['Connections', '/admin/settings/connections', 'system_settings:read', undefined],
      // E40.4 (#688), appended: the `questions` namespace of the system settings.
      ['Request history', '/admin/settings/request-history', 'system_settings:read', undefined],
      // E43.4 (#734), appended: what GET /api/usage/report?scope=all enforces.
      ['AI usage & cost', '/admin/settings/usage', 'ai_config:read', undefined],
      // E45.6 (#761), appended: the `recordings` namespace of the system settings.
      ['Run recordings', '/admin/settings/run-recordings', 'system_settings:read', undefined],
    ]);
    expect(/@Get\(\)\s*\n\s*@ApiDataResponse\([^)]*\)\)?\s*\n\s*@Auth\(\{ permissions: \['([^']+)'\] \}\)/.exec(connectionsAdminController)?.[1]).toBe('system_settings:read');
    expect(/@Get\('admin\/summary'\)\s*\n\s*@ApiDataResponse\([^)]*\)\s*\n\s*@Auth\(\{ permissions: \['([^']+)'\] \}\)/.exec(secretsActivityController)?.[1]).toBe('system_settings:read');
  });

  it('are appended: the existing groups keep their order and cards, the new group comes after them', () => {
    const adminLabels = ADMIN_SECTIONS.map((s) => s.label);
    expect(adminLabels.slice(0, 4)).toEqual(['General', 'Access', 'Operations', 'Browser agent']);
    expect(ADMIN_SECTIONS[0]!.cards[0]!.path).toBe('/admin/settings/fabric');
    const userLabels = USER_SETTINGS_SECTIONS.map((s) => s.label);
    const at = userLabels.indexOf('Browser agent');
    expect(userLabels.slice(0, 3)).toEqual(['Account', 'Security', 'Notes']);
    expect(at).toBeGreaterThan(userLabels.indexOf('Notes'));
    if (userLabels.includes('Integrations')) expect(at).toBe(userLabels.indexOf('Integrations') + 1);
    // No existing group gained one of the new cards.
    const newPaths = new Set(['/settings/agent-policies', '/settings/agent-model-tiers', '/settings/run-history', '/settings/ai-apps', '/admin/settings/agent-model-tiers', '/admin/settings/agent-ceilings', '/admin/settings/agent-pricing', '/admin/settings/run-history', '/admin/settings/ai-app-limits', '/settings/secrets', '/admin/settings/secrets']);
    for (const s of [...ADMIN_SECTIONS, ...USER_SETTINGS_SECTIONS].filter((x) => x.label !== 'Browser agent')) {
      for (const c of s.cards) expect(newPaths.has(c.path!), `${s.label}: ${c.path}`).toBe(false);
    }
  });

  it('Run history (#422): the card carries what the retention routes enforce, and its route is gated by it', () => {
    const controller = read('../../../api/src/tasks/run-retention.controller.ts');
    const enforced = [...controller.matchAll(/@Auth\(\{ permissions: \['([^']+)'\] \}\)/g)].map((m) => m[1]);
    expect(enforced).toEqual(['runs:delete', 'runs:delete', 'runs:delete']);
    const card = group(USER_SETTINGS_SECTIONS)?.cards.find((c) => c.path === '/settings/run-history');
    expect(card).toMatchObject({ title: 'Run history', description: 'How long finished runs are kept.', path: '/settings/run-history', permission: enforced[0] });
    expect(appSource).toMatch(/path="settings\/run-history" element=\{<Gate permission="runs:delete">/);
    expect(appSource).toMatch(/path="admin\/settings\/run-history" element=\{<Gate permission="system_settings:read">/);
  });

  it('route each page behind the card\'s permission (writes are gated in the pages)', () => {
    expect(appSource).toMatch(/path="settings\/agent-policies" element=\{<Gate permission="agent_policies:read">/);
    expect(appSource).toMatch(/path="settings\/agent-model-tiers" element=\{<Gate permission="agent_policies:read">/);
    expect(appSource).toMatch(/path="admin\/settings\/agent-model-tiers" element=\{<Gate permission="system_settings:read">/);
    expect(appSource).toMatch(/path="admin\/settings\/agent-ceilings" element=\{<Gate permission="system_settings:read">/);
    expect(appSource).toMatch(/path="admin\/settings\/agent-pricing" element=\{<Gate permission="system_settings:read">/);
    expect(appSource).toMatch(/path="settings\/secrets" element=\{<Gate permission="secrets:read">/);
    expect(appSource).toMatch(/path="admin\/settings\/secrets" element=\{<Gate permission="system_settings:read">/);
  });
});
