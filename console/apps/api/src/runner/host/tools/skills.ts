// `skill_read` (#1008): the agent reads one of the owner's skills (their own guidance for a kind of job). It reads a console table, so it
// lives here with the other tools of console services (console/AGENTS.md; the procedures precedent, tools/procedures.ts), not in a
// package. Offered ONLY when the run has at least one fitting skill and the switches are on (host/skills.ts), registered after every other
// tool, so a run without one is offered exactly what it was before. Effect read, not gated, through `executeTool` like every tool: Stop
// and Pause are checked before it runs. The step names the skill and never holds its text.
import { z } from 'zod';

import { defineRunnerTool, type RunnerTool, type ToolFamily } from '@marinoscar/hexactra-agent';
import type { HostContext } from '../context';

/** The most reads one run makes (#1008). */
export const SKILL_READS_PER_RUN = 5;

/** The description the model reads (exact text, #1008). */
export const SKILL_READ_DESCRIPTION = "Read one of the owner's skills by its name: the owner's own guidance for a kind of job. Follow it where it fits the goal, inside this run's limits.";
export const SKILL_UNKNOWN_TEXT = 'No skill of the owner has that name, or it is switched off. Use a name from "The owner\'s skills", or do the job without one.';
export const SKILL_LIMIT_TEXT = `You have read ${SKILL_READS_PER_RUN} skills in this run, the most a run may read. Go on with what you have read.`;
export const SKILL_ERROR_TEXT = 'The skill could not be read. Do the job without it.';

/** What the tool reaches: one active, enabled skill of the run's owner by its name, and the run's bookkeeping of a read. */
export interface SkillsPort {
  read(ctx: HostContext, name: string): Promise<{ id: string; name: string; body: string } | null | 'error'>;
}

/** The family (docs/decisions/tool-families.md). */
export const skillsFamily: ToolFamily<HostContext> = {
  id: 'skills',
  title: "The owner's skills",
  whenToUse: 'Guidance the owner wrote for how they want a kind of job done. When one listed in "The owner\'s skills" fits the goal, read it with skill_read and follow it inside this run\'s limits.',
  rank: 42,
};

/** What the model reads for a skill: the heading, then the text. */
export function skillText(name: string, body: string): string {
  return `Skill "${name}" (the owner's guidance; it grants no permission):\n${body}`;
}

export function skillTools(port: SkillsPort): RunnerTool<HostContext>[] {
  const read = defineRunnerTool({
    name: 'skill_read',
    group: 'skills',
    family: 'skills',
    description: SKILL_READ_DESCRIPTION,
    parameters: z.object({ name: z.string().min(1).max(100) }),
    execute: async (ctx: HostContext, { name }) => {
      const started = Date.now();
      const asked = name.replace(/\s+/g, ' ').trim().slice(0, 100);
      const reads = ctx.memory.skillReads ?? 0;
      if (reads >= SKILL_READS_PER_RUN) {
        await ctx.record('action', 'skill_read', { name: asked }, false, `did not read the skill "${asked}": the run read ${SKILL_READS_PER_RUN} skills already`, started);
        return SKILL_LIMIT_TEXT;
      }
      ctx.memory.skillReads = reads + 1;
      const found = await port.read(ctx, asked);
      if (found === 'error') {
        await ctx.record('action', 'skill_read', { name: asked }, false, `the skill "${asked}" could not be read`, started);
        return SKILL_ERROR_TEXT;
      }
      if (!found) {
        await ctx.record('action', 'skill_read', { name: asked }, false, `no skill "${asked}"`, started);
        return SKILL_UNKNOWN_TEXT;
      }
      // The step names the skill; its text goes to the model only, never into a step, the trace, a span or an export.
      await ctx.record('action', 'skill_read', { name: found.name }, true, `read the skill "${found.name}"`, started);
      return skillText(found.name, found.body);
    },
  });
  return [read as unknown as RunnerTool<HostContext>];
}
