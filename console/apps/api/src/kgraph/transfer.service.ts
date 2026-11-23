// Export and import of procedures (E46.23). An import is never trusted: each procedure is validated, its accounts are mapped only to the
// owner's own connections by the owner's explicit choice (nothing matched by name), it lands on a task in `learn` mode with the owner's
// defaults (an import never sets allowed sites, a connection or a saved approval), and it is stored as a sensitive candidate: it needs the
// owner's review of the whole procedure AND a clean verification run before it is ever active.
import { randomUUID } from 'node:crypto';

import { BadRequestException, Injectable, NotFoundException } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { classifyRepair, diffVersions, exportFile, procedureVersionSchema, readTransferFile, validateVersion, type Tool, type TransferFile } from '@marinoscar/hexactra-kgraph';

import { PrismaService } from '../prisma/prisma.service';
import { consoleIsSensitive } from '../runner/host/kgraph/observer-port';
import { PrismaProcedureStore } from './prisma-procedure-store';
import { KgraphReviewsService } from './reviews.service';
import { KgraphSiteFactsService, type ExportedSiteFact } from './site-facts.service';

export interface ImportOptions {
  /** Which of the owner's connections stands for each exported account placeholder (`account-1` → a connection id). */
  accounts?: Record<string, string>;
  /** Attach procedure N (by its index in the file) to an existing task of the owner; otherwise a new task is created. */
  attach?: Record<string, string>;
}

