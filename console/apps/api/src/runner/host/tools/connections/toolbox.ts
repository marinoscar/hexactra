// `open_toolbox` (E50.17, #987): every enabled tool of the owner's MCP servers stays reachable, however many there are. When their sum is over
// the per-run cap (`MCP_MAX_TOOLS_PER_RUN`), no tool is dropped: each server is a closed toolbox, named in "Your tools" with its purpose and
// tool count, and its tools are offered from the round after the agent opens it. The tool list (and the provider's cached prefix) changes at
// an open, never otherwise. Opening grants nothing: the tools are the ones the owner switched on, and each call still goes through
// `executeTool`, the connection gate and `McpRunService.check`.
import { z } from 'zod';

import { clip, defineRunnerTool, type RunnerTool, type ToolFamily } from '@marinoscar/hexactra-agent';
import { MCP_TRUST_LINE } from '../../../../connections/mcp/mcp.constants';
import type { McpRunTool } from '../../../../connections/mcp/mcp-run.service';
import type { HostContext } from '../../context';
import { recordStep } from './support';

export const OPEN_TOOLBOX = 'open_toolbox';
export const TOOLBOXES_FAMILY = 'mcp-toolboxes';

/** One closed toolbox: an MCP server of the run, its label, purpose and tools. */
export interface Toolbox {
  familyId: string;
  label: string;
  purpose: string;
  tools: readonly McpRunTool[];
}

/** Whether the run opened this toolbox (memory is the run's own, written only by `open_toolbox`). */
export const isOpen = (ctx: Pick<HostContext, 'memory'>, familyId: string): boolean => Boolean(ctx.memory.connections?.toolboxes?.includes(familyId));

const count = (n: number): string => `${n} tool${n === 1 ? '' : 's'}`;

/** The family that names every closed toolbox in "Your tools": the same bytes for the whole run. */
export function toolboxesFamily(boxes: readonly Toolbox[]): ToolFamily<HostContext> {
  return {
    id: TOOLBOXES_FAMILY,
    title: 'Toolboxes the owner added',
    whenToUse: `More tools than fit at once, so each is closed until you open it with ${OPEN_TOOLBOX}: ${boxes.map((b) => `"${b.label}" (${count(b.tools.length)}): ${clip(b.purpose, 200)}`).join('; ')}.`,
    rank: 21,
  };
}

/** The `open_toolbox` tool of a run whose MCP tools are over the cap. Offered for the whole run, so the instructions stay the same. */
export function openToolboxTool(boxes: readonly Toolbox[]): RunnerTool<HostContext> {
  const labels = boxes.map((b) => b.label) as [string, ...string[]];
  return defineRunnerTool({
    name: OPEN_TOOLBOX,
    group: TOOLBOXES_FAMILY,
    family: TOOLBOXES_FAMILY,
    description: 'Open one of the toolboxes the owner added, by its name: its tools are offered to you from the next step on, for the rest of the run.',
    parameters: z.object({ toolbox: z.enum(labels).describe('The toolbox to open.') }),
    usage: MCP_TRUST_LINE,
    execute: async (ctx: HostContext, args: { toolbox: string }) => {
      const started = Date.now();
      const box = boxes.find((b) => b.label === args.toolbox);
      if (!box) return `There is no toolbox "${clip(args.toolbox, 100)}". Choose one of: ${labels.map((l) => `"${l}"`).join(', ')}.`;
      const names = box.tools.map((t) => clip(t.title || t.name, 60)).join(', ');
      if (isOpen(ctx, box.familyId)) return `"${box.label}" is already open: ${names}.`;
      const mem = (ctx.memory.connections ??= {});
      mem.toolboxes = [...(mem.toolboxes ?? []), box.familyId];
      await recordStep(ctx, OPEN_TOOLBOX, started, { toolbox: box.label }, true, `opened "${box.label}" (${count(box.tools.length)})`);
      return `"${box.label}" is open. Its tools are offered from your next step: ${names}.`;
    },
  }) as unknown as RunnerTool<HostContext>;
}
