// The memory block for a run (#553), from its goal and its follow-up context.
import type { HostDeps } from './deps';

/**
 * The memories the goal uses are added to `runs.memory_ids` and marked used the first time. '' without memories. Information for the
 * model, in the stable prefix (#406): never an instruction, never a permission.
 */
export async function aboutOwner(d: HostDeps, userId: string, run: { id: string; goal: string; memoryIds?: string[] | null }, context: string | undefined): Promise<string> {
  if (!d.memoryContext) return '';
  const { block, usedIds } = await d.memoryContext.forText(userId, [run.goal, context ?? ''].join('\n'));
  const known = new Set(run.memoryIds ?? []);
  const fresh = usedIds.filter((id) => !known.has(id));
  if (fresh.length > 0) {
    await d.prisma.forUser({ userId }).run.updateMany({ where: { id: run.id }, data: { memoryIds: [...known, ...fresh] } });
    await d.memoryContext.touch(userId, fresh);
  }
  return block;
}
