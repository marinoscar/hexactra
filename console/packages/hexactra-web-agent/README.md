# @marinoscar/hexactra-web-agent

The Hexactra web toolset for [`@marinoscar/hexactra-agent`](../hexactra-agent/README.md): what an agent needs to find out something public without opening the browser (epic E50, `docs/decisions/web-search.md`).

- **Tools** (`/tools`): `web_search` (titles, addresses and short excerpts, or an answer with its sources) and `web_fetch` (one public page as text, no sign-in, no scripts), in the order the model is offered them.
- **Family** (`/families`): `webFamily` ("Web search", rank 30) with its own how-to, `HOW_TO_RESEARCH`. The how-to is emitted only when a web tool is offered, so a run without them reads none of it, and `ROUTING_RULE` does not change.
- **Gate** (`/gates`): `webSiteGate` (`web_site`): a task's allowed sites bind `web_fetch` and a search narrowed to a site. The predicate comes from the host through `ctx.ext.web.sites` (the same one the browser's site gate uses); this package does not import the browser toolset.
- **Ports** (`/ports`): `WebSearchPort`, `WebFetchPort`, `WebSearchResult`, `WebSearchHit` and `WebToolError` (a closed code vocabulary). The host binds the search providers (E50.5) and the server-side page reader (E50.6); this package makes no request of its own.
- **`/testing`**: `FakeWebSearch`, `FakeWebFetch` (pages, redirects, failures, latency for Stop tests) and `fakeWebRun()`, a web context over the harness fakes. No network.

It depends on the harness and on `zod`, and on nothing else: no console code, no NestJS, no Prisma, no HTTP client, no provider SDK (a test scans the built output).

**Stability: experimental** (`0.1.0-next.x`). Not published to npm yet.

## The rules the tools keep

- Every call goes through the harness's `executeTool`: Stop and Pause first, the gates, the span, the step. A Stop while a call is in flight aborts it through the owner's signal.
- A query or an address that matches the run's sensitive patterns (the host's `PolicyPort.mask`) is refused with a fixed sentence and never sent.
- What a provider or a page returns is third-party data: cleaned (`sanitizeText` of the harness: no control or invisible characters, no markup), capped (title 200, excerpt 400, answer 4,000, a whole search 12,000 characters; a page at `max_chars`) and wrapped between two fixed lines that say it is information, not instructions.
- An error becomes one fixed sentence per code; a provider's own text never reaches the model or the step.
- The step keeps the query (masked), the count, the freshness and the site of a search, and the host and path of a page read; never the result text.

## Use

```ts
import { GatePipeline, ToolRegistry } from '@marinoscar/hexactra-agent';
import { webFamily, webSiteGate, webTools, type WebExt } from '@marinoscar/hexactra-web-agent';

const web: WebExt = { search: searchPort, fetch: fetchPort, sites, limits: { maxResults: 10, maxFetchChars: 50_000 } };
// ext: { ...browserExt, web }
registry.registerFamily(webFamily).registerAll(webTools);
pipeline.add(webSiteGate);
```

The console registers them in its runner in E50.7.

## Build

```bash
npm run build:packages   # from console/: the harness first, then the toolsets
npm run test:packages
```
