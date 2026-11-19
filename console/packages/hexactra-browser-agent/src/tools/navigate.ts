import { z } from 'zod';

import { defineRunnerTool } from '@marinoscar/hexactra-agent';
import { act } from '../act';
import type { BrowserContext } from '../context';
import { SITE_GATE, type SiteRequest } from '../gates/site-gate';

export const navigate = defineRunnerTool({
  name: 'navigate',
  group: 'browser',
  description: 'Open any URL in the current tab.',
  parameters: z.object({ url: z.string().max(8000), reason: z.string().max(500) }),
  gated: {
    [SITE_GATE]: (ctx: BrowserContext, { url, reason }): SiteRequest => ({
      url,
      refusal: {
        text: `Refused: ${url.startsWith('javascript:') ? 'use run_javascript instead of a javascript: URL' : `that site is not allowed for this task (${ctx.ext.sites.text})`}.`,
        step: { action: 'navigate', args: { url }, summary: 'refused by policy: site not allowed', reasoning: reason },
      },
    }),
  },
  execute: (ctx: BrowserContext, { url, reason }) => act(ctx, { type: 'navigate', url }, reason),
});

export const goBack = defineRunnerTool({
  name: 'go_back',
  group: 'browser',
  description: 'Go back one page.',
  parameters: z.object({}),
  execute: (ctx: BrowserContext) => act(ctx, { type: 'back' }),
});

export const tabs = defineRunnerTool({
  name: 'tabs',
  group: 'browser',
  description: 'List the open tabs (id, title, URL, which is active).',
  parameters: z.object({}),
  execute: (ctx: BrowserContext) => act(ctx, { type: 'tabs' }),
});

export const switchTab = defineRunnerTool({
  name: 'switch_tab',
  group: 'browser',
  description: 'Make a tab (by id from tabs) the active one; later actions use it.',
  parameters: z.object({ tab_id: z.number().int() }),
  execute: (ctx: BrowserContext, { tab_id }) => act(ctx, { type: 'activate_tab', tab_id }),
});

export const newTab = defineRunnerTool({
  name: 'new_tab',
  group: 'browser',
  description: 'Open a new tab, optionally at a URL, and make it active.',
  parameters: z.object({ url: z.string().max(8000).nullable() }),
  gated: {
    // A tab with no URL opens a blank page: nothing to check.
    [SITE_GATE]: (ctx: BrowserContext, { url }): SiteRequest | null =>
      url
        ? {
            url,
            refusal: {
              text: `Refused: that site is not allowed for this task (${ctx.ext.sites.text}).`,
              step: { action: 'new_tab', args: { url }, summary: 'refused by policy: site not allowed' },
            },
          }
        : null,
  },
  execute: (ctx: BrowserContext, { url }) => act(ctx, { type: 'new_tab', ...(url ? { url } : {}) }),
});
