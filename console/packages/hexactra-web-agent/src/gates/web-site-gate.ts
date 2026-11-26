// The allowed-sites rule for the web tools (E50.4): a task's allowed sites bind web_fetch, and the site a search is narrowed to. Decided by
// the address alone, through the run's own predicate (`ctx.ext.web.sites`, the one the browser's site gate uses): this package does not
// import the browser toolset. The requested address is checked here; the address after redirects is checked again by the port (E50.6).
import type { Gate, RefusalStep } from '@marinoscar/hexactra-agent';
import type { WebContext } from '../context';

export const WEB_SITE_GATE = 'web_site';

/** What a web tool asks the gate: the address, and what to say and record when it is refused. */
export interface WebSiteRequest {
  url: string;
  refusal: { text: string; step: RefusalStep };
}

export const webSiteGate: Gate<WebContext> = {
  name: WEB_SITE_GATE,
  async check(ctx, request) {
    const r = request as WebSiteRequest | null;
    const sites = ctx.ext.web?.sites;
    if (!r || !sites || sites.allowed(r.url)) return { kind: 'allow' };
    return { kind: 'refuse', text: r.refusal.text, step: r.refusal.step };
  },
};
