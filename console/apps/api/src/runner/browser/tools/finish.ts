import { z } from 'zod';

import { clip, defineRunnerTool } from '../../harness';
import type { BrowserContext } from '../context';

const plain = z.object({ success: z.boolean(), result: z.string().min(1).max(4000) });

export const finish = defineRunnerTool({
  name: 'finish',
  group: 'control',
  description: 'End the run with a short factual result.',
  parameters: plain,
  // A task with outputs (E39.5) gives the model the task's keys and types; a task without any keeps the schema above, unchanged.
  parametersFor: (ctx: BrowserContext) => ctx.ext.outputs?.parameters ?? plain,
  execute: async (ctx: BrowserContext, args) => {
    const { success } = args;
    let { result } = args;
    const outputs = ctx.ext.outputs;
    if (outputs) {
      // The task's outputs are read and checked here, on the server. A success finish with a missing required value or one that does not
      // parse is refused, twice at most; a failure, the wrap-up call and the third try end the run with what it has.
      const given = (args as { outputs?: unknown }).outputs;
      const attempts = ctx.memory.outputAttempts ?? 0;
      const decision = outputs.decide(given, { attempts, final: ctx.state.wrappingUp || !success });
      if (decision.refusal) {
        ctx.memory.outputAttempts = attempts + 1;
        await ctx.note('note', null, `finish was refused: ${decision.problemKeys.join(', ')} (${attempts + 1} of ${outputs.maxAttempts})`, { ok: false });
        return decision.refusal;
      }
      result = outputs.scrub(result, given);
      ctx.state.finished = { success, result, outputs: { fields: decision.fields, complete: decision.complete } };
    } else ctx.state.finished = { success, result };
    ctx.state.stop = 'finish';
    await ctx.record('finish', null, null, success, clip(result, 1_900), Date.now());
    return 'Finished.';
  },
});
