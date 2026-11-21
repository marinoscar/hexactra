import InsightsOutlinedIcon from '@mui/icons-material/InsightsOutlined';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import AutoDeleteOutlinedIcon from '@mui/icons-material/AutoDeleteOutlined';
import { alertsAdminCards } from '@marinoscar/platform-web/alerts/ui';
import { doctorSettingsPage } from '@marinoscar/platform-web/doctor/ui';
import { identityAdminSections } from '@marinoscar/platform-web/identity/ui';
import { jobsAdminSections } from '@marinoscar/platform-web/jobs/ui';
import type { SettingsSectionDef } from '@marinoscar/platform-web/settings/ui';
import { DANGER_ZONE_GROUP_LABEL } from '@marinoscar/platform-web/user-data/headless';
import { factoryResetSettingsPage } from '@marinoscar/platform-web/user-data/ui';
import { webhooksAdminSections } from '@marinoscar/platform-web/webhooks/ui';

import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import LinkOutlinedIcon from '@mui/icons-material/LinkOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import LayersOutlinedIcon from '@mui/icons-material/LayersOutlined';
import PaidOutlinedIcon from '@mui/icons-material/PaidOutlined';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import SpeedOutlinedIcon from '@mui/icons-material/SpeedOutlined';

import { composeSections } from '../slices/sections';
import { sliceAdminCards } from '../slices/manifest';
import { ALERTS_ENABLED, BROWSER_AGENT_GROUP, WEBHOOKS_ENABLED } from './userSettingsSections';

/**
 * The core's admin groups. `General` is empty on purpose: the optional slices
 * (`packages/shared/slices.json`) append their cards to it and to
 * `Operations`, and add their own groups (AI) before the Danger Zone.
 */
