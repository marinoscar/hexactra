import { z } from 'zod';

import { defineRunnerTool } from '@marinoscar/hexactra-agent';
import { act } from '../act';
import { pageDigest } from '../page';
import type { BrowserContext } from '../context';

export const typeText = defineRunnerTool({
  name: 'type_text',
  group: 'browser',
  family: 'browser',
  // E54.1: fill only when it does not also submit, so a reply that carries several actions may go on after it.
  batch: (a) => !a.submit,
  description: 'Type text into an input (not secrets: use type_handoff_secret for those). For a code split across several one-character boxes, pass the first box.',
  parameters: z.object({ selector: z.string().max(2000), text: z.string().max(10_000), submit: z.boolean() }),
  execute: (ctx: BrowserContext, { selector, text, submit }) => act(ctx, { type: 'type', selector, text, clear: true, submit }),
});

export const pressKey = defineRunnerTool({
  name: 'press_key',
  group: 'browser',
  family: 'browser',
  description: 'Press a key such as Enter, Tab or Escape, with a real key press at the focused element.',
  parameters: z.object({ key: z.string().max(40) }),
  // The page before the key (E52.3): `act` says when the key left it exactly so.
  execute: async (ctx: BrowserContext, { key }) => act(ctx, { type: 'press', key }, undefined, undefined, undefined, { before: await pageDigest(ctx) }),
});

export const typeKeys = defineRunnerTool({
  name: 'type_keys',
  group: 'browser',
  family: 'browser',
  description: 'Type text into whatever has focus with real keyboard events (click the field first). Use for fields that ignore type_text.',
  parameters: z.object({ text: z.string().min(1).max(10_000) }),
  execute: (ctx: BrowserContext, { text }) => act(ctx, { type: 'type_keys', text }),
});

export const key = defineRunnerTool({
  name: 'key',
  group: 'browser',
  family: 'browser',
  description: 'Press one key with real keyboard events, with modifiers: key "a" with ["ctrl"] selects all, "Enter", "Escape", "Tab", "ArrowDown", "PageDown", "F5".',
  parameters: z.object({ key: z.string().min(1).max(40), modifiers: z.array(z.enum(['alt', 'ctrl', 'meta', 'shift'])) }),
  execute: (ctx: BrowserContext, { key: k, modifiers }) => act(ctx, { type: 'key', key: k, ...(modifiers.length ? { modifiers } : {}) }),
});
