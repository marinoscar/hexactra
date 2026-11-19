import { randomUUID } from 'node:crypto';

import type { PrismaService } from '../prisma/prisma.service';

/** Statuses in which a job may hold a run. A finished run is held by nobody. */
const HOLDABLE = ['queued', 'running', 'waiting_human'] as const;

/** The job found another token on the run: it lost the run and must stop at once without touching it (E38.3). */
export class LeaseLost extends Error {
  constructor(readonly runId: string) {
    super(`run ${runId}: another job took over this run`);
  }
}

/**
 * The right of one job to drive one run (E38.3). `runs.worker_token` is set when `advance` starts and cleared when it ends
 * cleanly; every write of a step and of the memory is conditional on it, and every action asks `held()` before it is sent.
 * The job that claimed last owns the run: a retried job (its predecessor died, so the token was never cleared) takes over, and
 * the predecessor, if it is somehow alive, stops at its next action. Two jobs never act on one run.
 */
export class RunLease {
  private constructor(
    private readonly prisma: PrismaService,
    readonly runId: string,
    readonly userId: string,
    readonly token: string,
    /** The token the run held when this job claimed it: not null means the last job never ended cleanly (a crash, a deploy). */
    readonly previous: string | null,
  ) {}

  static async claim(prisma: PrismaService, userId: string, runId: string): Promise<RunLease> {
    const db = prisma.forUser({ userId });
    const row = await db.run.findFirst({ where: { id: runId, status: { in: [...HOLDABLE] } }, select: { workerToken: true } });
    const token = randomUUID();
    if (row) await db.run.updateMany({ where: { id: runId, status: { in: [...HOLDABLE] } }, data: { workerToken: token } });
    return new RunLease(prisma, runId, userId, token, row?.workerToken ?? null);
  }

  /** The condition every write of this job adds to its `where`. */
  get guard(): { workerToken: string } {
    return { workerToken: this.token };
  }

  /** Whether this job still holds the run (one small read; asked before each action is sent). */
  async held(): Promise<boolean> {
    const row = await this.prisma.forUser({ userId: this.userId }).run.findFirst({ where: { id: this.runId }, select: { workerToken: true } });
    return row?.workerToken === this.token;
  }

  /** The job ended cleanly (finished, paused, handed the run on): clear the token if it is still ours. */
  async release(): Promise<void> {
    await this.prisma.forUser({ userId: this.userId }).run.updateMany({ where: { id: this.runId, workerToken: this.token }, data: { workerToken: null } });
  }
}
