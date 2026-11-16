/**
 * Fleet permissions: the browser hosts and profiles of the fabric. The exact
 * strings `FleetController` enforces and the web, CLI and TUI declare.
 */
export const FLEET_PERMISSIONS = {
  FLEET_READ: {
    id: 'fleet:read',
    description: 'See browser hosts, profiles and running browsers',
    scope: 'org',
    defaultGrants: ['contributor', 'viewer', 'org_admin'],
  },
  FLEET_WRITE: {
    id: 'fleet:write',
    description: 'Enroll, drain and revoke hosts; create, restart and delete profiles',
    scope: 'org',
    defaultGrants: ['org_admin'],
  },
  FLEET_DESKTOP: {
    id: 'fleet:desktop',
    description: "See and control a host's remote desktop (its signed-in browsers)",
    scope: 'org',
    defaultGrants: ['org_admin'],
  },
} as const;
