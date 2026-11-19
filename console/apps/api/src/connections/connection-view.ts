// What the owner (and the web, the CLI and later issues) may read about a connection (E39.2, #599): capability NAMES, never a
// scope string, a token or a provider message. `statusReason` is a stable code.
import type { Connection } from '@prisma/client';

import { CAPABILITIES, CAPABILITY_GROUPS, isCapability, type Capability, type CapabilityGroup } from './connections.constants';

/** What an MCP connection adds to its view (E39.9): where it points, how it signs in, and what its tools stand at. Never a secret. */
export interface McpConnectionInfo {
  url: string;
  auth: 'none' | 'bearer' | 'header' | 'oauth';
  serverName: string | null;
  tools: { total: number; enabled: number; needsReview: number };
  toolsFetchedAt: string | null;
}

export interface ConnectionView {
  id: string;
  provider: 'google' | 'microsoft' | 'mcp';
  label: string;
  accountEmail: string;
  accountName: string | null;
  /** The switches that are on. */
  capabilities: Capability[];
  /** What the provider actually granted (may exceed the switches: a permission stays granted at the provider until disconnect). Switching one of these on needs no new consent. */
  granted: Capability[];
  /** The groups this account is the default for. */
  defaultFor: CapabilityGroup[];
  status: 'active' | 'paused' | 'needs_reconnect' | 'revoked';
  /** A stable code (`GRANT_REVOKED`, ...), never a message. */
  statusReason: string | null;
  connectedAt: string;
  lastUsedAt: string | null;
  lastRefreshAt: string | null;
  /** Provider `mcp` only. */
  mcp?: McpConnectionInfo;
}

const iso = (d: Date | null): string | null => (d ? d.toISOString() : null);

/** The view of a row. `granted` comes from the provider's adapter (the caller computes it from `grantedScopes`). */
export function toView(row: Connection, granted: readonly Capability[]): ConnectionView {
  return {
    id: row.id,
    provider: row.provider,
    label: row.label,
    accountEmail: row.accountEmail,
    accountName: row.accountName,
    capabilities: CAPABILITIES.filter((c) => row.capabilities.includes(c)),
    granted: CAPABILITIES.filter((c) => granted.includes(c)),
    defaultFor: CAPABILITY_GROUPS.filter((g) => row.defaultFor.includes(g)),
    status: row.status,
    statusReason: row.statusReason,
    connectedAt: row.connectedAt.toISOString(),
    lastUsedAt: iso(row.lastUsedAt),
    lastRefreshAt: iso(row.lastRefreshAt),
  };
}

/** The capabilities of a stored row, as the closed type (an unknown stored value is dropped). */
export const capabilitiesOf = (row: Pick<Connection, 'capabilities'>): Capability[] => row.capabilities.filter(isCapability);
