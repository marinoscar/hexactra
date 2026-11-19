import { z } from 'zod';

import { defineRunnerTool } from '@marinoscar/hexactra-agent';
import { clickThrough } from '../click-through';
import type { BrowserContext } from '../context';
import { RISK_GATE, type RiskRequest } from '../gates/risk-gate';
import { describeTarget } from '../page';
import { markCenter } from '../vision';

export const click = defineRunnerTool({
  name: 'click',
  group: 'browser',
  description: 'Click the element matching a CSS selector.',
  parameters: z.object({ selector: z.string().max(2000), reason: z.string().max(500) }),
  gated: {
    [RISK_GATE]: async (ctx: BrowserContext, { selector, reason }): Promise<RiskRequest> => {
      // The page's facts first (they hold the form's action); what observe_elements saw when the page cannot answer.
      const confirm = ctx.ext.confirmRisky();
      const described = confirm ? await describeTarget(ctx, { selector }) : null;
      return { action: 'click', args: { selector }, reason, facts: confirm ? (described ?? ctx.ext.state.labels.get(selector) ?? null) : null, described: described !== null };
    },
  },
  execute: (ctx: BrowserContext, { selector, reason }, decision) => clickThrough(ctx, decision, { type: 'click', selector }, 'click', reason),
});

export const clickMark = defineRunnerTool({
  name: 'click_mark',
  group: 'browser',
  description: 'Click the element numbered n on the latest page screenshot, with a real mouse click at its center.',
  parameters: z.object({ n: z.number().int().min(1), double: z.boolean(), reason: z.string().max(500) }),
  gated: {
    [RISK_GATE]: async (ctx: BrowserContext, { n, reason }): Promise<RiskRequest | null> => {
      const mark = ctx.ext.state.marks.get(n);
      // A mark that is not on the screenshot is answered by the tool, not gated.
      if (!mark) return null;
      const { x, y } = markCenter(mark);
      // The element under the mark's center, as the page reports it; the mark's own role and text when it cannot.
      const confirm = ctx.ext.confirmRisky();
      const described = confirm ? await describeTarget(ctx, { x, y }) : null;
      const facts = confirm ? (described ?? { label: mark.text ?? null, role: mark.role ?? null, tag: mark.tag ?? null }) : null;
      return { action: 'click_at', args: { mark: n }, reason, facts, described: described !== null };
    },
  },
  execute: (ctx: BrowserContext, { n, double, reason }, decision) => {
    const mark = ctx.ext.state.marks.get(n);
    if (!mark) return `There is no mark ${n} on the latest screenshot. Call look to refresh it.`;
    const { x, y } = markCenter(mark);
    return clickThrough(ctx, decision, { type: 'click_at', x, y, ...(double ? { click_count: 2 } : {}) }, 'click_at', reason, { x: mark.x, y: mark.y, w: mark.w, h: mark.h });
  },
});

export const clickAt = defineRunnerTool({
  name: 'click_at',
  group: 'browser',
  description: 'Real mouse click at viewport coordinates (CSS pixels, as on the page screenshot). button left/middle/right; double for a double click; modifiers alt, ctrl, meta, shift.',
  parameters: z.object({
    x: z.number().int().min(0),
    y: z.number().int().min(0),
    button: z.enum(['left', 'middle', 'right']),
    double: z.boolean(),
    modifiers: z.array(z.enum(['alt', 'ctrl', 'meta', 'shift'])),
    reason: z.string().max(500),
  }),
  gated: {
    [RISK_GATE]: async (ctx: BrowserContext, { x, y, reason }): Promise<RiskRequest> => {
      // The element under the point (#550). The model's reason is never read: with no facts, nothing is gated.
      const described = ctx.ext.confirmRisky() ? await describeTarget(ctx, { x, y }) : null;
      return { action: 'click_at', args: { x, y }, reason, facts: described, described: described !== null };
    },
  },
  execute: (ctx: BrowserContext, { x, y, button, double, modifiers, reason }, decision) =>
    clickThrough(ctx, decision, { type: 'click_at', x, y, ...(button !== 'left' ? { button } : {}), ...(double ? { click_count: 2 } : {}), ...(modifiers.length ? { modifiers } : {}) }, 'click_at', reason),
});
