// Which connections a run may use (E39.7), fixed when the run starts. A task's run has every active connection of the owner, at what the owner
// switched on for each (an account's capabilities, an MCP server's enabled tools), unless the task is limited to a list (#967: `connectionsMode`).
// A run that is not a task's has what its chat lists (the owner's default or the owner's own choice, #680); an AI app's run gets none unless the
// owner allowed connections for that app. The list is written onto the policy snapshot at the first advance, so a later change of the task, the
// chat or the connection's switches never alters a live run (the hub still re-reads the connection's state at every call).
import { capabilitiesOf } from '../../../connections/connection-view';
import { isConnectionAccess } from '../../../connections/agent-connections';
import type { SnapshotAppLimits, SnapshotConnection } from '../../../policies/policy-snapshot';
import type { HostDeps } from '../deps';

export type NeedsBrowser = 'auto' | 'always' | 'never';

export function readNeedsBrowser(value: unknown): NeedsBrowser {
  return value === 'always' || value === 'never' ? value : 'auto';
}

/** The connections a run may use, from its task or its chat, as they are now. Empty for a run that lists none. */
export async function runConnections(
  d: Pick<HostDeps, 'prisma'>,
  run: { userId: string; taskId: string | null; conversationId?: string | null },
  appLimits: Pick<SnapshotAppLimits, 'allowConnections'> | null,
): Promise<SnapshotConnection[]> {
  // A run an AI app started gets the owner's connections only when the owner allowed it for that app, and the task lists them.
  if (appLimits && appLimits.allowConnections !== true) return [];
  const include = { connection: { select: { id: true, userId: true, label: true, provider: true, capabilities: true } } } as const;
  // The task's mode (#967), or the chat's (#969) for a run that is not a task's. An AI app's run never takes a chat's.
  const owner = run.taskId
    ? await d.prisma.task.findFirst({ where: { id: run.taskId, userId: run.userId }, select: { connectionsMode: true } })
    : appLimits || !run.conversationId
      ? null
      : await d.prisma.conversation.findFirst({ where: { id: run.conversationId, userId: run.userId }, select: { connectionsMode: true } });
  if (run.taskId || run.conversationId) {
    if (!owner) return [];
    if (owner.connectionsMode !== 'listed') {
      // `all`: read and change, so what the agent may do is exactly what the owner switched on for the connection. Every write still asks.
      const all = await d.prisma.connection.findMany({ where: { userId: run.userId, status: 'active' }, select: include.connection.select, orderBy: [{ label: 'asc' }, { id: 'asc' }] });
      return all.map((c) => ({ connectionId: c.id, access: 'read_write' as const, label: c.label, provider: c.provider, capabilities: capabilitiesOf(c) }));
    }
  }
  const rows = run.taskId
    ? await d.prisma.taskConnection.findMany({ where: { taskId: run.taskId, task: { userId: run.userId } }, include, orderBy: [{ connection: { label: 'asc' } }, { id: 'asc' }] })
    : appLimits || !run.conversationId
      ? []
      : await d.prisma.conversationConnection.findMany({ where: { conversationId: run.conversationId, conversation: { userId: run.userId } }, include, orderBy: [{ connection: { label: 'asc' } }, { id: 'asc' }] });
  return rows
    .filter((r) => r.connection.userId === run.userId)
    .map((r) => ({
      connectionId: r.connectionId,
      access: isConnectionAccess(r.access) ? r.access : 'read',
      label: r.connection.label,
      provider: r.connection.provider,
      capabilities: capabilitiesOf(r.connection),
    }));
}
