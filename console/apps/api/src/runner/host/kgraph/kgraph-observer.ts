// Whether a run gets the Knowledge Graph's observer (E46.5): only when `KgraphEnabledService.modeFor` says `learn` or `reuse`. Asked once per
// job; any error is `off` (no observer), so the run is exactly as without the feature.
import type { Logger } from '@nestjs/common';
import type { ObserverPort } from '@marinoscar/hexactra-agent';

import type { KgraphEnabledService } from '../../../kgraph/kgraph-enabled.service';
import type { PrismaService } from '../../../prisma/prisma.service';
import { KgraphObserver } from './observer-port';

export interface ObserverRun {
  id: string;
  taskId: string | null;
  goal: string;
  inputs: unknown;
  trigger: string | null;
  conversationId: string | null;
}

export async function kgraphObserverFor(d: { kgraph?: Pick<KgraphEnabledService, 'modeFor'>; prisma: PrismaService; log: Logger }, userId: string, run: ObserverRun, aiOnly = false): Promise<ObserverPort | undefined> {
  if (!d.kgraph) return undefined;
  const isTaskRun = run.taskId !== null && run.trigger !== 'chat' && !run.conversationId;
  const mode = await d.kgraph.modeFor({ userId, taskId: run.taskId, run: { isTaskRun, aiOnly } }).catch(() => 'off' as const);
  if (mode === 'off') return undefined;
  return new KgraphObserver({ prisma: d.prisma, log: d.log, userId, runId: run.id, goal: run.goal, inputs: run.inputs });
}
