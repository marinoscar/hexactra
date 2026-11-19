import { defineTool, type AiDefinedTool } from '@marinoscar/platform-api/ai';
import type { z } from 'zod';

import { runAsCommit } from './harness/intent';

export * from './harness/intent';

/**
 * `defineTool` with one more field. `commits: true` marks the tool commit-class: its fabric actions get an intent record.
 * Parallel calls of one model response each keep their own marker (async local storage), never a shared flag.
 */
export function defineRunTool<P extends z.ZodTypeAny, R>(def: Parameters<typeof defineTool<P, R>>[0] & { commits?: boolean }): AiDefinedTool<P, R> {
  const { commits, ...rest } = def;
  const tool = defineTool<P, R>(rest);
  if (!commits) return tool;
  return { ...tool, execute: (args, ctx) => runAsCommit(() => tool.execute(args, ctx)) };
}
