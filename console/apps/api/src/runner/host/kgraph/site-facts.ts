// The binding of the package's site fact tools for one run: `propose_site_fact` (E46.31) and `site_facts` (E46.32), and the "About these
// sites" block (E46.32). The page's URL comes from the browser (never the model's or the page's text), the secret rules are the console's,
// and the store is the owner's. build-context.ts calls `siteFactsBinding` ONLY when the run's Knowledge Graph mode is in SITE_FACT_MODES;
// otherwise nothing here is constructed, so a run with the feature off has no block and no tool. The everyday wiring (#850) calls the same
// function for a chat or one-off run.
import type { RunnerTool, ToolFamily } from '@marinoscar/hexactra-agent';
import { currentUrl } from '@marinoscar/hexactra-browser-agent/page';
import { selectSiteFacts, siteFactCandidates, siteFactsBlock, type InputSiteFact } from '@marinoscar/hexactra-kgraph';
import { proposeSiteFactTool, siteFactsFamily, siteFactsTool } from '@marinoscar/hexactra-kgraph/harness';

import { consoleSecretCheck } from '../../../kgraph/prisma-site-fact-store';
import type { KgraphSiteFactsService } from '../../../kgraph/site-facts.service';
import type { HostContext } from '../context';
import type { HostDeps } from '../deps';

/** The run modes that are given site facts and offered the site fact tools. `everyday` exists once #850 lands. */
export const SITE_FACT_MODES: ReadonlySet<string> = new Set(['learn', 'reuse', 'everyday']);

export type SiteFactsService = Pick<KgraphSiteFactsService, 'propose' | 'activeFor' | 'offeredTo' | 'recordOffered' | 'markUsed' | 'afterRun'>;

export interface SiteFactTools {
  tools: RunnerTool<HostContext>[];
  family: ToolFamily<HostContext>;
}

/** The two tools, in their order: `propose_site_fact`, then `site_facts`. Both read the page's site from the browser. */
export function siteFactTools(facts: SiteFactsService, userId: string): SiteFactTools {
  const location = (ctx: HostContext) => currentUrl(ctx as never);
  const propose = proposeSiteFactTool<HostContext>({
    location,
    propose: async (_ctx, proposal) => {
      const r = await facts.propose(userId, proposal);
      // The tool validated it with the same rules; a refusal here answers "could not be saved".
      if (r === 'refused') throw new Error('refused');
      return r;
    },
    secretCheck: consoleSecretCheck,
  });
  const read = siteFactsTool<HostContext>({
    location,
    read: (_ctx, site) => facts.activeFor(userId, [site]),
    used: (ctx, ids) => facts.markUsed(userId, ctx.run.id, ids),
  });
  return { tools: [propose, read], family: siteFactsFamily as unknown as ToolFamily<HostContext> };
}

/**
 * A run's candidate sites (E46.26): the registrable domains its goal names, its allowed sites (its own and its app's), and the sites of its
 * task's active procedure version. Never a page's or the model's text.
 */
export async function runCandidateSites(d: HostDeps, userId: string, run: { goal: string; taskId?: string | null }, allowedSites: readonly string[]): Promise<string[]> {
  let procedureSites: string[] = [];
  if (run.taskId && d.kgraphStore) {
    try {
      const p = await d.kgraphStore.findProcedureForTask(userId, run.taskId);
      const v = p?.activeVersion ? await d.kgraphStore.getVersion(userId, p.activeVersion) : null;
      procedureSites = (v?.sites ?? []).map((s) => s.domain);
    } catch {
      procedureSites = [];
    }
  }
  return siteFactCandidates({ goal: run.goal, allowedSites, procedureSites });
}

/**
 * The "About these sites" block for one run. The first job chooses the facts and records their ids on the run's `kg_runs` row; a later job
 * of the same run shows the same facts (those still active), so the stable prefix does not move. '' without any. Never throws.
 */
export async function siteFactsBlockFor(facts: SiteFactsService, userId: string, run: { id: string; goal: string }, mode: string, candidateSites: readonly string[]): Promise<string> {
  try {
    if (candidateSites.length === 0) return '';
    const active = await facts.activeFor(userId, candidateSites);
    const offered = await facts.offeredTo(userId, run.id);
    let chosen: InputSiteFact[];
    if (offered) {
      const byId = new Map(active.map((f) => [f.id, f]));
      chosen = offered.map((id) => byId.get(id)).filter((f): f is InputSiteFact => Boolean(f));
    } else {
      chosen = selectSiteFacts(active, { goal: run.goal, sites: candidateSites });
      if (chosen.length > 0) await facts.recordOffered(userId, run.id, mode, chosen.map((f) => f.id));
    }
    return siteFactsBlock(chosen);
  } catch {
    return '';
  }
}

/**
 * Everything site facts add to one run, in one call: the block (after the memories block) and the tools (registered after every other
 * tool). The caller decides the mode; this is the function the everyday wiring calls too.
 */
export async function siteFactsBinding(d: HostDeps, userId: string, run: { id: string; goal: string; taskId?: string | null }, mode: string, candidateSites: readonly string[]): Promise<{ block: string; tools: SiteFactTools } | null> {
  const facts = d.kgraphSiteFacts;
  if (!facts || !SITE_FACT_MODES.has(mode)) return null;
  return { block: await siteFactsBlockFor(facts, userId, run, mode, candidateSites), tools: siteFactTools(facts, userId) };
}
