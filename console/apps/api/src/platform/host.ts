import { definePlatformHost } from '@marinoscar/platform-api/core';
import { Auth, Public, type PermissionName } from '@marinoscar/platform-api/identity';

/**
 * The app's platform host: how a packaged controller's routes get the app's
 * access rules. Each slice's `forRoot({ host })` applies these, so a packaged
 * route is guarded exactly like one of the app's own (`@Auth()`).
 */
export const platformHost = definePlatformHost({
  access: {
    // The platform hands its own ids as plain strings; `PermissionName` is a closed union once an embedded package
    // (the built-in secrets store's Vault packages) augments it, hence the cast.
    requirePermissions: (permissions) => Auth({ permissions: [...permissions] as PermissionName[] }),
    requireAuthenticated: () => Auth(),
    allowPublic: () => Public(),
  },
});
