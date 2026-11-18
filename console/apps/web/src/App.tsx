import { APP_NAME } from '@app/shared';
import { Box, CircularProgress } from '@mui/material';
import { Fragment, Suspense, type ComponentType, type ReactNode } from 'react';
import { Navigate, Outlet, Route, Routes } from 'react-router-dom';
import { DoctorPage } from '@marinoscar/platform-web/doctor/ui';
import {
  AuthProvider,
  createIdentityApi,
  createOAuthServerApi,
  IdentityWebAdaptersProvider,
  OAuthServerStatusProvider,
  RequireAuth,
  RequirePermission,
  useOAuthServerFeature,
  useOrgsFeature,
  usePermissions,
} from '@marinoscar/platform-web/identity/headless';
import {
  ActivateDevicePage,
  AuthCallbackPage,
  ConnectedAppsPage,
  LoginPage,
  OAuthClientsPage,
  OAuthConsentPage,
  OAuthErrorPage,
  OrganizationPage,
  OrganizationsPage,
  UserTokensPage,
  UsersPage,
} from '@marinoscar/platform-web/identity/ui';
import { JobInsightsPage, JobsPage } from '@marinoscar/platform-web/jobs/ui';
import { registerSettingsFeature, useSettingsFeatures } from '@marinoscar/platform-web/settings/headless';
import { SettingsHub, type SettingsHubProps } from '@marinoscar/platform-web/settings/ui';
import { FactoryResetPage, OffboardOrganizationButton, UserDangerZonePage, factoryResetSettingsPage } from '@marinoscar/platform-web/user-data/ui';
import { ShellProviders, type ShellProvider } from '@marinoscar/platform-web/shell/headless';
import { AboutPage, InstallPrompt } from '@marinoscar/platform-web/host/ui';
import { ShellAppBar, ShellBottomNav, ShellLayout, ShellUserMenu } from '@marinoscar/platform-web/shell/ui';
import { UserTimeZoneSync } from '@marinoscar/platform-web/timezone/headless';
import type { ReactElement } from 'react';

import { api, platformApi } from './api';
import { ADMIN_SECTIONS } from './config/adminSections';
import { NAVIGATION, PHONE_NAVIGATION } from './config/navigation';
import { USER_SETTINGS_SECTIONS } from './config/userSettingsSections';
import { WebhooksPage } from '@marinoscar/platform-web/webhooks/ui';
import { AlertsPage } from '@marinoscar/platform-web/alerts/ui';

import { BrandLogo, BrandMark } from './components/BrandLogo';
import { InboxCountProvider } from './components/InboxCountProvider';
import { mcpScopeIcon } from './components/McpScopeIcon';
import { ALERTS_ENABLED, WEBHOOKS_ENABLED } from './config/userSettingsSections';
import { FabricConnectionPage } from './pages/FabricConnectionPage';
import { DesktopPage } from './pages/DesktopPage';
import { FleetPage } from './pages/FleetPage';
import { HomePage } from './pages/HomePage';
import { InboxPage } from './pages/InboxPage';
import { QuestionPage } from './pages/QuestionPage';
import { RunDetailPage } from './pages/RunDetailPage';
import { RunsPage } from './pages/RunsPage';
import { TaskCreatePage } from './pages/TaskCreatePage';
import { TaskDetailPage } from './pages/TaskDetailPage';
import { TaskEditPage } from './pages/TaskEditPage';
import { TasksPage } from './pages/TasksPage';
import { NotesPage } from './pages/NotesPage';
import { AgentPoliciesPage } from './pages/AgentPoliciesPage';
import { AgentPolicyEditorPage } from './pages/AgentPolicyEditorPage';
import { ModelTiersPage } from './pages/ModelTiersPage';
import { AgentCeilingsPage } from './pages/AgentCeilingsPage';
import { RunHistorySettingsPage } from './pages/RunHistorySettingsPage';
import { AiAppCeilingsPage } from './pages/AiAppCeilingsPage';
import { AiAppDetailPage } from './pages/AiAppDetailPage';
import { AiAppsPage } from './pages/AiAppsPage';
import { ConnectAiAppPage } from './pages/ConnectAiAppPage';
import { RunRetentionCeilingPage } from './pages/RunRetentionCeilingPage';
import { AgentPricingPage } from './pages/AgentPricingPage';
import { AppPlatformHost } from './platformHost';
import {
  beforeLogout,
  sliceAppBarActions,
  sliceBanners,
  sliceHostedProviders,
  slicePublicRoutes,
  sliceOverlays,
  sliceRoutes,
  sliceShellProviders,
  sliceUserMenuItems,
} from './slices/manifest';
import type { SliceRoute } from './slices/slice';
import { ConfirmProvider, ToastHost } from './ui';

