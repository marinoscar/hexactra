import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Mode } from '@marinoscar/hexactra-kgraph';

import { PrismaService } from '../prisma/prisma.service';
import { KgraphEnabledService } from './kgraph-enabled.service';
import { purgeKgraph } from './prisma-procedure-store';

/** The switches and the purge of the Knowledge Graph (E46.3, #777). Every read is the caller's own. */
@Injectable()
export class KgraphService {
  private readonly log = new Logger(KgraphService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enabled: KgraphEnabledService,
  ) {}

  private async ownTask(userId: string, taskId: string): Promise<void> {
    const task = await this.prisma.forUser({ userId }).task.findFirst({ where: { id: taskId, userId }, select: { id: true } });
    if (!task) throw new NotFoundException({ code: 'KGRAPH_TASK_NOT_FOUND', message: 'Task not found' });
  }

  async taskSettings(userId: string, taskId: string) {
    await this.ownTask(userId, taskId);
    const [mode, status] = await Promise.all([this.enabled.taskMode(userId, taskId), this.enabled.status(userId)]);
    return { taskId, mode, available: status.available };
  }

  async setTaskMode(userId: string, taskId: string, mode: Mode) {
    await this.ownTask(userId, taskId);
    const status = await this.enabled.status(userId);
    if (!status.available) {
      throw new ConflictException({ code: 'KGRAPH_OFF', message: status.deployment ? 'Turn on the Knowledge Graph in your settings first' : 'The Knowledge Graph is turned off by your administrator' });
    }
    const before = await this.enabled.taskMode(userId, taskId);
    await this.prisma.forUser({ userId }).kgTaskSettings.upsert({ where: { taskId }, create: { taskId, userId, mode }, update: { mode } });
    if (before !== mode) await this.audit(userId, 'kgraph.task_mode_changed', 'task', taskId, { taskId, from: before, to: mode });
    return { taskId, mode, available: true };
  }

  status(userId: string) {
    return this.enabled.status(userId);
  }

  async purge(userId: string) {
    const deleted = await purgeKgraph(this.prisma, userId);
    await this.audit(userId, 'kgraph.purged', 'user', userId, deleted);
    return { deleted };
  }

  /** An audit event: ids, modes and counts only. Never fails the caller. */
  async audit(userId: string, action: string, targetType: string, targetId: string, meta: Record<string, unknown>): Promise<void> {
    try {
      await this.prisma.auditEvent.create({ data: { actorUserId: userId, action, targetType, targetId, meta: meta as Prisma.InputJsonValue } });
    } catch (err) {
      this.log.warn(`${action}: the audit record could not be written: ${err instanceof Error ? err.name : 'error'}`);
    }
  }
}
