// What an account was used for lately (E39.10, #607), for the "Recent activity" of a connection on the Connections page: the agent's
// tool calls (the run steps that name the account) and the deliveries sent through it. The operation, the time, whether it worked and the
// run: NEVER a subject, an address, a body, a cell or a file name (a run step's summary can carry some, so it is not read).
import { Injectable } from '@nestjs/common';

import { PrismaService } from '../prisma/prisma.service';
import { notFound } from './connections.errors';

/** The run steps of the agent's connection tools (E39.7): the operation names a client may show. A bounded vocabulary. */
export const CONNECTION_TOOL_NAMES = [
  'mail_search',
  'mail_read',
  'mail_attachment_to_browser',
  'mail_draft',
  'mail_send',
  'mail_modify',
  'calendar_list',
  'calendar_free_busy',
  'calendar_create_event',
  'calendar_update_event',
  'calendar_delete_event',
  'docs_search',
  'docs_read',
  'sheet_read',
  'docs_create',
  'docs_append',
  'sheet_append_rows',
  'sheet_create',
  'file_upload',
] as const;

export interface ConnectionActivityItem {
  /** `tool`: the agent used the account during a run. `delivery`: a delivery after a run went through it. */
  kind: 'tool' | 'delivery';
  /** The tool's name (`mail_send`) or the delivery's kind (`sheet_row`). */
  operation: string;
  ok: boolean;
  at: string;
  runId: string | null;
}

const LIMIT = 15;

@Injectable()
export class ConnectionActivityService {
  constructor(private readonly prisma: PrismaService) {}

  async recent(userId: string, connectionId: string): Promise<{ items: ConnectionActivityItem[] }> {
    const conn = await this.prisma.connection.findFirst({ where: { id: connectionId, userId }, select: { label: true } });
    if (!conn) throw notFound();
    // The steps name the account by its label at the time; the label is the owner's own text and is matched exactly, never interpolated.
    const [steps, deliveries] = await Promise.all([
      this.prisma.runStep.findMany({
        where: { kind: 'action', action: { in: [...CONNECTION_TOOL_NAMES] }, args: { path: ['connection'], equals: conn.label }, run: { userId } },
        orderBy: { createdAt: 'desc' },
        take: LIMIT,
        select: { action: true, ok: true, createdAt: true, runId: true },
      }),
      this.prisma.runDelivery.findMany({
        where: { userId, delivery: { connectionId }, status: { in: ['sent', 'failed'] } },
        orderBy: { createdAt: 'desc' },
        take: LIMIT,
        select: { kind: true, status: true, createdAt: true, runId: true, sentAt: true },
      }),
    ]);
    const items: ConnectionActivityItem[] = [
      ...steps.map((s): ConnectionActivityItem => ({ kind: 'tool', operation: s.action ?? 'tool', ok: s.ok, at: s.createdAt.toISOString(), runId: s.runId })),
      ...deliveries.map((d): ConnectionActivityItem => ({ kind: 'delivery', operation: d.kind, ok: d.status === 'sent', at: (d.sentAt ?? d.createdAt).toISOString(), runId: d.runId })),
    ];
    items.sort((a, b) => b.at.localeCompare(a.at));
    return { items: items.slice(0, LIMIT) };
  }
}
