// The owner's learned procedures as tools of a run (E46.22): `procedures_list` and `run_procedure`, offered ONLY when the run's Knowledge
// Graph mode is `reuse` (build-context.ts asks `KgraphEnabledService.modeFor`), registered after every other tool so a run with the feature
// off is offered exactly what it was before. A procedure runs through the run's own tool wrapper, step by step (every gate, Stop and Pause
// apply); the walk itself is the package's (`runSubProcedure`), bound to the console by `host/kgraph/sub-procedure.ts` and handed in here.
import { z } from 'zod';

import { defineRunnerTool, type RunnerTool, type ToolFamily } from '@marinoscar/hexactra-agent';
import type { HostContext } from '../context';

/** What the tools reach: the owner's active procedures and the walk of one, as bound by the host for this run. */
export interface ProceduresPort {
  /** The owner's active procedures other than this task's own, one line each (masked names, parameter names, outputs). */
  list(ctx: HostContext): Promise<{ text: string; count: number }>;
  /** Runs one as a sub-procedure: whether it finished and what the model reads. */
  run(ctx: HostContext, procedureId: string, parameters: Record<string, string>): Promise<{ ok: boolean; text: string }>;
}

/** The family (docs/decisions/tool-families.md): a run in `reuse` mode reads one line about it. */
export const proceduresFamily: ToolFamily<HostContext> = {
  id: 'procedures',
  title: "The owner's saved procedures",
  whenToUse: "Steps learned from the owner's earlier runs of their tasks (a site's sign-in, an export), repeated without the model. Use one when it does exactly a part of the goal: list them with procedures_list.",
  rank: 40,
};

export function procedureTools(port: ProceduresPort): RunnerTool<HostContext>[] {
  const list = defineRunnerTool({
    name: 'procedures_list',
    group: 'procedures',
    family: 'procedures',
    description: "List the owner's saved procedures you can run with run_procedure: each one's id, what it does, the parameters it takes and what it returns.",
    parameters: z.object({}),
    execute: async (ctx: HostContext) => {
      const started = Date.now();
      const out = await port.list(ctx);
      await ctx.record('action', 'procedures_list', {}, true, `listed ${out.count} saved procedure${out.count === 1 ? '' : 's'}`, started);
      return out.text;
    },
  });
  const run = defineRunnerTool({
    name: 'run_procedure',
    group: 'procedures',
    family: 'procedures',
    description:
      "Run one of the owner's saved procedures (from procedures_list) now, in this run, with its parameters. Each of its steps passes the same checks as your own actions. " +
      'If it stops, look at the page and continue yourself. A procedure cannot run another one. Never pass a sensitive value: it comes from the run itself.',
    parameters: z.object({
      procedure_id: z.string().min(1).max(200),
      parameters: z.array(z.object({ name: z.string().min(1).max(100), value: z.string().max(500) })).max(50).nullable(),
    }),
    execute: async (ctx: HostContext, { procedure_id, parameters }) => {
      const started = Date.now();
      const out = await port.run(ctx, procedure_id, Object.fromEntries((parameters ?? []).map((p) => [p.name, p.value])));
      // The step names the procedure and its parameters' names, never their values; the procedure's own steps are rows of their own.
      await ctx.record('action', 'run_procedure', { procedure_id, parameters: (parameters ?? []).map((p) => p.name) }, out.ok, out.ok ? `ran the saved procedure ${procedure_id}` : `the saved procedure ${procedure_id} stopped`, started);
      return out.text;
    },
  });
  return [list as unknown as RunnerTool<HostContext>, run as unknown as RunnerTool<HostContext>];
}