// The `orgs` feature: the organization cards show only in multi-organization mode.
declare module '@marinoscar/platform-web/settings/headless' {
  interface SettingsFeatureRegistry {
    orgs: true;
  }
}
registerSettingsFeature('orgs', useOrgsFeature);
// The `oauthServer` feature (#459): the Connected apps card shows only while the
// OAuth server is on (it ships off; an administrator switches it on in OAuth clients).
registerSettingsFeature('oauthServer', useOAuthServerFeature);

const spinner = (
  <Box sx={{ display: 'grid', placeItems: 'center', minHeight: '60vh' }}>
    <CircularProgress aria-label="Loading" />
  </Box>
);

/** A route behind the permission its card declares (the same string the API enforces). */
function Gate({ permission, children }: { permission: string; children: ReactElement }) {
  return (
    <RequirePermission permission={permission} fallback={<Navigate to="/" replace />}>
      {children}
    </RequirePermission>
  );
}

/**
 * The providers around the signed-in shell, outermost first: the enabled
 * slices' (the notification inbox, the AI config the host's feature map reads),
 * then the platform host every packaged page reads, then the providers that
 * need the host (the Inbox count behind the navigation badge, the onboarding
 * fetch). Add yours to `src/slices/<id>.tsx`.
 */
const SHELL_PROVIDERS: readonly ShellProvider[] = [...sliceShellProviders, OAuthServerStatus, AppPlatformHost, InboxCountProvider, ...sliceHostedProviders];

/** One probe per signed-in user of whether the OAuth server is on (the `oauthServer` feature). */
function OAuthServerStatus({ children }: { children: ReactNode }) {
  return <OAuthServerStatusProvider api={oauthApi}>{children}</OAuthServerStatusProvider>;
}

/** The consent page's slots: an icon per MCP scope (a warning icon on the two high-risk ones). */
const CONSENT_SLOTS = { scopeIcon: mcpScopeIcon };

/** Renders each component of a shell slot (banners, overlays, top-bar actions). */
function Slot({ components }: { components: readonly ComponentType[] }) {
  return (
    <>
      {components.map((Component, index) => (
        <Component key={index} />
      ))}
    </>
  );
}

/** The platform shell: AppBar, navigation rail or bottom bar (by width), user menu, and what the enabled slices slot in. */
function AppShell() {
  return (
    <ShellLayout
      navigation={NAVIGATION}
      // The phone bar: Home, Inbox, Tasks, Runs; the rest is in the user menu.
      bottomNav={<ShellBottomNav navigation={PHONE_NAVIGATION} />}
      brand={<BrandLogo label={APP_NAME} />}
      appBar={
        <ShellAppBar
          navigation={NAVIGATION}
          brand={<BrandLogo label={APP_NAME} />}
          actions={<Slot components={sliceAppBarActions} />}
          userMenu={
            <ShellUserMenu
              navigation={NAVIGATION}
              items={(close) => sliceUserMenuItems.map((item, index) => <Fragment key={index}>{item(close)}</Fragment>)}
            />
          }
        />
      }
      banners={<Slot components={sliceBanners} />}
      overlays={
        <>
          <Slot components={sliceOverlays} />
          {/* The PWA install offer (Chrome and Edge fire beforeinstallprompt; it stays hidden once installed). */}
          <InstallPrompt appName={APP_NAME} icon={<BrandMark size={32} />} />
        </>
      }
    >
      {/* Slice pages are lazy: the shell stays mounted while one loads. */}
      {/* The one confirmation dialog every page's `useConfirm()` opens. */}
      <ConfirmProvider>
        <Suspense fallback={spinner}>
          <Outlet />
        </Suspense>
      </ConfirmProvider>
      {/* The one snackbar `toast()` fills ("Task created"); it outlives the page that raised it. */}
      <ToastHost />
    </ShellLayout>
  );
}

const shell = (
  <ShellProviders providers={SHELL_PROVIDERS}>
    <AppShell />
  </ShellProviders>
);

