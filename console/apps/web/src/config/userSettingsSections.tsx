import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import PaidOutlinedIcon from '@mui/icons-material/PaidOutlined';
import StickyNote2OutlinedIcon from '@mui/icons-material/StickyNote2Outlined';
import RuleOutlinedIcon from '@mui/icons-material/RuleOutlined';
import LayersOutlinedIcon from '@mui/icons-material/LayersOutlined';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import InsightsOutlinedIcon from '@mui/icons-material/InsightsOutlined';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import PsychologyOutlinedIcon from '@mui/icons-material/PsychologyOutlined';
import MenuBookOutlinedIcon from '@mui/icons-material/MenuBookOutlined';
import VerifiedUserOutlinedIcon from '@mui/icons-material/VerifiedUserOutlined';
import KeyOutlinedIcon from '@mui/icons-material/KeyOutlined';
import LinkOutlinedIcon from '@mui/icons-material/LinkOutlined';
import { identityUserSettingsSections } from '@marinoscar/platform-web/identity/ui';
import type { SettingsSectionDef } from '@marinoscar/platform-web/settings/ui';
import { DANGER_ZONE_GROUP_LABEL } from '@marinoscar/platform-web/user-data/headless';
import { dangerZoneSettingsPage } from '@marinoscar/platform-web/user-data/ui';
import { webhooksUserSettingsSections } from '@marinoscar/platform-web/webhooks/ui';

import { isSliceEnabled, sliceUserCards } from '../slices/manifest';

/** Outbound webhooks are mounted with the credentials and notifications slices (apps/api/src/app.module.ts). */
export const WEBHOOKS_ENABLED = isSliceEnabled('credentials') && isSliceEnabled('notifications');
/** Alerts are mounted with the notifications and email slices (apps/api/src/platform/alerts/alerts.enabled.ts). */
export const ALERTS_ENABLED = isSliceEnabled('notifications') && isSliceEnabled('email');
/** The settings group of the browser agent's cards, in both hubs. */
export const BROWSER_AGENT_GROUP = 'Browser agent';
import { composeSections } from '../slices/sections';

/**
 * The core's per-user groups. `Account` is empty on purpose: the optional
 * slices (`packages/shared/slices.json`) append to it (Profile, Notifications,
 * Get started) and to `Security` (AI keys), and add their own groups (Sharing,
 * Your data) before the Danger Zone.
 */
