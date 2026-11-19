// ControlPort over the job's stop signal (E38.1, E38.2) and the run's flags in the database.
import type { PrismaService } from '../../prisma/prisma.service';
import type { ControlPort } from '../harness';
import type { RunStopSignal } from '../stop-signal';

export function controlPort(stop: RunStopSignal, db: ReturnType<PrismaService['forUser']>, runId: string): ControlPort {
  return {
    get requested() {
      return stop.requested;
    },
    get pauseRequested() {
      return stop.pauseRequested;
    },
    get abortSignal() {
      return stop.abortSignal;
    },
    get haltSignal() {
      return stop.haltSignal;
    },
    async readFlags() {
      const flags = await db.run.findFirst({ where: { id: runId }, select: { cancelRequested: true, pauseRequested: true } });
      return { cancelRequested: Boolean(flags?.cancelRequested), pauseRequested: flags?.pauseRequested === true };
    },
  };
}
