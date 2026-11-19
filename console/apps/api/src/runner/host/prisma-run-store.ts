// RunStorePort over Prisma, the tasks service and the run lease: where a run is kept. Every write is conditional on this job still holding
// the run (E38.3).
import type { FabricSession } from '../fabric-session';
import { appendConfirmedAction } from '../confirmed-actions';
import { runActivity, type ActivityOptions, type CheckpointInput, type CommitStepInput, type NewStep, type RunActivityPhase, type RunStopReason, type RunStorePort, type StepPatch, type StoredStep, type Transition } from '../harness';
import type { RunLease } from '../lease';
import { finishRun, pauseRunRaw, saveMemoryRaw } from './finish-run';
import type { HostDeps } from './deps';
import type { RunMemory } from './run-memory';

export interface StoreRun {
  id: string;
}

export class PrismaRunStore implements RunStorePort {
  private readonly db;

  constructor(
    private readonly d: HostDeps,
    private readonly userId: string,
    private readonly runId: string,
    private readonly lease: RunLease,
    private readonly hooks: { run: StoreRun; session: FabricSession; sessionId: () => string | null },
  ) {
    this.db = d.prisma.forUser({ userId });
  }

  holdsRun(): Promise<boolean> {
    return this.lease.held();
  }

  checkpoint({ memory, usage }: CheckpointInput): Promise<boolean> {
    return saveMemoryRaw(this.d, this.userId, this.runId, memory as RunMemory, usage, this.lease);
  }

  async commitStep({ memory, stepCount, step, finishesIntent }: CommitStepInput): Promise<boolean> {
    const { seq, ...row } = step;
    const data = { ...row, args: row.args as never };
    return this.d.prisma.$transaction(async (tx) => {
      const { count } = await tx.run.updateMany({ where: { id: this.runId, ...this.lease.guard }, data: { stepCount, transcript: memory as never } });
      if (count === 0) return false;
      if (finishesIntent) await tx.runStep.update({ where: { runId_seq: { runId: this.runId, seq } }, data });
      else await tx.runStep.create({ data: { runId: this.runId, seq, ...data } });
      return true;
    });
  }

  async saveMemory(memory: NewStepMemory): Promise<boolean> {
    const saved = await this.db.run.updateMany({ where: { id: this.runId, ...this.lease.guard }, data: { transcript: memory as never } });
    return saved.count > 0;
  }

  async openIntent(memory: NewStepMemory, step: NewStep): Promise<boolean> {
    if (!(await this.saveMemory(memory))) return false;
    await this.d.prisma.runStep.create({ data: { runId: this.runId, ...step, args: step.args as never } });
    return true;
  }

  async appendStep(step: NewStep): Promise<void> {
    await this.d.prisma.runStep.create({ data: { runId: this.runId, ...step, args: step.args as never } });
  }

  async getStep(seq: number): Promise<(StoredStep & { screenshotKey: string | null }) | null> {
    const row = await this.d.prisma.runStep.findFirst({ where: { runId: this.runId, seq }, select: { seq: true, kind: true, action: true, args: true, ok: true, phase: true, summary: true, screenshotKey: true } });
    return row;
  }

  async patchStep(seq: number, patch: StepPatch): Promise<void> {
    await this.d.prisma.runStep.updateMany({ where: { runId: this.runId, seq }, data: { ...patch, args: patch.args as never } });
  }

  async newestSeq(): Promise<number> {
    const last = await this.d.prisma.runStep.aggregate({ where: { runId: this.runId }, _max: { seq: true } });
    return last._max.seq ?? 0;
  }

  async stepsToReconcile(afterSeq: number | undefined): Promise<StoredStep[]> {
    return this.d.prisma.runStep.findMany({
      where: afterSeq === undefined ? { runId: this.runId, phase: 'intent' } : { runId: this.runId, OR: [{ seq: { gt: afterSeq } }, { phase: 'intent' }] },
      orderBy: { seq: 'asc' },
    });
  }

  async markUnknown(seq: number, summary: string): Promise<void> {
    await this.d.prisma.runStep.update({ where: { runId_seq: { runId: this.runId, seq } }, data: { phase: 'unknown', ok: false, summary } });
  }

  async setActivity(phase: RunActivityPhase, options: ActivityOptions): Promise<void> {
    try {
      await this.db.run.updateMany({ where: { id: this.runId, status: 'running' }, data: { activity: runActivity(phase, options) as never } });
    } catch (e) {
      this.d.log.debug(`run ${this.runId}: could not record its activity: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  async setTier(tier: string, escalations: number): Promise<void> {
    await this.db.run.updateMany({ where: { id: this.runId }, data: { currentTier: tier as never, escalations } });
  }

  async appendConfirmedAction(entry: { seq: number; prompt: string; action: string; at: Date }): Promise<void> {
    const row = await this.db.run.findFirst({ where: { id: this.runId }, select: { confirmedActions: true } });
    const next = appendConfirmedAction(row?.confirmedActions ?? null, entry);
    await this.db.run.updateMany({ where: { id: this.runId }, data: { confirmedActions: next as never } });
  }

  /**
   * Folds the owner's pending chat guidance into the run (#490), each line once: a line is claimed by setting `deliveredAt`, so two jobs of
   * one run cannot both take it. Guidance is advice: the run's limits (allowed sites, confirmation before purchases) are checked in code and
   * do not change with it. A failure here never fails the run.
   */
  async takeGuidance(): Promise<string[]> {
    const taken: string[] = [];
    try {
      const pending = await this.d.prisma.runGuidance.findMany({ where: { runId: this.runId, deliveredAt: null }, orderBy: { createdAt: 'asc' }, take: 10, select: { id: true, note: true } });
      for (const g of pending) {
        const claimed = await this.d.prisma.runGuidance.updateMany({ where: { id: g.id, deliveredAt: null }, data: { deliveredAt: new Date() } });
        if (claimed.count) taken.push(g.note);
      }
    } catch (e) {
      this.d.log.warn(`run ${this.runId}: could not read the chat guidance: ${e instanceof Error ? e.message : String(e)}`);
    }
    return taken;
  }

  async transition(to: Transition, patch: { handoffId?: string | null; handoffExpiresAt?: Date | null } = {}): Promise<void> {
    await this.d.tasks.transition(this.userId, this.runId, to, patch);
  }

  pause(patch: { handoffId?: string | null } = {}): Promise<boolean> {
    return pauseRunRaw(this.d, this.userId, this.runId, patch);
  }

  finish(to: 'succeeded' | 'failed' | 'cancelled', patch: { result?: string; error?: string; stopReason?: string }): Promise<void> {
    return finishRun(this.d, this.userId, this.runId, this.hooks.sessionId(), this.hooks.session, to, patch as { result?: string; error?: string; stopReason?: RunStopReason });
  }
}

type NewStepMemory = Parameters<RunStorePort['saveMemory']>[0];
