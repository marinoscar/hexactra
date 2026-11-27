// The web tools' context of a run (E50.7, #977): `ctx.ext.web`, bound to the search provider registry (E50.5, `WebSearchService.forUser`) and
// the page reader on the console server (E50.6, `WebFetchService.forRun`), ONE port of each per job. Bound only when the run's snapshot says
// web search is on (`web-availability.ts`); otherwise `web` is null and the tools are not offered.
//
// The run's web call budget (`budget.maxWebCalls`, kept on the snapshot as `web.maxCalls`) is counted here, over the run's jobs (it starts
// from the run's earlier web steps): one search or one page read is one call, and the call over the limit is answered `LIMIT_REACHED` without
// reaching a provider. Reaching it does NOT stop the run: the tool says so and the agent goes on with the browser. The harness's
// `BudgetTracker` stops runs; this budget refuses a tool, so it is kept apart from it (decision recorded in docs/runner.md, "Web search").
import { DEFAULT_WEB_LIMITS, WebToolError, type WebExt, type WebFetchPort, type WebSearchPort, type WebSites } from '@marinoscar/hexactra-web-agent';

import type { HostDeps } from './deps';
import type { SnapshotWeb } from './web-availability';

/** The step actions of the web tools: what the run summary counts and the budget starts from. */
export const WEB_ACTIONS = ['web_search', 'web_fetch'] as const;

const NOT_CONFIGURED_SEARCH: WebSearchPort = { search: async () => Promise.reject(new WebToolError('NOT_CONFIGURED')) };
const NOT_CONFIGURED_FETCH: WebFetchPort = { fetch: async () => Promise.reject(new WebToolError('NOT_CONFIGURED')) };

/** A counter shared by the two ports of a run. */
export interface WebCallCounter {
  used: number;
  max: number | null;
}

/** `port` with the run's web call budget in front: over it, `LIMIT_REACHED` and no call. */
export function limitSearch(port: WebSearchPort, counter: WebCallCounter): WebSearchPort {
  return {
    search: async (req) => {
      if (counter.max !== null && counter.used >= counter.max) throw new WebToolError('LIMIT_REACHED');
      counter.used += 1;
      return port.search(req);
    },
  };
}

export function limitFetch(port: WebFetchPort, counter: WebCallCounter): WebFetchPort {
  return {
    fetch: async (req) => {
      if (counter.max !== null && counter.used >= counter.max) throw new WebToolError('LIMIT_REACHED');
      counter.used += 1;
      return port.fetch(req);
    },
  };
}

/**
 * The run's allowed sites as the web tools read them: the predicate the browser's site gate uses (the task's or chat's list and the AI app's),
 * and the hosts a refusal names. Null when the run has no list.
 */
export function webSites(allowed: (url: string) => boolean, taskHosts: readonly string[], appHosts: readonly string[]): WebSites | null {
  if (taskHosts.length === 0 && appHosts.length === 0) return null;
  const hosts = taskHosts.length > 0 ? [...taskHosts] : [...appHosts];
  return { allowed, hosts: () => hosts };
}

/** How many web calls the run made in its earlier jobs (a refusal before sending is not one). The run is the owner's, loaded already. */
export async function earlierWebCalls(prisma: Pick<HostDeps['prisma'], 'runStep'>, runId: string): Promise<number> {
  return prisma.runStep.count({ where: { runId, action: { in: [...WEB_ACTIONS] }, NOT: { summary: { startsWith: 'refused' } } } });
}

/**
 * The web context of one job of a run, or null (web search off for the run, or the module absent). Never throws.
 */
export async function bindWeb(
  d: Pick<HostDeps, 'webSearch' | 'webFetch' | 'log'>,
  s: { userId: string; orgId: string | null; runId: string; web: SnapshotWeb | null; sites: WebSites | null; earlierCalls: () => Promise<number> },
): Promise<WebExt | null> {
  if (!s.web?.search || !d.webSearch) return null;
  try {
    const counter: WebCallCounter = { used: s.web.maxCalls === null ? 0 : await s.earlierCalls(), max: s.web.maxCalls };
    // The snapshot decides what is offered: a switch turned off since the run started leaves the tools in place (the cached prompt prefix does
    // not change), and the service refuses the call (`NOT_CONFIGURED`), as a connection switched off mid-run is refused when it is called.
    const search = (await d.webSearch.forUser(s.userId, s.orgId)) ?? NOT_CONFIGURED_SEARCH;
    const fetch = s.web.fetch && d.webFetch ? ((await d.webFetch.forRun({ userId: s.userId, sites: s.sites })) ?? NOT_CONFIGURED_FETCH) : null;
    return { search: limitSearch(search, counter), fetch: fetch ? limitFetch(fetch, counter) : null, sites: s.sites, limits: { ...DEFAULT_WEB_LIMITS } };
  } catch (e) {
    d.log.warn(`run ${s.runId}: the web tools could not be bound (${e instanceof Error ? e.name : 'error'}): not offered in this job`);
    return null;
  }
}
