// Whether a run gets the Knowledge Graph's observer (E46.5): only when `KgraphEnabledService.modeFor` says `learn` or `reuse`. Asked once per
// job; any error is `off` (no observer), so the run is exactly as without the feature.
import type { Logger } from '@nestjs/common';

import type { KgraphEnabledService } from '../../../kgraph/kgraph-enabled.service';
import type { PrismaService } from '../../../prisma/prisma.service';
import { KgraphObserver, type KgraphObserverInput } from './observer-port';

export interface ObserverRun {
  id: string;
  taskId: string | null;
  goal: string;
  inputs: unknown;
  trigger: string | null;
  conversationId: string | null;
}

type ObserverDeps = { kgraph?: Pick<KgraphEnabledService, 'modeFor' | 'systemSettingsOf'> & Partial<Pick<KgraphEnabledService, 'everydayFor'>>; prisma: PrismaService; log: Logger };

export async function kgraphObserverFor(d: { kgraph?: Pick<KgraphEnabledService, 'modeFor' | 'systemSettingsOf'> & Partial<Pick<KgraphEnabledService, 'everydayFor'>>; prisma: PrismaService; log: Logger }, userId: string, run: ObserverRun, aiOnly = false, capture?: KgraphObserverInput['capture']): Promise<KgraphObserver | undefined> {
  if (!d.kgraph) return undefined;
  const isTaskRun = run.taskId !== null && run.trigger !== 'chat' && !run.conversationId;
  const mode = await d.kgraph.modeFor({ userId, taskId: run.taskId, run: { isTaskRun, aiOnly } }).catch(() => 'off' as const);
  if (mode === 'off') return everydayObserverFor(d, userId, run, isTaskRun, capture);
  // The run's Knowledge Graph facts (its mode), which the savings ledger reads when the run ends (E46.6). Best effort, outside any step.
  try {
    await d.prisma.forUser({ userId }).kgRun.upsert({ where: { runId: run.id }, create: { runId: run.id, userId, mode, aiOnly }, update: { mode } });
  } catch (err) {
    d.log.warn(`run ${run.id}: kgraph run facts not written: ${err instanceof Error ? err.name : 'error'}`);
  }
  return new KgraphObserver({ prisma: d.prisma, log: d.log, userId, runId: run.id, goal: run.goal, inputs: run.inputs, ...(capture ? { capture } : {}) });
}

/**
 * The everyday observer (E46.36): a chat or one-off run (never a saved task's run) whose owner turned on `kgraph.everyday` records its
 * surface (shared elements with masked labels, and one `RunSurface` node per call) so site facts can be derived after it, and its `kg_runs`
 * row says `everyday` so the run's end queues the derive job. No trace row: nothing is ever compiled from it. Off (or any error): no
 * observer, no write, so the run is exactly as without the feature.
 */
async function everydayObserverFor(d: ObserverDeps, userId: string, run: ObserverRun, isTaskRun: boolean, capture?: KgraphObserverInput['capture']): Promise<KgraphObserver | undefined> {
  if (!d.kgraph?.everydayFor || isTaskRun) return undefined;
  if (!(await d.kgraph.everydayFor(userId, { isTaskRun }).catch(() => false))) return undefined;
  try {
    await d.prisma.forUser({ userId }).kgRun.upsert({ where: { runId: run.id }, create: { runId: run.id, userId, mode: 'everyday' }, update: {} });
  } catch (err) {
    d.log.warn(`run ${run.id}: kgraph everyday run facts not written: ${err instanceof Error ? err.name : 'error'}`);
  }
  return new KgraphObserver({ prisma: d.prisma, log: d.log, userId, runId: run.id, goal: run.goal, inputs: run.inputs, surfaceOnly: true, ...(capture ? { capture } : {}) });
}
