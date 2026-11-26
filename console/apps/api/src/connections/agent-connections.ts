// The per-task and per-chat connection lists (E39.7, #604) are DEPRECATED (E50.17, #987): a tool that is set up and switched on is always
// available, so every run and chat gets every active connection of its owner at what the owner switched on (`runConnections`). Nothing here
// decides availability any more. The tables `task_connections` and `conversation_connections` stay for one release (data and exports still
// reference them) and are no longer written; the `connections` field of the task and chat APIs is accepted and ignored. What is left here:
// the wire shapes of the deprecated fields and the Disconnect dialog's clean-up of old rows.
//
// Plain functions over the Prisma client, not a Nest provider: the tasks and chat modules use them whether or not the connections
// slice is mounted.
import { z } from 'zod';

import type { PrismaService } from '../prisma/prisma.service';
import { MAX_CONNECTIONS_PER_USER } from './connections.constants';
import { registerErrorCode } from '@marinoscar/platform-api/core';
import type { ConnectionUsageSource } from './connection-usage.registry';

registerErrorCode({ code: 'CONNECTION_SELECTION_INVALID', status: 400, description: 'The connections listed for a task or a chat are not valid: one is not the caller\'s, or one is listed twice. `details.connectionIds` names them.' });

/** `read`: the read tools only. `read_write`: the tools that change something too (each of them still asks the owner). */
export const CONNECTION_ACCESS = ['read', 'read_write'] as const;
export type ConnectionAccess = (typeof CONNECTION_ACCESS)[number];
export const isConnectionAccess = (v: unknown): v is ConnectionAccess => typeof v === 'string' && (CONNECTION_ACCESS as readonly string[]).includes(v);

export const connectionSelectionSchema = z.object({
  connectionId: z.uuid().describe('A connection of the caller (`GET /api/connections`).'),
  access: z.enum(CONNECTION_ACCESS).describe('`read` offers the agent only the tools that read; `read_write` also the tools that send, create or change (each of those still asks the owner the first time).'),
});
export type ConnectionSelection = z.infer<typeof connectionSelectionSchema>;

/** The deprecated `connections` field of a task or a chat (E50.17): validated, then ignored. */
export const connectionSelectionsField = z
  .array(connectionSelectionSchema)
  .max(MAX_CONNECTIONS_PER_USER)
  .meta({ deprecated: true })
  .describe('Deprecated (E50.17): accepted and ignored for one release. Every run and chat may use everything its owner switched on in Connections and tools (each send or change still asks); there is no per-task or per-chat list.');

/** What the API returns for each selected connection. */
export const connectionSelectionViewSchema = connectionSelectionSchema.extend({
  label: z.string(),
  provider: z.string(),
  accountEmail: z.string(),
  status: z.string().describe('The connection\'s status now (`active`, `paused`, `needs_reconnect`): a run cannot use one that is not active.'),
});
export type ConnectionSelectionView = z.infer<typeof connectionSelectionViewSchema>;

/** What the deprecated `connections` and `connectionsMode` fields of a task answer (E50.17): no list, every connection the owner switched on. */
export const deprecatedConnectionFields = (): { connectionsMode: 'all'; connections: ConnectionSelectionView[] } => ({ connectionsMode: 'all', connections: [] });

/**
 * The Disconnect dialog's sources (`ConnectionUsageRegistry`). Since E50.17 no task or chat lists a connection (every one may use all of
 * them), so nothing is listed as a use; clearing still removes old selection rows (the foreign keys would too).
 */
export function agentConnectionUsage(prisma: PrismaService): ConnectionUsageSource[] {
  return [
    {
      // The owner's saved approvals for this connection (E39.7) are not listed (they are not a use); they are removed with it, so none outlives the account.
      kind: 'approval_rule',
      async list() {
        return [];
      },
      async clear(userId, connectionId) {
        await prisma.approvalRule.deleteMany({ where: { userId, kind: 'connection', host: connectionId } });
      },
    },
    {
      kind: 'task',
      async list() {
        return [];
      },
      async clear(userId, connectionId) {
        await prisma.taskConnection.deleteMany({ where: { connectionId, task: { userId } } });
      },
    },
    {
      kind: 'chat',
      async list() {
        return [];
      },
      async clear(userId, connectionId) {
        await prisma.conversationConnection.deleteMany({ where: { connectionId, conversation: { userId } } });
      },
    },
  ];
}
