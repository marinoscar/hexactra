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

import { BENCHMARKS_PERMISSIONS } from '../benchmark/benchmark.permissions';
import { CHAT_PERMISSIONS } from '../chat/chat.permissions';
import { CONNECTIONS_PERMISSIONS } from '../connections/connections.permissions';
import { CONNECTED_APPS_PERMISSIONS } from '../connected-apps/connected-apps.permissions';
import { MEMORIES_PERMISSIONS } from '../memories/memories.permissions';
import { MCP_PERMISSIONS } from '../mcp/mcp.permissions';
import { FABRIC_PERMISSIONS } from '../fabric/fabric.permissions';
import { FLEET_PERMISSIONS } from '../fleet/fleet.permissions';
import { NOTES_PERMISSIONS } from '../notes/notes.permissions';
import { POLICIES_PERMISSIONS } from '../policies/policies.permissions';
import { APPROVALS_PERMISSIONS } from '../approvals/approvals.permissions';
import { SECRETS_PERMISSIONS } from '../secrets/secrets.permissions';
import { TASKS_PERMISSIONS } from '../tasks/tasks.permissions';
import { USAGE_PERMISSIONS } from '../usage/usage.permissions';
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
  app: { permissions: [NOTES_PERMISSIONS, FABRIC_PERMISSIONS, FLEET_PERMISSIONS, TASKS_PERMISSIONS, POLICIES_PERMISSIONS, CHAT_PERMISSIONS, CONNECTED_APPS_PERMISSIONS, MCP_PERMISSIONS, MEMORIES_PERMISSIONS, APPROVALS_PERMISSIONS, SECRETS_PERMISSIONS, CONNECTIONS_PERMISSIONS, BENCHMARKS_PERMISSIONS, USAGE_PERMISSIONS] },
} satisfies PlatformPermissionOptions;

// The permission id type. `@marinoscar/vault-api` (the built-in secrets store, E37.5) augments the platform's
// `IdentityPermissionIds` with ITS permission ids, and an augmentation turns the open `string` into a closed union, so
// every id the console itself enforces must be added here or `@Auth({ permissions })` stops compiling for it. The
// ids are derived from the app's own permission sets, so adding one needs no change here.
type AppPermissionSet =
  | typeof NOTES_PERMISSIONS
  | typeof FABRIC_PERMISSIONS
  | typeof FLEET_PERMISSIONS
  | typeof TASKS_PERMISSIONS
  | typeof USAGE_PERMISSIONS
  | typeof POLICIES_PERMISSIONS
  | typeof CHAT_PERMISSIONS
  | typeof CONNECTED_APPS_PERMISSIONS
  | typeof MCP_PERMISSIONS
  | typeof MEMORIES_PERMISSIONS
  | typeof APPROVALS_PERMISSIONS
  | typeof SECRETS_PERMISSIONS
  | typeof CONNECTIONS_PERMISSIONS
  | typeof BENCHMARKS_PERMISSIONS;
// Distributive over the union (`keyof (A | B)` would keep only the keys both sets share).
type IdsOf<T> = T extends Record<string, { readonly id: infer I }> ? I : never;
type AppPermissionId = IdsOf<AppPermissionSet>;

declare module '@marinoscar/platform-api/identity' {
  interface IdentityPermissionIds extends Record<AppPermissionId, true> {}
}