/** A slice's route behind the permission(s) its API route enforces. */
function guarded(route: SliceRoute): ReactElement {
  const { permission, element } = route;
  if (permission === undefined) return element;
  if (typeof permission === 'string') return <Gate permission={permission}>{element}</Gate>;
  return (
    <RequirePermission permissions={[...permission]} fallback={<Navigate to="/" replace />}>
      {element}
    </RequirePermission>
  );
}

/** The routes. Every settings page is reachable from a registry card (config/). */
export function AppRoutes() {
  return (
    <Routes>
      <Route path="/login" element={<LoginPage />} />
      <Route path="/auth/callback" element={<AuthCallbackPage />} />
      {/* Where the OAuth server sends a person it cannot send back to the client: no sign-in, no API call. */}
      <Route path="/oauth/error" element={<OAuthErrorPage />} />
      {/* Slice routes that need no sign-in (the sharing slice's public link page). */}
      {slicePublicRoutes.map((route) => (
        <Route key={route.path} path={`/${route.path}`} element={<Suspense fallback={spinner}>{route.element}</Suspense>} />
      ))}
      <Route element={<RequireAuth loading={spinner} />}>
        {/* Device activation (`hexactra login`, the Android app): signed in, full
            screen, outside the shell. Without it the catch-all sent /activate home. Its
            API client comes from IdentityWebAdaptersProvider below (no shell here). */}
        <Route path="activate" element={<ActivateDevicePage />} />
        {/* OAuth consent (#459: ChatGPT, Claude): signed in, full screen, outside the shell, like /activate. */}
        <Route path="oauth/consent" element={<OAuthConsentPage slots={CONSENT_SLOTS} />} />
        <Route element={shell}>
          <Route index element={<HomePage />} />
          <Route path="notes" element={<Gate permission="notes:read"><NotesPage /></Gate>} />
          <Route path="tasks" element={<Gate permission="tasks:read"><TasksPage /></Gate>} />
          <Route path="tasks/new" element={<Gate permission="tasks:write"><TaskCreatePage /></Gate>} />
          <Route path="tasks/:id/edit" element={<Gate permission="tasks:write"><TaskEditPage /></Gate>} />
          <Route path="tasks/:id" element={<Gate permission="tasks:read"><TaskDetailPage /></Gate>} />
          <Route path="inbox" element={<Gate permission="runs:read"><InboxPage /></Gate>} />
          <Route path="inbox/q/:id" element={<Gate permission="runs:read"><QuestionPage /></Gate>} />
          <Route path="runs" element={<Gate permission="runs:read"><RunsPage /></Gate>} />
          <Route path="runs/:id" element={<Gate permission="runs:read"><RunDetailPage /></Gate>} />
          <Route path="fleet" element={<Gate permission="fleet:read"><FleetPage /></Gate>} />
          <Route path="fleet/hosts/:id/desktop" element={<Gate permission="fleet:desktop"><DesktopPage /></Gate>} />
          <Route path="settings" element={<Hub sections={USER_SETTINGS_SECTIONS} hubKey="user-settings-hub" title="Settings" subtitle="Manage your account preferences." />} />
          <Route path="settings/tokens" element={<UserTokensPage />} />
          <Route path="settings/connected-apps" element={<ConnectedAppsPage />} />
          <Route path="admin/settings" element={<Hub sections={ADMIN_SECTIONS} hubKey="admin-settings-hub" title="Administration" subtitle="Users, background jobs and the health of this deployment." />} />
          <Route path="admin/settings/users" element={<Gate permission="users:read"><UsersPage /></Gate>} />
          <Route path="admin/settings/oauth-clients" element={<Gate permission="oauth_clients:read"><OAuthClientsPage /></Gate>} />
          <Route path="admin/settings/organization" element={<Gate permission="org_members:read"><OrganizationPage /></Gate>} />
          <Route
            path="admin/settings/organizations"
            element={
              <Gate permission="organizations:read">
                <OrganizationsPage
                  renderActions={(organization, { refresh }) => <OffboardOrganizationButton organization={organization} onCompleted={refresh} />}
                />
              </Gate>
            }
          />
          <Route path="admin/settings/jobs" element={<Gate permission="jobs:read"><JobsPage /></Gate>} />
          <Route path="admin/settings/jobs/insights" element={<Gate permission="jobs:read"><JobInsightsPage /></Gate>} />
          <Route path="admin/settings/doctor" element={<Gate permission="system_settings:read"><DoctorPage /></Gate>} />
          <Route path="admin/settings/about" element={<Gate permission="system_settings:read"><AboutPage /></Gate>} />
          <Route path="admin/settings/fabric" element={<Gate permission="fabric_config:read"><FabricConnectionPage /></Gate>} />
          {WEBHOOKS_ENABLED && <Route path="settings/webhooks" element={<Gate permission="webhooks:read"><WebhooksPage scope="user" /></Gate>} />}
          {WEBHOOKS_ENABLED && <Route path="admin/settings/webhooks" element={<Gate permission="system_webhooks:read"><WebhooksPage scope="system" /></Gate>} />}
          {ALERTS_ENABLED && <Route path="admin/settings/alerts" element={<Gate permission="alerts:read"><AlertsPage /></Gate>} />}
          {/* Agent policies (#407): the user's policies and model tiers; the deployment's tiers, ceilings and prices. */}
          <Route path="settings/agent-policies" element={<Gate permission="agent_policies:read"><AgentPoliciesPage /></Gate>} />
          <Route path="settings/agent-policies/new" element={<Gate permission="agent_policies:write"><AgentPolicyEditorPage /></Gate>} />
          <Route path="settings/agent-policies/:id" element={<Gate permission="agent_policies:read"><AgentPolicyEditorPage /></Gate>} />
          <Route path="settings/agent-model-tiers" element={<Gate permission="agent_policies:read"><ModelTiersPage scope="user" /></Gate>} />
          <Route path="admin/settings/agent-model-tiers" element={<Gate permission="system_settings:read"><ModelTiersPage scope="deployment" /></Gate>} />
          <Route path="admin/settings/agent-ceilings" element={<Gate permission="system_settings:read"><AgentCeilingsPage /></Gate>} />
          <Route path="admin/settings/agent-pricing" element={<Gate permission="system_settings:read"><AgentPricingPage /></Gate>} />
          <Route path="settings/run-history" element={<Gate permission="runs:delete"><RunHistorySettingsPage /></Gate>} />
          {/* Connected AI apps (#464): `connected_apps:read` is what /api/connected-apps enforces. */}
          <Route path="settings/ai-apps" element={<Gate permission="connected_apps:read"><AiAppsPage /></Gate>} />
          <Route path="settings/ai-apps/connect" element={<Gate permission="connected_apps:read"><ConnectAiAppPage /></Gate>} />
          <Route path="settings/ai-apps/:clientId" element={<Gate permission="connected_apps:read"><AiAppDetailPage /></Gate>} />
          <Route path="admin/settings/ai-app-limits" element={<Gate permission="system_settings:read"><AiAppCeilingsPage /></Gate>} />
          <Route path="admin/settings/run-history" element={<Gate permission="system_settings:read"><RunRetentionCeilingPage /></Gate>} />
          <Route path="settings/danger-zone" element={<UserDangerZonePage />} />
          <Route path="admin/settings/factory-reset" element={<Gate permission={factoryResetSettingsPage.card.permission!}><FactoryResetPage /></Gate>} />
          {/* The enabled optional slices' pages (packages/shared/slices.json; src/slices/). */}
          {sliceRoutes.map((route) => (
            <Route key={route.path} path={route.path} element={guarded(route)} />
          ))}
        </Route>
      </Route>
      <Route path="*" element={<Navigate to="/" replace />} />
    </Routes>
  );
}

/** Both hubs are one packaged component bound to a registry (the Settings UI Pattern). */
function Hub(props: Omit<SettingsHubProps, 'hasPermission' | 'features'>) {
  const { hasPermission } = usePermissions();
  return <SettingsHub {...props} features={useSettingsFeatures()} hasPermission={hasPermission} />;
}

/**
 * The identity pages' API client. Given to IdentityWebAdaptersProvider at the
 * root, so a page outside the shell (/activate) has it too: inside the shell the
 * platform host would provide it, outside it the page threw "no identity client".
 */
const identityApi = createIdentityApi(platformApi);
/** The OAuth pages' client, for the same reason (the consent page renders outside the shell). */
const oauthApi = createOAuthServerApi(platformApi);

export default function App() {
  return (
    <AuthProvider client={api} onBeforeLogout={beforeLogout}>
      {/* Every packaged time renders in the signed-in user's profile time zone (cleared on sign-out). */}
      <UserTimeZoneSync api={platformApi} />
      <IdentityWebAdaptersProvider adapters={{ appName: APP_NAME, api: identityApi, oauthApi }}>
        <AppRoutes />
      </IdentityWebAdaptersProvider>
    </AuthProvider>
  );
}
