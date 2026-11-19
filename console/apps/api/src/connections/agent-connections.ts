// Which connections a task or a chat may use, and how (E39.7, #604). Nothing is available by default: a run has the connections its
// task (or the chat that started it) lists, each `read` or `read_write`, and nothing else. The selection is stored in
// `task_connections` and `conversation_connections`; a run takes a snapshot of it when it starts (policy-snapshot.ts), so a later
// change never alters a live run.
//
// Plain functions over the Prisma client, not a Nest provider: the tasks and chat modules use them whether or not the connections
// slice is mounted (without it the tables are simply empty, and nothing is offered).
import { BadRequestException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
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

/** The `connections` field of a task or a chat: absent leaves it as it is, `[]` switches every connection off. */
export const connectionSelectionsField = z
  .array(connectionSelectionSchema)
  .max(MAX_CONNECTIONS_PER_USER)
  .describe('The connections the agent may use in this task or chat, and how. Off until listed: nothing is available by default. A run takes a snapshot when it starts.');

/** What the API returns for each selected connection. */
export const connectionSelectionViewSchema = connectionSelectionSchema.extend({
  label: z.string(),
  provider: z.string(),
  accountEmail: z.string(),
  status: z.string().describe('The connection\'s status now (`active`, `paused`, `needs_reconnect`): a run cannot use one that is not active.'),
});
export type ConnectionSelectionView = z.infer<typeof connectionSelectionViewSchema>;

type SelectionRow = { connectionId: string; access: string; connection: { label: string; provider: string; accountEmail: string; status: string } };

const viewOf = (r: SelectionRow): ConnectionSelectionView => ({ connectionId: r.connectionId, access: isConnectionAccess(r.access) ? r.access : 'read', label: r.connection.label, provider: r.connection.provider, accountEmail: r.connection.accountEmail, status: r.connection.status });

const include = { connection: { select: { label: true, provider: true, accountEmail: true, status: true } } } as const;

/** The selections of several tasks, by task id. */
export async function taskConnectionViews(prisma: PrismaService, taskIds: readonly string[]): Promise<Map<string, ConnectionSelectionView[]>> {
  const out = new Map<string, ConnectionSelectionView[]>();
  if (taskIds.length === 0) return out;
  const rows = await prisma.taskConnection.findMany({ where: { taskId: { in: [...taskIds] } }, include, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  for (const r of rows) out.set(r.taskId, [...(out.get(r.taskId) ?? []), viewOf(r)]);
  return out;
}

/** The selections of several chats, by conversation id. */
export async function conversationConnectionViews(prisma: PrismaService, ids: readonly string[]): Promise<Map<string, ConnectionSelectionView[]>> {
  const out = new Map<string, ConnectionSelectionView[]>();
  if (ids.length === 0) return out;
  const rows = await prisma.conversationConnection.findMany({ where: { conversationId: { in: [...ids] } }, include, orderBy: [{ createdAt: 'asc' }, { id: 'asc' }] });
  for (const r of rows) out.set(r.conversationId, [...(out.get(r.conversationId) ?? []), viewOf(r)]);
  return out;
}

/** Checks that every connection listed is the caller's (a foreign id is reported as unknown, never as another user's) and listed once. */
export async function assertSelectable(prisma: PrismaService | Prisma.TransactionClient, userId: string, items: readonly ConnectionSelection[]): Promise<void> {
  const ids = items.map((i) => i.connectionId);
  const bad = new Set(ids.filter((id, i) => ids.indexOf(id) !== i));
  if (ids.length > 0) {
    const own = await prisma.connection.findMany({ where: { userId, id: { in: ids }, NOT: { provider: 'mcp' } }, select: { id: true } });
    const ok = new Set(own.map((c) => c.id));
    for (const id of ids) if (!ok.has(id)) bad.add(id);
  }
  if (bad.size > 0) throw new BadRequestException({ code: 'CONNECTION_SELECTION_INVALID', message: 'A connection listed is not one of yours, or is listed twice.', details: { connectionIds: [...bad] } });
}

/** Replaces a task's selection (the caller has checked the task is theirs and ran `assertSelectable`). */
export async function replaceTaskConnections(tx: Prisma.TransactionClient, taskId: string, items: readonly ConnectionSelection[]): Promise<void> {
  await tx.taskConnection.deleteMany({ where: { taskId } });
  if (items.length > 0) await tx.taskConnection.createMany({ data: items.map((i) => ({ taskId, connectionId: i.connectionId, access: i.access })) });
}

/** Replaces a chat's selection. */
export async function replaceConversationConnections(tx: Prisma.TransactionClient, conversationId: string, items: readonly ConnectionSelection[]): Promise<void> {
  await tx.conversationConnection.deleteMany({ where: { conversationId } });
  if (items.length > 0) await tx.conversationConnection.createMany({ data: items.map((i) => ({ conversationId, connectionId: i.connectionId, access: i.access })) });
}

/**
 * The tasks and chats that use a connection, for the Disconnect dialog (`ConnectionUsageRegistry`). Clearing removes the selection
 * rows (the foreign keys would too): the task or chat then lists one connection fewer.
 */
export function agentConnectionUsage(prisma: PrismaService): ConnectionUsageSource[] {
  return [
    {
      kind: 'task',
      async list(userId, connectionId) {
        const rows = await prisma.taskConnection.findMany({ where: { connectionId, task: { userId } }, select: { task: { select: { id: true, name: true } } } });
        return rows.map((r) => ({ kind: 'task', id: r.task.id, name: r.task.name }));
      },
      async clear(userId, connectionId) {
        await prisma.taskConnection.deleteMany({ where: { connectionId, task: { userId } } });
      },
    },
    {
      kind: 'chat',
      async list(userId, connectionId) {
        const rows = await prisma.conversationConnection.findMany({ where: { connectionId, conversation: { userId } }, select: { conversation: { select: { id: true, title: true } } } });
        return rows.map((r) => ({ kind: 'chat', id: r.conversation.id, name: r.conversation.title || 'Untitled chat' }));
      },
      async clear(userId, connectionId) {
        await prisma.conversationConnection.deleteMany({ where: { connectionId, conversation: { userId } } });
      },
    },
  ];
}
