// The console's binding of a procedure called as a tool inside a run (E46.22, `run_procedure`): the owner's ACTIVE procedures (never this
// task's own), and the walk of one through the package's `runSubProcedure` over the run's own ports. Every call goes through the run's tool
// wrapper (`harnessToolInvoker`), so every gate, Stop and Pause apply; a sub-procedure cannot call one (depth 1, the package's rule). Its own
// calls are not fed to the Knowledge Graph's capture: the capture sees the one `run_procedure` call. Any error answers the model; it never
// fails the run.
import type { LoopProfile } from '@marinoscar/hexactra-agent';
import { currentUrl } from '@marinoscar/hexactra-browser-agent/page';
import { abortableSleep } from '@marinoscar/hexactra-browser-agent/surface';
import { noopTelemetry, type Procedure, type ProcedureVersion } from '@marinoscar/hexactra-kgraph';
import { harnessJudge, harnessProbe, harnessToolInvoker, runSubProcedure, watchCalls } from '@marinoscar/hexactra-kgraph/harness';

import { maskSensitive } from '../../../tasks/mask';
import { readRunInputs } from '../../../tasks/task-params.schemas';
import type { HostContext } from '../context';
import type { HostDeps } from '../deps';
import type { ProceduresPort } from '../tools/procedures';
import { surfaceInvoker } from './surface';

const mask = (t: string) => maskSensitive(t).text;
/** The most procedures `procedures_list` names. */
const LIST_LIMIT = 50;

/** The active version of a procedure, or null. */
async function activeOf(d: HostDeps, userId: string, p: Procedure): Promise<ProcedureVersion | null> {
  if (!p.activeVersion) return null;
  const v = await d.kgraphStore!.getVersion(userId, p.activeVersion);
  return v?.state === 'active' ? v : null;
}

/** The owner's active procedures other than `taskId`'s own, newest first, at most 50, each with its active version. */
export async function usableProcedures(d: HostDeps, userId: string, taskId: string | null): Promise<Array<{ p: Procedure; v: ProcedureVersion }>> {
  const all = (await d.kgraphStore!.listProcedures(userId)).filter((p) => p.task !== taskId).sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  const out: Array<{ p: Procedure; v: ProcedureVersion }> = [];
  for (const p of all) {
    if (out.length >= LIST_LIMIT) break;
    const v = await activeOf(d, userId, p);
    if (v) out.push({ p, v });
  }
  return out;
}

/** One procedure as the model reads it: its id, masked name, parameter names and non-sensitive output names. Never a value. */
export function procedureLine({ p, v }: { p: Procedure; v: ProcedureVersion }): string {
  const params = v.parameters.map((x) => `${mask(x.name)}${x.required ? '' : ' (optional)'}${x.sensitive ? ' (sensitive: from the run)' : ''}`);
  const outs = v.outputs.filter((o) => !o.sensitive).map((o) => mask(o.name));
  return `- ${p.id} "${mask(p.name)}": parameters ${params.length ? params.join(', ') : 'none'}; returns ${outs.length ? outs.join(', ') : 'nothing'}`;
}

/** What a `run_procedure` call that walked a procedure reports to the host (E46.28: the everyday ledger). Never a value. */
export interface ProcedureRan {
  versionId: string;
  /** The steps it completed without the model. */
  done: number;
  /** Whether it finished. */
  ok: boolean;
}

/**
 * The port of the `procedures` tools for one run. `profile` is read when a procedure runs (the registry and the gate pipeline of this run);
 * `taskId` is the run's own task, whose procedure is never offered as a sub-procedure. `onRan` (an everyday run, E46.28) is told when a
 * procedure was walked; its failure is the host's and never the run's.
 */
export function subProcedures(d: HostDeps, userId: string, taskId: string | null, runInputs: unknown, profile: () => LoopProfile<HostContext>, onRan?: (r: ProcedureRan) => Promise<void>): ProceduresPort {
  const usable = () => usableProcedures(d, userId, taskId);

  return {
    async list() {
      try {
        const rows = await usable();
        if (rows.length === 0) return { text: 'The owner has no other saved procedure you can run.', count: 0 };
        return { text: `Saved procedures (run one with run_procedure):\n${rows.map(procedureLine).join('\n')}`, count: rows.length };
      } catch (err) {
        d.log.warn(`procedures_list failed: ${err instanceof Error ? err.name : 'error'}`);
        return { text: 'The saved procedures could not be read. Do the work yourself.', count: 0 };
      }
    },

    async run(ctx, procedureId, parameters) {
      const p = await d.kgraphStore!.getProcedure(userId, procedureId).catch(() => null);
      if (!p || p.task === taskId) return { ok: false, text: `No saved procedure ${procedureId.slice(0, 80)} you can run. List them with procedures_list.` };
      const version = await activeOf(d, userId, p).catch(() => null);
      if (!version) return { ok: false, text: 'That procedure is not active (it has not been verified yet). Do the work yourself.' };
      const original = ctx.ports.observer;
      // Its calls feed only the invoker's watch, not the capture: the capture records the one run_procedure call.
      const { observer, watch } = watchCalls();
      (ctx.ports as { observer?: typeof observer }).observer = observer;
      try {
        const loop = profile();
        const task = await d.prisma.forUser({ userId }).task.findFirst({ where: { id: p.task, userId }, select: { goal: true } });
        const trusted: Record<string, unknown> = {};
        for (const [key, v] of Object.entries(readRunInputs(runInputs)?.values ?? {})) trusted[key] = v.value;
        const base = harnessToolInvoker(ctx, loop, watch);
        const pacing = (await d.kgraph?.systemSettingsOf().catch(() => null))?.pacing ?? 'human';
        const result = await runSubProcedure({
          ctx,
          version,
          given: parameters,
          trusted,
          goal: task?.goal ?? p.name,
          ports: {
            store: d.kgraphStore!,
            tools: surfaceInvoker(base, version, ctx.ext.browser, async (id) => ((await d.prisma.forUser({ userId }).kgNode.findFirst({ where: { userId, type: 'Element', key: id } }))?.props ?? null) as never, {
              familyOf: (tool) => loop.registry.list(ctx).find((t) => t.name === tool)?.family ?? 'browser',
              pacing,
              signal: ctx.ports.control.haltSignal,
              location: () => currentUrl(ctx as never),
            }),
            probe: harnessProbe(() => currentUrl(ctx as never), watch),
            judge: harnessJudge(ctx, ctx.ports.policy.routing.route('fast')),
            clock: { now: () => new Date(ctx.ports.clock.now()), sleep: async (ms) => void (await abortableSleep(ms, ctx.ports.control.haltSignal)) },
            ids: { next: (prefix) => `${prefix}${ctx.ports.ids.uuid()}` },
            telemetry: noopTelemetry,
          },
        });
        if (result.report && onRan) await onRan({ versionId: version.id, done: result.report.steps.filter((x) => x.status === 'done').length, ok: result.ok }).catch(() => undefined);
        return { ok: result.ok, text: result.text };
      } catch (err) {
        d.log.warn(`run ${ctx.run.id}: run_procedure failed: ${err instanceof Error ? err.name : 'error'}`);
        return { ok: false, text: 'The saved procedure could not be run. Do the work yourself.' };
      } finally {
        (ctx.ports as { observer?: typeof observer }).observer = original;
      }
    },
  };
}