const CORE_USER_SECTIONS: SettingsSectionDef[] = [
  { label: 'Account', cards: [] },
  // `Connected apps` (#459: the OAuth grants of ChatGPT, Claude and other AI apps) shows only while the server is on (`feature: 'oauthServer'`).
  { label: 'Security', cards: [...identityUserSettingsSections.security, ...identityUserSettingsSections.connectedApps] },
  {
    label: 'Notes',
    cards: [
      {
        title: 'My notes',
        description: 'Write, archive and delete your own notes.',
        Icon: StickyNote2OutlinedIcon,
        path: '/notes',
        permission: 'notes:read',
      },
    ],
  },
  // `Danger Zone` stays LAST (docs/specs/settings-ui.md): add new groups above it.
  ...(WEBHOOKS_ENABLED ? [{ label: 'Integrations', cards: [...webhooksUserSettingsSections.integrations] }] : []),
  // The browser agent (epic #398). `agent_policies:read` is what `GET /api/agent-policies`
  // and `GET /api/agent-policies/model-tiers/effective` enforce; writes are gated in the pages.
  // APPEND further browser-agent cards (Run history, #422) to this group.
  {
    label: BROWSER_AGENT_GROUP,
    cards: [
      {
        title: 'Agent policies',
        description: 'Which models a run uses and how much it may spend: create, duplicate, export and import policies, and choose your default.',
        Icon: RuleOutlinedIcon,
        path: '/settings/agent-policies',
        permission: 'agent_policies:read',
      },
      {
        title: 'Model tiers',
        description: 'Choose the model, reasoning effort and fallback of the Fast, Standard and Frontier tiers for your runs.',
        Icon: LayersOutlinedIcon,
        path: '/settings/agent-model-tiers',
        permission: 'agent_policies:read',
        feature: 'ai',
      },
      // Run retention (#422). `runs:delete` is what `GET /api/runs/retention`, its preview and
      // `POST /api/runs/retention/apply` enforce (apps/api/src/tasks/run-retention.controller.ts).
      {
        title: 'Run history',
        description: 'How long finished runs are kept.',
        Icon: HistoryOutlinedIcon,
        path: '/settings/run-history',
        permission: 'runs:delete',
      },
      // Connected AI apps (#464). `connected_apps:read` is what `GET /api/connected-apps`
      // enforces (apps/api/src/connected-apps/connected-apps.controller.ts); the limits
      // and Pause need `connected_apps:write`, checked inside the page.
      {
        title: 'AI apps',
        description: 'ChatGPT, Claude and other AI apps connected to your account: what each may do and spend, and how to connect one.',
        Icon: SmartToyOutlinedIcon,
        path: '/settings/ai-apps',
        permission: 'connected_apps:read',
      },
      // Memories (#551). `memories:read` is what `GET /api/memories` enforces
      // (apps/api/src/memories/memories.controller.ts); writes need `memories:write`, checked in the page.
      {
        title: 'Memories',
        description: 'Facts you let the agent use: people, accounts and preferences. It never saves one without asking you.',
        Icon: PsychologyOutlinedIcon,
        path: '/settings/memories',
        permission: 'memories:read',
      },
      // Saved approvals (#554). `approvals:read` is what `GET /api/approval-rules` enforces
      // (apps/api/src/approvals/approval-rules.controller.ts); narrowing, turning off, deleting
      // and Pause all need `approvals:write`, checked inside the page.
      {
        title: 'Saved approvals',
        description: "Steps you told the agent not to ask about again: see, limit, turn off or delete them, or pause them all.",
        Icon: VerifiedUserOutlinedIcon,
        path: '/settings/approvals',
        permission: 'approvals:read',
      },
      // Secrets (#593). `secrets:read` is what `GET /api/secrets/status`, `/activity` and `/reach` enforce
      // (apps/api/src/secrets/); connecting, disconnecting and the switches need `secrets:write`, checked in the page.
      {
        title: 'Secrets',
        description: 'Connect your secrets provider, choose whether the agent may sign in with your saved logins, and see what it used.',
        Icon: KeyOutlinedIcon,
        path: '/settings/secrets',
        permission: 'secrets:read',
      },
      // Connections (E39.2). `connections:read` is what `GET /api/connections` enforces
      // (apps/api/src/connections/connections.controller.ts); connecting, changing and removing need `connections:write`, checked in the page.
      {
        title: 'Connections and tools',
        description: 'Everything the agent may use: your Google and Microsoft accounts, the tools you added (MCP servers) and web search. Switch each on or off, and test it.',
        Icon: LinkOutlinedIcon,
        path: '/settings/connections',
        permission: 'connections:read',
      },
      // AI usage and cost (#734). `usage:read` is what GET /api/usage/report enforces for the caller's own usage
      // (apps/api/src/usage/usage.controller.ts).
      {
        title: 'My usage & cost',
        description: 'The AI tokens you used and what they cost, by day, month and model. Export as CSV.',
        Icon: InsightsOutlinedIcon,
        path: '/settings/usage',
        permission: 'usage:read',
      },
      // My model prices (#735): the user's own `agentPricing` namespace of GET/PATCH /api/user-settings.
      {
        title: 'My model prices',
        description: 'What each model costs you, if your own key pays a different rate: replaces the deployment price for your runs and usage.',
        Icon: PaidOutlinedIcon,
        path: '/settings/model-prices',
        permission: 'user_settings:read',
      },
      // The Knowledge Graph (E46.20). `kgraph:read` is what GET /api/kgraph/status enforces; the switch and
      // Delete everything learned (DELETE /api/kgraph) need `kgraph:write`, checked in the page.
      {
        title: 'Knowledge Graph',
        description: 'Let your saved tasks learn their steps and repeat them without the model, see what was learned, or delete everything learned.',
        Icon: AccountTreeOutlinedIcon,
        path: '/settings/kgraph',
        permission: 'kgraph:read',
      },
      // Skills (#1008). `skills:read` is what `GET /api/skills` enforces (apps/api/src/skills/skills.controller.ts); writes need
      // `skills:write`, checked in the page.
      {
        title: 'Skills',
        description: 'How you want the agent to do a kind of job, in your words. A skill is guidance: it never allows a site, a payment or a recipient.',
        Icon: MenuBookOutlinedIcon,
        path: '/settings/skills',
        permission: 'skills:read',
      },
    ],
  },
  { label: DANGER_ZONE_GROUP_LABEL, cards: [{ ...dangerZoneSettingsPage.card, Icon: dangerZoneSettingsPage.Icon }] },
];

/**
 * The per-user settings hub (`/settings`). The sample card is the app's own:
 * `notes:read` is the permission `GET /api/notes` enforces
 * (apps/api/src/notes/notes.controller.ts). APPEND new cards; an optional
 * slice's card is declared in `src/slices/<id>.tsx`.
 */
export const USER_SETTINGS_SECTIONS: SettingsSectionDef[] = composeSections(CORE_USER_SECTIONS, sliceUserCards);
