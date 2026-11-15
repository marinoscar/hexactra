/**
 * Permissions for the fabric connection (the Hexactra control plane the
 * console drives browsers through). System scope: one fabric per deployment.
 * The exact strings `FabricConnectionController` enforces and the admin card
 * declares.
 */
export const FABRIC_PERMISSIONS = {
  FABRIC_CONFIG_READ: {
    id: 'fabric_config:read',
    description: 'See the fabric connection and test it',
    scope: 'system',
    defaultGrants: ['admin'],
  },
  FABRIC_CONFIG_WRITE: {
    id: 'fabric_config:write',
    description: 'Change the fabric URL and service token',
    scope: 'system',
    defaultGrants: ['admin'],
  },
} as const;
