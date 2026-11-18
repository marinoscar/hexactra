import StickyNote2OutlinedIcon from '@mui/icons-material/StickyNote2Outlined';
import RuleOutlinedIcon from '@mui/icons-material/RuleOutlined';
import LayersOutlinedIcon from '@mui/icons-material/LayersOutlined';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
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
