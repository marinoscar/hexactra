// Which connections a run may use (E39.7; one rule, E50.17 #987), fixed when the run starts. A tool that is set up and switched on is always
// available: every active connection of the owner is offered to every run and chat, at what the owner switched on for it (an account's
// capabilities, an MCP server's tools that are `read` or `write`). Nothing else turns one on or off: not a task, a chat, a model or a page.
// The per-task and per-chat lists (`task_connections`, `conversation_connections`) are deprecated and never read here. An AI app's run gets
// them only while the owner's `allowConnections` limit for that app is on (on by default for a new app).
//
// The list is written onto the policy snapshot at the first advance, so a later flip of a switch never alters a live run (the capability hub
// and `McpRunService.check` still re-read the connection at every call, so a tool switched off mid-run is refused when it is called).
// Web search follows the same shape (`web-availability.ts`, E50.7). Guarded by `test/tools-always-available.db.spec.ts`.
import { capabilitiesOf } from '../../../connections/connection-view';
import { isWriteCapability } from '../../../connections/connections.constants';
import type { SnapshotAppLimits, SnapshotConnection } from '../../../policies/policy-snapshot';
import type { HostDeps } from '../deps';

export type NeedsBrowser = 'auto' | 'always' | 'never';

export function readNeedsBrowser(value: unknown): NeedsBrowser {
  return value === 'always' || value === 'never' ? value : 'auto';
}

/**
 * The connections the owner switched on, as they are now: every active one, ordered by label then id. `access` follows the connection's own
 * switches: `read_write` when a change capability is on (an MCP server: when one of its tools is `write`), else `read`. Empty for an AI app's
 * run when the owner switched connections off for that app.
 */
export async function runConnections(
  d: Pick<HostDeps, 'prisma'>,
  run: { userId: string },
  appLimits: Pick<SnapshotAppLimits, 'allowConnections'> | null,
): Promise<SnapshotConnection[]> {
  if (appLimits && appLimits.allowConnections !== true) return [];
  const rows = await d.prisma.connection.findMany({
    where: { userId: run.userId, status: 'active' },
    select: { id: true, userId: true, label: true, provider: true, capabilities: true, mcpTools: { where: { mode: 'write', review: null }, select: { id: true }, take: 1 } },
    orderBy: [{ label: 'asc' }, { id: 'asc' }],
  });
  return rows
    .filter((c) => c.userId === run.userId)
    .map((c) => {
      const capabilities = capabilitiesOf(c);
      const write = c.provider === 'mcp' ? c.mcpTools.length > 0 : capabilities.some(isWriteCapability);
      return { connectionId: c.id, access: write ? ('read_write' as const) : ('read' as const), label: c.label, provider: c.provider, capabilities };
    });
}
