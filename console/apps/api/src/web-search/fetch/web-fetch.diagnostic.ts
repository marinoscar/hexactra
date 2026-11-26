// The `fetch` stage of web search diagnostics (E50.13, #983) through the real page reader (E50.6, #976): the deployment's switch
// `webSearch.fetch.enabled`, then one read of the fixed page through `WebFetchService.fetch`, so the address rules (SSRF, every hop),
// the administrator's blocked hosts and the caps apply exactly as for the agent. No run's allowed sites (the page is fixed in code).
// The diagnostics' own cache entries are dropped before each read, so a report always reaches the page. Nothing read is kept or returned.
import { Injectable } from '@nestjs/common';

import type { WebFetchDiagnosticHook } from '../web-search-diagnostics.service';
import { WebSearchService } from '../web-search.service';
import { WebFetchService } from './web-fetch.service';

/** The cache key of the diagnostics' reads: never a user's, so a user's cached pages are neither read nor evicted. */
export const DIAGNOSTIC_FETCH_CACHE_KEY = 'diagnostics';
/** The page text kept by the read (then dropped). */
const DIAGNOSTIC_MAX_CHARS = 1_000;

@Injectable()
export class WebFetchDiagnosticBinding implements WebFetchDiagnosticHook {
  constructor(
    private readonly fetcher: WebFetchService,
    private readonly webSearch: WebSearchService,
  ) {}

  async enabled(): Promise<boolean> {
    return (await this.webSearch.system()).fetch.enabled;
  }

  async read(url: string, signal: AbortSignal): Promise<void> {
    this.fetcher.cache.forget(DIAGNOSTIC_FETCH_CACHE_KEY);
    try {
      await this.fetcher.fetch(DIAGNOSTIC_FETCH_CACHE_KEY, { url, maxChars: DIAGNOSTIC_MAX_CHARS, signal }, null);
    } finally {
      this.fetcher.cache.forget(DIAGNOSTIC_FETCH_CACHE_KEY);
    }
  }
}
