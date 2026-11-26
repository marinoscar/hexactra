// The context the web tools are written against (E50.4): the harness context with `ext.web`. A host that offers the web tools adds `web` to
// its own `ext`; a host that does not leaves it out, and the tools are not offered.
import type { HarnessMemory, RunContext } from '@marinoscar/hexactra-agent';
import type { WebFetchPort, WebSearchPort } from './ports';

/** The run's allowed sites, the same predicate the browser's site gate uses. */
export interface WebSites {
  allowed(url: string): boolean;
  /** The listed hosts, in the task's order: what a refusal names, and the one host a search is narrowed to. */
  hosts(): readonly string[];
}

export interface WebExt {
  /** Null: web search is not offered. */
  search: WebSearchPort | null;
  /** Null: web_fetch is not offered. */
  fetch: WebFetchPort | null;
  /** The run's allowed sites. Null: no list. */
  sites: WebSites | null;
  limits: { maxResults: number; maxFetchChars: number };
}

export interface WebHostExt {
  web?: WebExt | null;
}

export type WebContext = RunContext<HarnessMemory, WebHostExt>;

/** The defaults a host uses when it has no limit of its own. */
export const DEFAULT_WEB_LIMITS: WebExt['limits'] = { maxResults: 10, maxFetchChars: 50_000 };