const CORE_ADMIN_SECTIONS: SettingsSectionDef[] = [
  {
    label: 'General',
    cards: [
      {
        title: 'Fabric connection',
        description: 'The Hexactra Fabric control plane that runs the browsers: its URL and service token.',
        Icon: HubOutlinedIcon,
        path: '/admin/settings/fabric',
        permission: 'fabric_config:read',
      },
    ],
  },
  // `OAuth clients` (#459: the OAuth server ChatGPT and Claude sign in through) is appended last; the server ships off at run time.
  { label: 'Access', cards: [...identityAdminSections.access, ...identityAdminSections.organizations, ...identityAdminSections.oauthClients] },
  {
    label: 'Operations',
    cards: [
      // The fleet page needs the nodes control plane, which the starter does not mount.
      ...jobsAdminSections.operations.filter((card) => card.path !== '/admin/settings/workers'),
      { ...doctorSettingsPage.card, Icon: doctorSettingsPage.Icon },
      ...(WEBHOOKS_ENABLED ? webhooksAdminSections.operations : []),
      // Alerts: rules (browser host offline, schedule failing, run budget, …) and incidents.
      // `alerts:read` is what every read route of `/api/admin/alerts` enforces; writes are gated in the page.
      ...(ALERTS_ENABLED ? alertsAdminCards : []),
      // What is deployed here: versions, the deploy record, the database and the fabric.
      // `system_settings:read` is what the host slice's `GET /api/admin/about` enforces.
      {
        title: 'About',
        description: 'What is deployed here: versions, the last deploy and its history, the database and the Fabric.',
        Icon: InfoOutlinedIcon,
        path: '/admin/settings/about',
        permission: 'system_settings:read',
      },
    ],
  },
  // The browser agent (epic #398): the deployment's model tiers, budget ceilings and model prices.
  // Each is a namespace of the system settings document: `system_settings:read` is what
  // `GET /api/system-settings` enforces; saving (`:write`) is gated in the pages.
  {
    label: BROWSER_AGENT_GROUP,
    cards: [
      {
        title: 'Agent model tiers',
        description: 'The deployment default for the Fast, Standard and Frontier tiers: model, reasoning effort, output cap and fallback.',
        Icon: LayersOutlinedIcon,
        path: '/admin/settings/agent-model-tiers',
        permission: 'system_settings:read',
        feature: 'ai',
      },
      {
        title: 'Agent budget ceilings',
        description: 'The most any run may spend on this deployment, whatever its policy says, including Unlimited policies.',
        Icon: SpeedOutlinedIcon,
        path: '/admin/settings/agent-ceilings',
        permission: 'system_settings:read',
      },
      {
        title: 'Model prices',
        description: 'What each model costs per million tokens, for run cost, cost budgets and the AI usage report.',
        Icon: PaidOutlinedIcon,
        path: '/admin/settings/agent-pricing',
        permission: 'system_settings:read',
      },
      // AI usage and cost for everyone (#734): `ai_config:read` is what GET /api/usage/report?scope=all enforces.
      {
        title: 'AI usage & cost',
        description: "Every user's AI tokens and what they cost, by day or month, model, feature and user. Export as CSV.",
        Icon: InsightsOutlinedIcon,
        path: '/admin/settings/usage',
        permission: 'ai_config:read',
      },
      // Run retention (#422): the `runs` namespace of the system settings document.
      {
        title: 'Run history limit',
        description: "The most days any user's finished runs are kept, whatever their own setting says.",
        Icon: AutoDeleteOutlinedIcon,
        path: '/admin/settings/run-history',
        permission: 'system_settings:read',
      },
      // External AI apps (#464, #465): the `mcp` namespace of the system settings document
      // (GET /api/system-settings): the kill switches, the per-app ceilings and the rate limits,
      // the sensitive sites; plus every user's connected apps and their activity, gated in the page
      // (oauth_clients:read, mcp_activity:read). The route stays /admin/settings/ai-app-limits.
      {
        title: 'External AI apps',
        description: 'ChatGPT, Claude and agent frameworks: the kill switch, rate limits and per-app ceilings, sensitive sites, every connected app and what they did.',
        Icon: SmartToyOutlinedIcon,
        path: '/admin/settings/ai-app-limits',
        permission: 'system_settings:read',
      },
      // Secrets (#593): the `secrets` namespace of the system settings document (the kill switch, off by default),
      // the default Vault, and counts. `system_settings:read` is what GET /api/secrets/admin/summary and
      // GET /api/secrets/vault/default-client enforce; the switch and the default need `:write`, checked in the page.
      {
        title: 'Secrets',
        description: 'The kill switch for the agent using saved logins, the default Vault your users connect to, and how much it is used.',
        Icon: KeyOutlinedIcon,
        path: '/admin/settings/secrets',
        permission: 'system_settings:read',
      },
      // Connections (E39.2): the deployment's apps at Google and Microsoft. `system_settings:read` is what
      // GET /api/connections/admin/apps enforces; saving needs `:write`, checked in the page. Never a user's connections.
      {
        title: 'Connections',
        description: 'The apps your users connect their Google and Microsoft accounts through: client ids, secrets, redirect URIs and a switch for each provider.',
        Icon: LinkOutlinedIcon,
        path: '/admin/settings/connections',
        permission: 'system_settings:read',
      },
      // Request history (E40.4): the `questions` namespace of the system settings document.
      {
        title: 'Request history',
        description: 'How long the history of what agents asked is kept (7 days by default), and how long a question waits for an answer.',
        Icon: HistoryOutlinedIcon,
        path: '/admin/settings/request-history',
        permission: 'system_settings:read',
      },
    ],
  },
  // `Danger Zone` stays LAST (docs/specs/settings-ui.md): new groups go above it.
  { label: DANGER_ZONE_GROUP_LABEL, cards: [{ ...factoryResetSettingsPage.card, Icon: factoryResetSettingsPage.Icon }] },
];

/**
 * The admin settings hub (`/admin/settings`), as data. Every card's
 * `permission` is the exact string the API route enforces. The packaged
 * slices ship their cards; the app decides where they go. A core card is
 * appended above; an optional slice's card is declared in `src/slices/<id>.tsx`.
 */
export const ADMIN_SECTIONS: SettingsSectionDef[] = composeSections(CORE_ADMIN_SECTIONS, sliceAdminCards);
