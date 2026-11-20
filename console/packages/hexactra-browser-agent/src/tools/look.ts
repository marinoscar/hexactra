import { z } from 'zod';

import { defineRunnerTool } from '@marinoscar/hexactra-agent';
import type { BrowserContext } from '../context';

export const look = defineRunnerTool({
  name: 'look',
  group: 'browser',
  family: 'browser',
  description:
    'Take a fresh screenshot and end this turn; the next turn starts with the image. screen "page" shows the tab with numbered interactive elements; "desktop" shows the whole computer screen (native dialogs, file pickers, other windows).',
  parameters: z.object({ screen: z.enum(['page', 'desktop']), reason: z.string().max(500) }),
  execute: async (ctx: BrowserContext, { screen, reason }) => {
    if (ctx.memory.visionOff || !ctx.ext.shotWindow.enabled) return 'Screenshots are not available with this model: use observe_elements and read_text.';
    const spent = ctx.budgetStop();
    if (spent) return spent;
    await ctx.record('observe', 'look', { screen }, true, `looked at the ${screen}`, Date.now(), reason);
    ctx.memory.look = screen;
    ctx.state.stop = 'look';
    return 'Looking; the screenshot comes with the next turn.';
  },
});
