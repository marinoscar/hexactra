import type { AnyContext } from './run-context';
import type { RunnerTool } from './tool-def';
import type { ToolFamily } from './tool-family';
import { toolFamilyOf } from './tool-family-of';

/**
 * The tools a run may be offered. A toolset registers its tools once; each round `list(ctx)` is what the model sees: the registered tools
 * whose `available(ctx)` holds, in registration order. The order matters (it is part of the stable prefix the provider caches), so the
 * registry never sorts or reorders.
 */
export class ToolRegistry<C extends AnyContext = AnyContext> {
  private readonly tools: RunnerTool<C>[] = [];
  private readonly familyList: ToolFamily<C>[] = [];

  /** Adds a family descriptor (E41.2). A second family with the same id is a programming error. A tool whose family has none is offered as before. */
  registerFamily(family: ToolFamily<C>): this {
    if (this.familyList.some((f) => f.id === family.id)) throw new Error(`family "${family.id}" is registered twice`);
    this.familyList.push(family);
    return this;
  }

  registerFamilies(families: readonly ToolFamily<C>[]): this {
    for (const f of families) this.registerFamily(f);
    return this;
  }

  /** The registered families with at least one tool offered this round, by rank, then registration order. Deterministic. */
  families(ctx: C): ToolFamily<C>[] {
    const offered = new Set(this.list(ctx).map(toolFamilyOf));
    return this.familyList
      .map((f, i) => ({ f, i }))
      .filter(({ f }) => offered.has(f.id))
      .sort((a, b) => a.f.rank - b.f.rank || a.i - b.i)
      .map(({ f }) => (f.sectionsFor ? { ...f, sections: f.sectionsFor(ctx) } : f));
  }

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
