// The Knowledge Graph's replay (E46.9, #783): binds the executor's ports to this run and runs a usable procedure between `beforeLoop` and
// `loop.run`. Entered ONLY when `modeFor` is `reuse` and the task has an active, verified or candidate version; otherwise this returns null
// before doing anything. Every call goes through `executeTool` (the harness bridge); the steps are ordinary step rows. Anything that does not
// match hands the run to the loop with one note in the model's log. Any error is caught, counted and handed over: it never fails the run.
import type { RunOutcome } from '@marinoscar/hexactra-agent';
import { currentUrl } from '@marinoscar/hexactra-browser-agent/page';
import { noopTelemetry, type ProcedureVersion } from '@marinoscar/hexactra-kgraph';
import { harnessJudge, harnessProbe, harnessToolInvoker, replayPhase, watchCalls, type ReplayMemory } from '@marinoscar/hexactra-kgraph/harness';

import { readOutputs } from '../../../tasks/task-outputs.schemas';
import { readRunInputs } from '../../../tasks/task-params.schemas';
import type { BuiltRun } from '../build-context';
import type { HostDeps } from '../deps';
import type { RunStart } from '../start';

type KgMemory = { kgraphReplay?: ReplayMemory };

/** The version a reuse run replays: active, else verified, else the newest candidate (its verification run). */
export function usableVersion(versions: readonly ProcedureVersion[]): ProcedureVersion | null {
  return versions.find((v) => v.state === 'active') ?? versions.find((v) => v.state === 'verified') ?? versions.find((v) => v.state === 'candidate') ?? null;
}

export async function maybeReplay(d: HostDeps, built: BuiltRun, s: RunStart): Promise<RunOutcome | null> {
  if (!d.kgraph || !d.kgraphStore) return null;
  const { ctx, profile } = built;
  const { run, userId } = s;
  const memory = ctx.memory as typeof ctx.memory & KgMemory;
  if (memory.kgraphReplay?.handedOver) return null;
  let version: ProcedureVersion | null = null;
  try {
    const isTaskRun = run.taskId !== null && run.trigger !== 'chat' && !run.conversationId;
    if ((await d.kgraph.modeFor({ userId, taskId: run.taskId, run: { isTaskRun } })) !== 'reuse' || !run.taskId) return null;
    const procedure = await d.kgraphStore.findProcedureForTask(userId, run.taskId);
    if (!procedure) return null;
    const versions = await d.kgraphStore.listVersions(userId, procedure.id);
    const pinned = memory.kgraphReplay?.version;
    version = (pinned ? versions.find((v) => v.id === pinned) : null) ?? usableVersion(versions);
    if (!version) return null;
  } catch (err) {
    d.log.warn(`run ${run.id}: kgraph replay not started: ${err instanceof Error ? err.name : 'error'}`);
    return null;
  }

  const state: ReplayMemory = memory.kgraphReplay?.version === version.id ? memory.kgraphReplay : { version: version.id, done: [], intent: null, handedOver: false };
  memory.kgraphReplay = state;
  const original = ctx.ports.observer;
  const { observer, watch } = watchCalls(original);
  (ctx.ports as { observer?: typeof observer }).observer = observer;
  try {
    const inputs: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(readRunInputs(run.inputs)?.values ?? {})) inputs[`p:${key}`] = v.value;
    const result = await replayPhase({
      ctx,
      version,
      inputs,
      ports: {
        store: d.kgraphStore,
        tools: harnessToolInvoker(ctx, profile, watch),
        probe: harnessProbe(() => currentUrl(ctx as never), watch),
        judge: harnessJudge(ctx, ctx.ports.policy.routing.route('fast')),
        clock: { now: () => new Date(ctx.ports.clock.now()), sleep: (ms) => new Promise((r) => setTimeout(r, ms)) },
        ids: { next: (p) => `${p}${ctx.ports.ids.uuid()}` },
        telemetry: noopTelemetry,
      },
      memory: state,
      save: () => ctx.checkpoint(),
      outputs: readOutputs(run.outputsSpec).map((o) => (o as { key?: string }).key ?? o.label),
    });
    await recordKgRun(d, userId, run.id, version.id, result.kind === 'finished' ? 'replayed' : result.kind === 'handover' ? 'fell_back' : null);
    return result.kind === 'handover' ? null : result.outcome;
  } catch (err) {
    d.log.warn(`run ${run.id}: kgraph replay error, handing over: ${err instanceof Error ? err.name : 'error'}`);
    state.handedOver = true;
    await ctx.checkpoint().catch(() => undefined);
    return null;
  } finally {
    (ctx.ports as { observer?: typeof observer }).observer = original;
  }
}

/** The run's Knowledge Graph facts (best effort). */
async function recordKgRun(d: HostDeps, userId: string, runId: string, versionId: string, outcome: string | null): Promise<void> {
  try {
    const data = { mode: 'reuse', procedureVersionId: versionId, ...(outcome ? { outcome } : {}) };
    await d.prisma.kgRun.upsert({ where: { runId }, create: { runId, userId, ...data }, update: data });
  } catch (err) {
    d.log.warn(`run ${runId}: kg_runs not written: ${err instanceof Error ? err.name : 'error'}`);
  }
}
