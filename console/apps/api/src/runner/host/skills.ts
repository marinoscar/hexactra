// The owner's skills in a run (#1008): the "The owner's skills" block in the stable part of the input (after the memories) and
// `skill_read`. Offered to every run of the owner, whatever started it (chat, task, schedule, API, CLI, an AI app's `run_goal`), exactly as
// the memory block is (about-owner.ts reads the memories for every run with no trigger or app check). With the switches off, or no
// fitting active skill, this returns null: no block, no tool, no family, so the run is byte-identical to how it ran before skills.
// The selection is deterministic (src/skills/skill-context.ts); an error is logged and counted and the run goes on without the block.
import type { SnapshotConnection } from '../../policies/policy-snapshot';
import type { HostDeps } from './deps';
import { candidateSites } from './kgraph/everyday';
import { skillTools, skillsFamily } from './tools/skills';

export interface SkillsBinding {
  block: string;
  tools: ReturnType<typeof skillTools>;
  family: typeof skillsFamily;
}

/**
 * The binding of a run, or null without a fitting skill. `sites` are the run's allowed sites (its own and its AI app's); the candidate
 * sites add the goal's and the accounts' (`candidateSites`, the everyday rule: exact registrable domain, so a lookalike matches nothing).
 */
export async function skillsBinding(
  d: HostDeps,
  userId: string,
  run: { id: string; goal: string },
  context: string | undefined,
  allowedDomains: readonly string[],
  connections: readonly SnapshotConnection[],
): Promise<SkillsBinding | null> {
  const skills = d.skills;
  if (!skills) return null;
  const text = [run.goal, context ?? ''].join('\n');
  let block = '';
  try {
    block = (await skills.forJob(userId, { text, sites: candidateSites(text, allowedDomains, connections) })).block;
  } catch (err) {
    skills.failed('match', 'run binding', err);
    return null;
  }
  if (!block) return null;
  const tools = skillTools({
    read: async (_ctx, name) => {
      try {
        const found = await skills.read(userId, name);
        if (found) await skills.noteRead(userId, run.id, found.id);
        return found;
      } catch (err) {
        skills.failed('read', 'skill_read', err);
        return 'error';
      }
    },
  });
  return { block, tools, family: skillsFamily };
}
