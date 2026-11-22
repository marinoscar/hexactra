import { randomUUID } from 'node:crypto';

import { ConflictException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import type { Mode } from '@marinoscar/hexactra-kgraph';

import { PrismaService } from '../prisma/prisma.service';
import { KgraphEnabledService } from './kgraph-enabled.service';
import { PrismaProcedureStore, purgeKgraph } from './prisma-procedure-store';

/** The switches and the purge of the Knowledge Graph (E46.3, #777). Every read is the caller's own. */
@Injectable()
export class KgraphService {
  private readonly log = new Logger(KgraphService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly enabled: KgraphEnabledService,
    private readonly store: PrismaProcedureStore,
  ) {}

  private async ownProcedure(userId: string, id: string) {
    const p = await this.store.getProcedure(userId, id);
    if (!p) throw new NotFoundException({ code: 'KGRAPH_PROCEDURE_NOT_FOUND', message: 'Procedure not found' });
    return p;
  }

  /**
   * Rollback (E46.12): a retired or suspended version comes back as a new candidate copy (versions are immutable), and the other usable
   * versions retire, so the task's next run verifies it (asking before every commit-class step) and then makes it active.
   */
  async restore(userId: string, procedureId: string, versionId: string) {
    await this.ownProcedure(userId, procedureId);
    const versions = await this.store.listVersions(userId, procedureId);
    const chosen = versions.find((v) => v.id === versionId);
    if (!chosen || (chosen.state !== 'retired' && chosen.state !== 'suspended')) throw new ConflictException({ code: 'KGRAPH_VERSION_NOT_RESTORABLE', message: 'Only a retired or suspended version can be restored' });
    for (const v of versions) if (v.state === 'active' || v.state === 'verified' || v.state === 'candidate') await this.store.setVersionState(userId, v.id, v.state, 'retired');
    const copy = { ...chosen, id: `kgv-${randomUUID()}`, number: (versions[0]?.number ?? 0) + 1, state: 'candidate' as const, parent: chosen.id, createdAt: new Date().toISOString(), evidence: { successes: 0, failures: 0, repairs: 0, lastSuccessAt: null, lastFailureAt: null }, stepEvidence: {} };
    await this.store.putVersion(userId, copy);
    await this.audit(userId, 'kgraph.version.restored', 'kgraph_version', copy.id, { procedureId, restoredFrom: chosen.id, versionId: copy.id });
    return { procedureId, restoredFrom: chosen.id, versionId: copy.id };
  }

  /** Reset (E46.12): every version of the procedure retires; the task learns again. */
  async forget(userId: string, procedureId: string) {
    await this.ownProcedure(userId, procedureId);
    let retired = 0;
    for (const v of await this.store.listVersions(userId, procedureId)) if (v.state !== 'retired' && v.state !== 'rejected' && (await this.store.setVersionState(userId, v.id, v.state, 'retired'))) retired++;
    await this.audit(userId, 'kgraph.procedure.forgotten', 'kgraph_procedure', procedureId, { procedureId, retired });
    return { procedureId, retired };
  }

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
