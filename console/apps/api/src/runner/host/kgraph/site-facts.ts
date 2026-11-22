// The binding of the package's `propose_site_fact` (E46.31) for one run: the page's URL from the browser (never the model's or the page's
// text), the console's secret rules, and the owner's site fact store (every proposal is `proposed`, with the 30-day decline suppression).
// build-context.ts constructs it ONLY when the run's Knowledge Graph mode is `learn`, `reuse` or `everyday`.
import type { RunnerTool, ToolFamily } from '@marinoscar/hexactra-agent';
import { currentUrl } from '@marinoscar/hexactra-browser-agent/page';
import { proposeSiteFactTool, siteFactsFamily } from '@marinoscar/hexactra-kgraph/harness';

import { consoleSecretCheck } from '../../../kgraph/prisma-site-fact-store';
import type { KgraphSiteFactsService } from '../../../kgraph/site-facts.service';
import type { HostContext } from '../context';

/** The run modes that are offered `propose_site_fact`. `everyday` exists once #850 lands. */
export const SITE_FACT_MODES: ReadonlySet<string> = new Set(['learn', 'reuse', 'everyday']);

export function siteFactTools(facts: Pick<KgraphSiteFactsService, 'propose'>, userId: string): { tools: RunnerTool<HostContext>[]; family: ToolFamily<HostContext> } {
  const tool = proposeSiteFactTool<HostContext>({
    location: (ctx) => currentUrl(ctx as never),
    propose: async (_ctx, proposal) => {
      const r = await facts.propose(userId, proposal);
      // The tool validated it with the same rules; a refusal here answers "could not be saved".
      if (r === 'refused') throw new Error('refused');
      return r;
    },
    secretCheck: consoleSecretCheck,
  });
  return { tools: [tool], family: siteFactsFamily as unknown as ToolFamily<HostContext> };
}
