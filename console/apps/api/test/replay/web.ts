// Web search in the scenario kit (E50.7, #977): the real `web_search` and `web_fetch` over the web toolset's fakes, bound the way the host binds
// them (`host/web-port.ts`: the run's allowed sites, the run's web call budget), so a scenario measures what a run gets. A scenario declares
// the owner's switch, the search results by query, the pages by address and the pages a server cannot read (sign-in, scripts).
import { FakeWebFetch, FakeWebSearch } from '@marinoscar/hexactra-web-agent/testing';
import { DEFAULT_WEB_LIMITS, webFamily, webTools, type WebExt } from '@marinoscar/hexactra-web-agent';

import { limitFetch, limitSearch, webSites } from '../../src/runner/host/web-port';
import { webAvailability } from '../../src/runner/host/web-availability';
import type { Scenario } from './scenario.schema';

export { webSiteGate } from '@marinoscar/hexactra-web-agent';

export interface ScenarioWeb {
  ext: WebExt;
  /** The fakes, for what reached the "provider" and the page reader. */
  search: FakeWebSearch;
  fetch: FakeWebFetch;
  tools: typeof webTools;
  family: typeof webFamily;
}

/** The scenario's web, or null when it declares none or the owner's switch is off (the tools are then not offered, as in a run). */
export function scenarioWeb(scenario: Scenario, allowed: (url: string) => boolean, maxCalls: number | null): ScenarioWeb | null {
  const w = scenario.web;
  if (!w) return null;
  // The same rule as a run: the provider is set up (the scenario declares one), the deployment's switch is on, and the owner's is `w.on`.
  const on = webAvailability({ providerUsable: true, deploymentOn: true, userOn: w.on, fetchOn: w.fetch, appAllows: null });
  if (!on.search) return null;
  const search = new FakeWebSearch();
  search.provider = 'fake';
  for (const [query, hits] of Object.entries(w.results)) search.results.set(query, hits.map((h) => ({ title: h.title, url: h.url, snippet: h.snippet, publishedAt: null })));
  // An answer-type provider (E50.9): the answer and its cited pages as hits, the URLs as citations.
  for (const [query, a] of Object.entries(w.answers)) {
    const hits = a.citations.map((h) => ({ title: h.title, url: h.url, snippet: h.snippet, publishedAt: null }));
    search.results.set(query, { provider: 'fake', hits, answer: { text: a.text, citations: hits.map((h) => h.url) } });
  }
  const fetch = new FakeWebFetch();
  for (const [url, page] of Object.entries(w.pages)) fetch.pages.set(url, { title: page.title, text: page.text });
  for (const url of w.blocked) fetch.failures.set(url, 'BLOCKED');
  const sites = webSites(allowed, scenario.task.allowedDomains, []);
  // The fakes answer only what passes the run's allowed sites, as the host's page reader checks every hop (E50.6).
  const guarded = { fetch: async (req: Parameters<FakeWebFetch['fetch']>[0]) => (sites && !sites.allowed(req.url) ? Promise.reject(Object.assign(new Error('NOT_ALLOWED'), { name: 'WebToolError', code: 'NOT_ALLOWED' })) : fetch.fetch(req)) };
  const counter = { used: 0, max: maxCalls };
  const ext: WebExt = { search: limitSearch(search, counter), fetch: on.fetch ? limitFetch(guarded, counter) : null, sites, limits: { ...DEFAULT_WEB_LIMITS } };
  return { ext, search, fetch, tools: webTools, family: webFamily };
}