@Injectable()
export class KgraphTransferService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly store: PrismaProcedureStore,
    private readonly reviews: KgraphReviewsService,
    private readonly siteFacts: KgraphSiteFactsService,
  ) {}

  async export(userId: string, procedureIds: string[] | null): Promise<{ file: TransferFile & { siteFacts: ExportedSiteFact[] }; filename: string }> {
    const db = this.prisma.forUser({ userId });
    const procedures = (await this.store.listProcedures(userId)).filter((p) => !procedureIds || procedureIds.includes(p.id));
    const items = [];
    for (const p of procedures) {
      const version = (await this.store.listVersions(userId, p.id)).find((v) => v.state === 'active');
      if (!version) continue;
      const task = await db.task.findFirst({ where: { id: p.task, userId }, select: { name: true, goal: true, parameters: true, outputs: true } });
      if (!task) continue;
      items.push({ task: { name: task.name, goal: task.goal, parameters: Array.isArray(task.parameters) ? (task.parameters as unknown[]) : [], outputs: Array.isArray(task.outputs) ? (task.outputs as unknown[]) : [] }, version });
    }
    const now = new Date();
    // The owner's active site facts (E46.31) travel beside the procedures: site, kind, text and source only. An import proposes each again.
    const file = { ...exportFile(items, now, consoleIsSensitive), siteFacts: await this.siteFacts.exportFacts(userId) };
    await this.prisma.auditEvent.create({ data: { actorUserId: userId, action: 'kgraph.exported', targetType: 'user', targetId: userId, meta: { procedures: items.length, siteFacts: file.siteFacts.length } } }).catch(() => undefined);
    return { file, filename: `hexactra-kgraph-${now.toISOString().slice(0, 10).replace(/-/g, '')}.json` };
  }

  async import(userId: string, raw: unknown, options: ImportOptions = {}) {
    const read = readTransferFile(raw);
    if (!read.ok) throw new BadRequestException({ code: 'KGRAPH_IMPORT_INVALID', message: read.error.message, details: { reason: read.error.code } });
    const db = this.prisma.forUser({ userId });
    const imported: { index: number; taskId: string; procedureId: string; versionId: string; reviewId: string }[] = [];
    const skipped: { index: number; reason: string }[] = [];
    for (const [index, p] of read.file.procedures.entries()) {
      // Accounts: only the owner's own connections, by the owner's explicit choice.
      const accounts = [];
      let missing: string | null = null;
      for (const a of p.version.accounts) {
        const chosen = options.accounts?.[a.id];
        const conn = chosen ? await db.connection.findFirst({ where: { id: chosen, userId }, select: { id: true, provider: true } }) : null;
        if (!conn) {
          missing = a.id;
          break;
        }
        accounts.push({ id: a.id, connectionId: conn.id, provider: conn.provider });
      }
      if (missing) {
        skipped.push({ index, reason: `choose which of your accounts stands for ${missing}` });
        continue;
      }
      const tools: Tool[] = [...new Map(p.version.steps.flatMap((s) => (s.kind === 'call' ? [[s.tool, { name: s.tool, family: s.tool.startsWith('mail_') || s.tool.startsWith('sheet_') ? 'accounts' : 'browser', commits: s.commitClass }] as const] : []))).values()];
      const now = new Date().toISOString();
      const draft = { ...p.version, accounts, id: `kgv-${randomUUID()}`, procedure: 'pending', number: 1, state: 'candidate', changeClass: 'sensitive', sourceRun: null, parent: null, createdAt: now };
      const violations = validateVersion(draft, { tools, isSensitive: consoleIsSensitive });
      if (violations.length) {
        skipped.push({ index, reason: violations.slice(0, 3).map((v) => v.message).join('; ') });
        continue;
      }
      // The task: the owner's own, or a new one in learn mode with the owner's defaults (no allowed sites, no connections from the file).
      let taskId = options.attach?.[String(index)];
      if (taskId) {
        if (!(await db.task.findFirst({ where: { id: taskId, userId }, select: { id: true } }))) throw new NotFoundException({ code: 'KGRAPH_TASK_NOT_FOUND', message: 'Task not found' });
      } else {
        taskId = (await db.task.create({ data: { userId, name: p.task.name.slice(0, 200), goal: p.task.goal.slice(0, 4000), parameters: p.task.parameters as Prisma.InputJsonValue, outputs: p.task.outputs as Prisma.InputJsonValue } })).id;
        await db.kgTaskSettings.create({ data: { taskId, userId, mode: 'learn' } });
      }
      const existing = await this.store.findProcedureForTask(userId, taskId);
      const procedure = existing ?? { id: `kgp-${randomUUID()}`, owner: userId, task: taskId, name: p.task.name.slice(0, 200), activeVersion: null, createdAt: now, updatedAt: now };
      if (!existing) await this.store.putProcedure(procedure);
      const number = ((await this.store.listVersions(userId, procedure.id))[0]?.number ?? 0) + 1;
      const version = procedureVersionSchema.parse({ ...draft, procedure: procedure.id, number });
      await this.store.putVersion(userId, version);
      // The owner reviews the whole procedure: every site, send, payment, account and saved login it uses.
      const blank = procedureVersionSchema.parse({ id: 'blank', procedure: procedure.id, number: 1, state: 'retired', changeClass: 'initial', sourceRun: null, parent: null, createdAt: now, entry: 'x', steps: [{ id: 'x', kind: 'check', label: 'nothing' }] });
      const classification = classifyRepair(blank, version, diffVersions(blank, version), tools);
      const reviewId = await this.reviews.open(userId, version.id, procedure.id, { changeClass: 'sensitive', reasons: [{ reason: 'commit_step', detail: 'an imported procedure: review all of it' }, ...classification.reasons] });
      imported.push({ index, taskId, procedureId: procedure.id, versionId: version.id, reviewId });
    }
    // Site facts (E46.31): never trusted, each validated and stored `proposed`, waiting for the owner in Reviews whatever the file says.
    const siteFacts = await this.siteFacts.importFacts(userId, (raw as { siteFacts?: unknown } | null)?.siteFacts);
    await this.prisma.auditEvent.create({ data: { actorUserId: userId, action: 'kgraph.imported', targetType: 'user', targetId: userId, meta: { imported: imported.length, skipped: skipped.length, siteFacts: siteFacts.proposed } } }).catch(() => undefined);
    return { imported, skipped, siteFacts };
  }
}
