// A procedure called as a tool inside a run (E46.22, `run_procedure`): another active procedure of the same owner, walked by the same executor
// with every call through the run's one tool wrapper (the invoker the host passes is `harnessToolInvoker`), so Stop, Pause, the gates, the
// span and intent recording apply as for a model-chosen call. Depth 1: a sub-procedure that reaches `run_procedure` again is refused. Its
// parameters are bound from the call, except a sensitive one, which only the run's own inputs can fill. It never throws.
import type { AnyContext } from '@marinoscar/hexactra-agent';

import { executeProcedure, type ExecutionReport } from '../execute';
import type { KgraphPorts } from '../ports';
import type { ProcedureVersion } from '../schema';

/** The runs (contexts) that are inside a sub-procedure right now. */
const inside = new WeakSet<object>();

/** Whether this run is walking a sub-procedure now (a second level is refused). */
export function insideSubProcedure(ctx: object): boolean {
  return inside.has(ctx);
}

export interface BoundInputs {
  /** By parameter id, as the executor reads them. */
  inputs: Record<string, unknown>;
  /** Names of required parameters with no value. */
  missing: string[];
  /** Names the call gave for a sensitive parameter: never accepted from a model. */
  refused: string[];
}

/**
 * Binds the call's values (by parameter name, case-insensitive, or by key: the id without `p:`) to the version's parameters. A sensitive
 * parameter is taken only from `trusted` (the run's own inputs, keyed the same way), never from the call.
 */
export function bindParameters(version: Pick<ProcedureVersion, 'parameters'>, given: Record<string, unknown>, trusted: Record<string, unknown> = {}): BoundInputs {
  const norm = (k: string) => k.trim().toLowerCase();
  const lookup = (src: Record<string, unknown>, names: string[]) => {
    for (const [k, v] of Object.entries(src)) if (names.includes(norm(k)) && v !== undefined && v !== null && v !== '') return v;
    return undefined;
  };
  const out: BoundInputs = { inputs: {}, missing: [], refused: [] };
  for (const p of version.parameters) {
    const names = [norm(p.name), norm(p.id), norm(p.id.replace(/^p:/, ''))];
    const fromCall = lookup(given, names);
    const value = p.sensitive ? lookup(trusted, names) : fromCall;
    if (p.sensitive && fromCall !== undefined) out.refused.push(p.name);
    if (value !== undefined) out.inputs[p.id] = value;
    else if (p.required) out.missing.push(p.name);
  }
  return out;
}

export interface SubProcedureInput<C extends AnyContext> {
  ctx: C;
  version: ProcedureVersion;
  /** The call's parameter values, by name. */
  given: Record<string, unknown>;
  /** The run's own inputs (for a sensitive parameter). */
  trusted?: Record<string, unknown>;
  /** The executor's ports; `tools` must be the run's `harnessToolInvoker`. */
  ports: KgraphPorts;
  /** The sub-procedure's task goal (the owner's words), for a judge step. */
  goal: string;
}

export interface SubProcedureResult {
  ok: boolean;
  /** What the model reads. Never page text beyond a step's own (already masked) label. */
  text: string;
  report: ExecutionReport | null;
}

const clip = (s: string, n = 120) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Walks a sub-procedure inside the run. */
export async function runSubProcedure<C extends AnyContext>(input: SubProcedureInput<C>): Promise<SubProcedureResult> {
  const { ctx, version } = input;
  if (inside.has(ctx)) return { ok: false, text: 'A saved procedure cannot call another one from inside a procedure (one level only). Do this part yourself.', report: null };
  const bound = bindParameters(version, input.given, input.trusted ?? {});
  if (bound.refused.length) return { ok: false, text: `Never pass a sensitive value (${bound.refused.join(', ')}): it comes only from the run's own inputs.`, report: null };
  if (bound.missing.length) return { ok: false, text: `The procedure needs: ${bound.missing.join(', ')}. Call it again with these parameters, or do the work yourself.`, report: null };
  inside.add(ctx);
  let report: ExecutionReport;
  try {
    report = await executeProcedure(version, bound.inputs, input.ports, { goal: input.goal, before: async () => ((await ctx.preflight()) !== null ? 'stop' : 'go') });
  } catch {
    return { ok: false, text: 'The saved procedure could not be run. Do the work yourself.', report: null };
  } finally {
    inside.delete(ctx);
  }
  const done = report.steps.filter((s) => s.status === 'done').length;
  if (report.status === 'completed') {
    const outputs = Object.keys(report.outputs).length ? ` Outputs: ${clip(JSON.stringify(report.outputs), 2000)}` : '';
    return { ok: true, text: `The saved procedure finished (${done} step(s)).${outputs}`, report };
  }
  if (report.status === 'stopped' || report.status === 'paused') return { ok: false, text: report.status === 'stopped' ? 'Stopped by the owner.' : 'Paused by the owner.', report };
  const at = version.steps.find((s) => s.id === report.resume?.step);
  const why = report.status === 'refused' ? 'a gate refused it' : report.status === 'needs_owner' ? 'it needs the owner' : report.status === 'agent' ? 'the procedure leaves this part to you' : 'it did not match the page';
  return { ok: false, text: `The saved procedure did ${done} step(s) and stopped${at ? ` at "${clip(at.label)}"` : ''}: ${why}. Look at the page and continue toward the goal yourself.`, report };
}
