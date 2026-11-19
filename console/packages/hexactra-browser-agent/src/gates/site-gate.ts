// The allowed-sites gate (#508): a URL must pass the task's list and the AI app's list. Decided by the URL alone.
import type { Gate, RefusalStep } from '@marinoscar/hexactra-agent';
import type { BrowserContext } from '../context';

export const SITE_GATE = 'site';

/** What a tool that opens a URL asks the site gate: the URL, and what to say and record when it is refused. */
export interface SiteRequest {
  url: string;
  refusal: { text: string; step: RefusalStep };
}

export const siteGate: Gate<BrowserContext> = {
  name: SITE_GATE,
  async check(ctx, request) {
    const r = request as SiteRequest | null;
    if (!r || ctx.ext.sites.allowed(r.url)) return { kind: 'allow' };
    return { kind: 'refuse', text: r.refusal.text, step: r.refusal.step };
  },
};
