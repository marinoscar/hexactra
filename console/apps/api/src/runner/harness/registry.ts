import type { AnyContext } from './run-context';
import type { RunnerTool } from './tool-def';

/**
 * The tools a run may be offered. A toolset registers its tools once; each round `list(ctx)` is what the model sees: the registered tools
 * whose `available(ctx)` holds, in registration order. The order matters (it is part of the stable prefix the provider caches), so the
 * registry never sorts or reorders.
 */
export class ToolRegistry<C extends AnyContext = AnyContext> {
  private readonly tools: RunnerTool<C>[] = [];

  /** Adds a tool. A second tool of the same name is a programming error. */
  register(tool: RunnerTool<C>): this {
    if (this.tools.some((t) => t.name === tool.name)) throw new Error(`tool "${tool.name}" is registered twice`);
    this.tools.push(tool);
    return this;
  }

  registerAll(tools: readonly RunnerTool<C>[]): this {
    for (const t of tools) this.register(t);
    return this;
  }

  /** Every registered tool, available or not. */
  all(): readonly RunnerTool<C>[] {
    return this.tools;
  }

  get(name: string): RunnerTool<C> | undefined {
    return this.tools.find((t) => t.name === name);
  }

  /** The tools offered this round. */
  list(ctx: C): RunnerTool<C>[] {
    return this.tools.filter((t) => !t.available || t.available(ctx));
  }

  /** The usage notes of the tools offered this round, in registration order. */
  usageNotes(ctx: C): string[] {
    return this.list(ctx).flatMap((t) => (t.usage ? [t.usage] : []));
  }
}
