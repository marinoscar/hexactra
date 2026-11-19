// The gates a tool call passes before it runs (E38.5). A gate decides from facts the server read itself, never from the model's words;
// the harness knows only this interface. The site gate and the risk gate (#550) are the browser toolset's and plug in.
import type { AnyContext } from './run-context';
import type { GateDecision, GateVerdict, RunnerTool } from './tool-def';

export interface Gate<C extends AnyContext = AnyContext> {
  /** The name a tool's `gated` map uses for it. */
  readonly name: string;
  /** Decides one call. `request` is what the tool's own `gated[name]` function returned. */
  check(ctx: C, request: unknown, call: { tool: string }): Promise<GateVerdict>;
}

export type PipelineResult = { kind: 'allow'; decision: GateDecision } | Exclude<GateVerdict, { kind: 'allow' }>;

/** Runs the gates a tool names, in the order its `gated` map lists them; the first that does not allow ends the call. */
export class GatePipeline<C extends AnyContext = AnyContext> {
  private readonly gates = new Map<string, Gate<C>>();

  constructor(gates: readonly Gate<C>[] = []) {
    for (const g of gates) this.add(g);
  }

  add(gate: Gate<C>): this {
    if (this.gates.has(gate.name)) throw new Error(`gate "${gate.name}" is registered twice`);
    this.gates.set(gate.name, gate);
    return this;
  }

  async run(ctx: C, tool: RunnerTool<C>, args: unknown): Promise<PipelineResult> {
    const decision: Record<string, unknown> = {};
    for (const [name, requestOf] of Object.entries(tool.gated ?? {})) {
      const gate = this.gates.get(name);
      // A tool that names a gate nobody registered must never run ungated.
      if (!gate) throw new Error(`tool "${tool.name}" names the gate "${name}", which is not registered`);
      const verdict = await gate.check(ctx, await requestOf(ctx, args), { tool: tool.name });
      if (verdict.kind !== 'allow') return verdict;
      decision[name] = verdict.data;
    }
    return { kind: 'allow', decision };
  }
}
