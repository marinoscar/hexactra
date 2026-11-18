// The roles and permissions this app seeds, as options for the platform's
// packaged registry (`@marinoscar/platform-api/manifest`): the permission sets
// of the slices this app mounts, in the platform's seed order, then the app's
// own. The identity slice's four roles always come first. Pure data, no side
// effect: `prisma/seed.ts` composes the catalog from it
// (`platformPermissionCatalog`) and `./registrations.ts` fills the registries
// with it (`registerPlatformPermissions`), so the two never disagree.
//
// The OPTIONAL slices bring their own: each enabled slice in
// `packages/shared/slices.json` names the permission sets it declares
// (`ApiSlice.permissionSlices`: storage, notifications, sharing, AI, backup), so
// the seed writes the rows its routes check. Re-run `npm run prisma:seed` after
// enabling one. A slice without permissions of its own (credentials, email,
// exports, onboarding, android-app) enforces the `settings` slice's.
import type { PlatformPermissionOptions } from '@marinoscar/platform-api/manifest';

import { CHAT_PERMISSIONS } from '../chat/chat.permissions';
import { CONNECTED_APPS_PERMISSIONS } from '../connected-apps/connected-apps.permissions';
import { MEMORIES_PERMISSIONS } from '../memories/memories.permissions';
import { MCP_PERMISSIONS } from '../mcp/mcp.permissions';
import { FABRIC_PERMISSIONS } from '../fabric/fabric.permissions';
import { FLEET_PERMISSIONS } from '../fleet/fleet.permissions';
import { NOTES_PERMISSIONS } from '../notes/notes.permissions';
import { POLICIES_PERMISSIONS } from '../policies/policies.permissions';
import { TASKS_PERMISSIONS } from '../tasks/tasks.permissions';
import { alertsMounted } from './alerts/alerts.enabled';
import { enabledPermissionSlices, isSliceEnabled } from './slices/manifest';

export const PERMISSION_OPTIONS = {
  slices: [
    'identity',
    'settings',
    'jobs',
    'nodes',
    'user-data',
    ...enabledPermissionSlices(),
    ...(isSliceEnabled('credentials') && isSliceEnabled('notifications') ? (['webhooks'] as const) : []),
    ...(alertsMounted() ? (['alerts'] as const) : []),
  ],
  app: { permissions: [NOTES_PERMISSIONS, FABRIC_PERMISSIONS, FLEET_PERMISSIONS, TASKS_PERMISSIONS, POLICIES_PERMISSIONS, CHAT_PERMISSIONS, CONNECTED_APPS_PERMISSIONS, MCP_PERMISSIONS, MEMORIES_PERMISSIONS] },
} satisfies PlatformPermissionOptions;
