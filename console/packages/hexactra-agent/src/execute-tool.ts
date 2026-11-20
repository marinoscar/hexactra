// The one wrapper around every tool execution (E38.5). Nothing the model calls reaches a tool except through here, so "nothing bypasses
// Stop, the gates or the trace" is a property of this function and its test, not a convention.
//
// The life of one call, in this order:
//   1. Stop, then Pause (E38.1, E38.2): a call chosen before the owner pressed it is not carried out and nothing is recorded.
//   2. The trace span (E38.4) opens: everything below is inside it.
//   3. The gates the tool names (site, risk) decide from facts the server read itself. A refusal is recorded as a failed step.
//   4. A commit-class tool (`commits: true`) runs marked as one: the first action it sends is intent-recorded before it goes (E38.3).
//   5. The tool runs through the context and returns the text the model reads. Recording the step, feeding the stall detector, the
//      budget and the activity are the context's services (`ctx.record`, `ctx.setActivity`), applied once per step whoever calls them.
import type { GatePipeline } from './gate-pipeline';
import { runAsCommit } from './intent';
import type { ModelTool, ToolCallMeta } from './ports';
import type { AnyContext } from './run-context';
import type { ToolRegistry } from './registry';
import type { RunnerTool } from './tool-def';
import { toolFamilyOf } from './tool-family-of';
import { PAUSED_TEXT, STOPPED_TEXT } from './types';

export async function executeTool<C extends AnyContext>(ctx: C, tool: RunnerTool<C>, args: unknown, pipeline: GatePipeline<C>): Promise<string> {
  const { control, telemetry } = ctx.ports;
  // 1. Stop, then Pause.
  if (control.requested) {
    ctx.state.stop = 'cancel';
    return STOPPED_TEXT;
  }
  if (control.pauseRequested) {
    ctx.state.stop ??= 'owner_pause';
    return PAUSED_TEXT;
  }
  const meta: ToolCallMeta = { family: toolFamilyOf(tool) };
  return telemetry.toolCall(tool.name, async () => {
    // 3. The gates.
    const verdict = await pipeline.run(ctx, tool, args);
    if (verdict.kind === 'refuse') {
      meta.outcome = 'refused';
      if (verdict.step) await ctx.record('action', verdict.step.action, verdict.step.args, false, verdict.step.summary, Date.now(), verdict.step.reasoning);
      return verdict.text;
    }
    if (verdict.kind === 'ask') return (await ctx.askPerson(verdict.question, Date.now())) ? verdict.text : 'Could not reach a person right now.';
    // 4 and 5. The tool.
    const run = () => tool.execute(ctx, args, verdict.decision);
    return tool.commits ? runAsCommit(run) : run();
  }, meta);
}

/** The tools of this round as the model port takes them: each call goes through `executeTool`. */
export function offerTools<C extends AnyContext>(ctx: C, registry: ToolRegistry<C>, pipeline: GatePipeline<C>): ModelTool[] {
  const tools = registry.list(ctx);
  ctx.ports.telemetry.familiesOffered?.([...new Set(tools.map(toolFamilyOf))].sort());
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    parameters: tool.parametersFor ? tool.parametersFor(ctx) : tool.parameters,
    ...(tool.strict === false ? { strict: false } : {}),
    execute: (args: never) => executeTool(ctx, tool, args, pipeline),
  }));
}
