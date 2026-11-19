import { z } from 'zod';

import { defineRunnerTool } from '@marinoscar/hexactra-agent';
import { act } from '../act';
import type { BrowserContext } from '../context';

export const desktopClick = defineRunnerTool({
  name: 'desktop_click',
  group: 'desktop',
  description: 'Click anywhere on the computer screen, at screen coordinates from a desktop screenshot (look with screen "desktop").',
  parameters: z.object({ x: z.number().int().min(0), y: z.number().int().min(0), button: z.enum(['left', 'middle', 'right']), double: z.boolean() }),
  execute: (ctx: BrowserContext, { x, y, button, double }) => act(ctx, { type: 'desktop_click', x, y, ...(button !== 'left' ? { button } : {}), ...(double ? { click_count: 2 } : {}) }),
});

export const desktopType = defineRunnerTool({
  name: 'desktop_type',
  group: 'desktop',
  description: "Type text into whatever has focus on the computer (a native file dialog's path box, another window).",
  parameters: z.object({ text: z.string().min(1).max(10_000) }),
  execute: (ctx: BrowserContext, { text }) => act(ctx, { type: 'desktop_type', text }),
});

export const desktopKey = defineRunnerTool({
  name: 'desktop_key',
  group: 'desktop',
  description: 'Press a key chord on the computer, xdotool style: "Return", "Escape", "ctrl+l", "alt+F4", "ctrl+a BackSpace".',
  parameters: z.object({ key: z.string().min(1).max(64) }),
  execute: (ctx: BrowserContext, { key }) => act(ctx, { type: 'desktop_key', key }),
});

export const desktopScroll = defineRunnerTool({
  name: 'desktop_scroll',
  group: 'desktop',
  description: 'Scroll on the computer screen by mouse-wheel clicks at a point (positive dy scrolls down).',
  parameters: z.object({ x: z.number().int().min(0), y: z.number().int().min(0), dy: z.number().int().min(-100).max(100) }),
  execute: (ctx: BrowserContext, { x, y, dy }) => act(ctx, { type: 'desktop_scroll', x, y, dy }),
});

export const desktopDrag = defineRunnerTool({
  name: 'desktop_drag',
  group: 'desktop',
  description: 'Drag on the computer screen from one point to another.',
  parameters: z.object({ from_x: z.number().int().min(0), from_y: z.number().int().min(0), to_x: z.number().int().min(0), to_y: z.number().int().min(0) }),
  execute: (ctx: BrowserContext, a) => act(ctx, { type: 'desktop_drag', ...a }),
});
