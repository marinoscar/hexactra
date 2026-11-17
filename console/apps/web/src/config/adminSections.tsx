import { alertsAdminCards } from '@marinoscar/platform-web/alerts/ui';
import { doctorSettingsPage } from '@marinoscar/platform-web/doctor/ui';
import { identityAdminSections } from '@marinoscar/platform-web/identity/ui';
import { jobsAdminSections } from '@marinoscar/platform-web/jobs/ui';
import type { SettingsSectionDef } from '@marinoscar/platform-web/settings/ui';
import { DANGER_ZONE_GROUP_LABEL } from '@marinoscar/platform-web/user-data/headless';
import { factoryResetSettingsPage } from '@marinoscar/platform-web/user-data/ui';
import { webhooksAdminSections } from '@marinoscar/platform-web/webhooks/ui';

import HubOutlinedIcon from '@mui/icons-material/HubOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import LayersOutlinedIcon from '@mui/icons-material/LayersOutlined';
import PaidOutlinedIcon from '@mui/icons-material/PaidOutlined';
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
  { label: 'Access', cards: [...identityAdminSections.access, ...identityAdminSections.organizations] },
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
