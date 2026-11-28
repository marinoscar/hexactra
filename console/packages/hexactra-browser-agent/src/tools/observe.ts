import { z } from 'zod';

import { defineRunnerTool } from '@marinoscar/hexactra-agent';
import { act } from '../act';
import type { BrowserContext } from '../context';
import { maxElementsFor } from '../context-settings';

export const observeElements = defineRunnerTool({
  name: 'observe_elements',
  group: 'browser',
  family: 'browser',
  // E54.1: leaves the page where it is, so a reply that carries several actions may go on after it.
  batch: 'fill',
  description: 'List the interactive elements of the current page with CSS selectors.',
  parameters: z.object({}),
  execute: (ctx: BrowserContext) => act(ctx, { type: 'elements', max_elements: maxElementsFor(ctx.ext.observationChars) }),
});

export const readText = defineRunnerTool({
  name: 'read_text',
  group: 'browser',
  family: 'browser',
  // E54.1: leaves the page where it is, so a reply that carries several actions may go on after it.
  batch: 'fill',
  description: 'Read the visible text of the page, or of one element.',
  parameters: z.object({ selector: z.string().max(2000).nullable() }),
  execute: (ctx: BrowserContext, { selector }) => act(ctx, { type: 'text', ...(selector ? { selector } : {}), max_chars: ctx.ext.observationChars }),
});

export const waitFor = defineRunnerTool({
  name: 'wait_for',
  group: 'browser',
  family: 'browser',
  description: 'Wait until an element matching a selector appears (up to 15 s).',
  parameters: z.object({ selector: z.string().max(2000) }),
  execute: (ctx: BrowserContext, { selector }) => act(ctx, { type: 'wait_for', selector, timeout_ms: 15_000 }),
});

export const runJavascript = defineRunnerTool({
  name: 'run_javascript',
  group: 'browser',
  family: 'browser',
  description:
    "Run JavaScript in the current page and get its value back (like the DevTools console: the last expression is the value; top-level await works). Use it to read page state, fill or submit complex forms, call the page's functions, or work around stubborn widgets.",
  parameters: z.object({ script: z.string().min(1).max(100_000), reason: z.string().max(500) }),
  execute: (ctx: BrowserContext, { script, reason }) => act(ctx, { type: 'evaluate', script, await_promise: true }, reason),
});
