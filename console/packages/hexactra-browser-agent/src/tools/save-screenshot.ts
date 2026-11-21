// `save_screenshot` (E41.4, #701): the agent keeps a picture of the page on purpose, so it can be attached to an email or saved to the owner's
// files by its step number. The picture goes through the trace path (`ctx.shoot`): masked at capture, kept past the per-run cap (moment
// `saved`), and never taken while a secret is being asked for or typed.
import { z } from 'zod';

import { defineRunnerTool } from '@marinoscar/hexactra-agent';
import type { BrowserContext } from '../context';

const WHY: Record<string, string> = {
  no_storage: 'Screenshots are not stored on this deployment, so there is nothing to attach.',
  timeout: 'The picture could not be taken in time. Try again in a moment.',
  secret: 'A secret is being asked for: no picture is taken now. Try again after it is typed.',
};

export const saveScreenshot = defineRunnerTool({
  name: 'save_screenshot',
  group: 'browser',
  family: 'browser',
  description:
    "Save a picture of the current page to this job's record, with sensitive parts covered, so it can be attached to an email or saved to the owner's files. Returns the step number to use as the attachment's step.",
  parameters: z.object({ reason: z.string().max(200).nullable() }),
  execute: async (ctx: BrowserContext, { reason }) => {
    const refused = await ctx.preflight();
    if (refused) return refused;
    const started = Date.now();
    // A secret answer waiting to be typed: the fabric refuses a picture then, and so does this tool.
    if (ctx.memory.secretHandoffId) return WHY.secret!;
    const shot = await ctx.shoot('saved');
    if (!shot.shot) {
      const note = shot.note ?? 'unavailable';
      await ctx.record('action', 'save_screenshot', {}, false, `no picture saved (${note})`, started, reason ?? undefined);
      return WHY[note] ?? 'The picture could not be taken right now.';
    }
    await ctx.record('action', 'save_screenshot', {}, true, 'saved a masked picture of the page', started, reason ?? undefined);
    const seq = ctx.state.seq;
    await ctx.attachShot(seq, 'saved', shot);
    return `Saved as the screenshot of step ${seq}.`;
  },
});
