// web_fetch (E50.4): read one public page as text through the host's WebFetchPort, on the server, with no sign-in and no scripts. The web
// site gate checks the requested address against the run's allowed sites; the port checks every redirect (E50.6) and this tool checks the
// final address once more. An address that holds secret material is never sent.
import { z } from 'zod';

import { defineRunnerTool, digest, redactUrl } from '@marinoscar/hexactra-agent';
import { callPort, holdsSecret } from '../call';
import type { WebContext } from '../context';
import { WEB_SITE_GATE, type WebSiteRequest } from '../gates/web-site-gate';
import { cleanPageText, cleanUrl, fetchErrorText, formatPage, siteRefusal, WEB_SENTENCES } from '../results';

const DEFAULT_MAX_CHARS = 12_000;

const parameters = z.object({
  url: z.string().min(1).max(8000),
  max_chars: z.number().int().min(1_000).max(50_000).nullable(),
});

/** What a step says about an address: host and path, never the query or the fragment. */
function hostAndPath(raw: string): string {
  try {
    const u = new URL(raw);
    return `${u.host}${u.pathname}`;
  } catch {
    return '[invalid address]';
  }
}

export const webFetch = defineRunnerTool({
  name: 'web_fetch',
  group: 'web',
  family: 'web',
  description: 'Read a public web page as text, without the browser. It cannot sign in, run scripts, click or fill a form. If a page needs any of that, open it in the browser.',
  parameters,
  available: (ctx: WebContext) => ctx.ext.web?.fetch != null,
  gated: {
    [WEB_SITE_GATE]: (ctx: WebContext, { url }): WebSiteRequest => ({
      url,
      refusal: {
        text: siteRefusal(ctx.ext.web?.sites?.hosts() ?? []),
        step: { action: 'web_fetch', args: { url: ctx.ports.policy.mask(url) }, summary: 'refused by policy: site not allowed' },
      },
    }),
  },
  async execute(ctx: WebContext, { url, max_chars }) {
    const started = Date.now();
    const web = ctx.ext.web;
    const args = { url: ctx.ports.policy.mask(url), max_chars };
    const hosts = web?.sites?.hosts() ?? [];
    let parsed: URL | null = null;
    try {
      parsed = new URL(url);
    } catch {
      parsed = null;
    }
    if (!parsed) {
      await ctx.record('action', 'web_fetch', args, false, 'refused: not a web address', started);
      return WEB_SENTENCES.notAUrl;
    }
    if (parsed.protocol !== 'https:') {
      await ctx.record('action', 'web_fetch', args, false, 'refused: only https addresses are read', started);
      return WEB_SENTENCES.notHttps;
    }
    // An address that holds secret material (a token in the query, a code) is never sent.
    if (holdsSecret(ctx, url)) {
      await ctx.record('action', 'web_fetch', args, false, 'refused: the address looks like it holds secret material', started);
      return WEB_SENTENCES.sensitiveUrl;
    }
    const port = web?.fetch;
    const where = `read ${hostAndPath(url)}`;
    if (!port) {
      await ctx.record('action', 'web_fetch', args, false, `${where}: failed (NOT_CONFIGURED)`, started);
      return WEB_SENTENCES.fetchNotConfigured;
    }
    const max = Math.min(max_chars ?? DEFAULT_MAX_CHARS, web.limits.maxFetchChars);
    const href = parsed.href;
    const out = await callPort(ctx, 'web_fetch', (signal) => port.fetch({ url: href, maxChars: max, signal }));
    if (!out.ok) {
      if ('refused' in out) return out.refused;
      if ('stopped' in out) {
        await ctx.record('action', 'web_fetch', args, false, 'Stopped by the owner while this was running.', started);
        return out.stopped;
      }
      await ctx.record('action', 'web_fetch', args, false, `${where}: failed (${out.code})`, started);
      return fetchErrorText(out.code, hosts);
    }
    const page = out.value;
    const finalUrl = cleanUrl(page.finalUrl) ?? href;
    // The port checked each redirect; a final address outside the list is refused here too, and nothing of the page is shown.
    if (web.sites && !web.sites.allowed(finalUrl)) {
      await ctx.record('action', 'web_fetch', args, false, `${where}: refused by policy: redirected to a site not allowed`, started);
      return siteRefusal(hosts);
    }
    const { text, cut } = cleanPageText(typeof page.text === 'string' ? page.text : '', max);
    const forModel = formatPage(page.title, finalUrl, text, cut || page.truncated ? max : null);
    await ctx.record('action', 'web_fetch', args, true, where, started, undefined, { url: redactUrl(finalUrl), contentHash: digest(forModel) });
    return forModel;
  },
});
