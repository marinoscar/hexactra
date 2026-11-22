// E46.7 (#781): compiles one run's trace into a `candidate` procedure version. Runs only in the `kgraph.compile` queue job, never in a
// request or a run. Only a clean success compiles: the run `succeeded`, its declared outputs are complete, and no step is left `unknown`.
// The tool catalogue is what the server recorded about each call (name, family, commits), never anything the model or a page said.
import { randomUUID } from 'node:crypto';

import { Injectable, Logger } from '@nestjs/common';
import type { Prisma } from '@prisma/client';
import { classifyRepair, compileTrace, diffVersions, type ProcedureVersion, type Tool, type TraceBinding, type TraceEvent } from '@marinoscar/hexactra-kgraph';

import { PrismaService } from '../prisma/prisma.service';
import { consoleIsSensitive } from '../runner/host/kgraph/observer-port';
import { readOutputs } from '../tasks/task-outputs.schemas';
import { readParameters } from '../tasks/task-params.schemas';
import { PrismaProcedureStore } from './prisma-procedure-store';
import { changeSignature, KgraphReviewsService } from './reviews.service';

export type CompileOutcome = 'compiled' | 'repaired_structural' | 'repaired_sensitive' | 'repair_suppressed' | 'rejected' | 'empty' | 'skipped_not_clean' | 'skipped_has_version' | 'skipped_done' | 'skipped_no_trace';

@Injectable()
export class KgraphCompileService {
  private readonly log = new Logger(KgraphCompileService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly store: PrismaProcedureStore,
    private readonly reviews: KgraphReviewsService,
  ) {}

  async compileRun(userId: string, runId: string): Promise<CompileOutcome> {
    const db = this.prisma.forUser({ userId });
    const run = await db.run.findFirst({ where: { id: runId, userId }, select: { id: true, status: true, taskId: true, outputsComplete: true, task: { select: { id: true, name: true, parameters: true, outputs: true } } } });
    if (!run?.task || run.status !== 'succeeded') return 'skipped_not_clean';
    const declared = readOutputs(run.task.outputs);
    if (declared.length > 0 && run.outputsComplete !== true) return 'skipped_not_clean';
    // The run is the owner's (read above through forUser); its steps are read by run id.
    if ((await this.prisma.runStep.count({ where: { runId, phase: 'unknown' } })) > 0) return 'skipped_not_clean';
    // Idempotent per run.
    if ((await db.kgProcedureVersion.count({ where: { userId, sourceRunId: runId } })) > 0) return 'skipped_done';
    if ((await db.kgNode.count({ where: { userId, type: 'CompileRejection', key: runId } })) > 0) return 'skipped_done';

    const existing = await this.store.findProcedureForTask(userId, run.task.id);
    const versions = existing ? await this.store.listVersions(userId, existing.id) : [];
    // A repair (E46.17): the run replayed a version, handed over, and the agent finished it. Its trace becomes a proposed new version.
    const kg = await db.kgRun.findFirst({ where: { runId, userId, outcome: { in: ['fell_back', 'outcome_failed'] } }, select: { procedureVersionId: true } });
    const repairOf: ProcedureVersion | null = (kg?.procedureVersionId && versions.find((v) => v.id === kg.procedureVersionId && (v.state === 'active' || v.state === 'verified'))) || null;
    if (!repairOf && versions.some((v) => v.state === 'candidate' || v.state === 'verified' || v.state === 'active')) return 'skipped_has_version';

    const rows = await db.kgTrace.findMany({ where: { runId, userId }, orderBy: { seq: 'asc' } });
    if (rows.length === 0) return 'skipped_no_trace';
    const trace: TraceEvent[] = rows.map((r) => ({ seq: r.seq, tool: r.tool, family: r.family, commits: r.commits, ok: r.ok, outcome: r.outcome as TraceEvent['outcome'], bindings: (r.bindings ?? {}) as Record<string, TraceBinding>, post: (r.post ?? {}) as TraceEvent['post'] }));
    const tools = new Map<string, Tool>();
    for (const r of rows) tools.set(r.tool, { name: r.tool, family: r.family, commits: (tools.get(r.tool)?.commits ?? false) || r.commits });

    const now = new Date().toISOString();
    const procedure = existing ?? { id: `kgp-${randomUUID()}`, owner: userId, task: run.task.id, name: run.task.name.slice(0, 200), activeVersion: null, createdAt: now, updatedAt: now };
    const result = compileTrace({
      procedure: procedure.id,
      version: `kgv-${randomUUID()}`,
      number: (versions[0]?.number ?? 0) + 1,
      createdAt: now,
      sourceRun: runId,
      parent: repairOf?.id ?? null,
      trace,
      tools: [...tools.values()],
      parameters: readParameters(run.task.parameters).map((p) => ({ key: p.key, name: p.label ?? p.key, sensitive: p.sensitive === true })),
      outputs: declared.map((o) => ({ name: (o as { key?: string }).key ?? o.label })),
      isSensitive: consoleIsSensitive,
    });
    if (result.status === 'candidate' && repairOf) {
      const classification = classifyRepair(repairOf, result.version, diffVersions(repairOf, result.version), [...tools.values()]);
      if (classification.changeClass === 'sensitive' && (await this.reviews.recentlyDeclined(userId, changeSignature(procedure.id, classification)))) return 'repair_suppressed';
      const version = { ...result.version, changeClass: classification.changeClass };
      await this.store.putVersion(userId, version);
      if (classification.changeClass === 'sensitive') {
        await this.reviews.open(userId, version.id, procedure.id, classification);
        this.log.log(`run ${runId}: sensitive repair ${version.id} waits for the owner (${classification.reasons.length} change(s))`);
        return 'repaired_sensitive';
      }
      this.log.log(`run ${runId}: structural repair ${version.id}: its next clean replay verifies it`);
      return 'repaired_structural';
    }
    if (result.status === 'candidate') {
      if (!existing) await this.store.putProcedure(procedure);
      await this.store.putVersion(userId, result.version);
      this.log.log(`run ${runId}: compiled candidate ${result.version.id} (${result.version.steps.length} steps, ${result.notCompilable} left to the agent)`);
      return 'compiled';
    }
    if (result.status === 'rejected') {
      // Stored, not run: the reasons (rule, step, message: names and ids, never a value) for the Knowledge Graph pages.
      await db.kgNode.create({ data: { id: `kgr-${randomUUID()}`, userId, type: 'CompileRejection', key: runId, label: 'compile rejected', props: { taskId: run.task.id, violations: result.violations } as unknown as Prisma.InputJsonValue } });
      this.log.warn(`run ${runId}: compile rejected (${result.violations.length} violation(s))`);
      return 'rejected';
    }
    return 'empty';
  }
}
