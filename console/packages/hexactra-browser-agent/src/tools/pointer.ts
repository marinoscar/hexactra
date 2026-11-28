import { z } from 'zod';

import { defineRunnerTool } from '@marinoscar/hexactra-agent';
import { act } from '../act';
import type { BrowserContext } from '../context';

export const scroll = defineRunnerTool({
  name: 'scroll',
  group: 'browser',
  family: 'browser',
  // E54.1: leaves the page where it is, so a reply that carries several actions may go on after it.
  batch: 'fill',
  description: 'Scroll the page vertically by a number of pixels (negative scrolls up).',
  parameters: z.object({ dy: z.number().int().min(-20000).max(20000) }),
  execute: (ctx: BrowserContext, { dy }) => act(ctx, { type: 'scroll', dy }),
});

export const hoverAt = defineRunnerTool({
  name: 'hover_at',
  group: 'browser',
  family: 'browser',
  // E54.1: leaves the page where it is, so a reply that carries several actions may go on after it.
  batch: 'fill',
  description: 'Move the mouse to viewport coordinates (opens hover menus and tooltips).',
  parameters: z.object({ x: z.number().int().min(0), y: z.number().int().min(0) }),
  execute: (ctx: BrowserContext, { x, y }) => act(ctx, { type: 'mouse', op: 'move', x, y }),
});

export const drag = defineRunnerTool({
  name: 'drag',
  group: 'browser',
  family: 'browser',
  description: 'Real mouse drag from one viewport point to another (sliders, drag and drop, drawing).',
  parameters: z.object({ from_x: z.number().int().min(0), from_y: z.number().int().min(0), to_x: z.number().int().min(0), to_y: z.number().int().min(0) }),
  execute: (ctx: BrowserContext, a) => act(ctx, { type: 'drag', ...a }),
});

export const scrollAt = defineRunnerTool({
  name: 'scroll_at',
  group: 'browser',
  family: 'browser',
  // E54.1: leaves the page where it is, so a reply that carries several actions may go on after it.
  batch: 'fill',
  description: 'Mouse-wheel scroll at a viewport point: scrolls whatever is under it (a list, a map, a panel). Positive dy scrolls down.',
  parameters: z.object({ x: z.number().int().min(0), y: z.number().int().min(0), dy: z.number().int().min(-20000).max(20000) }),
  execute: (ctx: BrowserContext, { x, y, dy }) => act(ctx, { type: 'scroll_at', x, y, dx: 0, dy }),
});
