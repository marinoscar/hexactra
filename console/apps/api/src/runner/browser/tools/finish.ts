import { z } from 'zod';

import { clip, defineRunnerTool } from '../../harness';
import type { BrowserContext } from '../context';

export const finish = defineRunnerTool({
  name: 'finish',
  group: 'control',
  description: 'End the run with a short factual result.',
  parameters: z.object({ success: z.boolean(), result: z.string().min(1).max(4000) }),
  execute: async (ctx: BrowserContext, { success, result }) => {
    ctx.state.finished = { success, result };
    ctx.state.stop = 'finish';
    await ctx.record('finish', null, null, success, clip(result, 1_900), Date.now());
    return 'Finished.';
  },
});
