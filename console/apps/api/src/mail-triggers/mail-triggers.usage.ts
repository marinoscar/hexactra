// What a mail trigger tells the connections page (E39.8, #605): the Disconnect dialog lists the triggers that read the account,
// and removing the account switches them off ("connection removed") instead of leaving a trigger that polls nothing.
import { Injectable, type OnModuleInit } from '@nestjs/common';

import { ConnectionUsageRegistry, type ConnectionUsage, type ConnectionUsageSource } from '../connections/connection-usage.registry';
import { PrismaService } from '../prisma/prisma.service';
import { MailTriggerEvents } from './mail-triggers.events';

@Injectable()
export class MailTriggerUsage implements ConnectionUsageSource, OnModuleInit {
  readonly kind = 'mail_trigger';

  constructor(
    private readonly prisma: PrismaService,
    private readonly registry: ConnectionUsageRegistry,
    private readonly events: MailTriggerEvents,
  ) {}

  onModuleInit(): void {
    this.registry.register(this);
  }

  async list(userId: string, connectionId: string): Promise<ConnectionUsage[]> {
    const rows = await this.prisma.mailTrigger.findMany({ where: { userId, connectionId }, include: { task: { select: { name: true } } }, orderBy: { createdAt: 'asc' } });
    return rows.map((r) => ({ kind: this.kind, id: r.id, name: `${r.task.name}: ${r.name}`.slice(0, 200) }));
  }

  /** Switches the triggers off and says so on them; the owner is told once each. */
  async clear(userId: string, connectionId: string): Promise<void> {
    const rows = await this.prisma.mailTrigger.findMany({ where: { userId, connectionId, enabled: true }, include: { task: { select: { name: true } } } });
    for (const t of rows) {
      const claimed = await this.prisma.mailTrigger.updateMany({ where: { id: t.id, enabled: true }, data: { enabled: false, status: 'connection_removed', statusReason: 'CONNECTION_REMOVED' } });
      if (claimed.count === 1) await this.events.attention(userId, { kind: 'connection_removed', triggerId: t.id, taskId: t.taskId, taskName: t.task.name });
    }
  }
}
