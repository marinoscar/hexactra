// The Knowledge Graph's replay (E46.9, #783): binds the executor's ports to this run and runs a usable procedure between `beforeLoop` and
// `loop.run`. Entered ONLY when `modeFor` is `reuse` and the task has an active, verified or candidate version; otherwise this returns null
// before doing anything. Every call goes through `executeTool` (the harness bridge); the steps are ordinary step rows. Anything that does not
// match hands the run to the loop with one note in the model's log. Any error is caught, counted and handed over: it never fails the run.
import type { RunOutcome } from '@marinoscar/hexactra-agent';
import { currentUrl } from '@marinoscar/hexactra-browser-agent/page';
import { abortableSleep } from '@marinoscar/hexactra-browser-agent/surface';
import { breaker, checkOutcome, isAuditRun, noopTelemetry, RecoveryLadder, registrableDomain, type ProcedureVersion, type RunVerdict } from '@marinoscar/hexactra-kgraph';
import { interruptStrategy, type SiteMemory } from './interrupts';
import { hostRungs } from './recovery';
import { harnessJudge, harnessProbe, harnessToolInvoker, replayPhase, watchCalls, type ReplayMemory } from '@marinoscar/hexactra-kgraph/harness';

import { declaredOutputs, learnShapes, readShapes } from '../../../kgraph/output-shapes';
import { readRunInputs } from '../../../tasks/task-params.schemas';
import type { BuiltRun } from '../build-context';
import { surfaceInvoker } from './surface';
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
    if (!version) {
      // A suspended procedure (E46.12): the run skips replay and is recorded as AI only; its success compiles a fresh candidate.
      const suspended = versions.find((v) => v.state === 'suspended');
      if (suspended) await recordKgRun(d, userId, run.id, suspended.id, 'ai_only', true);
      return null;
    }
    // An audit run (E46.11): every Nth run of the task runs with AI only, chosen here from the task's run count, never by a model or a page.
    if (!pinned && version.state !== 'candidate') {
      const { auditEvery } = await d.kgraph.systemSettingsOf();
      const n = await d.prisma.run.count({ where: { userId, taskId: run.taskId, createdAt: { lte: run.createdAt } } });
      if (isAuditRun(n, auditEvery)) {
        await recordKgRun(d, userId, run.id, version.id, 'ai_only', true);
        return null;
      }
    }
  } catch (err) {
    d.log.warn(`run ${run.id}: kgraph replay not started: ${err instanceof Error ? err.name : 'error'}`);
    return null;
  }

  const state: ReplayMemory = memory.kgraphReplay?.version === version.id ? memory.kgraphReplay : { version: version.id, done: [], intent: null, handedOver: false };
  memory.kgraphReplay = state;
  const original = ctx.ports.observer;
  const { observer, watch } = watchCalls(original);
  (ctx.ports as { observer?: typeof observer }).observer = observer;
  const declared = declaredOutputs(run.outputsSpec);
  const pacing = (await d.kgraph.systemSettingsOf().catch(() => null))?.pacing ?? 'human';
  const shapes = declared.length ? await readShapes(d.prisma, userId, version.id).catch(() => ({})) : {};
  try {
    const inputs: Record<string, unknown> = {};
    for (const [key, v] of Object.entries(readRunInputs(run.inputs)?.values ?? {})) inputs[`p:${key}`] = v.value;
    const base = harnessToolInvoker(ctx, profile, watch);
    const siteOf = async (url: string | null): Promise<SiteMemory | null> => {
      const host = url ? new URL(url).hostname : null;
      if (!host) return null;
      return ((await d.prisma.forUser({ userId }).kgNode.findFirst({ where: { userId, type: 'Site', key: registrableDomain(host) } }))?.props ?? null) as SiteMemory | null;
    };
    const overrides = new Map<string, string>();
    const judge = harnessJudge(ctx, ctx.ports.policy.routing.route('fast'));
    const propose = async (p: { step: string; element: string; rung: string; selector: string }) => {
      await d.prisma.forUser({ userId }).kgNode.create({ data: { id: `kgn-${ctx.ports.ids.uuid()}`, userId, type: 'FingerprintProposal', key: `${version!.id}:${p.step}:${run.id}`.slice(0, 500), label: p.rung, props: { ...p, versionId: version!.id, runId: run.id } } });
    };
    const result = await replayPhase({
      recovery: new RecoveryLadder([interruptStrategy({ browser: ctx.ext.browser, invoke: base, site: siteOf }), ...hostRungs({ browser: ctx.ext.browser, version, overrides, judge, signal: ctx.ports.control.haltSignal, propose })]),
      ctx,
      version,
      inputs,
      ports: {
        store: d.kgraphStore,
        tools: surfaceInvoker(base, version, ctx.ext.browser, async (id) => ((await d.prisma.forUser({ userId }).kgNode.findFirst({ where: { userId, type: 'Element', key: id } }))?.props ?? null) as never, {
          familyOf: (tool) => profile.registry.list(ctx).find((t) => t.name === tool)?.family ?? 'browser',
          pacing,
          signal: ctx.ports.control.haltSignal,
          location: () => currentUrl(ctx as never),
          overrides,
        }),
        probe: harnessProbe(() => currentUrl(ctx as never), watch),
        judge,
        clock: { now: () => new Date(ctx.ports.clock.now()), sleep: async (ms) => void (await abortableSleep(ms, ctx.ports.control.haltSignal)) },
        ids: { next: (p) => `${p}${ctx.ports.ids.uuid()}` },
        telemetry: noopTelemetry,
      },
      memory: state,
      save: () => ctx.checkpoint(),
      // A candidate's first replay is its verification run (E46.10): every commit-class step asks the owner first.
      verify: version.state === 'candidate',
      outputs: declared.map((o) => o.key),
      // Outcome checks (E46.11): a replay that finishes with a missing, mistyped or implausible output hands over instead of succeeding.
      ...(declared.length ? { checkOutcome: (outputs: Record<string, unknown>) => checkOutcome(declared, outputs, shapes) } : {}),
    });
    const v = version;
    if (result.kind === 'finished' && declared.length) await learnShapes(d.prisma, userId, v.id, declared, result.report.outputs).catch(() => undefined);
    if (result.kind === 'handover' && result.note.startsWith('The saved procedure finished but')) await d.kgraphStore.recordEvidence(userId, v.id, null, 'failure', new Date().toISOString()).catch(() => undefined);
    const outcomeFailed = result.kind === 'handover' && result.note.startsWith('The saved procedure finished but');
    await recordKgRun(d, userId, run.id, version.id, result.kind === 'finished' ? 'replayed' : outcomeFailed ? 'outcome_failed' : result.kind === 'handover' ? 'fell_back' : null);
    if (result.kind !== 'outcome') await protect(d, userId, run.taskId!, version);
    if (version.state === 'candidate' && result.kind !== 'outcome') await settleVerification(d, userId, version.id, result.kind === 'finished');
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

/**
 * The end of a verification run (E46.10): a clean finish promotes the candidate to the procedure's one active version (compare-and-set: of two
 * racing jobs one wins); a handover retires it, and the run the agent finishes is compiled into a new candidate. Best effort.
 */
async function settleVerification(d: HostDeps, userId: string, versionId: string, clean: boolean): Promise<void> {
  try {
    const moved = clean ? await d.kgraphStore!.activate(userId, versionId, 'candidate') : await d.kgraphStore!.setVersionState(userId, versionId, 'candidate', 'retired');
    if (moved) await d.prisma.auditEvent.create({ data: { actorUserId: userId, action: clean ? 'kgraph.version.verified' : 'kgraph.version.retired', targetType: 'kgraph_version', targetId: versionId, meta: { versionId } } });
  } catch (err) {
    d.log.warn(`kgraph version ${versionId}: verification not settled: ${err instanceof Error ? err.name : 'error'}`);
  }
}

/**
 * The circuit breaker (E46.12): over the outcomes of this version's own runs, oldest first. A suspension is a compare-and-set on `active`, so
 * of two jobs only one suspends and only one notification is sent. Best effort: never changes the run.
 */
async function protect(d: HostDeps, userId: string, taskId: string, version: ProcedureVersion): Promise<void> {
  try {
    if (version.state !== 'active' || !d.kgraph) return;
    const rows = await d.prisma.forUser({ userId }).kgRun.findMany({ where: { userId, procedureVersionId: version.id, outcome: { in: ['replayed', 'fell_back', 'outcome_failed'] } }, orderBy: { createdAt: 'asc' }, select: { outcome: true } });
    const history: RunVerdict[] = rows.map((r) => (r.outcome === 'replayed' ? 'clean' : r.outcome === 'outcome_failed' ? 'outcome_failed' : 'agent'));
    const { suspendAfterFailures } = await d.kgraph.systemSettingsOf();
    const verdict = breaker(history, suspendAfterFailures);
    if (!verdict.suspend) return;
    if (!(await d.kgraphStore!.setVersionState(userId, version.id, 'active', 'suspended'))) return;
    await d.prisma.auditEvent.create({ data: { actorUserId: userId, action: 'kgraph.version.suspended', targetType: 'kgraph_version', targetId: version.id, meta: { versionId: version.id, reason: verdict.reason } } });
    const task = await d.prisma.forUser({ userId }).task.findFirst({ where: { id: taskId, userId }, select: { name: true } });
    await d.notifier?.kgraphSuspended?.(userId, taskId, task?.name ?? 'a task', version.id);
  } catch (err) {
    d.log.warn(`kgraph version ${version.id}: breaker not applied: ${err instanceof Error ? err.name : 'error'}`);
  }
}

/** The run's Knowledge Graph facts (best effort). */
async function recordKgRun(d: HostDeps, userId: string, runId: string, versionId: string, outcome: string | null, aiOnly = false): Promise<void> {
  try {
    const data = { mode: 'reuse', procedureVersionId: versionId, aiOnly, ...(outcome ? { outcome } : {}) };
    await d.prisma.kgRun.upsert({ where: { runId }, create: { runId, userId, ...data }, update: data });
  } catch (err) {
    d.log.warn(`run ${runId}: kg_runs not written: ${err instanceof Error ? err.name : 'error'}`);
  }
}
