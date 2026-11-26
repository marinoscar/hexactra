// web_search (E50.4): search the public web through the host's WebSearchPort. The query passes the run's sensitive patterns first; a task's
// allowed sites narrow the search and filter its hits; what comes back is third-party text, cleaned, capped and wrapped as data.
import { z } from 'zod';

import { defineRunnerTool, digest } from '@marinoscar/hexactra-agent';
import { callPort, holdsSecret } from '../call';
import type { WebContext } from '../context';
import { WEB_SITE_GATE, type WebSiteRequest } from '../gates/web-site-gate';
import { cleanUrl, formatSearch, providerId, searchErrorText, siteRefusal, WEB_SENTENCES } from '../results';

/** The span attributes the web tools add (closed, content-free names; the host keeps only the names it allows). */
export const WEB_SPAN_ATTRS = { provider: 'hexactra.web.provider', results: 'hexactra.web.results' } as const;

const DEFAULT_COUNT = 5;
const HOST = /^(?=.{1,253}$)(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/i;

const parameters = z.object({
  query: z.string().min(2).max(400),
  count: z.number().int().min(1).max(10).nullable(),
  freshness: z.enum(['day', 'week', 'month', 'year']).nullable(),
  site: z.string().regex(HOST).nullable(),
});

/** The host a search is narrowed to: the model's own, or the run's one allowed host. */
function narrowTo(ctx: WebContext, site: string | null): string | null {
  if (site) return site.toLowerCase();
  const hosts = ctx.ext.web?.sites?.hosts() ?? [];
  return hosts.length === 1 ? hosts[0]!.replace(/^\*\./, '').toLowerCase() : null;
}

export const webSearch = defineRunnerTool({
  name: 'web_search',
  group: 'web',
  family: 'web',
  description: 'Search the public web. Returns titles, addresses and short excerpts. Use it to find out a fact or to find the right page, then web_fetch to read a page in full.',
  parameters,
  available: (ctx: WebContext) => ctx.ext.web?.search != null,
  gated: {
    // A search the model narrowed to a site outside the run's list is refused before anything is sent.
    [WEB_SITE_GATE]: (ctx: WebContext, { query, count, freshness, site }): WebSiteRequest | null =>
      site
        ? {
            url: `https://${site.toLowerCase()}/`,
            refusal: {
              text: siteRefusal(ctx.ext.web?.sites?.hosts() ?? []),
              step: { action: 'web_search', args: { query: ctx.ports.policy.mask(query), count, freshness, site }, summary: 'refused by policy: site not allowed' },
            },
          }
        : null,
  },
  async execute(ctx: WebContext, { query, count, freshness, site }) {
    const started = Date.now();
    const web = ctx.ext.web;
    const q = query.trim();
    const n = Math.max(1, Math.min(count ?? DEFAULT_COUNT, web?.limits.maxResults ?? 10));
    const narrowed = narrowTo(ctx, site);
    const args = { query: ctx.ports.policy.mask(q), count: n, freshness, site: narrowed };
    const hosts = web?.sites?.hosts() ?? [];
    const port = web?.search;
    if (!port) {
      await ctx.record('action', 'web_search', args, false, 'web search failed (NOT_CONFIGURED)', started);
      return WEB_SENTENCES.searchNotConfigured;
    }
    // A query that holds secret material is never sent.
    if (holdsSecret(ctx, q)) {
      await ctx.record('action', 'web_search', args, false, 'refused: the query looks like it holds secret material', started);
      return WEB_SENTENCES.sensitiveQuery;
    }
    const out = await callPort(ctx, 'web_search', (signal) => port.search({ query: q, count: n, freshness, site: narrowed, signal }));
    if (!out.ok) {
      if ('refused' in out) return out.refused;
      if ('stopped' in out) {
        await ctx.record('action', 'web_search', args, false, 'Stopped by the owner while this was running.', started);
        return out.stopped;
      }
      await ctx.record('action', 'web_search', args, false, `web search failed (${out.code})`, started);
      return searchErrorText(out.code, hosts);
    }
    const result = out.value;
    const provider = providerId(result.provider);
    const sites = web.sites;
    let dropped = 0;
    const hits: { title: string; url: string; snippet: string }[] = [];
    for (const h of Array.isArray(result.hits) ? result.hits : []) {
      const url = cleanUrl(h?.url);
      if (!url) continue;
      if (sites && !sites.allowed(url)) {
        dropped += 1;
        continue;
      }
      if (hits.length < n) hits.push({ title: String(h.title ?? ''), url, snippet: String(h.snippet ?? '') });
    }
    const { text, shown } = formatSearch(result, hits, dropped);
    ctx.ports.telemetry.toolAttributes({ [WEB_SPAN_ATTRS.provider]: provider, [WEB_SPAN_ATTRS.results]: shown });
    await ctx.record('action', 'web_search', args, true, `searched the web for "${q}" (${shown} results, ${provider})`, started, undefined, { contentHash: digest(text) });
    return text;
  },
});
